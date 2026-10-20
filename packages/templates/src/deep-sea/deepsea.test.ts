import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { passAt, pathAt, seaSchedule, type Depth } from './schedule';

const L = 1800;
const opts = (depth: Depth) => ({ depth, life: 0.6, whalesPerHour: 6, sonarPerHour: 12, creaks: 0.5 });

describe('deep sea schedule', () => {
  it('moves every creature on a path that closes over the loop', () => {
    for (const depth of ['twilight', 'abyss', 'reef'] as Depth[]) {
      const s = seaSchedule(opts(depth), L, new Rng(3));
      expect(s.jellies.length).toBeGreaterThan(0);
      for (const c of [...s.jellies, ...s.schools]) {
        for (const t of [0, 123.4, 1000]) {
          const a = pathAt(c.path, t, L);
          const b = pathAt(c.path, t + L, L);
          for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i], 9);
        }
        for (const n of c.path.n) expect(Number.isInteger(n)).toBe(true);
      }
    }
  });

  it('keeps passes and cues inside the loop', () => {
    for (const seed of [1, 2, 3, 4]) {
      for (const depth of ['twilight', 'abyss', 'reef'] as Depth[]) {
        const s = seaSchedule(opts(depth), L, new Rng(seed));
        for (const p of [...s.whales, ...s.anglers, ...s.bubbles]) {
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
        else expect(s.anglers).toHaveLength(0);
      }
    }
  });

  it('sings while a whale passes', () => {
    const s = seaSchedule(opts('twilight'), L, new Rng(5));
    for (const w of s.whales) expect(s.cues.some((c) => c.clip.includes('whale') && c.t > w.t0 && c.t < w.t1)).toBe(true);
  });
});
