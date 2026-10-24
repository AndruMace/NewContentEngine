import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { murmuration } from '.';
import { FLOCK_MODES } from './params';
import { addPredator, centroid, newFlock, order, stepFlock } from './sim';
import { sayEvents } from '../story';
import { fakeVoice, runStory } from '../story/testing';

const LIGHT = { count: 400 };

describe('boids', () => {
  it('flocks with all three rules and stays scattered with none', () => {
    const o = { n: 400, separation: 1.2, alignment: 1, cohesion: 1, radius: 9, neighbours: 7, speed: 14, agility: 55 };
    const loose = newFlock(new Rng(1), o, true);
    const tight = newFlock(new Rng(1), o, true);
    tight.rules = { separation: true, alignment: true, cohesion: true };
    for (let k = 0; k < 600; k++) {
      stepFlock(loose);
      stepFlock(tight);
    }
    expect(order(tight)).toBeGreaterThan(0.6);
    expect(order(loose)).toBeLessThan(0.3);
  });
});

describe('predator', () => {
  it('circles above, stoops fast at the flock, climbs back out and comes round again', () => {
    const o = { n: 500, separation: 1.2, alignment: 1, cohesion: 1, radius: 9, neighbours: 7, speed: 14, agility: 55 };
    const f = newFlock(new Rng(3), o, false);
    f.rules = { separation: true, alignment: true, cohesion: true };
    for (let k = 0; k < 300; k++) stepFlock(f);
    addPredator(f);
    const p = f.predators[0];
    const modes: string[] = [];
    let stoopSpeed = 0;
    let closest = Infinity;
    let panic = 0;
    for (let k = 0; k < 1200; k++) {
      stepFlock(f);
      if (modes[modes.length - 1] !== p.mode) modes.push(p.mode);
      if (p.mode === 'circle') expect(p.y).toBeLessThan(centroid(f).y);
      if (p.mode === 'stoop') {
        stoopSpeed = Math.max(stoopSpeed, Math.hypot(p.vx, p.vy, p.vz));
        for (let i = 0; i < o.n; i++) closest = Math.min(closest, Math.hypot(f.x[i] - p.x, f.y[i] - p.y, f.z[i] - p.z));
        panic = Math.max(panic, f.fear.filter((x) => x > 0.3).length / o.n);
      }
    }
    expect(modes.slice(0, 4)).toEqual(['circle', 'stoop', 'climb', 'circle']);
    expect(stoopSpeed).toBeGreaterThan(o.speed * 2.5);
    expect(closest).toBeLessThan(6);
    // The panic spreads well beyond the birds that can see it.
    expect(panic).toBeGreaterThan(0.4);
  });

  it('flies as one compact flock, not strung out or split', () => {
    for (const seed of [3, 5]) {
      const o = { n: 500, separation: 1.2, alignment: 1, cohesion: 1, radius: 9, neighbours: 7, speed: 14, agility: 55 };
      const f = newFlock(new Rng(seed), o, false);
      f.rules = { separation: true, alignment: true, cohesion: true };
      for (let k = 0; k < 900; k++) stepFlock(f);
      // On-screen stretch: the ratio of the flock's long axis to its short one.
      const c = centroid(f);
      let a = 0, b = 0, d = 0;
      for (let i = 0; i < o.n; i++) {
        const dx = f.x[i] - c.x, dy = f.y[i] - c.y;
        a += dx * dx; b += dx * dy; d += dy * dy;
      }
      const mid = (a + d) / 2, half = Math.sqrt(((a - d) / 2) ** 2 + b * b);
      expect(Math.sqrt((mid + half) / (mid - half))).toBeLessThan(2.2);
    }
  });
});

describe('murmuration', () => {
  it.each(FLOCK_MODES)('%s: lands near its length and every beat has its facts', (mode) => {
    const r = runStory(murmuration, { mode, ...LIGHT }, 1);
    expect(r.timedOut).toBe(false);
    expect(Math.abs(r.durationS - 42) / 42).toBeLessThan(0.25);
    for (const b of sayEvents(r.events)) for (const k of b.required) expect(b.facts).toHaveProperty(k);
    expect(murmuration.outcome!(r.events)).toBeTruthy();
  });

  it.each(FLOCK_MODES)('%s: flies the same flock however long the lines run', (mode) => {
    const params = { mode, ...LIGHT };
    const short = runStory(murmuration, params, 2, fakeVoice(murmuration, params, 2, 0.7));
    const long = runStory(murmuration, params, 2, fakeVoice(murmuration, params, 2, 1.8));
    expect(sayEvents(short.events)).toEqual(sayEvents(long.events));
    const sim = (r: typeof short) => r.events.filter((e) => e.type !== 'story:say').map((e) => ({ ...e, t: 0 }));
    expect(sim(short)).toEqual(sim(long));
  });
});
