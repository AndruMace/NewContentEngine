/**
 * Two blocks and a wall, 1D, perfectly elastic. Solved event by event (no timestep error): the
 * total number of collisions is ⌊π·10^(d−1)⌋ when the big block is 100^(d−1) times heavier.
 *
 * Only + − × ÷ are used, which are exact IEEE operations, so Node and Chrome agree bit for bit.
 * The wall is at x = 0; positions are left edges.
 */
export interface Blocks {
  /** Small block: left edge, width, velocity, mass. */
  x1: number;
  w1: number;
  v1: number;
  m1: number;
  /** Big block. */
  x2: number;
  v2: number;
  m2: number;
  count: number;
}

export interface StepResult {
  /** Collisions this step. */
  n: number;
  /** Of which against the wall. */
  wall: number;
  /** True once no further collision can happen. */
  done: boolean;
}

/** No collision can ever happen again: both moving away from the wall, small one no faster. */
export const finished = (b: Blocks) => b.v1 >= 0 && b.v1 <= b.v2;

/**
 * Advance by `dt`, resolving every collision inside it in order. `onHit` (optional) sees the
 * state after each collision and the time since the start of this call.
 */
export function advance(b: Blocks, dt: number, onHit?: (b: Blocks, wall: boolean, at: number) => void): StepResult {
  let left = dt;
  let at = 0;
  let n = 0;
  let wall = 0;
  for (;;) {
    const tWall = b.v1 < 0 ? b.x1 / -b.v1 : Infinity;
    const tHit = b.v1 > b.v2 ? Math.max(0, b.x2 - (b.x1 + b.w1)) / (b.v1 - b.v2) : Infinity;
    const tNext = Math.min(tWall, tHit);
    if (tNext > left) {
      b.x1 += b.v1 * left;
      b.x2 += b.v2 * left;
      break;
    }
    b.x1 += b.v1 * tNext;
    b.x2 += b.v2 * tNext;
    left -= tNext;
    at += tNext;
    if (tWall <= tHit) {
      b.x1 = 0;
      b.v1 = -b.v1;
      wall++;
    } else {
      const M = b.m1 + b.m2;
      const u1 = ((b.m1 - b.m2) * b.v1 + 2 * b.m2 * b.v2) / M;
      const u2 = ((b.m2 - b.m1) * b.v2 + 2 * b.m1 * b.v1) / M;
      b.v1 = u1;
      b.v2 = u2;
      b.x1 = b.x2 - b.w1;
    }
    n++;
    b.count++;
    onHit?.(b, tWall <= tHit, at);
    if (finished(b)) {
      b.x1 += b.v1 * left;
      b.x2 += b.v2 * left;
      break;
    }
  }
  return { n, wall, done: finished(b) };
}

export function makeBlocks(ratio: number, opts: { x1: number; w1: number; x2: number; v: number }): Blocks {
  return { x1: opts.x1, w1: opts.w1, v1: 0, m1: 1, x2: opts.x2, v2: -opts.v, m2: ratio, count: 0 };
}

/** Run a whole round instantly and return the total collision count. */
export function countCollisions(ratio: number): number {
  const b = makeBlocks(ratio, { x1: 300, w1: 70, x2: 500, v: 250 });
  advance(b, Infinity);
  return b.count;
}
