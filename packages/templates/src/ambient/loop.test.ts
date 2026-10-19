import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { drift, loopSin, perLoop, scheduleTimes, timeCircle, wrap } from './loop';

describe('long-form loop helpers', () => {
  const L = 1800;

  it('everything periodic is back where it started at t = L', () => {
    for (const hz of [0.013, 0.7, 3.3, 11]) expect(loopSin(L, L, hz, 0.4)).toBeCloseTo(loopSin(0, L, hz, 0.4), 9);
    expect(drift(L, L, 0.05, 3)).toBeCloseTo(drift(0, L, 0.05, 3), 9);
    const [x0, y0] = timeCircle(0, L, 1.4);
    const [x1, y1] = timeCircle(L, L, 1.4);
    expect(x1).toBeCloseTo(x0, 6);
    expect(y1).toBeCloseTo(y0, 6);
    expect(perLoop(1.3, L) * L).toBe(Math.round(1.3 * L));
  });

  it('noise on the time circle moves at the asked speed', () => {
    const [x0, y0] = timeCircle(10, L, 1.4);
    const [x1, y1] = timeCircle(11, L, 1.4);
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeCloseTo(1.4, 3);
  });

  it('wraps times into [0, L)', () => {
    expect(wrap(-1, L)).toBe(L - 1);
    expect(wrap(L + 2, L)).toBe(2);
  });

  it('schedules events inside the loop, at least the gap apart, also across the wrap', () => {
    for (const seed of [1, 2, 3]) {
      const t = scheduleTimes(new Rng(seed), L, 1 / 60, 20);
      expect(t.length).toBeGreaterThan(10);
      expect(t.every((x) => x >= 0 && x < L)).toBe(true);
      for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeGreaterThanOrEqual(20);
      expect(t[0] + L - t[t.length - 1]).toBeGreaterThanOrEqual(20);
    }
    expect(scheduleTimes(new Rng(1), L, 0)).toEqual([]);
  });
});
