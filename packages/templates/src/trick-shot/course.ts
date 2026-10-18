/**
 * The Trick Shot course: a tall glass cabinet of tilted boards, rods, pegs, bumpers and spinners,
 * with a cup standing on the floor. Built from the seed only, so the same seed always gives the same
 * course (attempts mode rebuilds it for its test shots).
 */
import type { Rng } from '@sim/engine';
import { rotation, type Box3, type Mat3, type Plane3, type Sphere3, type Tube3, type World3D } from '@sim/physics';
import * as dm from '@sim/physics/math';

export const BALL_R = 0.18;
/** Cabinet: x and z half-widths, and height (floor at y = 0). */
export const HALF_X = 3;
export const HALF_Z = 1.8;
export const HEIGHT = 9;
export const CUP_H = 0.55;
export const CUP_WALL = 0.06;
/** Obstacles stay this far apart (surface to surface), so a ball can always get through. */
const GAP = BALL_R * 2.4;
/** Nothing in the column over the cup below this height, so the cup can be reached. */
export const KEEP_OUT_Y = 3.2;
const KEEP_OUT_PAD = 0.45;
const FIELD = { x: HALF_X - 0.4, z: HALF_Z - 0.4, y0: 1.7, y1: HEIGHT - 1.6 };

export type ObstacleKind = 'board' | 'rod' | 'peg' | 'bumper' | 'spinner';
export type Mix = 'mixed' | 'boards' | 'pegs' | 'bumpers';

export interface Obstacle {
  kind: ObstacleKind;
  shape: Box3 | Sphere3;
  /** Bounding spheres used for spacing (and the keep-out test). */
  parts: { x: number; y: number; z: number; r: number }[];
  /** 0..1 along the theme palette (visual only). */
  hue: number;
  hitAt: number;
}

export interface Cup {
  x: number;
  z: number;
  /** Inner radius. */
  r: number;
  wall: Tube3;
  bottom: Tube3;
}

export interface Course {
  obstacles: Obstacle[];
  cup: Cup;
  floor: Plane3;
}

const KIND_ODDS: Record<Mix, [ObstacleKind, number][]> = {
  mixed: [
    ['board', 0.4],
    ['rod', 0.15],
    ['peg', 0.25],
    ['bumper', 0.2],
  ],
  boards: [
    ['board', 0.75],
    ['rod', 0.25],
  ],
  pegs: [
    ['peg', 0.8],
    ['rod', 0.2],
  ],
  bumpers: [
    ['bumper', 0.55],
    ['peg', 0.45],
  ],
};

function pickKind(mix: Mix, rng: Rng): ObstacleKind {
  let u = rng.next();
  for (const [k, w] of KIND_ODDS[mix]) {
    if (u < w) return k;
    u -= w;
  }
  return KIND_ODDS[mix][0][0];
}

/** Whether a bounding sphere sits in the column above the cup (where it would block the shot). */
export function inKeepOut(c: { x: number; y: number; z: number; r: number }, cup: { x: number; z: number; r: number }) {
  return c.y - c.r < KEEP_OUT_Y && dm.hypot(c.x - cup.x, c.z - cup.z) < cup.r + CUP_WALL + KEEP_OUT_PAD + c.r;
}

/** Bounding spheres along a box's long (local x) axis. */
function boxParts(cx: number, cy: number, cz: number, rot: Mat3, hx: number, r: number) {
  const n = Math.max(2, Math.ceil(hx / r) + 1);
  return Array.from({ length: n }, (_, k) => {
    const u = -hx + (2 * hx * k) / (n - 1);
    return { x: cx + rot[0] * u, y: cy + rot[3] * u, z: cz + rot[6] * u, r };
  });
}

