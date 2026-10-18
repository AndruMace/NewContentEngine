/**
 * The Marble Machine's routes and scheduler. Each note's marble is released from the drum, runs one
 * contraption route (helix, seesaws, loop-and-jump, zigzag rails, or a straight drop), leaps from the
 * route's exit onto its bar exactly on the beat, then rides the return loop back to the hopper. The
 * final note's marble sets off the domino run instead. Pure functions of the timeline and the rng.
 */
import type { Rng } from '@sim/engine';
import {
  BARS,
  BUCKET_DT,
  DOMINO,
  GATE_Y,
  HELIX,
  HOPPER,
  LIFT,
  LOOP,
  RAIL,
  SEESAWS,
  SEESAW_GAP,
  TIP_S,
  TROUGH,
  WHEEL,
  ZIGZAG_Z,
  barContact,
  bucketY,
  leverEnd,
  planDominoes,
  tippingEnd,
  type Channel,
  type DominoRun,
} from './machine';
import { G, Path, dist, v3, type V3 } from './segments';

export const ROUTES = ['helix', 'seesaw', 'loop', 'zigzag', 'direct'] as const;
export type RouteKind = (typeof ROUTES)[number];

/** Least time between two marbles entering the same route. */
export const ROUTE_GAP: Record<RouteKind, number> = { helix: 0.45, seesaw: SEESAW_GAP, loop: 0.75, zigzag: 0.35, direct: 0 };

/** Where each route's marble leaves the drum. */
const INLET_X: Record<Exclude<RouteKind, 'direct'>, number> = { helix: 0, seesaw: -2.0, loop: 0.95, zigzag: -1.0 };

export interface Note {
  /** Melody step index, or -1 for a bass note. */
  i: number;
  t: number;
  dur: number;
  midi: number;
  bass: boolean;
}

/** Something a gadget does at a moment (for sounds and the camera). */
export interface GadgetEvent {
  t: number;
  kind: 'tip' | 'loop' | 'clack' | 'wheel' | 'domino';
  x: number;
  /** Seesaw index for tips. */
  n?: number;
}

export interface Drop extends Note {
  ch: number;
  r: number;
  route: RouteKind;
  release: number;
  /** Drum peg position along the drum (x). */
  pegX: number;
  path: Path;
  /** When it reaches the route's exit (the leap to its bar), and when it is back in the hopper. */
  exitAt: number;
  goneAt: number;
  /** Return loop: lands on the paddle wheel; bucket number on the elevator. */
  wheelAt: number;
  bucket: number;
  final: boolean;
}

export interface Schedule {
  drops: Drop[];
  events: GadgetEvent[];
  seesawLandings: number[][];
  wheelDrops: number[];
  dominoes: DominoRun | null;
}

/** The surface point p with a marble of radius r sitting on it. */
const on = (p: V3, r: number) => v3(p.x, p.y + r + 0.02, p.z);

