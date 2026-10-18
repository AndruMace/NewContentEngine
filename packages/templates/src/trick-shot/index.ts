import { z } from 'zod';
import { FONT_FAMILY, Rng, type DramaScore, type OverlaySpec, type StepCtx, type Template } from '@sim/engine';
import { World3D, type Body3, type Contact3, type Shape3 } from '@sim/physics';
import * as dm from '@sim/physics/math';
import { COLOR_TEAMS, pickDistinctTeams, type Team } from '../fx';
import { clamp01, gaussFit } from '../scoring';
import { BALL_R, CUP_H, HALF_X, HEIGHT, buildCourse, type Course } from './course';
import { REPLAY_FROM_S, REPLAY_LEN_S, REPLAY_SPEED, drawTrickShot3D, initialCamera, updateCamera, type Cam } from './view3d';

export const TRICK_SHOT_MODES = ['bounce', 'attempts', 'race'] as const;

export const trickShotSchema = z.object({
  mode: z.enum(TRICK_SHOT_MODES).default('bounce').meta({ title: 'Mode' }),
  obstacles: z.number().int().min(12).max(40).default(28).meta({ title: 'Obstacles' }),
  mix: z.enum(['mixed', 'boards', 'pegs', 'bumpers']).default('mixed').meta({ title: 'Obstacle mix' }),
  // Attempts mode has none: its aim is planned from test shots, which needs a course that holds still.
  spinners: z.number().int().min(0).max(4).default(2).meta({ title: 'Spinners (bounce and race)' }),
  cupSize: z.number().min(2.4).max(5).default(3.4).meta({ title: 'Cup width (ball widths)', step: 0.1 }),
  gravity: z.number().min(8).max(20).default(14).meta({ title: 'Gravity', step: 0.5 }),
  bounciness: z.number().min(0.4).max(0.9).default(0.7).meta({ title: 'Bounciness', step: 0.05 }),
  racers: z.number().int().min(2).max(4).default(3).meta({ title: 'Balls (race)' }),
  racePoints: z.number().int().min(1).max(3).default(2).meta({ title: 'Cups to win (race)' }),
  maxAttempts: z.number().int().min(3).max(14).default(10).meta({ title: 'Max attempts' }),
});

export type TrickShotParams = z.infer<typeof trickShotSchema>;

export interface Pt3 {
  x: number;
  y: number;
  z: number;
}

/** An aim relative to the cannon's home direction: yaw (turn) and pitch (+ = up), radians. */
export interface Aim {
  yaw: number;
  pitch: number;
}

export interface Shot {
  body: Body3;
  team: Team;
  cannon: number;
  aim: Aim;
  /** Visual only: the path so far, and the last couple of seconds with times (for the replay). */
  trail: Pt3[];
  recent: (Pt3 & { t: number })[];
  done: boolean;
  /** Time sitting low in the cup / barely moving. */
  inCupS: number;
  slowS: number;
  /** Over the cup's mouth right now (for near misses). */
  inMouth: boolean;
  lastHitT: number;
  /** Physics steps since launch (attempts mode gives each shot TEST_MAX_S, as the test shots had). */
  steps: number;
  launchedAt: number;
}

export interface Cannon extends Pt3 {
  /** Home direction (radians in the x–z plane): toward the middle of the cabinet. */
  home: number;
  aim: Aim;
  aimFrom: Aim;
  aimTo: Aim;
  aimStartT: number;
  firedAt: number;
}

export interface State {
  p: TrickShotParams;
  world: World3D;
  course: Course;
  cannons: Cannon[];
  shots: Shot[];
  teams: Team[];
  /** Attempts mode: every shot's aim, closing in on one test-fired to go in (null if none did). */
  plan: Aim[] | null;
  nextLaunchAt: number;
  speed: number;
  hits: number;
  points: number[];
  reloads: { cannon: number; at: number }[];
  winner: number;
  success: boolean;
  endAt: number | null;
  replay: (Pt3 & { t: number })[];
  /** Visual only: the smoothed camera. */
  cam: Cam;
  t: number;
  visual: boolean;
  rng: Rng;
  fxRng: Rng;
}

