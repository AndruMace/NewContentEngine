/**
 * More contraptions: a coin-style vortex funnel, a steel-rail spiral, a seesaw catapult, a paddle
 * wheel and a Newton's cradle. All real rigid bodies and joints.
 */
import * as dm from '@sim/physics/math';
import { CHANNEL_W, channel, landing, post, rail } from '../parts';
import { ID_Q, MARBLE_R, quatAxis, v3, type BodyPiece, type Sim, type V3 } from '../sim';
import { X_MAX, X_MIN, Z, across, backstop, catchFunnel, lipCheck, state, type Entry, type ModuleDef } from './common';

/** Hand off once the marble has dropped clear below `y` (falling free), aiming the next catch under `at`. */
function dropCheck(marble: number, y: number, catchAt: V3 | undefined, floor: number) {
  return (sim: Sim): Entry | 'fail' | null => {
    const s = state(sim, marble);
    if (s.at.y < y && s.vel.y < 0) return catchAt ? { ...s, catchAt: v3(catchAt.x, s.at.y, catchAt.z) } : s;
    return s.at.y < floor ? 'fail' : null;
  };
}

// ——— Vortex: rolled in at the rim, the marble orbits a gravity-well funnel down to the hole ———

export const VORTEX: ModuleDef = {
  kind: 'vortex',
  showpiece: true,
  build(ctx, e) {
    const { sim, rng } = ctx;
    const dir = across(e.at.x);
    const hole = catchFunnel(ctx, e, rng.range(0.05, 0.08));
    const R = rng.range(0.1, 0.13);
    const rHole = MARBLE_R + 0.008;
    const depth = rng.range(0.07, 0.09);
    // The bowl sits a little further along, in the machine plane.
    const c = v3(hole.x + dir * (R + 0.06), hole.y - 0.075, 0);
    // Gravity-well profile: y = top − k·(1/r − 1/R), steepening toward the hole.
    const k = depth / (1 / rHole - 1 / R);
    const rows = 26;
    const segs = 72;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let j = 0; j <= rows; j++) {
      const r = rHole + ((R - rHole) * j) / rows;
      const y = c.y - k * (1 / r - 1 / R);
      for (let s = 0; s < segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        positions.push(c.x + r * dm.cos(a), y, c.z + r * dm.sin(a));
      }
    }
    // A raised rim wall all the way round: the gravity well is nearly flat out here, so without it a
    // marble going round fast just carries on over the edge.
    const wallH = 0.02;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      positions.push(c.x + R * dm.cos(a), c.y + wallH, c.z + R * dm.sin(a));
    }
    for (let j = 0; j < rows + 1; j++)
      for (let s = 0; s < segs; s++) {
        const a = j * segs + s;
        const b = j * segs + ((s + 1) % segs);
        indices.push(a, a + segs, b, b, a + segs, b + segs);
      }
    sim.addStatic({ shape: { kind: 'mesh', positions: new Float32Array(positions), indices: new Uint32Array(indices) }, finish: 'paint', hue: ctx.hue(), pos: v3(0, 0, 0), rot: ID_Q }, 'brass', 'vortex');
    // A feed chute from under the catch funnel, passing over the rim wall and ending just inside it,
    // heading round the bowl: the marble drops onto the bowl already circling.
    const start = v3(hole.x - dir * 0.012, hole.y - 0.03, hole.z);
    const chuteEnd = v3(c.x - dir * 0.015, c.y + wallH + 0.012, c.z + R - CHANNEL_W / 2 - 0.012);
    channel(sim, start, chuteEnd, { closedStart: true, finish: 'walnut' });
    post(sim, c.x, c.z - R - 0.01, c.y - depth - 0.04, c.y);
    const holeY = c.y - depth;
    // It leaves the hole still spinning sideways: place the next catch from its actual flight.
    const drop = dropCheck(e.marble, holeY - 0.04, undefined, holeY - 0.4);
    // It has to go down the hole: falling past the bowl's edge doesn't count.
    const check = (s: Sim) => {
      const m = state(s, e.marble);
      if (m.at.y < c.y - 0.01 && Math.sqrt((m.at.x - c.x) ** 2 + (m.at.z - c.z) ** 2) > R + 0.01) return 'fail' as const;
      return drop(s);
    };
    return { kind: 'vortex', check: (s) => check(s), timeout: 22 };
  },
};

