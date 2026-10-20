import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { BOGIES, RAIL, RING_STEP, distanceAt, makeMotion, speedAt, timeAt, timetable } from './track';

const L = 1800;
const opts = { speed: 30, jointed: true, crossingsPerHour: 8, tunnelsPerHour: 3, bridgesPerHour: 4, horn: 0.6 };

describe('night train track', () => {
  it('covers exactly the ring, a whole number of rails, in one loop', () => {
    for (const seed of [1, 2, 3]) {
      const { motion } = timetable(opts, L, new Rng(seed));
      expect(motion.D % RING_STEP).toBe(0);
      expect(motion.D % RAIL).toBe(0);
      expect(distanceAt(motion, 0)).toBe(0);
      expect(distanceAt(motion, L)).toBeCloseTo(motion.D, 6);
      // Close to the speed asked for.
      expect(Math.abs(motion.D / L - opts.speed)).toBeLessThan(2);
    }
  });

  it('integrates its speed dips exactly', () => {
    const m = makeMotion(30, L, [
      { t: 400, depth: 0.4, halfS: 50 },
      { t: 1200, depth: 0.3, halfS: 40 },
    ]);
    // Numerical integral of the speed matches the closed form.
    let s = 0;
    const dt = 0.01;
    for (let i = 0; i < 90000; i++) s += speedAt(m, (i + 0.5) * dt) * dt;
    expect(s).toBeCloseTo(distanceAt(m, 900), 2);
    expect(speedAt(m, 400)).toBeCloseTo(m.v * 0.6, 6);
    expect(timeAt(m, distanceAt(m, 777.7), L)).toBeCloseTo(777.7, 6);
  });

  it('clicks at every joint, sorted, inside the loop, keeping the rail rhythm across the join', () => {
    const tt = timetable(opts, L, new Rng(4));
    const { motion, clicks } = tt;
    expect(clicks.length).toBe((motion.D / RAIL) * BOGIES.length);
    for (let i = 1; i < clicks.length; i++) expect(clicks[i]).toBeGreaterThanOrEqual(clicks[i - 1]);
    expect(clicks[0]).toBeGreaterThanOrEqual(0);
    expect(clicks[clicks.length - 1]).toBeLessThan(L);
    // The front bogie's clicks are a rail apart, including from the last one round to the first.
    const front = clicks.filter((t) => {
      const s = distanceAt(motion, t) + BOGIES[1];
      return Math.abs(s / RAIL - Math.round(s / RAIL)) < 1e-6;
    });
    const first = distanceAt(motion, front[0]);
    const last = distanceAt(motion, front[front.length - 1]);
    expect(first + motion.D - last).toBeCloseTo(RAIL, 4);
  });

  it('keeps features apart, inside the loop, never across the join', () => {
    for (const seed of [5, 6, 7, 8]) {
      const { features, cues } = timetable(opts, L, new Rng(seed));
      expect(features.some((f) => f.kind === 'station')).toBe(true);
      for (const f of features) {
        expect(f.t0).toBeGreaterThan(0);
        expect(f.t1).toBeLessThan(L);
        expect(f.s1).toBeGreaterThan(f.s0);
      }
      const sorted = [...features].sort((a, b) => a.t0 - b.t0);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i].t0).toBeGreaterThan(sorted[i - 1].t1);
      for (const c of cues) {
        expect(c.t).toBeGreaterThanOrEqual(0);
        expect(c.t).toBeLessThan(L);
      }
    }
  });

  it('has no clicks on welded track', () => {
    const tt = timetable({ ...opts, jointed: false }, L, new Rng(9));
    expect(tt.clicks).toHaveLength(0);
    expect(tt.cues.every((c) => c.type !== 'click')).toBe(true);
  });
});
