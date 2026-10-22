import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { Rng, searchBudgetOf, type Recipe } from '@sim/engine';
import { RENDERS_DIR } from '@sim/render';
import {
  PLATFORMS,
  TITLE_EMOJI_SHARE,
  claudeAvailable,
  claudeErrorReason,
  normalizeCopy,
  planOne,
  platformText,
  startsWithEmoji,
  uploadCopyFromClaude,
  type Concept,
  type CopyTarget,
  type SocialCopy,
} from '@sim/planner';
import Anthropic from '@anthropic-ai/sdk';
import {
  EXPORTS_DIR,
  db,
  exportForRender,
  getConcept,
  getRender,
  pendingAutoExports,
  insertConcept,
  insertPredictionOnce,
  predictionFor,
  insertExport,
  insertRender,
  manualBatchForToday,
  conceptsForBatch,
  recentHooks,
  recentTitles,
  updateConcept,
  updateRender,
  type RenderRow,
} from './db';
import { ALL_MELODY_IDS, chooseMelody, hashSeed, recipeFor, type BatchRunner } from './batch';
import { getTemplate } from '@sim/templates';
import { copyPerformance, postFeatures, predictFeatures } from './analytics';
import { chooseParams } from './taste';
import { REJECT_REASONS } from '@sim/analytics';

const REASON_IDS = new Set<string>(REJECT_REASONS.map((r) => r.id));
import type { RenderScheduler } from './scheduler';
import type { SearchPool } from './searchPool';
import { fallbackConcept } from '@sim/planner';
import { pruneVoiceCache } from '@sim/voice';

/** Claude writing upload text for a render, in the background. Only lives in memory. */
export interface CopyJob {
  target: CopyTarget | 'all';
  running: boolean;
  error: string | null;
}

const copyJobs = new Map<string, CopyJob>();

/** The latest copy job for a render (running or finished since the server started), if any. */
export const copyJobFor = (id: string): CopyJob | null => copyJobs.get(id) ?? null;

/** Queue a replacement render and mark the original as superseded by it. */
function supersede(old: RenderRow, next: RenderRow) {
  updateRender(old.id, { supersededBy: next.id, decision: old.decision === 'approved' ? 'approved' : 'rerolled' });
}

export class ReviewActions {
  constructor(
    private scheduler: RenderScheduler,
    private pool: SearchPool,
    private batches: BatchRunner,
  ) {}

  /** Playground exports bundle themselves once rendered (and once any copy being written has landed). */
  startAutoExport() {
    this.scheduler.on('render', (r: RenderRow) => r.status === 'ready' && r.autoExport && void this.maybeAutoExport(r.id));
    for (const r of pendingAutoExports()) void this.maybeAutoExport(r.id);
  }

  private changed(id: string) {
    const r = getRender(id);
    if (r?.batchId) this.batches.emit('changed', r.batchId);
  }

  /** Approve / reject / undo. Reject reasons and a note teach the taste model why. */
  setDecision(id: string, decision: 'approved' | 'rejected' | 'pending', feedback: { reasons?: string[]; note?: string | null } = {}) {
    const keep = decision === 'rejected';
    updateRender(id, { decision, reasons: keep ? (feedback.reasons ?? []).filter((x) => REASON_IDS.has(x)) : [], note: keep ? feedback.note?.trim() || null : null });
    return getRender(id)!;
  }

  /** Same concept, next-best seed (searching more if the stored alternates run out). */
  async rerollSeed(id: string): Promise<RenderRow> {
    const r = mustRender(id);
    let [seed, ...rest] = r.altSeeds;
    let score: number | null = null;
    let scoreParts: Record<string, number> | null = null;
    if (seed === undefined) {
      const results = await this.pool.search({ ...r.recipe, seed: 0 }, { count: 200, targetS: r.recipe.targetS ?? 30, start: (r.recipe.seed + 1000) % 1_000_000 });
      const fresh = results.filter((x) => !x.timedOut && x.seed !== r.recipe.seed);
      if (!fresh.length) throw new Error('No alternative seeds found');
      [seed, ...rest] = fresh.map((x) => x.seed);
      score = fresh[0].total;
      scoreParts = fresh[0].parts;
    }
    const next = insertRender({
      batchId: r.batchId,
      conceptId: r.conceptId,
      kind: r.kind,
      recipe: { ...r.recipe, seed },
      copy: r.copy,
      score,
      scoreParts,
      altSeeds: rest,
      rankScore: r.rankScore,
    });
    supersede(r, next);
    this.scheduler.notify();
    return next;
  }

