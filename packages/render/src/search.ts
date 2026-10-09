import { Runner, getTheme, type Recipe } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from '@sim/templates';

export interface SeedResult {
  seed: number;
  total: number;
  durationS: number;
  timedOut: boolean;
  notes: string[];
}

/** Headless seed search: simulate many seeds (no rendering) and rank them by drama score. */
export function searchSeeds(recipe: Recipe, opts: { count: number; targetS: number; start?: number }): SeedResult[] {
  const template = getTemplate(recipe.templateId);
  const theme = getTheme(recipe.themeId);
  const melody = getMelody(recipe.melodyId);
  const start = opts.start ?? 0;
  const results: SeedResult[] = [];
  for (let seed = start; seed < start + opts.count; seed++) {
    const r = new Runner(template, { seed, params: recipe.params, theme, melody, visual: false }).runToEnd();
    const score = r.score(opts.targetS);
    results.push({ seed, total: score.total, durationS: r.durationS, timedOut: r.timedOut, notes: score.notes ?? [] });
  }
  return results.sort((a, b) => b.total - a.total);
}
