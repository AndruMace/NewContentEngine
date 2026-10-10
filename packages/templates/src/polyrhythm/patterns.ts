import type { Rng } from '@sim/engine';

export const PATTERNS = ['linear', 'harmonic', 'primes', 'mirror', 'random'] as const;
export type Pattern = (typeof PATTERNS)[number];

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139];

/**
 * Whole-number rates (cycles per loop) for each element, in element order. Whole numbers are what
 * make every pattern loop seamlessly: each element is back where it started at the end.
 *
 * - linear: base, base+step, base+2·step… (the classic even spread)
 * - harmonic: multiples of one unit, like overtones (1, 2, 3… × unit)
 * - primes: consecutive primes from about base/3 (no two share a factor: few partial lineups,
 *   one big one at the end)
 * - mirror: slowest in the middle, speeding up toward both edges in matching pairs (symmetric twins)
 * - random: distinct seeded rates in a band above base, slowest first
 */
export function patternRates(pattern: Pattern, n: number, base: number, step: number, rng: Rng): number[] {
  switch (pattern) {
    case 'linear':
      return Array.from({ length: n }, (_, i) => base + i * step);
    case 'harmonic': {
      const unit = Math.max(1, Math.round(base / 4)) * step;
      return Array.from({ length: n }, (_, i) => unit * (i + 1));
    }
    case 'primes': {
      const from = Math.max(0, PRIMES.findIndex((p) => p >= Math.max(2, Math.round(base / 3))));
      return Array.from({ length: n }, (_, i) => PRIMES[Math.min(PRIMES.length - 1, from + i)] ?? base + i);
    }
    case 'mirror': {
      const mid = (n - 1) / 2;
      return Array.from({ length: n }, (_, i) => base + Math.ceil(Math.abs(i - mid) - 1e-9) * step);
    }
    case 'random': {
      const pool = Array.from({ length: Math.max(n, 2 * n * step) }, (_, k) => base + k);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, n).sort((a, b) => a - b);
    }
  }
}

/** Side counts for nested polygons (3 = triangle…), from the same patterns, innermost first. */
export function polygonSides(pattern: Pattern, n: number, step: number, rng: Rng): number[] {
  switch (pattern) {
    case 'harmonic':
      return Array.from({ length: n }, (_, i) => 3 * (i + 1));
    case 'primes':
      return PRIMES.filter((p) => p >= 3).slice(0, n);
    case 'random': {
      const pool = Array.from({ length: 12 }, (_, k) => 3 + k);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, n).sort((a, b) => a - b);
    }
    default:
      return Array.from({ length: n }, (_, i) => 3 + i * step);
  }
}
