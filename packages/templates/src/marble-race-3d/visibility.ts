/**
 * Can the camera see into a lane? The tower is watched from the front and a little above, so a lane
 * in the back row can disappear behind solid track in front of it at about its own height (a front
 * lane's floor, a turn's walls, a funnel's bowl). Glass walls don't count: they're see-through.
 *
 * The check traces sight lines from points along a lane (where the marbles roll) toward the camera
 * and reports the share that run into solid track. Pure geometry on the built course, so the
 * generator can use it to lay the tower out with every lane in view.
 */
import type { Piece, V3 } from '../rube-goldberg/sim';
import { OUTER_H, R, RT, T, W, WALL_H, type FunnelSpec, type TurnSpec } from './course';

/** The camera's angle above the horizontal, looking at the marbles (a little under its real tilt, to be safe). */
const VIEW_TILT = 0.3;
const RAY_LEN = 0.45;
const STEP = 0.0025;

export interface Box {
  c: V3;
  /** Rotation (row-major 3×3) and half sizes. */
  m: number[];
  h: V3;
  lo: V3;
  hi: V3;
}

/** A box piece's oriented box and its world bounds (null for other shapes). */
export function boxOf(p: Piece): Box | null {
  if (p.shape.kind !== 'box') return null;
  const { x, y, z, w } = p.rot;
  const m = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
  const h = { x: p.shape.hx, y: p.shape.hy, z: p.shape.hz };
  // World-space bounds from the rotated half sizes.
  const ex = Math.abs(m[0]) * h.x + Math.abs(m[1]) * h.y + Math.abs(m[2]) * h.z;
  const ey = Math.abs(m[3]) * h.x + Math.abs(m[4]) * h.y + Math.abs(m[5]) * h.z;
  const ez = Math.abs(m[6]) * h.x + Math.abs(m[7]) * h.y + Math.abs(m[8]) * h.z;
  return { c: p.pos, m, h, lo: { x: p.pos.x - ex, y: p.pos.y - ey, z: p.pos.z - ez }, hi: { x: p.pos.x + ex, y: p.pos.y + ey, z: p.pos.z + ez } };
}

export function inBox(b: Box, x: number, y: number, z: number) {
  const dx = x - b.c.x;
  const dy = y - b.c.y;
  const dz = z - b.c.z;
  // Into the box's frame (the rotation's transpose).
  return Math.abs(b.m[0] * dx + b.m[3] * dy + b.m[6] * dz) <= b.h.x && Math.abs(b.m[1] * dx + b.m[4] * dy + b.m[7] * dz) <= b.h.y && Math.abs(b.m[2] * dx + b.m[5] * dy + b.m[8] * dz) <= b.h.z;
}

/** Inside a turn's solid parts: its floor slab, or its inner or outer wall. */
function inTurn(t: TurnSpec, x: number, y: number, z: number) {
  const r = Math.hypot(x - t.c.x, z - t.c.z);
  const rIn = RT - W / 2;
  const rOut = RT + W / 2;
  if (r < rIn - T || r > rOut + T) return false;
  const a = Math.atan2(z - t.c.z, x - t.c.x);
  const span = t.a1 - t.a0;
  // Every winding of the turn that passes this angle.
  for (let k = -3; k <= 3; k++) {
    const u = (a + k * 2 * Math.PI - t.a0) / span;
    if (u < 0 || u > 1) continue;
    const fy = t.y0 + (t.y1 - t.y0) * u;
    if (y >= fy - T && y <= fy + 0.003) return true;
    if (r <= rIn + 0.001 && y >= fy && y <= fy + WALL_H) return true;
    if (r >= rOut - 0.001 && y >= fy && y <= fy + OUTER_H) return true;
  }
  return false;
}

/** Inside a funnel's shell: its bowl, rim wall or spout. */
function inFunnel(f: FunnelSpec, x: number, y: number, z: number) {
  const r = Math.hypot(x - f.c.x, z - f.c.z);
  if (r > f.rTop + T) return false;
  if (r >= f.rTop - 0.001) return y >= f.c.y - T && y <= f.c.y + WALL_H;
  if (r <= f.rHole + T) return y >= f.c.y - f.depth - f.spout && y <= f.c.y - f.depth;
  const u = (r - f.rHole) / (f.rTop - f.rHole);
  const sy = f.c.y - f.depth * (1 - u) ** 1.8;
  return y >= sy - T && y <= sy + 0.003;
}

export interface Occluders {
  boxes: Box[];
  turns: TurnSpec[];
  funnels: FunnelSpec[];
}

/** The solid track built so far: floors and pads (not glass walls, nor the slender pegs). */
export function occluders(statics: Piece[], turns: TurnSpec[], funnels: FunnelSpec[]): Occluders {
  const boxes: Box[] = [];
  for (const p of statics) {
    if (p.finish === 'glass' || p.finish === 'steel') continue;
    const b = boxOf(p);
    if (b) boxes.push(b);
  }
  return { boxes, turns, funnels };
}

/**
 * The share of a lane (from → to, floor heights, running along x at constant z) hidden from the
 * camera by solid track.
 */
export function hiddenShare(o: Occluders, from: V3, to: V3): number {
  const dy = Math.sin(VIEW_TILT);
  const dz = Math.cos(VIEW_TILT);
  const run = Math.abs(to.x - from.x);
  let total = 0;
  let hidden = 0;
  for (let d = 0.03; d <= run - 0.03; d += 0.02) {
    const u = d / run;
    const x = from.x + (to.x - from.x) * u;
    const fy = from.y + (to.y - from.y) * u;
    for (const off of [-W / 4, 0, W / 4]) {
      const p = { x, y: fy + R, z: from.z + off };
      // Only what the sight line could reach.
      const lo = { y: p.y, z: p.z };
      const hi = { y: p.y + RAY_LEN * dy, z: p.z + RAY_LEN * dz };
      const boxes = o.boxes.filter((b) => b.lo.x <= x && b.hi.x >= x && b.hi.y >= lo.y && b.lo.y <= hi.y && b.hi.z >= lo.z && b.lo.z <= hi.z);
      const turns = o.turns.filter((t) => Math.abs(t.c.x - x) <= RT + W && t.c.z + RT + W >= lo.z && Math.min(t.y0, t.y1) - T <= hi.y && Math.max(t.y0, t.y1) + OUTER_H >= lo.y);
      const funnels = o.funnels.filter((f) => Math.abs(f.c.x - x) <= f.rTop + T && f.c.z + f.rTop >= lo.z && f.c.y + WALL_H >= lo.y && f.c.y - f.depth - f.spout <= hi.y);
      total++;
      if (!boxes.length && !turns.length && !funnels.length) continue;
      for (let t = R + 0.004; t <= RAY_LEN; t += STEP) {
        const y = p.y + t * dy;
        const z = p.z + t * dz;
        if (boxes.some((b) => inBox(b, x, y, z)) || turns.some((tr) => inTurn(tr, x, y, z)) || funnels.some((f) => inFunnel(f, x, y, z))) {
          hidden++;
          break;
        }
      }
    }
  }
  return total ? hidden / total : 0;
}
