import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Recipe } from '@sim/engine';
import type { SeedResult } from '@sim/render/search';
import type { SearchJob } from './searchWorker';

/**
 * Seed search on worker threads so batches can search several concepts in parallel
 * without blocking the API server. Workers run TypeScript through tsx, like the server.
 */
export class SearchPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: SearchJob; resolve: (r: SeedResult[]) => void; reject: (e: Error) => void }[] = [];
  private pending = new Map<number, { resolve: (r: SeedResult[]) => void; reject: (e: Error) => void; worker: Worker }>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(readonly size = Math.max(1, Math.min(6, cpus().length - 3))) {}

  search(recipe: Recipe, opts: { count: number; targetS: number; start?: number }): Promise<SeedResult[]> {
    return new Promise((resolve, reject) => {
      this.queue.push({ job: { id: this.nextId++, recipe, count: opts.count, targetS: opts.targetS, start: opts.start ?? 0 }, resolve, reject });
      this.pump();
    });
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./searchWorker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
    w.on('message', (msg: { id: number; results?: SeedResult[]; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.results!);
      this.idle.push(w);
      this.pump();
    });
    w.on('error', (err) => this.failWorker(w, err instanceof Error ? err : new Error(String(err))));
    w.on('exit', (code) => code !== 0 && this.failWorker(w, new Error(`search worker exited with ${code}`)));
    this.workers.push(w);
    return w;
  }

  private failWorker(w: Worker, err: Error) {
    for (const [id, p] of this.pending) {
      if (p.worker === w) {
        this.pending.delete(id);
        p.reject(err);
      }
    }
    this.workers = this.workers.filter((x) => x !== w);
    this.idle = this.idle.filter((x) => x !== w);
    this.pump();
  }

  private pump() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    while (this.queue.length) {
      const w = this.idle.pop() ?? (this.workers.length < this.size ? this.spawn() : undefined);
      if (!w) break;
      const item = this.queue.shift()!;
      this.pending.set(item.job.id, { resolve: item.resolve, reject: item.reject, worker: w });
      w.postMessage(item.job);
    }
    // Free the threads after a minute of inactivity.
    if (!this.queue.length && !this.pending.size) this.idleTimer = setTimeout(() => this.close(), 60_000);
  }

  async close() {
    const ws = this.workers;
    this.workers = [];
    this.idle = [];
    await Promise.all(ws.map((w) => w.terminate()));
  }
}
