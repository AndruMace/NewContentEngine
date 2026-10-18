/**
 * Marble Machine geometry and gadget animations (three.js-style coordinates: x right, y up, z toward
 * the camera). A portrait tower: the program drum at the top, contraption routes through the middle
 * (seesaws on the left, a helix in the centre, a loop and jump on the right, zigzag rails at the
 * back), the vibraphone along the front, and the return loop (trough, paddle wheel, bucket elevator,
 * top rail) round the outside. Every animation is a pure function of time and the schedule.
 */
import { smooth, v3, type V3 } from './segments';

export const MARBLE_R = 0.11;
export const BASS_R = 0.15;

export const DRUM = { x0: -2.55, x1: 2.55, y: 10, z: 0, r: 0.45 };
/** Pegs trip their gate this far round the drum's front face (radians below facing the camera). */
export const TRIGGER_PHI = 1.1;
export const DRUM_OMEGA = 1.1;
export const GATE_Y = 9.45;

export const BARS = { x0: -2.55, x1: 2.55, top: 2.0, z: 0.8, h: 0.12 };

export interface Channel {
  midi: number;
  x: number;
  /** Bar width (across the screen) and length (into the screen; longer for lower notes). */
  w: number;
  d: number;
  /** Resonator tube length under the bar. */
  tube: number;
  bass: boolean;
}

/** One bar per pitch played, low to high across the front. */
export function layoutChannels(pitches: number[], bassPitches: Set<number>): Channel[] {
  const sorted = [...new Set(pitches)].sort((a, b) => a - b);
  const n = sorted.length;
  const lo = sorted[0];
  const hi = sorted[n - 1];
  const spacing = n > 1 ? (BARS.x1 - BARS.x0) / (n - 1) : 0;
  const w = Math.min(0.42, Math.max(0.16, (n > 1 ? spacing : 0.5) * 0.84));
  return sorted.map((midi, k) => {
    const f = hi === lo ? 0.5 : (midi - lo) / (hi - lo);
    return { midi, x: n > 1 ? BARS.x0 + spacing * k : 0, w, d: 0.95 - 0.4 * f, tube: 0.35 + 0.75 * (1 - f), bass: bassPitches.has(midi) };
  });
}

/** Where a marble of radius r sits on top of a bar. */
export const barContact = (c: Channel, r: number): V3 => v3(c.x, BARS.top + r, BARS.z);

// ——— Seesaws ———

export interface Seesaw {
  pivot: V3;
  half: number;
  /** Which end marbles land on: -1 left, +1 right. */
  side: 1 | -1;
}

/** Lever angle at rest (the entry end raised) and tipped (the entry end down). */
const REST = 0.35;
export const TIP_S = 0.3;
const HOLD_S = 0.18;
const RETURN_S = 0.42;
/** A seesaw takes one marble at a time: landings this far apart at least. */
export const SEESAW_GAP = TIP_S + HOLD_S + RETURN_S + 0.05;

export const SEESAWS: Seesaw[] = [
  { pivot: v3(-1.35, 7.45, -0.3), half: 0.55, side: -1 },
  { pivot: v3(-2.4, 6.35, -0.3), half: 0.55, side: 1 },
];

const restAngle = (s: Seesaw) => s.side * REST;

/** Lever angle (counter-clockwise, radians) given the times marbles landed on it. */
export function leverAngle(s: Seesaw, landings: number[], t: number): number {
  const rest = restAngle(s);
  const tip = -rest;
  let last = -Infinity;
  for (const l of landings) if (l <= t) last = l;
  const u = t - last;
  if (u < TIP_S) return rest + (tip - rest) * smooth(u / TIP_S);
  if (u < TIP_S + HOLD_S) return tip;
  if (u < TIP_S + HOLD_S + RETURN_S) return tip + (rest - tip) * smooth((u - TIP_S - HOLD_S) / RETURN_S);
  return rest;
}

/** The entry end of a seesaw at lever angle a, lifted by r so a marble sits on it. */
export function leverEnd(s: Seesaw, a: number, r: number): V3 {
  return v3(s.pivot.x + s.side * s.half * Math.cos(a), s.pivot.y + s.side * s.half * Math.sin(a) + r + 0.03, s.pivot.z);
}

