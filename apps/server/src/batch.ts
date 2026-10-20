import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { Rng, searchBudgetOf, type Recipe } from '@sim/engine';
import { MELODIES } from '@sim/audio';
import { getTemplate } from '@sim/templates';
import { claudeAvailable, coerceParams, planConcepts, type Concept } from '@sim/planner';
import { copyFeatures } from '@sim/analytics';
import {
  activeBatches,
  conceptsForBatch,
  getBatch,
  insertBatch,
  insertConcept,
  insertRender,
  recentHooks,
  recentMelodies,
  recentNudges,
  recentTitles,
  rendersForBatch,
  updateBatch,
  updateRender,
  type BatchRow,
  type BatchSettings,
  type ConceptRow,
  type RenderRow,
} from './db';
import type { RenderScheduler } from './scheduler';
import type { SearchPool } from './searchPool';
import { refreshYouTube, youtubeStatus } from './youtube';
import { copyPerformance, lastPostedAt, planningModel, predictInput, refitLearner } from './analytics';
import { chooseParams, tasteArmPlanningModel, tastePredict } from './taste';

const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'deleted']);

/** Renders that represent the batch's current candidates (not replaced by a re-roll). */
export const liveRenders = (rows: RenderRow[]) => rows.filter((r) => !r.supersededBy && r.status !== 'deleted');

/** Recipe as rendered: concept + seed, with the on-screen copy. */
export function recipeFor(concept: Concept, seed: number): Recipe {
  return {
    templateId: concept.templateId,
    seed,
    params: concept.params,
    themeId: concept.themeId,
    melodyId: concept.melodyId,
    copy: { hook: concept.copy.hook, cta: concept.copy.cta, ...(concept.copy.nudge ? { nudge: concept.copy.nudge } : {}) },
    targetS: concept.targetS,
  };
}

/**
 * Runs batches: PLAN (arms + Claude concepts) → DIRECT (seed search per concept, in worker
 * threads) → RENDER (queued on the shared scheduler as each search finishes). Every step is
 * idempotent, so the same code resumes a batch interrupted by a server restart.
 */
export class BatchRunner extends EventEmitter {
  private cancelled = new Set<string>();
  private running = new Set<string>();
  private caffeinate: ChildProcess | null = null;

  constructor(
    private scheduler: RenderScheduler,
    private pool: SearchPool,
  ) {
    super();
    scheduler.on('render', (r: RenderRow) => r.batchId && this.emit('changed', r.batchId));
  }

  isBusy() {
    return this.running.size > 0;
  }

  start(settings: BatchSettings): BatchRow {
    if (this.running.size) throw new Error('A batch is already running');
    const batch = insertBatch({ status: 'planning', settings, target: Math.max(1, Math.round(settings.postsWanted * settings.factor)) });
    void this.run(batch.id);
    return batch;
  }

  /** Continue any batch that was in progress when the server stopped. */
  resumeAll() {
    for (const b of activeBatches()) {
      console.log(`Resuming batch ${b.id} (${b.status})`);
      void this.run(b.id);
    }
  }

  cancel(id: string) {
    this.cancelled.add(id);
    for (const r of rendersForBatch(id)) if (r.status === 'queued') updateRender(r.id, { status: 'cancelled' });
    this.emit('changed', id);
  }

  private warn(batchId: string, message: string) {
    const b = getBatch(batchId)!;
    if (!b.warnings.includes(message)) updateBatch(batchId, { warnings: [...b.warnings, message] });
  }

  private setStatus(batchId: string, status: BatchRow['status']) {
    updateBatch(batchId, { status });
    this.emit('changed', batchId);
  }

  private async run(batchId: string) {
    this.running.add(batchId);
    this.keepAwake(true);
    try {
      await this.plan(batchId);
      if (this.cancelled.has(batchId)) return this.finish(batchId, 'cancelled');
      await this.direct(batchId);
      if (this.cancelled.has(batchId)) return this.finish(batchId, 'cancelled');
      this.setStatus(batchId, 'rendering');
      await this.waitForRenders(batchId);
      this.finish(batchId, this.cancelled.has(batchId) ? 'cancelled' : 'done');
    } catch (e) {
      updateBatch(batchId, { status: 'failed', error: (e as Error).message, finishedAt: Date.now() });
      this.emit('changed', batchId);
    } finally {
      this.running.delete(batchId);
      this.cancelled.delete(batchId);
      if (!this.running.size) this.keepAwake(false);
    }
  }