/** A route from the drum gate to its exit, starting at `release`. Gadget moments are reported to `ev`. */
export function routeToExit(kind: Exclude<RouteKind, 'direct'>, release: number, r: number, ev: GadgetEvent[], landings: number[][]): Path {
  const gate = v3(INLET_X[kind], GATE_Y, 0.2);
  const p = new Path(release, gate);
  switch (kind) {
    case 'helix': {
      const top = v3(HELIX.cx, HELIX.top + r, HELIX.cz + HELIX.r);
      p.fly(top, 0.25).helix(HELIX.cx, HELIX.cz, HELIX.r, HELIX.turns, HELIX.bottom + r, 2.7, -1);
      break;
    }
    case 'seesaw': {
      const [a, b] = SEESAWS;
      p.fly(on(v3(-2.5, 8.75, -0.3), r), 0.32).rail(on(v3(-1.95, 8.25, -0.3), r), 1.8);
      // Land on the first lever's raised end, ride it down as it tips, drop onto the second.
      p.fly(leverEnd(a, a.side * 0.35, r), 0.26);
      landings[0].push(p.t);
      ev.push({ t: p.t, kind: 'tip', x: p.p.x, n: 0 });
      p.ride(TIP_S, tippingEnd(a, p.t, r), 'seesaw');
      p.fly(leverEnd(b, b.side * 0.35, r), 0.3);
      landings[1].push(p.t);
      ev.push({ t: p.t, kind: 'tip', x: p.p.x, n: 1 });
      p.ride(TIP_S, tippingEnd(b, p.t, r), 'seesaw');
      p.fly(on(v3(-1.35, 5.75, -0.3), r), 0.28).rail(on(v3(-0.8, 5.35, -0.3), r), 1.8);
      break;
    }
    case 'loop': {
      const bottom = v3(LOOP.c.x, LOOP.c.y - LOOP.r, LOOP.c.z);
      p.fly(on(v3(0.95, 8.9, -0.3), r), 0.28).rail(on(bottom, r), 3.2);
      ev.push({ t: p.t, kind: 'loop', x: bottom.x });
      p.loop(v3(LOOP.c.x, LOOP.c.y, LOOP.c.z), LOOP.r - r - 0.02, 3.2);
      // Out of the loop, up a little kicker and over the gap onto the landing ramp.
      p.rail(on(v3(2.35, 6.36, -0.3), r), 3.2).fly(on(v3(2.62, 5.78, -0.3), r), 0.34, 'jump').rail(on(v3(1.5, 5.18, -0.3), r), 2.2);
      break;
    }
    case 'zigzag': {
      const z = ZIGZAG_Z;
      p.fly(on(v3(-2.3, 9.0, z), r), 0.42);
      const legs: [number, number, number, number][] = [
        [-2.3, 9.0, 2.3, 8.3],
        [2.3, 7.75, -2.3, 7.05],
        [-2.3, 6.5, 2.3, 5.8],
      ];
      legs.forEach(([, , x1, y1], k) => {
        p.rail(on(v3(x1, y1, z), r), 3.6);
        ev.push({ t: p.t, kind: 'clack', x: x1 });
        if (k < legs.length - 1) p.fly(on(v3(legs[k + 1][0], legs[k + 1][1], z), r), 0.26);
      });
      break;
    }
  }
  return p;
}

/** Flight time for the leap from a route's exit onto a bar: longer for longer leaps. */
const leapTime = (from: V3, to: V3) => Math.min(1.0, Math.max(0.5, 0.42 + 0.11 * Math.hypot(to.x - from.x, to.z - from.z)));

/** Release-to-hit time for each route onto each bar (fixed, so release = hit − this). */
function travelTime(kind: RouteKind, c: Channel, r: number): number {
  if (kind === 'direct') return Math.sqrt((2 * (GATE_Y - (BARS.top + r))) / G);
  const p = routeToExit(kind, 0, r, [], [[], []]);
  return p.t + leapTime(p.p, barContact(c, r));
}

/** Base appeal of each route, and how the note's length shifts it. */
const APPEAL: Record<RouteKind, number> = { loop: 3, seesaw: 3, helix: 2.6, zigzag: 1.7, direct: 1 };

