import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { preyOf, rpsBattle } from './index';

const run = (seed: number, params: Record<string, unknown> = {}) =>
  new Runner(rpsBattle, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params, visual: false });

describe('rps battle', () => {
  it('makes each side beat exactly one other', () => {
    expect([0, 1, 2].map(preyOf).sort()).toEqual([0, 1, 2]);
    for (const k of [0, 1, 2]) expect(preyOf(k)).not.toBe(k);
  });

  it('only ever converts a unit to the side that beats it, keeping the total', () => {
    for (const seed of [1, 2, 3]) {
      const r = run(seed, { perSide: 12, maxSeconds: 24 }).runToEnd();
      const s = r.state;
      expect(s.counts.reduce((a, b) => a + b, 0)).toBe(36);
      expect(s.units.filter((u) => u.side === 0).length).toBe(s.counts[0]);
      const converts = r.events.filter((e) => e.type === 'convert');
      expect(converts.length).toBeGreaterThan(10);
      for (const e of converts) expect(preyOf(e.to as number)).toBe(e.from);
    }
  });

  it('ends with a wipe-out, or the biggest side at the buzzer', () => {
    for (const seed of [4, 5, 6, 7]) {
      const r = run(seed, { maxSeconds: 22 }).runToEnd();
      const end = r.events.find((e) => e.type === 'end')!;
      const s = r.state;
      expect(s.counts[s.winner]).toBe(Math.max(...s.counts));
      if (end.byExtinction) expect(s.counts.filter((c) => c > 0)).toHaveLength(1);
      else expect(end.t).toBeGreaterThanOrEqual(22 - 1e-6);
    }
  });

  it('starts every unit inside the arena', () => {
    for (const arena of ['circle', 'square']) {
      const s = run(9, { arena, perSide: 40 }).state;
      for (const u of s.units) expect(Math.hypot(u.body.x - 540, u.body.y - 1080)).toBeLessThan(460);
    }
  });
});
