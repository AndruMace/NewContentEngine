/**
 * Believable hops. Gravity is one value per song that only drifts slowly; each bar tilts a little
 * to reflect the ball; and the next bar sits wherever the ball actually is when the next note is
 * due. A short note therefore lands on a bar close by and steeply below; a long note carries the
 * ball further on a flatter, higher arc. Pure functions of the timeline (deterministic).
 */
import * as dm from '@sim/physics/math';
import { bounceNormal, type Arc, type Pt } from './timeline';

/** How far gravity may drift from the song's base value on tempo alone (±15%). */
export const GRAVITY_BAND: [number, number] = [0.85, 1.15];
/** The most gravity changes from one hop to the next (about 8%). */
export const GRAVITY_RATE = 0.08;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/** The song's base gravity: a median note's hop rises a visible but modest amount. */
export function baseGravity(durs: number[]): number {
  const m = median(durs);
  return Math.min(9000, Math.max(1200, 980 / (m * m)));
}

/**
 * Gravity per hop: drifts toward slightly lower values in slow passages and higher in fast ones,
 * within GRAVITY_BAND, and is pulled lower where a level hop would rise past maxApex (`levelCap`,
 * for the keyboard, which can't drop the ball further instead). Every change is spread out so no
 * two neighbouring hops differ by more than GRAVITY_RATE.
 */
export function gravityProfile(durs: number[], opts: { levelCap?: number; floor?: number } = {}): number[] {
  const g0 = baseGravity(durs);
  const m = median(durs);
  const n = durs.length;
  const upper = durs.map((_, i) => {
    // The local tempo: geometric mean of the note lengths around this one.
    let s = 0;
    let k = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++, k++) s += dm.log(durs[j]);
    const local = dm.exp(s / k);
    const pref = g0 * Math.min(GRAVITY_BAND[1], Math.max(GRAVITY_BAND[0], dm.pow(m / local, 0.35)));
    const cap = opts.levelCap ? (8 * opts.levelCap) / (durs[i] * durs[i]) : Infinity;
    return Math.max(Math.min(pref, cap), (opts.floor ?? 0) * g0);
  });
  // Lowest cone through the upper bounds: smooth (rate-limited) and never above any bound.
  const g = [...upper];
  const step = dm.exp(GRAVITY_RATE);
  for (let i = 1; i < n; i++) g[i] = Math.min(g[i], g[i - 1] * step);
  for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] * step);
  return g;
}

export interface Steer {
  /** Where pitch would like the next landing (horizontal plane: x and z). */
  target(i: number, at: Pt, dt: number): { x: number; z: number };
  /** Keep landings inside these (x and z ranges, px). */
  bounds: { x: [number, number]; z: [number, number] };
  /** Optionally also within this distance of the centre line (x = 540, z = 0), e.g. the spiral. */
  maxRadius?: number;
  maxTilt: number;
  /** Sideways speed override (px/s); defaults to about half a median hop's vertical speed. */
  cruise?: number;
  /** The least share of cruise speed kept when the target is close (default 0.4). */
  minShare?: number;
  /** The highest a hop may rise above its bar; longer notes drop further instead. */
  maxApex: number;
  /** Fast runs ping back and forth along this horizontal direction (default: across the screen). */
  zigAxis?: (at: Pt) => { x: number; z: number };
  /** Instead of reversing, turn the step this far (radians) each fast hop: for views from above. */
  zigTurn?: number;
  /** The camera looks straight down, so bars overlap whenever they're close sideways. */
  topDown?: boolean;
  /** Fast runs' sideways step between neighbouring bars (px); default FAST_STEP. */
  fastStep?: number;
  /** Fast steps keep their distance from the centre line (x = 540, z = 0): round the spiral's column. */
  keepRadius?: boolean;
  /**
   * Real physics: one gravity for the whole song, and no bounce rising higher than the drop before
   * it (vertical speed off a bar is at most RESTITUTION times the speed onto it). A held note finds
   * its extra time in a longer drop, never a taller lob.
   */
  constantGravity?: boolean;
}

/** Constant gravity: the share of vertical speed a bounce keeps (a lively ball, like rubber on wood). */
export const RESTITUTION = 0.85;

/** A hop counts as fast when shorter than this share of the song's median note, or than FAST_S. */
export const FAST_SHARE = 0.72;
/** ...or shorter than this (s): too quick for a normal hop to clear the bar before it. */
export const FAST_S = 0.2;
/** Full bar length (px); matches the renderers' BLOCK_W. */
const BAR_W = 118;
/** Fast runs: sideways step between neighbouring bars (px), so bars sit apart instead of piling up. */
const FAST_STEP = 105;
/** Fast runs: bars may lean this far (about 55°) to send the ball straight back the other way. */
export const FAST_TILT = 0.95;

