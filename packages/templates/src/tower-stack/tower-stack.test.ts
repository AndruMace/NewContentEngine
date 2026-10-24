import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { CELL, PIECES, distinctTurns, traceCells } from './pieces';
import { towerStack } from './index';

const run = (seed: number, params: Record<string, unknown> = {}) =>
  new Runner(towerStack, { seed, theme: getTheme('pastel-minimal'), melody: getMelody('ode-to-joy'), params, visual: false });

const area = (p: [number, number][]) => p.reduce((a, [x0, y0], i) => a + x0 * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * y0, 0) / 2;

describe('tower stack', () => {
  it('traces each cell piece as one counter-clockwise outline covering its cells', () => {
    const bridge = traceCells([[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [3, 2], [3, 1], [3, 0]]);
    expect(bridge.length).toBe(8);
    expect(area(bridge)).toBe(8);
    for (const def of Object.values(PIECES)) {
      expect(area(def.outline)).toBeGreaterThan(0);
      const parts = def.parts.reduce((a, p) => a + area(p.poly), 0);
      expect(parts).toBeCloseTo(def.area, 6);
    }
    expect(PIECES.block.area).toBeCloseTo(4 * CELL * CELL, 6);
    expect(distinctTurns(PIECES.block)).toEqual([0]);
    expect(distinctTurns(PIECES.slab)).toEqual([0, 1]);
    expect(distinctTurns(PIECES.step).length).toBe(2);
  });

  it('every live drop ends exactly as its test drop did', () => {
    for (const seed of [1, 2]) {
      const { events } = run(seed, { pieces: 10 }).runToEnd();
      let drops = 0;
      events.forEach((e, i) => {
        if (e.type !== 'drop') return;
        drops++;
        const next = events.slice(i + 1).find((x) => x.type === 'settle' || x.type === 'fall');
        expect(next?.type).toBe(e.expect === 'fell' ? 'fall' : 'settle');
      });
      expect(drops).toBeGreaterThanOrEqual(10);
    }
  });

  it('background music plays the melody on its own clock, and landings stop playing melody notes', () => {
    const bg = run(5, { pieces: 8, music: 'background' }).runToEnd();
    const notes = bg.events.filter((e) => e.type === 'mnote');
    // The tune keeps going from start to finish, whatever the pieces do.
    expect(notes[0].t).toBeLessThan(0.5);
    expect(notes[notes.length - 1].t).toBeGreaterThan(bg.durationS - 1);
    expect(bg.events.some((e) => e.type === 'mbass')).toBe(true);
    expect(bg.audio.filter((a) => a.kind === 'note' && a.voice !== 'bass').length).toBeGreaterThanOrEqual(notes.length);
    // The same game as with placement music: the music never touches the run.
    const plain = run(5, { pieces: 8 }).runToEnd();
    const game = (r: typeof bg) => r.events.filter((e) => e.type === 'settle' || e.type === 'fall').map((e) => `${e.type}${e.height}@${e.t}`);
    expect(game(bg)).toEqual(game(plain));
    expect(plain.events.some((e) => e.type === 'mnote')).toBe(false);
  });

  it('daily mode stacks every piece unless it runs out of falls, and counts the last steady height', () => {
    for (const seed of [3, 4]) {
      const r = run(seed, { pieces: 8, lives: 2 }).runToEnd();
      const end = r.events.find((e) => e.type === 'end')!;
      const falls = r.events.filter((e) => e.type === 'fall').length;
      expect(falls).toBeLessThanOrEqual(2);
      if (end.cleared) expect(end.placed).toBe(8);
      else expect(falls).toBe(2);
      const settles = r.events.filter((e) => e.type === 'settle');
      expect(end.height).toBe(settles[settles.length - 1].height);
      expect(end.height).toBeGreaterThan(20);
    }
  });
});
