import * as dm from '@sim/physics/math';
import { CP_AIR, MU, OMEGA, R_EARTH, air, shockTemperature } from './atmosphere';
import { MATERIALS, scaleShape, surfaceArea, thinnest, type Body, type DragKind, type Shape, type StartMode } from './objects';

/**
 * The fall, integrated from release to the ground (RK4, steps sized to the flow), in Earth's
 * equatorial plane around a round, spinning Earth whose air turns with it:
 *
 * - Gravity: μ/r². Drag: ½ρv²·Cd·A on the speed through the air, with Cd from Mach number and, in
 *   the thin upper air, the Knudsen number (free-molecular flow, bridged to continuum).
 * - Heating at the stagnation point: convective (Sutton–Graves, with the hot-wall correction, so a
 *   hot object also cools in cold air) plus shock-layer radiation above 9 km/s (Tauber–Sutton),
 *   never more than the air's kinetic energy flux.
 * - Heat soaking into the surface: 1D conduction (implicit, through a dozen layers), radiating
 *   away at εσT⁴. Past its melting (or charring) point the surface is swept away and recedes:
 *   the object loses mass and shrinks.
 * - Breaking up: when the air pressure ram (½ρv²) passes its strength, or its thin skin burns
 *   through. Vehicles leave their sturdiest part; rocks flatten and spread (the pancake model of
 *   Chyba et al. 1993 / Collins et al. 2005) until they burst at 7× their width, leaving fragments.
 *
 * Not modelled: lift and wind (it falls ballistically), the effect of ablation vapour shielding the
 * surface, and fragments other than the one followed.
 */

const SIGMA = 5.670374e-8;
const G0 = 9.80665;
/** Where the atmosphere is taken to begin (the Kármán line). */
export const KARMAN = 100_000;
/** Altitude meteor speeds and entry angles are given at. */
export const ENTRY_INTERFACE = 120_000;

/** Continuum drag coefficient against Mach number, and the free-molecular value. */
const CD: Record<DragKind, { mach: number[]; cd: number[]; fm: number }> = {
  sphere: {
    mach: [0, 0.6, 0.8, 1.0, 1.2, 1.5, 2, 3, 5, 10],
    cd: [0.47, 0.5, 0.6, 0.85, 0.98, 1.02, 1.0, 0.96, 0.93, 0.92],
    fm: 2.1,
  },
  // A tumbling bluff body, on its average area (a quarter of its surface).
  bluff: {
    mach: [0, 0.6, 0.8, 1.0, 1.2, 1.5, 2, 3, 5, 10],
    cd: [1.0, 1.02, 1.08, 1.3, 1.4, 1.4, 1.35, 1.3, 1.25, 1.25],
    fm: 2.3,
  },
  // A fluttering coin (a penny falls at about 11 m/s).
  disc: {
    mach: [0, 0.6, 0.8, 1.0, 1.2, 1.5, 2, 3, 5, 10],
    cd: [1.8, 1.8, 1.85, 1.95, 1.9, 1.8, 1.7, 1.65, 1.6, 1.6],
    fm: 2.3,
  },
  // A long rod flying point-first: nose, base and skin friction on 20 diameters of length.
  slender: {
    mach: [0, 0.6, 0.8, 1.0, 1.2, 1.5, 2, 3, 5, 10, 20],
    cd: [0.4, 0.4, 0.42, 0.6, 0.62, 0.58, 0.5, 0.42, 0.34, 0.3, 0.28],
    fm: 6,
  },
};

function lerpTable(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  for (let k = 1; k < xs.length; k++) if (x < xs[k]) return ys[k - 1] + ((ys[k] - ys[k - 1]) * (x - xs[k - 1])) / (xs[k] - xs[k - 1]);
  return ys[ys.length - 1];
}