export function schedule(notes: Note[], channels: Channel[], rng: Rng, revealAt: number): Schedule {
  const chOf = (midi: number) => channels.findIndex((c) => c.midi === midi);
  const travel = new Map<string, number>();
  const tt = (kind: RouteKind, ch: number, r: number) => {
    const key = `${kind}:${ch}:${r}`;
    if (!travel.has(key)) travel.set(key, travelTime(kind, channels[ch], r));
    return travel.get(key)!;
  };
  const lastEntry: Record<RouteKind, number> = { helix: -Infinity, seesaw: -Infinity, loop: -Infinity, zigzag: -Infinity, direct: -Infinity };
  const events: GadgetEvent[] = [];
  const seesawLandings: number[][] = [[], []];
  const drops: Drop[] = [];
  const order = [...notes].sort((a, b) => a.t - b.t || a.i - b.i);
  const finalIdx = order.reduce((best, n, k) => (!n.bass && (best < 0 || n.t >= order[best].t) ? k : best), -1);
  let prev: RouteKind | null = null;

  order.forEach((n, k) => {
    const ch = chOf(n.midi);
    const c = channels[ch];
    const r = n.bass ? 0.15 : 0.11;
    let best: RouteKind = 'direct';
    let bestScore = -Infinity;
    for (const kind of ROUTES) {
      const release = n.t - tt(kind, ch, r);
      if (release < 0 || release - lastEntry[kind] < ROUTE_GAP[kind]) continue;
      let score = APPEAL[kind] * rng.range(0.7, 1.3);
      const showpiece = kind === 'loop' || kind === 'seesaw' || kind === 'helix';
      if (showpiece && n.dur >= 0.4) score *= 1.6;
      if (n.dur < 0.2 && (kind === 'direct' || kind === 'zigzag')) score *= 1.8;
      if (kind === prev) score *= 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = kind;
      }
    }
    const release = n.t - tt(best, ch, r);
    lastEntry[best] = release;
    prev = best;
    const hitAt = barContact(c, r);
    let path: Path;
    if (best === 'direct') {
      path = new Path(release, v3(c.x, GATE_Y, BARS.z)).drop(hitAt.y);
    } else {
      path = routeToExit(best, release, r, events, seesawLandings);
      path.fly(hitAt, leapTime(path.p, hitAt), 'leap');
    }
    const exitAt = best === 'direct' ? release : path.segs[path.segs.length - 1].t0;
    drops.push({ ...n, ch, r, route: best, release, pegX: best === 'direct' ? c.x : INLET_X[best], path, exitAt, goneAt: Infinity, wheelAt: Infinity, bucket: -1, final: k === finalIdx });
  });

  // After the hit: the final note's marble starts the domino run; every other one heads home.
  let dominoes: DominoRun | null = null;
  const wheelDrops: number[] = [];
  const toLift: Drop[] = [];
  for (const d of drops) {
    const p = d.path;
    const c = channels[d.ch];
    if (d.final) {
      const land = v3(c.x, d.r, DOMINO.z);
      dominoes = planDominoes(c.x, d.t + 0.5 + 0.15, revealAt);
      if (dominoes) {
        // Leap down to the floor and roll into the first domino just as the run is due to start.
        const touch = v3(dominoes.x0 - dominoes.dir * (DOMINO.t / 2 + d.r), d.r, DOMINO.z);
        p.fly(land, 0.5, 'leap');
        p.rail(touch, dist(land, touch) / (dominoes.start - p.t), 'roll').wait(60);
        for (let k = 0; k < dominoes.n; k += 2) events.push({ t: dominoes.start + k * 0.075, kind: 'domino', x: dominoes.x0 + dominoes.dir * k * 0.2 });
        continue;
      }
    }
    // Hop back off the bar into the trough, roll to the paddle wheel, ride it over, on to the lift.
    const tx = Math.min(TROUGH.xEnd - 0.1, c.x + 0.15);
    const troughY = (x: number) => TROUGH.y0 + ((TROUGH.y1 - TROUGH.y0) * (x + 2.8)) / (TROUGH.xEnd + 2.8);
    p.fly(v3(tx, troughY(tx) + d.r, TROUGH.z), 0.42, 'hop');
    events.push({ t: p.t, kind: 'clack', x: tx });
    p.rail(v3(TROUGH.xEnd, troughY(TROUGH.xEnd) + d.r, TROUGH.z), 2.0, 'trough');
    d.wheelAt = p.t;
    wheelDrops.push(p.t);
    const R = WHEEL.r + d.r;
    const w0 = p.t;
    p.ride(0.6, (t) => {
      const a = (150 - 120 * Math.min(1, (t - w0) / 0.6)) * (Math.PI / 180);
      return v3(WHEEL.c.x + R * Math.cos(a), WHEEL.c.y + R * Math.sin(a), WHEEL.c.z);
    }, 'wheel');
    p.rail(v3(LIFT.x, LIFT.y0 + d.r, LIFT.z), 1.8);
    toLift.push(d);
  }
  // Buckets on the elevator, first come first served (each bucket carries one marble).
  toLift.sort((a, b) => a.path.t - b.path.t);
  const taken = new Set<number>();
  for (const d of toLift) {
    const p = d.path;
    let k = Math.ceil(p.t / BUCKET_DT);
    while (taken.has(k)) k++;
    taken.add(k);
    d.bucket = k;
    p.wait(k * BUCKET_DT - p.t, 'queue');
    const ride = (LIFT.y1 - LIFT.y0) / LIFT.v;
    const t0 = p.t;
    p.ride(ride, (t) => v3(LIFT.x, bucketY(k, Math.min(t, t0 + ride)) + d.r, LIFT.z), 'lift');
    p.rail(v3(RAIL.xEnd, RAIL.y + d.r, RAIL.z), 2.6, 'top').rail(v3(HOPPER.x + HOPPER.r, HOPPER.y + 0.25, HOPPER.z), 1.6).helix(HOPPER.x, HOPPER.z, HOPPER.r, 1.25, HOPPER.y - 0.3, 1.4);
    d.goneAt = p.t;
  }
  events.sort((a, b) => a.t - b.t);
  wheelDrops.sort((a, b) => a - b);
  return { drops, events, seesawLandings: seesawLandings.map((l) => l.sort((a, b) => a - b)), wheelDrops, dominoes };
}
