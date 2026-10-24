import { describe, expect, it } from 'vitest';
import { chladniPlates } from '.';
import { CHLADNI_MODES } from './params';
import { figures, patternOf, GRID } from './modes';
import { circlePlate, plateHz, squarePlate } from './plate';
import { sayEvents } from '../story';
import { fakeVoice, runStory } from '../story/testing';

describe('plate physics', () => {
  it('matches published eigenvalues for a free square plate (Leissa, ν = 0.3)', () => {
    const got = squarePlate(0.3).modes.slice(0, 8).map((m) => m.lambda);
    // The Ritz method lands slightly high (an upper bound); within 1% of the tables.
    [13.468, 19.596, 24.27, 34.801, 34.801, 61.093, 61.093, 63.686].forEach((want, k) => {
      expect(got[k]).toBeGreaterThan(want * 0.999);
      expect(got[k]).toBeLessThan(want * 1.01);
    });
  });

  it('matches published eigenvalues for a free round plate (Leissa, ν = 0.33)', () => {
    const modes = circlePlate(0.33);
    const find = (n: number, s: number) => modes.find((m) => m.n === n && m.s === s)!.lambda;
    expect(find(2, 0)).toBeCloseTo(5.253, 1);
    expect(find(0, 1)).toBeCloseTo(9.084, 1);
    expect(find(3, 0)).toBeCloseTo(12.23, 1);
    expect(find(1, 1)).toBeCloseTo(20.52, 1);
    expect(find(0, 2)).toBeCloseTo(38.55, 0);
  });

  it('gives a real plate its real frequencies', () => {
    // 24 cm steel, 1 mm: f = λ / (2π a²) · √(D / ρh).
    const D = (200e9 * 1e-9) / (12 * (1 - 0.29 ** 2));
    expect(plateHz(13.47, 'steel', 0.24, 0.001)).toBeCloseTo((13.47 / (2 * Math.PI * 0.0576)) * Math.sqrt(D / (7850 * 0.001)), 6);
    expect(plateHz(13.47, 'steel', 0.24, 0.002) / plateHz(13.47, 'steel', 0.24, 0.001)).toBeCloseTo(2, 6);
  });

  it('lets the centre speaker play only figures that move at the centre; the bow plays the rest', () => {
    const N = GRID;
    const centre = (amp: Float32Array) => Math.abs(amp[(N / 2) * N + N / 2]);
    for (const plate of ['square', 'circle'] as const) {
      const auto = figures(plate, 'steel', 'auto');
      expect(auto.some((f) => f.exciter === 'speaker')).toBe(true);
      expect(auto.some((f) => f.exciter === 'bow')).toBe(true);
      for (const f of auto) {
        const amp = patternOf(f, 'steel').amp;
        if (f.exciter === 'speaker') expect(centre(amp)).toBeGreaterThan(0.15);
        else expect(centre(amp)).toBeLessThan(0.15);
      }
      expect(figures(plate, 'steel', 'speaker').every((f) => f.exciter === 'speaker')).toBe(true);
    }
    expect(figures('circle', 'steel', 'speaker').every((f) => f.circle!.n === 0)).toBe(true);
  });
});

describe('chladni plates', () => {
  it.each(CHLADNI_MODES)('%s: lands near its length and every beat has its facts', (mode) => {
    for (const seed of [1, 2]) {
      const r = runStory(chladniPlates, { mode }, seed);
      expect(r.timedOut).toBe(false);
      expect(Math.abs(r.durationS - 40) / 40).toBeLessThan(0.25);
      const beats = sayEvents(r.events);
      for (const b of beats) for (const k of b.required) expect(b.facts).toHaveProperty(k);
      expect(r.audio.some((a) => a.kind === 'tone')).toBe(true);
    }
  });

  it.each(CHLADNI_MODES)('%s: the same notes and facts however long the lines run', (mode) => {
    const short = runStory(chladniPlates, { mode }, 3, fakeVoice(chladniPlates, { mode }, 3, 0.7));
    const long = runStory(chladniPlates, { mode }, 3, fakeVoice(chladniPlates, { mode }, 3, 1.8));
    expect(sayEvents(short.events)).toEqual(sayEvents(long.events));
    const notes = (r: typeof short) => r.events.filter((e) => e.type === 'chladni:tone').map((e) => [Math.round(e.hz as number), Math.round(e.hzEnd as number)]);
    expect(notes(short)).toEqual(notes(long));
  });

  it.each([
    ['rising-pitch', 'first'],
    ['guess-the-pattern', 'play1'],
    ['plate-shapes', 'square'],
  ])('%s: silent through the intro; the tone starts with the line that starts the sand', (mode, beat) => {
    for (const narration of ['on', 'off']) {
      const r = runStory(chladniPlates, { mode, narration }, 1);
      const first = r.audio.find((a) => a.kind === 'tone');
      const line = r.events.find((e) => e.type === 'story:say' && e.beat === beat)!;
      expect(first?.t).toBe(line.t);
      expect(line.t).toBeGreaterThan(2);
    }
  });

  it('holds one tone per stretch, back to back, with no gaps while it sounds', () => {
    const r = runStory(chladniPlates, { mode: 'rising-pitch' }, 1);
    const tones = r.audio.filter((a) => a.kind === 'tone');
    for (let k = 1; k < tones.length; k++) {
      const a = tones[k - 1];
      const b = tones[k];
      if (a.kind !== 'tone' || b.kind !== 'tone') continue;
      if (Math.abs(a.hzEnd! - b.hz) < 0.01) expect(b.t).toBeLessThanOrEqual(a.t + a.dur + 1e-6);
    }
  });
});