/** Drag coefficient at a Mach and Knudsen number (sin² bridging between 10⁻³ and 10). */
export function dragCoefficient(kind: DragKind, mach: number, kn: number): number {
  const c = CD[kind];
  const cont = lerpTable(c.mach, c.cd, mach);
  if (kn <= 1e-3) return cont;
  if (kn >= 10) return c.fm;
  const s = dm.sin(Math.PI * (3 / 8 + dm.log(kn) / Math.LN10 / 8));
  return cont + (c.fm - cont) * s * s;
}

/** Tauber–Sutton radiative heating for Earth: f(V) in W/cm² (V in m/s). */
const RAD_V = [9000, 9250, 9500, 9750, 10000, 10250, 10500, 10750, 11000, 11500, 12000, 12500, 13000, 13500, 14000, 14500, 15000, 15500, 16000];
const RAD_F = [1.5, 4.3, 9.7, 19.5, 35, 55, 81, 115, 151, 238, 359, 495, 660, 850, 1065, 1313, 1550, 1780, 2040];

export function radiativeFlux(v: number, rho: number, rn: number): number {
  if (v < 9000 || rho <= 0) return 0;
  const f = v <= 16000 ? lerpTable(RAD_V, RAD_F, v) : 2040 * dm.pow(v / 16000, 4.5);
  const a = Math.min(1, 1.072e6 * dm.pow(v, -1.88) * dm.pow(rho, -0.325));
  return 4.736e4 * dm.pow(rn, a) * dm.pow(rho, 1.22) * f * 1e4;
}

/** Largest share of the oncoming air's kinetic energy flux that reaches the surface. */
function lambdaMax(kn: number): number {
  if (kn <= 1e-3) return 0.1;
  if (kn >= 10) return 1;
  const s = dm.sin(Math.PI * (3 / 8 + dm.log(kn) / Math.LN10 / 8));
  return 0.1 + 0.9 * s * s;
}

/** Stagnation-point heat transfer coefficient (kg/m²·s): Sutton–Graves, q = C·(h₀ − h_wall). */
const heatCoeff = (rho: number, v: number, rn: number) => 3.483e-4 * Math.sqrt(rho / rn) * v;

export interface Start {
  mode: StartMode;
  /** Release altitude (m): dropped from rest there, or the orbit the burn is made from. */
  altitude: number;
  /** Angle below the horizon at 120 km (degrees): orbit and meteor starts. */
  angle: number;
  /** Speed at 120 km (m/s): meteor starts. */
  speed: number;
}

/** A body in flight, as it is now. */
interface Live {
  body: Body;
  mass: number;
  /** Size relative to the body as specified (shrinks as it ablates). */
  k: number;
  shape: Shape;
  /** Temperatures through the surface layer (K), outermost first; layer thicknesses (m). */
  T: Float64Array;
  dx: Float64Array;
  recess: number;
  /** Pancaking rock: its width, how fast that grows, and the width it broke at. */
  pancake: { L: number; Ldot: number; L0: number } | null;
}

const LAYERS = 12;

function live(body: Body, T0: number): Live {
  // How deep to model: its skin, or into a solid as far as heat soaks in a fall (≤ 25 cm).
  const depth = body.shell ?? Math.min(0.25, thinnest(body.shape) / 2);
  const ratio = 1.35;
  const first = (depth * (ratio - 1)) / (dm.pow(ratio, LAYERS) - 1);
  const dx = new Float64Array(LAYERS);
  for (let i = 0; i < LAYERS; i++) dx[i] = first * dm.pow(ratio, i);
  return {
    body,
    mass: body.mass,
    k: 1,
    shape: body.shape,
    T: new Float64Array(LAYERS).fill(T0),
    dx,
    recess: 0,
    pancake: null,
  };
}

/** Area facing the flow (m²), size for the Knudsen number (m), and nose radius (m). */
function geometry(b: Live): { A: number; L: number; rn: number } {
  if (b.pancake)
    return {
      A: (Math.PI * b.pancake.L * b.pancake.L) / 4,
      L: b.pancake.L,
      rn: b.pancake.L / 2,
    };
  const s = b.shape;
  if (b.body.attitude === 'nose' && s.kind === 'cyl') return { A: (Math.PI * s.d * s.d) / 4, L: s.d, rn: s.d / 4 };
  const A = b.body.area ? b.body.area * b.k * b.k : surfaceArea(s) / 4;
  return { A, L: Math.sqrt(A), rn: 0.5 * Math.sqrt((4 * A) / Math.PI) };
}