/**
 * Bar length (share of full) for each note: shorter notes get shorter bars, down to 55%. Short is
 * judged against the song's median note, and against 0.3 s, so a song made of fast notes (where
 * the median itself is fast) still gets small bars.
 */
export function barSizes(onsets: { dur: number }[]): number[] {
  const durs = onsets.map((o) => o.dur);
  const ref = Math.max(0.3, median(durs.slice(0, -1).length ? durs.slice(0, -1) : durs));
  return durs.map((d, i) => Math.min(1, Math.max(0.55, Math.min(d, i > 0 ? durs[i - 1] : d) / ref)));
}

export interface HopLayout {
  lands: Pt[];
  normals: Pt[];
  /** arcs[i] ends on landing i (arcs[0] is the drop-in). */
  arcs: Arc[];
  gravity: number[];
  /** Hops whose rise had to be capped (drama score penalty). */
  capped: number;
  /** Bar length per landing (share of full). */
  sizes: number[];
}

/** Hop durations: the gap after each note (the drop-in is separate). */
const gaps = (onsets: { t: number; dur: number }[]) => onsets.slice(0, -1).map((o) => o.dur);

/**
 * Lay out a descending path by forward physics: from each landing, pick an outgoing velocity (short
 * notes drop steeply, long notes lob further and flatter, steered gently toward the pitch target),
 * reflect it off a bar tilted to suit, and place the next bar where the ball is one note later.
 * Fast notes (and any hop that would land on the bar it just left) zigzag between small bars.
 */
