import { EventEmitter } from 'node:events';
import { join, relative } from 'node:path';
import { RENDERS_DIR, RenderHarness, renderRecipe } from '@sim/render';
import { getRender, nextQueuedRender, requeueInterrupted, updateRender, type RenderRow } from './db';

/**
 * Single serial render worker shared by batch candidates, manual adds and Playground
 * exports. The queue lives in SQLite, so renders survive server restarts.
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
  /** Recent render time per second of video, for ETAs. */
  private ratios: number[] = [];

  start() {
    const n = requeueInterrupted();
    if (n) console.log(`Resuming ${n} interrupted render(s)`);
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

  async stop() {
    this.stopping = true;
    this.running = false;
    this.wake?.();
    await this.harness?.stop().catch(() => {});
  }
}
