/**
 * The race, simulated start to finish at init on deterministic Rapier (via the Rube Goldberg
 * recording sim) and kept as a tape: every body's pose each video frame, every marble's distance
 * along the course, and every event (gates, checkpoints, eliminations, finishes, impacts) at its
 * step. The template plays the tape back, so Node and Chrome see the same race by construction,
 * and the camera can be smoothed looking ahead.
 */
import * as dm from '@sim/physics/math';
import type { Rng } from '@sim/engine';
import { Sim, ID_Q, DT, STEPS_PER_FRAME, quatAxis, v3, type TapeEvent, type V3 } from '../rube-goldberg/sim';
import { RAPIER } from '../rube-goldberg/rapier';
import { buildCourse, locate, LIFT_HALF_PERIOD, R, W, WALL_H, type Course, type CourseOpts } from './course';

export const GATE_OPEN_S = 0.8;
export const OUTRO_S = 2.6;
const MAX_S = 85;
/** Rolling resistance: keeps a pack at a watchable pace on the long lanes. */
const ROLL_DAMPING = 0.9;
const GATE_LIFT = WALL_H + 0.03;
const GATE_LIFT_S = 0.3;
/** How long marbles may sit on a shut trapdoor before it lets them through anyway. */
const TRAP_RELEASE_S = 4;
/** Swung open this far (radians), a trapdoor has tipped: it latches open for good. */
const TRAP_LATCH_AT = 0.25;
/** How long a latched trapdoor takes to swing fully open. */
const TRAP_SWING_S = 0.25;

export type Mode = 'elimination' | 'race';

export interface RaceOpts {
  mode: Mode;
  marbles: number;
  sections: number;
  lanesPerSection: number;
  density: number;
  spinnerSpeed: number;
  /** Passed to the course (tests). */
  specials?: CourseOpts['specials'];
  specialChance?: number;
}

export interface Race {
  sim: Sim;
  course: Course;
  /** Body index of each marble. */
  marbles: number[];
  /** Per video frame: each marble's distance along the course. */
  progress: Float32Array[];
  events: TapeEvent[];
  steps: number;
  /** Per video frame: what the camera should take in, [x, y, z, width, height] (before smoothing). */
  focus: Float32Array;
  winner: number;
  winStep: number;
  /** Race mode: when the podium filled (3rd place, or everyone in a smaller field), else the win. */
  podiumStep: number;
  timedOut: boolean;
  lost: number;
  kicks: number;
}

function sectionCuts(n: number, sections: number): number[] {
  const total = n - 1;
  return Array.from({ length: sections }, (_, j) => Math.floor((total * (j + 1)) / sections) - Math.floor((total * j) / sections));
}

