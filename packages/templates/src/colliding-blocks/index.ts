import { z } from 'zod';
import { FONT_FAMILY, lighten, paletteAt, rgbToCss, type Ctx2D, type DramaScore, type Template } from '@sim/engine';
import { gaussFit } from '../scoring';
import { scaleNote } from '../music';
import { advance, makeBlocks, type Blocks } from './blocks';

export const collidingBlocksSchema = z.object({
  digits: z.number().int().min(3).max(6).default(5).meta({ title: 'Digits of π (final round)' }),
  staged: z.boolean().default(true).meta({ title: 'Play every round (1 kg, 100 kg, …)' }),
  diagram: z.boolean().default(true).meta({ title: 'Velocity circle diagram' }),
  burstSeconds: z.number().min(0.6).max(3).default(1.6).meta({ title: 'Collision burst length (s)' }),
});

export type CollidingBlocksParams = z.infer<typeof collidingBlocksSchema>;

interface Round {
  ratio: number;
  /** Mass exponent: the big block is 10^exp kg. */
  exp: number;
  /** Collision times of the whole round, simulated up front (drives slow-mo and fast-forward). */
  times: Float64Array;
  /** Velocity-space point after each collision (visual only): x = √M·V, y = √m·v, unit circle. */
  pts: Float32Array | null;
  w2: number;
  start: { x1: number; x2: number; v: number };
}

type Phase = 'intro' | 'run' | 'hold' | 'reveal';

interface State {
  p: CollidingBlocksParams;
  rounds: Round[];
  r: number;
  phase: Phase;
  phaseAt: number;
  b: Blocks;
  tau: number;
  rate: number;
  /** Sim time of the last collision. */
  lastHitTau: number;
  lastHitT: number;
  lastWallT: number;
  lastClackT: number;
  /** Collisions not yet sounded. */
  pendN: number;
  pendWall: number;
  results: number[];
  /** Digit notes still to play: [time, digit, index]. */
  digitQueue: [number, number, number][];
  /** How many digits of the reveal have lit up. */
  litDigits: number;
  holdS: number;
  visual: boolean;
  t: number;
}

const W1 = 70; // small block size (also its width in the physics)
const WALL_X = 96;
const FLOOR_Y = 1440;
const DIAG = { x: 540, y: 860, r: 190 };
const INTRO_S = 0.6;
const HOLD_MIN_S = 1.4;
const DIGIT_GAP_S = 0.16;
const REVEAL_S = 4.2;
const FAST_FORWARD = 3;

const massLabel = (exp: number) => `${(10 ** exp).toLocaleString('en-US')} kg`;
const fmtCount = (n: number) => String(n);

