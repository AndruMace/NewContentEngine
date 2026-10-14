/**
 * Spinning-top physics in the stadium's floor plane (2D, rim at radius 1). The 3D view only reads
 * this state. Everything here is deterministic: no Math.random, and the transcendental functions
 * come from @sim/physics/math.
 */
import type { Rng } from '@sim/engine';
import * as dm from '@sim/physics/math';
import type { Team } from '../fx';
import { OPPOSITE, POINTS_MOD, TOPS, type TopStats, type TopType } from './tops';
import { POLY_N, contourPolygon, getDesign, type Design } from './designs';

export type TopStatus = 'spinning' | 'down' | 'out';
export type FinishKind = 'spin' | 'pocket' | 'wall';

export interface Top {
  idx: number;
  type: TopType;
  /** The contour design; `stats` already include its radius and weight. */
  design: Design;
  stats: TopStats;
  /** Contour polygon in the top's own frame, its inner and outer radius, and scratch space for its
   * world position (rebuilt when tops are close). */
  poly: { x: Float64Array; y: Float64Array; min: number; max: number };
  wx: Float64Array;
  wy: Float64Array;
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Spin as a fraction of launch RPM. */
  omega: number;
  /** Spin direction: 1 = right (clockwise from above), -1 = left. */
  dir: 1 | -1;
  /** Its opponent spins the other way (opposite-spin tuning applies). */
  vsOpposite: boolean;
  status: TopStatus;
  wobbling: boolean;
  /** When and how it left the fight, and how it was moving (for the 3D exit animation). */
  outAt: number;
  outKind: FinishKind | null;
  outVx: number;
  outVy: number;
  /** Sim time it left the fight (for the replay). */
  outSimT: number;
  /** Spin angle (radians, physics: the contour polygon turns with it). */
  spin: number;
  /** Visual only: wobble tilt and precession angle, hit flash. */
  tilt: number;
  precess: number;
  flash: number;
}

export interface Arena {
  /** Pull towards the middle of the bowl (per unit radius). */
  G: number;
  /** Centre angles of the rim pockets. */
  pockets: number[];
  wallLaunch: number;
  /** Extra resistance to knockouts, and extra randomness (points format). */
  hold: number;
  chaos: number;
  /** Points format (per-type knockout resistance applies). */
  points: boolean;
  hitPower: number;
  /** Multiplier on every spin loss (decay, hits, grinding): sets how long rounds last without
   * changing who tends to win. */
  spin: number;
}

export interface StepHooks {
  emit: (e: Record<string, unknown> & { type: string }) => void;
  /** Ring-outs and spin-outs only count while the round is live. */
  live: boolean;
  /** Sim seconds since this round's launch (spin decay ramps up after a soft cap). */
  fightT: number;
  softCap: number;
  /** Sim time, for clash cooldowns. */
  simT: number;
  /** Physics randomness (the tip's skips and skids). */
  rng: Rng;
  /** Called the moment a top leaves the fight. */
  finish: (top: Top, kind: FinishKind, by: Top | null) => void;
}

