import { describe, expect, it } from 'vitest';
import { plantRules } from '.';
import { FRACTALS, PLANTS, PLANT_MODES } from './params';
import { PRESETS, rewrite, shapeOf } from './lsystem';
import { sayEvents } from '../story';
import { fakeVoice, runStory } from '../story/testing';

describe('L-systems', () => {
  it('rewrites and draws the textbook counts', () => {
    const tree = PRESETS.find((p) => p.id === 'tree')!;
    let s = tree.axiom;
    for (let k = 0; k < 3; k++) s = rewrite(s, tree.rules, null);
    expect(shapeOf(s, tree.draws).n).toBe(125);
    const koch = PRESETS.find((p) => p.id === 'koch')!;
    expect(shapeOf(rewrite(koch.axiom, koch.rules, null), koch.draws).n).toBe(12);
  });

  it('grows every line from one before it, root first', () => {
    const fern = PRESETS.find((p) => p.id === 'fern')!;
    let s = fern.axiom;
    for (let k = 0; k < 4; k++) s = rewrite(s, fern.rules, null);
    const sh = shapeOf(s, fern.draws);
    for (let i = 0; i < sh.n; i++) if (sh.parent[i] >= 0) expect(sh.birth[i]).toBe(sh.birth[sh.parent[i]] + 1);
  });
});

describe('plant rules', () => {
  it.each(PLANT_MODES)('%s: lands near its length and every beat has its facts', (mode) => {
    for (const seed of [1, 2, 3]) {
      const r = runStory(plantRules, { mode }, seed);
      expect(r.timedOut).toBe(false);
      expect(Math.abs(r.durationS - 40) / 40).toBeLessThan(0.25);
      const beats = sayEvents(r.events);
      expect(beats.length).toBeGreaterThanOrEqual(4);
      for (const b of beats) for (const k of b.required) expect(b.facts).toHaveProperty(k);
      expect(plantRules.outcome!(r.events)).toBeTruthy();
    }
  });

  it.each(PLANT_MODES)('%s: plays the same growth however long the lines run', (mode) => {
    const short = runStory(plantRules, { mode }, 4, fakeVoice(plantRules, { mode }, 4, 0.7));
    const long = runStory(plantRules, { mode }, 4, fakeVoice(plantRules, { mode }, 4, 1.8));
    expect(sayEvents(short.events)).toEqual(sayEvents(long.events));
    const sim = (r: typeof short) => r.events.filter((e) => e.type !== 'story:say').map((e) => ({ ...e, t: 0 }));
    expect(sim(short)).toEqual(sim(long));
  });

  it('runs every preset', () => {
    for (const preset of PLANTS) expect(runStory(plantRules, { mode: 'rewrite', preset }, 1).timedOut).toBe(false);
    for (const fractal of FRACTALS) expect(runStory(plantRules, { mode: 'fractals', fractal }, 1).timedOut).toBe(false);
  });
});
