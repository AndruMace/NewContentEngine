import type { Ctx2D } from '@sim/engine';
import { TAU, collideInsideCircle, reflect, type Ball } from '@sim/physics';
import * as dm from '@sim/physics/math';

export type ArenaShape = 'circle' | 'square' | 'hexagon' | 'triangle';

/**
 * Regular polygons by edge count, the angle of the first edge's midpoint (screen angles, y down),
 * circumradius per unit arena radius (sized so the outline and progress arc stay inside a 1080 px
 * frame), how far to drop the centre (per unit circumradius) so the outline sits centred, and a
 * growth multiplier tuned so a run takes about as long as in a circle with the same settings.
 */
const POLYGONS: Record<Exclude<ArenaShape, 'circle'>, { sides: number; firstMid: number; circum: number; drop: number; pace: number }> = {
  square: { sides: 4, firstMid: 0, circum: 0.92 * Math.SQRT2, drop: 0, pace: 1.02 }, // flat top and floor
  hexagon: { sides: 6, firstMid: 0, circum: 1.1, drop: 0, pace: 0.73 }, // point at the top and bottom
  triangle: { sides: 3, firstMid: TAU / 4, circum: 1.15, drop: 0.25, pace: 0.26 }, // point at the top, flat floor
};

export interface Arena {
  shape: ArenaShape;
  cx: number;
  cy: number;
  /** Inradius: the largest ball that fits. */
  inR: number;
  /** Multiplier on growth per bounce (1 for a circle; see POLYGONS). */
  pace: number;
  /**
   * Balls are the arena's shape in the same orientation, sized by inradius r. A ball reaches r
   * along each edge normal and back·r the opposite way (further for a triangle, whose far side is a
   * corner), and circum·r to its corners.
   */
  back: number;
  circum: number;
  /** Outward unit normals of the edges (empty for a circle). */
  ux: number[];
  uy: number[];
}

export function makeArena(shape: ArenaShape, radius: number, cx: number, cy: number): Arena {
  if (shape === 'circle') return { shape, cx, cy, inR: radius, pace: 1, back: 1, circum: 1, ux: [], uy: [] };
  const def = POLYGONS[shape];
  const circum = radius * def.circum;
  const cosHalf = dm.cos(Math.PI / def.sides);
  const inR = circum * cosHalf;
  const ux: number[] = [];
  const uy: number[] = [];
  for (let k = 0; k < def.sides; k++) {
    const a = def.firstMid + (k * TAU) / def.sides;
    ux.push(dm.cos(a));
    uy.push(dm.sin(a));
  }
  return { shape, cx, cy: cy + circum * def.drop, inR, pace: def.pace, back: def.sides % 2 ? 1 / cosHalf : 1, circum: 1 / cosHalf, ux, uy };
}

/**
 * Keep a ball inside the arena. Returns the impact speed if it hit a wall, else 0. A ball the
 * arena's shape meets each wall with its matching face, so the circle test against each edge is exact.
 */
export function collideArena(a: Arena, b: Ball, minOut: number): number {
  if (a.shape === 'circle') return collideInsideCircle(b, a.cx, a.cy, a.inR, 1, minOut);
  let impact = 0;
  for (let k = 0; k < a.ux.length; k++) {
    const gap = a.inR - ((b.x - a.cx) * a.ux[k] + (b.y - a.cy) * a.uy[k]);
    if (gap >= b.r) continue;
    b.x -= a.ux[k] * (b.r - gap);
    b.y -= a.uy[k] * (b.r - gap);
    impact = Math.max(impact, reflect(b, -a.ux[k], -a.uy[k], 1, minOut));
  }
  return impact;
}

