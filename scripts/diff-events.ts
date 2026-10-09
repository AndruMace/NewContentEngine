// Prints the first event where a browser render diverged from a Node run of the same recipe.
import { readFileSync } from 'node:fs';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from '@sim/templates';

const dir = process.argv[2];
const recipe = JSON.parse(readFileSync(`${dir}/recipe.json`, 'utf8'));
const browser = JSON.parse(readFileSync(`${dir}/events.json`, 'utf8')).events;
const r = new Runner(getTemplate(recipe.templateId), {
  seed: recipe.seed, params: recipe.params, theme: getTheme(recipe.themeId), melody: getMelody(recipe.melodyId), visual: false,
}).runToEnd();
const i = r.events.findIndex((e, k) => JSON.stringify(e) !== JSON.stringify(browser[k]));
if (i < 0) console.log('identical');
else console.log(`first difference at event ${i}\nnode    ${JSON.stringify(r.events[i])}\nbrowser ${JSON.stringify(browser[i])}`);
