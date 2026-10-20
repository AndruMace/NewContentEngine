import { describe, expect, it } from 'vitest';
import { Runner, getTheme, hashString } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { advance, countCollisions, finished, makeBlocks } from './modes/blocks-physics';
import { mathCuriosities } from './index';
import { getTemplate } from '../index';

const run = (seed: number, params: Record<string, unknown>) =>
  new Runner(mathCuriosities, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), visual: false, params }).runToEnd();

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
    const r = run(3, { digits: 4 });
    expect(r.timedOut).toBe(false);
    expect(r.events.filter((e) => e.type === 'roundEnd').map((e) => e.count)).toEqual([3, 31, 314, 3141]);
    expect(r.events.some((e) => e.type === 'reveal')).toBe(true);
  });

  it('replays recipes from before the modes (no mode, old template id) exactly', () => {
    // Event and audio hashes of the original Colliding Blocks template for these runs.
    const before: [number, Record<string, unknown>, string, string][] = [
      [3, { digits: 4 }, '3133bc63', 'c0ccbd9f'],
      [11, {}, '25ea53bc', 'd8fad55a'],
      [5, { digits: 3, staged: false }, '302ba3a6', '9f96d106'],
    ];
    for (const [seed, params, events, audio] of before) {
      const r = new Runner(getTemplate('colliding-blocks'), { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), visual: false, params }).runToEnd();
      expect(hashString(JSON.stringify(r.events))).toBe(events);
      expect(hashString(JSON.stringify(r.audio))).toBe(audio);
    }
  });
});
