import { FONT_FAMILY, lighten, paletteAt, rgbToCss, type Ctx2D, type RGB, type Rng, type Theme } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { drawCommentPrompt } from '../../guess';
import { scaleNote } from '../../music';
import { gaussFit } from '../../scoring';
import { CHAOS_RULES, type ChaosRule, type MathParams } from '../params';
import { OUTRO_DELAY_S, REVEAL_S, caption, clamp01, drawModeTitle, ev, evName, flash, fmtInt, makeLayer, outlined, popIn, smooth, type ModeImpl } from '../shared';

/**
 * The chaos game: roll a die, jump part of the way toward that corner, mark the spot, repeat. The
 * marks look like noise for a while, then a fractal appears. Corners come from dm trig and every
 * jump is + − ×, so the dots land identically everywhere; drawing them is visual-only.
 */

interface RuleSpec {
  name: string;
  corners: number;
  /** Fraction of the way to jump. */
  jump: number;
  jumpText: string;
  /** Never roll the corner just used. */
  noRepeat?: boolean;
  /** Edge midpoints are targets too. */
  midpoints?: boolean;
}

export const CHAOS: Record<ChaosRule, RuleSpec> = {
  triangle: { name: 'Sierpinski triangle', corners: 3, jump: 1 / 2, jumpText: 'jump halfway to that corner' },
  square: { name: 'fractal square', corners: 4, jump: 1 / 2, jumpText: 'jump halfway (no corner twice in a row)', noRepeat: true },
  pentagon: { name: 'pentaflake', corners: 5, jump: (Math.sqrt(5) - 1) / 2, jumpText: 'jump 62% of the way there' },
  hexagon: { name: 'hexaflake', corners: 6, jump: 2 / 3, jumpText: 'jump two thirds of the way there' },
  carpet: { name: 'Sierpinski carpet', corners: 4, jump: 2 / 3, jumpText: 'jump two thirds of the way there', midpoints: true },
};

interface State {
  p: MathParams;
  rng: Rng;
  rule: ChaosRule;
  spec: RuleSpec;
  /** Targets: corners (then edge midpoints for the carpet). */
  tx: number[];
  ty: number[];
  x: number;
  y: number;
  prev: number;
  /** Dots placed so far. */
  count: number;
  /** Slow, narrated moves: [from x, from y, to x, to y, target, time]. */
  slow: { fx: number; fy: number; x: number; y: number; j: number; t: number }[];
  slowTimes: number[];
  fastFrom: number;
  fastTo: number;
  /** Every dot (visual runs only), for the accumulation layer. */
  px: Float32Array | null;
  py: Float32Array | null;
  pj: Uint8Array | null;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  nextMilestone: number;
  flurryAt: number;
  flurryCount: number;
  revealAt: number;
  started: boolean;
  revealed: boolean;
  visual: boolean;
  t: number;
}

const M = 'chaos-game';
const SLOW_MOVES = 12;
const CENTER = { x: 540, y: 1010, r: 450 };
const LAYER = { x: 40, y: 520, w: 1000, h: 1000 };
const MILESTONES = [100, 1000, 10000, 100000];

function targets(spec: RuleSpec): { tx: number[]; ty: number[] } {
  const tx: number[] = [];
  const ty: number[] = [];
  const n = spec.corners;
  // Squares sit flat; odd polygons point up and drop a little so they look centred.
  const rot = n === 4 ? -3 * (Math.PI / 4) : -Math.PI / 2;
  const dy = n === 3 ? 70 : n === 5 ? 30 : 0;
  for (let i = 0; i < n; i++) {
    const a = rot + (2 * Math.PI * i) / n;
    tx.push(CENTER.x + CENTER.r * dm.cos(a));
    ty.push(CENTER.y + dy + CENTER.r * dm.sin(a));
  }
  if (spec.midpoints) for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    tx.push((tx[i] + tx[k]) / 2);
    ty.push((ty[i] + ty[k]) / 2);
  }
  return { tx, ty };
}

