import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { PATTERNS, patternRates, polygonSides } from './patterns';
import { FIGURES, buildEpicycles } from './epicycles';
import { POLYRHYTHM_STYLES, chordSteps, noteName, pitchDegrees, polyrhythm } from './index';

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
    const s = r.state;
    // Fourier ends on its finished drawing and holds the sync chord. Ripples shift the sync a moment
    // into the loop (it opens with every drop in the air) and stay seamless.
    expect(r.durationS).toBeCloseTo(12 + s.holdS, 1);
    expect(s.holdS).toBe(style === 'fourier' ? 2 : 0);
    if (style === 'ripples') expect(s.syncS).toBeGreaterThan(0.1);
    else expect(s.syncS).toBe(0);
    const hits = r.events.filter((e) => e.type === 'hit');
    // Every element plays exactly its whole number of notes, evenly spaced, starting together (at the
    // sync), plus the closing note at the end when the finish is held.
    s.notesPerLoop.forEach((m, i) => {
      const mine = hits.filter((e) => e.i === i);
      expect(Number.isInteger(m)).toBe(true);
      expect(mine).toHaveLength(s.holdS ? m + 1 : m);
      expect(mine[0].t).toBeCloseTo(s.syncS, 1);
      if (s.holdS) expect(mine[mine.length - 1].t).toBeCloseTo(12, 1);
      if (m > 1) expect(mine[1].t - mine[0].t).toBeCloseTo(12 / m, 1);
    });
  });

  it('scattered orrery: planets start apart and all ring together only at the end', () => {
    const r = run({ style: 'orrery', orreryStart: 'scattered', count: 8 });
    const s = r.state;
    expect(s.holdS).toBe(2);
    expect(r.durationS).toBeCloseTo(14, 1);
    const hits = r.events.filter((e) => e.type === 'hit');
    // Nothing rings at the start (no planet is on the beam), every planet rings exactly at the end.
    expect(hits.filter((e) => e.t === 0)).toHaveLength(0);
    s.cycles.forEach((c, i) => {
      const mine = hits.filter((e) => e.i === i);
      expect(mine).toHaveLength(c + 1);
      expect(mine[mine.length - 1].t).toBeCloseTo(12, 1);
      expect(mine[1].t - mine[0].t).toBeCloseTo(12 / s.beatRate[i], 1);
    });
    // Starting positions really are spread out: no two planets within 5% of a lap.
    const starts = s.beatOffset.map((o) => o % 1).sort((a, b) => a - b);
    for (let k = 1; k < starts.length; k++) expect(starts[k] - starts[k - 1]).toBeGreaterThan(0.05);
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
    // The ring has room for every drop the slider allows.
    expect(run({ style: 'ripples', count: 32 }).state.cycles).toHaveLength(32);
    // The count is shared between columns and rows, up to ten each.
    expect(run({ style: 'lissajous', count: 30 }).state.cycles).toHaveLength(20);
    expect(run({ style: 'lissajous', count: 12 }).state.cycles).toHaveLength(12);
    expect(run({ style: 'lissajous', count: 5 }).state.cycles).toHaveLength(6);
  });

  it.each(FIGURES)('fourier %s: circles turn whole numbers of times, so the drawing closes at the end', (figure) => {
    const e = buildEpicycles(figure, 32, (k) => Array.from({ length: k }, (_, i) => 10 + i));
    expect(e.arms.length).toBeGreaterThanOrEqual(3);
    expect(e.ticks).toHaveLength(e.arms.length);
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
    for (const a of e.arms) {
      expect(Number.isInteger(a.freq)).toBe(true);
      expect(a.freq).not.toBe(0);
    }
    expect(e.arms.map((a) => a.freq).reduce(gcd, 0)).toBe(1);
    // Biggest circle first.
    expect(e.arms.map((a) => a.amp)).toEqual([...e.arms.map((a) => a.amp)].sort((a, b) => b - a));
  });

  it('fits any number of elements into the pitch range, slowest lowest', () => {
    const ranks = (n: number) => Array.from({ length: n }, (_, i) => i);
    // Up to the range, one step each, as before.
    expect(pitchDegrees(ranks(18), 'pentatonic', 3.5, 'scale')).toEqual(ranks(18));
    expect(pitchDegrees(ranks(25), 'major', 3.5, 'scale')).toEqual(ranks(25));
    // Beyond it, spread across the range, never going down.
    const wide = pitchDegrees(ranks(32), 'pentatonic', 3.5, 'scale');
    expect(Math.max(...wide)).toBe(17);
    wide.forEach((d, i) => i && expect(d).toBeGreaterThanOrEqual(wide[i - 1]));
    expect(pitchDegrees(ranks(32), 'major', 2, 'scale').at(-1)).toBe(14);
    // Every note of a 32-dot video stays within the range above the root.
    const r = run({ style: 'ripples', count: 32, scale: 'pentatonic', rootNote: 55, pitchRange: 2.5 });
    const midis = r.events.filter((e) => e.type === 'hit').map((e) => e.midi as number);
    expect(Math.max(...midis)).toBeLessThanOrEqual(55 + 30);
  });

  it('can play chord tones only', () => {
    expect(chordSteps('major', false)).toEqual([0, 2, 4]);
    expect(chordSteps('minor', true)).toEqual([0, 2, 4, 6]);
    // Pentatonic has no 7th: its chord stays a triad (root, major 3rd, 5th).
    expect(chordSteps('pentatonic', true)).toEqual([0, 2, 3]);
    // C major chord tones, climbing: C E G C E G.
    const names = pitchDegrees([0, 1, 2, 3, 4, 5], 'major', 3, 'chord').map((d) => noteName('major', 60, d));
    expect(names).toEqual(['C4', 'E4', 'G4', 'C5', 'E5', 'G5']);
    const r = run({ style: 'arcs', count: 20, scale: 'dorian', rootNote: 50, notes: 'chord7' });
    // D dorian's chord tones: D F A C.
    const classes = new Set(r.events.filter((e) => e.type === 'hit').map((e) => ((e.midi as number) - 50 + 120) % 12));
    expect([...classes].sort((a, b) => a - b)).toEqual([0, 3, 7, 10]);
  });

  it('softens high notes by the setting, leaving low ones alone', () => {
    const hits = (soften: number) => run({ style: 'arcs', count: 24, scale: 'major', rootNote: 55, pitchRange: 4, soften }).events.filter((e) => e.type === 'hit' && e.k === 0);
    const hard = hits(0);
    const soft = hits(1);
    const low = (es: typeof hard) => es.find((e) => (e.midi as number) < 64)!;
    const high = (es: typeof hard) => es.reduce((a, e) => ((e.midi as number) > (a.midi as number) ? e : a));
    expect(low(soft).vel).toBe(low(hard).vel);
    expect(low(soft).bright).toBeUndefined();
    expect(high(soft).vel as number).toBeLessThan(high(hard).vel as number);
    expect(high(soft).bright as number).toBeLessThan(1);
    expect(high(hard).bright).toBeUndefined();
  });

  it('uses the chosen instrument, or the theme\'s by default', () => {
    const voices = (params: Record<string, unknown>) => new Set(run({ style: 'arcs', count: 6, ...params }).audio.map((a) => (a.kind === 'note' ? a.voice : null)));
    expect(voices({})).toEqual(new Set([getTheme('neon-dark').voice]));
    expect(voices({ voice: 'kalimba' })).toEqual(new Set(['kalimba']));
  });
});
