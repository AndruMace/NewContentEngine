/// <reference lib="webworker" />
import type { Recipe } from '@sim/engine';
import { makeRunner } from './recipe';

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
}

self.onmessage = (e: MessageEvent<SearchRequest>) => {
  const { recipe, start, count, targetS } = e.data;
  const results: SearchResult[] = [];
  for (let i = 0; i < count; i++) {
    const seed = start + i;
    const r = makeRunner({ ...recipe, seed }, false).runToEnd();
    const score = r.score(targetS);
    results.push({ seed, total: score.total, durationS: r.durationS, timedOut: r.timedOut, notes: score.notes ?? [] });
    if (i % 25 === 0) self.postMessage({ type: 'progress', done: i, count });
  }
  results.sort((a, b) => b.total - a.total);
  self.postMessage({ type: 'done', results: results.slice(0, 12) });
};
