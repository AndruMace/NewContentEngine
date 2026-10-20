/**
 * Deep Sea Submarine's schedule (no rendering): how far the submarine travels per loop, which animals
 * live at each depth and how often they come by, and the sounds (hull creaks, bubbles, whale song,
 * sonar).
 *
 * The submarine cruises forward (towards -z) at v, covering exactly D (a whole number of TRAVEL_STEP
 * metres) per loop. Everything outside is recycled through slots: a slot runs through a window W deep
 * (W divides D), from out in the fog ahead to just behind the cockpit, then comes round again off
 * screen as a new pass, varied by the pass's number (a different animal of the kind: size, place,
 * heading, colour). So the view at t = L is the view at t = 0.
 */
import type { Rng } from '@sim/engine';
import { scheduleTimes } from '../ambient/loop';
import { clipPicker } from '../ambient/pool';

export type Depth = 'twilight' | 'abyss' | 'reef';

export const SOUNDS = {
  creak: Array.from({ length: 9 }, (_, i) => `audio/hull-creak-${i + 1}.opus`),
  bubbles: Array.from({ length: 6 }, (_, i) => `audio/bubbles-${i + 1}.opus`),
  whale: Array.from({ length: 5 }, (_, i) => `audio/whale-${i + 1}.opus`),
  sonar: ['audio/sonar-1.opus', 'audio/sonar-2.opus'],
} as const;
/** Bubble clip lengths (s): the stream rises for as long as it sounds. */
const BUBBLE_S = [7, 6.5, 7, 4, 8, 6.2];

/** The travel per loop is a whole number of these (every slot window divides it). */
export const TRAVEL_STEP = 120;
/** A slot's window ends this far behind the cockpit (out of view), where it wraps. */
export const Z_NEAR = 8;

/** How far the submarine travels per loop (m) and how fast (m/s), from the speed asked for. */
export function travel(speed: number, L: number) {
  const D = Math.max(TRAVEL_STEP, Math.round((speed * L) / TRAVEL_STEP) * TRAVEL_STEP);
  return { D, v: D / L };
}

/** How far through its window a slot is (0 out in the fog ahead .. 1 just behind us). */
export function slotProgress(phase: number, W: number, s: number) {
  return ((((phase * W + s) % W) + W) % W) / W;
}

/** Where a slot is along the travel (z, m): from Z_NEAR - W (ahead) to Z_NEAR (behind). */
export function slotZ(phase: number, W: number, s: number) {
  return Z_NEAR - W + slotProgress(phase, W, s) * W;
}

/** Which pass a slot is on (repeats over the loop: D / W passes). */
export function slotPass(phase: number, W: number, s: number, D: number) {
  return ((Math.floor((phase * W + s) / W) % (D / W)) + D / W) % (D / W);
}

