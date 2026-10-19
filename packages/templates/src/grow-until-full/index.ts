import { z } from 'zod';
import { hexToRgb, lighten, paletteAt, rgbToCss, type Ctx2D, type DramaScore, type RGB, type Rng, type SimEvent, type Template, type Theme } from '@sim/engine';
import { TAU, clampSpeed, speed, type Ball } from '@sim/physics';
import { clamp01, gaussFit } from '../scoring';
import { COLOR_TEAMS, pickTeams, type Team } from '../fx';
import * as dm from '@sim/physics/math';
import { bodyContact, clampInside, collideArena, crowdFit, makeArena, traceOutline, traceShape, type Arena, type CrowdFit } from './arena';
import { drawFace, drawRings, type Mood } from './draw';

export const growUntilFullSchema = z.object({
  mode: z.enum(['single', 'crowd', 'mitosis']).default('single').meta({ title: 'Mode' }),
  arena: z.enum(['circle', 'square', 'hexagon', 'triangle']).default('circle').meta({ title: 'Arena shape' }),
  arenaRadius: z.number().min(250).max(470).default(440).meta({ title: 'Arena radius' }),
  startRadius: z.number().min(6).max(80).default(18).meta({ title: 'Starting ball radius' }),
  growth: z.number().min(0.5).max(20).default(4).meta({ title: 'Growth per bounce (px)', step: 0.5 }),
  fullAt: z.number().min(0.7).max(0.99).default(0.95).meta({ title: 'Full at (fraction of arena, single)', step: 0.01 }),
  balls: z.number().int().min(2).max(8).default(4).meta({ title: 'Balls (crowd in a circle; other arenas use their own count)' }),
  splitAt: z.number().min(0.15).max(0.5).default(0.3).meta({ title: 'Split at (fraction of arena, mitosis)', step: 0.01 }),
  fillArea: z.number().min(0.3).max(0.6).default(0.5).meta({ title: 'Full at (share of area, mitosis & circle crowd)', step: 0.01 }),
  gravity: z.number().min(0).max(3000).default(1500).meta({ title: 'Gravity', step: 50 }),
  launchSpeed: z.number().min(200).max(1500).default(800).meta({ title: 'Launch speed', step: 10 }),
  minBounceSpeed: z.number().min(200).max(1500).default(750).meta({ title: 'Min bounce speed', step: 10 }),
  style: z.enum(['paint', 'clean', 'rings', 'face']).default('paint').meta({ title: 'Style' }),
  paintEvery: z.number().int().min(1).max(10).default(2).meta({ title: 'Paint every N frames' }),
  progress: z.boolean().default(true).meta({ title: 'Progress arc' }),
});

export type GrowUntilFullParams = z.infer<typeof growUntilFullSchema>;

interface Blob extends Ball {
  /** Wall bounces this ball (and, in mitosis, its ancestors) has had. */
  n: number;
  /** Palette position (mitosis colours drift apart with each split). */
  hue: number;
  team: Team | null;
  /** 1 on a wall hit, decaying (face style winces). */
  hit: number;
  /** Mitosis: radius at which this ball splits (varies per ball so splits don't all happen at once). */
  splitR: number;
}

interface State {
  p: GrowUntilFullParams;
  /** The seeded sim randomness, kept for mitosis splits. */
  rng: Rng;
  arena: Arena;
  balls: Blob[];
  bounces: number;
  fullAt: number | null;
  /** Crowd: index of the biggest ball once full. */
  winner: number;
  /** Crowd in a polygon: piece count and the size each piece can grow to. */
  fit: CrowdFit | null;
  /** Last time a piece grew: a polygon crowd that can't grow any more is as full as it gets. */
  lastGrowT: number;
  /** Polygon crowd: the first piece to reach full size (it wins). */
  firstFull: number;
  flash: number;
  ringFlash: number;
  t: number;
}

