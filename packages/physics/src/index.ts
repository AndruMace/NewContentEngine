/** Small, allocation-light 2D helpers shared by the templates. */
import { exp, hypot } from './math';

export * from './math';

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

export const TAU = Math.PI * 2;


/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function speed(b: Ball): number {
  return hypot(b.vx, b.vy);
}

export function clampSpeed(b: Ball, max: number) {
  const s = speed(b);
  if (s > max) {
    b.vx *= max / s;
    b.vy *= max / s;
  }
}

export function scaleSpeed(b: Ball, k: number) {
  b.vx *= k;
  b.vy *= k;
}

/**
 * Reflect the ball's velocity off a surface with unit normal (nx, ny) pointing
 * back towards the ball's allowed region. Returns the pre-impact normal speed (>= 0).
 * `minOut` guarantees a minimum bounce speed so the sim never settles.
 */
export function reflect(b: Ball, nx: number, ny: number, restitution: number, minOut = 0): number {
  const vn = b.vx * nx + b.vy * ny;
  if (vn >= 0) return 0;
  const out = Math.max(-vn * restitution, minOut);
  b.vx += (out - vn) * nx;
  b.vy += (out - vn) * ny;
  return -vn;
}

/**
 * Ball inside a circular wall of radius R centred at (cx, cy).
 * Returns impact speed if a collision was resolved, else 0.
 */
export function collideInsideCircle(b: Ball, cx: number, cy: number, R: number, restitution: number, minOut = 0): number {
  const dx = b.x - cx;
  const dy = b.y - cy;
  const d = hypot(dx, dy);
  if (d + b.r <= R || d === 0) return 0;
  const nx = -dx / d;
  const ny = -dy / d;
  b.x = cx - nx * (R - b.r);
  b.y = cy - ny * (R - b.r);
  return reflect(b, nx, ny, restitution, minOut);
}

/** Ball against a static disc/point (px, py) of radius pr. Returns impact speed or 0. */
export function collideWithDisc(b: Ball, px: number, py: number, pr: number, restitution: number, minOut = 0): number {
  const dx = b.x - px;
  const dy = b.y - py;
  const d = hypot(dx, dy);
  const min = b.r + pr;
  if (d >= min || d === 0) return 0;
  const nx = dx / d;
  const ny = dy / d;
  b.x = px + nx * min;
  b.y = py + ny * min;
  return reflect(b, nx, ny, restitution, minOut);
}

/** Exponential smoothing factor helper for frame-rate independent decay. */
export function decay(rate: number, dt: number): number {
  return exp(-rate * dt);
}

export * from './world';