/** A repeatable 0..1 from integers (visual only: per-pass variety). */
export function hash2(a: number, b: number) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul((b | 0) + 0x9e37, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A one-off pass across the view: from `from` to `to` (m) between t0 and t1. */
export interface Pass {
  t0: number;
  t1: number;
  from: [number, number, number];
  to: [number, number, number];
  seed: number;
}

export function passAt(p: Pass, t: number): [number, number, number] | null {
  if (t < p.t0 || t > p.t1) return null;
  const u = (t - p.t0) / (p.t1 - p.t0);
  // Ease in and out a little (it glides in from the dark and away again).
  const e = u * u * (3 - 2 * u) * 0.3 + u * 0.7;
  return [0, 1, 2].map((i) => p.from[i] + (p.to[i] - p.from[i]) * e) as [number, number, number];
}

/** The animals, by kind (each has its own builder in fauna/). */
export type Species =
  | 'jelly'
  | 'lanternfish'
  | 'reefSchool'
  | 'comb'
  | 'squid'
  | 'siphonophore'
  | 'manta'
  | 'eagleRay'
  | 'shark'
  | 'reefShark'
  | 'turtle'
  | 'eel'
  | 'vampire'
  | 'angler';

/** A kind of animal and its slots: `phase` spreads them through the window, `seed` varies them. */
export interface Population {
  species: Species;
  W: number;
  slots: { phase: number; seed: number }[];
}

/** Who lives where, and how many slots each kind gets (scaled by the life setting, 0..1). */
const FAUNA: Record<Depth, (life: number) => [Species, number, number][]> = {
  // [species, window (m), slots]
  twilight: (l) => [
    ['jelly', 60, Math.round(1 + 1.5 * l)],
    ['lanternfish', 60, Math.round(2 + 2 * l)],
    ['comb', 40, Math.round(2 + 2 * l)],
    ['squid', 60, Math.round(2 + l)],
    ['siphonophore', 120, Math.round(1 + l)],
    ['manta', 120, 1],
    ['shark', 120, l > 0.3 ? 1 : 0],
  ],
  abyss: (l) => [
    ['jelly', 60, Math.round(1 + l)],
    ['angler', 60, Math.round(2 + l)],
    ['eel', 120, Math.round(1 + l)],
    ['vampire', 60, Math.round(1 + l)],
    ['siphonophore', 120, Math.round(1 + l)],
    ['comb', 40, Math.round(2 + 2 * l)],
    ['lanternfish', 60, Math.round(1 + l)],
  ],
  reef: (l) => [
    ['reefSchool', 60, Math.round(2 + 2 * l)],
    ['turtle', 120, Math.round(1 + l)],
    ['eagleRay', 120, 1],
    ['manta', 120, Math.round(l)],
    ['reefShark', 120, 1],
    ['jelly', 120, 1],
  ],
};

export type Cue = { t: number; clip: string; vel: number; pan: number; rate: number };

export interface SeaSchedule {
  /** Travel per loop (m) and speed (m/s). */
  D: number;
  v: number;
  fauna: Population[];
  whales: Pass[];
  bubbles: Pass[];
  cues: Cue[];
}

export interface ScheduleOptions {
  depth: Depth;
  life: number;
  whalesPerHour: number;
  sonarPerHour: number;
  creaks: number;
  /** Cruising speed asked for (m/s). */
  speed: number;
}

const EDGE = 20;

export function seaSchedule(o: ScheduleOptions, L: number, rng: Rng): SeaSchedule {
  const { D, v } = travel(o.speed, L);
  const fauna: Population[] = FAUNA[o.depth](o.life)
    .filter(([, , n]) => n > 0)
    .map(([species, W, n]) => ({
      species,
      W,
      slots: Array.from({ length: n }, (_, i) => ({ phase: (i + rng.range(0.1, 0.8)) / n, seed: rng.int(1, 1_000_000) })),
    }));

  const cues: Cue[] = [];
  const whales: Pass[] = [];
  const pickWhale = clipPicker(rng, [...SOUNDS.whale]);
  if (o.depth !== 'abyss') {
    for (const t of scheduleTimes(rng, L, o.whalesPerHour / 3600, 200)) {
      const dur = rng.range(70, 100);
      if (t < EDGE || t + dur > L - EDGE) continue;
      const dir = rng.chance(0.5) ? 1 : -1;
      // Far out to one side, crossing ahead of us in the fog.
      const z = -rng.range(28, 40);
      const y = rng.range(-1, 6);
      whales.push({ t0: t, t1: t + dur, from: [-dir * 50, y, z], to: [dir * 50, y + rng.range(-2, 2), z - rng.range(0, 6)], seed: rng.int(1, 1_000_000) });
      const phrases = rng.int(2, 3);
      for (let k = 0; k < phrases; k++) cues.push({ t: t + dur * (0.25 + (0.5 * k) / phrases), clip: pickWhale(), vel: 0.6, pan: dir * (k / phrases - 0.4), rate: rng.range(0.94, 1.02) });
    }
  }
  // Bubbles venting from the hull, streaming up past the dome's edge.
  const bubbles: Pass[] = [];
  const pickBubbles = clipPicker(rng, [...SOUNDS.bubbles]);
  for (const t of scheduleTimes(rng, L, 8 / 3600, 120)) {
    const clip = pickBubbles();
    const dur = BUBBLE_S[SOUNDS.bubbles.indexOf(clip as (typeof SOUNDS.bubbles)[number])];
    if (t < EDGE || t + dur + 8 > L - EDGE) continue;
    const x = rng.chance(0.5) ? rng.range(-1.6, -1.1) : rng.range(1.1, 1.6);
    bubbles.push({ t0: t, t1: t + dur + 8, from: [x, -1.1, -1.6], to: [x, 6, -1.6], seed: rng.int(1, 1_000_000) });
    cues.push({ t, clip, vel: 0.65, pan: x * 0.4, rate: rng.range(0.92, 1.08) });
  }
  if (o.creaks > 0) {
    const pickCreak = clipPicker(rng, [...SOUNDS.creak]);
    for (const t of scheduleTimes(rng, L, 24 / 3600, 40)) {
      if (t > L - 10) continue;
      cues.push({ t, clip: pickCreak(), vel: (0.35 + 0.65 * o.creaks) * rng.range(0.6, 1), pan: rng.range(-0.7, 0.7), rate: rng.range(0.85, 1.05) });
    }
  }
  if (o.sonarPerHour > 0) {
    const pickSonar = clipPicker(rng, [...SOUNDS.sonar]);
    for (const t of scheduleTimes(rng, L, o.sonarPerHour / 3600, 30)) if (t < L - 6) cues.push({ t, clip: pickSonar(), vel: 0.55, pan: rng.range(-0.3, 0.3), rate: 1 });
  }
  cues.sort((a, b) => a.t - b.t);
  return { D, v, fauna, whales, bubbles, cues };
}