export const collidingBlocks: Template<CollidingBlocksParams, State> = {
  id: 'colliding-blocks',
  name: 'Colliding Blocks π',
  family: 'bounce',
  description:
    'A heavy block slides into a small one in front of a wall. Count the collisions: 3, 31, 314, 3141… each round 100× heavier, the counts spell out the digits of π. A velocity-circle diagram shows why. CTAs may use {count} (the final round\'s collision count).',
  schema: collidingBlocksSchema,
  substeps: 4,
  searchBudget: 4,
  glowScale: 0.4,
  ownMusic: true,
  defaultCopy: {
    hook: 'How many times will the blocks collide?',
    cta: '{count} collisions… those are the digits of π 🤯',
  },
  nudges: ["Guess the collision count 👇", "How many clacks? Comment 👇", "Lock in a number 👇", "Guess the last round's count 👇", "Comment your guess 👇", "Spot the pattern yet? 👇"],

  init({ params: p, rng, visual }) {
    const exps = p.staged ? Array.from({ length: p.digits }, (_, k) => 2 * k) : [2 * (p.digits - 1)];
    const rounds: Round[] = exps.map((exp, k) => {
      const ratio = 100 ** (exp / 2);
      const start = { x1: rng.range(230, 280), x2: 0, v: rng.range(250, 290) };
      start.x2 = start.x1 + W1 + rng.range(150, 200);
      const times: number[] = [];
      const sim = makeBlocks(ratio, { ...start, w1: W1 });
      // The same round run instantly, keeping each collision's exact time (and diagram point).
      const pts: number[] | null = visual ? [-1, 0] : null;
      const norm = Math.sqrt(ratio) * start.v;
      advance(sim, Infinity, (bb, _wall, at) => {
        times.push(at);
        pts?.push((Math.sqrt(bb.m2) * bb.v2) / norm, bb.v1 / norm);
      });
      const w2 = 120 + 40 * (p.staged ? k : p.digits - 1);
      return { ratio, exp, times: Float64Array.from(times), pts: pts ? Float32Array.from(pts) : null, w2, start };
    });
    return {
      p,
      rounds,
      r: 0,
      phase: 'intro',
      phaseAt: 0,
      b: makeBlocks(rounds[0].ratio, { ...rounds[0].start, w1: W1 }),
      tau: 0,
      rate: 1,
      lastHitTau: 0,
      lastHitT: -9,
      lastWallT: -9,
      lastClackT: -9,
      pendN: 0,
      pendWall: 0,
      results: [],
      digitQueue: [],
      litDigits: 0,
      holdS: HOLD_MIN_S,
      visual,
      t: 0,
    };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    while (s.digitQueue.length && s.digitQueue[0][0] <= t) {
      const [, digit, i] = s.digitQueue.shift()!;
      emit({ type: 'digit', digit, i, reveal: s.phase === 'reveal' });
      if (s.phase === 'reveal') s.litDigits = i + 1;
    }
    const round = s.rounds[s.r];
    switch (s.phase) {
      case 'intro':
        if (t >= s.phaseAt + INTRO_S) {
          s.phase = 'run';
          emit({ type: 'round', round: s.r, exp: round.exp });
        }
        return;
      case 'run': {
        // Sim-time rate: slow down so the burst's collisions arrive at about count/burstSeconds per
        // second (otherwise all of them land within a couple of frames), and fast-forward through
        // long quiet stretches (the last slow tap against the wall can be seconds away).
        const k = s.b.count;
        const times = round.times;
        const target = Math.max(60, times.length / s.p.burstSeconds);
        let want = 1;
        if (k < times.length) {
          const j = Math.min(times.length - 1, k + 16);
          const span = times[j] - times[k];
          const density = j > k ? (j - k) / Math.max(span, 1e-12) : 0;
          if (density > target) want = target / density;
          else if (times[k] - s.tau > 0.9 && s.tau - s.lastHitTau > 0.35) want = FAST_FORWARD;
        }
        s.rate = want < s.rate ? want : s.rate + (want - s.rate) * Math.min(1, dt * 5);
        const dtau = dt * s.rate;
        const res = advance(s.b, dtau);
        s.tau += dtau;
        if (res.n) {
          s.lastHitTau = s.tau;
          s.lastHitT = t;
          if (res.wall) s.lastWallT = t;
          s.pendN += res.n;
          s.pendWall += res.wall;
        }
        // At most 40 clack events a second: the burst stays a buzz without thousands of sounds.
        if (s.pendN && (t - s.lastClackT >= 1 / 40 - 1e-9 || res.done)) {
          emit({ type: 'clack', n: s.pendN, wall: s.pendWall, round: s.r, x: s.b.x2, frac: s.b.count / Math.max(1, round.times.length) });
          s.lastClackT = t;
          s.pendN = s.pendWall = 0;
        }
        if (res.done) {
          s.phase = 'hold';
          s.phaseAt = t;
          s.results.push(s.b.count);
          emit({ type: 'roundEnd', round: s.r, count: s.b.count, exp: round.exp });
          const digits = fmtCount(s.b.count).split('').map(Number);
          digits.forEach((d, i) => s.digitQueue.push([t + 0.35 + i * DIGIT_GAP_S, d, i]));
          s.holdS = Math.max(HOLD_MIN_S, 0.35 + digits.length * DIGIT_GAP_S + 0.8);
        }
        return;
      }
      case 'hold':
        advance(s.b, dt);
        if (t >= s.phaseAt + s.holdS) {
          if (s.r + 1 < s.rounds.length) {
            s.r++;
            const nr = s.rounds[s.r];
            s.b = makeBlocks(nr.ratio, { ...nr.start, w1: W1 });
            s.tau = 0;
            s.rate = 1;
            s.lastHitTau = 0;
            s.phase = 'intro';
            s.phaseAt = t;
          } else {
            s.phase = 'reveal';
            s.phaseAt = t;
            const digits = fmtCount(s.results[s.results.length - 1]).split('').map(Number);
            digits.forEach((d, i) => s.digitQueue.push([t + 0.6 + i * 0.22, d, i]));
            emit({ type: 'reveal', count: s.results[s.results.length - 1] });
          }
        }
        return;
      case 'reveal':
        return;
    }
  },

  isDone(s) {
    return s.phase === 'reveal' && s.t >= s.phaseAt + REVEAL_S;
  },

  hud(s) {
    const final = s.results.length === s.rounds.length;
    return { count: final ? s.results[s.results.length - 1] : s.b.count, outro: s.phase === 'reveal' && s.t >= s.phaseAt + 1.8 };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.6, y: 0.12 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.12 },
    ];
  },

  render({ ctx, theme }, s) {
    const round = s.rounds[s.r];
    const t = s.t;
    const small = paletteAt(theme.palette, 0.08);
    const big = paletteAt(theme.palette, 0.62);

    // Counter.
    const count = s.phase === 'reveal' ? s.results[s.results.length - 1] : s.b.count;
    const busy = Math.exp(-(t - s.lastHitT) * 6);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `800 34px ${FONT_FAMILY}`;
    ctx.fillText('COLLISIONS', 540, 350);
    ctx.save();
    ctx.translate(540, 445);
    ctx.scale(1 + 0.08 * busy, 1 + 0.08 * busy);
    ctx.font = `900 150px ${FONT_FAMILY}`;
    ctx.lineWidth = 10;
    ctx.strokeStyle = theme.textStroke;
    ctx.strokeText(fmtCount(count), 0, 0);
    ctx.fillStyle = rgbToCss(lighten(paletteAt(theme.palette, 0.4), 0.15 + 0.5 * busy));
    ctx.fillText(fmtCount(count), 0, 0);
    ctx.restore();

    drawResults(ctx, theme, s);
    if (s.p.diagram) drawDiagram(ctx, theme, s);
    if (s.phase === 'reveal') drawSummary(ctx, theme, s);

    // Floor and wall.
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, FLOOR_Y, 1080, 120);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(0, FLOOR_Y, 1080, 4);
    const wallTop = FLOOR_Y - 380;
    const wallFlash = Math.exp(-(t - s.lastWallT) * 10);
    ctx.fillStyle = rgbToCss(lighten([70, 76, 96], 0.25 * wallFlash));
    ctx.fillRect(WALL_X - 30, wallTop, 30, FLOOR_Y - wallTop);
    ctx.save();
    ctx.beginPath();
    ctx.rect(WALL_X - 30, wallTop, 30, FLOOR_Y - wallTop);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 3;
    for (let y = wallTop - 30; y < FLOOR_Y + 30; y += 22) {
      ctx.beginPath();
      ctx.moveTo(WALL_X - 30, y + 30);
      ctx.lineTo(WALL_X, y);
      ctx.stroke();
    }
    ctx.restore();

    // Blocks (fade in during the round intro).
    const appear = s.phase === 'intro' ? Math.min(1, (t - s.phaseAt) / (INTRO_S * 0.8)) : 1;
    const fadeOut = s.phase === 'reveal' ? Math.max(0, 1 - (t - s.phaseAt) / 0.8) : 1;
    ctx.globalAlpha = appear * fadeOut;
    const hitFlash = Math.exp(-(t - s.lastHitT) * 12);
    drawBlock(ctx, WALL_X + s.b.x1, W1, small, '1 kg', 22, hitFlash * 0.3);
    drawBlock(ctx, WALL_X + s.b.x2, round.w2, big, massLabel(round.exp), Math.min(30, round.w2 * 0.13), hitFlash * 0.12);
    ctx.globalAlpha = 1;

    // Time-warp tag.
    if (s.phase === 'run' && (s.rate < 0.5 || s.rate > 1.6)) {
      ctx.textAlign = 'right';
      ctx.font = `900 30px ${FONT_FAMILY}`;
      ctx.fillStyle = s.rate < 0.5 ? theme.accent : 'rgba(255,255,255,0.7)';
      ctx.fillText(s.rate < 0.5 ? 'SLOW-MO' : '⏩ ×3', 1040, FLOOR_Y - 420);
    }
  },

  audio(e) {
    switch (e.type) {
      case 'clack': {
        const n = e.n as number;
        const wall = e.wall as number;
        const lg = Math.min(4, Math.log10(n + 1));
        const out = [];
        const pan = Math.max(-0.6, Math.min(0.6, ((e.x as number) + WALL_X) / 540 - 1));
        // The click is kept modest (sharp clicks overshoot the true-peak limit after encoding); the
        // wooden note under it carries the hit.
        const vel = n > 2 ? 0.22 : 0.3;
        if (n - wall > 0) out.push({ kind: 'sfx' as const, name: 'clack' as const, vel, pitch: 0.45 + 0.1 * lg, pan });
        if (wall > 0) out.push({ kind: 'sfx' as const, name: 'clack' as const, vel: vel * 0.8, pitch: 0.12, pan: -0.5 });
        // A wooden note under each knock that climbs through the round: the burst becomes a rising run.
        const degree = Math.round(Math.min(1, e.frac as number) * 18);
        out.push({ kind: 'note' as const, midi: scaleNote('pentatonic', 52, degree), vel: n > 2 ? 0.4 : 0.6, voice: 'marimba' as const, dur: 0.5, pan });
        return out;
      }
      case 'round':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.18 }];
      case 'roundEnd':
        // A bell in E major (the rounds' key), one step higher each round.
        return [{ kind: 'note', midi: scaleNote('major', 76, (e.exp as number) / 2), vel: 0.26, voice: 'bell', dur: 1 }];
      case 'digit': {
        const reveal = e.reveal as boolean;
        const midi = scaleNote('major', reveal ? 60 : 64, e.digit as number);
        return [{ kind: 'note', midi, vel: reveal ? 0.5 : 0.38, voice: 'bell', dur: reveal ? 1.6 : 0.9 }];
      }
      case 'reveal':
        return [60, 64, 67, 72].map((midi, i) => ({ kind: 'note' as const, midi: midi - 12, vel: 0.22 + i * 0.02, voice: 'softsine' as const, dur: 3.2 }));
    }
    return [];
  },

  score(events, { durationS, targetS }): DramaScore {
    const counts = events.filter((e) => e.type === 'roundEnd').map((e) => e.count as number);
    const durFit = gaussFit(durationS, targetS, targetS * 0.3);
    return { total: durFit, parts: { durFit }, notes: [`counts ${counts.join(' · ')}`] };
  },
};

