/// <reference lib="webworker" />
import type { DramaScore, Recipe } from '@sim/engine';

/**
 * The simulation code is loaded dynamically, after the message handler is in place (statically
 * imported, its top-level await leaves the handler unset when the message arrives, and it's lost).
 */
const sims = import('./recipe');

export interface AnalysisResult {
  key: string;
  durationS: number;
  timedOut: boolean;
  score: DramaScore;
}

/** Headless pre-run of a recipe (duration + drama score), off the main thread. */
self.onmessage = async (e: MessageEvent<{ key: string; recipe: Recipe }>) => {
  const { makeRunner } = await sims;
  const { key, recipe } = e.data;
  const r = makeRunner(recipe, false).runToEnd();
  const result: AnalysisResult = { key, durationS: r.durationS, timedOut: r.timedOut, score: r.score(recipe.targetS ?? 30) };
  self.postMessage(result);
};