const OUTRO_S = 1.8;
/** A polygon crowd that hasn't grown for this long is as full as it can get. */
const STALL_S = 1.5;
/** A single polygon ball eases out to this share of the arena at the end, its outline just meeting the wall. */
const PERFECT_FILL = 1 / 1.025;
const MAX_BALLS = 64;
const MAX_SPEED = 2600;
/** Sideways push the two halves get when a ball splits. */
const SPLIT_KICK = 320;
/** Growth multiplier per mode, so every mode runs about as long at default settings. */
const MODE_PACE = { single: 1, crowd: 0.45, mitosis: 0.72 };
const paintLayers = new WeakMap<State, { canvas: OffscreenCanvas | HTMLCanvasElement; lastFrame: number }>();

/** 0 → 1 as the arena fills: the single ball's size, or the crowd's share of the area. */
function progressOf(s: State): number {
  const { p, arena } = s;
  if (p.mode === 'single') return Math.min(1, s.balls[0].r / (arena.inR * p.fullAt));
  return Math.min(1, areaShare(s) / (s.fit ? fullShare(s.fit, arena) : p.fillArea));
}

/** Area share when every piece of a polygon crowd is full size. */
const fullShare = (fit: CrowdFit, arena: Arena) => (fit.count * (fit.r * PERFECT_FILL) ** 2) / arena.inR ** 2;

const growthOf = (s: State) => s.p.growth * s.arena.pace * MODE_PACE[s.p.mode];

/** Total ball area relative to the largest circle that fits in the arena. */
function areaShare(s: State): number {
  let a = 0;
  for (const b of s.balls) a += b.r * b.r;
  return a / (s.arena.inR * s.arena.inR);
}

const blob = (x: number, y: number, vx: number, vy: number, r: number, hue = 0, team: Team | null = null): Blob => ({ x, y, vx, vy, r, n: 0, hue, team, hit: 0, splitR: Infinity });

/** Mitosis split sizes vary ±20% around splitAt. */
const nextSplitR = (s: State) => s.p.splitAt * s.arena.inR * s.rng.range(0.8, 1.2);

