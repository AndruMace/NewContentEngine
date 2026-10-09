// Prints liquid sim health per simulated second (particle count, density, speed, extent, step time).
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from '@sim/templates';

const params = JSON.parse(process.argv[2] ?? '{}');
const seconds = Number(process.argv[3] ?? 8);
const r = new Runner(getTemplate('liquid-mix'), { seed: 1, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params, visual: false });
let t0 = performance.now();
while (!r.done && r.t < seconds) {
  r.advanceFrame();
  if (r.frame % 60 === 0) {
    const s = r.state;
    let maxV = 0, minY = 1e9, maxY = -1e9, outside = 0;
    for (let i = 0; i < s.n; i++) {
      maxV = Math.max(maxV, Math.hypot(s.vx[i], s.vy[i]));
      minY = Math.min(minY, s.y[i]);
      maxY = Math.max(maxY, s.y[i]);
      if (s.y[i] > 1600) outside++;
    }
    console.log(`t=${r.t.toFixed(0)} n=${s.n} maxV=${maxV.toFixed(0)} y=[${minY.toFixed(0)},${maxY.toFixed(0)}] spilled=${outside} ${(performance.now() - t0).toFixed(0)}ms`);
    t0 = performance.now();
  }
}