export function layoutCascade(onsets: { t: number; dur: number }[], start: Pt, lead: number, steer: Steer): HopLayout {
  const durs = gaps(onsets);
  // Held notes ease gravity down beforehand (rate-limited) rather than flying off screen or plunging,
  // but never below 20% of the song's base: much lower and the fast notes around them would only
  // skim flat, with no room to zigzag. A note too long even for that drops further onto its bar.
  const g0 = durs.length ? baseGravity(durs) : 2500;
  const gravity = !durs.length ? [] : steer.constantGravity ? durs.map(() => g0) : gravityProfile(durs, { levelCap: steer.maxApex, floor: 0.2 });
  /** The most a bounce may rise off a bar given how fast the ball came down onto it. */
  const bounceCap = () => (steer.constantGravity ? RESTITUTION * vin.y : Infinity);
  const m = durs.length ? median(durs) : 0.5;
  const sizes = barSizes(onsets);
  // A steady sideways speed: short notes become short hops at about the same pace instead of slow
  // dribbles, long notes carry further. About half a median hop's vertical speed.
  const cruise = steer.cruise ?? Math.min(480, Math.max(180, 0.25 * g0 * m));
  const isFast = (d: number) => d < Math.max(FAST_SHARE * m, FAST_S);
  // Drop-in: free fall straight onto the first bar.
  const fall = 0.5 * g0 * lead * lead;
  const arcs: Arc[] = [{ t0: onsets[0].t - lead, dt: lead, x0: start.x, y0: start.y - fall, z0: start.z, vx: 0, vy: 0, vz: 0, g: g0 }];
  const lands: Pt[] = [start];
  const normals: Pt[] = [];
  let vin: Pt = { x: 0, y: g0 * lead, z: 0 };
  let heading = { x: 1, z: 0 };
  let capped = 0;
  let zig = 1;
  let turn = 0;
  let prevZig = false;
  const tiltOk = (vout: Pt, max: number) => -bounceNormal(vin, vout, Math.PI / 2).y >= dm.cos(max);
  const landAt = (at: Pt, v: Pt, g: number, dt: number): Pt => ({ x: at.x + v.x * dt, y: at.y + v.y * dt + 0.5 * g * dt * dt, z: at.z + v.z * dt });
  /** Would bar j (landing b) sit on top of bar i (landing a) as seen by the camera? */
  const stacked = (a: Pt, b: Pt, wa: number, wb: number) => {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    const clear = (BAR_W * (wa + wb)) / 2 + 12;
    if (steer.topDown) return dx * dx + dz * dz < clear * clear;
    return dx * dx + dz * dz < clear * clear && Math.abs(a.y - b.y) < 45;
  };

  for (let i = 0; i < durs.length; i++) {
    const dt = durs[i];
    const g = gravity[i];
    const at = lands[i];
    const tg = steer.target(i + 1, at, dt);

    // The usual hop: a share c of it spent dropping (short notes steep, long notes level), heading
    // for the pitch target at cruise speed and easing off (to no less than minShare) when close.
    const c = Math.min(0.42, Math.max(0.03, 0.15 - (0.15 * dm.log(dt / m)) / Math.LN2));
    let up = g * dt * (0.5 - c);
    let wasCapped = false;
    // A bounce never rises above the drop it came from; the rest of the time is spent falling.
    up = Math.min(up, bounceCap());
    if ((up * up) / (2 * g) > steer.maxApex) {
      up = Math.sqrt(2 * g * steer.maxApex);
      wasCapped = true;
    }
    const dx = tg.x - at.x;
    const dz = tg.z - at.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const head = dist > 1e-6 ? { x: dx / dist, z: dz / dist } : heading;
    const speed = Math.min(cruise, Math.max((steer.minShare ?? 0.4) * cruise, dist / dt));
    const hx = fitTo(head.x * speed, at.x, dt, steer.bounds.x);
    const hz = fitTo(head.z * speed, at.z, dt, steer.bounds.z);
    // Keep the bar's tilt believable: blend back toward the no-tilt bounce (same heading,
    // horizontal speed scaled with the vertical) until the bar leans no more than maxTilt.
    const k0 = up / Math.max(1e-6, vin.y);
    const flat = { x: vin.x * k0, z: vin.z * k0 };
    let vout: Pt = { x: hx, y: -up, z: hz };
    for (let s = 1; s >= 0; s -= 0.05) {
      vout = { x: flat.x + (hx - flat.x) * s, y: -up, z: flat.z + (hz - flat.z) * s };
      if (tiltOk(vout, steer.maxTilt)) break;
    }
    vout = withinRing(at, { x: fitTo(vout.x, at.x, dt, steer.bounds.x), y: vout.y, z: fitTo(vout.z, at.z, dt, steer.bounds.z) }, dt, steer.maxRadius);
    let maxTilt = steer.maxTilt;
    let usedZig = false;

    if (isFast(dt) || stacked(at, landAt(at, vout, g, dt), sizes[i], sizes[i + 1])) {
      // A fast note: a short, steep hop one step to the side, the next one back again, so a run
      // zigzags down between two staggered columns of small bars leaning toward each other. The
      // zigzag's centre drifts toward the pitch target, so a run still traces the melody's shape.
      usedZig = true;
      maxTilt = FAST_TILT;
      let axis = steer.zigAxis?.(at) ?? { x: 1, z: 0 };
      let flip: number;
      if (steer.zigTurn) {
        // Seen from above, reversing would stack every other bar; turning traces a small loop.
        turn = prevZig ? turn + steer.zigTurn : 0;
        axis = { x: axis.x * dm.cos(turn) - axis.z * dm.sin(turn), z: axis.x * dm.sin(turn) + axis.z * dm.cos(turn) };
        flip = 1;
      } else flip = prevZig ? -zig : heading.x * axis.x + heading.z * axis.z < 0 ? -1 : 1;
      const along = (tg.x - at.x) * axis.x + (tg.z - at.z) * axis.z;
      const drift = Math.max(-35, Math.min(35, 0.3 * along));
      // `up` is the share of the hop's time spent rising off the bar: a little, or more when that's
      // what lets a bar turn the ball (a flat exit would need the bar nearly on end).
      const step = (d: { x: number; z: number }, len: number, k: number, up: number): Pt => {
        let ex = d.x * len * k;
        let ez = d.z * len * k;
        if (steer.keepRadius) {
          // Land at the same distance from the column: the step becomes a chord round it.
          const r0 = Math.sqrt((at.x - 540) * (at.x - 540) + at.z * at.z);
          const nx = at.x - 540 + ex;
          const nz = at.z + ez;
          const r1 = Math.sqrt(nx * nx + nz * nz) || 1;
          ex = (nx * r0) / r1 - (at.x - 540);
          ez = (nz * r0) / r1 - at.z;
        }
        const rise = Math.min(g * dt * up, bounceCap());
        return withinRing(at, { x: fitTo(ex / dt, at.x, dt, steer.bounds.x), y: -rise, z: fitTo(ez / dt, at.z, dt, steer.bounds.z) }, dt, steer.maxRadius);
      };
      const fits = (v: Pt) => tiltOk(v, FAST_TILT) && !stacked(at, landAt(at, v, g, dt), sizes[i], sizes[i + 1]);
      const base = steer.fastStep ?? FAST_STEP;
      const toward = dist > 1e-6 ? { x: dx / dist, z: dz / dist } : heading;
      // In order of preference: turn back toward the facing bar (the zigzag); carry on the other way
      // along the axis; carry straight on; head for the pitch target (e.g. back in from the spiral's
      // edge). Drift toward the pitch only ever lengthens a zigzag step, so bars stay a step apart.
      // When gravity is low (around a held note) the ball travels almost flat and no believable bar
      // can turn it hard, which is when the later options are needed.
      const options = [
        { d: { x: axis.x * flip, z: axis.z * flip }, len: base + Math.max(0, flip * drift), zig: flip },
        { d: { x: -axis.x * flip, z: -axis.z * flip }, len: base + Math.max(0, -flip * drift), zig: -flip },
        { d: heading, len: base, zig },
        { d: toward, len: base, zig },
      ];
      let chosen: { v: Pt; d: { x: number; z: number }; zig: number } | null = null;
      const ups = [0.06, 0.1, 0.14, 0.18, 0.22, 0.26, 0.3, 0.34, 0.38, 0.42, 0.46];
      search: for (const o of options) {
        for (let k = 1; k >= 0.5; k -= 0.05) {
          for (const up of ups) {
            const v = step(o.d, o.len, k, up);
            if (fits(v)) {
              chosen = { v, d: o.d, zig: o.zig };
              break search;
            }
          }
        }
      }
      if (!chosen) {
        // Nothing clear and believable: the shortest compromise, a shortened zigzag step.
        const o = options[0];
        let v = step(o.d, o.len, 1, 0.3);
        for (let k = 1; k >= 0.2; k -= 0.05) {
          v = step(o.d, o.len, k, 0.3);
          if (tiltOk(v, FAST_TILT)) break;
        }
        chosen = { v, d: o.d, zig: o.zig };
      }
      vout = chosen.v;
      zig = chosen.zig;
      heading = chosen.d;
    } else {
      heading = head;
      if (wasCapped) capped++;
    }
    prevZig = usedZig;
    normals.push(bounceNormal(vin, vout, maxTilt));
    arcs.push({ t0: onsets[i].t, dt, x0: at.x, y0: at.y, z0: at.z, vx: vout.x, vy: vout.y, vz: vout.z, g });
    lands.push(landAt(at, vout, g, dt));
    vin = { x: vout.x, y: vout.y + g * dt, z: vout.z };
  }
  // The last bar, where the ball comes to rest, lies flat.
  normals.push({ x: 0, y: -1, z: 0 });
  return { lands, normals, arcs, gravity, capped, sizes };
}

