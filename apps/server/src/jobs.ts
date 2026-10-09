import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import type { Recipe } from '@sim/engine';
import { RENDERS_DIR, RenderHarness, renderRecipe, searchSeeds, type RenderOutput, type RenderStage } from '@sim/render';

export type JobStatus = 'queued' | 'searching' | RenderStage | 'done' | 'error';

export interface JobView {
  id: string;
  recipe: Recipe;
  status: JobStatus;
  /** 0..1 within the frames stage. */
  progress: number;
  createdAt: number;
  error?: string;
  result?: RenderOutput & { files: { final: string; cover: string; contact: string; dir: string } };
}

type Listener = (job: JobView) => void;

/**
 * Serial in-memory render queue (one Chrome instance, reused across jobs).
 * Persistence moves to SQLite with the Phase 4 review queue.
 */
export class RenderQueue {
  private jobs = new Map<string, JobView>();
  private listeners = new Map<string, Set<Listener>>();
  private chain: Promise<void> = Promise.resolve();
  private harness: RenderHarness | null = null;

  list(): JobView[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  subscribe(id: string, fn: Listener) {
    const set = this.listeners.get(id) ?? new Set();
    set.add(fn);
    this.listeners.set(id, set);
    return () => set.delete(fn);
  }

  private update(job: JobView, patch: Partial<JobView>) {
    Object.assign(job, patch);
    for (const fn of this.listeners.get(job.id) ?? []) fn(job);
  }

  enqueue(recipe: Recipe, opts: { search?: number } = {}): JobView {
    const job: JobView = { id: randomUUID().slice(0, 8), recipe, status: 'queued', progress: 0, createdAt: Date.now() };
    this.jobs.set(job.id, job);
    this.chain = this.chain.then(() => this.run(job, opts));
    return job;
  }

  private async run(job: JobView, opts: { search?: number }) {
    try {
      let recipe = job.recipe;
      if (opts.search) {
        this.update(job, { status: 'searching' });
        const targetS = recipe.targetS ?? 30;
        const best = searchSeeds(recipe, { count: opts.search, targetS, start: recipe.seed })[0];
        recipe = { ...recipe, seed: best.seed, targetS };
        this.update(job, { recipe });
      }
      if (!this.harness) {
        this.harness = new RenderHarness();
        await this.harness.start();
      }
      let lastPct = -1;
      const out = await renderRecipe(recipe, {
        harness: this.harness,
        onStage: (stage) => this.update(job, { status: stage }),
        onProgress: (frame, est) => {
          const pct = Math.floor((frame / est) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            this.update(job, { progress: frame / est });
          }
        },
      });
      const rel = (p: string) => relative(RENDERS_DIR, p);
      this.update(job, {
        status: 'done',
        progress: 1,
        result: { ...out, files: { final: rel(out.final), cover: rel(out.cover), contact: rel(out.contact), dir: rel(out.dir) } },
      });
    } catch (e) {
      // A crashed browser should not poison later jobs.
      await this.harness?.stop().catch(() => {});
      this.harness = null;
      this.update(job, { status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  async close() {
    await this.harness?.stop();
  }
}
