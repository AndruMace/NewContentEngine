import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { Z_NEAR, passAt, seaSchedule, slotPass, slotProgress, slotZ, type Depth } from './schedule';
import { jellySwim } from './fauna/jelly';

const L = 1800;
const opts = (depth: Depth) => ({ depth, life: 0.6, whalesPerHour: 6, sonarPerHour: 12, creaks: 0.5, speed: 0.78 });
const DEPTHS: Depth[] = ['twilight', 'abyss', 'reef'];

describe('deep sea submarine schedule', () => {
  it('travels a whole number of every slot window per loop, so every slot comes round exactly', () => {
    for (const depth of DEPTHS) {
      const s = seaSchedule(opts(depth), L, new Rng(2));
      expect(s.v * L).toBeCloseTo(s.D, 9);
      for (const pop of s.fauna) {
        expect(s.D % pop.W).toBe(0);
        for (const slot of pop.slots) {
          for (const t of [0, 77.7, 1500]) {
            expect(slotZ(slot.phase, pop.W, s.v * (t + L))).toBeCloseTo(slotZ(slot.phase, pop.W, s.v * t), 6);
            expect(slotPass(slot.phase, pop.W, s.v * (t + L), s.D)).toBe(slotPass(slot.phase, pop.W, s.v * t, s.D));
          }
        }
      }
    }
  });

  it('brings slots in from ahead and wraps them behind the cockpit', () => {
    const W = 60;
    expect(slotZ(0, W, 0)).toBeCloseTo(Z_NEAR - W, 9);
    // Moving forward: a slot only ever comes closer (z grows) until it wraps behind us.
    let last = slotZ(0.1, W, 0);
    for (let s = 0.5; s < W * 0.85; s += 0.5) {
      const z = slotZ(0.1, W, s);
      expect(z).toBeGreaterThan(last);
      last = z;
    }
    expect(slotProgress(0.1, W, W * 0.9)).toBeCloseTo(0, 6);
  });

  it('has a varied cast at every depth, with few jellyfish', () => {
    for (const depth of DEPTHS) {
      const s = seaSchedule({ ...opts(depth), life: 1 }, L, new Rng(4));
      expect(s.fauna.length).toBeGreaterThanOrEqual(5);
      const jellies = s.fauna.filter((p) => p.species === 'jelly').reduce((n, p) => n + p.slots.length, 0);
      const others = s.fauna.filter((p) => p.species !== 'jelly').reduce((n, p) => n + p.slots.length, 0);
      expect(jellies).toBeLessThan(others / 2);
    }
  });

  it('keeps passes and cues inside the loop', () => {
    for (const seed of [1, 2, 3, 4]) {
      for (const depth of DEPTHS) {
        const s = seaSchedule(opts(depth), L, new Rng(seed));
        for (const p of [...s.whales, ...s.bubbles]) {
          expect(p.t0).toBeGreaterThan(0);
          expect(p.t1).toBeLessThan(L);
          expect(passAt(p, p.t0 - 1)).toBeNull();
          expect(passAt(p, (p.t0 + p.t1) / 2)).not.toBeNull();
        }
        for (const c of s.cues) {
          expect(c.t).toBeGreaterThanOrEqual(0);
          expect(c.t).toBeLessThan(L);
        }
        if (depth === 'abyss') expect(s.whales).toHaveLength(0);
      }
    }
  });

  it('sings while a whale passes', () => {
    const s = seaSchedule(opts('twilight'), L, new Rng(5));
    for (const w of s.whales) expect(s.cues.some((c) => c.clip.includes('whale') && c.t > w.t0 && c.t < w.t1)).toBe(true);
  });
});

describe('jellyfish swimming', () => {
  it('pulses push it along its tilting axis, and it sinks a little between pulses', () => {
    const j = { seed: 7, pulseHz: 0.35 };
    // Over a pulse it rises (the push), between pulses it sinks: net upward over many pulses.
    const a = jellySwim(j, 0);
    const b = jellySwim(j, 30);
    expect(b.pos[1]).toBeGreaterThan(a.pos[1]);
    // Contraction is quick and relaxation slow: the bell is mostly relaxed.
    let contracted = 0;
    for (let t = 0; t < 30; t += 0.05) if (jellySwim(j, t).pulse > 0.5) contracted++;
    expect(contracted / (30 / 0.05)).toBeLessThan(0.35);
    // It keeps moving: no two seconds apart are the same place.
    const c = jellySwim(j, 12);
    const d = jellySwim(j, 14);
    expect(Math.hypot(c.pos[0] - d.pos[0], c.pos[1] - d.pos[1], c.pos[2] - d.pos[2])).toBeGreaterThan(0.05);
  });
});
