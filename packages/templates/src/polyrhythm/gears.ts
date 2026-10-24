/**
 * Gear Sync: a compound gear train, laid out like a clock movement. Every arbor (axle) carries up to
 * three wheels, one per layer (front, middle, back); wheels mesh with wheels in their own layer, and
 * all the wheels on an arbor turn together. Meshing wheels pass teeth at the same rate, so an
 * arbor driven through a z_p : z_c pair turns z_p / z_c times as fast as the one driving it, and
 * stacking pairs on shared arbors (compound gears) reaches almost any ratio with sensible tooth
 * counts, which is how real clocks get exact 12 : 1 and 60 : 1.
 *
 * Each ringing arbor turns exactly its element's whole number of times per loop (the speed pattern,
 * as in every other style) and wears a hand on its front wheel that starts pointing straight up; it
 * rings every time the hand comes back up. When no direct pair of tooth counts reaches a rate, an
 * in-between arbor (no hand, it only carries the drive) is added.
 *
 * Layout runs in the sim (positions set the stereo placement), so it uses the deterministic maths and
 * exact whole-number ratios. Units: module 1, so a wheel's pitch radius is z / 2.
 */
import type { Rng } from '@sim/engine';
import * as dm from '@sim/physics/math';

/** Most ringing gears in a train (the count slider's maximum). */
export const MAX_GEARS = 32;
/** Tooth counts allowed: down to clock pinions (6 leaves), up to a big wheel. */
export const Z_MIN = 6;
export const Z_MAX = 72;
/** Tooth height above the pitch circle (one module). */
export const ADDENDUM = 1;
/** Gap kept between wheels in the same layer that don't mesh. */
const CLEARANCE = 1;
/** Room kept round an arbor (no wheel of another arbor may cover it). */
export const HUB = 1;
/** The shape the train is packed into (width : height): the space under the overlays (see gears3d). */
const FIT_W = 3.74;
const FIT_H = 4.94;
/** The slowest arbor's front wheel. */
const ROOT_Z = 60;
const ANGLES = 24;
/** Orientations tried for the finished train (over half a turn). */
const TURNS = 36;
/** How widely an in-between arbor's placement is searched: the parents nearest the rate, and wheel combinations per layer pair. */
const IDLER_PARENTS = 12;
const IDLER_COMBOS = 6;

/** Wheel layers, front (where the hands are) to back. */
export const LAYERS = [0, 1, 2] as const;
export type Layer = (typeof LAYERS)[number];

export interface Wheel {
  z: number;
  /** 0 = front (where the hands are), then further back. */
  layer: Layer;
  /** Angle of tooth 0 at the start. */
  theta0: number;
}

export interface Arbor {
  /** Centre (layout units, the train centred on the origin). */
  x: number;
  y: number;
  /** Turns per loop as a fraction (den is 1 for every ringing arbor). */
  num: number;
  den: number;
  /** +1 turns anticlockwise (with y up), −1 clockwise. */
  dir: number;
  /** The element it rings for, or −1 for an in-between arbor that only carries the drive. */
  element: number;
  /** At most one per layer. */
  wheels: Wheel[];
  /** The arbor it's driven from (−1 for the first), and the layer of that mesh. */
  parent: number;
  meshLayer: Layer;
}

const frac = (x: number) => x - Math.floor(x);
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
const wheelIn = (a: { wheels: Wheel[] }, layer: number) => a.wheels.find((w) => w.layer === layer);

/** Angle of a wheel's tooth 0 at loop fraction u. */
export const wheelAngle = (a: Arbor, w: Wheel, u: number) => w.theta0 + a.dir * 2 * Math.PI * (a.num / a.den) * u;
/** Angle the arbor itself has turned through at loop fraction u. */
export const arborAngle = (a: Arbor, u: number) => a.dir * 2 * Math.PI * (a.num / a.den) * u;

/**
 * Tooth phase for a wheel meshing with `pw` (on `pa`) at contact direction `phi` (from pa to it):
 * where they touch, a tooth of one faces a gap of the other.
 */
function meshPhase(pw: Wheel, phi: number, z: number): number {
  const fP = frac((phi - pw.theta0) / ((2 * Math.PI) / pw.z));
  return phi + Math.PI - ((2 * Math.PI) / z) * frac(0.5 - fP);
}

interface Proto {
  x: number;
  y: number;
  wheels: { z: number; layer: Layer }[];
}

