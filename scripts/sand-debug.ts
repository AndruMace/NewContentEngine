// Dumps the sand grid to PPM images at given times, for debugging container shapes.
import { writeFileSync } from 'node:fs';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from '@sim/templates';

const [container = 'jar', out = '/tmp/sand', ...times] = process.argv.slice(2);
const r = new Runner(getTemplate('sand-pour'), { seed: 1, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params: { container }, visual: false });
for (const ts of times.map(Number)) {
  while (!r.done && r.t < ts) r.advanceFrame();
  const s = r.state;
  const px = Buffer.alloc(s.gw * s.gh * 3);
  for (let i = 0; i < s.grid.length; i++) {
    const v = s.grid[i];
    const c = v === 0 ? (s.inside[i] ? [40, 40, 60] : [0, 0, 0]) : v === 1 ? [255, 255, 255] : [255, 180, 0];
    px.set(c, i * 3);
  }
  writeFileSync(`${out}-${container}-${ts}.ppm`, Buffer.concat([Buffer.from(`P6 ${s.gw} ${s.gh} 255\n`), px]));
  console.log(`t=${r.t.toFixed(1)} filled=${s.filled}/${s.capacity} active=${s.active.length}`);
}