export type PhaseId = 0 | 1 | 2 | 3;
/** 0 intact, 1 broken up (following its core), 2 a rock flattening, 3 a fragment after a burst. */

export interface TrajEvent {
  kind: 'entry' | 'peakHeat' | 'peakTemp' | 'maxG' | 'maxQ' | 'maxSpeed' | 'melt' | 'breakup' | 'airburst' | 'subsonic' | 'impact' | 'burnup';
  t: number;
  alt: number;
  v: number;
  value?: number;
  /** For a breakup: why. */
  cause?: 'pressure' | 'burn-through';
}

export interface Trajectory {
  /** Sample arrays, one entry per step. */
  t: number[];
  /** Polar position (m, rad) and altitude (m). */
  r: number[];
  th: number[];
  h: number[];
  /** Speed through the air (m/s), and its horizontal and downward parts. */
  v: number[];
  vh: number[];
  vd: number[];
  mach: number[];
  /** Dynamic pressure (Pa), heat flux at the nose (W/m²), surface and shock-layer temperature (K). */
  q: number[];
  heat: number[];
  Ts: number[];
  Tshock: number[];
  /** Deceleration in g, mass (kg), size relative to the start of its phase, phase. */
  g: number[];
  mass: number[];
  k: number[];
  phase: PhaseId[];
  /** Pancaking width (m), 0 if not. */
  L: number[];
  rho: number[];
  events: TrajEvent[];
  /** How it ended: hit the ground, or burned up completely. */
  end: 'impact' | 'burnup';
  impact: {
    t: number;
    v: number;
    angle: number;
    mass: number;
    th: number;
    count: number;
    body: Body;
    shape: Shape;
    L: number;
  } | null;
  /** The burst, for rocks that explode in the air. */
  airburst: {
    t: number;
    alt: number;
    v: number;
    energy: number;
    th: number;
  } | null;
  breakup: {
    t: number;
    alt: number;
    cause: 'pressure' | 'burn-through';
    core: Body | null;
    count: number;
    debris: number;
  } | null;
  start: { v: number; mode: StartMode; altitude: number };
  /** Hottest the surface got (K) and when; most mass lost to ablation (fraction). */
  maxTs: number;
  massLost: number;
  m0: number;
}

/** The deorbit: a retro burn from a circular orbit so the path crosses 120 km at `angle` below horizontal. */
function deorbit(r0: number, angleDeg: number): number {
  const re = R_EARTH + ENTRY_INTERFACE;
  const target = (angleDeg * Math.PI) / 180;
  // Flight-path angle at re for an ellipse with apoapsis r0 and periapsis rp (steeper as rp drops).
  const gammaAt = (rp: number) => {
    const a = (r0 + rp) / 2;
    const h = Math.sqrt(MU * ((2 * r0 * rp) / (r0 + rp)));
    const ve = Math.sqrt(MU * (2 / re - 1 / a));
    const c = Math.min(1, h / (re * ve));
    return dm.atan2(Math.sqrt(1 - c * c), c);
  };
  let lo = 1;
  let hi = re;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (gammaAt(mid) > target) lo = mid;
    else hi = mid;
  }
  const rp = (lo + hi) / 2;
  // Speed at apoapsis.
  return Math.sqrt((2 * MU * rp) / (r0 * (r0 + rp)));
}

export interface SimOptions {
  /** Starting temperature (K). */
  T0?: number;
  /** Give up after this much simulated time (s). */
  maxT?: number;
}