/**
 * Whether a new arbor at (x, y) with these wheels fits among the placed ones: wheels in the same
 * layer stay clear of each other (except the meshing pair), and no wheel covers another arbor. `extra`
 * is a wheel about to be added to arbor `mesh.arbor` for this mesh.
 */
function fits(arbors: Arbor[], n: Proto, mesh: { arbor: number; layer: number } | null, extra: Wheel | null): boolean {
  for (let ai = 0; ai < arbors.length; ai++) {
    const a = arbors[ai];
    const d = dm.hypot(a.x - n.x, a.y - n.y);
    const ws = extra && mesh && ai === mesh.arbor ? [...a.wheels, extra] : a.wheels;
    for (const w of ws) {
      const isMesh = !!mesh && ai === mesh.arbor && w.layer === mesh.layer;
      if (!isMesh && d < w.z / 2 + ADDENDUM + HUB) return false;
      for (const nw of n.wheels) {
        if (nw.layer !== w.layer || (isMesh && nw.layer === mesh!.layer)) continue;
        if (d < w.z / 2 + nw.z / 2 + 2 * ADDENDUM + CLEARANCE) return false;
      }
    }
    for (const nw of n.wheels) {
      const isMesh = !!mesh && ai === mesh.arbor && nw.layer === mesh.layer;
      if (!isMesh && d < nw.z / 2 + ADDENDUM + HUB) return false;
    }
  }
  return true;
}

