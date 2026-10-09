// Quick stats: escape durations and drama scores across seeds for a template.
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from '@sim/templates';

const [templateId = 'ring-escape', n = '200', target = '30', paramsJson = '{}'] = process.argv.slice(2);
const template = getTemplate(templateId);
const theme = getTheme('neon-dark');
const melody = getMelody('ode-to-joy');
const durs: number[] = [];
const scores: { seed: number; total: number; dur: number }[] = [];
const t0 = performance.now();
for (let seed = 0; seed < Number(n); seed++) {
  const r = new Runner(template, { seed, theme, melody, visual: false, params: JSON.parse(paramsJson) }).runToEnd();
  const sc = r.score(Number(target));
  if (!r.timedOut) durs.push(r.durationS);
  scores.push({ seed, total: sc.total, dur: r.durationS });
}
const ms = performance.now() - t0;
durs.sort((a, b) => a - b);
const q = (p: number) => durs[Math.floor(p * (durs.length - 1))]?.toFixed(1);
console.log(`${n} runs in ${ms.toFixed(0)}ms (${(ms / Number(n)).toFixed(1)}ms/run); escaped ${durs.length}`);
console.log(`duration p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)}`);
scores.sort((a, b) => b.total - a.total);
console.log('top seeds', scores.slice(0, 5).map((s) => `${s.seed}:${s.total.toFixed(3)}@${s.dur.toFixed(1)}s`).join('  '));