export const growUntilFull: Template<GrowUntilFullParams, State> = {
  id: 'grow-until-full',
  name: 'Grow Until Full',
  family: 'bounce',
  description:
    'A ball bounces inside an arena (circle, square, hexagon or triangle) and grows a little on every bounce until it fills it. As it grows the bounces get faster and faster. ' +
    'In the square, hexagon and triangle arenas the "ball" is the same shape as the arena (never rotating), so it can fill it perfectly. ' +
    'Modes: single (one ball fills the arena); crowd (several coloured balls grow and jostle until together they fill it, the biggest wins; in a polygon arena 4 squares, 3 hexagons or 3 triangles grow until they pack it as tightly as they can, and the first to full size wins); ' +
    'mitosis (the ball splits in two whenever it gets big enough, and the halves keep growing and splitting until the arena is full). ' +
    'Styles: paint (colourful outline trail), clean, rings (tree rings, one band per bounce) and face (cartoon faces that panic as space runs out). A progress arc around the arena shows how full it is.',
  schema: growUntilFullSchema,
  substeps: 4,
  // Big solid fills blow out under full bloom; crowd colours must stay tellable apart.
  glowScale: (p) => (p.mode === 'crowd' ? 0.4 : 1),
  defaultCopy: {
    hook: 'Every bounce makes it bigger…',
    cta: 'How many bounces did you guess?',
  },
  nudges: ["Guess the bounces before it's full 👇", "Comment your bounce count 👇", "How long until it fills? Guess 👇", "Lock in a number 👇", "Your guess goes in the comments 👇", "Call it before it fills 👇"],

  init({ params: p, rng, width, height }) {
    const arena = makeArena(p.arena, p.arenaRadius, width / 2, height * 0.53);
    const { cx, cy, inR } = arena;
    const balls: Blob[] = [];
    const fit = p.mode === 'crowd' ? crowdFit(arena) : null;
    if (p.mode === 'crowd') {
      const teams = pickTeams(COLOR_TEAMS, fit ? fit.count : p.balls, rng);
      for (const team of teams) {
        let x = cx;
        let y = cy;
        for (let tries = 0; tries < 60; tries++) {
          const a = rng.range(0, TAU);
          const d = rng.range(0, inR * 0.6);
          x = cx + dm.cos(a) * d;
          y = cy + dm.sin(a) * d;
          if (balls.every((b) => dm.hypot(b.x - x, b.y - y) > 2 * p.startRadius * arena.circum + 12)) break;
        }
        const a = rng.range(0, TAU);
        balls.push(blob(x, y, dm.cos(a) * p.launchSpeed, dm.sin(a) * p.launchSpeed, p.startRadius, 0, team));
      }
    } else {
      const a = rng.range(0, TAU);
      balls.push(blob(cx + rng.range(-40, 40), cy - inR * 0.3, dm.cos(a) * p.launchSpeed, dm.sin(a) * p.launchSpeed, p.startRadius));
    }
    const s: State = { p, rng, arena, balls, bounces: 0, fullAt: null, winner: -1, fit, lastGrowT: 0, firstFull: -1, flash: 0, ringFlash: 0, t: 0 };
    if (p.mode === 'mitosis') balls[0].splitR = nextSplitR(s);
    return s;
  },

  step(s, { dt, t, emit }) {
    if (s.fullAt === null) {
      if (s.p.mode === 'single') stepSingle(s, dt, t, emit);
      else stepMany(s, dt, t, emit);
    } else if (s.p.mode === 'single') {
      // Settle into the centre; a polygon also grows the last bit to fill its arena exactly.
      const ball = s.balls[0];
      const k = 1 - dm.exp(-6 * dt);
      ball.x += (s.arena.cx - ball.x) * k;
      ball.y += (s.arena.cy - ball.y) * k;
      if (s.arena.shape !== 'circle') ball.r += (s.arena.inR * PERFECT_FILL - ball.r) * k;
    } else {
      // Ease apart any overlap left at the end.
      settle(s, 2);
    }
    for (const b of s.balls) b.hit *= dm.exp(-8 * dt);
    s.flash *= dm.exp(-4 * dt);
    s.ringFlash *= dm.exp(-10 * dt);
    s.t = t + dt;
  },

  isDone(s) {
    return s.fullAt !== null && s.t >= s.fullAt + OUTRO_S;
  },

  hud(s) {
    const w = s.balls[s.winner];
    return {
      size: `${Math.round(progressOf(s) * 100)}%`,
      bounces: s.bounces,
      balls: s.balls.length,
      winner: w?.team?.label ?? '',
      outro: s.fullAt !== null,
    };
  },

  overlays(p, copy) {
    const counter = p.mode === 'mitosis' ? { key: 'balls', label: 'BALLS' } : { key: 'bounces', label: 'BOUNCES' };
    // Mitosis counts pieces, not bounces: the stock CTA would ask the wrong question.
    const cta = p.mode === 'mitosis' && copy.cta === growUntilFull.defaultCopy.cta ? 'How many did you guess?' : copy.cta;
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.6, y: 0.12 },
      { kind: 'counter', ...counter, y: 0.205, size: 100 },
      { kind: 'cta', text: cta, when: 'outro', y: 0.17 },
    ];
  },

  render({ ctx, theme, frame, width, height }, s) {
    const { p, arena, balls } = s;

    if (p.style === 'paint') {
      let layer = paintLayers.get(s);
      if (!layer) {
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
        layer = { canvas, lastFrame: -1 };
        paintLayers.set(s, layer);
      }
      if (frame !== layer.lastFrame && frame % p.paintEvery === 0 && s.fullAt === null) {
        const pc = layer.canvas.getContext('2d') as Ctx2D;
        pc.lineWidth = 2.5;
        for (const b of balls) {
          pc.strokeStyle = rgbToCss(ballColor(s, b, theme), 0.55);
          traceShape(pc, arena, b.x, b.y, b.r);
          pc.stroke();
        }
      }
      layer.lastFrame = frame;
      ctx.drawImage(layer.canvas, 0, 0);
    }

    ctx.strokeStyle = rgbToCss(lighten(paletteAt(theme.palette, 0.9), s.ringFlash * 0.6));
    ctx.lineWidth = 10 + s.ringFlash * 6;
    ctx.lineJoin = 'round';
    traceOutline(ctx, arena, 5);
    ctx.stroke();

    if (p.progress) drawProgress(ctx, s, theme);

    for (const b of balls) {
      const col = ballColor(s, b, theme);
      if (p.style === 'rings') {
        drawRings(ctx, b.r, b.n, growthOf(s), (k) => ringColor(s, b, k, theme), (rr) => traceShape(ctx, arena, b.x, b.y, rr));
      } else {
        ctx.fillStyle = rgbToCss(col, p.style === 'paint' ? 0.85 : 1);
        traceShape(ctx, arena, b.x, b.y, b.r);
        ctx.fill();
      }
      ctx.lineWidth = Math.max(p.mode === 'single' ? 3 : 2, b.r * 0.05);
      ctx.strokeStyle = theme.ball;
      traceShape(ctx, arena, b.x, b.y, b.r);
      ctx.stroke();
    }

    // Crowd: ring the biggest ball once it's full.
    const w = balls[s.winner];
    if (w && s.fullAt !== null) {
      const pulse = 0.5 + 0.5 * Math.sin((s.t - s.fullAt) * 9);
      ctx.strokeStyle = `rgba(255,255,255,${(0.6 + 0.4 * pulse).toFixed(3)})`;
      ctx.lineWidth = 6 + 4 * pulse;
      traceShape(ctx, arena, w.x, w.y, w.r + 8);
      ctx.stroke();
    }

    if (s.flash > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${(s.flash * 0.5).toFixed(3)})`;
      ctx.fillRect(0, 0, width, height);
    }
  },

  renderTop({ ctx }, s) {
    if (s.p.style !== 'face') return;
    const u = progressOf(s);
    const shared: Mood = s.fullAt !== null ? 'happy' : u < 0.45 ? 'calm' : u < 0.8 ? 'worried' : 'panic';
    s.balls.forEach((b, i) => {
      const mood = s.winner >= 0 && i !== s.winner ? 'sad' : shared;
      drawFace(ctx, b, mood, s.t, i);
    });
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, ((e.x as number) - 540) / 540)) : 0;
    switch (e.type) {
      case 'bounce': {
        if (e.t - lastNoteT < 0.06) return [{ kind: 'sfx', name: 'tick', vel: 0.2, pan }];
        const vel = 0.55 + 0.4 * clamp01((e.speed as number) / 1500);
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? vel * 0.45 : vel, voice: theme.voice, pan }));
      }
      case 'clack':
        return [{ kind: 'sfx', name: 'clack', vel: 0.12 + 0.3 * clamp01((e.speed as number) / 1500), pan }];
      case 'split':
        return [{ kind: 'sfx', name: 'pop', vel: 0.7, pan }];
      case 'full':
        return [
          { kind: 'sfx', name: 'boom', vel: 1 },
          ...melody.peek().flatMap((midi) => [
            { kind: 'note' as const, midi, vel: 0.8, voice: 'bell' as const, dur: 2.5 },
            { kind: 'note' as const, midi: midi + 12, vel: 0.5, voice: 'bell' as const, dur: 2.5 },
          ]),
        ];
    }
    return [];
  },

  score(events, { durationS, targetS, timedOut }): DramaScore {
    const full = events.find((e) => e.type === 'full');
    const durFit = gaussFit(durationS, targetS, targetS * 0.2);
    if (timedOut || !full) return { total: 0.02 * durFit, parts: { durFit }, notes: ['never filled'] };
    const bounces = events.filter((e) => e.type === 'bounce');
    // Escalation: bounce rate in the last quarter vs the first quarter.
    const q = full.t / 4;
    const early = bounces.filter((b) => b.t < q).length / q;
    const late = bounces.filter((b) => b.t > full.t - q).length / q;
    const escalation = clamp01(dm.log(Math.max(1, late / Math.max(0.5, early))) / dm.log(6));
    return {
      total: durFit * (0.6 + 0.4 * escalation),
      parts: { durFit, escalation },
      notes: [
        `${bounces.length} bounces, full at ${full.t.toFixed(1)}s${typeof full.balls === 'number' && full.balls > 1 ? ` with ${full.balls} balls` : ''}`,
        `bounce rate ${early.toFixed(1)}/s → ${late.toFixed(1)}/s`,
      ],
    };
  },
};

type Emit = (e: Omit<SimEvent, 't'>) => void;

/** One ball: grows on every wall bounce until it reaches fullAt of the arena. */
function stepSingle(s: State, dt: number, t: number, emit: Emit) {
  const { p, arena } = s;
  const ball = s.balls[0];
  const fullR = arena.inR * p.fullAt;
  const n = Math.max(1, Math.ceil((speed(ball) * dt) / Math.max(2, (arena.inR - ball.r) * 0.25)));
  const h = dt / n;
  for (let k = 0; k < n && s.fullAt === null; k++) {
    ball.vy += p.gravity * h;
    ball.x += ball.vx * h;
    ball.y += ball.vy * h;
    const impact = collideArena(arena, ball, p.minBounceSpeed);
    if (impact > 0) {
      s.bounces++;
      ball.n++;
      ball.hit = 1;
      s.ringFlash = 1;
      ball.r = Math.min(fullR, ball.r + growthOf(s));
      emit({ type: 'bounce', speed: impact, size: ball.r / arena.inR, x: ball.x });
      if (ball.r >= fullR - 1e-6) {
        s.fullAt = t + k * h;
        s.flash = 1;
        ball.vx = 0;
        ball.vy = 0;
        emit({ type: 'full', bounces: s.bounces, balls: 1 });
      }
    }
  }
}

/** Crowd and mitosis: several balls collide with each other; full when their area reaches fillArea. */
function stepMany(s: State, dt: number, t: number, emit: Emit) {
  const { p, arena, balls } = s;
  let vmax = 0;
  let rmin = Infinity;
  for (const b of balls) {
    vmax = Math.max(vmax, speed(b));
    rmin = Math.min(rmin, b.r);
  }
  const n = Math.min(32, Math.max(1, Math.ceil((vmax * dt) / Math.max(2, rmin * 0.5))));
  const h = dt / n;
  for (let k = 0; k < n && s.fullAt === null; k++) {
    const at = t + k * h;
    for (const b of balls) {
      b.vy += p.gravity * h;
      b.x += b.vx * h;
      b.y += b.vy * h;
    }
    // A few relaxation passes so growing balls packed together don't overlap.
    for (let pass = 0; pass < 3 && s.fullAt === null; pass++) {
      collidePairs(s, emit);
      for (let i = 0; i < balls.length && s.fullAt === null; i++) {
        const impact = collideArena(arena, balls[i], p.minBounceSpeed);
        if (impact > 0) wallBounce(s, i, impact, at, emit);
      }
    }
    for (const b of balls) clampSpeed(b, MAX_SPEED);
  }
  if (s.fit && s.fullAt === null && t + dt - s.lastGrowT > STALL_S) finish(s, t + dt, emit);
}

function wallBounce(s: State, i: number, impact: number, at: number, emit: Emit) {
  const { p, arena, balls } = s;
  const b = balls[i];
  s.bounces++;
  b.n++;
  b.hit = 1;
  s.ringFlash = 1;
  // Grow (and maybe split), then make sure everything still fits: growth that would wedge balls
  // together (flat-faced polygons in a row can't slide past each other) is undone, and a smaller
  // step tried instead so pieces can creep into the last gaps.
  const saved = { ...b };
  const before = balls.map((o) => [o.x, o.y]);
  const cap = s.fit ? s.fit.r * PERFECT_FILL : Infinity;
  let split = false;
  for (const step of [1, 0.5, 0.25]) {
    b.r = Math.min(saved.r + growthOf(s) * step, cap);
    if (b.r <= saved.r) break;
    split = step === 1 && b.r >= b.splitR && balls.length < MAX_BALLS;
    if (split) splitBall(s, b);
    const changed = split ? [b, balls[balls.length - 1]] : [b];
    settle(s, 12);
    if (!changed.some((c) => worstOverlap(s, c) > 1)) break;
    split = false;
    balls.length = before.length;
    balls.forEach((o, j) => {
      o.x = before[j][0];
      o.y = before[j][1];
    });
    Object.assign(b, saved);
  }
  if (b.r > saved.r) s.lastGrowT = at;
  if (split) emit({ type: 'split', balls: balls.length, x: b.x });
  if (b.r >= cap - 1e-6 && s.firstFull < 0) s.firstFull = i;
  emit({ type: 'bounce', speed: impact, size: b.r / arena.inR, x: b.x });
  if (s.fit ? balls.every((o) => o.r >= cap - 1e-6) : areaShare(s) >= p.fillArea) finish(s, at, emit);
}

/** The arena is as full as it gets: freeze, crown the crowd's winner and celebrate. */
function finish(s: State, at: number, emit: Emit) {
  const { p, balls } = s;
  s.fullAt = at;
  s.flash = 1;
  for (const o of balls) {
    o.vx = 0;
    o.vy = 0;
  }
  if (p.mode !== 'crowd') return emit({ type: 'full', bounces: s.bounces, balls: balls.length });
  // First to full size, else the biggest.
  s.winner = s.firstFull >= 0 ? s.firstFull : balls.reduce((w, o, j) => (o.r > balls[w].r ? j : w), 0);
  emit({ type: 'full', bounces: s.bounces, balls: balls.length, winner: balls[s.winner].team!.label, share: progressOf(s) });
}

/**
 * Split across the direction of travel into two unequal halves of the same total area, each flush
 * with its side of the parent (a polygon splits along its nearest edge normal). The new half goes last.
 */
function splitBall(s: State, b: Blob) {
  const { arena } = s;
  const sp = Math.max(1e-6, speed(b));
  let ex = -b.vy / sp;
  let ey = b.vx / sp;
  let f1 = 1;
  let f2 = 1;
  if (arena.ux.length) {
    let kb = 0;
    for (let k = 1; k < arena.ux.length; k++) if (Math.abs(arena.ux[k] * ex + arena.uy[k] * ey) > Math.abs(arena.ux[kb] * ex + arena.uy[kb] * ey)) kb = k;
    const sign = arena.ux[kb] * ex + arena.uy[kb] * ey >= 0 ? 1 : -1;
    ex = sign * arena.ux[kb];
    ey = sign * arena.uy[kb];
    f1 = sign > 0 ? 1 : arena.back;
    f2 = sign > 0 ? arena.back : 1;
  }
  const share = s.rng.range(0.38, 0.62);
  const r1 = b.r * Math.sqrt(share);
  const r2 = b.r * Math.sqrt(1 - share);
  const off2 = f2 * (b.r - r2);
  const half = blob(b.x - ex * off2, b.y - ey * off2, b.vx - ex * SPLIT_KICK, b.vy - ey * SPLIT_KICK, r2, (b.hue + 0.93) % 1, b.team);
  half.n = b.n;
  half.splitR = nextSplitR(s);
  s.balls.push(half);
  b.x += ex * f1 * (b.r - r1);
  b.y += ey * f1 * (b.r - r1);
  b.vx += ex * SPLIT_KICK;
  b.vy += ey * SPLIT_KICK;
  b.r = r1;
  b.hue = (b.hue + 0.07) % 1;
  b.splitR = nextSplitR(s);
}

const contact = { nx: 1, ny: 0 };

/** Push overlapping balls apart (by mass) and back inside the arena, positions only. */
function settle(s: State, passes: number) {
  const { arena, balls } = s;
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < balls.length; i++)
      for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i];
        const b = balls[j];
        const overlap = bodyContact(arena, a, b, contact);
        if (overlap <= 0) continue;
        const ma = a.r * a.r;
        const mb = b.r * b.r;
        const mt = ma + mb;
        a.x -= contact.nx * overlap * (mb / mt);
        a.y -= contact.ny * overlap * (mb / mt);
        b.x += contact.nx * overlap * (ma / mt);
        b.y += contact.ny * overlap * (ma / mt);
      }
    for (const b of balls) clampInside(arena, b);
  }
}

/** Deepest overlap between this ball and any other. */
function worstOverlap(s: State, b: Blob): number {
  let worst = 0;
  for (const o of s.balls) if (o !== b) worst = Math.max(worst, bodyContact(s.arena, b, o, contact));
  return worst;
}


/** Elastic ball-ball collisions, mass ∝ area; overlaps are pushed apart. */
function collidePairs(s: State, emit: Emit) {
  const { arena, balls } = s;
  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    for (let j = i + 1; j < balls.length; j++) {
      const b = balls[j];
      const overlap = bodyContact(arena, a, b, contact);
      if (overlap <= 0) continue;
      const { nx, ny } = contact;
      const ma = a.r * a.r;
      const mb = b.r * b.r;
      const mt = ma + mb;
      a.x -= nx * overlap * (mb / mt);
      a.y -= ny * overlap * (mb / mt);
      b.x += nx * overlap * (ma / mt);
      b.y += ny * overlap * (ma / mt);
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel >= 0) continue;
      const imp = (-2 * rel) / (1 / ma + 1 / mb);
      a.vx -= (imp / ma) * nx;
      a.vy -= (imp / ma) * ny;
      b.vx += (imp / mb) * nx;
      b.vy += (imp / mb) * ny;
      if (-rel > 150) emit({ type: 'clack', speed: -rel, x: (a.x + b.x) / 2 });
    }
  }
}

function ballColor(s: State, b: Blob, theme: Theme): RGB {
  if (b.team) return hexToRgb(b.team.color);
  if (s.p.mode === 'mitosis') return paletteAt(theme.palette, b.hue);
  if (s.p.style === 'paint') return paletteAt(theme.palette, (s.t * 0.08) % 1);
  const { p, arena } = s;
  return paletteAt(theme.palette, clamp01((b.r - p.startRadius) / Math.max(1, arena.inR * p.fullAt - p.startRadius)));
}

/** Tree-ring band colours: shades of a crowd ball's colour, otherwise a walk through the palette. */
function ringColor(s: State, b: Blob, k: number, theme: Theme): RGB {
  if (b.team) return lighten(hexToRgb(b.team.color), [0, 0.25, 0.45][k % 3]);
  return lighten(paletteAt(theme.palette, (b.hue + k * 0.045) % 1), k % 2 ? 0.18 : 0);
}

/** Progress bar running clockwise from the top, just outside the arena wall. */
function drawProgress(ctx: Ctx2D, s: State, theme: Theme) {
  const u = clamp01(progressOf(s));
  ctx.save();
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = rgbToCss(paletteAt(theme.palette, 0.9), 0.16);
  const len = traceOutline(ctx, s.arena, 30);
  ctx.stroke();
  if (u > 0.002) {
    ctx.setLineDash([u * len, len + 1]);
    ctx.strokeStyle = rgbToCss(lighten(paletteAt(theme.palette, u), 0.15 + 0.5 * s.ringFlash * u));
    ctx.stroke();
  }
  ctx.restore();
}