  private async plan(batchId: string) {
    const batch = getBatch(batchId)!;
    const existing = conceptsForBatch(batchId);
    const missing = batch.target - existing.length;
    if (missing <= 0) return;
    this.setStatus(batchId, 'planning');
    const s = batch.settings;
    // Learn from the latest numbers before planning (fresh batches only; bounded so it never stalls the morning run).
    if (!existing.length && youtubeStatus().connected) {
      try {
        const r = await refreshYouTube({ deadline: Date.now() + 20_000 });
        refitLearner();
        if (r.errors.length) this.warn(batchId, `Some YouTube stats didn't refresh: ${r.errors[0]}${r.errors.length > 1 ? ` (+${r.errors.length - 1} more)` : ''}`);
      } catch (e) {
        this.warn(batchId, `YouTube stats not refreshed: ${(e as Error).message}`);
      }
    }
    let generator: 'claude' | 'fallback' | 'mock' = s.useClaude ? 'claude' : 'fallback';
    if (process.env.SIM_PLANNER === 'mock') generator = 'mock';
    if (generator === 'claude' && !claudeAvailable()) {
      generator = 'fallback';
      this.warn(batchId, 'No Anthropic API key found (ANTHROPIC_API_KEY in .env), so concepts use template copy.');
    }
    let idx = existing.length;
    // YouTube results steer once enough posts have matured; until then, the taste model learned
    // from Review decisions does (templates judged by their best settings, not the batch average).
    const youtube = planningModel();
    const model = youtube.ready ? youtube : (tasteArmPlanningModel() ?? youtube);
    await planConcepts(
      {
        count: missing,
        templateIds: s.templateIds,
        themeIds: s.themeIds,
        minLengthS: s.minLengthS,
        maxLengthS: s.maxLengthS,
        lastPostedAt: lastPostedAt(),
        generator,
        seed: hashSeed(batchId) + existing.length,
      },
      model,
      { recentHooks: recentHooks(), notes: s.notes || undefined, chooseParams, recentNudges: recentNudges(), recentTitles: recentTitles(), performanceSummary: copyPerformance() },
      (planned) => {
        if (this.cancelled.has(batchId)) return;
        const concept = planned.concept;
        // Melodies are assigned for variety (never learned): no repeats within the batch.
        concept.melodyId = chooseMelody(batchId, concept.templateId, new Rng(hashSeed(batchId) + idx * 7919));
        insertConcept(batchId, idx++, concept);
        if (planned.warning) this.warn(batchId, planned.warning);
        this.emit('changed', batchId);
      },
    );
  }

  private async direct(batchId: string) {
    this.setStatus(batchId, 'searching');
    const renders = rendersForBatch(batchId);
    const todo = conceptsForBatch(batchId).filter((c) => !renders.some((r) => r.conceptId === c.id));
    await Promise.all(
      todo.map(async (c) => {
        if (this.cancelled.has(batchId)) return;
        await this.searchAndQueue(batchId, c);
      }),
    );
  }

  /** Seed search for a concept, then queue its render. Falls back to default params if nothing finishes. */
  async searchAndQueue(batchId: string, c: ConceptRow, opts: { start?: number; kind?: RenderRow['kind'] } = {}): Promise<RenderRow> {
    const template = getTemplate(c.concept.templateId);
    const budget = searchBudgetOf(template, c.concept.params);
    const start = opts.start ?? (hashSeed(c.id) % 100_000);
    let concept = c.concept;
    let results = await this.pool.search(recipeFor(concept, 0), { count: budget, targetS: concept.targetS, start });
    if (!results.length || results[0].timedOut || results[0].total < 0.02) {
      // The proposed params never produce a good run: retry with the template's tuned defaults.
      concept = { ...concept, params: coerceParams(template, {}) };
      const retry = await this.pool.search(recipeFor(concept, 0), { count: budget, targetS: concept.targetS, start });
      if (retry.length && retry[0].total > (results[0]?.total ?? 0)) {
        results = retry;
        this.warn(batchId, `"${concept.copy.hook}": proposed parameters didn't produce a good run, so defaults were used.`);
      } else concept = c.concept;
    }
    const best = results[0];
    // Rank by what the learner expects of this exact candidate (its real length, drama and copy);
    // until the model is steering, by drama score alone.
    const input = { arm: concept.arm, melodyId: concept.melodyId, durationS: best.durationS, drama: best.total, copy: copyFeatures(concept.copy) };
    const prediction = predictInput(input);
    // Without YouTube data yet, rank by fit to taste (settings included), with drama as a tiebreak.
    const taste = prediction ? null : tastePredict({ ...input, params: concept.params });
    const row = insertRender({
      batchId,
      conceptId: c.id,
      kind: opts.kind ?? 'batch',
      recipe: recipeFor(concept, best.seed),
      copy: concept.copy,
      score: best.total,
      scoreParts: best.parts ?? null,
      altSeeds: results.slice(1, 8).filter((r) => !r.timedOut).map((r) => r.seed),
      rankScore: prediction ? prediction.mean : taste ? taste.mean + 0.3 * best.total : best.total,
      prediction,
    });
    // Cancelled while this search was running: keep the result for reference, don't render it.
    if (this.cancelled.has(batchId)) updateRender(row.id, { status: 'cancelled' });
    this.scheduler.notify();
    this.emit('changed', batchId);
    return row;
  }