/** Integrate a fall. Deterministic: same inputs, same numbers everywhere. */
export function simulate(body: Body, start: Start, opts: SimOptions = {}): Trajectory {
  const T0 = opts.T0 ?? 290;
  let b = live(body, T0);
  // Position and velocity, inertial, in the equatorial plane (prograde = counter-clockwise).
  let x: number;
  let y: number;
  let vx: number;
  let vy: number;
  if (start.mode === 'drop') {
    const r0 = R_EARTH + start.altitude;
    x = 0;
    y = r0;
    // At rest above the ground: it turns with the Earth.
    vx = -OMEGA * r0;
    vy = 0;
  } else if (start.mode === 'orbit') {
    const r0 = R_EARTH + Math.max(start.altitude, ENTRY_INTERFACE + 30_000);
    x = 0;
    y = r0;
    vx = -deorbit(r0, start.angle);
    vy = 0;
  } else {
    // A meteor: placed 80 km before it reaches 120 km, on the straight line in at its entry angle,
    // with the speed it has there (gravity barely bends a path at these speeds over 80 km).
    const re = R_EARTH + ENTRY_INTERFACE;
    const g = (start.angle * Math.PI) / 180;
    // Entry point at the top (0, re); flying in the −x direction and down.
    const dirx = -dm.cos(g);
    const diry = -dm.sin(g);
    // Back along the path until 200 km up.
    const rs = R_EARTH + 200_000;
    // |p - s·dir| = rs, p = (0, re): s² - 2s(p·dir) + re² - rs² = 0 (take the root behind).
    const pd = re * diry;
    const s = pd + Math.sqrt(pd * pd - (re * re - rs * rs));
    x = -s * dirx;
    y = re - s * diry;
    const vs = Math.sqrt(start.speed * start.speed - 2 * MU * (1 / re - 1 / rs));
    vx = vs * dirx;
    vy = vs * diry;
  }
  const tr: Trajectory = {
    t: [],
    r: [],
    th: [],
    h: [],
    v: [],
    vh: [],
    vd: [],
    mach: [],
    q: [],
    heat: [],
    Ts: [],
    Tshock: [],
    g: [],
    mass: [],
    k: [],
    phase: [],
    L: [],
    rho: [],
    events: [],
    end: 'impact',
    impact: null,
    airburst: null,
    breakup: null,
    start: { v: 0, mode: start.mode, altitude: start.altitude },
    maxTs: T0,
    massLost: 0,
    m0: body.mass,
  };
  const ev = (e: TrajEvent) => tr.events.push(e);
  let phase: PhaseId = 0;
  let t = 0;
  const maxT = opts.maxT ?? 6 * 3600;
  // Running extremes.
  let peakHeat: TrajEvent | null = null;
  let peakTemp: TrajEvent | null = null;
  let maxG: TrajEvent | null = null;
  let maxQ: TrajEvent | null = null;
  let maxSpeed: TrajEvent | null = null;
  let melted = false;
  let entered = false;
  let wasSuper = false;
  let subsonicAt: TrajEvent | null = null;

  /** Acceleration (inertial) at a state, with the body as it is now. */
  const accel = (px: number, py: number, qx: number, qy: number): [number, number] => {
    const r = Math.sqrt(px * px + py * py);
    const gk = -MU / (r * r * r);
    let ax = gk * px;
    let ay = gk * py;
    const h = r - R_EARTH;
    if (h < 1_200_000) {
      const a = air(h);
      if (a.rho > 1e-16) {
        const ux = qx + OMEGA * py;
        const uy = qy - OMEGA * px;
        const v = Math.sqrt(ux * ux + uy * uy);
        if (v > 1e-6) {
          const geo = geometry(b);
          const cd = dragCoefficient(b.pancake ? 'sphere' : b.body.drag, v / a.a, a.mfp / geo.L);
          const f = (0.5 * a.rho * v * cd * geo.A) / b.mass;
          ax -= f * ux;
          ay -= f * uy;
        }
      }
    }
    return [ax, ay];
  };

  // Implicit conduction scratch.
  const lo = new Float64Array(LAYERS);
  const di = new Float64Array(LAYERS);
  const up = new Float64Array(LAYERS);
  const rhs = new Float64Array(LAYERS);

  let prev: { t: number; h: number } | null = null;
  let lastRec = -Infinity;
  let lastPhase: PhaseId = 0;
  for (let step = 0; ; step++) {
    let switched = false;
    const r = Math.sqrt(x * x + y * y);
    const h = r - R_EARTH;
    const a = air(h);
    const ux = vx + OMEGA * y;
    const uy = vy - OMEGA * x;
    const v = Math.sqrt(ux * ux + uy * uy);
    // Downward and horizontal parts of the air-relative velocity.
    const rx = x / r;
    const ry = y / r;
    const vd = -(ux * rx + uy * ry);
    const vh = Math.abs(ux * -ry + uy * rx);
    const geo = geometry(b);
    const mach = v / a.a;
    const cd = dragCoefficient(b.pancake ? 'sphere' : b.body.drag, mach, a.mfp / geo.L);
    const q = 0.5 * a.rho * v * v;
    const decel = (q * cd * geo.A) / b.mass / G0;
    const matNow = MATERIALS[b.body.material];

    // Heating at the nose: in W/m², positive into the surface (before re-radiation).
    const Tw = b.T[0];
    const h0 = CP_AIR * a.T + 0.5 * v * v;
    const C = heatCoeff(a.rho, v, geo.rn);
    let qConv = C * (h0 - CP_AIR * Tw);
    const qRad = radiativeFlux(v, a.rho, geo.rn);
    // Never more than a share of the energy the oncoming air brings: all of it in free-molecular
    // flow, a tenth in dense air, where a shock layer stands off the surface (the heat-transfer
    // coefficient Λ of meteor physics, ≲ 0.1 for large bodies low down; Ceplecha & ReVelle 2005).
    const cap = lambdaMax(a.mfp / geo.L) * 0.5 * a.rho * v * v * v;
    if (qConv + qRad > cap) qConv = Math.max(-cap, cap - qRad);
    const qIn = qConv + qRad;
    const Tshock = v > 300 ? shockTemperature(v, a.T) : a.T;

    // Recorded every 20 ms of fall at most (and always at the ground and when it changes).
    const rec = step === 0 || t - lastRec >= 0.02 || phase !== lastPhase || h <= 0;
    if (rec) {
      lastRec = t;
      lastPhase = phase;
      tr.t.push(t);
      tr.r.push(r);
      tr.th.push(dm.atan2(y, x));
      tr.h.push(h);
      tr.v.push(v);
      tr.vh.push(vh);
      tr.vd.push(vd);
      tr.mach.push(a.rho > 1e-9 ? mach : 0);
      tr.q.push(q);
      tr.heat.push(Math.max(0, qIn));
      tr.Ts.push(Tw);
      tr.Tshock.push(Tshock);
      tr.g.push(decel);
      tr.mass.push(b.mass);
      tr.k.push(b.k);
      tr.phase.push(phase);
      tr.L.push(b.pancake?.L ?? 0);
      tr.rho.push(a.rho);
    }
    if (step === 0) tr.start.v = v;

    // Events.
    const here = { t, alt: h, v };
    if (!entered && h <= KARMAN && prev) {
      entered = true;
      ev({ kind: 'entry', ...here });
    }
    if (h < KARMAN) {
      if (!peakHeat || qIn > (peakHeat.value ?? 0)) peakHeat = { kind: 'peakHeat', ...here, value: qIn };
      if (!maxG || decel > (maxG.value ?? 0)) maxG = { kind: 'maxG', ...here, value: decel };
      if (!maxQ || q > (maxQ.value ?? 0)) maxQ = { kind: 'maxQ', ...here, value: q };
    }
    if (!peakTemp || Tw > (peakTemp.value ?? 0)) peakTemp = { kind: 'peakTemp', ...here, value: Tw };
    if (!maxSpeed || v > maxSpeed.v) maxSpeed = { kind: 'maxSpeed', ...here, value: v };
    if (a.rho > 1e-6 && mach > 1.05) wasSuper = true;
    if (wasSuper && !subsonicAt && mach < 1 && a.rho > 1e-6) subsonicAt = { kind: 'subsonic', ...here };
    if (Tw > tr.maxTs) tr.maxTs = Tw;

    // Ground: interpolate to where it crossed.
    if (h <= 0 && prev) {
      const u = prev.h / (prev.h - h);
      const ti = prev.t + (t - prev.t) * u;
      const angle = (dm.atan2(Math.max(0, vd), vh) * 180) / Math.PI;
      tr.impact = {
        t: ti,
        v,
        angle,
        mass: b.mass,
        th: dm.atan2(y, x),
        count: phase === 1 && tr.breakup ? tr.breakup.count : 1,
        body: b.body,
        shape: b.shape,
        L: b.pancake?.L ?? 0,
      };
      ev({ kind: 'impact', t: ti, alt: 0, v });
      // The last sample sits exactly on the ground.
      const n = tr.t.length - 1;
      tr.t[n] = ti;
      tr.h[n] = 0;
      break;
    }
    if (t > maxT) {
      tr.end = 'burnup';
      break;
    }

    // Breakup.
    if (phase === 0 && body.breakup) {
      const burnt = b.body.shell !== undefined && b.recess >= b.body.shell;
      if (q > b.body.strength || burnt) {
        const cause = burnt && q <= b.body.strength ? 'burn-through' : 'pressure';
        ev({ kind: 'breakup', ...here, cause, value: q });
        if (body.breakup.kind === 'core') {
          const core = body.breakup.core;
          tr.breakup = {
            t,
            alt: h,
            cause,
            core,
            count: body.breakup.count,
            debris: body.breakup.debris,
          };
          const T = b.T[LAYERS - 1];
          b = live(core, Math.min(T0 + 40, T));
          phase = 1;
          switched = true;
        } else {
          tr.breakup = { t, alt: h, cause, core: null, count: 1, debris: 40 };
          const L0 = geo.L;
          b.pancake = { L: L0 * 1.0, Ldot: 0, L0 };
          phase = 2;
        }
      }
    }
    // Pancake: the crushed rock spreads sideways under the pressure difference across it.
    if (b.pancake && phase === 2) {
      const p = b.pancake;
      const rhoM = MATERIALS[b.body.material].rho;
      if (p.L >= 7 * p.L0) {
        // Nearly all its motion energy goes into the air here (what the fragments keep is tiny).
        const energy = 0.5 * b.mass * v * v;
        tr.airburst = { t, alt: h, v, energy, th: dm.atan2(y, x) };
        ev({ kind: 'airburst', ...here, value: energy });
        // What reaches the ground: the largest fragment, a solid stone.
        const frac = body.breakup?.kind === 'pancake' ? body.breakup.fragment : 0.01;
        const m = Math.min(b.mass, frac * body.mass);
        const d = dm.pow((6 * m) / (Math.PI * rhoM), 1 / 3);
        b = live(
          {
            name: 'largest fragment',
            mass: m,
            shape: { kind: 'sphere', d },
            attitude: 'tumble',
            drag: 'sphere',
            material: body.material,
            strength: 1e9,
          },
          T0,
        );
        phase = 3;
        switched = true;
      }
    }

    // Step size: a second while the air barely touches it; then ~100 m of travel and a small part
    // of the drag's time scale.
    const aDrag = decel * G0;
    let dt = aDrag < 1e-4 && Math.abs(qIn) < 500 ? 1 : Math.min(0.5, 100 / Math.max(v, 1), aDrag > 1e-9 ? (0.1 * v) / aDrag : 0.5);
    if (b.pancake && phase === 2) dt = Math.min(dt, 0.02);
    dt = Math.max(dt, 0.001);

    // RK4 on position and velocity.
    const [a1x, a1y] = accel(x, y, vx, vy);
    const [a2x, a2y] = accel(x + 0.5 * dt * vx, y + 0.5 * dt * vy, vx + 0.5 * dt * a1x, vy + 0.5 * dt * a1y);
    const v2x = vx + 0.5 * dt * a1x;
    const v2y = vy + 0.5 * dt * a1y;
    const [a3x, a3y] = accel(x + 0.5 * dt * v2x, y + 0.5 * dt * v2y, vx + 0.5 * dt * a2x, vy + 0.5 * dt * a2y);
    const v3x = vx + 0.5 * dt * a2x;
    const v3y = vy + 0.5 * dt * a2y;
    const [a4x, a4y] = accel(x + dt * v3x, y + dt * v3y, vx + dt * a3x, vy + dt * a3y);
    const v4x = vx + dt * a3x;
    const v4y = vy + dt * a3y;
    prev = { t, h };
    x += (dt / 6) * (vx + 2 * v2x + 2 * v3x + v4x);
    y += (dt / 6) * (vy + 2 * v2y + 2 * v3y + v4y);
    vx += (dt / 6) * (a1x + 2 * a2x + 2 * a3x + a4x);
    vy += (dt / 6) * (a1y + 2 * a2y + 2 * a3y + a4y);
    t += dt;

    if (b.pancake && phase === 2) {
      const p = b.pancake;
      const rhoM = MATERIALS[b.body.material].rho;
      p.Ldot += ((cd * a.rho * v * v) / (rhoM * p.L)) * dt;
      p.L += p.Ldot * dt;
    }

    // Heat into the surface: implicit conduction, the outer face taking qIn − εσT⁴ (linearised).
    // (Not on the step it broke up: the heating above was worked out for the body before.)
    if (!switched) {
      const m = matNow;
      const T = b.T;
      const dx = b.dx;
      const eps = m.emissivity;
      const F = qIn - eps * SIGMA * Tw * Tw * Tw * Tw;
      const dF = -C * CP_AIR - 4 * eps * SIGMA * Tw * Tw * Tw;
      for (let i = 0; i < LAYERS; i++) {
        const cap_ = (m.rho * m.cp * dx[i]) / dt;
        const gl = i > 0 ? m.k / ((dx[i - 1] + dx[i]) / 2) : 0;
        const gr = i < LAYERS - 1 ? m.k / ((dx[i] + dx[i + 1]) / 2) : 0;
        lo[i] = -gl;
        up[i] = -gr;
        di[i] = cap_ + gl + gr;
        rhs[i] = cap_ * T[i];
      }
      di[0] -= dF;
      rhs[0] += F - dF * Tw;
      // Thomas algorithm.
      for (let i = 1; i < LAYERS; i++) {
        const w = lo[i] / di[i - 1];
        di[i] -= w * up[i - 1];
        rhs[i] -= w * rhs[i - 1];
      }
      T[LAYERS - 1] = rhs[LAYERS - 1] / di[LAYERS - 1];
      for (let i = LAYERS - 2; i >= 0; i--) T[i] = (rhs[i] - up[i] * T[i + 1]) / di[i];
      // Past the melting point: the heat above it carries molten surface away (a flattening cloud
      // of rubble is followed as a whole, as in the pancake model: it doesn't ablate).
      if (T[0] > m.tAbl && phase === 2) T[0] = m.tAbl;
      if (T[0] > m.tAbl) {
        let excess = 0;
        for (let i = 0; i < LAYERS; i++) {
          if (T[i] <= m.tAbl) break;
          excess += m.rho * m.cp * dx[i] * (T[i] - m.tAbl);
          T[i] = m.tAbl;
        }
        const latent = Math.max(2e5, m.qAbl - m.cp * (m.tAbl - T0));
        const perArea = excess / latent;
        // Averaged over the face toward the flow, the heating is about half the nose's.
        const dm_ = Math.min(b.mass * 0.999, perArea * geo.A * 0.5);
        if (dm_ > 0) {
          if (!melted) {
            melted = true;
            ev({ kind: 'melt', ...here });
          }
          const before = b.mass;
          b.mass -= dm_;
          const s = perArea / m.rho;
          b.recess += s;
          if (b.body.attitude === 'nose' && b.shape.kind === 'cyl') {
            b.shape = {
              ...b.shape,
              l: Math.max(b.shape.d, b.shape.l * (b.mass / before)),
            };
          } else if (!b.pancake) {
            const kk = dm.pow(b.mass / b.body.mass, 1 / 3);
            b.k = kk;
            b.shape = scaleShape(b.body.shape, kk);
          }
          // The exposed layer is deeper, cooler material: shift the temperatures outward by s. The
          // face itself stays molten.
          shiftProfile(T, dx, s);
          T[0] = m.tAbl;
        }
      }
    }
    if (b.mass < body.mass * 1e-6 || b.mass < 1e-7) {
      tr.end = 'burnup';
      ev({ kind: 'burnup', t, alt: h, v });
      break;
    }
  }
  for (const e of [peakHeat, peakTemp, maxG, maxQ, maxSpeed, subsonicAt]) if (e) ev(e);
  tr.events.sort((p, q) => p.t - q.t);
  const last = tr.mass[tr.mass.length - 1];
  tr.massLost = 1 - (tr.impact ? tr.impact.mass * tr.impact.count : last) / body.mass;
  return tr;
}