export const RIM = 1;
/** Half-width (radians) of each rim pocket: wide enough for a top to drop through. */
export const POCKET_HALF = 0.17;
/** Physics tuning (exported so the balance test and tuning scripts can read it). */
export const K = {
  /** Outward speed a top needs to clear a pocket's lip (scaled by √mass). */
  pocketLip: 2.6,
  damp: 0.85,
  wallRestitution: 0.55,
  /** How much of a contour's spinning surface speed (× smash) goes into a hit. */
  surface: 1.9,
  /** Friction between contours (sideways kick, as a share of the normal impulse at most). */
  mu: 0.56,
  hitDrain: 0.0088,
  grindDrain: 0.057,
  clashCooldown: 0.14,
  /** Turn rates (rad/s at full spin): the steady curl, and steering at the opponent. */
  curl: 1.59,
  hunt: 3.52,
  /** Pull to the middle of the bowl (× bowlDepth) and launch speed (× launchPower). */
  bowl: 5.82,
  launch: 3.52,
  /** Random shoves from the tip skipping on the floor (× spin): chaos that keeps fights unpredictable. */
  jitter: 5.8,
  /** Longer rounds mean more clashes: tops get harder to knock out to keep the odds the same. */
  holdExp: 0.39,
  /** Points format: an over finish scores double, so knockouts are made a little harder. */
  pointsHold: 1,
  /** Points format: more chaos per round, so small edges don't add up over a match. */
  pointsChaos: 1,
  /** Opposite spins curl round the bowl in opposite directions and meet head-on far more often:
   * hit spin cost multiplier (and its growth with round length) for those fights. */
  oppDrain: 0.35,
  oppLenExp: 0,
};
/** Seconds after launch before a top can be knocked out of the stadium. */
const LAUNCH_GRACE = 1.2;
/** A clash at least this hard counts as heavy (big spark burst, flash, boom). */
export const HEAVY_HIT = 2.4;
export const WOBBLE_AT = 0.24;
export const FALL_AT = 0.035;

/** Spin rate (rad/s) at a given spin fraction: the contour's angular speed. */
export const spinRate = (omega: number) => 5 + 30 * omega;

export function makeTop(idx: number, type: TopType, team: Team, dir: 1 | -1 = 1, design: Design = getDesign(DEFAULT_DESIGN[type])): Top {
  const base = TOPS[type];
  const stats = { ...base, radius: base.radius * design.radiusScale, mass: base.mass * design.massScale };
  return {
    idx,
    type,
    design,
    stats,
    poly: contourPolygon(design, stats.radius),
    wx: new Float64Array(POLY_N),
    wy: new Float64Array(POLY_N),
    team,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    omega: 1,
    dir,
    vsOpposite: false,
    status: 'spinning',
    wobbling: false,
    outAt: -1,
    outKind: null,
    outVx: 0,
    outVy: 0,
    outSimT: -1,
    spin: 0,
    tilt: 0,
    precess: 0,
    flash: 0,
  };
}

const DEFAULT_DESIGN: Record<TopType, string> = { attack: 'tri-blade', defense: 'bastion', stamina: 'halo', balance: 'trinity' };

const wrap = (a: number) => {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
};

export function inPocket(arena: Arena, x: number, y: number, extra = 0): boolean {
  if (!arena.pockets.length) return false;
  const a = dm.atan2(y, x);
  return arena.pockets.some((p) => Math.abs(wrap(a - p)) < POCKET_HALF + extra);
}

/** Outward speed that would carry this top out of the stadium at (x, y). */
export function escapeSpeed(arena: Arena, t: Top, x: number, y: number): number {
  const k = Math.sqrt(t.stats.mass) * t.stats.hold * (t.vsOpposite ? OPPOSITE[t.type].hold : 1) * (arena.points ? POINTS_MOD[t.type].hold : 1);
  return (inPocket(arena, x, y) ? K.pocketLip : arena.wallLaunch) * k * arena.hold * arena.spin ** -K.holdExp;
}

const pairKey = (a: Top, b: Top) => `${a.idx}-${b.idx}`;
const TAU = Math.PI * 2;

