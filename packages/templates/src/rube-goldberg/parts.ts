/**
 * Building blocks for the machine's scenery: wooden channels, catch trays, posts and brackets, each
 * a real collider plus its drawing. All in the machine plane: runs go along x, depth is z.
 */
import * as dm from '@sim/physics/math';
import { ID_Q, MARBLE_R, add, len, quatAxis, quatMul, rotate, scale, sub, v3, type Finish, type Material, type Quat, type Sim, type V3 } from './sim';


/** A channel's inside width and wall height, and the wood's thickness. */
export const CHANNEL_W = MARBLE_R * 2 + 0.008;
export const WALL_H = 0.016;
export const WOOD_T = 0.008;

/**
 * The rotation taking local x to `d` (unit), local y to the direction closest to world up that is
 * square to it, and local z across. Built from basis vectors (only sqrt, so it is deterministic).
 */
export function orient(d: V3): Quat {
  // y' = up minus its component along d, normalised; z' = x' × y'.
  let yx = -d.y * d.x;
  let yy = 1 - d.y * d.y;
  let yz = -d.y * d.z;
  const yl = Math.sqrt(yx * yx + yy * yy + yz * yz) || 1;
  yx /= yl;
  yy /= yl;
  yz /= yl;
  const zx = d.y * yz - d.z * yy;
  const zy = d.z * yx - d.x * yz;
  const zz = d.x * yy - d.y * yx;
  return quatFromBasis(d, v3(yx, yy, yz), v3(zx, zy, zz));
}

/** Quaternion from an orthonormal basis (the rotated x, y and z axes). */
export function quatFromBasis(x: V3, y: V3, z: V3): Quat {
  const m00 = x.x, m01 = y.x, m02 = z.x;
  const m10 = x.y, m11 = y.y, m12 = z.y;
  const m20 = x.z, m21 = y.z, m22 = z.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const k = Math.sqrt(tr + 1) * 2;
    return { w: 0.25 * k, x: (m21 - m12) / k, y: (m02 - m20) / k, z: (m10 - m01) / k };
  }
  if (m00 > m11 && m00 > m22) {
    const k = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return { w: (m21 - m12) / k, x: 0.25 * k, y: (m01 + m10) / k, z: (m02 + m20) / k };
  }
  if (m11 > m22) {
    const k = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return { w: (m02 - m20) / k, x: (m01 + m10) / k, y: 0.25 * k, z: (m12 + m21) / k };
  }
  const k = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return { w: (m10 - m01) / k, x: (m02 + m20) / k, y: (m12 + m21) / k, z: 0.25 * k };
}

/** A box from its top-surface centre line (from → to, any direction), width across, thickness below. */
export function plank(sim: Sim, from: V3, to: V3, width: number, thick: number, finish: Finish, material: Material, tag = 'wood', hue?: number) {
  // Lay it so its run points +x-ward (when it has any x), so "up" is up.
  if (to.x < from.x || (to.x === from.x && to.z < from.z)) [from, to] = [to, from];
  const d = sub(to, from);
  const length = len(d);
  const u = scale(d, 1 / length);
  const q = orient(u);
  const up = rotate(q, v3(0, 1, 0));
  const pos = sub(scale(add(from, to), 0.5), scale(up, thick / 2));
  sim.addStatic({ shape: { kind: 'box', hx: length / 2, hy: thick / 2, hz: width / 2, round: Math.min(0.002, thick / 3) }, finish, hue, pos, rot: q }, material, tag);
}

/**
 * A U-shaped wooden channel: floor from → to (where the marble's underside rolls), walls either side.
 * A closed start gets an end stop so a marble dropped onto it can't roll out backwards.
 */
