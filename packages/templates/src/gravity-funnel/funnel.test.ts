import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { gravityFunnel } from './index';

const run = (seed: number, params: Record<string, unknown> = {}) =>
  new Runner(gravityFunnel, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params, visual: false }).runToEnd();

describe('gravity funnel', () => {
  it('drops every marble but one and crowns the survivor', () => {
    for (const marbles of [3, 6, 8]) {
      const r = run(4, { marbles });
      const drops = r.events.filter((e) => e.type === 'drop').map((e) => e.who);
      const win = r.events.find((e) => e.type === 'win')!;
      expect(r.timedOut).toBe(false);
      expect(new Set(drops).size).toBe(marbles - 1);
      expect(drops).not.toContain(win.who);
    }
  });

  it('spreads the drops through the match', () => {
    const r = run(2);
    const drops = r.events.filter((e) => e.type === 'drop').map((e) => e.t);
    expect(drops[0]).toBeGreaterThan(3);
    expect(drops[drops.length - 1] - drops[0]).toBeGreaterThan(8);
  });

  it('never gains energy on its own (no flinging back out of the hole)', () => {
    // A lone marble: only rolling friction acts, so its energy may only fall.
    const r = new Runner(gravityFunnel, { seed: 1, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params: { marbles: 3 }, visual: false });
    const s = r.state;
    s.marbles.forEach((m, i) => (m.alive = i === 0));
    const m = s.marbles[0];
    const energy = () => {
      const rr = Math.hypot(m.x, m.z);
      const vr = (m.vx * m.x + m.vz * m.z) / rr;
      const vt = (-m.vx * m.z + m.vz * m.x) / rr;
      const fp = 0.075 / (rr * rr);
      return 0.5 * (vr * vr * (1 + fp * fp) + vt * vt) - (80 * 0.075) / rr;
    };
    let prev = energy();
    let maxR = 0;
    let minR = Infinity;
    while (m.alive && r.t < 80) {
      r.advanceFrame();
      if (!m.alive) break;
      const e = energy();
      expect(e).toBeLessThanOrEqual(prev + 1e-9);
      prev = e;
      const rr = Math.hypot(m.x, m.z);
      minR = Math.min(minR, rr);
      if (minR < 0.25) maxR = Math.max(maxR, rr);
    }
    expect(m.alive).toBe(false);
    // Once it has spiralled close to the hole it never climbs back out toward the rim.
    expect(maxR).toBeLessThan(0.4);
  });

  it('emits nothing after the winner is decided', () => {
    const r = run(3);
    const end = r.events.find((e) => e.type === 'win')!.t;
    expect(r.events.every((e) => e.t <= end)).toBe(true);
  });
});