/** Move a ball back inside the arena without touching its velocity. */
export function clampInside(a: Arena, b: Ball) {
  if (a.shape === 'circle') {
    const dx = b.x - a.cx;
    const dy = b.y - a.cy;
    const d = dm.hypot(dx, dy);
    if (d + b.r <= a.inR || d === 0) return;
    b.x = a.cx + (dx / d) * (a.inR - b.r);
    b.y = a.cy + (dy / d) * (a.inR - b.r);
    return;
  }
  for (let k = 0; k < a.ux.length; k++) {
    const gap = a.inR - ((b.x - a.cx) * a.ux[k] + (b.y - a.cy) * a.uy[k]);
    if (gap >= b.r) continue;
    b.x -= a.ux[k] * (b.r - gap);
    b.y -= a.uy[k] * (b.r - gap);
  }
}

/**
 * Penetration depth of two balls (0 if apart), with the unit normal from p to q written to `out`.
 * Polygon balls share the arena's orientation, so the separating axes are its edge normals.
 */
export function bodyContact(a: Arena, p: Ball, q: Ball, out: { nx: number; ny: number }): number {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  if (a.shape === 'circle') {
    const d = dm.hypot(dx, dy);
    const depth = p.r + q.r - d;
    if (depth <= 0) return 0;
    out.nx = d > 1e-9 ? dx / d : 1;
    out.ny = d > 1e-9 ? dy / d : 0;
    return depth;
  }
  let best = Infinity;
  for (let k = 0; k < a.ux.length; k++) {
    const along = dx * a.ux[k] + dy * a.uy[k];
    // Overlap if q were pushed out along +u, or along -u.
    const fwd = p.r + q.r * a.back - along;
    const bwd = p.r * a.back + q.r + along;
    const depth = Math.min(fwd, bwd);
    if (depth <= 0) return 0;
    if (depth < best) {
      best = depth;
      const sign = fwd <= bwd ? 1 : -1;
      out.nx = sign * a.ux[k];
      out.ny = sign * a.uy[k];
    }
  }
  return best;
}

/** Trace the arena outline grown outward by `off` px as a new path (see traceShape). Returns its length. */
export const traceOutline = (ctx: Ctx2D, a: Arena, off: number) => traceShape(ctx, a, a.cx, a.cy, a.inR + off);

/**
 * Trace the arena's shape with inradius r centred on (x, y) as a new path, starting at the top centre
 * and running clockwise (so a dashed stroke reads as a progress bar). Returns the path's length.
 */
export function traceShape(ctx: Ctx2D, a: Arena, x: number, y: number, r: number): number {
  ctx.beginPath();
  if (a.shape === 'circle') {
    ctx.arc(x, y, r, -TAU / 4, (3 * TAU) / 4);
    return TAU * r;
  }
  const n = a.ux.length;
  const half = Math.PI / n;
  const mids = a.ux.map((ux, k) => Math.atan2(a.uy[k], ux));
  const top = -TAU / 4;
  // The edge the top centre lies on, and where on it.
  const edge = mids.findIndex((m) => Math.abs(wrap(top - m)) <= half + 1e-9);
  const d = r / Math.cos(wrap(top - mids[edge]));
  ctx.moveTo(x + d * Math.cos(top), y + d * Math.sin(top));
  const corner = r / Math.cos(half);
  // Every corner, clockwise from the end of that edge (one may coincide with the start: harmless).
  for (let k = 0; k < n; k++) {
    const m = mids[(edge + k) % n] + half;
    ctx.lineTo(x + corner * Math.cos(m), y + corner * Math.sin(m));
  }
  ctx.closePath();
  return 2 * n * r * Math.tan(half);
}

const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));

/** How many pieces a crowd of this shape has, and the size each grows to (none for a circle). */
export interface CrowdFit {
  count: number;
  /** Inradius of a piece in the neatest packing. */
  r: number;
}

/**
 * Pieces at half the arena's size: 4 squares tile it exactly (2×2); same-orientation triangles and
 * hexagons can't tile a bigger copy of themselves, and 3 is their best fit (corner triangles, or
 * three hexagons meeting at a point), filling 75%. Bouncing reliably finds all three packings.
 */
export function crowdFit(a: Arena): CrowdFit | null {
  if (a.shape === 'circle') return null;
  return { count: a.shape === 'square' ? 4 : 3, r: a.inR / 2 };
}
