import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { LongFormCancelled, RENDERS_DIR, RenderHarness, renderLongForm, renderRecipe, type LongFormStage } from '@sim/render';
import { getRender, nextQueuedRender, requeueInterrupted, updateRender, type RenderRow } from './db';
import { getLongFormJob, nextQueuedLongFormJob, requeueInterruptedLongForm, updateLongFormJob, type LongFormJob } from './longformJobs';

/** How far through a long-form render each stage starts, for one overall progress bar. */
const LONG_STAGES: Record<LongFormStage, [number, number]> = {
  prepare: [0, 0.01],
  frames: [0.01, 0.82],
  audio: [0.82, 0.9],
  joining: [0.9, 0.92],
  mastering: [0.92, 0.97],
  qc: [0.97, 1],
};

/**
 * Single serial render worker shared by batch candidates, manual adds, Playground exports and
 * long-form (ambient) videos. Shorts go first; a long-form job starts only when no Shorts are
 * queued (it can take half an hour or more). The queues live in SQLite, so renders survive restarts,
 * and a long-form job picks up after its last finished segment.
 */
export class RenderScheduler extends EventEmitter {
  private harness: RenderHarness | null = null;
  private running = false;
  private stopping = false;
  /** Renders already retried once after a browser crash. */
  private retried = new Set<string>();
  private wake: (() => void) | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  current: string | null = null;
  /** The long-form job rendering now, and how to stop it. */
  currentLongForm: string | null = null;
  private longAbort: AbortController | null = null;
  private caffeinate: ChildProcess | null = null;
  /** Recent render time per second of video, for ETAs. */
  private ratios: number[] = [];