export function stepTops(tops: Top[], arena: Arena, dt: number, contact: Map<string, number>, h: StepHooks) {
  const live = tops.filter((t) => t.status === 'spinning');
  const ramp = 1 + Math.max(0, h.fightT - h.softCap) * 0.3 * arena.spin;

  for (const t of live) {
    const r = Math.sqrt(t.x * t.x + t.y * t.y);
    const sp = Math.sqrt(t.vx * t.vx + t.vy * t.vy);
    // The tip drives the top along its path (towards a cruising speed set by traction and spin),
    // and the path curls: a steady turn (counter-clockwise for right spin, clockwise for left) plus,
    // for aggressive types, a turn towards the opponent. A wobbling top loses its grip.
    const grip = t.stats.traction * t.omega * (t.wobbling ? 0.35 : 1);
    let ux = 1;
    let uy = 0;
    if (sp > 0.02) {
      ux = t.vx / sp;
      uy = t.vy / sp;
    } else if (r > 1e-3) {
      ux = -t.y / r;
      uy = t.x / r;
    }
    let turn = K.curl * t.omega * t.dir;
    const foe = live.find((o) => o !== t);
    if (foe && t.stats.aggression > 0) {
      const fx = foe.x - t.x;
      const fy = foe.y - t.y;
      const fd = Math.sqrt(fx * fx + fy * fy) || 1;
      // Turn by the sine of the angle to the foe (positive = foe to the left), sharper when close
      // and fast, so the turning circle never gets wider than the gap and it doesn't just orbit.
      turn += (t.stats.aggression * K.hunt * t.omega * sp * ((ux * fy - uy * fx) / fd)) / Math.max(fd, 0.3);
    }
    if (sp > 0.02) {
      const c = dm.cos(turn * dt);
      const sn = dm.sin(turn * dt);
      const vx = t.vx * c - t.vy * sn;
      t.vy = t.vx * sn + t.vy * c;
      t.vx = vx;
    }
    // The tip skips and skids: a random shove, re-drawn each step.
    const jit = K.jitter * arena.chaos * t.omega;
    const jx = jit * (h.rng.next() * 2 - 1);
    const jy = jit * (h.rng.next() * 2 - 1);
    t.vx += (-arena.G * t.x + grip * ux - K.damp * t.vx + jx) * dt;
    t.vy += (-arena.G * t.y + grip * uy - K.damp * t.vy + jy) * dt;
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    t.omega = Math.max(0, t.omega - t.stats.spinDecay * arena.spin * ramp * dt);
    t.spin += spinRate(t.omega) * dt;
    if (t.spin >= TAU) t.spin -= TAU;
  }

  // Top against top.
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) collide(live[i], live[j], arena, dt, contact, h);

  // Rim: bounce, or fly out through a pocket or over the wall.
  for (const t of live) {
    if (t.status !== 'spinning') continue;
    const r = Math.sqrt(t.x * t.x + t.y * t.y);
    const lim = RIM - t.stats.radius;
    if (r <= lim) continue;
    const ux = t.x / r;
    const uy = t.y / r;
    const vr = t.vx * ux + t.vy * uy;
    if (vr <= 0) {
      t.x = ux * lim;
      t.y = uy * lim;
      continue;
    }
    // Nobody flies out while the tops are still settling after the launch.
    if (h.live && h.fightT > LAUNCH_GRACE && vr > escapeSpeed(arena, t, t.x, t.y)) {
      const kind: FinishKind = inPocket(arena, t.x, t.y) ? 'pocket' : 'wall';
      t.status = 'out';
      t.outKind = kind;
      t.outVx = t.vx;
      t.outVy = t.vy;
      t.outSimT = h.simT;
      h.finish(t, kind, null);
      continue;
    }
    t.x = ux * lim;
    t.y = uy * lim;
    t.vx -= (1 + K.wallRestitution) * vr * ux;
    t.vy -= (1 + K.wallRestitution) * vr * uy;
    if (vr > 0.35) h.emit({ type: 'wall', who: t.idx, speed: Math.round(vr * 100) / 100, x: Math.round(t.x * 100) / 100 });
  }

  // Spin: wobble, then topple.
  for (const t of live) {
    if (t.status !== 'spinning') continue;
    if (!t.wobbling && t.omega < WOBBLE_AT) {
      t.wobbling = true;
      if (h.live) h.emit({ type: 'wobble', who: t.idx, x: Math.round(t.x * 100) / 100 });
    }
    if (t.omega <= FALL_AT && h.live) {
      t.status = 'down';
      t.outKind = 'spin';
      t.outVx = t.vx;
      t.outVy = t.vy;
      t.outSimT = h.simT;
      t.vx = 0;
      t.vy = 0;
      h.finish(t, 'spin', null);
    }
  }
}

