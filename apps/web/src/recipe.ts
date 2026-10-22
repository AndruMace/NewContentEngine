import { Runner, getTheme, type Recipe } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from '@sim/templates';

export function makeRunner(recipe: Recipe, visual = true) {
  return new Runner(getTemplate(recipe.templateId), {
    seed: recipe.seed,
    params: recipe.params,
    theme: getTheme(recipe.themeId),
    melody: getMelody(recipe.melodyId),
    copy: recipe.copy,
    visual,
    voice: recipe.voice,
  });
}

/** Shell-safe single-quoted string. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function renderCommand(recipe: Recipe) {
  return `npm run render -- --recipe-json ${shellQuote(JSON.stringify(recipe))}`;
}