/** Shorten sideways travel until the landing is within `maxRadius` of the centre line (spiral). */
function withinRing(at: Pt, v: Pt, dt: number, maxRadius?: number): Pt {
  if (!maxRadius) return v;
  const out = (k: number) => {
    const x = at.x + v.x * k * dt - 540;
    const z = at.z + v.z * k * dt;
    return x * x + z * z > maxRadius * maxRadius;
  };
  let k = 1;
  while (k > 0 && out(k)) k -= 0.05;
  return { x: v.x * Math.max(0, k), y: v.y, z: v.z * Math.max(0, k) };
}

/** A sideways speed, shortened so a hop of dt from `from` stays inside the range. */
function fitTo(v: number, from: number, dt: number, [lo, hi]: [number, number]): number {
  const to = from + v * dt;
  return to > hi ? Math.max(0, (hi - from) / dt) : to < lo ? Math.min(0, (lo - from) / dt) : v;
}

/** Level hops between fixed points (the keyboard, the bass rail), under the same slow gravity. */
export function layoutLevel(onsets: { t: number; dur: number }[], points: Pt[], lead: number, maxApex: number): HopLayout {
  const durs = gaps(onsets);
  const gravity = durs.length ? gravityProfile(durs, { levelCap: maxApex }) : [];
  const g0 = durs.length ? Math.min(baseGravity(durs), gravity[0] * dm.exp(GRAVITY_RATE)) : 2500;
  const fall = 0.5 * g0 * lead * lead;
  const p0 = points[0];
  const arcs: Arc[] = [{ t0: onsets[0].t - lead, dt: lead, x0: p0.x, y0: p0.y - fall, z0: p0.z, vx: 0, vy: 0, vz: 0, g: g0 }];
  let capped = 0;
  for (let i = 0; i < durs.length; i++) {
    const dt = durs[i];
    const g = gravity[i];
    const a = points[i];
    const b = points[i + 1];
    if (g < baseGravity(durs) * GRAVITY_BAND[0] * 0.999) capped++;
    arcs.push({ t0: onsets[i].t, dt, x0: a.x, y0: a.y, z0: a.z, vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt - 0.5 * g * dt, vz: (b.z - a.z) / dt, g });
  }
  return { lands: points, normals: points.map(() => ({ x: 0, y: -1, z: 0 })), arcs, gravity, capped, sizes: points.map(() => 1) };
}