function drawBlock(ctx: Ctx2D, x: number, w: number, col: [number, number, number], label: string, font: number, flash: number) {
  const y = FLOOR_Y - w;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(x + w / 2, FLOOR_Y + 6, w * 0.55, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  const grad = ctx.createLinearGradient(0, y, 0, y + w);
  grad.addColorStop(0, rgbToCss(lighten(col, 0.25 + flash)));
  grad.addColorStop(1, rgbToCss(lighten(col, flash)));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(x, y, w, w, Math.min(12, w * 0.12));
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${font}px ${FONT_FAMILY}`;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillText(label, x + w / 2, y + w / 2);
}

/** Round results as a row ("3  31  314 …"), turning into "π = 3.1415…" at the end. */
function drawResults(ctx: Ctx2D, theme: { text: string; accent: string; textStroke: string }, s: State) {
  const y = 590;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  if (s.phase === 'reveal') {
    const str = fmtCount(s.results[s.results.length - 1]);
    const k = Math.min(1, (s.t - s.phaseAt) / 0.5);
    ctx.font = `900 ${Math.round(66 + 24 * k)}px ${FONT_FAMILY}`;
    const parts = ['π = ', str[0], '.', ...str.slice(1).split(''), '…'];
    const widths = parts.map((pp) => ctx.measureText(pp).width);
    let x = 540 - widths.reduce((a, b) => a + b, 0) / 2;
    parts.forEach((pp, i) => {
      // Digit index: 0 for the leading 3, then 1.. for the decimals.
      const di = i === 1 ? 0 : i >= 3 && i < parts.length - 1 ? i - 2 : -1;
      const lit = di < 0 || di < s.litDigits;
      ctx.textAlign = 'left';
      ctx.lineWidth = 8;
      ctx.strokeStyle = theme.textStroke;
      ctx.strokeText(pp, x, y + 10);
      ctx.fillStyle = lit ? (di >= 0 ? theme.accent : theme.text) : 'rgba(255,255,255,0.18)';
      ctx.fillText(pp, x, y + 10);
      x += widths[i];
    });
    return;
  }
  if (!s.results.length) return;
  ctx.font = `800 44px ${FONT_FAMILY}`;
  const items = s.results.map(fmtCount);
  const gap = 46;
  const widths = items.map((it) => ctx.measureText(it).width);
  let x = 540 - (widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1)) / 2;
  items.forEach((it, i) => {
    const latest = i === items.length - 1 && s.phase === 'hold';
    ctx.textAlign = 'left';
    ctx.fillStyle = latest ? theme.accent : 'rgba(255,255,255,0.75)';
    ctx.fillText(it, x, y);
    x += widths[i] + gap;
  });
}

/** End card: each mass and its count, one row per round. */
function drawSummary(ctx: Ctx2D, theme: { text: string; accent: string }, s: State) {
  const rows = s.rounds.length;
  const rowH = Math.min(92, 520 / rows);
  const top = 1000 - (rows * rowH) / 2;
  s.rounds.forEach((rd, i) => {
    const a = Math.max(0, Math.min(1, (s.t - s.phaseAt - 0.5 - i * 0.12) / 0.35));
    if (a <= 0) return;
    const y = top + (i + 0.5) * rowH;
    ctx.globalAlpha = a;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.font = `700 ${Math.round(rowH * 0.4)}px ${FONT_FAMILY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(massLabel(rd.exp), 610, y);
    ctx.textAlign = 'left';
    ctx.font = `900 ${Math.round(rowH * 0.55)}px ${FONT_FAMILY}`;
    ctx.fillStyle = i === rows - 1 ? theme.accent : theme.text;
    ctx.fillText(`→ ${fmtCount(s.results[i])}`, 640, y);
  });
  ctx.globalAlpha = 1;
}

