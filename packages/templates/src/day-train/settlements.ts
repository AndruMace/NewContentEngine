/**
 * Where Day Train's settlements are (no rendering): farmsteads and villages by the line, walled towns
 * on hilltops, lone castles on crags, now and then a city on a far ridge. Each has a place on the ring
 * (s, metres along) and a distance out from the track, and passes the window at time t.
 *
 * Towns, castles and cities (and the river valleys under bridges) shape the land itself (world.ts);
 * the shader holds MAX_FAR of them, so they keep FAR_GAP apart along the ring, which keeps at most
 * MAX_FAR within FAR_RANGE either way of the window. Gaps hold across the ring's join too.
 */
import type { Rng } from '@sim/engine';
import { ringPos, timeAt, type Timetable } from '../night-train/track';
import { FAR_KIND, FAR_RANGE, MAX_FAR, MAX_VIL, NEAR_KIND, type FarShape, type NearShape } from './world';

/** The ring is a whole number of these (m): every band of scenery's window divides it. */
export const RING_STEP_DAY = 4800;
/** Settlements that shape the land keep this far apart along the ring (m). */
export const FAR_GAP = (2 * FAR_RANGE) / (MAX_FAR - 1) + 1;

export type SettlementKind = 'station' | 'farm' | 'village' | 'town' | 'castle' | 'city';

export interface Settlement {
  kind: SettlementKind;
  /** Ring position (m) and distance out from the track (m). */
  s: number;
  out: number;
  /** When it is level with the window. */
  t: number;
  /** The hill it sits on (towns, castles, cities): radius and height above the land round it (m). */
  radius: number;
  height: number;
  seed: number;
}

export interface SettlementOptions {
  /** 0..1: villages and farms. */
  villages: number;
  /** 0..1: walled towns, castles and cities. */
  castles: number;
}

/** Signed ring distance from a to b (m), the short way round. */
export const ringDelta = (a: number, b: number, D: number) => {
  const r = ringPos(b - a, D);
  return r > D / 2 ? r - D : r;
};

export function settlements(tt: Timetable, L: number, o: SettlementOptions, rng: Rng): Settlement[] {
  const { motion, features } = tt;
  const D = motion.D;
  const per10k = (n: number) => Math.max(0, Math.round((n * D) / 10000));
  const out: Settlement[] = [];
  // Land-shaping places taken along the ring: the rivers under bridges first.
  const farTaken: number[] = features.filter((f) => f.kind === 'bridge').map((f) => ringPos((f.s0 + f.s1) / 2, D));
  // Nothing big right by a tunnel or a station (the land is shaped for those).
  const avoid = features.filter((f) => f.kind === 'tunnel' || f.kind === 'station').map((f) => [ringPos(f.s0 - 300, D), f.s1 - f.s0 + 600] as const);
  const clearOf = (s: number) => avoid.every(([a, len]) => ringPos(s - a, D) > len);
  const overlaps = (s: number, d: number, r: number) => out.some((w) => Math.abs(ringDelta(w.s, s, D)) < r + w.radius * 0.6 + 60 && Math.abs(w.out - d) < r + w.radius * 0.6 + 60);
  const add = (kind: SettlementKind, s: number, d: number, radius: number, height: number) => {
    out.push({ kind, s, out: d, t: timeAt(motion, ringPos(s, D), L), radius, height, seed: rng.int(1, 1_000_000) });
  };
  const tryFar = (kind: SettlementKind, n: number, place: () => { d: number; r: number; h: number }) => {
    for (let k = 0; k < n; k++)
      for (let attempt = 0; attempt < 30; attempt++) {
        const s = rng.range(0, D);
        if (farTaken.some((x) => Math.abs(ringDelta(x, s, D)) < FAR_GAP) || !clearOf(s)) continue;
        const { d, r, h } = place();
        if (overlaps(s, d, r)) continue;
        farTaken.push(s);
        add(kind, s, d, r, h);
        break;
      }
  };
  tryFar('city', per10k(0.12 + 0.4 * o.castles), () => ({ d: rng.range(1100, 1700), r: rng.range(800, 950), h: rng.range(80, 120) }));
  tryFar('town', per10k(0.5 + 1.1 * o.castles), () => ({ d: rng.range(330, 700), r: rng.range(300, 400), h: rng.range(25, 45) }));
  tryFar('castle', per10k(0.4 + 0.9 * o.castles), () => ({ d: rng.range(400, 1100), r: rng.range(150, 210), h: rng.range(40, 65) }));

  // Villages (one by every station) and farmsteads: on the land as it is.
  for (const f of features.filter((x) => x.kind === 'station')) {
    // The station house by the platform, and its village behind.
    add('station', ringPos((f.s0 + f.s1) / 2 + rng.range(-40, 40), D), 19, 0, 0);
    add('village', ringPos(f.s0 + rng.range(60, 240), D), rng.range(90, 160), 90, 0);
  }
  const tryNear = (kind: SettlementKind, n: number, dmin: number, dmax: number, r: number) => {
    for (let k = 0; k < n; k++)
      for (let attempt = 0; attempt < 20; attempt++) {
        const s = rng.range(0, D);
        const d = rng.range(dmin, dmax);
        if (overlaps(s, d, r) || !clearOf(s)) continue;
        add(kind, s, d, r, 0);
        break;
      }
  };
  tryNear('village', per10k(1.2 + 3.8 * o.villages), 110, 650, 90);
  tryNear('farm', per10k(2.5 + 6 * o.villages), 45, 380, 35);
  return out.sort((a, b) => a.t - b.t);
}

