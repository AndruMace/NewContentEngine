// Verifies the browser render produced the exact same event log as a Node run (cross-runtime determinism).
import { readFileSync } from 'node:fs';
import { Runner, getTheme, hashString } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from '@sim/templates';

const dir = process.argv[2];
const recipe = JSON.parse(readFileSync(`${dir}/recipe.json`, 'utf8'));
const browser = JSON.parse(readFileSync(`${dir}/events.json`, 'utf8'));
const r = new Runner(getTemplate(recipe.templateId), {
  seed: recipe.seed, params: recipe.params, theme: getTheme(recipe.themeId), melody: getMelody(recipe.melodyId), visual: false,
}).runToEnd();
const a = hashString(JSON.stringify(r.events));
const b = hashString(JSON.stringify(browser.events));
console.log(`node ${a} (${r.events.length} events)  browser ${b} (${browser.events.length} events)  ${a === b ? 'MATCH' : 'MISMATCH'}`);
process.exitCode = a === b ? 0 : 1;
