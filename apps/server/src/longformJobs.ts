/**
 * Long-form (ambient) render jobs: queued from the Ambient page, rendered by the shared scheduler
 * (after any queued Shorts), resumable after a restart. Kept in their own table, away from the Shorts
 * renders that batches, review and analytics read.
 */
import { randomUUID } from 'node:crypto';
import type { Recipe } from '@sim/engine';
import type { LongFormCopy } from '@sim/planner';
import { db } from './db';

export type LongFormStatus = 'queued' | 'rendering' | 'ready' | 'failed' | 'cancelled';

export interface LongFormResult {
  qcPass: boolean;
  problems: string[];
  integratedLufs: number;
  truePeakDb: number;
  durationS: number;
  loopS: number;
  sizeBytes: number;
  timings: { framesMs: number; audioMs: number; masterMs: number; totalMs: number };
}

export interface LongFormJob {
  id: string;
  createdAt: number;
  recipe: Recipe & { loopS: number; totalS: number };
  notes: string | null;
  status: LongFormStatus;
  stage: string | null;
  progress: number;
  /** Folder relative to data/renders. */
  dir: string | null;
  result: LongFormResult | null;
  error: string | null;
  copy: LongFormCopy | null;
  copyStatus: 'none' | 'writing' | 'ready' | 'failed';
  copyError: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const json = <T>(s: unknown, fallback: T): T => (typeof s === 'string' ? (JSON.parse(s) as T) : fallback);

const toJob = (r: any): LongFormJob => ({
  id: r.id,
  createdAt: r.created_at,
  recipe: json(r.recipe, null as never),
  notes: r.notes,
  status: r.status,
  stage: r.stage,
  progress: r.progress,
  dir: r.dir,
  result: json(r.result, null),
  error: r.error,
  copy: json(r.copy, null),
  copyStatus: r.copy_status,
  copyError: r.copy_error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export function insertLongFormJob(recipe: LongFormJob['recipe'], notes: string | null): LongFormJob {
  const id = randomUUID().slice(0, 8);
  db.prepare('INSERT INTO longform_jobs (id, created_at, recipe, notes, status) VALUES (?, ?, ?, ?, ?)').run(id, Date.now(), JSON.stringify(recipe), notes, 'queued');
  return getLongFormJob(id)!;
}

export function getLongFormJob(id: string): LongFormJob | undefined {
  const r = db.prepare('SELECT * FROM longform_jobs WHERE id = ?').get(id);
  return r ? toJob(r) : undefined;
}

export function listLongFormJobs(): LongFormJob[] {
  return db.prepare('SELECT * FROM longform_jobs ORDER BY created_at DESC').all().map(toJob);
}

export function nextQueuedLongFormJob(): LongFormJob | undefined {
  const r = db.prepare("SELECT * FROM longform_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get();
  return r ? toJob(r) : undefined;
}

const COLS: Record<string, string> = {
  status: 'status', stage: 'stage', progress: 'progress', dir: 'dir', result: 'result', error: 'error',
  copy: 'copy', copyStatus: 'copy_status', copyError: 'copy_error', startedAt: 'started_at', finishedAt: 'finished_at', notes: 'notes',
};
const JSON_COLS = new Set(['result', 'copy']);

export function updateLongFormJob(id: string, patch: Partial<Omit<LongFormJob, 'id' | 'createdAt' | 'recipe'>>) {
  const entries = Object.entries(patch).filter(([k]) => k in COLS);
  if (!entries.length) return;
  const sql = `UPDATE longform_jobs SET ${entries.map(([k]) => `${COLS[k]} = ?`).join(', ')} WHERE id = ?`;
  const values = entries.map(([k, v]) => (JSON_COLS.has(k) ? (v == null ? null : JSON.stringify(v)) : (v as string | number | null)));
  db.prepare(sql).run(...values, id);
}

export function deleteLongFormJob(id: string) {
  db.prepare('DELETE FROM longform_jobs WHERE id = ?').run(id);
}

/** After a restart: jobs that were rendering go back in the queue (their finished segments are kept). */
export function requeueInterruptedLongForm(): number {
  return Number(db.prepare("UPDATE longform_jobs SET status = 'queued', stage = NULL WHERE status = 'rendering'").run().changes);
}