/** How a settlement shapes the land (towns, castles and cities sit on hills). */
export const shapesLand = (k: SettlementKind) => k === 'town' || k === 'castle' || k === 'city';

/**
 * The far features near the window as the land sees them, nearest first: the hills under towns,
 * castles and cities, and the valleys under bridges (along: metres from the window).
 */
export function farShapes(towns: Settlement[], tt: Timetable, dist: number): FarShape[] {
  const D = tt.motion.D;
  const list: FarShape[] = [];
  for (const w of towns) {
    if (!shapesLand(w.kind)) continue;
    const along = ringDelta(ringPos(dist, D), w.s, D);
    if (Math.abs(along) < FAR_RANGE) list.push({ kind: FAR_KIND.hill, along, out: w.out, radius: w.radius, height: w.height, seed: (w.seed % 997) / 997 });
  }
  for (const f of tt.features) {
    if (f.kind !== 'bridge') continue;
    const along = ringDelta(ringPos(dist, D), ringPos((f.s0 + f.s1) / 2, D), D);
    if (Math.abs(along) < FAR_RANGE) list.push({ kind: FAR_KIND.valley, along, out: 0, radius: (f.s1 - f.s0) * 0.45, height: 0, seed: (f.seed % 997) / 997 });
  }
  return list.sort((a, b) => Math.abs(a.along) - Math.abs(b.along)).slice(0, MAX_FAR);
}

/** The near features (stations, crossings, bridges, tunnels) within a kilometre, nearest first. */
export function nearShapes(tt: Timetable, dist: number): NearShape[] {
  const D = tt.motion.D;
  const list: NearShape[] = [];
  for (const f of tt.features) {
    const rel0 = ringDelta(ringPos(dist, D), ringPos(f.s0, D), D);
    const rel1 = rel0 + (f.s1 - f.s0);
    if (rel1 < -1000 || rel0 > 1000) continue;
    list.push({ kind: NEAR_KIND[f.kind], rel0, rel1, seed: (f.seed % 997) / 997 });
  }
  return list.sort((a, b) => Math.abs(a.rel0 + a.rel1) - Math.abs(b.rel0 + b.rel1)).slice(0, 4);
}

/** Villages and farms within reach of the trees (along, out, radius), nearest first. */
export function villageShapes(towns: Settlement[], dist: number, D: number): [number, number, number][] {
  const here = ringPos(dist, D);
  return towns
    .filter((w) => w.kind === 'village' || w.kind === 'farm')
    .map((w): [number, number, number] => [ringDelta(here, w.s, D), w.out, w.kind === 'village' ? 95 : 45])
    .filter(([a]) => Math.abs(a) < 2600)
    .sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))
    .slice(0, MAX_VIL);
}
