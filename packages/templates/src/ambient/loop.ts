/**
 * Time helpers for long-form loops. Everything that moves must repeat exactly over the loop length L,
 * so the last frame flows into the first.
 */
import { log } from '@sim/physics/math';
import type { Rng } from '@sim/engine';

/** t modulo L, always in [0, L). */
export const wrap = (t: number, L: number) => ((t % L) + L) % L;

/** A frequency rounded to a whole number of cycles per loop (at least one). */
export const perLoop = (hz: number, L: number) => Math.max(1, Math.round(hz * L)) / L;

/** sin at roughly `hz`, adjusted to repeat exactly over the loop. */
export const loopSin = (t: number, L: number, hz: number, phase = 0) => Math.sin(2 * Math.PI * perLoop(hz, L) * t + phase);

/**
 * A point on a circle in noise space, one lap per loop, travelling `speed` noise units per second:
 * feed (x, y) to 3D/4D noise as extra coordinates and the noise animates and loops.
 */
export function timeCircle(t: number, L: number, speed: number): [number, number] {
  const R = (speed * L) / (2 * Math.PI);
  const a = (2 * Math.PI * t) / L;
  return [R * Math.cos(a), R * Math.sin(a)];
}

/** Slow periodic camera sway (radians or units), a few long cycles per loop. */
export const drift = (t: number, L: number, amount: number, seed = 0) =>
  amount * (0.6 * loopSin(t, L, 1 / 47, seed) + 0.4 * loopSin(t, L, 1 / 83, seed * 2.3 + 1));

/**
 * Times of random events in [0, L): Poisson arrivals at `perSecond`, at least `minGap` apart, also
 * across the loop's wrap (last → first + L). Uses the deterministic log (cue times are sim events).
 */
export function scheduleTimes(rng: Rng, L: number, perSecond: number, minGap = 0): number[] {
  if (perSecond <= 0) return [];
  const out: number[] = [];
  const gap = () => minGap - log(1 - rng.next()) / perSecond;
  for (let t = rng.range(0, 1 / perSecond); t < L - minGap; t += gap()) out.push(t);
  return out;
}