export function buildCourse(
  world: World3D,
  rng: Rng,
  o: { count: number; mix: Mix; spinners: number; cupSize: number; restitution: number; cannons: { x: number; y: number; z: number }[] },
): Course {
  const cupR = (o.cupSize * BALL_R * 2) / 2;
  const cx = rng.range(-HALF_X + 0.9 + cupR, HALF_X - 0.9 - cupR);
  const cz = rng.range(-HALF_Z + 0.6 + cupR, HALF_Z - 0.6 - cupR);
  const wall = world.add<Tube3>({ kind: 'tube', cx, cz, y0: 0, y1: CUP_H, ri: cupR, ro: cupR + CUP_WALL, restitution: 0.3, friction: 0.2, tag: 'cup' });
  // The cup's base sits just above the floor, so a ball inside touches it and never the floor.
  const bottom = world.add<Tube3>({ kind: 'tube', cx, cz, y0: 0, y1: 0.05, ri: 0, ro: cupR, restitution: 0.05, friction: 0.4, tag: 'cupFloor' });
  const floor = world.add<Plane3>({ kind: 'plane', nx: 0, ny: 1, nz: 0, d: 0, restitution: 0.75, friction: 0, tag: 'floor' });
  const side = { restitution: 0.8, tag: 'side' };
  world.add<Plane3>({ kind: 'plane', nx: 1, ny: 0, nz: 0, d: -HALF_X, ...side });
  world.add<Plane3>({ kind: 'plane', nx: -1, ny: 0, nz: 0, d: -HALF_X, ...side });
  world.add<Plane3>({ kind: 'plane', nx: 0, ny: 0, nz: 1, d: -HALF_Z, ...side });
  world.add<Plane3>({ kind: 'plane', nx: 0, ny: 0, nz: -1, d: -HALF_Z, ...side });
  world.add<Plane3>({ kind: 'plane', nx: 0, ny: -1, nz: 0, d: -HEIGHT, ...side });
  const cup: Cup = { x: cx, z: cz, r: cupR, wall, bottom };

  const obstacles: Obstacle[] = [];
  const taken: { x: number; y: number; z: number; r: number }[] = o.cannons.map((c) => ({ ...c, r: 1.1 }));
  const fits = (parts: { x: number; y: number; z: number; r: number }[]) =>
    parts.every(
      (q) =>
        Math.abs(q.x) + q.r < HALF_X - 0.15 &&
        Math.abs(q.z) + q.r < HALF_Z - 0.15 &&
        !inKeepOut(q, cup) &&
        taken.every((t) => dm.hypot(t.x - q.x, dm.hypot(t.y - q.y, t.z - q.z)) > t.r + q.r + GAP),
    );

  const wanted = o.count + o.spinners;
  for (let tries = 0; obstacles.length < wanted && tries < wanted * 150; tries++) {
    let kind: ObstacleKind = obstacles.length < o.spinners ? 'spinner' : pickKind(o.mix, rng);
    // A crowded cabinet runs out of room for the long pieces first: fill the rest with pegs.
    if ((kind === 'board' || kind === 'rod') && tries > wanted * 80) kind = 'peg';
    const x = rng.range(-FIELD.x, FIELD.x);
    const y = rng.range(FIELD.y0, FIELD.y1);
    const z = rng.range(-FIELD.z, FIELD.z);
    const hue = rng.next();
    if (kind === 'board' || kind === 'rod') {
      // Boards: wide planks tilted well off flat, so a ball can't come to rest on one. Rods: thin bars.
      const board = kind === 'board';
      const hx = rng.range(0.35, board ? 0.7 : 0.9);
      const hz = board ? rng.range(0.25, 0.45) : 0.05;
      const rot = rotation(rng.range(0, Math.PI), board ? rng.range(-0.2, 0.2) : 0, rng.range(0.4, 1.2) * (rng.chance(0.5) ? 1 : -1));
      const parts = boxParts(x, y, z, rot, hx, Math.max(hz, 0.06));
      if (!fits(parts)) continue;
      const shape = world.add<Box3>({ kind: 'box', cx: x, cy: y, cz: z, hx, hy: board ? 0.04 : 0.05, hz, rot, restitution: o.restitution, friction: 0.05, tag: kind });
      taken.push(...parts);
      obstacles.push({ kind, shape, parts, hue, hitAt: -10 });
    } else if (kind === 'spinner') {
      const hx = rng.range(0.55, 0.8);
      const parts = [{ x, y, z, r: hx + 0.06 }];
      if (!fits(parts)) continue;
      const omega = rng.range(1.6, 3) * (rng.chance(0.5) ? 1 : -1);
      const shape = world.addSpinner({ cx: x, cy: y, cz: z, hx, hy: 0.05, hz: 0.07, restitution: 0.6, tag: 'spinner' }, rng.range(0, Math.PI), omega);
      taken.push(...parts);
      obstacles.push({ kind, shape, parts, hue, hitAt: -10 });
    } else {
      const bumper = kind === 'bumper';
      const r = bumper ? rng.range(0.28, 0.42) : rng.range(0.08, 0.13);
      const parts = [{ x, y, z, r }];
      if (!fits(parts)) continue;
      const shape = world.add<Sphere3>({ kind: 'sphere', x, y, z, r, restitution: bumper ? 0.8 : 0.6, kick: bumper ? 2.4 : undefined, tag: kind });
      taken.push(...parts);
      obstacles.push({ kind, shape, parts, hue, hitAt: -10 });
    }
  }
  return { obstacles, cup, floor };
}