export function runRace(rng: Rng, o: RaceOpts): Race {
  const sim = new Sim();
  const course = buildCourse(sim, rng, { sections: o.sections, lanesPerSection: o.lanesPerSection, density: o.density, spinnerSpeed: o.spinnerSpeed, gates: o.mode === 'elimination', marbles: o.marbles, specials: o.specials, specialChance: o.specialChance });
  const marbles = course.grid.map((at, i) =>
    sim.addBody(at, ID_Q, [{ piece: { shape: { kind: 'sphere', r: R }, finish: 'glass', hue: i, pos: v3(0, 0, 0), rot: ID_Q }, material: 'glass', tag: 'marble' }], {
      kind: 'marble',
      ccd: true,
      angularDamping: ROLL_DAMPING,
      // A marble slowing on a gentle slope must never doze off: it would never wake.
      canSleep: false,
    }),
  );
  const n = marbles.length;
  const cuts = o.mode === 'elimination' ? sectionCuts(n, course.lines.length) : [];
  const hint = new Array<number>(n).fill(0);
  const prog = new Float32Array(n);
  const passed = new Array<number>(n).fill(0);
  const out = new Array<boolean>(n).fill(false);
  const finishedAt = new Array<number>(n).fill(-1);
  const lastMove = new Array<number>(n).fill(0);
  /** Progress marks: how far each marble had got, and when it last got 2 cm further. */
  const markProg = new Array<number>(n).fill(0);
  const markT = new Array<number>(n).fill(0);
  const progress: Float32Array[] = [];
  const focus: number[] = [];
  let nextCp = 0;
  let winner = -1;
  let winStep = -1;
  let podiumStep = -1;
  const podiumSize = o.mode === 'race' ? Math.min(3, course.grid.length) : 1;
  /** Race mode waits this long at most for 2nd and 3rd after the win. */
  const PODIUM_WAIT_S = 20;
  let leader = -1;
  let leaderSince = 0;
  let lost = 0;
  let kicks = 0;
  const finishOrder: number[] = [];
  const Y = v3(0, 1, 0);
  const emit = (type: string, data: Record<string, unknown> = {}) => sim.emit(type, data);

  const alive = () => marbles.map((_, i) => i).filter((i) => !out[i] && finishedAt[i] < 0);
  const order = () => alive().sort((a, b) => prog[b] - prog[a] || a - b);
  const pos = (i: number): V3 => sim.body(marbles[i]).translation();
  const trapWait = course.trapdoors.map(() => 0);
  const trapState = course.trapdoors.map((): 'shut' | 'opening' | 'open' => 'shut');
  const trapFrom = course.trapdoors.map(() => ({ t: 0, angle: 0 }));

  const eliminate = (i: number, cp: number) => {
    out[i] = true;
    const p = pos(i);
    emit('eliminate', { who: i, cp, margin: Math.max(0, course.lines[cp].s - prog[i]), x: p.x, y: p.y, z: p.z });
    sim.body(marbles[i]).setEnabled(false);
  };

  const openGate = (g: Course['gates'][number]) => {
    g.openAt = sim.t;
  };

  let timedOut = false;
  while (true) {
    const t = sim.t;
    // Kinematic parts: spinners turn, opened gates lift away.
    for (const sp of course.spinners) sim.body(sp.body).setNextKinematicRotation(quatAxis(Y, sp.phase + sp.omega * (t + DT)));
    // Latched trapdoors: swing smoothly the rest of the way open, then stay there.
    course.trapdoors.forEach((td, k) => {
      if (trapState[k] !== 'opening') return;
      const u = Math.min(1, (t + DT - trapFrom[k].t) / TRAP_SWING_S);
      const e = u * u * (3 - 2 * u);
      const full = td.rest - td.dir * td.open;
      const a = trapFrom[k].angle + (full - trapFrom[k].angle) * e;
      // The flap's centre sits half its length from the hinge, along its own direction.
      const half = (td.len / 2) * td.dir;
      const body = sim.body(td.body);
      body.setNextKinematicRotation(quatAxis(v3(0, 0, 1), a));
      body.setNextKinematicTranslation(v3(td.pivot.x + half * dm.cos(a), td.pivot.y + half * dm.sin(a), td.pivot.z));
      if (u >= 1) trapState[k] = 'open';
    });
    // Elevators: alternate slats up and down in opposite phase, pausing at each end of their travel
    // (long enough for the marbles on a raised slat to roll across onto the next).
    for (const lf of course.lifts) {
      const u = Math.max(-1, Math.min(1, 1.6 * dm.sin(((t + DT) * Math.PI) / LIFT_HALF_PERIOD)));
      lf.bodies.forEach((bi, k) => {
        const c = lf.at[k];
        sim.body(bi).setNextKinematicTranslation(v3(c.x, c.y + lf.amp * (k % 2 ? -u : u), c.z));
      });
    }
    for (const g of [course.startGate, ...course.gates]) {
      if (g.openAt === null) continue;
      const u = Math.min(1, (t + DT - g.openAt) / GATE_LIFT_S);
      sim.body(g.body).setNextKinematicTranslation(v3(g.at.x, g.at.y + GATE_LIFT * u * u * (3 - 2 * u), g.at.z));
    }
    if (course.startGate.openAt === null && t >= GATE_OPEN_S) {
      openGate(course.startGate);
      emit('gate');
    }
    sim.advance();
    if (sim.step % STEPS_PER_FRAME !== 0) continue;

    // Once a video frame: where everyone is, and the race's rules.
    const now = sim.t;
    for (let i = 0; i < n; i++) {
      if (out[i]) continue;
      const p = pos(i);
      hint[i] = locate(course, p, hint[i]);
      const q = course.path[hint[i]];
      const tg = course.tangent[hint[i]];
      prog[i] = course.dist[hint[i]] + (p.x - q.x) * tg.x + (p.y - q.y) * tg.y + (p.z - q.z) * tg.z;
      // Off the course altogether (should never happen): count it, and the race is void. Judged by
      // leaving the tower's bounds (a marble circling the far side of a big funnel can be well off
      // the centre line and still fine).
      if (p.x < course.minX - 0.08 || p.x > course.maxX + 0.08 || p.z < course.minZ - 0.08 || p.z > course.maxZ + 0.08 || p.y < course.bottom - 0.2) {
        lost++;
        out[i] = true;
        sim.body(marbles[i]).setEnabled(false);
        emit('lost', { who: i });
      }
    }
    progress.push(Float32Array.from(prog));

    // Rules run until the winner (and, in race mode, until the podium has filled).
    if (winner < 0 || (o.mode === 'race' && podiumStep < 0)) {
      for (let i = 0; i < n; i++) while (!out[i] && passed[i] < course.lines.length && prog[i] > course.lines[passed[i]].s) passed[i]++;
      if (o.mode === 'elimination') {
        const cp = nextCp;
        if (cp < course.lines.length) {
          const still = marbles.map((_, i) => i).filter((i) => !out[i]);
          const through = still.filter((i) => passed[i] > cp);
          const final = cp === course.lines.length - 1;
          if (final && through.length) {
            // The last line: the first across wins (the one furthest on if several crossed together).
            const first = through.reduce((a, b2) => (prog[b2] > prog[a] ? b2 : a));
            for (const i of still) if (i !== first) eliminate(i, cp);
            nextCp++;
          } else if (!final && through.length >= still.length - cuts[cp]) {
            const losers = still.filter((i) => passed[i] <= cp);
            for (const i of losers) eliminate(i, cp);
            // Several crossed together and fewer went out than planned: the next round takes the rest.
            if (losers.length < cuts[cp]) cuts[cp + 1] += cuts[cp] - losers.length;
            if (course.gates[cp]) {
              openGate(course.gates[cp]);
              emit('roundGate', { cp });
            }
            nextCp++;
            if (nextCp < course.lines.length) emit('checkpoint', { cp: nextCp });
          }
        }
        const remaining = marbles.map((_, i) => i).filter((i) => !out[i]);
        if (remaining.length === 1) {
          winner = remaining[0];
          winStep = sim.step;
          emit('win', { who: winner, x: pos(winner).x });
        }
      } else {
        const last = course.lines.length - 1;
        // Across the line this frame, furthest on first.
        const across = marbles.map((_, i) => i).filter((i) => finishedAt[i] < 0 && !out[i] && passed[i] > last).sort((a, b2) => prog[b2] - prog[a] || a - b2);
        for (const i of across) {
          finishedAt[i] = now;
          finishOrder.push(i);
          emit('finish', { who: i, place: finishOrder.length, x: pos(i).x, gap: winStep >= 0 ? now - winStep * DT : 0 });
          if (finishOrder.length === 1) {
            winner = i;
            winStep = sim.step;
            emit('win', { who: i, x: pos(i).x });
          }
        }
      }
      const ord = order();
      if (winner < 0 && now > GATE_OPEN_S && ord.length && ord[0] !== leader) {
        if (leader >= 0 && now - leaderSince > 0.4) emit('leadChange', { from: leader, to: ord[0] });
        leader = ord[0];
        leaderSince = now;
      }
    }

    // Trapdoors let a lone straggler (or two) through: marbles that have sat on a shut flap for a
    // while trip its release.
    const onTrap = new Set<number>();
    course.trapdoors.forEach((td, k) => {
      let on = false;
      marbles.forEach((_, i) => {
        if (out[i]) return;
        const p = pos(i);
        if (Math.abs(p.x - td.at.x) < td.len / 2 + R && Math.abs(p.z - td.at.z) < W / 2 && p.y > td.at.y - 0.01 && p.y < td.at.y + 0.03) {
          on = true;
          onTrap.add(i);
        }
      });
      const flap = sim.body(td.body);
      if (trapState[k] === 'shut') {
        // How far it has swung open (radians from shut).
        const q = flap.rotation();
        const openBy = (2 * dm.atan2(q.z, q.w) - td.rest) * -td.dir;
        trapWait[k] = on ? trapWait[k] + 1 / 60 : 0;
        // Tipped by enough weight, or (a group too light to tip it) after a wait: either way it
        // latches open from here on.
        if (openBy > TRAP_LATCH_AT || trapWait[k] > TRAP_RELEASE_S) {
          // From here the flap is driven, not free: the counterweight can't pull it shut again.
          trapState[k] = 'opening';
          trapFrom[k] = { t: now, angle: td.rest - td.dir * openBy };
          flap.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
          emit('trapdoor', { forced: openBy <= TRAP_LATCH_AT });
        }
      }
    });

    // Unstick: a marble that has hardly moved for a while, or has moved without getting anywhere
    // (a spinner's bar sweeping it back up the lane, round and round), and isn't queued at a gate,
    // gets a nudge along the course.
    for (let i = 0; i < n; i++) {
      if (out[i] || now < GATE_OPEN_S + 0.5) {
        lastMove[i] = now;
        markT[i] = now;
        markProg[i] = prog[i];
        continue;
      }
      const b = sim.body(marbles[i]);
      const v = b.linvel();
      const waiting = (o.mode === 'elimination' && passed[i] > nextCp && winner < 0) || finishedAt[i] >= 0 || (winner >= 0 && passed[i] >= course.lines.length) || onTrap.has(i);
      if (waiting || prog[i] > markProg[i] + 0.02) {
        markProg[i] = prog[i];
        markT[i] = now;
      }
      // (Only in spinner lanes: a marble circling a funnel also gets nowhere along the course for a
      // while, and is fine.)
      const inSpinners = course.lanes.some((l) => l.kind === 'spinners' && l.obstacles && prog[i] >= l.s0 && prog[i] <= l.s1);
      const churning = !waiting && inSpinners && now - markT[i] > 3;
      if ((waiting || Math.hypot(v.x, v.y, v.z) > 0.03) && !churning) {
        lastMove[i] = now;
        continue;
      }
      if (now - lastMove[i] > 2 || churning) {
        // A hop up and to one side with a little push along: it breaks a jam rather than driving
        // into it.
        const tg = course.tangent[hint[i]];
        const m = b.mass();
        // (Held back by a bar: a firmer shove down the lane, over its next sweep.)
        const along = churning ? 0.35 : 0.12;
        b.applyImpulse({ x: m * (tg.x * along + rng.range(-0.12, 0.12)), y: m * 0.22, z: m * (tg.z * along + rng.range(-0.12, 0.12)) }, true);
        lastMove[i] = now;
        markT[i] = now;
        kicks++;
        emit('kick', { who: i, churn: churning });
      }
    }

    // The podium is complete once the places it shows are taken (or the wait for them runs out).
    if (winner >= 0 && podiumStep < 0 && (o.mode !== 'race' || finishOrder.length >= podiumSize || now - winStep * DT > PODIUM_WAIT_S)) {
      podiumStep = sim.step;
      if (o.mode === 'race') emit('podium', { places: finishOrder.length });
    }

    // What the camera wants to see this frame: the "decision zone", as in the 2D race.
    focus.push(...framing(course, o.mode, winner, nextCp, cuts, order(), prog, pos, finishOrder, podiumStep >= 0));

    if (lost > 0) break;
    if (podiumStep >= 0 && sim.step >= podiumStep + Math.round(OUTRO_S / DT)) break;
    if (now > MAX_S) {
      timedOut = true;
      break;
    }
  }
  return { sim, course, marbles, progress, events: sim.events, steps: sim.step, focus: Float32Array.from(focus), winner, winStep, podiumStep, timedOut, lost, kicks };
}

