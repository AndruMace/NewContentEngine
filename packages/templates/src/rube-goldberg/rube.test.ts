import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { generate } from './generate';
import { MODULES, RAMP } from './modules/index';
import { rubeGoldberg } from './index';
import { FOV, cameraPose, watchedAt } from './view3d';
import { THREE } from '../three-layer';

describe('rube goldberg', () => {
  it('generates a complete, working machine for every seed, within budget', () => {
    const times: number[] = [];
    for (let seed = 0; seed < 10; seed++) {
      const t0 = performance.now();
      const m = generate(new Rng(seed * 13 + 5), { targetS: 30, marble: seed % 2 ? 'steel' : 'glass' });
      const ms = performance.now() - t0;
      expect(m.stages[0].kind).toBe('start');
      expect(m.stages[m.stages.length - 1].kind).toBe('bell');
      expect(m.stages.length).toBeGreaterThanOrEqual(6);
      // Stages hand off end to start, in order.
      for (let k = 1; k < m.stages.length; k++) expect(m.stages[k].from).toBe(m.stages[k - 1].to);
      // The bell really rang, by the marble striking it.
      expect(m.sim.events.some((e) => e.type === 'ding')).toBe(true);
      expect(m.sim.events.some((e) => e.type === 'impact' && (e.tagA === 'bell' || e.tagB === 'bell'))).toBe(true);
      expect(Math.abs(m.steps / 240 - 30)).toBeLessThan(10);
      times.push(ms);
      m.sim.free();
    }
    // Budget on the average (single seeds vary, and the suite runs files in parallel), with a hard
    // ceiling that still catches a generator gone wrong.
    expect(times.reduce((a, b) => a + b, 0) / times.length).toBeLessThan(3000);
    expect(Math.max(...times)).toBeLessThan(12000);
  });

  it.each(MODULES.filter((m) => m !== RAMP).map((m) => m.kind))('%s works when it is the only contraption on offer', (kind) => {
    let used = 0;
    for (let seed = 0; seed < 3; seed++) {
      const m = generate(new Rng(seed + 101), { targetS: 20, marble: 'glass', modules: MODULES.filter((d) => d.kind === kind || d === RAMP) });
      used += m.stages.filter((s) => s.kind === kind).length;
      m.sim.free();
    }
    expect(used).toBeGreaterThan(0);
  });

  it('plays the same tape every time', () => {
    const run = () =>
      new Runner(rubeGoldberg, { seed: 4, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params: { durationS: 20 }, visual: false }).runToEnd();
    const a = run();
    const b = run();
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.events.filter((e) => e.type === 'impact').length).toBeGreaterThan(20);
  });

  it('keeps the marble in frame the whole way down', () => {
    const cam = new THREE.PerspectiveCamera(FOV, 1080 / 1920, 0.02, 40);
    for (const seed of [1, 2, 3]) {
      const r = new Runner(rubeGoldberg, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params: { durationS: 30 }, visual: false });
      const s = r.state;
      let worst = 0;
      // From the first frame to the bell (60 checks a second).
      for (let t = 0; t < (s.finaleStep / 240); t += 1 / 60) {
        const { pos, look } = cameraPose(s, t);
        cam.position.copy(pos);
        cam.lookAt(look);
        cam.updateMatrixWorld();
        const m = watchedAt(s, t);
        const p = new THREE.Vector3(m.x, m.y, m.z).project(cam);
        worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
      }
      // Well inside the frame (not just on it): |NDC| < 0.7.
      expect(worst).toBeLessThan(0.7);
    }
  });

  it('never drops below the machine before the finale', () => {
    const s = new Runner(rubeGoldberg, { seed: 2, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params: { durationS: 30 }, visual: false }).state;
    const bell = s.bodies.findIndex((b) => b.pieces.some((p) => p.finish === 'bell'));
    const bellY = s.frames[s.firstFrame[bell]][bell * 7 + 1];
    for (let t = 0; t < s.steps / 240; t += 1 / 30) expect(cameraPose(s, t).look.y).toBeGreaterThan(bellY - 0.12);
    // It opens close on the ball and ends wide, on the whole machine.
    const near = cameraPose(s, 0.1);
    const far = cameraPose(s, s.steps / 240 - 0.05);
    expect(near.pos.distanceTo(near.look)).toBeLessThan(1.5);
    expect(far.pos.distanceTo(far.look)).toBeGreaterThan(near.pos.distanceTo(near.look) * 2);
  });
});
