/**
 * The Trick Shot course: a tall glass cabinet of tilted boards, rods, pegs, bumpers and spinners,
 * with a cup standing on the floor, built as Rapier colliders. Built from the seed only, so the same
 * seed always gives the same course.
 */
import type { Rng } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { RAPIER } from '../rube-goldberg/rapier';
import { rotation, type Mat3, type Table } from './physics';

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

export type ObstacleKind = 'board' | 'rod' | 'peg' | 'bumper' | 'spinner' | 'swing';
export type Mix = 'mixed' | 'boards' | 'pegs' | 'bumpers';

/** How an obstacle is drawn (a spinner's or swing's pose follows it as it moves). */
export interface BoxShape {
  kind: 'box';
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  rot: Mat3;
}

export interface SphereShape {
  kind: 'sphere';
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface Spin {
  /** The kinematic body turning it. */
  body: number;
  angle: number;
  omega: number;
}

export interface Obstacle {
  kind: ObstacleKind;
  shape: BoxShape | SphereShape;
  spin?: Spin;
  /** Swings: the hinged paddle's body. */
  swing?: number;
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
}

export interface Course {
  obstacles: Obstacle[];
  cup: Cup;
}

/** Boxes in the cup's wall (a ring of them makes the tube; their square tops are the rim). */
const CUP_SEGMENTS = 32;
/** Thickness of the cabinet's walls, floor and ceiling (outside the cabinet). */
const SHELL = 0.5;

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
  table: Table,
  rng: Rng,
  o: { count: number; mix: Mix; spinners: number; swings: boolean; cupSize: number; restitution: number; cannons: { x: number; y: number; z: number }[] },
): Course {
  const cupR = (o.cupSize * BALL_R * 2) / 2;
  const cx = rng.range(-HALF_X + 0.9 + cupR, HALF_X - 0.9 - cupR);
  const cz = rng.range(-HALF_Z + 0.6 + cupR, HALF_Z - 0.6 - cupR);
  // The cup: a ring of upright boxes, each tangent to the inside circle and wide enough to close the
  // outside, standing on a base disc just above the floor (a ball inside touches the base, never the floor).
  const ro = cupR + CUP_WALL;
  const halfW = (ro * dm.sin(Math.PI / CUP_SEGMENTS)) / dm.cos(Math.PI / CUP_SEGMENTS) + 0.004;
  for (let k = 0; k < CUP_SEGMENTS; k++) {
    const a = (k * 2 * Math.PI) / CUP_SEGMENTS;
    const rc = cupR + CUP_WALL / 2;
    // Local x points out from the axis, local z along the wall.
    table.addStatic(
      RAPIER.ColliderDesc.cuboid(CUP_WALL / 2, CUP_H / 2, halfW),
      { x: cx + dm.cos(a) * rc, y: CUP_H / 2, z: cz + dm.sin(a) * rc },
      rotation(-a),
      { restitution: 0.3, friction: 0.2 },
      { tag: 'cup', obstacle: -1 },
    );
  }
  table.addStatic(RAPIER.ColliderDesc.cylinder(0.025, ro), { x: cx, y: 0.025, z: cz }, null, { restitution: 0.05, friction: 0.4 }, { tag: 'cupFloor', obstacle: -1 });
  // The cabinet: a floor, glass sides and a ceiling, as thick slabs outside it.
  table.addStatic(RAPIER.ColliderDesc.cuboid(HALF_X + SHELL, SHELL, HALF_Z + SHELL), { x: 0, y: -SHELL, z: 0 }, null, { restitution: 0.75, friction: 0 }, { tag: 'floor', obstacle: -1 });
  const side = { restitution: 0.8, friction: 0.05 };
  const sideInfo = { tag: 'side', obstacle: -1 };
  for (const sx of [-1, 1]) table.addStatic(RAPIER.ColliderDesc.cuboid(SHELL, HEIGHT / 2 + SHELL, HALF_Z + SHELL), { x: sx * (HALF_X + SHELL), y: HEIGHT / 2, z: 0 }, null, side, sideInfo);
  for (const sz of [-1, 1]) table.addStatic(RAPIER.ColliderDesc.cuboid(HALF_X + SHELL, HEIGHT / 2 + SHELL, SHELL), { x: 0, y: HEIGHT / 2, z: sz * (HALF_Z + SHELL) }, null, side, sideInfo);
  table.addStatic(RAPIER.ColliderDesc.cuboid(HALF_X + SHELL, SHELL, HALF_Z + SHELL), { x: 0, y: HEIGHT + SHELL, z: 0 }, null, side, sideInfo);
  const cup: Cup = { x: cx, z: cz, r: cupR };

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
  // Swings (one or two, out of the count) only where the course may move: not in attempts mode, whose
  // shots each start from the course at rest.
  const swings = o.swings ? rng.int(1, 2) : 0;
  for (let tries = 0; obstacles.length < wanted && tries < wanted * 150; tries++) {
    // The big moving pieces go in first, while there's room for them to turn and swing.
    let kind: ObstacleKind = obstacles.length < o.spinners ? 'spinner' : obstacles.length < o.spinners + swings ? 'swing' : pickKind(o.mix, rng);
    // A crowded cabinet runs out of room for the long pieces first: fill the rest with pegs.
    if ((kind === 'board' || kind === 'rod' || kind === 'swing') && tries > wanted * 80) kind = 'peg';
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
      const shape: BoxShape = { kind: 'box', cx: x, cy: y, cz: z, hx, hy: board ? 0.04 : 0.05, hz, rot };
      table.addStatic(RAPIER.ColliderDesc.cuboid(shape.hx, shape.hy, shape.hz), { x, y, z }, rot, { restitution: o.restitution, friction: 0.05 }, { tag: kind, obstacle: obstacles.length });
      taken.push(...parts);
      obstacles.push({ kind, shape, parts, hue, hitAt: -10 });
    } else if (kind === 'swing') {
      // A paddle hanging from a hinge: room for it to swing right up either side.
      const hy = rng.range(0.32, 0.45);
      const hz = rng.range(0.22, 0.32);
      const parts = [{ x, y, z, r: 2 * hy + 0.05 }];
      if (!fits(parts)) continue;
      const yaw = rng.range(0, Math.PI);
      const shape: BoxShape = { kind: 'box', cx: x, cy: y - hy, cz: z, hx: 0.04, hy, hz, rot: rotation(yaw) };
      const swing = table.addSwing({ x, y, z }, { x: 0.04, y: hy, z: hz }, yaw, { restitution: 0.5, friction: 0.1 }, { tag: 'swing', obstacle: obstacles.length });
      taken.push(...parts);
      obstacles.push({ kind, shape, swing, parts, hue, hitAt: -10 });
    } else if (kind === 'spinner') {
      const hx = rng.range(0.55, 0.8);
      const parts = [{ x, y, z, r: hx + 0.06 }];
      if (!fits(parts)) continue;
      const omega = rng.range(1.6, 3) * (rng.chance(0.5) ? 1 : -1);
      const angle = rng.range(0, Math.PI);
      const shape: BoxShape = { kind: 'box', cx: x, cy: y, cz: z, hx, hy: 0.05, hz: 0.07, rot: rotation(angle) };
      const body = table.addKinematicBox({ x, y, z }, { x: hx, y: 0.05, z: 0.07 }, angle, { restitution: 0.6, friction: 0.05 }, { tag: 'spinner', obstacle: obstacles.length });
      taken.push(...parts);
      obstacles.push({ kind, shape, spin: { body, angle, omega }, parts, hue, hitAt: -10 });
    } else {
      const bumper = kind === 'bumper';
      const r = bumper ? rng.range(0.28, 0.42) : rng.range(0.08, 0.13);
      const parts = [{ x, y, z, r }];
      if (!fits(parts)) continue;
      const shape: SphereShape = { kind: 'sphere', x, y, z, r };
      table.addStatic(RAPIER.ColliderDesc.ball(r), { x, y, z }, null, { restitution: bumper ? 0.8 : 0.6, friction: 0.05, lively: true }, { tag: kind, obstacle: obstacles.length, kick: bumper ? 2.4 : undefined, at: { x, y, z } });
      taken.push(...parts);
      obstacles.push({ kind, shape, parts, hue, hitAt: -10 });
    }
  }
  return { obstacles, cup };
}
