/**
 * Contraption modules: jumps, domino runs and xylophone stairs. Each is real physics; the generator
 * keeps the ones that work and retries the rest.
 */
import * as dm from '@sim/physics/math';
import { CHANNEL_W, WALL_H, channel, plank, post, rail } from '../parts';
import { ID_Q, MARBLE_R, quatAxis, v3, type Sim, type TapeEvent } from '../sim';
import { X_MAX, X_MIN, Z, across, backstop, catchFunnel, lipCheck, state, type Entry, type ModuleDef } from './common';

// ——— Jump: a steeper run up a kicker, a flight across a gap, caught by the next funnel ———

export const JUMP: ModuleDef = {
  kind: 'jump',
  showpiece: true,
  build(ctx, e) {
    const { sim, rng } = ctx;
    const dir = across(e.at.x);
    const hole = catchFunnel(ctx, e, rng.range(0.05, 0.08));
    const start = v3(hole.x - dir * 0.012, hole.y - 0.03, hole.z);
    const xEnd = (dir > 0 ? X_MAX : X_MIN) - dir * rng.range(0.16, 0.22);
    const slope = rng.range(0.15, 0.22);
    const mid = v3(xEnd, start.y - Math.abs(xEnd - start.x) * dm.sin(slope), start.z);
    channel(sim, start, mid, { closedStart: true, finish: 'maple' });
    // The kicker: a short section bent upward that throws the marble into the air.
    const up = rng.range(0.22, 0.38);
    const kick = v3(mid.x + dir * 0.045 * dm.cos(up), mid.y + 0.045 * dm.sin(up), mid.z);
    channel(sim, mid, kick, { finish: 'walnut' });
    post(sim, mid.x, mid.z - 0.03, mid.y - 0.08, mid.y - 0.01);
    // No backstop: the next module's funnel goes where the flight comes down.
    const check = lipCheck(e.marble, kick, dir, kick.y - 0.4);
    return { kind: 'jump', check: (s) => check(s), timeout: 6 };
  },
};

// ——— Dominoes: the marble topples a row; the last one pushes a second marble off the shelf ———

export const DOMINOES: ModuleDef = {
  kind: 'dominoes',
  showpiece: true,
  build(ctx, e) {
    const { sim, rng } = ctx;
    const dir = across(e.at.x);
    const hole = catchFunnel(ctx, e, rng.range(0.05, 0.08));
    const start = v3(hole.x - dir * 0.012, hole.y - 0.03, hole.z);
    // A short drop to get rolling, then a nearly level shelf (a channel) carrying the row.
    const rampEnd = v3(start.x + dir * 0.1, start.y - 0.1 * dm.sin(0.14), start.z);
    channel(sim, start, rampEnd, { closedStart: true, finish: 'maple' });
    const xEnd = dir > 0 ? X_MAX : X_MIN;
    const floorY = rampEnd.y;
    const spacing = rng.range(0.019, 0.024);
    const h = 0.042;
    const x0 = rampEnd.x + dir * 0.06;
    const reach = 0.033;
    const room = Math.abs(xEnd - x0) - reach - 0.07;
    const n = Math.min(rng.int(8, 13), Math.floor(room / spacing) + 1);
    const hue = ctx.hue();
    let last = -1;
    for (let k = 0; k < n; k++) {
      const x = x0 + dir * k * spacing;
      last = sim.addBody(v3(x, floorY + h / 2 + 0.0004, rampEnd.z), ID_Q, [
        { piece: { shape: { kind: 'box', hx: 0.0035, hy: h / 2, hz: CHANNEL_W / 2 - 0.004, round: 0.001 }, finish: 'paint', hue: hue + (k % 3), pos: v3(0, 0, 0), rot: ID_Q }, material: 'wood', tag: 'domino' },
      ]);
    }
    // The second marble waits on the level shelf where the last domino will land on it.
    const mx = x0 + dir * ((n - 1) * spacing + reach);
    const marble2 = sim.addMarble(v3(mx, floorY + MARBLE_R + 0.0003, rampEnd.z), ctx.marble, ctx.hue());
    // Level up to the waiting marble (so it stays put), then a gentle fall to the lip (so a push carries it).
    const knee = v3(mx + dir * 0.016, floorY, rampEnd.z);
    const shelfEnd = v3(xEnd, floorY - Math.abs(xEnd - knee.x) * 0.06, rampEnd.z);
    channel(sim, rampEnd, knee, { finish: 'walnut' });
    channel(sim, knee, shelfEnd, { finish: 'walnut' });
    post(sim, shelfEnd.x - dir * 0.04, shelfEnd.z - 0.03, shelfEnd.y - 0.07, shelfEnd.y - 0.01);
    const lip = lipCheck(marble2, shelfEnd, dir, shelfEnd.y - 0.4, backstop(sim, shelfEnd, dir));
    // Only a real chain reaction counts: the waiting marble mustn't move before the last domino tips.
    const check = (sm: typeof sim) => {
      const tipped = Math.abs(sm.body(last).rotation().z) > 0.15;
      const moved = Math.abs(sm.body(marble2).translation().x - mx) > 0.004;
      if (moved && !tipped) return 'fail' as const;
      // Waiting patiently isn't stalling: only watch the second marble once the row reaches it.
      return tipped ? lip(sm) : null;
    };
    return { kind: 'dominoes', check: (sm) => check(sm), timeout: 9 };
  },
};