/** World positions of a top's contour vertices (left-spin tops are mirrored, turning the other way). */
function placePolygon(t: Top) {
  const th = t.dir * t.spin;
  const c = dm.cos(th);
  const sn = dm.sin(th);
  const { x, y } = t.poly;
  for (let i = 0; i < POLY_N; i++) {
    const lx = t.dir > 0 ? x[i] : -x[i];
    t.wx[i] = t.x + lx * c - y[i] * sn;
    t.wy[i] = t.y + lx * sn + y[i] * c;
  }
}

function insidePolygon(px: number, py: number, wx: Float64Array, wy: Float64Array) {
  let inside = false;
  for (let i = 0, j = POLY_N - 1; i < POLY_N; j = i++) {
    if (wy[i] > py !== wy[j] > py && px < ((wx[j] - wx[i]) * (py - wy[i])) / (wy[j] - wy[i]) + wx[i]) inside = !inside;
  }
  return inside;
}

interface Contact {
  depth: number;
  /** Contact point, and the direction the first top must move to separate. */
  x: number;
  y: number;
  nx: number;
  ny: number;
}

/** Deepest vertex of p inside polygon q: how far it is in, and the way out (nearest edge of q). */
function deepestIn(p: Top, q: Top, sign: number, best: Contact | null): Contact | null {
  const qMax2 = q.poly.max * q.poly.max;
  const qMin2 = q.poly.min * q.poly.min;
  for (let i = 0; i < POLY_N; i++) {
    const px = p.wx[i];
    const py = p.wy[i];
    const dx = px - q.x;
    const dy = py - q.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > qMax2) continue;
    if (d2 > qMin2 && !insidePolygon(px, py, q.wx, q.wy)) continue;
    // Nearest point on q's outline.
    let bd2 = Infinity;
    let bx = 0;
    let by = 0;
    for (let k = 0, j = POLY_N - 1; k < POLY_N; j = k++) {
      const ax = q.wx[j];
      const ay = q.wy[j];
      const ex = q.wx[k] - ax;
      const ey = q.wy[k] - ay;
      const l2 = ex * ex + ey * ey || 1e-12;
      let u = ((px - ax) * ex + (py - ay) * ey) / l2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const cx = ax + ex * u;
      const cy = ay + ey * u;
      const e2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      if (e2 < bd2) {
        bd2 = e2;
        bx = cx;
        by = cy;
      }
    }
    const depth = Math.sqrt(bd2);
    if (depth < 1e-9 || (best && depth <= best.depth)) continue;
    // p's top must move towards the outline point; `sign` turns that into the first top's direction.
    best = { depth, x: (px + bx) / 2, y: (py + by) / 2, nx: (sign * (bx - px)) / depth, ny: (sign * (by - py)) / depth };
  }
  return best;
}

/**
 * Contour against contour. The contours are real polygons turning with each top's spin, and the
 * impulse at the contact point includes each contour's surface speed there: a hooked face sweeping
 * into the opponent strikes hard; a smooth rim (surface moving along the contact) mostly scrapes.
 */
