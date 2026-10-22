/**
 * Night Train's motion and timetable (no rendering): how far along the track the train is at any
 * moment, where the rail joints are, and what passes the window when.
 *
 * The track is a ring D metres round, a whole number of 25 m rails, and the train covers exactly D in
 * one loop, so at t = loopS everything outside is back where it was at t = 0 and the wheel clicks keep
 * their rhythm across the join. The train never stops; it slows a little through stations (smooth
 * raised-cosine dips in speed, whose distance has a closed form, so s(t) is exact at any t).
 */
import type { Rng } from '@sim/engine';
import { sin } from '@sim/physics/math';
import { scheduleTimes } from '../ambient/loop';
import { clipPicker } from '../ambient/pool';

/** Rail length (m): joints, and so wheel clicks, every RAIL metres. */
export const RAIL = 25;
/**
 * The ring is a whole number of this many metres (8 rails), so every repeating pattern outside (fence
 * posts 2.5 m, poles 50 m, houses on a 200 m grid) also closes on itself.
 */
export const RING_STEP = 200;
/** Axles on our carriage, metres ahead (+) or behind (-) of the compartment: two bogies, two axles each. */
export const AXLES = [-10.25, -7.75, 7.75, 10.25] as const;
/** Each bogie's two axles cross a joint 2.5 m apart: one "ta-tak" clip per bogie per joint. */
export const BOGIES = [-9, 9] as const;

/** A slowdown: speed falls by `depth` (0..1) at `t`, easing in and out over ±`halfS`. */
export interface Dip {
  t: number;
  depth: number;
  halfS: number;
}

export interface Motion {
  /** Ring length (m). */
  D: number;
  /** Cruising speed (m/s). */
  v: number;
  dips: Dip[];
}

/** ∫ of the dip shape 0.5(1 + cos πu) from -1 to u, for u in [-1, 1] (0 before, 1 after). */
function dipArea(u: number) {
  if (u <= -1) return 0;
  if (u >= 1) return 1;
  return 0.5 * (u + 1) + sin(Math.PI * u) / (2 * Math.PI);
}

/**
 * The train's speed and its ring: `speed` (m/s) is the speed asked for; the cruising speed is adjusted
 * slightly so that the loop covers a whole number of `step`s (RING_STEP unless the scenery needs more).
 */
export function makeMotion(speed: number, L: number, dips: Dip[], step = RING_STEP): Motion {
  // Distance lost to the dips, per m/s of cruising speed: each dip removes depth · halfS · v.
  const lost = dips.reduce((a, d) => a + d.depth * d.halfS, 0);
  const D = Math.max(step, Math.round((speed * (L - lost)) / step) * step);
  return { D, v: D / (L - lost), dips };
}

/** Distance travelled at time t (m), from 0 at t = 0 to D at t = L. */
export function distanceAt(m: Motion, t: number): number {
  let lost = 0;
  for (const d of m.dips) lost += d.depth * d.halfS * dipArea((t - d.t) / d.halfS);
  return m.v * (t - lost);
}

/** Speed at time t (m/s). */
export function speedAt(m: Motion, t: number): number {
  let f = 1;
  for (const d of m.dips) {
    const u = (t - d.t) / d.halfS;
    if (u > -1 && u < 1) f -= d.depth * 0.5 * (1 + Math.cos(Math.PI * u));
  }
  return m.v * f;
}

