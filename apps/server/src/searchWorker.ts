import { parentPort } from 'node:worker_threads';
import type { Recipe } from '@sim/engine';
import { searchSeeds } from '@sim/render/search';

export interface SearchJob {
  id: number;
  recipe: Recipe;
  count: number;
  targetS: number;
  start: number;
}

parentPort!.on('message', (job: SearchJob) => {
  try {
    const results = searchSeeds(job.recipe, { count: job.count, targetS: job.targetS, start: job.start });
    parentPort!.postMessage({ id: job.id, results: results.slice(0, 8) });
  } catch (e) {
    parentPort!.postMessage({ id: job.id, error: (e as Error).message });
  }
});
