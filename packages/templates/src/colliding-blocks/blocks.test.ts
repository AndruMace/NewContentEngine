import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { advance, countCollisions, finished, makeBlocks } from './blocks';
import { collidingBlocks } from './index';

describe('colliding blocks', () => {
  it('counts the digits of π', () => {
    for (let d = 1; d <= 6; d++) expect(countCollisions(100 ** (d - 1))).toBe(Math.floor(Math.PI * 10 ** (d - 1)));
  });

  it('gives the same count however the time is chunked', () => {
    const b = makeBlocks(1e6, { x1: 250, w1: 70, x2: 480, v: 270 });
    for (let k = 0; k < 100000 && !finished(b); k++) advance(b, 1 / 240 / (1 + (k % 7)));
    expect(b.count).toBe(3141);
  });

  it('plays every round and ends with the reveal', () => {
    const r = new Runner(collidingBlocks, { seed: 3, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), visual: false, params: { digits: 4 } }).runToEnd();
    expect(r.timedOut).toBe(false);
    expect(r.events.filter((e) => e.type === 'roundEnd').map((e) => e.count)).toEqual([3, 31, 314, 3141]);
    expect(r.events.some((e) => e.type === 'reveal')).toBe(true);
  });
});