  /** Same run and copy, a different melody (one not used elsewhere in the batch). Melody only changes the sound, except for melody-driven templates. */
  async rerollMelody(id: string): Promise<RenderRow> {
    const r = mustRender(id);
    if (getTemplate(r.recipe.templateId).ownMusic) throw new Error('This template makes its own notes; it has no melody to change');
    const rng = new Rng(Date.now() % 1e9);
    const melodyId = r.batchId ? chooseMelody(r.batchId, r.recipe.templateId, rng, [r.recipe.melodyId]) : rng.pick(ALL_MELODY_IDS.filter((m) => m !== r.recipe.melodyId));
    const c = r.conceptId ? getConcept(r.conceptId) : undefined;
    if (c) updateConcept(c.id, { ...c.concept, melodyId });
    // Where the melody shapes the run (e.g. Bounce Keys), a new song is a new run: search and score it afresh.
    let run = { seed: r.recipe.seed, score: r.score, scoreParts: r.scoreParts, altSeeds: r.altSeeds };
    const template = getTemplate(r.recipe.templateId);
    if (template.melodyDriven) {
      const results = await this.pool.search({ ...r.recipe, melodyId, seed: 0 }, { count: searchBudgetOf(template, r.recipe.params, 6), targetS: r.recipe.targetS ?? 30, start: r.recipe.seed });
      const ok = results.filter((x) => !x.timedOut);
      if (!ok.length) throw new Error('This melody did not produce a usable run');
      run = { seed: ok[0].seed, score: ok[0].total, scoreParts: ok[0].parts, altSeeds: ok.slice(1).map((x) => x.seed) };
    }
    const next = insertRender({
      batchId: r.batchId,
      conceptId: r.conceptId,
      kind: r.kind,
      recipe: { ...r.recipe, melodyId, seed: run.seed },
      copy: r.copy,
      score: run.score,
      scoreParts: run.scoreParts,
      altSeeds: run.altSeeds,
      rankScore: r.rankScore,
    });
    supersede(r, next);
    this.scheduler.notify();
    return next;
  }

  /** New text from Claude (or template copy), same simulation. Re-renders because the hook changes. */
  async rerollCopy(id: string): Promise<RenderRow> {
    const r = mustRender(id);
    const c = r.conceptId ? getConcept(r.conceptId) : undefined;
    if (!c) throw new Error('This video has no concept to rewrite');
    const client = claudeAvailable() ? new Anthropic() : undefined;
    // Same simulation, so the new copy is written for the settings already on screen.
    const keep = () => ({ params: c.concept.params, source: c.concept.paramsSource ?? 'kept' });
    const planned = await planOne(c.concept.arm, c.concept.targetS, client ? 'claude' : 'fallback', { recentHooks: recentHooks(), chooseParams: keep, recentTitles: recentTitles(), performanceSummary: copyPerformance() }, new Rng(Date.now() % 1e9), client);
    // Keep the video's comment prompt (or its absence): only the written copy is being replaced.
    const { nudge: _drop, ...fresh } = planned.concept.copy;
    const copy = { ...fresh, ...(c.concept.copy.nudge ? { nudge: c.concept.copy.nudge } : {}) };
    updateConcept(c.id, { ...c.concept, copy });
    return this.rerenderWithCopy(r, copy);
  }

  /** Brand-new concept for the same arm: plan, search, render. */
  async rerollConcept(id: string): Promise<RenderRow> {
    const r = mustRender(id);
    const c = r.conceptId ? getConcept(r.conceptId) : undefined;
    if (!c || !r.batchId) throw new Error('This video has no concept to replace');
    const client = claudeAvailable() ? new Anthropic() : undefined;
    const planned = await planOne(c.concept.arm, c.concept.targetS, client ? 'claude' : 'fallback', { recentHooks: recentHooks(), chooseParams, recentTitles: recentTitles(), performanceSummary: copyPerformance() }, new Rng(Date.now() % 1e9), client);
    if (c.concept.experiment) planned.concept.experiment = c.concept.experiment;
    planned.concept.melodyId = chooseMelody(r.batchId, planned.concept.templateId, new Rng(Date.now() % 1e9));
    const concept = insertConcept(r.batchId, conceptsForBatch(r.batchId).length, planned.concept);
    const next = await this.batches.searchAndQueue(r.batchId, concept, { kind: r.kind });
    supersede(r, next);
    return next;
  }