// ——— Spiral: a corkscrew of steel rails round a brass post ———

export const SPIRAL: ModuleDef = {
  kind: 'spiral',
  showpiece: true,
  // Some setups stall a slow marble where the feed meets the rails: try a few.
  tries: 4,
  build(ctx, e) {
    const { sim, rng } = ctx;
    const dir = across(e.at.x);
    const hole = catchFunnel(ctx, e, rng.range(0.05, 0.08));
    const R = rng.range(0.07, 0.09);
    const turns = rng.range(1.6, 2.4);
    // Riding two rails (a smaller rolling radius, more friction) needs a steeper pitch than a channel.
    const slope = rng.range(0.095, 0.115);
    // The helix's axis sits beside the catch; the track starts at its front, heading the way the feed
    // rolls (+dir), and winds down.
    const c = v3(hole.x + dir * (R + 0.03), 0, 0);
    const feedFrom = v3(hole.x - dir * 0.012, hole.y - 0.03, hole.z);
    // A decent drop along the feed, so the marble reaches the rails with some way on it.
    const y0 = feedFrom.y - 0.034 + MARBLE_R;
    const spin = -dir;
    const th0 = Math.PI / 2;
    const at = (th: number, r: number, dy = 0) => v3(c.x + r * dm.cos(th0 + spin * th), y0 - (th * R * dm.sin(slope)) / dm.cos(slope) + dy, c.z + r * dm.sin(th0 + spin * th));
    // A short wooden feed from the catch, its last stretch lined up with the track, so the marble
    // rolls onto the rails along them rather than across them.
    const s0 = at(0, R);
    const endY = y0 - MARBLE_R + 0.002;
    const p = v3(s0.x - dir * 0.045, endY + 0.045 * dm.sin(0.12), s0.z);
    channel(sim, feedFrom, p, { closedStart: true, finish: 'maple' });
    channel(sim, p, v3(s0.x - dir * 0.004, endY, s0.z), { finish: 'maple' });
    // Two running rails under the marble and a guard rail outside it.
    const w = 0.0075;
    const below = Math.sqrt(MARBLE_R * MARBLE_R - w * w) + 0.0025;
    const n = Math.ceil(turns * 30);
    const total = turns * Math.PI * 2;
    for (let s = 0; s < n; s++) {
      const a = (s / n) * total;
      const b = ((s + 1) / n) * total;
      rail(sim, at(a, R - w, -below), at(b, R - w, -below), 0.0025);
      rail(sim, at(a, R + w, -below), at(b, R + w, -below), 0.0025);
      rail(sim, at(a, R + MARBLE_R + 0.004, 0.002), at(b, R + MARBLE_R + 0.004, 0.002), 0.0022);
    }
    const yEnd = at(total, R).y;
    sim.addStatic({ shape: { kind: 'cylinder', r: 0.008, hh: (y0 - yEnd + 0.08) / 2 }, finish: 'brass', pos: v3(c.x, (y0 + yEnd) / 2, c.z), rot: ID_Q }, 'brass', 'post');
    const check = dropCheck(e.marble, yEnd - MARBLE_R - 0.03, undefined, yEnd - 0.45);
    return { kind: 'spiral', check: (s) => check(s), timeout: 9 };
  },
};

// ——— Catapult: the marble drops on a seesaw's raised end and flings a second marble into the air ———

