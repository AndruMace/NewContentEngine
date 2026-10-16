import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Recipe } from '@sim/engine';
import { RENDERS_DIR, ROOT } from '@sim/render';
import { COPY_TARGETS, PLATFORMS, claudeAvailable, type CopyTarget, type Platform, type SocialCopy } from '@sim/planner';
import { REWARD_PRESETS, parsePostUrl } from '@sim/analytics';
import { tasteStatus } from './taste';

// Load .env (ANTHROPIC_API_KEY etc.) before anything reads the environment.
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* no .env */
}

const {
  DEFAULT_BATCH_SETTINGS,
  EXPORTS_DIR,
  getExport,
  getKv,
  getRender,
  insertRender,
  listBatches,
  setKv,
  upsertPost,
  deletePost,
  postByExternalId,
  updatePostMeta,
} = await import('./db');
const { RenderScheduler } = await import('./scheduler');
const { SearchPool } = await import('./searchPool');
const { BatchRunner } = await import('./batch');
const { ReviewActions, dirSize } = await import('./review');
const { batchSnapshot, batchSummary, reviewItem } = await import('./views');
const { scanLibrary, deleteLibraryEntry } = await import('./library');
const youtube = await import('./youtube');
const { listPostViews, postDetail, refitLearner, learningStatus, analyticsSettings, setAnalyticsSettings } = await import('./analytics');
type BatchSettings = import('./db').BatchSettings;

const PORT = Number(process.env.SIM_SERVER_PORT ?? 5174);
const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 5 * 1024 * 1024 });
const scheduler = new RenderScheduler();
const pool = new SearchPool();
const batches = new BatchRunner(scheduler, pool);
const review = new ReviewActions(scheduler, pool, batches);

/** Resolve a path relative to a root, refusing anything that escapes it. */
function safePath(root: string, rel: string): string | null {
  const abs = resolve(root, rel);
  return abs.startsWith(root + sep) ? abs : null;
}

/** Server-sent events: `send` pushes JSON; returns when the client disconnects. */
function sse(req: FastifyRequest, reply: FastifyReply, subscribe: (send: (data: unknown) => void, end: () => void) => () => void) {
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let closed = false;
  const send = (data: unknown) => !closed && reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  const end = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    reply.raw.end();
  };
  const unsubscribe = subscribe(send, end);
  const ping = setInterval(() => !closed && reply.raw.write(': ping\n\n'), 15000);
  req.raw.on('close', () => {
    clearInterval(ping);
    closed = true;
    unsubscribe();
  });
}

const errorReply = (reply: FastifyReply, e: unknown, code = 400) => reply.code(code).send({ error: e instanceof Error ? e.message : String(e) });

await app.register(fastifyStatic, { root: RENDERS_DIR, prefix: '/files/', decorateReply: true });

// ---- status & settings ----------------------------------------------------------------------

app.get('/api/status', async () => ({ claude: claudeAvailable(), busy: batches.isBusy(), rendering: scheduler.current }));

app.get('/api/batch-settings', async () => ({ ...DEFAULT_BATCH_SETTINGS, ...getKv<Partial<BatchSettings>>('batchSettings', {}) }));

// ---- batches --------------------------------------------------------------------------------

app.post<{ Body: { settings?: Partial<BatchSettings> } }>('/api/batches', async (req, reply) => {
  const settings: BatchSettings = { ...DEFAULT_BATCH_SETTINGS, ...getKv<Partial<BatchSettings>>('batchSettings', {}), ...(req.body?.settings ?? {}) };
  settings.postsWanted = Math.max(1, Math.min(10, Math.round(settings.postsWanted)));
  settings.factor = Math.max(1, Math.min(5, settings.factor));
  settings.minLengthS = Math.max(12, Math.min(settings.minLengthS, settings.maxLengthS - 3));
  settings.maxLengthS = Math.min(75, settings.maxLengthS);
  setKv('batchSettings', settings);
  try {
    return batchSummary(batches.start(settings));
  } catch (e) {
    return errorReply(reply, e, 409);
  }
});

app.get('/api/batches', async () => listBatches().map(batchSummary));

app.get<{ Params: { id: string } }>('/api/batches/:id', async (req, reply) => {
  return batchSnapshot(req.params.id, batches.eta(req.params.id)) ?? reply.code(404).send({ error: 'not found' });
});

