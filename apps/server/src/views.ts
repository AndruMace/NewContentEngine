import { join } from 'node:path';
import { platformText } from '@sim/planner';
import {
  conceptsForBatch,
  exportForRender,
  getBatch,
  getConcept,
  postsForRender,
  rendersForBatch,
  type BatchRow,
  type RenderRow,
} from './db';
import { liveRenders } from './batch';
import { copyJobFor } from './review';

/** A render as the review UI sees it: render + concept summary + export + posts. */
export function reviewItem(r: RenderRow) {
  const c = r.conceptId ? getConcept(r.conceptId)?.concept : undefined;
  const ex = exportForRender(r.id);
  return {
    ...r,
    files: r.dir ? { final: join(r.dir, 'final.mp4'), cover: join(r.dir, 'cover.jpg'), contact: join(r.dir, 'contact.jpg') } : null,
    concept: c ? { arm: c.arm, source: c.source, rationale: c.rationale ?? null, targetS: c.targetS, experiment: c.experiment ?? null, paramsSource: c.paramsSource ?? null, notes: c.notes ?? null } : null,
    platformText: r.copy ? platformText(r.copy) : null,
    /** Claude writing upload text in the background (null when nothing has run since the server started). */
    copyJob: copyJobFor(r.id),
    export: ex ? { id: ex.id, dir: ex.dir, createdAt: ex.createdAt } : null,
    posts: postsForRender(r.id),
  };
}

const rankKey = (r: RenderRow) =>
  (r.status === 'ready' ? 0 : r.status === 'rendering' || r.status === 'queued' ? 1 : 2) * 10 + (r.status === 'ready' && r.qc && !r.qc.pass ? 5 : 0);

export function batchSnapshot(id: string, eta: number | null) {
  const batch = getBatch(id);
  if (!batch) return null;
  const all = rendersForBatch(id);
  const live = liveRenders(all).sort((a, b) => rankKey(a) - rankKey(b) || (b.rankScore ?? 0) - (a.rankScore ?? 0) || a.createdAt - b.createdAt);
  return {
    batch,
    planned: conceptsForBatch(id).length,
    items: live.map(reviewItem),
    counts: countBy(live),
    eta,
  };
}

export function batchSummary(b: BatchRow) {
  const live = liveRenders(rendersForBatch(b.id));
  return { ...b, counts: countBy(live), approved: live.filter((r) => r.decision === 'approved').length };
}

function countBy(rows: RenderRow[]) {
  const c = { queued: 0, rendering: 0, ready: 0, failed: 0, cancelled: 0 };
  for (const r of rows) if (r.status in c) c[r.status as keyof typeof c]++;
  return c;
}
