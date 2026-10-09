import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { Rng } from '@sim/engine';
import { RENDERS_DIR } from '@sim/render';
import { claudeAvailable, normalizeCopy, planOne, platformText, type SocialCopy } from '@sim/planner';
import Anthropic from '@anthropic-ai/sdk';
import {
  EXPORTS_DIR,
  db,
  exportForRender,
  getConcept,
  getRender,
  insertConcept,
  insertPredictionOnce,
  predictionFor,
  insertExport,
  insertRender,
  manualBatchForToday,
  conceptsForBatch,
  recentHooks,
  updateConcept,
  updateRender,
  type RenderRow,
} from './db';
import { hashSeed, recipeFor, type BatchRunner } from './batch';
import { postFeatures, predictFeatures } from './analytics';
import type { RenderScheduler } from './scheduler';
import type { SearchPool } from './searchPool';
import { fallbackConcept } from '@sim/planner';

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

  setDecision(id: string, decision: 'approved' | 'rejected' | 'pending') {
    updateRender(id, { decision });
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

  /** New text from Claude (or template copy), same simulation. Re-renders because the hook changes. */
  async rerollCopy(id: string): Promise<RenderRow> {
    const r = mustRender(id);
    const c = r.conceptId ? getConcept(r.conceptId) : undefined;
    if (!c) throw new Error('This video has no concept to rewrite');
    const client = claudeAvailable() ? new Anthropic() : undefined;
    const planned = await planOne(c.concept.arm, c.concept.targetS, client ? 'claude' : 'fallback', { recentHooks: recentHooks() }, new Rng(Date.now() % 1e9), client);
    const copy = planned.concept.copy;
    updateConcept(c.id, { ...c.concept, copy });
    return this.rerenderWithCopy(r, copy);
  }

  /** Brand-new concept for the same arm: plan, search, render. */
  async rerollConcept(id: string): Promise<RenderRow> {
    const r = mustRender(id);
    const c = r.conceptId ? getConcept(r.conceptId) : undefined;
    if (!c || !r.batchId) throw new Error('This video has no concept to replace');
    const client = claudeAvailable() ? new Anthropic() : undefined;
    const planned = await planOne(c.concept.arm, c.concept.targetS, client ? 'claude' : 'fallback', { recentHooks: recentHooks() }, new Rng(Date.now() % 1e9), client);
    if (c.concept.experiment) planned.concept.experiment = c.concept.experiment;
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
    const onScreenChanged = copy.hook !== (r.copy?.hook ?? '') || copy.cta !== (r.copy?.cta ?? '');
    if (!onScreenChanged) {
      updateRender(id, { copy });
      return getRender(id)!;
    }
    return this.rerenderWithCopy(r, copy);
  }

  private rerenderWithCopy(r: RenderRow, copy: SocialCopy): RenderRow {
    const next = insertRender({
      batchId: r.batchId,
      conceptId: r.conceptId,
      kind: r.kind,
      recipe: { ...r.recipe, copy: { hook: copy.hook, cta: copy.cta } },
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
    const base = fallbackConcept({ templateId: recipe.templateId, themeId: recipe.themeId, lengthBucket: 'medium', hookStyle: 'question' }, recipe.targetS ?? 30, new Rng(hashSeed(JSON.stringify(recipe))));
    const concept = {
      ...base,
      melodyId: recipe.melodyId,
      params: recipe.params,
      source: 'manual' as const,
      copy: normalizeCopy({ ...base.copy, hook: recipe.copy?.hook || base.copy.hook, cta: recipe.copy?.cta || base.copy.cta }),
    };
    const c = insertConcept(batch.id, conceptsForBatch(batch.id).length, concept);
    const row = insertRender({ batchId: batch.id, conceptId: c.id, kind: 'manual', recipe: recipeFor(concept, recipe.seed), copy: concept.copy, score: null, scoreParts: null, altSeeds: [], rankScore: null });
    this.scheduler.notify();
    return row;
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
    const text = platformText(copy);
    await writeFile(join(dir, 'youtube.txt'), text.youtube + '\n');
    await writeFile(join(dir, 'tiktok.txt'), text.tiktok + '\n');
    await writeFile(join(dir, 'x.txt'), text.x + '\n');
    const features = predictionFor(id)?.features ?? postFeatures(r);
    await copyFile(join(src, 'events.json'), join(dir, 'events.json')).catch(() => {});
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ recipe: r.recipe, copy, score: r.score, qc: r.qc, features }, null, 2));
    // Frozen at first export: what we knew before any results came in.
    const pred = predictFeatures(features);
    insertPredictionOnce({ renderId: id, createdAt: Date.now(), modelVersion: pred?.modelVersion ?? null, mean: pred?.mean ?? null, sd: pred?.sd ?? null, experiment: features.experiment, features });
    const files: Record<string, Uint8Array> = {};
    for (const f of ['video.mp4', 'cover.jpg', 'youtube.txt', 'tiktok.txt', 'x.txt', 'meta.json']) files[f] = new Uint8Array(await readFile(join(dir, f)));
    // Store only: the MP4 is already compressed.
    await writeFile(join(dir, 'bundle.zip'), zipSync(files, { level: 0 }));
    if (r.decision === 'pending') updateRender(id, { decision: 'approved' });
    return insertExport(id, rel);
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
    return { deleted: rows.length, freedBytes: freed };
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