  /** Edit copy. On-screen text (hook/CTA) changes need a re-render; captions don't. */
  editCopy(id: string, patch: Partial<SocialCopy>): RenderRow {
    const r = mustRender(id);
    const copy = normalizeCopy({ ...(r.copy ?? emptyCopy()), ...patch });
    if (r.conceptId) {
      const c = getConcept(r.conceptId);
      if (c) updateConcept(c.id, { ...c.concept, copy });
    }
    const onScreenChanged = copy.hook !== (r.copy?.hook ?? '') || copy.cta !== (r.copy?.cta ?? '') || (copy.nudge ?? '') !== (r.copy?.nudge ?? '');
    if (!onScreenChanged) {
      updateRender(id, { copy });
      void this.refreshExportFiles(id);
      return getRender(id)!;
    }
    return this.rerenderWithCopy(r, copy);
  }

  private rerenderWithCopy(r: RenderRow, copy: SocialCopy): RenderRow {
    const next = insertRender({
      batchId: r.batchId,
      conceptId: r.conceptId,
      kind: r.kind,
      recipe: { ...r.recipe, copy: { hook: copy.hook, cta: copy.cta, ...(copy.nudge ? { nudge: copy.nudge } : {}) } },
      copy,
      score: r.score,
      scoreParts: r.scoreParts,
      altSeeds: r.altSeeds,
      rankScore: r.rankScore,
    });
    supersede(r, next);
    this.scheduler.notify();
    return next;
  }

  /** Playground "Add to review queue": render exactly this recipe into today's Manual batch. */
  addManual(recipe: RenderRow['recipe']): RenderRow {
    const batch = manualBatchForToday();
    const concept = this.manualConcept(recipe, new Rng(hashSeed(JSON.stringify(recipe))));
    const c = insertConcept(batch.id, conceptsForBatch(batch.id).length, concept);
    const row = insertRender({ batchId: batch.id, conceptId: c.id, kind: 'manual', recipe: recipeFor(concept, recipe.seed), copy: concept.copy, score: null, scoreParts: null, altSeeds: [], rankScore: null });
    this.scheduler.notify();
    return row;
  }

  /**
   * Playground "Export": render exactly this recipe into today's Manual batch, approved, and have
   * Claude write the upload text while it renders. The bundle is written once both are done.
   */
  startUpload(recipe: RenderRow['recipe'], notes?: string): RenderRow {
    const batch = manualBatchForToday();
    const rng = new Rng((hashSeed(JSON.stringify(recipe)) + Date.now()) % 1e9);
    const concept: Concept = { ...this.manualConcept(recipe, rng), titleEmoji: rng.chance(TITLE_EMOJI_SHARE), ...(notes?.trim() ? { notes: notes.trim() } : {}) };
    const c = insertConcept(batch.id, conceptsForBatch(batch.id).length, concept);
    const row = insertRender({
      batchId: batch.id,
      conceptId: c.id,
      kind: 'manual',
      recipe: recipeFor(concept, recipe.seed),
      copy: concept.copy,
      score: null,
      scoreParts: null,
      altSeeds: [],
      rankScore: null,
      decision: 'approved',
      autoExport: true,
    });
    this.scheduler.notify();
    this.writeCopy(row.id, 'all');
    return row;
  }

  /** Rewrite one platform's text (or the cover text, or everything) with Claude, in the background. */
  regenerateCopy(id: string, target: CopyTarget | 'all', notes?: string): CopyJob {
    const r = mustRender(id);
    if (!r.copy) throw new Error('This video has no copy');
    if (copyJobs.get(id)?.running) throw new Error('Claude is already writing copy for this video');
    if (!claudeAvailable()) throw new Error('Claude is not configured (set ANTHROPIC_API_KEY in .env)');
    const c = r.conceptId ? getConcept(r.conceptId) : undefined;
    if (c && notes !== undefined) updateConcept(c.id, { ...c.concept, notes: notes.trim() || undefined });
    return this.writeCopy(id, target);
  }