/** Roll a target and jump toward it. */
function move(s: State, rng: Rng): number {
  const n = s.tx.length;
  let j = rng.int(0, n - 1);
  if (s.spec.noRepeat) while (j === s.prev) j = rng.int(0, n - 1);
  s.prev = j;
  s.x += (s.tx[j] - s.x) * s.spec.jump;
  s.y += (s.ty[j] - s.y) * s.spec.jump;
  if (s.count >= 8) {
    s.minX = Math.min(s.minX, s.x);
    s.maxX = Math.max(s.maxX, s.x);
    s.minY = Math.min(s.minY, s.y);
    s.maxY = Math.max(s.maxY, s.y);
  }
  if (s.px) {
    s.px[s.count] = s.x;
    s.py![s.count] = s.y;
    s.pj![s.count] = j;
  }
  s.count++;
  return j;
}

export const chaosGameMode: ModeImpl<State> = {
  copy: () => ({ hook: 'What will random dots draw?', cta: 'Pure randomness drew a {result} 🤯 Did you guess it?' }),
  searchBudget: 12,
  glowScale: 0.35,

  init({ params: p, rng, visual }) {
    const rule: ChaosRule = p.rule === 'random' ? CHAOS_RULES[rng.int(0, CHAOS_RULES.length - 1)] : p.rule;
    const spec = CHAOS[rule];
    const { tx, ty } = targets(spec);
    const revealAt = p.durationS - REVEAL_S;
    const gap = 0.5 * Math.max(0.7, Math.min(1.2, p.durationS / 32));
    const slowTimes = Array.from({ length: SLOW_MOVES }, (_, i) => 1.1 + i * gap * (1 - 0.35 * (i / SLOW_MOVES)));
    const fastFrom = slowTimes[SLOW_MOVES - 1] + gap;
    const s: State = {
      p, rng, rule, spec, tx, ty,
      x: CENTER.x + rng.range(-120, 120),
      y: CENTER.y + rng.range(-120, 120),
      prev: -1, count: 0, slow: [], slowTimes, fastFrom, fastTo: revealAt - 0.4,
      px: visual ? new Float32Array(p.dots) : null,
      py: visual ? new Float32Array(p.dots) : null,
      pj: visual ? new Uint8Array(p.dots) : null,
      minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity,
      nextMilestone: 0, flurryAt: -9, flurryCount: 0, revealAt, started: false, revealed: false, visual, t: 0,
    };
    return s;
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    if (!s.started) {
      s.started = true;
      emit({ type: ev(M, 'start'), rule: s.rule });
    }
    while (s.slow.length < SLOW_MOVES && t >= s.slowTimes[s.slow.length]) {
      const fx = s.x;
      const fy = s.y;
      const j = move(s, s.rng);
      s.slow.push({ fx, fy, x: s.x, y: s.y, j, t });
      emit({ type: ev(M, 'roll'), i: s.slow.length - 1, j });
    }
    if (t >= s.fastFrom && s.count < s.p.dots) {
      // Exponential build-up: a handful of dots a second at first, tens of thousands by the end.
      const u = clamp01((t - s.fastFrom) / (s.fastTo - s.fastFrom));
      const k = 6;
      const want = u >= 1 ? s.p.dots : Math.min(s.p.dots, SLOW_MOVES + Math.floor(((s.p.dots - SLOW_MOVES) * (dm.exp(k * u) - 1)) / (dm.exp(k) - 1)));
      const before = s.count;
      while (s.count < want) move(s, s.rng);
      s.flurryCount += s.count - before;
      while (s.nextMilestone < MILESTONES.length && s.count >= MILESTONES[s.nextMilestone]) emit({ type: ev(M, 'milestone'), dots: MILESTONES[s.nextMilestone++] });
      if (s.flurryCount > 0 && t - s.flurryAt >= 1 / 12 - 1e-9) {
        emit({ type: ev(M, 'flurry'), n: s.flurryCount, frac: s.count / s.p.dots });
        s.flurryAt = t;
        s.flurryCount = 0;
      }
    }
    if (!s.revealed && t >= s.revealAt) {
      s.revealed = true;
      emit({ type: ev(M, 'reveal'), rule: s.rule, dots: s.count });
    }
  },

  isDone: (s) => s.t >= s.p.durationS,

  hud: (s) => ({ result: s.spec.name, dots: s.count, outro: s.revealed && s.t >= s.revealAt + OUTRO_DELAY_S }),

  render({ ctx, theme }, s) {
    const t = s.t;
    drawModeTitle(ctx, 'The chaos game');
    const colors = s.tx.map((_, j) => paletteAt(theme.palette, (j / s.tx.length + 0.05) % 1));
    drawShape(ctx, s, colors);
    drawLayer(ctx, s, colors);
    drawSlow(ctx, theme, s, colors);

    if (s.revealed) {
      const u = t - s.revealAt;
      outlined(ctx, theme, cap(s.spec.name), 540, 450, { size: s.spec.name.length > 16 ? 76 : 92, fill: theme.accent, scale: popIn(u / 0.4) });
      caption(ctx, `from ${fmtInt(s.count)} random dots`, 540, 548, 36, `rgba(255,255,255,${0.75 * clamp01((u - 0.3) / 0.3)})`);
    } else {
      const lastSlow = s.slow[s.slow.length - 1];
      const hit = s.count > SLOW_MOVES ? 0 : flash(t - (lastSlow?.t ?? -9), 6);
      outlined(ctx, theme, `${fmtInt(s.count)} DOTS`, 540, 450, { size: 96, scale: 1 + 0.06 * hit });
      caption(ctx, `Roll a corner, ${s.spec.jumpText}`, 540, 548, s.spec.jumpText.length > 34 ? 28 : 32, 'rgba(255,255,255,0.65)');
    }
    const promptFrom = s.slowTimes[SLOW_MOVES - 4];
    const promptTo = promptFrom + 3.2;
    if (t >= promptFrom && t < promptTo) drawCommentPrompt(ctx, theme, t - promptFrom, promptTo - t, { x: 540, y: 1585 }, 'What shape will appear?');
  },

  audio(e) {
    switch (evName(e)) {
      case 'start':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.14 }];
      case 'roll':
        return [
          { kind: 'sfx', name: 'tick', vel: 0.22, pitch: 0.8 },
          { kind: 'note', midi: scaleNote('pentatonic', 60, e.j as number), vel: 0.4, voice: 'kalimba', dur: 0.5 },
        ];
      case 'milestone': {
        const k = MILESTONES.indexOf(e.dots as number);
        return [{ kind: 'note', midi: scaleNote('major', 67, 2 * k), vel: 0.26, voice: 'bell', dur: 1.2 }];
      }
      case 'flurry': {
        const f = e.frac as number;
        return [{ kind: 'note', midi: scaleNote('pentatonic', 62, Math.round(f * 14)), vel: 0.12 + 0.08 * Math.min(1, (e.n as number) / 2000), voice: 'glass', dur: 0.35, pan: 0 }];
      }
      case 'reveal':
        return [{ kind: 'sfx', name: 'chime', vel: 0.32 }, ...[48, 55, 60, 64, 67].map((midi, i) => ({ kind: 'note' as const, midi, vel: 0.2 + i * 0.02, voice: 'softsine' as const, dur: 3.4 }))];
    }
    return [];
  },

  score(events, { durationS, targetS }) {
    const durFit = gaussFit(durationS, targetS, targetS * 0.3);
    const rule = events.find((e) => e.type === ev(M, 'start'))?.rule;
    return { total: durFit, parts: { durFit }, notes: [`${rule}`] };
  },
};

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function drawShape(ctx: Ctx2D, s: State, colors: RGB[]) {
  const n = s.spec.corners;
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    if (i === 0) ctx.moveTo(s.tx[k], s.ty[k]);
    else ctx.lineTo(s.tx[k], s.ty[k]);
  }
  ctx.stroke();
  // Targets, numbered like die faces (faded once the dots take over).
  const fade = 1 - 0.6 * smooth((s.t - s.fastFrom) / 3);
  s.tx.forEach((x, j) => {
    const lit = s.slow.length && s.slow[s.slow.length - 1].j === j && s.count <= SLOW_MOVES ? flash(s.t - s.slow[s.slow.length - 1].t, 4) : 0;
    ctx.globalAlpha = fade;
    ctx.fillStyle = rgbToCss(lighten(colors[j], 0.1 + 0.5 * lit));
    ctx.beginPath();
    ctx.arc(x, s.ty[j], 26 + 8 * lit, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 28px ${FONT_FAMILY}`;
    ctx.fillText(String(j + 1), x, s.ty[j] + 1);
  });
  ctx.globalAlpha = 1;
}

const layers = new WeakMap<State, { canvas: OffscreenCanvas | HTMLCanvasElement; drawn: number }>();

/** Every dot so far, accumulated on an offscreen layer (only the new ones are drawn each frame). */
function drawLayer(ctx: Ctx2D, s: State, colors: RGB[]) {
  if (!s.px || !s.py || !s.pj) return;
  let layer = layers.get(s);
  if (!layer) {
    layer = { canvas: makeLayer(LAYER.w, LAYER.h), drawn: 0 };
    layers.set(s, layer);
  }
  const lc = layer.canvas.getContext('2d') as Ctx2D;
  if (layer.drawn > s.count) {
    lc.clearRect(0, 0, LAYER.w, LAYER.h);
    layer.drawn = 0;
  }
  if (s.count > layer.drawn) {
    // Bigger, brighter dots while there are few; fine dust once there are many.
    const size = s.count < 3000 ? 4 : s.count < 30000 ? 2.6 : 1.8;
    const alpha = s.count < 3000 ? 0.9 : s.count < 30000 ? 0.7 : 0.55;
    const from = Math.max(layer.drawn, SLOW_MOVES);
    for (let j = 0; j < colors.length; j++) {
      lc.fillStyle = rgbToCss(lighten(colors[j], 0.15), alpha);
      for (let i = from; i < s.count; i++) {
        if (s.pj[i] !== j) continue;
        lc.fillRect(s.px[i] - LAYER.x - size / 2, s.py[i] - LAYER.y - size / 2, size, size);
      }
    }
    layer.drawn = s.count;
  }
  ctx.drawImage(layer.canvas as CanvasImageSource, LAYER.x, LAYER.y);
}

/** The narrated first moves: the die, the line to the rolled corner, the jump and the marks left. */
function drawSlow(ctx: Ctx2D, theme: Theme, s: State, colors: RGB[]) {
  const t = s.t;
  const fade = 1 - smooth((t - s.fastFrom) / 2.5);
  if (fade <= 0) return;
  ctx.globalAlpha = fade;
  s.slow.forEach((m, i) => {
    const last = i === s.slow.length - 1;
    const u = last ? smooth((t - m.t) / 0.28) : 1;
    const x = m.fx + (m.x - m.fx) * u;
    const y = m.fy + (m.y - m.fy) * u;
    if (last && u < 1) {
      ctx.strokeStyle = rgbToCss(colors[m.j], 0.6);
      ctx.setLineDash([10, 10]);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(m.fx, m.fy);
      ctx.lineTo(s.tx[m.j], s.ty[m.j]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = rgbToCss(lighten(colors[m.j], 0.3));
    ctx.beginPath();
    ctx.arc(x, y, last ? 11 : 7, 0, Math.PI * 2);
    ctx.fill();
  });
  // The die, showing the last roll.
  const last = s.slow[s.slow.length - 1];
  if (last && s.count <= SLOW_MOVES + 50) {
    const k = popIn((t - last.t) / 0.25);
    drawDie(ctx, theme, 940, 660, 46 * k, last.j + 1, colors[last.j]);
  }
  ctx.globalAlpha = 1;
}

const PIPS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

function drawDie(ctx: Ctx2D, _theme: Theme, x: number, y: number, half: number, face: number, col: RGB) {
  if (half <= 1) return;
  ctx.fillStyle = '#f4f4f8';
  ctx.strokeStyle = rgbToCss(col);
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(x - half, y - half, half * 2, half * 2, half * 0.28);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#15151c';
  const pips = PIPS[face];
  if (!pips) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(half * 1.2)}px ${FONT_FAMILY}`;
    ctx.fillText(String(face), x, y + 2);
    return;
  }
  for (const [px, py] of pips) {
    ctx.beginPath();
    ctx.arc(x + px * half * 0.5, y + py * half * 0.5, half * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }
}
