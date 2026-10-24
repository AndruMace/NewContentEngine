import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { slimeMold } from '.';
import { MOLD_MODES } from './params';
import { mazeWalls, spanningTree } from './sim';
import { sayEvents } from '../story';
import { fakeVoice, runStory } from '../story/testing';

const LIGHT = { agents: 20000 };

describe('slime mold pieces', () => {
  it('carves a maze with one path from the entrance to the exit', () => {
    const m = mazeWalls(new Rng(3), 6);
    expect(m.path.length).toBeGreaterThanOrEqual(6);
    for (const [x, y] of m.path) expect(m.wall[Math.floor(y) * 300 + Math.floor(x)]).toBe(0);
  });

  it('links every food source in its spanning tree', () => {
    expect(spanningTree([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 50, y: 50 }])).toHaveLength(3);
  });
});

describe('slime mold', () => {
  it.each(MOLD_MODES)('%s: lands near its length and every beat has its facts', (mode) => {
    const r = runStory(slimeMold, { mode, ...LIGHT }, 1);
    expect(r.timedOut).toBe(false);
    expect(Math.abs(r.durationS - 42) / 42).toBeLessThan(0.3);
    for (const b of sayEvents(r.events)) for (const k of b.required) expect(b.facts).toHaveProperty(k);
    expect(slimeMold.outcome!(r.events)).toBeTruthy();
  });

  it.each(['network', 'maze'])('%s: grows the same however long the lines run', (mode) => {
    const params = { mode, ...LIGHT };
    const short = runStory(slimeMold, params, 2, fakeVoice(slimeMold, params, 2, 0.7));
    const long = runStory(slimeMold, params, 2, fakeVoice(slimeMold, params, 2, 1.8));
    expect(sayEvents(short.events)).toEqual(sayEvents(long.events));
    const sim = (r: typeof short) => r.events.filter((e) => e.type !== 'story:say').map((e) => ({ ...e, t: 0 }));
    expect(sim(short)).toEqual(sim(long));
  });
});