/**
 * The point to look at and how much to take in: the marbles that decide what happens next (everyone
 * still in during an elimination round, the leading three in a race, the winner at the end), plus a
 * look ahead to the line the key marble is racing for. [x, y, z, width, height].
 */
function framing(course: Course, mode: Mode, winner: number, nextCp: number, cuts: number[], ord: number[], prog: Float32Array, pos: (i: number) => V3, finished: number[], podiumDone: boolean): number[] {
  let focus: number[];
  let key: number;
  const chasing = mode === 'race' && winner >= 0 && !podiumDone && ord.length > 0;
  if (chasing) {
    // Won, and the race for 2nd and 3rd goes on: follow the marbles still in with a chance.
    focus = ord.slice(0, Math.max(1, 3 - finished.length));
    key = ord[0];
  } else if (winner >= 0) {
    // The end: the winner (elimination), or the podium finishers at the line (race).
    focus = mode === 'race' ? finished.slice(0, 3) : [winner];
    key = winner;
  } else if (!ord.length) {
    focus = finished.slice(0, 1);
    key = focus[0] ?? 0;
  } else if (mode === 'elimination') {
    const cut = cuts[Math.min(nextCp, cuts.length - 1)] ?? 1;
    focus = ord;
    key = ord[Math.max(0, ord.length - cut - 1)];
  } else {
    focus = ord.slice(0, 3);
    key = ord[0];
  }
  const ps = focus.map(pos);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z = 0;
  for (const p of ps) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
    z += p.z / ps.length;
  }
  const kp = pos(key);
  // Too spread out: centre on the key marble and the ones nearest it.
  const MAX_SPAN = 0.5;
  if (y1 - y0 > MAX_SPAN) {
    y0 = Math.max(y0, kp.y - MAX_SPAN / 2);
    y1 = Math.min(y1, kp.y + MAX_SPAN / 2);
  }
  // Ahead: the next line, if it's close below.
  const line = course.lines.find((l) => l.s > prog[key]);
  if ((winner < 0 || chasing) && line && line.s - prog[key] < 0.35 && line.at.y < y0) y0 = Math.max(line.at.y, y1 - MAX_SPAN);
  return [(x0 + x1) / 2, (y0 + y1) / 2, z, x1 - x0, y1 - y0];
}

export { dm };
