import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Recipe } from '@sim/engine';
import { RENDERS_DIR, ROOT } from '@sim/render';
import { COPY_TARGETS, PLATFORMS, claudeAvailable, type CopyTarget, type LongFormCopy, type Platform, type SocialCopy } from '@sim/planner';
import { LongFormService } from './longform';
import { getLongFormJob, listLongFormJobs } from './longformJobs';
import { parsePostUrl } from '@sim/analytics';
import { VOICE_CACHE, prepareNarration, warmUpKokoro } from '@sim/voice';

// Load .env (ANTHROPIC_API_KEY etc.) before anything reads the environment.
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* no .env */
}

const {
  EXPORTS_DIR,
  getExport,
  savedBatchSettings,
  getRender,
  insertRender,
  listBatches,
  setKv,
  upsertPost,
  deletePost,
  postByExternalId,
} = await import('./db');
const { RenderScheduler } = await import('./scheduler');
const { SearchPool } = await import('./searchPool');
const { BatchRunner } = await import('./batch');
const { ReviewActions, dirSize } = await import('./review');
const { batchSnapshot, batchSummary, reviewItem } = await import('./views');
const { scanLibrary, deleteLibraryEntry } = await import('./library');
type BatchSettings = import('./db').BatchSettings;

const PORT = Number(process.env.SIM_SERVER_PORT ?? 5174);
const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 5 * 1024 * 1024 });
const scheduler = new RenderScheduler();
const pool = new SearchPool();
const batches = new BatchRunner(scheduler, pool);
const review = new ReviewActions(scheduler, pool, batches);
const longformChanged = new EventEmitter();
const longform = new LongFormService(scheduler, (id) => longformChanged.emit('changed', id));
scheduler.on('longform', (j: { id: string }) => longformChanged.emit('changed', j.id));

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
// The long-form templates' textures, models and recordings, for the Ambient page's live preview.
await app.register(fastifyStatic, { root: join(ROOT, 'assets/ambient'), prefix: '/ambient-assets/', decorateReply: false });

// ---- status & settings ----------------------------------------------------------------------

app.get('/api/status', async () => ({ claude: claudeAvailable(), busy: batches.isBusy(), rendering: scheduler.current }));

app.get('/api/batch-settings', async () => savedBatchSettings());

// ---- batches --------------------------------------------------------------------------------

app.post<{ Body: { settings?: Partial<BatchSettings> } }>('/api/batches', async (req, reply) => {
  const settings: BatchSettings = { ...savedBatchSettings(), ...(req.body?.settings ?? {}) };
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

// ---- narration ------------------------------------------------------------------------------

/** Write and voice a recipe's narration (Playground "Voice it"); returns the recipe with its lines. */
app.post<{ Body: { recipe: Recipe; force?: boolean } }>('/api/narration/prepare', async (req, reply) => {
  const warnings: string[] = [];
  try {
    const recipe = await prepareNarration(req.body.recipe, { force: req.body.force, onWarning: (m) => warnings.push(m) });
    return { voice: recipe.voice ?? null, warnings };
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message });
  }
});

/** A voiced line from the cache. */
app.get<{ Params: { file: string } }>('/api/voice/:file', (req, reply) => {
  const abs = /^[\w-]+\.wav$/.test(req.params.file) ? safePath(VOICE_CACHE, req.params.file) : null;
  if (!abs || !existsSync(abs)) return reply.code(404).send({ error: 'not found' });
  return reply.type('audio/wav').send(createReadStream(abs));
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

// ---- long-form (ambient) videos ---------------------------------------------------------------

app.get('/api/longform', async () => ({ jobs: listLongFormJobs(), current: scheduler.currentLongForm, shortsRendering: scheduler.current }));

app.post<{ Body: { recipe: Recipe; notes?: string } }>('/api/longform', async (req, reply) => {
  try {
    return longform.create(req.body.recipe, req.body.notes);
  } catch (e) {
    return errorReply(reply, e);
  }
});

// Every job's live state (progress while rendering, copy as Claude writes it).
app.get('/api/longform/stream', (req, reply) => {
  sse(req, reply, (send) => {
    let timer: NodeJS.Timeout | null = null;
    const push = () => send({ jobs: listLongFormJobs(), current: scheduler.currentLongForm, shortsRendering: scheduler.current });
    const onChange = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        push();
      }, 300);
    };
    longformChanged.on('changed', onChange);
    push();
    return () => {
      longformChanged.off('changed', onChange);
      if (timer) clearTimeout(timer);
    };
  });
});

app.post<{ Params: { id: string } }>('/api/longform/:id/cancel', async (req) => {
  longform.cancel(req.params.id);
  return { ok: true };
});

app.post<{ Params: { id: string } }>('/api/longform/:id/retry', async (req, reply) => {
  try {
    longform.retry(req.params.id);
    return { ok: true };
  } catch (e) {
    return errorReply(reply, e);
  }
});

app.patch<{ Params: { id: string }; Body: Partial<LongFormCopy> }>('/api/longform/:id/copy', async (req, reply) => {
  try {
    longform.editCopy(req.params.id, req.body);
    return getLongFormJob(req.params.id);
  } catch (e) {
    return errorReply(reply, e);
  }
});

app.post<{ Params: { id: string }; Body: { notes?: string } }>('/api/longform/:id/copy/regenerate', async (req, reply) => {
  if (!getLongFormJob(req.params.id)) return reply.code(404).send({ error: 'not found' });
  void longform.writeCopy(req.params.id, req.body?.notes);
  return { ok: true };
});

app.delete<{ Params: { id: string }; Querystring: { files?: string } }>('/api/longform/:id', async (req, reply) => {
  try {
    await longform.remove(req.params.id, req.query.files === '1');
    return { ok: true };
  } catch (e) {
    return errorReply(reply, e);
  }
});

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
// Load the voice model now, in the background, so the first Playground voicing doesn't wait for it.
if (!process.env.VITEST) {
  const t0 = Date.now();
  warmUpKokoro().then(
    () => console.log(`Kokoro voice model ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`),
    (e) => console.warn(`Kokoro warm-up failed (it will load on first voicing): ${(e as Error).message}`),
  );
}