export function channel(sim: Sim, from: V3, to: V3, o: { finish?: Finish; closedStart?: boolean; wall?: number } = {}) {
  const finish = o.finish ?? 'maple';
  const wall = o.wall ?? WALL_H;
  plank(sim, from, to, CHANNEL_W + 2 * WOOD_T, WOOD_T, finish, 'wood');
  const d = sub(to, from);
  const u = scale(d, 1 / len(d));
  const q = orient(u);
  const across = rotate(q, v3(0, 0, 1));
  const up = rotate(q, v3(0, 1, 0));
  for (const side of [-1, 1]) {
    const off = add(scale(across, side * (CHANNEL_W / 2 + WOOD_T / 2)), scale(up, wall));
    plank(sim, add(from, off), add(to, off), WOOD_T, wall, finish, 'wood');
  }
  if (o.closedStart) {
    const c = add(sub(from, scale(u, WOOD_T / 2)), scale(up, wall / 2));
    sim.addStatic({ shape: { kind: 'box', hx: WOOD_T / 2, hy: wall / 2, hz: CHANNEL_W / 2 + WOOD_T }, finish, pos: c, rot: q }, 'wood', 'wood');
  }
}

/** A rail (a capsule) from a to b: chains of these make smooth wire tracks. */
export function rail(sim: Sim, a: V3, b: V3, r: number, finish: Finish = 'steel', tag = 'rail', collide = true) {
  const d = sub(b, a);
  const l = len(d);
  if (l < 1e-6) return;
  // Rapier's capsules run along local y: turn y onto the segment.
  const q = orient(scale(d, 1 / l));
  const toY = quatAxis(v3(0, 0, 1), Math.PI / 2);
  sim.addStatic({ shape: { kind: 'capsule', r, hh: l / 2 }, finish, pos: scale(add(a, b), 0.5), rot: quatMul(q, toY) }, 'steel', tag, collide);
}

/**
 * A conical catch funnel (a lathe surface, centre axis vertical): anything landing inside its rim
 * spirals down and drops out of the hole. Returns the hole's centre. The surface is a two-sided
 * triangle mesh, drawn and collided alike.
 */
export function funnel(sim: Sim, centre: V3, rTop: number, rHole: number, depth: number, finish: Finish = 'brass', segs = 40, hue?: number): V3 {
  const rows = 6;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= rows; j++) {
    const u = j / rows;
    // Slightly flared (concave) profile, like a real funnel.
    const r = rHole + (rTop - rHole) * (u * u * 0.35 + u * 0.65);
    const y = centre.y - depth + depth * u;
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      positions.push(centre.x + r * dm.cos(a), y, centre.z + r * dm.sin(a));
    }
  }
  for (let j = 0; j < rows; j++)
    for (let k = 0; k < segs; k++) {
      const a = j * segs + k;
      const b = j * segs + ((k + 1) % segs);
      indices.push(a, a + segs, b, b, a + segs, b + segs);
    }
  sim.addStatic({ shape: { kind: 'mesh', positions: new Float32Array(positions), indices: new Uint32Array(indices) }, finish, hue, pos: v3(0, 0, 0), rot: ID_Q }, finish === 'brass' ? 'brass' : 'wood', 'funnel');
  // A rolled brass rim and a collar at the spout (drawing only).
  sim.addStatic({ shape: { kind: 'torus', R: rTop, r: 0.0022 }, finish: 'brass', pos: v3(centre.x, centre.y, centre.z), rot: ID_Q }, 'brass', 'rim', false);
  sim.addStatic({ shape: { kind: 'torus', R: rHole + 0.0015, r: 0.0018 }, finish: 'brass', pos: v3(centre.x, centre.y - depth, centre.z), rot: ID_Q }, 'brass', 'rim', false);
  return v3(centre.x, centre.y - depth, centre.z);
}

/** A vertical support post (visual, with a collider so nothing passes through it). */
export function post(sim: Sim, x: number, z: number, y0: number, y1: number, finish: Finish = 'steel') {
  if (y1 - y0 < 0.01) return;
  sim.addStatic({ shape: { kind: 'cylinder', r: 0.004, hh: (y1 - y0) / 2 }, finish, pos: v3(x, (y0 + y1) / 2, z), rot: ID_Q }, 'steel', 'post', false);
}

/** Where a marble leaving `at` with velocity `vel` comes down to height y (marble centre). */
export function landing(at: V3, vel: V3, y: number): { at: V3; t: number } {
  const g = 9.81;
  const h = at.y - y;
  const t = (vel.y + Math.sqrt(Math.max(0, vel.y * vel.y + 2 * g * h))) / g;
  return { at: v3(at.x + vel.x * t, y, at.z + vel.z * t), t };
}