  /** Start a copy job: Claude writes `target` (or everything), saved into the render and its concept. */
  private writeCopy(id: string, target: CopyTarget | 'all'): CopyJob {
    const job: CopyJob = { target, running: true, error: null };
    if (!claudeAvailable()) {
      job.running = false;
      job.error = 'Claude is not configured (set ANTHROPIC_API_KEY in .env), so this uses template copy.';
      copyJobs.set(id, job);
      return job;
    }
    copyJobs.set(id, job);
    this.changed(id);
    void (async () => {
      try {
        const r = mustRender(id);
        const c = r.conceptId ? getConcept(r.conceptId) : undefined;
        const base = r.copy ?? emptyCopy();
        const titleEmoji = target === 'all' ? (c?.concept.titleEmoji ?? true) : startsWithEmoji(base.title);
        const copy = await uploadCopyFromClaude(
          new Anthropic(),
          {
            recipe: r.recipe,
            onScreen: { hook: base.hook, cta: base.cta, nudge: base.nudge },
            notes: c?.concept.notes,
            titleEmoji,
            performance: copyPerformance(),
            recentTitles: recentTitles().filter((t) => t !== base.title),
          },
          base,
          new Rng(Date.now() % 1e9),
          target === 'all' ? null : target,
        );
        // Re-read: the owner may have edited other fields while Claude was writing.
        const latest = getRender(id)?.copy ?? base;
        const merged = target === 'all' ? copy : mergeTarget(latest, copy, target);
        updateRender(id, { copy: merged });
        const fresh = r.conceptId ? getConcept(r.conceptId) : undefined;
        if (fresh) updateConcept(fresh.id, { ...fresh.concept, source: target === 'all' ? 'claude' : fresh.concept.source, copy: merged });
      } catch (e) {
        job.error = `Claude couldn't write this (${claudeErrorReason(e)}).${target === 'all' ? ' Showing template copy for now.' : ''}`;
      } finally {
        job.running = false;
        await this.refreshExportFiles(id).catch(() => {});
        await this.maybeAutoExport(id);
        this.changed(id);
      }
    })();
    return job;
  }

  /** Bundle a rendered Playground export once its copy is no longer being written. */
  private async maybeAutoExport(id: string) {
    const r = getRender(id);
    if (!r?.autoExport || r.status !== 'ready' || exportForRender(id) || copyJobs.get(id)?.running) return;
    try {
      await this.exportBundle(id);
    } catch (e) {
      console.warn(`Auto-export of ${id} failed: ${(e as Error).message}`);
    }
    this.changed(id);
  }

  /** Concept for a Playground recipe: its own params and on-screen text, template copy until Claude writes some. */
  private manualConcept(recipe: RenderRow['recipe'], rng: Rng): Concept {
    const base = fallbackConcept({ templateId: recipe.templateId, themeId: recipe.themeId, lengthBucket: 'medium', hookStyle: 'question' }, recipe.targetS ?? 30, rng);
    return {
      ...base,
      melodyId: recipe.melodyId,
      params: recipe.params,
      source: 'manual' as const,
      copy: normalizeCopy({ ...base.copy, hook: recipe.copy?.hook || base.copy.hook, cta: recipe.copy?.cta || base.copy.cta, nudge: recipe.copy?.nudge }),
    };
  }

  /** Write an upload-ready bundle (video, cover, captions per platform, zip) and approve the video. */
  async exportBundle(id: string) {
    const r = mustRender(id);
    if (r.status !== 'ready' || !r.dir) throw new Error('Video is not rendered yet');
    const copy = r.copy ?? emptyCopy();
    const day = new Date().toISOString().slice(0, 10);
    const slug = `${(copy.title || r.recipe.templateId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${r.id.slice(0, 6)}`;
    const rel = join(day, slug);
    const dir = join(EXPORTS_DIR, rel);
    await mkdir(dir, { recursive: true });
    const src = join(RENDERS_DIR, r.dir);
    await copyFile(join(src, 'final.mp4'), join(dir, 'video.mp4'));
    await copyFile(join(src, 'cover.jpg'), join(dir, 'cover.jpg'));
    await copyFile(join(src, 'events.json'), join(dir, 'events.json')).catch(() => {});
    const features = predictionFor(id)?.features ?? postFeatures(r);
    // Frozen at first export: what we knew before any results came in.
    const pred = predictFeatures(features);
    insertPredictionOnce({ renderId: id, createdAt: Date.now(), modelVersion: pred?.modelVersion ?? null, mean: pred?.mean ?? null, sd: pred?.sd ?? null, experiment: features.experiment, features });
    await writeUploadFiles(dir, r);
    if (r.decision === 'pending') updateRender(id, { decision: 'approved' });
    return insertExport(id, rel);
  }