/** Whether a new wheel on arbor `ai` fits among the other arbors. */
function wheelFits(arbors: Arbor[], ai: number, w: { z: number; layer: number }): boolean {
  const a = arbors[ai];
  for (let bi = 0; bi < arbors.length; bi++) {
    if (bi === ai) continue;
    const b = arbors[bi];
    const d = dm.hypot(a.x - b.x, a.y - b.y);
    if (d < w.z / 2 + ADDENDUM + HUB) return false;
    const bw = wheelIn(b, w.layer);
    if (bw && d < w.z / 2 + bw.z / 2 + 2 * ADDENDUM + CLEARANCE) {
      // Unless they already mesh (b driven from a, or a from b, in this layer).
      const meshed = (b.parent === ai || a.parent === bi) && (b.parent === ai ? b.meshLayer : a.meshLayer) === w.layer;
      if (!meshed) return false;
    }
  }
  return true;
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
const outer = (wheels: { z: number }[]) => Math.max(...wheels.map((w) => w.z / 2 + ADDENDUM));
const grow = (b: Box, x: number, y: number, r: number): Box => ({ x0: Math.min(b.x0, x - r), x1: Math.max(b.x1, x + r), y0: Math.min(b.y0, y - r), y1: Math.max(b.y1, y + r) });
const fitScore = (b: Box) => Math.max((b.x1 - b.x0) / FIT_W, (b.y1 - b.y0) / FIT_H);

/** Pairs (z_parent, z_child) giving child/parent turn ratio num/den, best-sized first, at most `max`. */
function pairs(num: number, den: number, max: number): [number, number][] {
  // child turns = parent turns × zp / zc, so zp / zc = num / den.
  const g = gcd(num, den);
  const p = num / g;
  const c = den / g;
  const out: [number, number][] = [];
  for (let k = 1; k * Math.max(p, c) <= Z_MAX; k++) if (k * Math.min(p, c) >= Z_MIN) out.push([k * p, k * c]);
  // Prefer mid-sized wheels (around 30 teeth).
  return out.sort((a, b) => Math.abs(Math.log((a[0] + a[1]) / 60)) - Math.abs(Math.log((b[0] + b[1]) / 60))).slice(0, max);
}

/** Front-wheel sizes tried for a ringing arbor driven from behind (big enough to carry a hand). */
const FRONT_SIZES = [36, 24, 15];

/** Largest prime factor of a whole number. */
function largestPrime(x: number): number {
  let big = 1;
  for (let p = 2; p * p <= x; p++)
    while (x % p === 0) {
      big = p;
      x /= p;
    }
  return x > 1 ? Math.max(big, x) : big;
}

/**
 * Speeds a clock train can reach. Every pair of wheels multiplies an arbor's speed by a ratio of tooth
 * counts, so with at most Z_MAX teeth no train can create a prime factor above Z_MAX (a gear turning
 * 79 or 139 times per loop would need a wheel with that many teeth). Such speeds are nudged to the
 * nearest reachable one not already in use (79 → 80, 83 → 84); everything else is left alone.
 */
export function reachableRates(rates: number[]): number[] {
  const ok = (r: number) => r >= 1 && largestPrime(r) <= Z_MAX;
  const used = new Set(rates.filter(ok));
  return rates.map((r) => {
    if (ok(r)) return r;
    for (let d = 1; ; d++)
      for (const c of [r + d, r - d])
        if (ok(c) && !used.has(c)) {
          used.add(c);
          return c;
        }
  });
}

/**
 * Build the train for elements turning `rates[i]` whole times per loop. Returns the arbors, and the
 * elements that couldn't be fitted (normally none).
 */
export function buildGearTrain(rates: number[], rng: Rng): { arbors: Arbor[]; dropped: number[] } {
  // A tightly packed train occasionally has no room left for a gear; another start usually does.
  let best = layOut(rates, rng);
  for (let k = 1; best.dropped.length && k <= 2; k++) {
    const next = layOut(rates, rng.fork(k));
    if (next.dropped.length < best.dropped.length) best = next;
  }
  return best;
}

function layOut(rates: number[], rng: Rng): { arbors: Arbor[]; dropped: number[] } {
  const arbors: Arbor[] = [];
  const dropped: number[] = [];
  let box: Box = { x0: 0, x1: 0, y0: 0, y1: 0 };
  const order = rates.map((_, i) => i).sort((a, b) => rates[a] - rates[b] || a - b);
  for (const e of order) {
    const R = rates[e];
    if (!arbors.length) {
      arbors.push({ x: 0, y: 0, num: R, den: 1, dir: 1, element: e, wheels: [{ z: ROOT_Z, layer: 0, theta0: rng.range(0, Math.PI * 2) }], parent: -1, meshLayer: 0 });
      box = grow(box, 0, 0, ROOT_Z / 2 + ADDENDUM);
      continue;
    }
    if (attach(arbors, e, R, rng, box)) {
      box = boxOf(arbors);
      continue;
    }
    // The parents nearest its rate first; then, in a crowded train, any parent with room.
    if (attachViaIdler(arbors, e, R, rng, box) || attachViaIdler(arbors, e, R, rng, box, true)) {
      box = boxOf(arbors);
      continue;
    }
    dropped.push(e);
  }
  // Turn the whole train to suit the frame (a wide train stood on end fills a tall frame far better).
  // Turning every arbor and every wheel's teeth together keeps each mesh exact; the hands still start
  // pointing up, as they hang off the arbor, not the teeth.
  let bestTurn = 0;
  let bestFit = Infinity;
  for (let j = 0; j < TURNS; j++) {
    const fit = fitScore(boxOf(arbors, (Math.PI * j) / TURNS));
    if (fit < bestFit - 1e-9) {
      bestFit = fit;
      bestTurn = (Math.PI * j) / TURNS;
    }
  }
  if (bestTurn) {
    const c = dm.cos(bestTurn);
    const sn = dm.sin(bestTurn);
    for (const a of arbors) {
      [a.x, a.y] = [a.x * c - a.y * sn, a.x * sn + a.y * c];
      for (const w of a.wheels) w.theta0 += bestTurn;
    }
  }
  // Centre the train.
  const b = boxOf(arbors);
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  for (const a of arbors) {
    a.x -= cx;
    a.y -= cy;
  }
  return { arbors, dropped };
}

/** The train's bounding box, optionally as if turned by `turn`. */
function boxOf(arbors: Arbor[], turn = 0): Box {
  const c = dm.cos(turn);
  const sn = dm.sin(turn);
  let b: Box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const a of arbors) b = grow(b, a.x * c - a.y * sn, a.x * sn + a.y * c, outer(a.wheels));
  return b;
}

interface Candidate {
  score: number;
  apply: () => void;
}

/** Plan meshing a new arbor (turning num/den) from arbor `pi` in `layer`: the wheel sizes to try. */
function meshOptions(arbors: Arbor[], pi: number, layer: Layer, num: number, den: number, maxPairs: number): { zp: number; zc: number; newWheel: boolean }[] {
  const p = arbors[pi];
  const pw = wheelIn(p, layer);
  // child turns / parent turns = (num/den) / (p.num/p.den) = zp / zc
  const rn = num * p.den;
  const rd = den * p.num;
  if (pw) {
    // zc = zp × rd / rn must be whole and in range.
    if ((pw.z * rd) % rn !== 0) return [];
    const zc = (pw.z * rd) / rn;
    return zc >= Z_MIN && zc <= Z_MAX ? [{ zp: pw.z, zc, newWheel: false }] : [];
  }
  return pairs(rn, rd, maxPairs)
    .filter(([zp]) => wheelFits(arbors, pi, { z: zp, layer }))
    .map(([zp, zc]) => ({ zp, zc, newWheel: true }));
}

