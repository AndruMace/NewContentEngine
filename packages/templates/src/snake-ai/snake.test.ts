import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { playSnake } from './game';
import { snakeAi } from './index';

describe('snake AI', () => {
  it('only makes legal moves and never overlaps itself', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const g = playSnake(10, new Rng(seed));
      for (let k = g.startLength; k <= g.last; k++) {
        const a = g.heads[k - 1];
        const b = g.heads[k];
        expect(Math.abs((a % 10) - (b % 10)) + Math.abs(Math.floor(a / 10) - Math.floor(b / 10))).toBe(1);
        const body = new Set<number>();
        for (let j = 0; j < g.lens[k]; j++) body.add(g.heads[k - j]);
        expect(body.size).toBe(g.lens[k]);
      }
      if (g.result === 'filled') expect(g.lens[g.last]).toBe(100);
    }
  });

  it('starts the video at the starting length and plays to the end', () => {
    const r = new Runner(snakeAi, { seed: 4, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params: { grid: 12, startFill: 0.3 }, visual: false });
    expect(r.state.g.lens[r.state.k]).toBeGreaterThanOrEqual(Math.round(0.3 * 144));
    r.runToEnd();
    expect(r.timedOut).toBe(false);
    expect(r.state.k).toBe(r.state.g.last);
  });

  it('sometimes fills the board and sometimes gets trapped', () => {
    const results = Array.from({ length: 30 }, (_, i) => playSnake(10, new Rng(i + 1)).result);
    expect(results).toContain('filled');
    expect(results).toContain('trapped');
  });

  it('lets the wanted ending steer the seed search', () => {
    const score = (type: 'filled' | 'trapped', ending: string) =>
      snakeAi.score([{ t: 20, type, fill: type === 'filled' ? 1 : 0.97, ending }], { durationS: 30, targetS: 30, timedOut: false }).total;
    expect(score('filled', 'filled')).toBeGreaterThan(score('trapped', 'filled'));
    expect(score('trapped', 'trapped')).toBeGreaterThan(score('filled', 'trapped'));
  });
});
