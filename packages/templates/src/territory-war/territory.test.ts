import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { territoryWar } from './index';

const run = (seed: number, params: Record<string, unknown> = {}) =>
  new Runner(territoryWar, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params, visual: false });

describe('territory war', () => {
  it.each([2, 3, 4])('starts %i teams with equal shares', (sides) => {
    const counts = run(1, { sides }).state.counts;
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('keeps every tile owned and crowns the biggest territory', () => {
    for (const sides of [2, 4]) {
      const r = run(3, { sides, matchSeconds: 14 }).runToEnd();
      const s = r.state;
      expect(s.counts.reduce((a, b) => a + b, 0)).toBe(s.n * s.n);
      expect(s.counts[s.winner]).toBe(Math.max(...s.counts));
      expect(r.events.filter((e) => e.type === 'flip').length).toBeGreaterThan(20);
    }
  });

  it('picks clearly different team colours', () => {
    for (let seed = 0; seed < 20; seed++) {
      const colors = run(seed, { sides: 4, teams: 'countries' }).state.teams.map((t) => t.color);
      expect(new Set(colors).size).toBe(4);
    }
  });
});