export const CATAPULT: ModuleDef = {
  kind: 'catapult',
  showpiece: true,
  // Whether the throw clears the beam still depends on the details: try a few setups.
  tries: 4,
  build(ctx, e) {
    const { sim, rng } = ctx;
    const dir = across(e.at.x);
    const hole = catchFunnel(ctx, e, rng.range(0.05, 0.08));
    const start = v3(hole.x - dir * 0.012, hole.y - 0.03, hole.z);
    const lip = v3(start.x + dir * 0.08, start.y - 0.08 * dm.sin(0.18), start.z);
    channel(sim, start, lip, { closedStart: true, finish: 'maple' });
    const half = rng.range(0.065, 0.078);
    const tilt = 0.5;
    const dropH = rng.range(0.14, 0.2);
    const pivotY = lip.y - dropH - half * dm.sin(tilt);
    /** The near cup's centre, along the beam from the pivot (on the side the marble comes from). */
    const cupAlong = half - 0.026;
    let beam = -1;
    let marble2 = -1;
    let pivot = v3(0, 0, 0);
    let cupAt = v3(0, 0, 0);
    let angle0 = 0;
    let struck = false;

    // The beam, the second marble and their stand are placed the moment the first marble leaves the
    // lip, when its real speed is known: the near cup goes exactly where it will come down.
    const place = (s: Sim) => {
      const m = state(s, e.marble);
      const cupTopY = pivotY + cupAlong * dm.sin(tilt) + 0.003;
      const land = landing(m.at, m.vel, cupTopY + MARBLE_R);
      pivot = v3(land.at.x + dir * cupAlong * dm.cos(tilt), pivotY, lip.z);
      const rod = (x: number): BodyPiece => ({ piece: { shape: { kind: 'cylinder', r: 0.0028, hh: 0.016 }, finish: 'brass', pos: v3(x, 0.003 + 0.0028, 0), rot: quatAxis(v3(1, 0, 0), Math.PI / 2) }, material: 'brass', tag: 'beam', density: 500 });
      const wall = (x: number, h: number): BodyPiece => ({ piece: { shape: { kind: 'box', hx: 0.0025, hy: h, hz: 0.016 }, finish: 'walnut', pos: v3(x, h, 0), rot: ID_Q }, material: 'wood', tag: 'beam', density: 500 });
      beam = s.addBody(pivot, quatAxis(Z, -dir * tilt), [
        { piece: { shape: { kind: 'box', hx: half, hy: 0.003, hz: 0.018, round: 0.001 }, finish: 'paint', hue: ctx.hue(), pos: v3(0, 0, 0), rot: ID_Q }, material: 'wood', tag: 'beam', density: 500 },
        // Far seat: two thin rods across the beam cradle the second marble; nothing in front of it.
        rod(dir * (half - 0.0185 - 0.0085)),
        rod(dir * (half - 0.0185 + 0.0085)),
        // Near cup, 5 cm long: a low lip at the end, a tall stopper on the pivot side.
        wall(-dir * (half - 0.0025), 0.004),
        wall(-dir * (half - 0.05), 0.012),
      ]);
      // The beam stops (on its hinge's limit) ~0.27 rad short of level, while the far end is still
      // rising forward: that throws the marble up and ahead instead of back over the pivot. Rapier
      // measures a hinge's angle from the bodies' frames, so the beam starts at -dir·tilt: the limits
      // run from just past its resting tilt to the stopping angle.
      const rest = -dir * tilt;
      const stopAt = -dir * 0.27;
      s.hinge(null, beam, pivot, v3(0, 0, 0), Z, [Math.min(rest - dir * 0.02, stopAt), Math.max(rest - dir * 0.02, stopAt)]);
      s.addStatic({ shape: { kind: 'box', hx: 0.006, hy: 0.02, hz: 0.012 }, finish: 'walnut', pos: v3(pivot.x, pivot.y - 0.024, pivot.z), rot: ID_Q }, 'wood', 'fulcrum', false);
      // The far end rests on a stop just beneath it (not touching yet: an overlap would shove the
      // beam up and rock it before the marble even lands).
      const farEnd = v3(pivot.x + dir * half * dm.cos(tilt), pivot.y - half * dm.sin(tilt), pivot.z);
      s.addStatic({ shape: { kind: 'box', hx: 0.008, hy: 0.004, hz: 0.014 }, finish: 'walnut', pos: v3(farEnd.x, farEnd.y - 0.0035 / dm.cos(tilt) - 0.0012 - 0.004, farEnd.z), rot: ID_Q }, 'wood', 'stop');
      // The second marble rests on the far seat, out from the tilted beam along its normal.
      const along = half - 0.0185;
      const nx = dir * dm.sin(tilt);
      const ny = dm.cos(tilt);
      const surf = v3(pivot.x + dir * along * dm.cos(tilt) + nx * 0.003, pivot.y - along * dm.sin(tilt) + ny * 0.003, pivot.z);
      cupAt = v3(surf.x + nx * (MARBLE_R + 0.0004), surf.y + ny * (MARBLE_R + 0.0004), pivot.z);
      marble2 = s.addMarble(cupAt, ctx.marble, ctx.hue());
      angle0 = 2 * dm.asin(s.body(beam).rotation().z);
    };

    const check = (s: Sim): Entry | 'fail' | null => {
      const m1 = state(s, e.marble);
      if (beam < 0) {
        if ((m1.at.x - lip.x) * dir > 0.004) place(s);
        else if (m1.at.y < lip.y - 0.3) return 'fail';
        return null;
      }
      const m = state(s, marble2);
      // The two marbles must never touch: the throw has to come from the beam alone.
      if (Math.sqrt((m.at.x - m1.at.x) ** 2 + (m.at.y - m1.at.y) ** 2 + (m.at.z - m1.at.z) ** 2) < 2 * MARBLE_R + 0.003) return 'fail';
      // Struck means the near end went down (the launching way), not a wobble.
      struck ||= (2 * dm.asin(s.body(beam).rotation().z) - angle0) * dir > 0.035;
      if (!struck && Math.sqrt((m.at.x - cupAt.x) ** 2 + (m.at.y - cupAt.y) ** 2) > 0.004) return 'fail';
      if (!struck) return m1.at.y < pivot.y - 0.25 ? 'fail' : null;
      // Airborne, past the beam's far end, on its way down; and the first marble sits in the near cup.
      const clear = (m.at.x - pivot.x) * dir > half * dm.cos(tilt) + 0.015;
      const inCup = (m1.at.x - pivot.x) * dir < -0.015 && m1.at.y > pivot.y - 0.01;
      if (clear && m.vel.y < 0 && m.at.y > pivot.y - 0.05) return inCup ? m : 'fail';
      if (m.at.y < pivot.y - 0.3) return 'fail';
      return null;
    };
    return { kind: 'catapult', check, timeout: 6 };
  },
};

