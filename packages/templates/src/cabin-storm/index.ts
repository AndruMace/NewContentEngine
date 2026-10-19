import { z } from 'zod';
import type { AudioEventInput, DramaScore, Template } from '@sim/engine';
import { Rng } from '@sim/engine';
import { log } from '@sim/physics/math';
import { drawCabin } from './view3d';

/**
 * Long-form ambient: inside a log cabin, a crackling fire, a thunderstorm through big windows.
 *
 * There is no simulation as such: init() lays out a seeded schedule of cues for the whole master
 * loop (lightning, thunder, the rain/wind bed, fire crackles), step() emits them on time, and every
 * frame is drawn from t and that schedule alone. All cue times live in [0, loopS): a thunderclap
 * that would land after the end wraps to the start, so the loop repeats seamlessly.
 */
export const cabinStormSchema = z.object({
  storm: z.number().min(0).max(1).default(0.6).meta({ title: 'Storm intensity' }),
  lightningPerHour: z.number().min(0).max(120).default(30).meta({ title: 'Lightning strikes per hour' }),
  fire: z.number().min(0).max(1).default(0.7).meta({ title: 'Fire size' }),
});

export type CabinStormParams = z.infer<typeof cabinStormSchema>;

export interface Strike {
  t: number;
  /** 0..1, how bright the flash is (brightness is capped in the view). */
  strength: number;
  /** Seconds between the flash and its thunder (≈ 3 s per km). */
  delay: number;
  /** Where along the windows the bolt is, 0..1. */
  x: number;
  /** Start times of the flash's pulses, relative to t (at most 2, so never more than 2 flashes a second). */
  pulses: number[];
}

type Cue =
  | { t: number; type: 'lightning'; strike: number }
  | { t: number; type: 'thunder'; strike: number; vel: number; near: boolean }
  | { t: number; type: 'bed'; vel: number }
  | { t: number; type: 'crackle'; vel: number; pitch: number; pan: number; pop: boolean };

export interface CabinState {
  p: CabinStormParams;
  loopS: number;
  strikes: Strike[];
  cues: Cue[];
  next: number;
}

/** Minimum time between strikes, so flashes never come in bursts. */
const MIN_STRIKE_GAP_S = 12;
/** Rain and wind bed: one overlapping stretch every 4 s (the synth's 'ambience' layer). */
const BED_EVERY_S = 4;

const mod = (t: number, L: number) => ((t % L) + L) % L;

function schedule(p: CabinStormParams, L: number, rng: Rng): Pick<CabinState, 'strikes' | 'cues'> {
  const strikes: Strike[] = [];
  const rate = p.lightningPerHour / 3600;
  if (rate > 0) {
    // Poisson arrivals with a floor on the gap, over [0, L - gap) so the wrap gap is respected too.
    for (let t = rng.range(0, 1 / rate); t < L - MIN_STRIKE_GAP_S; t += MIN_STRIKE_GAP_S + -log(1 - rng.next()) / rate) {
      const distanceKm = rng.range(0.6, 7);
      const strength = Math.min(1, (0.35 + rng.next() * 0.65) * (1.2 - distanceKm / 10));
      strikes.push({ t, strength, delay: distanceKm * 2.9, x: rng.next(), pulses: rng.chance(0.45) ? [0, rng.range(0.18, 0.35)] : [0] });
    }
  }
  const cues: Cue[] = [];
  strikes.forEach((s, i) => {
    cues.push({ t: s.t, type: 'lightning', strike: i });
    cues.push({ t: mod(s.t + s.delay, L), type: 'thunder', strike: i, vel: 0.25 + 0.65 * s.strength, near: s.delay < 6 });
  });
  for (let t = 0; t < L; t += BED_EVERY_S) cues.push({ t, type: 'bed', vel: 0.35 + 0.45 * p.storm });
  // Fire crackles: a few a second, with occasional louder pops.
  const crackleRate = 1.5 + 3 * p.fire;
  for (let t = rng.range(0, 1 / crackleRate); t < L; t += -log(1 - rng.next()) / crackleRate) {
    const pop = rng.chance(0.06);
    cues.push({ t, type: 'crackle', vel: (pop ? 0.5 : 0.12 + rng.next() * 0.2) * (0.6 + 0.4 * p.fire), pitch: rng.next(), pan: rng.range(-0.25, 0.25), pop });
  }
  cues.sort((a, b) => a.t - b.t);
  return { strikes, cues };
}

export const cabinStorm: Template<CabinStormParams, CabinState> = {
  id: 'cabin-storm',
  name: 'Cabin Storm',
  family: 'kinetic',
  description: 'Long-form ambient: a log cabin with a crackling fireplace and a thunderstorm outside the windows.',
  schema: cabinStormSchema,
  format: { width: 1920, height: 1080, fps: 30 },
  longForm: {
    minLoopS: 20 * 60,
    maxLoopS: 60 * 60,
    defaultLoopS: 30 * 60,
    thumbnailAt: (s: CabinState) => {
      const best = s.strikes.reduce<Strike | null>((a, b) => (!a || b.strength > a.strength ? b : a), null);
      return best ? best.t + 0.04 : s.loopS / 2;
    },
  },
  substeps: 1,
  searchBudget: 1,
  ownMusic: true,
  glowScale: 0,
  defaultCopy: { hook: '', cta: '' },

  init({ params, rng, loopS }) {
    const L = loopS || 30 * 60;
    return { p: params, loopS: L, ...schedule(params, L, rng), next: 0 };
  },

  step(s, { t, dt, emit }) {
    while (s.next < s.cues.length && s.cues[s.next].t < t + dt) {
      const c = s.cues[s.next++];
      if (c.type === 'lightning') emit({ type: 'lightning', strike: c.strike, strength: s.strikes[c.strike].strength });
      else if (c.type === 'thunder') emit({ type: 'thunder', strike: c.strike, vel: c.vel, near: c.near });
      else if (c.type === 'bed') emit({ type: 'bed', vel: c.vel });
      else emit({ type: 'crackle', vel: c.vel, pitch: c.pitch, pan: c.pan, pop: c.pop });
    }
  },

  // The Runner ends long-form runs at loopS.
  isDone: () => false,
  hud: () => ({}),
  overlays: () => [],

  render(rc, s) {
    drawCabin(rc, s);
  },

  audio(e): AudioEventInput[] {
    switch (e.type) {
      case 'thunder':
        return [{ kind: 'sfx', name: 'boom', vel: e.vel as number, pitch: e.near ? 0.7 : 0.2 }];
      case 'bed':
        return [{ kind: 'sfx', name: 'ambience', vel: e.vel as number, pitch: 1 }];
      case 'crackle':
        return [{ kind: 'sfx', name: e.pop ? 'pop' : 'tick', vel: e.vel as number, pitch: e.pitch as number, pan: e.pan as number }];
      default:
        return [];
    }
  },

  score(events, info): DramaScore {
    // Nothing to win: a loop is good when lightning is spread out (no long dead stretches).
    const strikes = events.filter((e) => e.type === 'lightning').map((e) => e.t);
    let longestGap = 0;
    for (let i = 1; i < strikes.length; i++) longestGap = Math.max(longestGap, strikes[i] - strikes[i - 1]);
    const spread = strikes.length > 1 ? Math.max(0, 1 - longestGap / Math.max(60, info.durationS / 4)) : 0.5;
    return { total: 0.5 + 0.5 * spread, parts: { spread } };
  },
};