// ——— Xylophone stairs: the marble bounces down a flight of tuned bars, playing the tune ———

export const XYLOPHONE: ModuleDef = {
  kind: 'xylophone',
  showpiece: true,
  tries: 3,
  build(ctx, e) {
    const { sim, rng } = ctx;
    const dir = across(e.at.x);
    const hole = catchFunnel(ctx, e, rng.range(0.05, 0.08));
    const start = v3(hole.x - dir * 0.012, hole.y - 0.03, hole.z);
    const lip = v3(start.x + dir * 0.07, start.y - 0.07 * dm.sin(0.12), start.z);
    channel(sim, start, lip, { closedStart: true, finish: 'walnut' });
    // A straight flight of tuned bars. The marble rolls along each (tilted slightly down the line),
    // drops off its end onto the next, which starts just under it. It speeds up on the way down, so
    // each bar is a little longer and a little flatter than the one above: it still lands on every one.
    const n = rng.int(6, 8);
    const dy = rng.range(0.02, 0.024);
    const overlap = 0.008;
    let x = lip.x - dir * 0.004;
    let top = lip.y - 0.012;
    const levels: number[] = [];
    let last = lip;
    for (let k = 0; k < n; k++) {
      const len = 0.05 + 0.007 * k;
      const tilt = Math.max(0.05, 0.11 - 0.008 * k);
      const a = v3(x, top, lip.z);
      const b = v3(x + dir * len * dm.cos(tilt), top - len * dm.sin(tilt), lip.z);
      const mid = v3((a.x + b.x) / 2, (a.y + b.y) / 2 - 0.004, lip.z);
      sim.addStatic({ shape: { kind: 'box', hx: len / 2, hy: 0.004, hz: 0.026, round: 0.0015 }, finish: k % 2 ? 'steel' : 'brass', pos: mid, rot: quatAxis(Z, -dir * tilt) }, 'brass', 'xylo');
      levels.push((a.y + b.y) / 2 + MARBLE_R);
      last = b;
      // The next bar starts just under this one's end.
      x = b.x - dir * overlap;
      top = b.y - dy;
    }
    // Clear guards either side keep the marble in its lane; a brass rail behind carries the bars.
    const x0 = lip.x - dir * 0.01;
    const x1 = last.x + dir * 0.03;
    for (const side of [-1, 1])
      sim.addStatic(
        { shape: { kind: 'box', hx: Math.abs(x1 - x0) / 2, hy: (lip.y - last.y + 0.06) / 2, hz: 0.0015 }, finish: 'glass', pos: v3((x0 + x1) / 2, (lip.y + last.y) / 2, lip.z + side * (MARBLE_R + 0.01)), rot: ID_Q },
        'glass',
        'guard',
      );
    rail(sim, v3(lip.x, lip.y - 0.01, lip.z - 0.03), v3(last.x, last.y - 0.01, lip.z - 0.03), 0.0025, 'brass', 'post', false);
    post(sim, last.x, last.z - 0.03, last.y - 0.06, last.y - 0.01);
    // Hand off once it has dropped off the last bar; nearly all the bars must have rung on the way.
    const hit = new Set<number>();
    const exitX = last.x + dir * 0.004;
    const check = (s: Sim, events: TapeEvent[]): Entry | 'fail' | null => {
      for (const ev of events) {
        if (ev.type !== 'impact' || (ev.tagA !== 'xylo' && ev.tagB !== 'xylo')) continue;
        let k = 0;
        for (let j = 1; j < n; j++) if (Math.abs((ev.y as number) - levels[j]) < Math.abs((ev.y as number) - levels[k])) k = j;
        hit.add(k);
      }
      const m = state(s, e.marble);
      if ((m.at.x - exitX) * dir > 0 && m.at.y < last.y + MARBLE_R) return hit.size >= n - 1 ? m : 'fail';
      if (m.at.y < last.y - 0.3) return 'fail';
      return null;
    };
    return { kind: 'xylophone', check, timeout: 9 };
  },
};