app.get<{ Params: { id: string } }>('/api/batches/:id/stream', (req, reply) => {
  const id = req.params.id;
  sse(req, reply, (send) => {
    let timer: NodeJS.Timeout | null = null;
    const push = () => send(batchSnapshot(id, batches.eta(id)));
    const onChange = (batchId: string) => {
      if (batchId !== id || timer) return;
      timer = setTimeout(() => {
        timer = null;
        push();
      }, 250);
    };
    batches.on('changed', onChange);
    push();
    return () => {
      batches.off('changed', onChange);
      if (timer) clearTimeout(timer);
    };
  });
});

app.post<{ Params: { id: string } }>('/api/batches/:id/cancel', async (req) => {
  batches.cancel(req.params.id);
  return { ok: true };
});

// ---- review ---------------------------------------------------------------------------------

const changed = (r: { batchId: string | null }) => r.batchId && batches.emit('changed', r.batchId);

app.post<{ Params: { id: string }; Body: { decision: 'approved' | 'rejected' | 'pending'; reasons?: string[]; note?: string | null } }>('/api/review/:id/decision', async (req) => {
  const r = review.setDecision(req.params.id, req.body.decision, { reasons: req.body.reasons, note: req.body.note });
  changed(r);
  return reviewItem(r);
});

app.post<{ Params: { id: string }; Body: { kind: 'seed' | 'copy' | 'concept' | 'melody' } }>('/api/review/:id/reroll', async (req, reply) => {
  try {
    const kind = req.body.kind;
    const r =
      kind === 'seed'
        ? await review.rerollSeed(req.params.id)
        : kind === 'copy'
          ? await review.rerollCopy(req.params.id)
          : kind === 'melody'
            ? await review.rerollMelody(req.params.id)
            : await review.rerollConcept(req.params.id);
    changed(r);
    return reviewItem(r);
  } catch (e) {
    return errorReply(reply, e);
  }
});

app.patch<{ Params: { id: string }; Body: Partial<SocialCopy> }>('/api/review/:id/copy', async (req, reply) => {
  try {
    const r = review.editCopy(req.params.id, req.body);
    changed(r);
    return reviewItem(r);
  } catch (e) {
    return errorReply(reply, e);
  }
});

app.post<{ Params: { id: string } }>('/api/review/:id/export', async (req, reply) => {
  try {
    await review.exportBundle(req.params.id);
    const r = getRender(req.params.id)!;
    changed(r);
    return reviewItem(r);
  } catch (e) {
    return errorReply(reply, e);
  }
});

