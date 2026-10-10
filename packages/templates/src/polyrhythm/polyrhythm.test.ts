import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { PATTERNS, patternRates, polygonSides } from './patterns';
import { POLYRHYTHM_STYLES, polyrhythm } from './index';

const run = (params: Record<string, unknown>, seed = 1) =>
  new Runner(polyrhythm, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params: { loopSeconds: 12, ...params }, visual: false }).runToEnd();

describe('polyrhythm', () => {
  it.each(POLYRHYTHM_STYLES.flatMap((style) => PATTERNS.map((pattern) => [style, pattern] as const)))('%s / %s loops exactly', (style, pattern) => {
    const r = run({ style, pattern, count: 12 });
    expect(r.timedOut).toBe(false);
    expect(r.durationS).toBeCloseTo(12, 1);
    const s = r.state;
    const hits = r.events.filter((e) => e.type === 'hit');
    // Every element plays exactly its whole number of notes, evenly spaced, starting together at 0.
    s.notesPerLoop.forEach((m, i) => {
      const mine = hits.filter((e) => e.i === i);
      expect(Number.isInteger(m)).toBe(true);
      expect(mine).toHaveLength(m);
      expect(mine[0].t).toBe(0);
      if (m > 1) expect(mine[1].t - mine[0].t).toBeCloseTo(12 / m, 1);
    });
  });

  it('builds the speed patterns', () => {
    const rng = new Rng(1);
    expect(patternRates('linear', 5, 10, 1, rng)).toEqual([10, 11, 12, 13, 14]);
    expect(patternRates('harmonic', 4, 10, 1, rng)).toEqual([3, 6, 9, 12]);
    expect(patternRates('primes', 4, 10, 1, rng)).toEqual([3, 5, 7, 11]);
    expect(patternRates('mirror', 5, 10, 1, rng)).toEqual([12, 11, 10, 11, 12]);
    const rand = patternRates('random', 8, 10, 1, rng);
    expect(new Set(rand).size).toBe(8);
    expect([...rand].sort((a, b) => a - b)).toEqual(rand);
    expect(polygonSides('linear', 4, 1, rng)).toEqual([3, 4, 5, 6]);
    expect(polygonSides('primes', 4, 1, rng)).toEqual([3, 5, 7, 11]);
  });

  it('caps polygons and lanes to what reads on screen', () => {
    expect(run({ style: 'polygons', count: 30 }).state.sides).toHaveLength(10);
    expect(run({ style: 'piano', count: 30 }).state.cycles).toHaveLength(24);
  });
});