export { plank, WALL_H };

// ——— Peg drop: a narrow chute the marble zigzags down, bouncing between staggered steel pegs ———

export const PEGDROP: ModuleDef = {
  kind: 'pegdrop',
  showpiece: true,
  tries: 3,
  build(ctx, e) {
    const { sim, rng } = ctx;
    const dir = across(e.at.x);
    const hole = catchFunnel(ctx, e, rng.range(0.05, 0.08));
    const start = v3(hole.x - dir * 0.012, hole.y - 0.03, hole.z);
    const lip = v3(start.x + dir * 0.07, start.y - 0.07 * dm.sin(0.12), start.z);
    channel(sim, start, lip, { closedStart: true, finish: 'walnut' });
    // The chute: two wooden side walls, clear front and back, pegs sticking out from alternate sides.
    const w = rng.range(0.056, 0.064);
    const xc = lip.x + dir * (w / 2 + 0.004);
    const rows = rng.int(7, 10);
    const dy = rng.range(0.028, 0.034);
    const reach = rng.range(0.011, 0.014);
    const topY = lip.y - 0.008;
    const pegTop = topY - 0.035;
    const bottom = pegTop - (rows - 1) * dy - 0.03;
    const wallH = topY + 0.05 - bottom;
    for (const side of [-1, 1]) {
      // The near wall stops below the lip, so the marble rolls over it into the chute.
      const top = side === -dir ? topY - 0.012 : topY + 0.05;
      sim.addStatic({ shape: { kind: 'box', hx: 0.004, hy: (top - bottom) / 2, hz: 0.022, round: 0.0015 }, finish: 'maple', pos: v3(xc + side * (w / 2 + 0.004), (top + bottom) / 2, lip.z), rot: ID_Q }, 'wood', 'wood');
      sim.addStatic({ shape: { kind: 'box', hx: w / 2 + 0.008, hy: wallH / 2, hz: 0.0015 }, finish: 'glass', pos: v3(xc, bottom + wallH / 2, lip.z + side * (MARBLE_R + 0.008)), rot: ID_Q }, 'glass', 'guard');
    }
    // Pegs: steel pins across the chute, staggered left and right, so the marble zigzags between them.
    const first = rng.chance(0.5) ? 1 : -1;
    const pegYs: number[] = [];
    for (let j = 0; j < rows; j++) {
      const side = j % 2 === 0 ? first : -first;
      const y = pegTop - j * dy;
      sim.addStatic({ shape: { kind: 'cylinder', r: 0.0038, hh: MARBLE_R + 0.008 }, finish: 'steel', pos: v3(xc + side * (w / 2 - reach), y, lip.z), rot: quatAxis(v3(1, 0, 0), Math.PI / 2) }, 'steel', 'peg');
      pegYs.push(y);
    }
    // Its support rod stands behind the far wall, out of sight lines through the glass.
    post(sim, xc + dir * (w / 2 + 0.004), lip.z - 0.035, bottom - 0.03, topY + 0.04);
    // Hand off once it drops out of the bottom; it has to have zigzagged off at least half the pegs.
    const hit = new Set<number>();
    const check = (s: Sim, events: TapeEvent[]): Entry | 'fail' | null => {
      for (const ev of events) {
        if (ev.type !== 'impact' || (ev.tagA !== 'peg' && ev.tagB !== 'peg')) continue;
        let k = 0;
        for (let j = 1; j < rows; j++) if (Math.abs((ev.y as number) - pegYs[j]) < Math.abs((ev.y as number) - pegYs[k])) k = j;
        hit.add(k);
      }
      const m = state(s, e.marble);
      if (m.at.y < bottom - 0.01 && m.vel.y < 0) return hit.size >= Math.ceil(rows / 2) ? { ...m, catchAt: v3(xc, m.at.y, lip.z) } : 'fail';
      if (m.at.y < bottom - 0.3) return 'fail';
      return null;
    };
    return { kind: 'pegdrop', check, timeout: 8 };
  },
};