/** When the train has travelled `s` metres (0 ≤ s ≤ D): bisection, so Node and browsers agree exactly. */
export function timeAt(m: Motion, s: number, L: number): number {
  let lo = 0;
  let hi = L;
  for (let i = 0; i < 48; i++) {
    const mid = 0.5 * (lo + hi);
    if (distanceAt(m, mid) < s) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Ring position in [0, D). */
export const ringPos = (s: number, D: number) => ((s % D) + D) % D;

export type FeatureKind = 'station' | 'crossing' | 'bridge' | 'tunnel';

/** Something that passes the window: along the ring from `s0` to `s1` (s1 > s0; may run past D). */
export interface Feature {
  kind: FeatureKind;
  /** Time the window is level with its start and its end. */
  t0: number;
  t1: number;
  s0: number;
  s1: number;
  /** Visual variety. */
  seed: number;
}

export type Cue =
  | { t: number; type: 'click'; clip: string; vel: number; pan: number; rate: number }
  | { t: number; type: 'sample'; clip: string; vel: number; pan: number; rate: number };

export interface Timetable {
  motion: Motion;
  features: Feature[];
  /** Click times (for the camera's little bumps), sorted. */
  clicks: number[];
  cues: Cue[];
}

export interface TimetableOptions {
  /** Cruising speed asked for (m/s). */
  speed: number;
  jointed: boolean;
  crossingsPerHour: number;
  tunnelsPerHour: number;
  bridgesPerHour: number;
  /** 0..1 horn volume (0: no horn). */
  horn: number;
  /** Which way the train runs across the view (+1 right, -1 left): sides of the clicks and horn. */
  dir?: number;
  /** The ring is a whole number of these (m; default RING_STEP, a multiple of RAIL). */
  ringStep?: number;
}

export const SOUNDS = {
  click: Array.from({ length: 12 }, (_, i) => `audio/rail-click-${i + 1}.opus`),
  bell: ['audio/crossing-bell-1.opus', 'audio/crossing-bell-2.opus'],
  horn: ['audio/train-horn-1.opus', 'audio/train-horn-2.opus', 'audio/train-horn-3.opus'],
  /** Tunnel roars, 30, 45 and 60 s long (the tunnel lasts as long as its roar). */
  tunnel: ['audio/train-tunnel-1.opus', 'audio/train-tunnel-2.opus', 'audio/train-tunnel-3.opus'],
  bridge: ['audio/train-bridge-1.opus', 'audio/train-bridge-2.opus'],
} as const;
export const TUNNEL_S = [30, 45, 60];
/** In a tunnel clip, when the window enters the tunnel and leaves it (after its fade-in, before its fade-out). */
const TUNNEL_IN_S = 0.7;
const TUNNEL_OUT_S = 2.2;
const BRIDGE_S = 12;
const BRIDGE_IN_S = 0.8;
const BRIDGE_OUT_S = 2.0;
/** In the bell clip, the moment it is level with the window (its loudest). */
const BELL_PEAK_S = 7;
/** Our carriage is this far behind the locomotive (m): the horn sounds before the crossing reaches us. */
const LOCO_AHEAD_M = 180;
/** Stations per hour the train slows through. */
const STATIONS_PER_HOUR = 6;
const STATION_LENGTH_M = 300;

/**
 * The loop's timetable: stations (with their slowdowns), then crossings, bridges and tunnels in the
 * gaps, then every wheel click. All times in [0, L), nothing straddling the loop's join.
 */
export function timetable(o: TimetableOptions, L: number, rng: Rng): Timetable {
  const EDGE = 40;
  const dir = o.dir ?? 1;
  const taken: [number, number][] = [];
  const free = (a: number, b: number, gap: number) => a > EDGE && b < L - EDGE && taken.every(([x, y]) => b + gap < x || a - gap > y);

  // Stations, evenly spread with some jitter; the train slows to 55–75% through each.
  const nStations = Math.max(1, Math.round((STATIONS_PER_HOUR * L) / 3600));
  const dips: Dip[] = [];
  for (let i = 0; i < nStations; i++) {
    const t = ((i + 0.5 + rng.range(-0.25, 0.25)) / nStations) * L;
    const halfS = rng.range(35, 55);
    if (t - halfS < EDGE || t + halfS > L - EDGE) continue;
    dips.push({ t, depth: rng.range(0.25, 0.45), halfS });
  }
  const motion = makeMotion(o.speed, L, dips, o.ringStep);
  const features: Feature[] = [];
  const at = (t0: number, s0: number, s1: number, kind: FeatureKind) => {
    const t1 = timeAt(motion, s1, L);
    features.push({ kind, t0, t1, s0, s1, seed: rng.int(1, 1_000_000) });
    taken.push([t0, t1]);
  };
  for (const d of dips) {
    const sc = distanceAt(motion, d.t);
    const s0 = sc - STATION_LENGTH_M / 2;
    at(timeAt(motion, s0, L), s0, sc + STATION_LENGTH_M / 2, 'station');
    // Keep the slow stretch clear of anything else.
    taken.push([d.t - d.halfS, d.t + d.halfS]);
  }

  const cues: Cue[] = [];
  const pick = {
    bell: clipPicker(rng, [...SOUNDS.bell]),
    horn: clipPicker(rng, [...SOUNDS.horn]),
    bridge: clipPicker(rng, [...SOUNDS.bridge]),
  };
  const horn = (t: number) => {
    if (o.horn > 0 && t > 0 && t < L - 25) cues.push({ t, type: 'sample', clip: pick.horn(), vel: 0.5 + 0.5 * o.horn, pan: 0.35 * dir, rate: rng.range(0.97, 1.03) });
  };

  // Tunnels: the roar clip sets the length.
  for (const t of scheduleTimes(rng, L, o.tunnelsPerHour / 3600, 120)) {
    const k = rng.int(0, 2);
    const start = t + TUNNEL_IN_S;
    const end = t + TUNNEL_S[k] - TUNNEL_OUT_S;
    if (!free(t, t + TUNNEL_S[k], 30)) continue;
    at(start, distanceAt(motion, start), distanceAt(motion, end), 'tunnel');
    cues.push({ t, type: 'sample', clip: SOUNDS.tunnel[k], vel: 0.9, pan: 0, rate: 1 });
    if (rng.chance(0.6)) horn(t - 8);
  }
  for (const t of scheduleTimes(rng, L, o.bridgesPerHour / 3600, 90)) {
    const start = t + BRIDGE_IN_S;
    const end = t + BRIDGE_S - BRIDGE_OUT_S;
    if (!free(t, t + BRIDGE_S, 20)) continue;
    at(start, distanceAt(motion, start), distanceAt(motion, end), 'bridge');
    cues.push({ t, type: 'sample', clip: pick.bridge(), vel: 0.85, pan: 0, rate: rng.range(0.95, 1.05) });
  }
  for (const t of scheduleTimes(rng, L, o.crossingsPerHour / 3600, 60)) {
    if (!free(t - BELL_PEAK_S, t + 10, 15)) continue;
    const sc = distanceAt(motion, t);
    at(t, sc - 4, sc + 4, 'crossing');
    cues.push({ t: t - BELL_PEAK_S, type: 'sample', clip: pick.bell(), vel: 0.8, pan: 0.1, rate: rng.range(0.96, 1.04) });
    // The locomotive is LOCO_AHEAD_M ahead: it whistles for the crossing a few seconds before it gets there.
    horn(timeAt(motion, Math.max(0, sc - LOCO_AHEAD_M), L) - rng.range(3, 6));
  }
  // The odd horn for no reason we can see.
  for (const t of scheduleTimes(rng, L, (2 * o.horn) / 3600, 240)) horn(t);

  // Wheel clicks: each bogie crosses joint k when s + offset = k · RAIL. Joints in tunnels and on
  // bridges click too (the roar covers them); stations are plain track.
  const clicks: number[] = [];
  if (o.jointed) {
    const pickClick = clipPicker(rng, [...SOUNDS.click]);
    for (const off of BOGIES) {
      // Every joint the bogie meets in [0, D): s = k · RAIL - off, wrapped into the ring.
      for (let k = 0; k < motion.D / RAIL; k++) {
        const s = (((k * RAIL - off) % motion.D) + motion.D) % motion.D;
        const t = timeAt(motion, s, L);
        if (t >= L) continue;
        clicks.push(t);
        // The front bogie is towards the right (we travel right); slightly louder and more even when slow.
        cues.push({ t, type: 'click', clip: pickClick(), vel: rng.range(0.32, 0.5), pan: (off > 0 ? 0.35 : -0.35) * dir, rate: rng.range(0.94, 1.02) });
      }
    }
    clicks.sort((a, b) => a - b);
  }
  cues.sort((a, b) => a.t - b.t);
  features.sort((a, b) => a.t0 - b.t0);
  return { motion, features, clicks, cues };
}
