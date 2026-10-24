import { describe, expect, it } from 'vitest';
import { geneticDrift } from '.';
import { DRIFT_MODES } from './params';
import { sayEvents } from '../story';
import { fakeVoice, runStory } from '../story/testing';

describe('genetic drift', () => {
  it.each(DRIFT_MODES)('%s: lands near its length, narrates every beat, ends with a result', (mode) => {
    for (const seed of [1, 2, 3]) {
      const r = runStory(geneticDrift, { mode }, seed);
      expect(r.timedOut).toBe(false);
      expect(Math.abs(r.durationS - 45) / 45).toBeLessThan(0.25);
      const beats = sayEvents(r.events);
      expect(beats.length).toBeGreaterThanOrEqual(5);
      for (const b of beats) for (const k of b.required) expect(b.facts).toHaveProperty(k);
      expect(geneticDrift.outcome!(r.events)).toBeTruthy();
    }
  });

  it.each(DRIFT_MODES)('%s: plays the same generations however long the lines run', (mode) => {
    const short = runStory(geneticDrift, { mode }, 4, fakeVoice(geneticDrift, { mode }, 4, 0.7));
    const long = runStory(geneticDrift, { mode }, 4, fakeVoice(geneticDrift, { mode }, 4, 1.8));
    expect(sayEvents(short.events)).toEqual(sayEvents(long.events));
    const gens = (r: typeof short) => r.events.filter((e) => e.type !== 'story:say').map((e) => ({ ...e, t: 0 }));
    expect(gens(short)).toEqual(gens(long));
    expect(long.durationS).toBeGreaterThan(short.durationS);
  });

  it('covers a spread of population sizes and colours', () => {
    for (const [popSize, colours] of [[10, 2], [48, 6], [300, 3], [600, 6]])
      expect(runStory(geneticDrift, { mode: 'race', popSize, colours }, 5).timedOut).toBe(false);
  });
});