/** The entry end while the marble that landed at `landed` tips it down. */
export const tippingEnd = (s: Seesaw, landed: number, r: number) => (t: number) => {
  const rest = restAngle(s);
  return leverEnd(s, rest + (-rest - rest) * smooth((t - landed) / TIP_S), r);
};

// ——— The loop, helix and zigzag routes ———

export const HELIX = { cx: 0, cz: -0.6, r: 0.62, top: 9.0, bottom: 5.0, turns: 3 };
export const LOOP = { c: v3(2.0, 6.75, -0.3), r: 0.45 };
export const ZIGZAG_Z = -1.5;

// ——— Return loop ———

export const TROUGH = { y0: 1.05, y1: 0.85, z: 0.05, xEnd: 2.2 };
export const WHEEL = { c: v3(2.55, 0.62, 0.05), r: 0.42, paddles: 6 };
/** Each marble turns the wheel one paddle, over this long. */
export const WHEEL_TURN_S = 0.6;
export const LIFT = { x: 2.85, z: -1.0, y0: 0.3, y1: 10.45, v: 2.4, spacing: 0.5 };
export const BUCKET_DT = LIFT.spacing / LIFT.v;
export const RAIL = { y: 10.45, z: -1.0, xEnd: -2.55 };
export const HOPPER = { x: -2.8, y: 9.85, z: -0.8, r: 0.28 };

/** Paddle wheel angle (clockwise, radians) given the times marbles dropped on it. */
export function wheelAngle(drops: number[], t: number): number {
  let a = 0;
  for (const d of drops) {
    if (d > t) break;
    a += ((Math.PI * 2) / WHEEL.paddles) * smooth((t - d) / WHEEL_TURN_S);
  }
  return a + t * 0.15;
}

/** Height of bucket k on the elevator at time t (it passes the foot at k·BUCKET_DT). */
export const bucketY = (k: number, t: number) => LIFT.y0 + (t - k * BUCKET_DT) * LIFT.v;

// ——— Showpieces ———

/** The bass hopper's lever, thrown by a marble when the bass line joins. */
export const BASS_LEVER = { pivot: v3(-2.55, 8.35, -1.05), len: 0.9 };
export const bassLeverAngle = (enterAt: number, t: number) => 0.9 * smooth((t - enterAt) / 0.45);

export const DOMINO = { z: 1.45, spacing: 0.2, h: 0.34, w: 0.16, t: 0.05, dt: 0.075, fall: 0.22 };

export interface DominoRun {
  /** Direction along x (+1 right, -1 left), first domino x, count, when the first one starts to fall. */
  dir: 1 | -1;
  x0: number;
  n: number;
  start: number;
  bell: V3;
}

/**
 * The domino run along the front floor, set off by the final note's marble, timed backwards so the
 * last domino strikes the bell exactly at `revealAt`. Returns null if there's no time for one.
 */
export function planDominoes(xHit: number, earliestStart: number, revealAt: number): DominoRun | null {
  const dir: 1 | -1 = xHit < 0 ? 1 : -1;
  const x0 = xHit + dir * 0.42;
  const room = dir > 0 ? 2.8 - x0 : x0 + 2.8;
  const byRoom = Math.floor((room - 0.3) / DOMINO.spacing) + 1;
  const byTime = Math.floor((revealAt - DOMINO.fall - earliestStart) / DOMINO.dt) + 1;
  const n = Math.min(26, byRoom, byTime);
  if (n < 4) return null;
  const start = revealAt - DOMINO.fall - (n - 1) * DOMINO.dt;
  return { dir, x0, n, start, bell: v3(x0 + dir * ((n - 1) * DOMINO.spacing + 0.3), 0, DOMINO.z) };
}

/** Domino k's tilt (radians, toward the run's direction): it falls onto the next one (or the bell). */
export function dominoTilt(run: DominoRun, k: number, t: number): number {
  const lean = Math.atan2(DOMINO.spacing, DOMINO.h) * 1.15;
  return lean * smooth((t - (run.start + k * DOMINO.dt)) / DOMINO.fall);
}