export const FIRST_LAUNCH_S = 1.6;
export const AIM_S = 0.45;
const RETRY_S = 0.55;
const RELOAD_S = 0.9;
const SINK_HOLD_S = 0.25;
const STUCK_V = 0.25;
const STUCK_S = 1.1;
const MAX_V = 14;
/** Bounce and race: the floor always throws a ball back up at least this high. */
const MIN_REBOUND_H = HEIGHT * 0.5;
const FLOOR_NUDGE = 0.9;
const OUTRO_WIN_S = REPLAY_FROM_S + REPLAY_LEN_S / REPLAY_SPEED + 0.5;
const OUTRO_FAIL_S = 2.2;
/** Attempts mode: test shots per course (yaw × pitch) and how long each may run. */
const TEST_YAW = 12;
const TEST_PITCH = 8;
const TEST_MAX_S = 8;
const AIM_RANGE = { yaw: [-0.75, 0.75], pitch: [-0.75, 0.3] } as const;
const BALL_TEAM: Team = { label: 'Ball', color: '#ffffff' };

const teamName = (t: Team) => `${t.icon ? t.icon + ' ' : ''}${t.label}`;
const pan = (x: number) => Math.max(-0.7, Math.min(0.7, (x / HALF_X) * 0.7));

export const trickShot: Template<TrickShotParams, State> = {
  id: 'trick-shot',
  name: 'Trick Shot',
  family: 'bounce',
  description:
    'A 3D glass cabinet: a cannon at the top, tilted boards, rods, pegs, bumpers and spinners in between, and a cup standing on the floor. In bounce mode one ball ricochets around in 3D (the floor keeps throwing it back up) until it finally drops into the cup, with a bounce counter. In attempts mode an AI cannon fires shot after shot, each miss landing closer (missed shots leave faint ghost trails), until one goes in. In race mode several coloured balls bounce around together and the first to sink {racePoints} cups wins. The camera opens wide, follows the ball, and every success ends with a slow-motion replay from beside the cup. Narrower cups and more obstacles make it take longer.',
  schema: trickShotSchema,
  substeps: 4,
  searchBudget: 200,
  glowScale: 0.3,
  defaultCopy: {
    hook: 'Will it land in the cup? 🎯',
    cta: '{result} Rate it 1–10 🎯',
  },
  nudges: ['How many bounces will it take? 👇', 'Did you think it would go in? 👇', 'Guess when it lands 👇', 'Rate the shot 1–10 👇', 'Pick a ball 👇', 'Call it now 👇'],

  init({ params: p, rng, fxRng, visual }) {
    const world = new World3D();
    world.gravity = p.gravity;
    const n = p.mode === 'race' ? p.racers : 1;
    const side = rng.chance(0.5) ? 1 : -1;
    const cannons: Cannon[] = [];
    for (let i = 0; i < n; i++) {
      // One cannon high in a corner; for a race they spread along the top.
      const x = n === 1 ? side * (HALF_X - 0.7) : -HALF_X + 0.8 + ((2 * HALF_X - 1.6) * i) / (n - 1);
      const z = n === 1 ? 0 : i % 2 ? 0.7 : -0.7;
      const home = dm.atan2(-z, -x * 0.8 || 1e-6);
      const aim = { yaw: 0, pitch: 0 };
      cannons.push({ x, y: HEIGHT - 0.9, z, home, aim, aimFrom: aim, aimTo: aim, aimStartT: 0, firedAt: -10 });
    }
    // Built from its own seed so attempts mode can rebuild the identical course for test shots.
    const courseSeed = rng.u32();
    const courseOpts = { count: p.obstacles, mix: p.mix, spinners: p.mode === 'attempts' ? 0 : p.spinners, cupSize: p.cupSize, restitution: p.bounciness, cannons };
    const course = buildCourse(world, new Rng(courseSeed), courseOpts);
    for (const c of cannons) {
      const aim = { yaw: rng.range(AIM_RANGE.yaw[0], AIM_RANGE.yaw[1]), pitch: rng.range(AIM_RANGE.pitch[0], AIM_RANGE.pitch[1]) };
      c.aim = c.aimFrom = c.aimTo = aim;
    }
    const shotSpeed = rng.range(5, 7.5);
    const plan =
      p.mode === 'attempts'
        ? planAttempts(rng, p, shotSpeed, cannons[0], () => {
            const w = new World3D();
            w.gravity = p.gravity;
            return { world: w, course: buildCourse(w, new Rng(courseSeed), courseOpts) };
          })
        : null;
    if (plan) cannons[0].aim = cannons[0].aimFrom = cannons[0].aimTo = plan[0];
    const teams = p.mode === 'race' ? pickDistinctTeams(COLOR_TEAMS.slice(0, 8), n, rng) : [BALL_TEAM];
    const s: State = {
      p,
      world,
      course,
      cannons,
      shots: [],
      teams,
      plan,
      nextLaunchAt: FIRST_LAUNCH_S,
      speed: shotSpeed,
      hits: 0,
      points: cannons.map(() => 0),
      reloads: [],
      winner: -1,
      success: false,
      endAt: null,
      replay: [],
      cam: undefined as unknown as Cam,
      t: 0,
      visual,
      rng,
      fxRng,
    };
    s.cam = initialCamera(s);
    return s;
  },

  step(s, { dt, t, emit }) {
    const { p } = s;
    s.t = t + dt;
    for (const c of s.cannons) {
      const u = smooth(clamp01((t - c.aimStartT) / AIM_S));
      c.aim = { yaw: c.aimFrom.yaw + (c.aimTo.yaw - c.aimFrom.yaw) * u, pitch: c.aimFrom.pitch + (c.aimTo.pitch - c.aimFrom.pitch) * u };
    }

    if (s.endAt === null && t >= s.nextLaunchAt) launch(s, t, emit);
    if (s.endAt === null && s.reloads.length && s.reloads[0].at <= t) {
      // Race: a ball that scored is fired again from its cannon, at a fresh angle.
      const { cannon } = s.reloads.shift()!;
      fire(s, cannon, { yaw: s.rng.range(AIM_RANGE.yaw[0], AIM_RANGE.yaw[1]), pitch: s.rng.range(AIM_RANGE.pitch[0], AIM_RANGE.pitch[1]) }, t, emit);
    }

    s.world.step(dt, (c) => onContact(s, c, t, emit));

    const cup = s.course.cup;
    for (let i = 0; i < s.shots.length; i++) {
      const sh = s.shots[i];
      if (sh.done) continue;
      const b = sh.body;
      clampSpeed3(b, MAX_V);
      if (s.visual && Math.floor(t * 60) !== Math.floor((t - dt) * 60)) {
        sh.trail.push({ x: b.x, y: b.y, z: b.z });
        sh.recent.push({ t, x: b.x, y: b.y, z: b.z });
        while (sh.recent.length && sh.recent[0].t < t - REPLAY_LEN_S - 0.2) sh.recent.shift();
      }
      if (s.endAt !== null) continue;
      const flat = dm.hypot(b.x - cup.x, b.z - cup.z);
      // Near miss: over the cup's mouth, then away again without dropping in.
      const mouth = flat < cup.r + BALL_R * 1.5 && b.y > CUP_H && b.y < CUP_H + 0.6;
      if (mouth && !sh.inMouth) sh.inMouth = true;
      else if (!mouth && sh.inMouth) {
        sh.inMouth = false;
        if (b.y > CUP_H) emit({ type: 'nearMiss', who: i, x: b.x });
      }
      sh.inCupS = flat < cup.r && b.y < CUP_H ? sh.inCupS + dt : 0;
      if (sh.inCupS >= SINK_HOLD_S) {
        sink(s, i, t, emit);
        continue;
      }
      sh.slowS = speed3(b) < STUCK_V ? sh.slowS + dt : 0;
      if (sh.slowS >= STUCK_S) {
        sh.slowS = 0;
        if (p.mode === 'attempts') miss(s, i, t, emit, 'stuck');
        else {
          // Wedged somewhere: knock it loose.
          b.vx += s.rng.range(-1.5, 1.5);
          b.vz += s.rng.range(-1.5, 1.5);
          b.vy += s.rng.range(3, 5);
          emit({ type: 'unstick', who: i, x: b.x });
        }
      }
      if (p.mode === 'attempts' && !sh.done && ++sh.steps >= TEST_MAX_S * 240) miss(s, i, t, emit, 'timeout');
    }
    if (s.visual) updateCamera(s, t, dt);
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + (s.success ? OUTRO_WIN_S : OUTRO_FAIL_S);
  },

  hud(s) {
    const attempts = s.p.mode === 'attempts' ? s.shots.length : 1;
    const winner = s.winner >= 0 ? teamName(s.shots[s.winner].team) : '';
    const result =
      !s.success && s.endAt !== null
        ? `So close! ${attempts} tries.`
        : s.p.mode === 'attempts'
          ? `Attempt ${attempts}: nailed it!`
          : s.p.mode === 'race'
            ? `${winner} wins the race!`
            : `In after ${s.hits} bounces!`;
    const hud: Record<string, string | number | boolean> = { result, attempts, winner, outro: s.endAt !== null };
    if (s.p.mode === 'attempts') hud.attempt = Math.max(1, s.shots.length);
    else hud.bounces = s.hits;
    return hud;
  },

  overlays(p, copy) {
    const specs: OverlaySpec[] = [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.8, y: 0.12 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.13 },
    ];
    // Race shows its score as a row of chips instead of a counter.
    if (p.mode === 'attempts') specs.push({ kind: 'counter', key: 'attempt', label: 'ATTEMPT', y: 0.205, size: 96 });
    if (p.mode === 'bounce') specs.push({ kind: 'counter', key: 'bounces', label: 'BOUNCES', y: 0.205, size: 96 });
    return specs;
  },

  render(rc, s) {
    drawTrickShot3D(rc.ctx, rc.theme, s, rc.t);
  },

  renderTop({ ctx, theme }, s) {
    if (s.p.mode === 'race' && (s.endAt === null || s.t < s.endAt + 0.25)) {
      // Race score: a chip per ball with a pip per cup to win, filled as they score.
      const n = s.cannons.length;
      const w = 170;
      s.teams.forEach((team, i) => {
        const x = 540 + (i - (n - 1) / 2) * (w + 16);
        const y = 0.205 * 1920;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath();
        ctx.roundRect(x - w / 2, y - 34, w, 68, 34);
        ctx.fill();
        ctx.fillStyle = team.color;
        ctx.beginPath();
        ctx.arc(x - w / 2 + 34, y, 22, 0, Math.PI * 2);
        ctx.fill();
        for (let k = 0; k < s.p.racePoints; k++) {
          ctx.beginPath();
          ctx.arc(x - w / 2 + 80 + k * 32, y, 11, 0, Math.PI * 2);
          ctx.fillStyle = k < s.points[i] ? team.color : 'rgba(255,255,255,0.15)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      });
    }
    if (s.endAt === null || !s.success) return;
    const since = s.t - s.endAt - REPLAY_FROM_S;
    if (since < 0 || since > REPLAY_LEN_S / REPLAY_SPEED || s.replay.length < 2) return;
    ctx.save();
    ctx.globalAlpha = clamp01(since / 0.2) * clamp01((REPLAY_LEN_S / REPLAY_SPEED - since) / 0.2);
    ctx.font = `900 46px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 9;
    ctx.strokeStyle = theme.textStroke;
    const label = `⏪ REPLAY ${REPLAY_SPEED}×`;
    ctx.strokeText(label, 70, 0.27 * 1920);
    ctx.fillStyle = theme.text;
    ctx.fillText(label, 70, 0.27 * 1920);
    ctx.restore();
  },

  audio(e, { melody, theme, lastNoteT }) {
    const p = typeof e.x === 'number' ? pan(e.x as number) : 0;
    const vel = typeof e.impulse === 'number' ? clamp01((e.impulse as number) / 9) : 0.5;
    switch (e.type) {
      case 'hit':
        if (e.kind === 'bumper') return [{ kind: 'sfx', name: 'boom', vel: 0.25 + 0.3 * vel, pitch: 1.4, pan: p }];
        if (e.kind === 'rim') return [{ kind: 'sfx', name: 'clang', vel: 0.35 + 0.4 * vel, pan: p }];
        if (e.t - lastNoteT < 0.09) return [{ kind: 'sfx', name: 'clack', vel: 0.15 + 0.3 * vel, pan: p }];
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: (i ? 0.2 : 0.4) + 0.3 * vel, voice: theme.voice, pan: p }));
      case 'launch':
        return [{ kind: 'sfx', name: 'boom', vel: 0.55, pitch: 0.7, pan: p }];
      case 'nearMiss':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.5, pan: p }];
      case 'miss':
        return [{ kind: 'sfx', name: 'tick', vel: 0.5, pitch: 0.3, pan: p }];
      case 'point':
        return [
          { kind: 'sfx', name: 'chime', vel: 0.6, pitch: 0.8 + 0.2 * (e.points as number), pan: p },
          ...melody.next().map((midi) => ({ kind: 'note' as const, midi: midi + 12, vel: 0.45, voice: 'bell' as const, dur: 1.2, pan: p })),
        ];
      case 'sink':
        return [
          { kind: 'sfx', name: 'chime', vel: 0.9, pan: p },
          ...melody.peek().flatMap((midi) => [
            { kind: 'note' as const, midi, vel: 0.7, voice: 'bell' as const, dur: 2.4 },
            { kind: 'note' as const, midi: midi + 12, vel: 0.45, voice: 'bell' as const, dur: 2.4 },
          ]),
        ];
      case 'fail':
        return [{ kind: 'sfx', name: 'boom', vel: 0.5, pitch: 0.5 }];
    }
    return [];
  },

  score(events, { durationS, targetS, timedOut }): DramaScore {
    const end = events.find((e) => e.type === 'sink' || e.type === 'fail');
    const durFit = gaussFit(durationS, targetS, targetS * 0.2);
    if (timedOut || !end || end.type === 'fail') return { total: 0.02 * durFit, parts: { durFit }, notes: [end ? 'never went in' : 'no finish'] };
    const before = events.filter((e) => e.t < end.t);
    const near = before.filter((e) => e.type === 'nearMiss').length;
    const nearFit = 1 - dm.exp(-near / 1.5);
    // A rattle on the rim just before it drops is the best kind of finish.
    const rattle = before.filter((e) => e.type === 'hit' && e.kind === 'rim' && e.t > end.t - 1.5).length;
    const rattleFit = clamp01(rattle / 2);
    const hits = before.filter((e) => e.type === 'hit').length;
    const busyFit = clamp01(hits / Math.max(1, end.t * 2.5));
    const mode = end.mode as TrickShotParams['mode'];
    if (mode === 'attempts') {
      const misses = before.filter((e) => e.type === 'miss').map((e) => e.err as number);
      const attempts = misses.length + 1;
      const attemptFit = attempts < 3 ? 0.3 * attempts : 1;
      // It visibly learns: most misses after the first land closer than the first did.
      const learnFit = misses.length > 1 ? misses.slice(1).filter((m) => m < misses[0]).length / (misses.length - 1) : 0;
      const total = durFit * (0.35 + 0.2 * attemptFit + 0.2 * learnFit + 0.15 * nearFit + 0.1 * rattleFit);
      return { total, parts: { durFit, attemptFit, learnFit, nearFit, rattleFit }, notes: [`in on attempt ${attempts}`, `${near} near misses`] };
    }
    if (mode === 'race') {
      // A race that goes the distance: the runner-up one cup short, and the lead changing hands.
      const points = before.filter((e) => e.type === 'point');
      const leads = new Set(points.filter((e) => e.lead).map((e) => e.who)).size;
      const byWho = new Map<unknown, number>();
      for (const e of points) byWho.set(e.who, (byWho.get(e.who) ?? 0) + 1);
      const winnerPts = byWho.get(end.who) ?? 0;
      byWho.delete(end.who);
      const runnerUp = Math.max(0, ...byWho.values());
      const closeFit = winnerPts ? clamp01(runnerUp / winnerPts) : 0.5;
      const swingFit = clamp01((leads - 1) / 2);
      const total = durFit * (0.4 + 0.2 * closeFit + 0.15 * swingFit + 0.15 * nearFit + 0.1 * rattleFit);
      return { total, parts: { durFit, closeFit, swingFit, nearFit, rattleFit }, notes: [`${points.length + 1} cups`, `runner-up ${runnerUp}`] };
    }
    const total = durFit * (0.5 + 0.25 * nearFit + 0.15 * rattleFit + 0.1 * busyFit);
    return { total, parts: { durFit, nearFit, rattleFit, busyFit }, notes: [`in after ${hits} hits`, `${near} near misses`] };
  },
};

const smooth = (u: number) => u * u * (3 - 2 * u);
const speed3 = (b: Body3) => Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);

function clampSpeed3(b: Body3, max: number) {
  const v = speed3(b);
  if (v > max) {
    const k = max / v;
    b.vx *= k;
    b.vy *= k;
    b.vz *= k;
  }
}

/** Launch velocity for an aim from a cannon. */
function velocity(c: { home: number }, aim: Aim, v: number): Pt3 {
  const yaw = c.home + aim.yaw;
  const cp = dm.cos(aim.pitch);
  return { x: dm.cos(yaw) * cp * v, y: dm.sin(aim.pitch) * v, z: dm.sin(yaw) * cp * v };
}

const MUZZLE = 0.55;

/** Where a ball leaves the barrel, and its velocity. */
export function muzzle(c: Pt3 & { home: number }, aim: Aim, v: number): { at: Pt3; vel: Pt3 } {
  const vel = velocity(c, aim, v);
  const k = MUZZLE / v;
  return { at: { x: c.x + vel.x * k, y: c.y + vel.y * k, z: c.z + vel.z * k }, vel };
}

/**
 * Fire one test shot on a fresh copy of the course: does it go in, and if not, where does it land?
 * Mirrors the live step exactly (contact, speed clamp, cup and stuck checks in the same order), so the
 * live shot at the same aim plays out identically.
 */
function testShot(fresh: () => { world: World3D; course: Course }, p: TrickShotParams, cannon: Cannon, aim: Aim, v: number): { in: boolean; err: number; dx: number } {
  const { world, course } = fresh();
  const m = muzzle(cannon, aim, v);
  const b = world.addBody({ ...m.at, vx: m.vel.x, vy: m.vel.y, vz: m.vel.z, r: BALL_R, restitution: p.bounciness, friction: 0.04 });
  const cup = course.cup;
  const dt = 1 / 240;
  let inCupS = 0;
  let slowS = 0;
  const out = () => ({ in: false, err: dm.hypot(b.x - cup.x, b.z - cup.z), dx: b.x - cup.x });
  for (let k = 1; k <= TEST_MAX_S * 240; k++) {
    world.step(dt, (c) => {
      if (c.kind === 'shape' && (c.other as Shape3).tag === 'floor') b.alive = false;
    });
    if (!b.alive) return out();
    clampSpeed3(b, MAX_V);
    inCupS = dm.hypot(b.x - cup.x, b.z - cup.z) < cup.r && b.y < CUP_H ? inCupS + dt : 0;
    if (inCupS >= SINK_HOLD_S) return { in: true, err: 0, dx: 0 };
    slowS = speed3(b) < STUCK_V ? slowS + dt : 0;
    if (slowS >= STUCK_S) return out();
  }
  return out();
}

/**
 * Attempts mode: test-fire a grid of aims, then plan the run like a learner closing in. Each miss
 * lands nearer the cup than the last, on alternating sides, and the final shot is one that went in.
 * Every planned shot was really fired here, so the live run replays it exactly. Null when no test
 * shot goes in (the live run then aims blind and almost always fails).
 */
function planAttempts(rng: Rng, p: TrickShotParams, v: number, cannon: Cannon, fresh: () => { world: World3D; course: Course }): Aim[] | null {
  const tests: (Aim & { in: boolean; err: number; dx: number })[] = [];
  for (let i = 0; i < TEST_YAW; i++)
    for (let j = 0; j < TEST_PITCH; j++) {
      const aim = {
        yaw: AIM_RANGE.yaw[0] + ((AIM_RANGE.yaw[1] - AIM_RANGE.yaw[0]) * (i + 0.5)) / TEST_YAW,
        pitch: AIM_RANGE.pitch[0] + ((AIM_RANGE.pitch[1] - AIM_RANGE.pitch[0]) * (j + 0.5)) / TEST_PITCH,
      };
      tests.push({ ...aim, ...testShot(fresh, p, cannon, aim, v) });
    }
  const ins = tests.filter((x) => x.in);
  if (!ins.length) return null;
  const misses = tests.filter((x) => !x.in);
  const n = Math.min(misses.length + 1, rng.int(Math.min(4, p.maxAttempts), p.maxAttempts));
  // Wanted miss distances: from well off to just past the rim, shrinking geometrically.
  const first = rng.range(2.2, 3.2);
  const lastMiss = rng.range(0.5, 0.8);
  const shrink = n > 2 ? dm.pow(lastMiss / first, 1 / (n - 2)) : 1;
  let side = rng.chance(0.5) ? 1 : -1;
  const used = new Set<number>();
  const plan: Aim[] = [];
  for (let k = 0; k < n - 1; k++) {
    const want = first * dm.pow(shrink, k);
    // Closest to the wanted distance, preferring the side it should land on.
    const cost = (m: (typeof misses)[number]) => Math.abs(m.err - want) + (Math.sign(m.dx) === side ? 0 : 0.35);
    let pick = -1;
    for (let j = 0; j < misses.length; j++) if (!used.has(j) && (pick < 0 || cost(misses[j]) < cost(misses[pick]))) pick = j;
    used.add(pick);
    plan.push({ yaw: misses[pick].yaw, pitch: misses[pick].pitch });
    side = -side;
  }
  const hit = rng.pick(ins);
  plan.push({ yaw: hit.yaw, pitch: hit.pitch });
  return plan;
}

function launch(s: State, t: number, emit: StepCtx['emit']) {
  s.nextLaunchAt = Infinity;
  if (s.p.mode === 'attempts') fire(s, 0, s.plan?.[s.shots.length] ?? s.cannons[0].aim, t, emit);
  else s.cannons.forEach((c, i) => fire(s, i, c.aim, t, emit));
}

function fire(s: State, ci: number, aim: Aim, t: number, emit: StepCtx['emit']) {
  const c = s.cannons[ci];
  const m = muzzle(c, aim, s.speed);
  const body = s.world.addBody({ ...m.at, vx: m.vel.x, vy: m.vel.y, vz: m.vel.z, r: BALL_R, restitution: s.p.bounciness, friction: 0.04 });
  c.firedAt = t;
  c.aim = c.aimFrom = c.aimTo = aim;
  s.shots.push({ body, team: s.teams[ci], cannon: ci, aim, trail: [], recent: [], done: false, inCupS: 0, slowS: 0, inMouth: false, lastHitT: -10, steps: 0, launchedAt: t });
  emit({ type: 'launch', attempt: s.shots.length, x: c.x });
}

function onContact(s: State, c: Contact3, t: number, emit: StepCtx['emit']) {
  if (s.endAt !== null) return;
  const i = s.shots.findIndex((sh) => sh.body === c.body);
  if (i < 0) return;
  const sh = s.shots[i];
  if (sh.done) return;
  const tag = c.kind === 'body' ? 'ball' : (c.other as Shape3).tag;
  if (tag === 'floor') {
    if (s.p.mode === 'attempts') {
      miss(s, i, t, emit, 'floor');
      return;
    }
    // Bounce and race: a springy floor that always sends the ball back up into the cabinet.
    // A seeded sideways nudge on every floor bounce keeps the ball roaming the cabinet (otherwise it
    // can settle into bouncing straight up and down in one spot, forever).
    const vMin = Math.sqrt(2 * s.p.gravity * MIN_REBOUND_H);
    if (c.body.vy < vMin) c.body.vy = vMin;
    c.body.vx += s.rng.range(-FLOOR_NUDGE, FLOOR_NUDGE);
    c.body.vz += s.rng.range(-FLOOR_NUDGE, FLOOR_NUDGE);
  }
  if (c.impulse < 0.6 || t - sh.lastHitT < 0.05) return;
  sh.lastHitT = t;
  const kind = tag === 'cup' ? (c.y > CUP_H - 0.08 ? 'rim' : 'cup') : tag;
  if (kind === 'cupFloor' || kind === 'cup') return;
  s.hits++;
  emit({ type: 'hit', kind, x: c.x, impulse: c.impulse, who: i });
  if (c.kind === 'shape') {
    const ob = s.course.obstacles.find((o) => o.shape === c.other);
    if (ob) ob.hitAt = t;
  }
}

function miss(s: State, i: number, t: number, emit: StepCtx['emit'], why: 'floor' | 'stuck' | 'timeout') {
  const sh = s.shots[i];
  sh.done = true;
  sh.body.alive = false;
  const { cup } = s.course;
  emit({ type: 'miss', attempt: s.shots.length, err: dm.hypot(sh.body.x - cup.x, sh.body.z - cup.z), why, x: sh.body.x });
  if (s.shots.length >= s.p.maxAttempts) {
    s.endAt = t;
    emit({ type: 'fail', mode: s.p.mode, attempts: s.shots.length });
    return;
  }
  // Swing the barrel round to the next aim during the pause.
  s.nextLaunchAt = t + RETRY_S + AIM_S;
  const c = s.cannons[0];
  c.aimFrom = c.aim;
  c.aimTo = s.plan?.[s.shots.length] ?? { yaw: s.rng.range(AIM_RANGE.yaw[0], AIM_RANGE.yaw[1]), pitch: s.rng.range(AIM_RANGE.pitch[0], AIM_RANGE.pitch[1]) };
  c.aimStartT = t + RETRY_S;
}

function sink(s: State, i: number, t: number, emit: StepCtx['emit']) {
  const sh = s.shots[i];
  if (s.p.mode === 'race' && ++s.points[sh.cannon] < s.p.racePoints) {
    // Not the winning cup yet: score it, clear the ball and reload its cannon.
    sh.done = true;
    sh.body.alive = false;
    s.reloads.push({ cannon: sh.cannon, at: t + RELOAD_S });
    const lead = Math.max(...s.points);
    emit({ type: 'point', who: sh.cannon, points: s.points[sh.cannon], lead: s.points[sh.cannon] === lead && s.points.filter((x) => x === lead).length === 1, x: sh.body.x });
    return;
  }
  s.success = true;
  s.winner = i;
  s.endAt = t;
  s.replay = sh.recent.filter((q) => q.t >= t - REPLAY_LEN_S);
  emit({ type: 'sink', who: sh.cannon, attempt: s.shots.length, mode: s.p.mode, x: sh.body.x });
}