/** Directions to try round an arbor (a random start, so seeds differ). */
const angles = (rng: Rng, k = ANGLES) => {
  const turn = rng.range(0, 1);
  return Array.from({ length: k }, (_, j) => 2 * Math.PI * ((j + turn) / k));
};

/** Mesh element e's arbor straight off one already placed. */
function attach(arbors: Arbor[], e: number, R: number, rng: Rng, box: Box): boolean {
  let best: Candidate | null = null;
  // Any arbor can drive it (the ratio decides whether a pair of wheels reaches the rate); crowded ones
  // simply find no room.
  const parents = arbors.map((_, i) => i);
  const dirs = angles(rng);
  for (const pi of parents) {
    const p = arbors[pi];
    for (const layer of LAYERS) {
      for (const { zp, zc, newWheel } of meshOptions(arbors, pi, layer, R, 1, 2)) {
        // Driven at the front, the meshing wheel carries the hand; from behind, it gets a front wheel too.
        const fronts = layer === 0 ? [null] : FRONT_SIZES;
        for (const zf of fronts) {
          const wheels: { z: number; layer: Layer }[] = zf === null ? [{ z: zc, layer: 0 }] : [{ z: zc, layer }, { z: zf, layer: 0 }];
          const extra = newWheel ? { z: zp, layer, theta0: 0 } : null;
          for (const phi of dirs) {
            const d = zp / 2 + zc / 2;
            const x = p.x + d * dm.cos(phi);
            const y = p.y + d * dm.sin(phi);
            if (!fits(arbors, { x, y, wheels }, { arbor: pi, layer }, extra)) continue;
            const front = zf ?? zc;
            // Compact, mostly meshed at the front, hands on wheels big enough to read.
            const score = fitScore(grow(box, x, y, outer(wheels))) + 0.03 * layer + (front < 12 ? 0.06 : 0) + 0.01 * rng.range(0, 1);
            if (best && score >= best.score) continue;
            best = {
              score,
              apply: () => {
                if (newWheel) p.wheels.push({ z: zp, layer, theta0: rng.range(0, Math.PI * 2) });
                const pw = wheelIn(p, layer)!;
                const ws: Wheel[] = wheels.map((w) => ({ ...w, theta0: w.layer === layer ? meshPhase(pw, phi, w.z) : rng.range(0, Math.PI * 2) }));
                arbors.push({ x, y, num: R, den: 1, dir: -p.dir, element: e, wheels: ws, parent: pi, meshLayer: layer });
              },
            };
          }
        }
      }
    }
  }
  best?.apply();
  return !!best;
}

/**
 * When no direct pair reaches the rate: drive it through an in-between arbor (two wheels, one per
 * layer, no hand) placed off an existing arbor, with element e meshing its other wheel. Of the places
 * found, the one keeping the train most compact wins.
 */