const diagramLayers = new WeakMap<State, { canvas: OffscreenCanvas | HTMLCanvasElement; round: number; drawn: number }>();

/**
 * Velocity space: x = √M·V, y = √m·v. Energy conservation keeps the state on a circle; every
 * collision is a reflection, and each block-hit + wall-hit pair turns it by the same angle 2θ
 * (θ = atan √(m/M)). So the number of hops that fit before it can't turn any more is about π/θ.
 */
function drawDiagram(ctx: Ctx2D, theme: { palette: string[]; accent: string }, s: State) {
  const round = s.rounds[s.r];
  if (!round.pts) return;
  const size = DIAG.r * 2 + 24;
  let layer = diagramLayers.get(s);
  if (!layer) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
    layer = { canvas, round: -1, drawn: 0 };
    diagramLayers.set(s, layer);
  }
  const lc = layer.canvas.getContext('2d') as Ctx2D;
  const upto = s.phase === 'intro' ? 0 : Math.min(s.b.count, round.pts.length / 2 - 1);
  if (layer.round !== s.r || layer.drawn > upto) {
    lc.clearRect(0, 0, size, size);
    layer.round = s.r;
    layer.drawn = 0;
  }
  const c = size / 2;
  const total = round.times.length;
  if (upto > layer.drawn) {
    const alpha = Math.min(0.85, Math.max(0.05, 4 / Math.sqrt(total)));
    lc.strokeStyle = rgbToCss(paletteAt(theme.palette, 0.4), alpha);
    lc.lineWidth = total > 2000 ? 1 : 2;
    lc.beginPath();
    for (let k = layer.drawn; k < upto; k++) {
      lc.moveTo(c + round.pts[2 * k] * DIAG.r, c - round.pts[2 * k + 1] * DIAG.r);
      lc.lineTo(c + round.pts[2 * k + 2] * DIAG.r, c - round.pts[2 * k + 3] * DIAG.r);
    }
    lc.stroke();
    layer.drawn = upto;
  }

  const fade = s.phase === 'reveal' ? Math.max(0, 1 - (s.t - s.phaseAt) / 0.8) : 1;
  ctx.globalAlpha = fade;
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(DIAG.x - DIAG.r - 30, DIAG.y);
  ctx.lineTo(DIAG.x + DIAG.r + 30, DIAG.y);
  ctx.moveTo(DIAG.x, DIAG.y - DIAG.r - 30);
  ctx.lineTo(DIAG.x, DIAG.y + DIAG.r + 30);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  ctx.arc(DIAG.x, DIAG.y, DIAG.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.drawImage(layer.canvas as CanvasImageSource, DIAG.x - c, DIAG.y - c);
  const px = DIAG.x + round.pts[2 * upto] * DIAG.r;
  const py = DIAG.y - round.pts[2 * upto + 1] * DIAG.r;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(px, py, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 24px ${FONT_FAMILY}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'left';
  ctx.fillText('big block', DIAG.x + DIAG.r + 40, DIAG.y - 16);
  ctx.fillText('speed →', DIAG.x + DIAG.r + 40, DIAG.y + 16);
  ctx.textAlign = 'right';
  ctx.fillText('small block', DIAG.x - DIAG.r - 40, DIAG.y - DIAG.r * 0.6 - 16);
  ctx.fillText('speed ↑', DIAG.x - DIAG.r - 40, DIAG.y - DIAG.r * 0.6 + 16);
  ctx.textAlign = 'center';
  ctx.font = `700 28px ${FONT_FAMILY}`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('Every collision turns the dot by the same angle', DIAG.x, DIAG.y + DIAG.r + 62);
  ctx.globalAlpha = 1;
}