// ——— Paddle wheel: the marble drops into a bucket and rides the wheel round and off ———

export const WHEEL: ModuleDef = {
  kind: 'wheel',
  showpiece: true,
  build(ctx, e) {
    const { sim, rng } = ctx;
    const dir = across(e.at.x);
    const hole = catchFunnel(ctx, e, rng.range(0.05, 0.08));
    const start = v3(hole.x - dir * 0.012, hole.y - 0.03, hole.z);
    const lip = v3(start.x + dir * 0.1, start.y - 0.1 * dm.sin(0.15), start.z);
    channel(sim, start, lip, { closedStart: true, finish: 'walnut' });
    const R = rng.range(0.05, 0.062);
    const centre = v3(lip.x + dir * (R * 0.55), lip.y - R - 0.012, lip.z);
    const paddles = 6;
    const hue = ctx.hue();
    const pieces: BodyPiece[] = [{ piece: { shape: { kind: 'cylinder', r: 0.012, hh: 0.012 }, finish: 'brass', pos: v3(0, 0, 0), rot: quatAxis(v3(1, 0, 0), Math.PI / 2) }, material: 'brass', tag: 'wheel', density: 2500 }];
    for (let k = 0; k < paddles; k++) {
      const a = (k / paddles) * Math.PI * 2 + 0.3;
      pieces.push({ piece: { shape: { kind: 'box', hx: R / 2, hy: 0.002, hz: 0.016 }, finish: 'paint', hue, pos: v3((dm.cos(a) * R) / 2, (dm.sin(a) * R) / 2, 0), rot: quatAxis(Z, a) }, material: 'wood', tag: 'wheel', density: 600 });
    }
    const wheel = sim.addBody(centre, ID_Q, pieces, { angularDamping: 0.6 });
    sim.hinge(null, wheel, centre, v3(0, 0, 0), Z);
    // Clear side plates keep the marble on the paddles.
    for (const side of [-1, 1])
      sim.addStatic({ shape: { kind: 'cylinder', r: R + 0.012, hh: 0.0012 }, finish: 'glass', pos: v3(centre.x, centre.y, centre.z + side * (0.0175 + 0.0012)), rot: quatAxis(v3(1, 0, 0), Math.PI / 2) }, 'glass', 'guard');
    post(sim, centre.x, centre.z - 0.03, centre.y - 0.08, centre.y);
    const check = dropCheck(e.marble, centre.y - R - 0.025, undefined, centre.y - 0.45);
    return { kind: 'wheel', check: (s) => check(s), timeout: 8 };
  },
};