function attachViaIdler(arbors: Arbor[], e: number, R: number, rng: Rng, box: Box, wide = false): boolean {
  const parents = arbors
    .map((_, i) => i)
    .sort((a, b) => Math.abs(Math.log(arbors[a].num / arbors[a].den / R)) - Math.abs(Math.log(arbors[b].num / arbors[b].den / R)))
    .slice(0, wide ? arbors.length : IDLER_PARENTS);
  const sizes = Array.from({ length: Z_MAX - Z_MIN + 1 }, (_, k) => Z_MIN + k);
  let best: Candidate | null = null;
  for (const pi of parents) {
    const p = arbors[pi];
    for (const [l1, l2] of [
      [1, 2],
      [2, 1],
      [1, 0],
      [0, 1],
      [2, 0],
      [0, 2],
    ] as [Layer, Layer][]) {
      const pw = wheelIn(p, l1);
      const zps = pw ? [pw.z] : [48, 36, 30, 24, 18, 12].filter((z) => wheelFits(arbors, pi, { z, layer: l1 }));
      // Find wheel sizes: idler turns m = p × zp / zi1; element turns R = m × zi2 / zc.
      const combos: { zp: number; zi1: number; zi2: number; zc: number; cost: number }[] = [];
      for (const zp of zps)
        for (const zi1 of sizes)
          for (const zi2 of sizes) {
            const top = p.num * zp * zi2;
            const bottom = p.den * zi1 * R;
            if (top % bottom !== 0) continue;
            const zc = top / bottom;
            if (zc < Z_MIN || zc > Z_MAX) continue;
            const cost = Math.abs(Math.log(zi1 / 30)) + Math.abs(Math.log(zi2 / 30)) + Math.abs(Math.log(zc / 24));
            combos.push({ zp, zi1, zi2, zc, cost });
          }
      combos.sort((a, b) => a.cost - b.cost);
      for (const c of combos.slice(0, wide ? 12 : IDLER_COMBOS)) {
        const extra = pw ? null : { z: c.zp, layer: l1, theta0: 0 };
        const idlerWheels = [
          { z: c.zi1, layer: l1 },
          { z: c.zi2, layer: l2 },
        ];
        const g = gcd(p.num * c.zp, p.den * c.zi1);
        const mNum = (p.num * c.zp) / g;
        const mDen = (p.den * c.zi1) / g;
        const wheels: { z: number; layer: Layer }[] = l2 === 0 ? [{ z: c.zc, layer: 0 }] : [{ z: c.zc, layer: l2 }, { z: 24, layer: 0 }];
        for (const phi of angles(rng, 16)) {
          const d1 = c.zp / 2 + c.zi1 / 2;
          const ix = p.x + d1 * dm.cos(phi);
          const iy = p.y + d1 * dm.sin(phi);
          if (!fits(arbors, { x: ix, y: iy, wheels: idlerWheels }, { arbor: pi, layer: l1 }, extra)) continue;
          const idlerBox = grow(box, ix, iy, outer(idlerWheels));
          // Even the idler alone already spreads the train more than the best so far.
          if (best && fitScore(idlerBox) >= best.score) continue;
          // Tentatively place the idler (and the parent's new wheel) to test room for the element.
          if (extra) p.wheels.push(extra);
          arbors.push({ x: ix, y: iy, num: mNum, den: mDen, dir: -p.dir, element: -1, wheels: idlerWheels.map((w) => ({ ...w, theta0: 0 })), parent: pi, meshLayer: l1 });
          const ii = arbors.length - 1;
          for (const phi2 of angles(rng, 16)) {
            const d2 = c.zi2 / 2 + c.zc / 2;
            const x = ix + d2 * dm.cos(phi2);
            const y = iy + d2 * dm.sin(phi2);
            if (!fits(arbors, { x, y, wheels }, { arbor: ii, layer: l2 }, null)) continue;
            const score = fitScore(grow(idlerBox, x, y, outer(wheels))) + 0.01 * rng.range(0, 1);
            if (best && score >= best.score) continue;
            best = {
              score,
              apply: () => {
                if (extra) p.wheels.push({ ...extra, theta0: rng.range(0, Math.PI * 2) });
                const ppw = wheelIn(p, l1)!;
                const idler: Arbor = {
                  x: ix,
                  y: iy,
                  num: mNum,
                  den: mDen,
                  dir: -p.dir,
                  element: -1,
                  wheels: [
                    { z: c.zi1, layer: l1, theta0: meshPhase(ppw, phi, c.zi1) },
                    { z: c.zi2, layer: l2, theta0: rng.range(0, Math.PI * 2) },
                  ],
                  parent: pi,
                  meshLayer: l1,
                };
                arbors.push(idler);
                const iw = wheelIn(idler, l2)!;
                arbors.push({
                  x,
                  y,
                  num: R,
                  den: 1,
                  dir: -idler.dir,
                  element: e,
                  wheels: wheels.map((w) => ({ ...w, theta0: w.layer === l2 ? meshPhase(iw, phi2, w.z) : rng.range(0, Math.PI * 2) })),
                  parent: arbors.length - 1,
                  meshLayer: l2,
                });
              },
            };
          }
          // Take the trial idler back out.
          arbors.pop();
          if (extra) p.wheels.pop();
        }
      }
    }
  }
  best?.apply();
  return !!best;
}

/** Half the width and height of the train (layout units), with a little margin. */
export function trainExtent(arbors: Arbor[]): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const a of arbors) {
    const r = outer(a.wheels) + 1;
    w = Math.max(w, Math.abs(a.x) + r);
    h = Math.max(h, Math.abs(a.y) + r);
  }
  return { w, h };
}
