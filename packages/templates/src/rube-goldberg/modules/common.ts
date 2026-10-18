/**
 * Shared pieces for machine modules. Each takes the marble arriving from the module above (where it left and how fast)
 * and builds itself below: a catch funnel where the marble will actually come down, then its
 * contraption, ending at an exit lip on the far side. The generator simulates it and checks it
 * hands off; if it doesn't, the module is rolled back and tried again differently.
 */
import type { Rng } from '@sim/engine';
import { WOOD_T, funnel, landing, post } from '../parts';
import * as dm from '@sim/physics/math';
import { ID_Q, MARBLE_R, quatAxis, v3, type Sim, type TapeEvent, type V3 } from '../sim';

/** The machine's width (marble runs cross between these) and depth. */
export const X_MIN = -0.3;
export const X_MAX = 0.3;

export interface Entry {
  marble: number;
  at: V3;
  vel: V3;
  /** Where the next catch should go, when the stage above aims its marble (e.g. off a backstop). */
  catchAt?: V3;
}

export interface Ctx {
  sim: Sim;
  rng: Rng;
  marble: 'glass' | 'steel';
  hue(): number;
}

export interface Placed {
  kind: string;
  /** Before each physics step (drive kinematic parts). */
  tick?(sim: Sim): void;
  /** After each step: the marble that carries on (handed off), 'fail', or null to keep going. */
  check(sim: Sim, events: TapeEvent[]): Entry | 'fail' | null;
  /** Seconds it may take before it counts as a failure. */
  timeout: number;
}

export interface ModuleDef {
  kind: string;
  /** A centrepiece (camera lingers; spread these out). */
  showpiece: boolean;
  finale?: boolean;
  /** Finicky modules: how many times to try fresh parameters before giving up on this kind here. */
  tries?: number;
  build(ctx: Ctx, entry: Entry): Placed;
}

export const Z = v3(0, 0, 1);

export function state(sim: Sim, marble: number): Entry {
  const b = sim.body(marble);
  const t = b.translation();
  const v = b.linvel();
  return { marble, at: v3(t.x, t.y, t.z), vel: v3(v.x, v.y, v.z) };
}

/** Standard watchdog: handed off once past the lip; failed if fallen well below it or stalled. */
export function lipCheck(marble: number, lip: V3, dir: number, floor: number, catchAt?: V3) {
  let still = 0;
  return (sim: Sim): Entry | 'fail' | null => {
    const s = state(sim, marble);
    if ((s.at.x - lip.x) * dir > 0.004 && s.at.y > lip.y - 0.05) return { ...s, catchAt };
    if (s.at.y < floor) return 'fail';
    const v = Math.sqrt(s.vel.x * s.vel.x + s.vel.y * s.vel.y + s.vel.z * s.vel.z);
    still = v < 0.004 ? still + 1 : 0;
    return still > 300 ? 'fail' : null;
  };
}

/** A catch funnel under where the marble will land, returning its hole. */
export function catchFunnel(ctx: Ctx, e: Entry, drop: number): V3 {
  const rTop = 0.055;
  const top = e.at.y - drop;
  const land = e.catchAt ?? landing(e.at, e.vel, top + MARBLE_R * 0.5).at;
  const x = land.x;
  // Enamelled funnels mostly (a big polished metal bowl just mirrors the key light), some brass.
  const hole = funnel(ctx.sim, v3(x, top, land.z), rTop, MARBLE_R + 0.006, 0.042, ctx.rng.chance(0.7) ? 'paint' : 'brass', 40, ctx.hue());
  // A fast marble flying in would bounce off the funnel's far side and out: a backboard on the far
  // rim stops it dead, and it drops in.
  const hv = Math.sqrt(e.vel.x * e.vel.x + e.vel.z * e.vel.z);
  if (!e.catchAt && hv > 0.45) {
    const ux = e.vel.x / hv;
    const uz = e.vel.z / hv;
    const yaw = dm.atan2(-uz, ux);
    ctx.sim.addStatic(
      { shape: { kind: 'box', hx: 0.004, hy: 0.045, hz: 0.065, round: 0.002 }, finish: 'walnut', pos: v3(x + ux * (rTop + 0.006), top + 0.03, land.z + uz * (rTop + 0.006)), rot: quatAxis(v3(0, 1, 0), yaw) },
      'wood',
      'backboard',
    );
  }
  post(ctx.sim, x + 0.045, land.z - 0.05, hole.y - 0.05, top);
  return hole;
}

/**
 * A backstop plate just past a channel's lip: the marble flies off, clacks into it and drops almost
 * straight down. Returns where the next catch should sit.
 */
export function backstop(sim: Sim, lip: V3, dir: number, above = 0.03): V3 {
  const x = lip.x + dir * 0.05;
  const top = lip.y + above;
  const bottom = lip.y - 0.07;
  sim.addStatic({ shape: { kind: 'box', hx: WOOD_T / 2, hy: (top - bottom) / 2, hz: 0.035, round: 0.002 }, finish: 'walnut', pos: v3(x + dir * (WOOD_T / 2), (top + bottom) / 2, lip.z), rot: ID_Q }, 'wood', 'backstop');
  return v3(lip.x + dir * 0.022, lip.y, lip.z);
}

/** The direction to head next: back across the machine, away from the side we're on. */
export const across = (x: number) => (x > 0 ? -1 : 1);

