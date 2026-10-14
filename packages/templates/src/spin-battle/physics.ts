/**
 * Spinning-top physics in the stadium's floor plane (2D, rim at radius 1). The 3D view only reads
 * this state. Everything here is deterministic: no Math.random, and the transcendental functions
 * come from @sim/physics/math.
 */
import type { Rng } from '@sim/engine';
import * as dm from '@sim/physics/math';
import type { Team } from '../fx';
import { OPPOSITE, TOPS, type TopStats, type TopType } from './tops';

export type TopStatus = 'spinning' | 'down' | 'out';
export type FinishKind = 'spin' | 'pocket' | 'wall';

export interface Top {
  idx: number;
  type: TopType;
  stats: TopStats;
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
  /** Visual only: spin angle, wobble tilt and precession angle, hit flash. */
  spin: number;
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
  /** Extra recoil from the spinning contours meeting (both tops spin the same way). */
  spinRecoil: 1.45,
  /** Sideways kick from the contours' surface speed, as a share of the normal impulse. */
  sideKick: 0.46,
  hitDrain: 0.015,
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
  pointsHold: 1.12,
  /** Points format: more chaos per round, so small edges don't add up over a match. */
  pointsChaos: 1,
  /** Opposite spins: the contours' surfaces move the same way where they touch, so the recoil is softer. */
  oppRecoil: 0.8,
  /** Opposite spins curl round the bowl in opposite directions and meet head-on far more often,
   * so each hit costs less spin to keep the odds the same. */
  oppDrain: 1.11,
  oppLenExp: 0.6,
};
/** Seconds after launch before a top can be knocked out of the stadium. */
const LAUNCH_GRACE = 1.2;
/** A clash at least this hard counts as heavy (big spark burst, flash, boom). */
export const HEAVY_HIT = 2.4;
export const WOBBLE_AT = 0.24;
export const FALL_AT = 0.035;

export function makeTop(idx: number, type: TopType, team: Team, dir: 1 | -1 = 1): Top {
  return {
    idx,
    type,
    stats: TOPS[type],
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
  const k = Math.sqrt(t.stats.mass) * t.stats.hold * (t.vsOpposite ? OPPOSITE[t.type].hold : 1);
  return (inPocket(arena, x, y) ? K.pocketLip : arena.wallLaunch) * k * arena.hold * arena.spin ** -K.holdExp;
}

const pairKey = (a: Top, b: Top) => `${a.idx}-${b.idx}`;

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

function collide(a: Top, b: Top, arena: Arena, dt: number, contact: Map<string, number>, h: StepHooks) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const minD = a.stats.radius + b.stats.radius;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minD * minD) return;
  const d = Math.sqrt(d2) || 1e-6;
  const nx = dx / d;
  const ny = dy / d;
  const ma = a.stats.mass;
  const mb = b.stats.mass;
  const over = minD - d;
  a.x += (nx * over * mb) / (ma + mb);
  a.y += (ny * over * mb) / (ma + mb);
  b.x -= (nx * over * ma) / (ma + mb);
  b.y -= (ny * over * ma) / (ma + mb);

  const vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  const e = (a.stats.restitution + b.stats.restitution) / 2;
  const invM = 1 / ma + 1 / mb;
  const J = vn < 0 ? (-(1 + e) * vn) / invM : 0;
  const key = pairKey(a, b);
  const fresh = (contact.get(key) ?? -1) <= h.simT;
  // Same spin: where the contours touch their surfaces run head-on, so they slam apart. Opposite
  // spin: the surfaces run together, so the recoil is softer.
  const same = a.dir === b.dir;
  const Js = fresh ? K.spinRecoil * arena.hitPower * (a.stats.smash * a.omega + b.stats.smash * b.omega) * (same ? 1 : K.oppRecoil) : 0;
  const Jn = J + Js;
  if (Jn <= 0) {
    // Resting contact: the contours grind, both slowly losing spin.
    a.omega = Math.max(0, a.omega - K.grindDrain * arena.spin * dt * b.omega);
    b.omega = Math.max(0, b.omega - K.grindDrain * arena.spin * dt * a.omega);
    const gk = `${key}g`;
    if ((contact.get(gk) ?? -1) <= h.simT) {
      contact.set(gk, h.simT + 0.12);
      h.emit({ type: 'grind', x: Math.round(((a.x + b.x) / 2) * 100) / 100 });
    }
    return;
  }
  // Sideways flick: each top's spinning contour throws the other along its own surface direction.
  // Same spin: they're flung apart in opposite directions; opposite spin: they swing round together.
  const Jt = K.sideKick * Jn;
  const tx = -ny;
  const ty = nx;
  a.vx += (nx * Jn + tx * Jt * a.dir) / ma;
  a.vy += (ny * Jn + ty * Jt * a.dir) / ma;
  b.vx -= (nx * Jn + tx * Jt * b.dir) / mb;
  b.vy -= (ny * Jn + ty * Jt * b.dir) / mb;
  const fragility = (t: Top) => t.stats.fragility * (t.vsOpposite ? OPPOSITE[t.type].fragility : 1);
  const drain = (self: Top, other: Top) => (K.hitDrain * arena.spin * Jn * (0.4 + other.stats.smash * other.omega) * fragility(self)) / self.stats.mass;
  // How much spin a hit costs depends on exactly where the contours meet: a random share.
  // Opposite spins: hits cost a bit more in rounds longer than usual (head-on meetings add up).
  const k = same ? 1 : K.oppDrain * Math.max(1, 1 / arena.spin) ** K.oppLenExp;
  const da = drain(a, b) * k * (0.3 + 1.4 * h.rng.next());
  const db = drain(b, a) * k * (0.3 + 1.4 * h.rng.next());
  a.omega = Math.max(0, a.omega - da);
  b.omega = Math.max(0, b.omega - db);
  if (!fresh) return;
  contact.set(key, h.simT + K.clashCooldown);
  a.flash = 1;
  b.flash = 1;
  const cx = (a.x * b.stats.radius + b.x * a.stats.radius) / minD;
  const cy = (a.y * b.stats.radius + b.y * a.stats.radius) / minD;
  h.emit({
    type: 'clash',
    a: a.idx,
    b: b.idx,
    power: Math.round(Jn * 100) / 100,
    x: Math.round(cx * 1000) / 1000,
    y: Math.round(cy * 1000) / 1000,
    w: [Math.round(a.omega * 1000) / 1000, Math.round(b.omega * 1000) / 1000],
    opp: !same,
  });
}