  /** Copy changed after export: rewrite the text files, meta.json and zip so they match the page. */
  private async refreshExportFiles(id: string) {
    const ex = exportForRender(id);
    const r = getRender(id);
    if (ex && r) await writeUploadFiles(join(EXPORTS_DIR, ex.dir), r);
  }

  /** Delete renders of rejected, replaced or unreviewed videos older than `days`. Never approved or exported ones. */
  async housekeeping(days: number) {
    const cutoff = Date.now() - days * 86_400_000;
    const rows = db
      .prepare(
        `SELECT id, dir FROM renders WHERE created_at < ? AND status IN ('ready','failed','cancelled') AND decision != 'approved'
         AND id NOT IN (SELECT render_id FROM exports) AND id NOT IN (SELECT render_id FROM posts)`,
      )
      .all(cutoff) as { id: string; dir: string | null }[];
    let freed = 0;
    for (const row of rows) {
      if (row.dir) {
        const abs = join(RENDERS_DIR, row.dir);
        freed += await dirSize(abs);
        await rm(abs, { recursive: true, force: true });
      }
      updateRender(row.id, { status: 'deleted', dir: null });
    }
    // Voiced lines no render still needs (each render copies its own; deleted ones re-voice if replayed).
    const keep = new Set<string>();
    for (const r of db.prepare("SELECT recipe FROM renders WHERE status != 'deleted' AND json_extract(recipe, '$.voice') IS NOT NULL").all() as { recipe: string }[])
      for (const l of (JSON.parse(r.recipe) as Recipe).voice?.lines ?? []) keep.add(l.clip);
    freed += (await pruneVoiceCache(keep, cutoff)).freedBytes;
    return { deleted: rows.length, freedBytes: freed };
  }
}

/** Text files (one per platform, everything for it in one block), meta.json and the zip, from the current copy. */
async function writeUploadFiles(dir: string, r: RenderRow) {
  const copy = r.copy ?? emptyCopy();
  const text = platformText(copy);
  for (const p of PLATFORMS) await writeFile(join(dir, `${p}.txt`), text[p] + '\n');
  const features = predictionFor(r.id)?.features ?? postFeatures(r);
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ recipe: r.recipe, copy, score: r.score, qc: r.qc, features }, null, 2));
  const files: Record<string, Uint8Array> = {};
  for (const f of ['video.mp4', 'cover.jpg', ...PLATFORMS.map((p) => `${p}.txt`), 'meta.json']) files[f] = new Uint8Array(await readFile(join(dir, f)));
  // Store only: the MP4 is already compressed.
  await writeFile(join(dir, 'bundle.zip'), zipSync(files, { level: 0 }));
}

/** Take only the target's fields from `fresh`, keeping everything else in `current`. */
function mergeTarget(current: SocialCopy, fresh: SocialCopy, target: CopyTarget): SocialCopy {
  const pinned = (p: 'youtube' | 'tiktok' | 'instagram' | 'x') => ({ pinnedComments: { ...current.pinnedComments, [p]: fresh.pinnedComments?.[p] ?? '' } });
  switch (target) {
    case 'youtube':
      return { ...current, title: fresh.title, youtubeDescription: fresh.youtubeDescription, hashtags: fresh.hashtags, ...pinned('youtube') };
    case 'tiktok':
      return { ...current, tiktokCaption: fresh.tiktokCaption, ...pinned('tiktok') };
    case 'instagram':
      return { ...current, instagramCaption: fresh.instagramCaption, ...pinned('instagram') };
    case 'x':
      return { ...current, xPost: fresh.xPost, ...pinned('x') };
    case 'cover':
      return { ...current, coverText: fresh.coverText };
  }
}

function mustRender(id: string): RenderRow {
  const r = getRender(id);
  if (!r) throw new Error('Render not found');
  return r;
}

function emptyCopy(): SocialCopy {
  return { hook: '', cta: '', title: '', youtubeDescription: '', tiktokCaption: '', xPost: '', hashtags: [] };
}

export async function dirSize(path: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(path, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

export { exportForRender };
