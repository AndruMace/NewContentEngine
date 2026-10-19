import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { PATTERNS, patternRates, polygonSides } from './patterns';
import { FIGURES, buildEpicycles } from './epicycles';
import { POLYRHYTHM_STYLES, noteName, polyrhythm } from './index';

const run = (params: Record<string, unknown>, seed = 1) =>
  new Runner(polyrhythm, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params: { loopSeconds: 12, ...params }, visual: false }).runToEnd();

describe('polyrhythm', () => {
  it('spells key labels the way each scale is written', () => {
    const names = (scale: Parameters<typeof noteName>[0], root: number, n = 8) => Array.from({ length: n }, (_, i) => noteName(scale, root, i)).join(' ');
    expect(names('mixolydian', 60)).toBe('C4 D4 E4 F4 G4 A4 B♭4 C5');
    expect(names('mixolydian', 55)).toBe('G3 A3 B3 C4 D4 E4 F4 G4');
    expect(names('mixolydian', 58)).toBe('B♭3 C4 D4 E♭4 F4 G4 A♭4 B♭4');
    expect(names('major', 66, 7)).toBe('F♯4 G♯4 A♯4 B4 C♯5 D♯5 E♯5');
    expect(names('lydian', 64, 4)).toBe('E4 F♯4 G♯4 A♯4');
    expect(names('minor', 62, 7)).toBe('D4 E4 F4 G4 A4 B♭4 C5');
    expect(names('pentatonic', 61, 3)).toBe('C♯4 D♯4 F4');
  });

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
    expect(run({ style: 'orrery', count: 30 }).state.cycles).toHaveLength(8);
    expect(run({ style: 'ripples', count: 30 }).state.cycles).toHaveLength(24);
    // Six columns and six rows.
    expect(run({ style: 'lissajous', count: 30 }).state.cycles).toHaveLength(12);
  });

  it.each(FIGURES)('fourier %s: circles turn whole, distinct-enough rates and only all line up at the end', (figure) => {
    const e = buildEpicycles(figure, 32, 36, 6);
    expect(e.arms.length).toBeGreaterThanOrEqual(3);
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
    for (const a of e.arms) {
      expect(Number.isInteger(a.freq)).toBe(true);
      expect(a.freq).not.toBe(0);
    }
    expect(e.arms.map((a) => a.freq).reduce(gcd, 0)).toBe(1);
    // Biggest circle first.
    expect(e.arms.map((a) => a.amp)).toEqual([...e.arms.map((a) => a.amp)].sort((a, b) => b - a));
  });

  it('uses the chosen instrument, or the theme\'s by default', () => {
    const voices = (params: Record<string, unknown>) => new Set(run({ style: 'arcs', count: 6, ...params }).audio.map((a) => (a.kind === 'note' ? a.voice : null)));
    expect(voices({})).toEqual(new Set([getTheme('neon-dark').voice]));
    expect(voices({ voice: 'kalimba' })).toEqual(new Set(['kalimba']));
  });
});
