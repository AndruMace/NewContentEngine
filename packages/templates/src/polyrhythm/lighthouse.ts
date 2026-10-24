/**
 * Lighthouse styles, sim side: the layout and the beat maths (drawing is in lighthouse3d and coast3d).
 *
 * Ships: one lighthouse, its beam turning clockwise B times per loop, and a ship per element sailing
 * round it anticlockwise k times per loop in its own lane. Going opposite ways they meet B + k times
 * per loop, so a ship ringing r times per loop (its pattern rate) sails k = r − B laps: the faster the
 * ship, the more often the beam finds it. Every ship starts in the beam (the sync), strung out across
 * the bay, and is back there at the end.
 *
 * Coast: a few lighthouses on headlands along a bay, every beam sweeping one ship anchored in the
 * middle. Each lighthouse turns its pattern rate and has its own flash code, a group of 1–3 beams close
 * together (real lighthouses are told apart by their codes); every flash rings as it crosses the ship,
 * and all the leading flashes cross it together at the start.
 *
 * Plan view: x to the right, z toward the camera; angles count anticlockwise seen from above, from +x
 * (so a point at angle a sits at (cos a, −sin a)).
 */
import * as dm from '@sim/physics/math';

/** Ships that read on screen (the count slider's maximum is clamped to it). */
export const MAX_SHIPS = 16;
/** Lane radii, innermost and outermost. */
export const LANE_IN = 0.85;
export const LANE_OUT = 2.3;

/**
 * The beam's turns per loop and each ship's laps for ships ringing `rates` times per loop. The beam
 * turns as fast as it can while every ship still sails forward (a ship ringing once per loop when the
 * beam turns once rides at anchor).
 */
export function shipLaps(rates: number[]): { beamTurns: number; laps: number[] } {
  const beamTurns = Math.max(1, Math.min(...rates) - 1);
  return { beamTurns, laps: rates.map((r) => r - beamTurns) };
}

/**
 * How the scene grows with the ship circle's size setting: the outer lane by the full amount, the
 * island (and so the inner lane), the tower and the ships by its square root, so the lanes spread
 * further apart while everything stays readable once the camera pulls back to fit.
 */
export const islandScale = (spread: number) => Math.sqrt(spread);
export const outerLane = (spread: number) => LANE_OUT * spread;

/** Each ship's lane radius: the fastest innermost, the slowest outermost. */
export function shipLanes(laps: number[], spread = 1): number[] {
  const n = laps.length;
  const inner = LANE_IN * islandScale(spread);
  const outer = outerLane(spread);
  const order = laps.map((_, i) => i).sort((a, b) => laps[b] - laps[a] || a - b);
  const r: number[] = new Array(n);
  order.forEach((i, rank) => (r[i] = n > 1 ? inner + ((outer - inner) * rank) / (n - 1) : (inner + outer) / 2));
  return r;
}

/** The beam's angle at loop fraction u (clockwise, from +x). */
export const beamAngle = (beamTurns: number, u: number) => -2 * Math.PI * beamTurns * u;
/** A ship's angle round the lighthouse at loop fraction u (anticlockwise, from +x). */
export const shipAngle = (laps: number, u: number) => 2 * Math.PI * laps * u;

/** Stereo position of ship i's k-th note: where the beam finds it. */
export function shipPan(beamTurns: number, rate: number, lane: number, k: number, spread = 1): number {
  return (lane / outerLane(spread)) * dm.cos(beamAngle(beamTurns, k / rate));
}

/** Lighthouses along the coast (the count slider maps onto 3–6). */
export const MIN_COAST = 3;
export const MAX_COAST = 6;
export const coastCount = (count: number) => Math.max(MIN_COAST, Math.min(MAX_COAST, Math.round(count / 5)));

/** The camera's place in plan (it looks out over the bay toward −z) and the anchored ship's. */
export const COAST_CAM = { x: 0, y: 3.3, z: 6 };
export const COAST_SHIP = { x: 0, z: -4.6 };
/** Half the camera's horizontal view, as a slope (x per unit of distance). */
export const VIEW_SLOPE = 0.235;

/**
 * Where lighthouse i (of n) stands on the coast: alternately on the left and right arms of the bay,
 * nearest first, receding into the distance. `edge` is the arm's shoreline there (the tower stands just
 * inland of the headland's tip).
 */
export function coastSpot(i: number, n: number): { x: number; z: number; side: number } {
  const side = i % 2 ? 1 : -1;
  const f = n > 1 ? i / (n - 1) : 0;
  const z = -1.2 - 15 * f ** 1.15;
  // A steady share of the view across, so near and far lights spread over the frame alike.
  const x = side * (0.68 - 0.1 * f) * VIEW_SLOPE * (COAST_CAM.z - z);
  return { x, z, side };
}

/** Stereo position of lighthouse i: where it stands across the view. */
export function coastPan(i: number, n: number): number {
  const { x, z } = coastSpot(i, n);
  return x / (VIEW_SLOPE * (COAST_CAM.z - z));
}

/** Flash codes for n lighthouses: groups of 1, 2 and 3 flashes, dealt round (shuffled by the caller). */
export const flashCodes = (n: number) => Array.from({ length: n }, (_, i) => 1 + (i % 3));

/** Seconds between the flashes of a group, at most. */
const GROUP_GAP_S = 0.28;

/**
 * Where in the loop (fractions, ascending, from 0) a lighthouse turning `turns` times with `code`
 * flashes per group crosses the ship: each turn's group, its flashes a fixed time apart.
 */
export function coastNoteU(turns: number, code: number, loopS: number): number[] {
  const gap = groupGapU(turns, code, loopS);
  const out: number[] = [];
  for (let m = 0; m < turns; m++) for (let j = 0; j < code; j++) out.push(m / turns + j * gap);
  return out;
}

/** The loop fraction between a group's flashes (kept well inside a turn for fast lights). */
export const groupGapU = (turns: number, code: number, loopS: number) => Math.min(GROUP_GAP_S / loopS, 0.55 / (turns * code));
