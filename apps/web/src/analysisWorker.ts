/// <reference lib="webworker" />
import type { DramaScore, Recipe } from '@sim/engine';
import { makeRunner } from './recipe';

export interface AnalysisResult {
  key: string;
  durationS: number;
  timedOut: boolean;
  score: DramaScore;
}

/** Headless pre-run of a recipe (duration + drama score), off the main thread. */
self.onmessage = (e: MessageEvent<{ key: string; recipe: Recipe }>) => {
  const { key, recipe } = e.data;
  const r = makeRunner(recipe, false).runToEnd();
  const result: AnalysisResult = { key, durationS: r.durationS, timedOut: r.timedOut, score: r.score(recipe.targetS ?? 30) };
  self.postMessage(result);
};