// ——— Newton's cradle: the marble strikes one end; the far ball swings out and knocks a marble on ———

export const CRADLE: ModuleDef = {
  kind: 'cradle',
  showpiece: true,
  build(ctx, e) {
    const { sim, rng } = ctx;
    const dir = across(e.at.x);
    const hole = catchFunnel(ctx, e, rng.range(0.05, 0.08));
    const start = v3(hole.x - dir * 0.012, hole.y - 0.03, hole.z);
    const slope = rng.range(0.16, 0.22);
    const lip = v3(start.x + dir * 0.12, start.y - 0.12 * dm.sin(slope), start.z);
    channel(sim, start, lip, { closedStart: true, finish: 'maple' });
    // Steel balls on strings, touching in a row at the height the marble arrives.
    const r = 0.0095;
    const L = 0.07;
    const n = rng.int(4, 6);
    const yBall = lip.y + MARBLE_R;
    // The first ball hangs just past the channel's end, so the marble rolls into it dead centre.
    const x0 = lip.x + dir * (r + 0.002);
    let last = -1;
    for (let k = 0; k < n; k++) {
      const x = x0 + dir * k * (2 * r + 0.0004);
      const ball = sim.addBody(v3(x, yBall, lip.z), ID_Q, [{ piece: { shape: { kind: 'sphere', r }, finish: 'steel', pos: v3(0, 0, 0), rot: ID_Q }, material: 'steel', tag: 'cradle', restitution: 0.95 }], { ccd: true });
      sim.hinge(null, ball, v3(x, yBall + L, lip.z), v3(0, L, 0), Z);
      sim.addStatic({ shape: { kind: 'cylinder', r: 0.0006, hh: L / 2 }, finish: 'steel', pos: v3(x, yBall + L / 2, lip.z), rot: ID_Q }, 'steel', 'string', false);
      last = ball;
    }
    const xEnd = x0 + dir * (n - 1) * (2 * r + 0.0004);
    sim.addStatic({ shape: { kind: 'box', hx: ((n + 1) * 2 * r) / 2, hy: 0.003, hz: 0.006 }, finish: 'brass', pos: v3((x0 + xEnd) / 2, yBall + L + 0.003, lip.z), rot: ID_Q }, 'brass', 'frame', false);
    // A level ledge past the last ball holds the second marble, then falls away to a lip.
    const ledge0 = v3(xEnd + dir * (r + 0.004), yBall - MARBLE_R, lip.z);
    const m2x = xEnd + dir * (r + MARBLE_R + 0.0015);
    // (Planks shorter than a marble's diameter make poor contact: keep the ledge well over that.)
    const knee = v3(m2x + dir * 0.04, ledge0.y, lip.z);
    const xFar = dir > 0 ? Math.max(X_MAX, knee.x + 0.1) : Math.min(X_MIN, knee.x - 0.1);
    const end = v3(xFar, knee.y - Math.abs(xFar - knee.x) * 0.07, lip.z);
    channel(sim, ledge0, knee, { finish: 'walnut' });
    channel(sim, knee, end, { finish: 'walnut' });
    const marble2 = sim.addMarble(v3(m2x, ledge0.y + MARBLE_R + 0.0003, lip.z), ctx.marble, ctx.hue());
    const lipC = lipCheck(marble2, end, dir, end.y - 0.4, backstop(sim, end, dir));
    // Only counts if the far ball (not something else) set the second marble going.
    let swung = false;
    const check = (s: Sim): Entry | 'fail' | null => {
      swung ||= (s.body(last).translation().x - xEnd) * dir > 0.003;
      // Settling a millimetre or two is fine; reaching the slope before the far ball swings is not.
      const away = (s.body(marble2).translation().x - knee.x) * dir > 0;
      if (away && !swung) return 'fail';
      return swung ? lipC(s) : null;
    };
    return { kind: 'cradle', check, timeout: 7 };
  },
};