app.put<{ Params: { id: string }; Body: { platform: Platform; url: string } }>('/api/review/:id/posts', async (req, reply) => {
  const { platform, url } = req.body;
  if (!PLATFORMS.includes(platform)) return reply.code(400).send({ error: 'bad platform' });
  if (url?.trim()) {
    if (!/^https?:\/\//.test(url.trim())) return reply.code(400).send({ error: 'URL must start with http(s)://' });
    const externalId = parsePostUrl(platform, url);
    if (platform === 'youtube' && !externalId) return reply.code(400).send({ error: "That doesn't look like a YouTube video link" });
    const other = externalId ? postByExternalId(platform, externalId) : undefined;
    if (other && other.renderId !== req.params.id) return reply.code(409).send({ error: 'That post is already linked to another video' });
    upsertPost({ renderId: req.params.id, platform, url: url.trim(), postedAt: Date.now(), externalId, linkedBy: 'paste' });
  } else deletePost(req.params.id, platform);
  refitLearner();
  const r = getRender(req.params.id)!;
  changed(r);
  return reviewItem(r);
});

app.post<{ Body: { recipe: Recipe } }>('/api/manual', async (req) => {
  const r = review.addManual(req.body.recipe);
  changed(r);
  return reviewItem(r);
});

// Playground "Export": tracked in today's Manual batch; Claude writes the upload text while it renders.
app.post<{ Body: { recipe: Recipe; notes?: string } }>('/api/uploads', async (req) => {
  const r = review.startUpload(req.body.recipe, req.body.notes);
  changed(r);
  return reviewItem(r);
});

app.get<{ Params: { id: string } }>('/api/review/:id', async (req, reply) => {
  const r = getRender(req.params.id);
  return r ? reviewItem(r) : reply.code(404).send({ error: 'not found' });
});

// One video's live state for the upload page (render progress, copy being written, export).
app.get<{ Params: { id: string } }>('/api/review/:id/stream', (req, reply) => {
  const first = getRender(req.params.id);
  if (!first) return reply.code(404).send({ error: 'not found' });
  sse(req, reply, (send) => {
    let timer: NodeJS.Timeout | null = null;
    const push = () => {
      const r = getRender(req.params.id);
      if (r) send(reviewItem(r));
    };
    const onChange = (batchId: string) => {
      if (batchId !== first.batchId || timer) return;
      timer = setTimeout(() => {
        timer = null;
        push();
      }, 250);
    };
    batches.on('changed', onChange);
    push();
    return () => {
      batches.off('changed', onChange);
      if (timer) clearTimeout(timer);
    };
  });
});

app.post<{ Params: { id: string }; Body: { target: CopyTarget | 'all'; notes?: string } }>('/api/review/:id/copy/regenerate', async (req, reply) => {
  const target = req.body.target;
  if (target !== 'all' && !COPY_TARGETS.includes(target)) return reply.code(400).send({ error: 'bad target' });
  try {
    review.regenerateCopy(req.params.id, target, req.body.notes);
    return reviewItem(getRender(req.params.id)!);
  } catch (e) {
    return errorReply(reply, e);
  }
});

app.get<{ Params: { id: string }; Querystring: { name: string; inline?: string } }>('/api/exports/:id/file', (req, reply) => {
  const ex = getExport(req.params.id);
  const name = req.query.name;
  if (!ex || !['bundle.zip', 'video.mp4', 'cover.jpg', ...PLATFORMS.map((p) => `${p}.txt`)].includes(name)) return reply.code(404).send({ error: 'not found' });
  const abs = safePath(EXPORTS_DIR, join(ex.dir, name));
  if (!abs || !existsSync(abs)) return reply.code(404).send({ error: 'missing' });
  const base = ex.dir.split(sep).pop();
  if (!(req.query as { inline?: string }).inline) reply.header('content-disposition', `attachment; filename="${base}-${name}"`);
  return reply.type(name.endsWith('.zip') ? 'application/zip' : name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.jpg') ? 'image/jpeg' : 'text/plain').send(createReadStream(abs));
});

app.get('/api/storage', async () => ({ rendersBytes: await dirSize(RENDERS_DIR), exportsBytes: await dirSize(EXPORTS_DIR) }));

// Every render on disk, labelled by where it came from (batch / Playground / command line).
app.get('/api/library', async () => scanLibrary());

app.delete<{ Querystring: { path: string } }>('/api/library', async (req, reply) => {
  const ok = await deleteLibraryEntry(req.query.path ?? '');
  return ok ? { ok: true } : reply.code(400).send({ error: 'bad path' });
});

app.post<{ Body: { days?: number } }>('/api/housekeeping', async (req) => review.housekeeping(Math.max(0, Number(req.body?.days ?? 7))));

// ---- files ----------------------------------------------------------------------------------

app.get<{ Querystring: { path: string } }>('/api/download', (req, reply) => {
  const abs = safePath(RENDERS_DIR, req.query.path ?? '');
  if (!abs) return reply.code(400).send({ error: 'bad path' });
  const rel = abs.slice(RENDERS_DIR.length + 1);
  return reply.download(rel, rel.split(sep).slice(-2).join('-'));
});

// ---- YouTube & analytics ----------------------------------------------------------------------

const isLocalOrigin = (s: string) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(s);

app.get('/api/youtube/status', async () => youtube.youtubeStatus());

app.get<{ Querystring: { returnTo?: string } }>('/api/youtube/connect', async (req, reply) => {
  const returnTo = req.query.returnTo && isLocalOrigin(req.query.returnTo) ? req.query.returnTo : `http://127.0.0.1:${PORT}`;
  try {
    return reply.redirect(youtube.authUrl(`http://127.0.0.1:${PORT}/api/youtube/callback`, returnTo));
  } catch (e) {
    return errorReply(reply, e);
  }
});

app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/youtube/callback', async (req, reply) => {
  try {
    return reply.redirect(await youtube.handleCallback(req.query));
  } catch (e) {
    return reply.code(400).type('text/plain').send(`YouTube connection failed: ${(e as Error).message}`);
  }
});

app.post('/api/youtube/disconnect', async () => {
  await youtube.disconnect();
  return youtube.youtubeStatus();
});