  private waitForRenders(batchId: string): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const live = liveRenders(rendersForBatch(batchId));
        if (this.cancelled.has(batchId) ? !live.some((r) => r.status === 'rendering') : live.every((r) => TERMINAL.has(r.status))) {
          this.scheduler.off('render', check);
          clearInterval(timer);
          resolve();
        }
      };
      const timer = setInterval(check, 2000);
      this.scheduler.on('render', check);
      check();
    });
  }

  private finish(batchId: string, status: 'done' | 'cancelled') {
    if (status === 'cancelled') for (const r of rendersForBatch(batchId)) if (r.status === 'queued') updateRender(r.id, { status: 'cancelled' });
    updateBatch(batchId, { status, finishedAt: Date.now() });
    this.emit('changed', batchId);
    this.emit('finished', batchId);
    const b = getBatch(batchId)!;
    if (status === 'done' && b.settings.notifyMac) {
      const ready = liveRenders(rendersForBatch(batchId)).filter((r) => r.status === 'ready').length;
      notifyMac(`${ready} video${ready === 1 ? '' : 's'} ready to review`);
    }
  }

  /** Keep the Mac from sleeping while a batch runs. */
  private keepAwake(on: boolean) {
    if (on && !this.caffeinate && process.platform === 'darwin') {
      this.caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      this.caffeinate.on('error', () => (this.caffeinate = null));
    } else if (!on && this.caffeinate) {
      this.caffeinate.kill();
      this.caffeinate = null;
    }
  }

  /** Estimated seconds until the batch's renders are done. */
  eta(batchId: string): number | null {
    const batch = getBatch(batchId);
    if (!batch || !['planning', 'searching', 'rendering'].includes(batch.status)) return null;
    const k = this.scheduler.secondsPerVideoSecond();
    const live = liveRenders(rendersForBatch(batchId));
    const unplanned = Math.max(0, batch.target - conceptsForBatch(batchId).length);
    const avgLen = (batch.settings.minLengthS + batch.settings.maxLengthS) / 2;
    let s = unplanned * (avgLen * k + 4);
    for (const r of live) {
      const len = r.recipe.targetS ?? avgLen;
      if (r.status === 'queued') s += len * k + 3;
      else if (r.status === 'rendering') s += len * k * (1 - Math.min(0.9, r.progress * 0.65));
    }
    const unsearched = conceptsForBatch(batchId).filter((c) => !live.some((r) => r.conceptId === c.id)).length;
    s += unsearched * (avgLen * k + 3);
    return Math.round(s);
  }
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h % 1_000_000;
}

export function notifyMac(message: string) {
  if (process.platform !== 'darwin') return;
  const esc = (s: string) => s.replace(/["\\]/g, '\\$&');
  spawn('osascript', ['-e', `display notification "${esc(message)}" with title "Sim Studio" sound name "Glass"`], { stdio: 'ignore' }).on('error', () => {});
}

export const ALL_MELODY_IDS = MELODIES.map((m) => m.id);

/**
 * A melody for a new candidate in this batch, chosen for variety: one no other live candidate in
 * the batch uses yet, preferring ones not heard in recent batches; if every melody is taken, the
 * least used. Templates that make their own notes don't use a melody, so they don't take one.
 */
export function chooseMelody(batchId: string, templateId: string, rng: Rng, exclude: string[] = []): string {
  const s = getBatch(batchId)?.settings;
  const pool = (s?.melodyIds.length ? s.melodyIds : ALL_MELODY_IDS).filter((m) => !exclude.includes(m));
  const options = pool.length ? pool : ALL_MELODY_IDS;
  if (getTemplate(templateId).ownMusic) return rng.pick(options);
  const inBatch = new Map<string, number>();
  for (const c of conceptsForBatch(batchId)) {
    if (getTemplate(c.concept.templateId).ownMusic) continue;
    inBatch.set(c.concept.melodyId, (inBatch.get(c.concept.melodyId) ?? 0) + 1);
  }
  for (const r of liveRenders(rendersForBatch(batchId))) if (!getTemplate(r.recipe.templateId).ownMusic) inBatch.set(r.recipe.melodyId, Math.max(inBatch.get(r.recipe.melodyId) ?? 0, 1));
  const recent = new Set(recentMelodies());
  const fewest = Math.min(...options.map((m) => inBatch.get(m) ?? 0));
  const least = options.filter((m) => (inBatch.get(m) ?? 0) === fewest);
  const fresh = least.filter((m) => !recent.has(m));
  return rng.pick(fresh.length ? fresh : least);
}