/** Move a temperature profile outward by `s` (the surface receded): each layer takes the value s deeper. */
function shiftProfile(T: Float64Array, dx: Float64Array, s: number) {
  const n = T.length;
  const centres = new Float64Array(n);
  let z = 0;
  for (let i = 0; i < n; i++) {
    centres[i] = z + dx[i] / 2;
    z += dx[i];
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const zz = centres[i] + s;
    let j = 0;
    while (j < n - 1 && centres[j + 1] < zz) j++;
    if (j >= n - 1) out[i] = T[n - 1];
    else {
      const u = Math.max(0, Math.min(1, (zz - centres[j]) / (centres[j + 1] - centres[j])));
      out[i] = T[j] + (T[j + 1] - T[j]) * u;
    }
  }
  T.set(out);
}

/** Index of the last sample at or before time t. */
export function sampleIndex(tr: Trajectory, t: number): number {
  let lo = 0;
  let hi = tr.t.length - 1;
  if (t >= tr.t[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr.t[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface Sample {
  t: number;
  h: number;
  th: number;
  r: number;
  v: number;
  vh: number;
  vd: number;
  mach: number;
  q: number;
  heat: number;
  Ts: number;
  Tshock: number;
  g: number;
  mass: number;
  k: number;
  phase: PhaseId;
  L: number;
  rho: number;
}

/** The fall at a time (interpolated between steps). */
export function sampleAt(tr: Trajectory, t: number): Sample {
  const i = sampleIndex(tr, t);
  const j = Math.min(tr.t.length - 1, i + 1);
  const span = tr.t[j] - tr.t[i];
  const u = span > 0 ? Math.max(0, Math.min(1, (t - tr.t[i]) / span)) : 0;
  const L = (a: number[]) => a[i] + (a[j] - a[i]) * u;
  return {
    t: Math.min(t, tr.t[tr.t.length - 1]),
    h: L(tr.h),
    th: L(tr.th),
    r: L(tr.r),
    v: L(tr.v),
    vh: L(tr.vh),
    vd: L(tr.vd),
    mach: L(tr.mach),
    q: L(tr.q),
    heat: L(tr.heat),
    Ts: L(tr.Ts),
    Tshock: L(tr.Tshock),
    g: L(tr.g),
    mass: L(tr.mass),
    k: L(tr.k),
    phase: tr.phase[u < 1 ? i : j],
    L: L(tr.L),
    rho: L(tr.rho),
  };
}

/** Speed it would settle at in this air if it fell long enough (m/s). */
export function terminalSpeed(body: Body, mass: number, rho: number, k = 1): number {
  const A = body.area ? body.area * k * k : body.attitude === 'nose' && body.shape.kind === 'cyl' ? (Math.PI * body.shape.d * body.shape.d) / 4 : surfaceArea(scaleShape(body.shape, k)) / 4;
  return Math.sqrt((2 * mass * G0) / (rho * CD[body.drag].cd[0] * A));
}

export const findEvent = (tr: Trajectory, kind: TrajEvent['kind']) => tr.events.find((e) => e.kind === kind) ?? null;
