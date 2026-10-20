/**
 * Deep Sea Observatory's cue schedule and the creatures' paths (no rendering). Paths are closed
 * curves with a whole number of laps per loop (so position at t + L equals position at t); one-off
 * visitors (a whale far off, an anglerfish, bubbles from the vent) are scheduled passes inside the loop.
 *
 * The station drifts sideways: the world slides past at v, covering exactly D (a whole number of
 * TRAVEL_STEP metres) per loop. Things outside are recycled through slots: each crosses a window W
 * wide (W divides D) and comes round again off-screen as a new pass, varied by the pass's number.
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
export const TRAVEL_STEP = 60;

/** How far the station drifts per loop (m) and how fast (m/s), from the speed asked for. */
export function travel(speed: number, L: number) {
  const D = Math.max(TRAVEL_STEP, Math.round((speed * L) / TRAVEL_STEP) * TRAVEL_STEP);
  return { D, v: D / L };
}

/** Where a slot is across its window (x, m) when the station has drifted s metres: right to left. */
export function slotX(phase: number, W: number, s: number) {
  return W / 2 - ((((phase * W + s) % W) + W) % W);
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

/** A closed path: centre plus whole-number Lissajous terms (laps per loop), metres. */
export interface Path {
  c: [number, number, number];
  a: [number, number, number];
  /** Laps per loop on each axis (integers). */
  n: [number, number, number];
  ph: [number, number, number];
}

export function pathAt(p: Path, t: number, L: number): [number, number, number] {
  const w = (2 * Math.PI * t) / L;
  return [0, 1, 2].map((i) => p.c[i] + p.a[i] * Math.sin(p.n[i] * w + p.ph[i])) as [number, number, number];
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

/** Slot windows (m) for jellyfish and fish schools. */
export const JELLY_W = 30;
export const SCHOOL_W = 60;

export interface Jelly {
  /** Where along its window it starts (0..1); its own drift on top. */
  slot: number;
  path: Path;
  size: number;
  /** Bell pulses per loop (whole). */
  pulses: number;
  hue: number;
}

export interface School {
  slot: number;
  path: Path;
  count: number;
  /** Fish size (m). */
  size: number;
  seed: number;
}

export type Cue = { t: number; clip: string; vel: number; pan: number; rate: number };

export interface SeaSchedule {
  /** Drift per loop (m) and speed (m/s). */
  D: number;
  v: number;
  jellies: Jelly[];
  schools: School[];
  whales: Pass[];
  anglers: Pass[];
  bubbles: Pass[];
  cues: Cue[];
}

export interface ScheduleOptions {
  depth: Depth;
  life: number;
  whalesPerHour: number;
  sonarPerHour: number;
  creaks: number;
  /** Drift speed asked for (m/s). */
  speed: number;
}

const EDGE = 20;

/** Laps per loop for a creature that should go round about once every `periodS` seconds. */
const laps = (periodS: number, L: number) => Math.max(1, Math.round(L / periodS));

export function seaSchedule(o: ScheduleOptions, L: number, rng: Rng): SeaSchedule {
  const life = o.life;
  const { D, v } = travel(o.speed, L);
  const jellies: Jelly[] = [];
  // About a third of a jelly window is in view, so three slots for each one seen at a time.
  const nJelly = 3 * (o.depth === 'reef' ? Math.round(1 + 2 * life) : Math.round(2 + 5 * life));
  for (let i = 0; i < nJelly; i++) {
    const z = -3.5 - rng.range(0, 13);
    jellies.push({
      slot: (i + rng.range(0, 0.6)) / nJelly,
      // Their own slow drift on top of the station's (small across, so they never jump at the wrap).
      path: {
        c: [0, rng.range(-0.5, 3.5), z],
        a: [rng.range(0.3, 1.2), rng.range(0.6, 1.6), rng.range(0.5, 2)],
        n: [laps(rng.range(240, 600), L), laps(rng.range(150, 400), L), laps(rng.range(300, 700), L)],
        ph: [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)],
      },
      size: rng.range(0.12, 0.32),
      pulses: laps(rng.range(2.4, 4.2), L),
      hue: rng.next(),
    });
  }
  const schools: School[] = [];
  if (o.depth !== 'abyss') {
    const nSchools = o.depth === 'reef' ? 1 + Math.round(2 * life) : Math.round(1 + life);
    for (let i = 0; i < nSchools; i++) {
      const z = -7 - rng.range(0, 12);
      schools.push({
        slot: (i + rng.range(0, 0.7)) / nSchools,
        path: {
          c: [0, rng.range(-1.5, 2.5), z],
          a: [rng.range(3, 6), rng.range(0.8, 2), rng.range(2, 4)],
          n: [laps(rng.range(90, 200), L), laps(rng.range(60, 140), L), laps(rng.range(120, 260), L)],
          ph: [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)],
        },
        count: Math.round((o.depth === 'reef' ? 40 : 28) + 40 * life),
        size: o.depth === 'reef' ? rng.range(0.1, 0.18) : rng.range(0.12, 0.22),
        seed: rng.int(1, 1_000_000),
      });
    }
  }

  const cues: Cue[] = [];
  const whales: Pass[] = [];
  const pickWhale = clipPicker(rng, [...SOUNDS.whale]);
  if (o.depth !== 'abyss') {
    for (const t of scheduleTimes(rng, L, o.whalesPerHour / 3600, 200)) {
      const dur = rng.range(60, 90);
      if (t < EDGE || t + dur > L - EDGE) continue;
      const dir = rng.chance(0.5) ? 1 : -1;
      // Close enough to show as a shadow in the fog, far enough to stay a shape, not a creature.
      const z = -rng.range(22, 34);
      const y = rng.range(-1, 6);
      whales.push({ t0: t, t1: t + dur, from: [-dir * 45, y, z], to: [dir * 45, y + rng.range(-2, 2), z - rng.range(0, 6)], seed: rng.int(1, 1_000_000) });
      // It sings as it passes: two or three phrases while it's in view.
      const phrases = rng.int(2, 3);
      for (let k = 0; k < phrases; k++) cues.push({ t: t + dur * (0.25 + (0.5 * k) / phrases), clip: pickWhale(), vel: 0.6, pan: dir * (k / phrases - 0.4), rate: rng.range(0.94, 1.02) });
    }
  }
  const anglers: Pass[] = [];
  if (o.depth === 'abyss') {
    for (const t of scheduleTimes(rng, L, (4 + 6 * life) / 3600, 150)) {
      const dur = rng.range(40, 70);
      if (t < EDGE || t + dur > L - EDGE) continue;
      const dir = rng.chance(0.5) ? 1 : -1;
      const z = -rng.range(3.5, 8);
      const y = rng.range(-0.5, 2.5);
      anglers.push({ t0: t, t1: t + dur, from: [-dir * 5, y, z], to: [dir * 5, y + rng.range(-0.6, 0.6), z + rng.range(-1, 1)], seed: rng.int(1, 1_000_000) });
    }
  }
  // Bubbles rising from the station's vent below the porthole, as long as their clip sounds.
  const bubbles: Pass[] = [];
  const pickBubbles = clipPicker(rng, [...SOUNDS.bubbles]);
  for (const t of scheduleTimes(rng, L, 10 / 3600, 120)) {
    const clip = pickBubbles();
    const dur = BUBBLE_S[SOUNDS.bubbles.indexOf(clip as (typeof SOUNDS.bubbles)[number])];
    if (t < EDGE || t + dur + 8 > L - EDGE) continue;
    const x = rng.range(-0.5, 0.5);
    bubbles.push({ t0: t, t1: t + dur + 8, from: [x, -1.0, -1.7], to: [x, 6, -1.9], seed: rng.int(1, 1_000_000) });
    cues.push({ t, clip, vel: 0.7, pan: x, rate: rng.range(0.92, 1.08) });
  }
  // The hull groaning now and then, and sonar.
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
  return { D, v, jellies, schools, whales, anglers, bubbles, cues };
}