let refreshing: Promise<unknown> | null = null;
app.post('/api/analytics/refresh', async (req, reply) => {
  if (!youtube.youtubeStatus().connected) return reply.code(409).send({ error: 'Connect YouTube first' });
  refreshing ??= youtube
    .refreshYouTube()
    .then((r) => (refitLearner(), r))
    .finally(() => (refreshing = null));
  try {
    return await refreshing;
  } catch (e) {
    return errorReply(reply, e);
  }
});

app.get('/api/analytics/posts', async () => ({ posts: listPostViews('youtube'), uploads: youtube.unlinkedUploads() }));

app.get<{ Params: { id: string } }>('/api/analytics/posts/:id', async (req, reply) => postDetail(req.params.id) ?? reply.code(404).send({ error: 'not found' }));

app.patch<{ Params: { id: string }; Body: { manual: Record<string, number | null> } }>('/api/analytics/posts/:id', async (req, reply) => {
  const d = postDetail(req.params.id);
  if (!d) return reply.code(404).send({ error: 'not found' });
  const manual: Record<string, number> = { ...d.manual };
  for (const [k, v] of Object.entries(req.body.manual ?? {})) {
    if (k !== 'stayedPct') continue;
    if (v === null || v === undefined || Number.isNaN(Number(v))) delete manual[k];
    else manual[k] = Math.max(0, Math.min(100, Number(v)));
  }
  updatePostMeta(req.params.id, 'youtube', { manual });
  refitLearner();
  return postDetail(req.params.id);
});

app.post<{ Body: { videoId: string; publishedAt: number; renderId: string } }>('/api/analytics/links', async (req, reply) => {
  try {
    youtube.linkUpload({ videoId: req.body.videoId, publishedAt: req.body.publishedAt }, req.body.renderId, 'paste');
    refitLearner();
    const r = getRender(req.body.renderId);
    if (r) changed(r);
    return { posts: listPostViews('youtube'), uploads: youtube.unlinkedUploads() };
  } catch (e) {
    return errorReply(reply, e);
  }
});

app.post<{ Body: { videoId: string } }>('/api/analytics/ignore', async (req) => {
  youtube.ignoreUpload(req.body.videoId);
  return { posts: listPostViews('youtube'), uploads: youtube.unlinkedUploads() };
});

app.get('/api/analytics/taste', async () => tasteStatus());

app.get('/api/analytics/learning', async () => learningStatus());

app.get('/api/analytics/settings', async () => ({ ...analyticsSettings(), presets: REWARD_PRESETS }));

app.put<{ Body: { preset?: string; weights?: Record<string, number> } }>('/api/analytics/settings', async (req, reply) => {
  const preset = req.body.preset && REWARD_PRESETS[req.body.preset] ? req.body.preset : 'custom';
  const raw = preset !== 'custom' ? REWARD_PRESETS[preset].weights : req.body.weights;
  const keys = ['retention', 'reach', 'engagement', 'followers'] as const;
  if (!raw || keys.some((k) => !(Number(raw[k]) >= 0))) return reply.code(400).send({ error: 'weights must be non-negative numbers' });
  const total = keys.reduce((s, k) => s + Number(raw[k]), 0);
  if (total <= 0) return reply.code(400).send({ error: 'at least one weight must be positive' });
  const weights = Object.fromEntries(keys.map((k) => [k, Number(raw[k]) / total])) as Record<(typeof keys)[number], number>;
  setAnalyticsSettings({ preset, weights });
  return { ...analyticsSettings(), presets: REWARD_PRESETS };
});

/** Exported videos not yet linked to a YouTube upload (for manual linking). */
app.get('/api/analytics/linkable', async () => youtube.linkableRendersView());

// Local-only convenience: reveal a render in Finder.
app.post<{ Body: { path: string; root?: 'renders' | 'exports' } }>('/api/reveal', async (req, reply) => {
  const abs = safePath(req.body.root === 'exports' ? EXPORTS_DIR : RENDERS_DIR, req.body.path ?? '');
  if (!abs) return reply.code(400).send({ error: 'bad path' });
  spawn('open', ['-R', abs], { stdio: 'ignore' }).unref();
  return { ok: true };
});

const shutdown = async () => {
  await scheduler.stop();
  await pool.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

scheduler.start();
review.startAutoExport();
batches.resumeAll();
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`Sim server on http://127.0.0.1:${PORT} (Claude ${claudeAvailable() ? 'enabled' : 'not configured'})`);
