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
import { tasteInput, tastePredict } from './taste';

/** A render as the review UI sees it: render + concept summary + export + posts. */
export function reviewItem(r: RenderRow) {
  const c = r.conceptId ? getConcept(r.conceptId)?.concept : undefined;
  const ex = exportForRender(r.id);
  return {
    ...r,
    files: r.dir ? { final: join(r.dir, 'final.mp4'), cover: join(r.dir, 'cover.jpg'), contact: join(r.dir, 'contact.jpg') } : null,
    concept: c ? { arm: c.arm, source: c.source, rationale: c.rationale ?? null, targetS: c.targetS, experiment: c.experiment ?? null, paramsSource: c.paramsSource ?? null } : null,
    taste: tasteFor(r),
    platformText: r.copy ? platformText(r.copy) : null,
    export: ex ? { id: ex.id, dir: ex.dir, createdAt: ex.createdAt } : null,
    posts: postsForRender(r.id),
  };
}

/** How well the candidate fits the owner's taste (approval chance), once the taste model is ready. */
function tasteFor(r: RenderRow): { chance: number } | null {
  if (r.kind === 'export') return null;
  const input = tasteInput(r);
  const p = input && tastePredict(input);
  return p ? { chance: Math.round(p.chance * 100) / 100 } : null;
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

/** Shape the Playground's Export panel expects (mirrors the pre-database job view). */
export function jobView(r: RenderRow) {
  const status =
    r.status === 'queued' ? 'queued' : r.status === 'rendering' ? (r.stage ?? 'frames') : r.status === 'ready' ? 'done' : 'error';
  return {
    id: r.id,
    recipe: r.recipe,
    status,
    progress: r.progress,
    createdAt: r.createdAt,
    error: r.error ?? (r.status === 'cancelled' ? 'Cancelled' : undefined),
    result:
      r.status === 'ready' && r.dir
        ? {
            durationS: r.durationS,
            score: { total: r.score ?? 0, parts: r.scoreParts ?? {} },
            qc: r.qc,
            codec: 'avc',
            timings: { totalMs: r.renderMs ?? 0 },
            files: { final: join(r.dir, 'final.mp4'), cover: join(r.dir, 'cover.jpg'), contact: join(r.dir, 'contact.jpg'), dir: r.dir },
          }
        : undefined,
  };
}
