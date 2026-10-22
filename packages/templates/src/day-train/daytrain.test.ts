import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { distanceAt, ringPos, timetable } from '../night-train/track';
import { dayTrain } from './index';
import { BANDS } from './plants';
import { FAR_GAP, RING_STEP_DAY, farShapes, ringDelta, settlements, shapesLand, villageShapes } from './settlements';
import { FAR_RANGE, MAX_FAR, MAX_VIL } from './world';

const L = 1800;
const opts = { speed: 30, jointed: true, crossingsPerHour: 6, tunnelsPerHour: 2, bridgesPerHour: 3, horn: 0.4, ringStep: RING_STEP_DAY };

describe('day train', () => {
  it('covers its ring, a whole number of 4800 m steps, in exactly one loop', () => {
    for (const seed of [1, 2, 3]) {
      const { motion } = timetable(opts, L, new Rng(seed));
      expect(motion.D % RING_STEP_DAY).toBe(0);
      expect(distanceAt(motion, L)).toBeCloseTo(motion.D, 6);
      expect(Math.abs(motion.D / L - opts.speed)).toBeLessThan(3);
    }
  });

  it('has every repeating band of scenery divide the ring', () => {
    for (const b of BANDS) {
      expect(RING_STEP_DAY % b.W).toBe(0);
      expect(b.W % b.cell).toBe(0);
    }
    // Fields (120 m).
    expect(RING_STEP_DAY % 120).toBe(0);
  });

  it('places its settlements on the ring, passing the window inside the loop', () => {
    const tt = timetable(opts, L, new Rng(5));
    const towns = settlements(tt, L, { villages: 0.6, castles: 0.5 }, new Rng(6));
    const kinds = new Set(towns.map((w) => w.kind));
    for (const k of ['village', 'farm', 'town', 'castle', 'station'] as const) expect(kinds.has(k)).toBe(true);
    for (let i = 0; i < towns.length; i++) {
      const w = towns[i];
      expect(w.s).toBeGreaterThanOrEqual(0);
      expect(w.s).toBeLessThan(tt.motion.D);
      expect(w.t).toBeGreaterThanOrEqual(0);
      expect(w.t).toBeLessThan(L);
      if (i) expect(w.t).toBeGreaterThanOrEqual(towns[i - 1].t);
    }
  });

  it('keeps the land-shaping places apart, across the join too, so the land never drops one in view', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const tt = timetable(opts, L, new Rng(seed));
      const towns = settlements(tt, L, { villages: 1, castles: 1 }, new Rng(seed + 10));
      const far = towns.filter((w) => shapesLand(w.kind));
      for (const a of far) for (const b of far) if (a !== b) expect(Math.abs(ringDelta(a.s, b.s, tt.motion.D))).toBeGreaterThanOrEqual(FAR_GAP);
      // Anywhere along the ring, everything within reach fits the land's list.
      for (let s = 0; s < tt.motion.D; s += 250) {
        const within = far.filter((w) => Math.abs(ringDelta(s, w.s, tt.motion.D)) < FAR_RANGE).length;
        const bridges = tt.features.filter((f) => f.kind === 'bridge' && Math.abs(ringDelta(s, ringPos((f.s0 + f.s1) / 2, tt.motion.D), tt.motion.D)) < FAR_RANGE).length;
        expect(within + bridges).toBeLessThanOrEqual(MAX_FAR);
        expect(farShapes(towns, tt, s).length).toBe(within + bridges);
        expect(villageShapes(towns, s, tt.motion.D).length).toBeLessThanOrEqual(MAX_VIL);
      }
    }
  });

  it('keeps its cues inside the loop and makes valid copy', () => {
    const p = dayTrain.schema.parse({ weather: 'rain' });
    const s = dayTrain.init({ params: p, rng: new Rng(3), loopS: L } as never);
    for (const c of s.tt.cues) {
      expect(c.t).toBeGreaterThanOrEqual(0);
      expect(c.t).toBeLessThan(L);
    }
    for (const params of [{}, { weather: 'rain' }, { timeOfDay: 'golden' }]) {
      const copy = dayTrain.longForm!.fallbackCopy!(dayTrain.schema.parse(params), '3 Hours');
      expect(copy.title.length).toBeLessThanOrEqual(100);
      expect(copy.tags.length).toBeGreaterThanOrEqual(5);
      expect(copy.tags.length).toBeLessThanOrEqual(20);
      expect(dayTrain.longForm!.describe!(dayTrain.schema.parse(params)).length).toBeGreaterThan(100);
    }
  });
});