  start() {
    const n = requeueInterrupted();
    if (n) console.log(`Resuming ${n} interrupted render(s)`);
    const m = requeueInterruptedLongForm();
    if (m) console.log(`Resuming ${m} interrupted long-form render(s)`);
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  /** New work was queued. */
  notify() {
    this.wake?.();
  }

  /** Seconds of wall time per second of video (rolling average). */
  secondsPerVideoSecond(): number {
    return this.ratios.length ? this.ratios.reduce((a, b) => a + b, 0) / this.ratios.length : 1.15;
  }

  private emitRender(id: string) {
    const row = getRender(id);
    if (row) this.emit('render', row);
  }

  private async loop() {
    while (this.running) {
      const next = nextQueuedRender();
      const long = next ? undefined : nextQueuedLongFormJob();
      if (long) {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        await this.renderLongFormJob(long);
        continue;
      }
      if (!next) {
        this.scheduleIdleShutdown();
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          setTimeout(resolve, 3000);
        });
        this.wake = null;
        continue;
      }
      if (this.idleTimer) clearTimeout(this.idleTimer);
      await this.renderOne(next);
    }
  }

  private scheduleIdleShutdown() {
    if (this.idleTimer || !this.harness) return;
    this.idleTimer = setTimeout(async () => {
      this.idleTimer = null;
      const h = this.harness;
      this.harness = null;
      await h?.stop().catch(() => {});
    }, 90_000);
  }

  private async renderOne(job: RenderRow) {
    const started = Date.now();
    this.current = job.id;
    updateRender(job.id, { status: 'rendering', stage: 'frames', progress: 0, startedAt: started, error: null });
    this.emitRender(job.id);
    const day = new Date().toISOString().slice(0, 10);
    const outDir = join(RENDERS_DIR, day, `${job.kind}-${job.recipe.templateId}-${job.recipe.seed}-${job.id}`);
    try {
      if (!this.harness) {
        this.harness = new RenderHarness();
        await this.harness.start();
      }
      let lastPct = -1;
      const out = await renderRecipe(job.recipe, {
        outDir,
        harness: this.harness,
        onStage: (stage) => {
          updateRender(job.id, { stage });
          this.emitRender(job.id);
        },
        onWarning: (message) => console.warn(`[render ${job.id}] ${message}`),
        onProgress: (frame, est) => {
          const pct = Math.floor((frame / est) * 50);
          if (pct === lastPct) return;
          lastPct = pct;
          updateRender(job.id, { progress: frame / est });
          this.emitRender(job.id);
        },
      });
      const renderMs = Date.now() - started;
      this.ratios = [...this.ratios.slice(-9), renderMs / 1000 / out.durationS];
      updateRender(job.id, {
        status: getRender(job.id)?.status === 'cancelled' ? 'cancelled' : 'ready',
        stage: null,
        progress: 1,
        dir: relative(RENDERS_DIR, out.dir),
        // With its narration, if it has one: review and re-renders then play the same lines.
        recipe: out.recipe,
        qc: out.qc,
        durationS: out.durationS,
        renderMs,
        finishedAt: Date.now(),
        ...(job.kind === 'export' ? { score: out.score.total, scoreParts: out.score.parts } : {}),
      });
    } catch (e) {
      const message = (e as Error).message;
      // A crashed browser shouldn't poison later jobs.
      await this.harness?.stop().catch(() => {});
      this.harness = null;
      if (this.stopping) {
        // Server shutting down: leave it queued so it resumes on restart.
        updateRender(job.id, { status: 'queued', stage: null, progress: 0 });
      } else if (/closed|crash|Target page|Protocol error/i.test(message) && !this.retried.has(job.id)) {
        this.retried.add(job.id);
        updateRender(job.id, { status: 'queued', stage: null, progress: 0 });
      } else {
        updateRender(job.id, { status: 'failed', stage: null, error: message, finishedAt: Date.now() });
      }
    } finally {
      this.current = null;
      this.emitRender(job.id);
    }
  }

  /** Stop a long-form job: it finishes the segment it's on (kept, for resuming) and is marked cancelled. */
  cancelLongForm(id: string) {
    if (this.currentLongForm === id) {
      this.longAbort?.abort();
      updateLongFormJob(id, { stage: 'cancelling' });
    } else {
      const j = getLongFormJob(id);
      if (j?.status === 'queued') updateLongFormJob(id, { status: 'cancelled', stage: null });
    }
    this.emitLongForm(id);
  }

  private emitLongForm(id: string) {
    const j = getLongFormJob(id);
    if (j) this.emit('longform', j);
  }

  private keepAwake(on: boolean) {
    if (on && !this.caffeinate && process.platform === 'darwin') {
      this.caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      this.caffeinate.on('error', () => (this.caffeinate = null));
    } else if (!on && this.caffeinate) {
      this.caffeinate.kill();
      this.caffeinate = null;
    }
  }

  private async renderLongFormJob(job: LongFormJob) {
    this.currentLongForm = job.id;
    this.longAbort = new AbortController();
    this.keepAwake(true);
    const day = new Date(job.createdAt).toISOString().slice(0, 10);
    const outDir = join(RENDERS_DIR, day, `longform-${job.recipe.templateId}-${job.recipe.seed}-${job.id}`);
    updateLongFormJob(job.id, { status: 'rendering', stage: 'prepare', startedAt: job.startedAt ?? Date.now(), error: null, dir: relative(RENDERS_DIR, outDir) });
    this.emitLongForm(job.id);
    let lastPct = -1;
    const report = (stage: LongFormStage, k: number) => {
      const [a, b] = LONG_STAGES[stage];
      const progress = a + (b - a) * Math.max(0, Math.min(1, k));
      const pct = Math.floor(progress * 200);
      if (pct === lastPct) return;
      lastPct = pct;
      updateLongFormJob(job.id, { stage: this.longAbort?.signal.aborted && !this.stopping ? 'cancelling' : stage, progress });
      this.emitLongForm(job.id);
    };
    try {
      if (!this.harness) {
        this.harness = new RenderHarness();
        await this.harness.start();
      }
      const out = await renderLongForm(job.recipe, {
        outDir,
        harness: this.harness,
        signal: this.longAbort.signal,
        onStage: (stage) => report(stage, 0),
        onProgress: (stage, done, total) => report(stage, done / total),
      });
      const q = out.qc;
      updateLongFormJob(job.id, {
        status: 'ready',
        stage: null,
        progress: 1,
        finishedAt: Date.now(),
        result: {
          qcPass: q.pass,
          problems: q.problems,
          integratedLufs: q.integratedLufs,
          truePeakDb: q.truePeakDb,
          durationS: q.durationS,
          loopS: out.loopS,
          sizeBytes: (await stat(out.final)).size,
          timings: out.timings,
        },
      });
    } catch (e) {
      const message = (e as Error).message;
      if (e instanceof LongFormCancelled) {
        // Shutting down: back in the queue to resume after the restart; otherwise the user cancelled.
        updateLongFormJob(job.id, { status: this.stopping ? 'queued' : 'cancelled', stage: null });
      } else {
        await this.harness?.stop().catch(() => {});
        this.harness = null;
        if (this.stopping) updateLongFormJob(job.id, { status: 'queued', stage: null });
        else if (/closed|crash|Target page|Protocol error/i.test(message) && !this.retried.has(job.id)) {
          this.retried.add(job.id);
          updateLongFormJob(job.id, { status: 'queued', stage: null });
        } else updateLongFormJob(job.id, { status: 'failed', stage: null, error: message, finishedAt: Date.now() });
      }
    } finally {
      this.currentLongForm = null;
      this.longAbort = null;
      this.keepAwake(false);
      this.emitLongForm(job.id);
    }
  }

  async stop() {
    this.stopping = true;
    this.longAbort?.abort();
    this.running = false;
    this.wake?.();
    await this.harness?.stop().catch(() => {});
  }
}
