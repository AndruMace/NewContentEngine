import * as dm from '@sim/physics/math';
import { CHANNEL_W, WALL_H, WOOD_T, channel, post } from '../parts';
import { ID_Q, MARBLE_R, quatAxis, v3 } from '../sim';
import { X_MAX, X_MIN, Z, across, backstop, catchFunnel, lipCheck, type Ctx, type ModuleDef, type Placed } from './common';

// ——— Start: a marble held by a gate at the top of a long ramp ———

export const START = {
  kind: 'start',
  build(ctx: Ctx): { placed: Placed; marble: number } {
    const { sim, rng } = ctx;
    const dir = rng.chance(0.5) ? 1 : -1;
    const x0 = dir > 0 ? X_MIN : X_MAX;
    const x1 = dir > 0 ? X_MAX : X_MIN;
    const slope = rng.range(0.04, 0.06);
    const from = v3(x0, 0, 0);
    const to = v3(x1, -Math.abs(x1 - x0) * dm.sin(slope), 0);
    channel(sim, from, to, { closedStart: true });
    // The gate: a thin flap hinged above the channel, swung up out of the way by a cam.
    const gx = x0 + dir * 0.07;
    const floorAt = (x: number) => from.y + ((x - x0) / (x1 - x0)) * (to.y - from.y);
    const pivot = v3(gx, floorAt(gx) + WALL_H + 0.012, 0);
    const gate = sim.addBody(pivot, ID_Q, [{ piece: { shape: { kind: 'box', hx: 0.002, hy: 0.018, hz: CHANNEL_W / 2 - 0.001 }, finish: 'paint', hue: ctx.hue(), pos: v3(0, -0.018, 0), rot: ID_Q }, material: 'wood', tag: 'gate' }], { kinematic: true });
    const mx = gx - dir * (0.002 + MARBLE_R + 0.0005);
    const marble = sim.addMarble(v3(mx, floorAt(mx) + MARBLE_R + 0.0002, 0), ctx.marble, ctx.hue());
    const openAt = Math.round(rng.range(0.6, 0.9) / (1 / 240));
    let opened = false;
    const check = lipCheck(marble, to, dir, to.y - 0.4, backstop(sim, to, dir));
    return {
      marble,
      placed: {
        kind: 'start',
        tick(s) {
          const u = Math.min(1, Math.max(0, (s.step - openAt) / 70));
          if (u > 0 && !opened) {
            opened = true;
            s.emit('gate', { x: gx });
          }
          // Swing the flap's foot downstream, up and out of the marble's way.
          const a = dir * (Math.PI * 0.55) * (u * u * (3 - 2 * u));
          s.body(gate).setNextKinematicRotation(quatAxis(Z, a));
        },
        check: (s) => check(s),
        timeout: 8,
      },
    };
  },
};

// ——— Ramp: a catch funnel into a long, gently sloping wooden channel back across ———

export const RAMP: ModuleDef = {
  kind: 'ramp',
  showpiece: false,
  build(ctx, e) {
    const { sim, rng } = ctx;
    const dir = across(e.at.x);
    const hole = catchFunnel(ctx, e, rng.range(0.05, 0.09));
    const start = v3(hole.x - dir * 0.012, hole.y - 0.03, hole.z);
    const x1 = dir > 0 ? X_MAX : X_MIN;
    const slope = rng.range(0.035, 0.06);
    const end = v3(x1, start.y - Math.abs(x1 - start.x) * dm.sin(slope), start.z);
    channel(sim, start, end, { closedStart: true, finish: rng.chance(0.5) ? 'maple' : 'walnut' });
    post(sim, end.x - dir * 0.03, end.z - 0.03, end.y - 0.06, end.y - WOOD_T);
    const check = lipCheck(e.marble, end, dir, end.y - 0.4, backstop(sim, end, dir));
    return { kind: 'ramp', check: (s) => check(s), timeout: 7 };
  },
};

