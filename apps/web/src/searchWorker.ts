/// <reference lib="webworker" />
import type { Recipe } from '@sim/engine';

/**
 * The simulation code is loaded dynamically, after the message handler is in place. Loaded with a
 * static import, its top-level await (Rapier's WASM set-up) leaves the handler unset while the job
 * message arrives, and the job is lost: the worker sat idle forever.
 */
const sims = import('./recipe');

/** One worker's share of a seed search: `count` seeds from `start`. */
export interface SearchRequest {
  recipe: Recipe;
  start: number;
  count: number;
  targetS: number;
}

export interface SearchResult {
  seed: number;
  total: number;
  durationS: number;
  timedOut: boolean;
  notes: string[];
  /** How it came out (template.outcome), for the tally across all seeds. */
  outcome: string | null;
}

export type SearchMessage = { type: 'seed' } | { type: 'done'; results: SearchResult[] };

self.onmessage = async (e: MessageEvent<SearchRequest>) => {
  const { makeRunner } = await sims;
  const { recipe, start, count, targetS } = e.data;
  const results: SearchResult[] = [];
  for (let i = 0; i < count; i++) {
    const seed = start + i;
    const r = makeRunner({ ...recipe, seed }, false).runToEnd();
    const score = r.score(targetS);
    results.push({ seed, total: score.total, durationS: r.durationS, timedOut: r.timedOut, notes: score.notes ?? [], outcome: r.timedOut ? 'no winner (timed out)' : (r.template.outcome?.(r.events) ?? null) });
    // After every seed: heavy templates take a second or more each, so the bar should move.
    self.postMessage({ type: 'seed' } satisfies SearchMessage);
  }
  self.postMessage({ type: 'done', results } satisfies SearchMessage);
};