function collide(a: Top, b: Top, arena: Arena, dt: number, contact: Map<string, number>, h: StepHooks) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const reach = a.poly.max + b.poly.max;
  if (dx * dx + dy * dy >= reach * reach) return;
  placePolygon(a);
  placePolygon(b);
  const hit = deepestIn(b, a, -1, deepestIn(a, b, 1, null));
  if (!hit) return;
  const ma = a.stats.mass;
  const mb = b.stats.mass;
  const { nx, ny } = hit;
  a.x += (nx * hit.depth * mb) / (ma + mb);
  a.y += (ny * hit.depth * mb) / (ma + mb);
  b.x -= (nx * hit.depth * ma) / (ma + mb);
  b.y -= (ny * hit.depth * ma) / (ma + mb);

  // Velocity of each contour where they touch: the top's motion plus its spinning surface.
  const rax = hit.x - a.x;
  const ray = hit.y - a.y;
  const rbx = hit.x - b.x;
  const rby = hit.y - b.y;
  const sa = K.surface * arena.hitPower * a.stats.smash * a.dir * spinRate(a.omega);
  const sb = K.surface * arena.hitPower * b.stats.smash * b.dir * spinRate(b.omega);
  const rvx = a.vx - sa * ray - (b.vx - sb * rby);
  const rvy = a.vy + sa * rax - (b.vy + sb * rbx);
  const vn = rvx * nx + rvy * ny;
  const key = pairKey(a, b);
  if (vn >= 0) {
    // Resting contact: the contours grind, both slowly losing spin.
    a.omega = Math.max(0, a.omega - K.grindDrain * arena.spin * dt * b.omega);
    b.omega = Math.max(0, b.omega - K.grindDrain * arena.spin * dt * a.omega);
    const gk = `${key}g`;
    if ((contact.get(gk) ?? -1) <= h.simT) {
      contact.set(gk, h.simT + 0.12);
      h.emit({ type: 'grind', x: Math.round(hit.x * 100) / 100 });
    }
    return;
  }
  const invM = 1 / ma + 1 / mb;
  const e = (a.stats.restitution + b.stats.restitution) / 2;
  const J = (-(1 + e) * vn) / invM;
  // Friction: the scraping surfaces throw each other sideways.
  let tx = rvx - vn * nx;
  let ty = rvy - vn * ny;
  const vt = Math.sqrt(tx * tx + ty * ty);
  let Jt = 0;
  if (vt > 1e-6) {
    tx /= vt;
    ty /= vt;
    Jt = Math.min(K.mu * J, vt / invM);
  }
  const jx = nx * J - tx * Jt;
  const jy = ny * J - ty * Jt;
  a.vx += jx / ma;
  a.vy += jy / ma;
  b.vx -= jx / mb;
  b.vy -= jy / mb;
  // Every hit costs both tops spin (a random share: exactly how the contours bit).
  const same = a.dir === b.dir;
  const k = (same ? 1 : K.oppDrain * Math.max(1, 1 / arena.spin) ** K.oppLenExp) * K.hitDrain * arena.spin * (J + Jt);
  const fragility = (t: Top) => t.stats.fragility * (t.vsOpposite ? OPPOSITE[t.type].fragility : 1) * (arena.points ? POINTS_MOD[t.type].fragility : 1);
  a.omega = Math.max(0, a.omega - (k * fragility(a) * (0.5 + h.rng.next())) / ma);
  b.omega = Math.max(0, b.omega - (k * fragility(b) * (0.5 + h.rng.next())) / mb);
  // One clash event per contact (or a much harder hit within it).
  const power = J + Jt;
  const last = contact.get(`${key}p`) ?? 0;
  if (power < 0.25 || ((contact.get(key) ?? -1) > h.simT && power < last * 2)) return;
  contact.set(key, h.simT + K.clashCooldown);
  contact.set(`${key}p`, power);
  a.flash = 1;
  b.flash = 1;
  h.emit({
    type: 'clash',
    a: a.idx,
    b: b.idx,
    power: Math.round(power * 100) / 100,
    x: Math.round(hit.x * 1000) / 1000,
    y: Math.round(hit.y * 1000) / 1000,
    nx: Math.round(nx * 1000) / 1000,
    ny: Math.round(ny * 1000) / 1000,
    w: [Math.round(a.omega * 1000) / 1000, Math.round(b.omega * 1000) / 1000],
    opp: !same,
  });
}
