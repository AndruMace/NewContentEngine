import { paletteAt, rgbToCss, type Ctx2D, type Theme } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { scaleNote } from '../../music';
import { gaussFit } from '../../scoring';
import type { MathParams } from '../params';
import { OUTRO_DELAY_S, REVEAL_S, caption, clamp01, drawModeTitle, ev, evName, outlined, popIn, smooth, type ModeImpl } from '../shared';

/**
 * Times tables on a circle: N points round a circle, and a line from every point k to point m·k
 * (mod N). As the multiplier m sweeps, the lines' envelope runs through a cardioid (×2), a nephroid
 * (×3), curves with m − 1 cusps, and much stranger shapes higher up. The sweep's timing uses dm, so it is the same everywhere.
 */

interface Segment {
  /** Arrive at m1 at t1 (sweeping from m0 since t0), then hold until the next segment's t0. */
  t0: number;
  t1: number;
  m0: number;
  m1: number;
}

/** A worked example in the opening: the line from point k to point 2k, drawn on its own. */
interface Demo {
  k: number;
  /** 2k, before going round the circle. */
  product: number;
  t: number;
}

interface State {
  p: MathParams;
  n: number;
  demos: Demo[];
  demoNext: number;
  /** The rest of the ×2 lines draw in, in order, over this window. */
  fillFrom: number;
  fillTo: number;
  filled: boolean;
  stops: number[];
  segs: Segment[];
  seg: number;
  m: number;
  /** Index of the stop last reached (-1 before the first). */
  reached: number;
  reachedAt: number;
  lastInt: number;
  lastTickT: number;
  revealAt: number;
  started: boolean;
  revealed: boolean;
  /** Palette offset for the chord colours. */
  hue: number;
  t: number;
}

const M = 'times-table';
/** Low enough that the numbers at the top of the circle clear the explainer line above it. */
const CENTER = { x: 540, y: 1055, r: 410 };
const HOLD_S = 0.75;
/**
 * The opening shows where the lines come from: numbered points, then a few lines drawn one at a time
 * with their sums (spread round the circle so each is long enough to see, the last one going past
 * the end and round again), then the rest filling in to make the cardioid.
 */
const DEMO_AT = [0.05, 0.15, 0.3, 0.65];
const DEMO_DRAW_S = 0.45;

/** What the multiplier draws, where it has a name. */
export function shapeName(m: number, n: number): string {
  if (m === 2) return 'Cardioid';
  if (m === 3) return 'Nephroid';
  if (m <= 12) return `${m - 1} cusps`;
  if (m === n - 1) return 'Mirror lines';
  if (n % 2 === 0 && m === n / 2 + 1) return 'Starburst';
  if (n % 2 === 0 && m === n / 2) return 'Two fans';
  return '';
}

/** The multipliers the sweep stops at: always ×2 and ×3, then a seed-chosen tour (or one up to maxMultiplier). */
function tour(p: MathParams, n: number, rng: { next(): number; int(a: number, b: number): number }): number[] {
  const max = Math.min(n - 1, p.maxMultiplier);
  const stopCount = Math.max(4, Math.min(9, Math.round(p.durationS / 4.2)));
  if (max >= 2 && max <= 12) return range(2, Math.max(3, max));
  if (max > 12) {
    const low = range(2, 5);
    const count = Math.max(1, stopCount - low.length);
    const high = Array.from({ length: count }, (_, i) => Math.round(5 + ((max - 5) * (i + 1)) / count));
    return dedupe([...low, ...high]);
  }
  if (rng.next() < 0.5) return range(2, 2 + stopCount - 1);
  // A few small ones, then jumps into the big multipliers (chaos between them, order at each stop).
  const low = range(2, 4);
  const pool = dedupe([21, 26, 34, 51, 67, n % 2 === 0 ? n / 2 + 1 : 0, n - 1].filter((m) => m > 4 && m < n));
  const picks = pool.filter(() => rng.next() < 0.6).slice(0, Math.max(2, stopCount - low.length));
  if (picks.length < 2) picks.splice(0, picks.length, ...pool.slice(-2));
  return [...low, ...picks.sort((a, b) => a - b)];
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const dedupe = (xs: number[]) => [...new Set(xs)];

export const timesTableMode: ModeImpl<State> = {
  copy: () => ({ hook: 'Watch what multiplying does to a circle', cta: 'All of that from one times table 🤯 Which shape was your favorite?' }),
  searchBudget: 12,
  glowScale: 0.5,

  init({ params: p, rng }) {
    const n = p.points;
    const stops = tour(p, n, rng);
    const revealAt = p.durationS - REVEAL_S;
    const g = Math.max(0.75, Math.min(1.15, p.durationS / 32));
    const demos: Demo[] = DEMO_AT.map((f, i) => {
      const k = Math.round(f * n);
      return { k, product: stops[0] * k, t: 1.4 * g + i * 1.05 * g };
    });
    const fillFrom = demos[demos.length - 1].t + 1.3 * g;
    const fillTo = fillFrom + 1.5 * g;
    // Sweeps are brisk (a long jump only a little longer than a short one: the tangle in between all
    // looks alike) and the time left goes to holding on the clean shapes. The cardioid gets a longer look.
    const first = fillTo + HOLD_S + 0.5;
    const avail = Math.max(1, revealAt - first);
    let sweeps = stops.slice(1).map((m, i) => Math.max(1, Math.min(2.6, 0.9 + 0.45 * (dm.log(1 + m - stops[i]) / dm.log(2)))));
    const most = avail - HOLD_S * (stops.length - 1);
    const sum = sweeps.reduce((a, b) => a + b, 0);
    if (sum > most) sweeps = sweeps.map((d) => (d * Math.max(0.5, most)) / sum);
    const hold = Math.max(HOLD_S, (avail - sweeps.reduce((a, b) => a + b, 0)) / Math.max(1, stops.length - 1));
    const segs: Segment[] = [{ t0: 0, t1: 0, m0: stops[0], m1: stops[0] }];
    let at = first;
    sweeps.forEach((d, i) => {
      segs.push({ t0: at, t1: at + d, m0: stops[i], m1: stops[i + 1] });
      at += d + hold;
    });
    return { p, n, demos, demoNext: 0, fillFrom, fillTo, filled: false, stops, segs, seg: 0, m: stops[0], reached: -1, reachedAt: -9, lastInt: stops[0], lastTickT: -9, revealAt, started: false, revealed: false, hue: rng.next(), t: 0 };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    if (!s.started) {
      s.started = true;
      emit({ type: ev(M, 'start'), points: s.n, stops: s.stops.length });
    }
    while (s.demoNext < s.demos.length && t >= s.demos[s.demoNext].t) {
      const d = s.demos[s.demoNext];
      emit({ type: ev(M, 'demo'), i: s.demoNext++, k: d.k, product: d.product, wraps: d.product >= s.n });
    }
    if (!s.filled && t >= s.fillFrom) {
      s.filled = true;
      emit({ type: ev(M, 'fill') });
    }
    while (s.seg + 1 < s.segs.length && s.segs[s.seg + 1].t0 <= t) s.seg++;
    const g = s.segs[s.seg];
    const u = g.t1 > g.t0 ? clamp01((t - g.t0) / (g.t1 - g.t0)) : 1;
    s.m = g.m0 + (g.m1 - g.m0) * smooth(u);
    if (u >= 1 && s.reached < s.seg && t >= s.fillTo) {
      s.reached = s.seg;
      s.reachedAt = t;
      s.m = g.m1;
      s.lastInt = g.m1;
      emit({ type: ev(M, 'stop'), i: s.seg, m: g.m1, name: shapeName(g.m1, s.n) });
    } else if (u < 1) {
      const whole = Math.floor(s.m);
      // A soft tick per whole multiplier crossed (at most 30 a second through the long jumps).
      if (whole !== s.lastInt && whole > g.m0 && t - s.lastTickT >= 1 / 30 - 1e-9) {
        s.lastTickT = t;
        emit({ type: ev(M, 'tick'), m: whole });
      }
      s.lastInt = whole;
    }
    if (!s.revealed && t >= s.revealAt) {
      s.revealed = true;
      emit({ type: ev(M, 'reveal'), m: s.stops[s.stops.length - 1] });
    }
  },

  isDone: (s) => s.t >= s.p.durationS,

  hud: (s) => {
    const last = s.stops[s.stops.length - 1];
    const name = shapeName(last, s.n);
    return { result: name ? `×${last} (${name.toLowerCase()})` : `×${last}`, multiplier: Math.round(s.m * 100) / 100, outro: s.revealed && s.t >= s.revealAt + OUTRO_DELAY_S };
  },

  render({ ctx, theme }, s) {
    const t = s.t;
    drawModeTitle(ctx, 'Times tables on a circle');
    drawLines(ctx, theme, s);

    // The multiplier: two decimals while it sweeps, whole (and named) when it stops.
    const holding = s.reached === s.seg;
    const whole = holding || Number.isInteger(s.m);
    const label = whole ? `× ${Math.round(s.m)}` : `× ${s.m.toFixed(2)}`;
    const pop = holding ? popIn((t - s.reachedAt) / 0.35) : 1;
    outlined(ctx, theme, label, 540, 450, { size: s.revealed ? 130 : 112, fill: holding ? theme.accent : theme.text, scale: pop });
    const name = holding ? shapeName(Math.round(s.m), s.n) : '';
    if (name) outlined(ctx, theme, name, 540, 548, { size: 46, alpha: clamp01((t - s.reachedAt) / 0.25), scale: pop });
    else drawStory(ctx, theme, s);
    caption(ctx, `point k  →  point ${whole ? Math.round(s.m) : s.m.toFixed(1)} × k   (${s.n} points)`, 540, 1568, 30, `rgba(255,255,255,${s.t < s.fillFrom ? 0.3 : 0.55})`);
  },

  audio(e) {
    switch (evName(e)) {
      case 'start':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.16 }];
      case 'demo':
        return [
          { kind: 'sfx', name: 'tick', vel: 0.24, pitch: 1 },
          { kind: 'note', midi: scaleNote('pentatonic', 60, (e.i as number) * 2), vel: 0.42, voice: 'pluck', dur: 0.6 },
          ...(e.wraps ? [{ kind: 'note' as const, midi: scaleNote('pentatonic', 60, (e.i as number) * 2 + 3), vel: 0.3, voice: 'glass' as const, dur: 0.8 }] : []),
        ];
      case 'fill':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.2 }];
      case 'tick':
        return [{ kind: 'note', midi: scaleNote('pentatonic', 72, (e.m as number) % 10), vel: 0.14, voice: 'glass', dur: 0.3 }];
      case 'stop': {
        const d = (e.i as number) % 7;
        return [0, 2, 4].map((k, j) => ({ kind: 'note' as const, midi: scaleNote('major', 55, d + k), vel: 0.24 - j * 0.03, voice: j ? ('glass' as const) : ('bell' as const), dur: 1.8 }));
      }
      case 'reveal':
        return [48, 55, 60, 67].map((midi, i) => ({ kind: 'note' as const, midi, vel: 0.22 + i * 0.02, voice: 'softsine' as const, dur: 3.2 }));
    }
    return [];
  },

  score(events, { durationS, targetS }) {
    const durFit = gaussFit(durationS, targetS, targetS * 0.3);
    const stops = events.filter((e) => e.type === ev(M, 'stop'));
    const variety = clamp01(stops.length / 6);
    return { total: 0.7 * durFit + 0.3 * variety, parts: { durFit, variety }, notes: [`stops ${stops.map((e) => e.m).join(' · ')}`] };
  },
};

const BUCKETS = 14;

/** All N chords, batched into colour buckets by length (one path per bucket). */
function drawLines(ctx: Ctx2D, theme: Theme, s: State) {
  const { x: cx, y: cy, r } = CENTER;
  const n = s.n;
  const m = s.m;
  const shown = Math.round(n * smooth((s.t - s.fillFrom) / (s.fillTo - s.fillFrom)));
  const ang = (k: number) => Math.PI + (2 * Math.PI * k) / n;

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  const paths: Path2D[] = Array.from({ length: BUCKETS }, () => new Path2D());
  for (let k = 0; k < shown; k++) {
    const target = (m * k) % n;
    let d = Math.abs(target - k) / n;
    d = Math.min(d, 1 - d) * 2;
    const b = Math.min(BUCKETS - 1, Math.floor(d * BUCKETS));
    const a = ang(k);
    const c = ang(target);
    paths[b].moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    paths[b].lineTo(cx + r * Math.cos(c), cy + r * Math.sin(c));
  }
  ctx.lineWidth = n > 250 ? 1.2 : 1.7;
  paths.forEach((path, b) => {
    ctx.strokeStyle = rgbToCss(paletteAt(theme.palette, (s.hue + b / BUCKETS) % 1), 0.62);
    ctx.stroke(path);
  });

  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  const dot = n > 250 ? 2.2 : 3;
  for (let k = 0; k < n; k++) {
    const a = ang(k);
    ctx.beginPath();
    ctx.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), dot, 0, Math.PI * 2);
    ctx.fill();
  }
  drawDemos(ctx, theme, s, ang);
}

/** The opening's worked examples: each line grows from k to 2k, ends labelled, then they fade into the fill. */
function drawDemos(ctx: Ctx2D, theme: Theme, s: State, ang: (k: number) => number) {
  const t = s.t;
  const fade = 1 - smooth((t - s.fillTo) / 0.6);
  if (fade <= 0) return;
  const { x: cx, y: cy, r } = CENTER;
  const at = (k: number, rr = r) => [cx + rr * Math.cos(ang(k)), cy + rr * Math.sin(ang(k))] as const;
  ctx.save();
  ctx.globalAlpha = fade;
  // A few numbers round the edge, so the counting is clear from the first frame.
  const marks = [0, Math.round(s.n / 4), Math.round(s.n / 2), Math.round((3 * s.n) / 4)];
  for (const k of marks) {
    const [lx, ly] = at(k, r + 40);
    caption(ctx, String(k), lx, ly, 28, 'rgba(255,255,255,0.45)', 'center', 900);
  }
  s.demos.forEach((d, i) => {
    // Shown once the sim has fired it (frame time can run a substep ahead).
    if (i >= s.demoNext) return;
    const target = d.product % s.n;
    const u = smooth((t - d.t) / DEMO_DRAW_S);
    const [x0, y0] = at(d.k);
    const [x1, y1] = at(target);
    const x = x0 + (x1 - x0) * u;
    const y = y0 + (y1 - y0) * u;
    const latest = i === s.demoNext - 1 && t < s.fillFrom;
    const col = latest ? theme.accent : 'rgba(255,255,255,0.85)';
    ctx.strokeStyle = col;
    ctx.lineWidth = latest ? 6 : 4;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = col;
    for (const [px, py, rad] of [[x0, y0, 11], [x, y, u < 1 ? 9 : 11]] as const) {
      ctx.beginPath();
      ctx.arc(px, py, rad, 0, Math.PI * 2);
      ctx.fill();
    }
    const [lx, ly] = at(d.k, r + 42);
    outlined(ctx, theme, String(d.k), lx, ly, { size: 34, fill: col });
    if (u >= 1) {
      const [tx, ty] = at(target, r + 42);
      outlined(ctx, theme, String(target), tx, ty, { size: 34, fill: col, scale: popIn((t - d.t - DEMO_DRAW_S) / 0.25) });
    }
  });
  ctx.restore();
}

/** The line under the multiplier while nothing has a name: what the opening is showing right now. */
function drawStory(ctx: Ctx2D, theme: Theme, s: State) {
  const t = s.t;
  let text = '';
  let since = 0;
  let fill = theme.text;
  if (s.demoNext === 0) {
    text = `${s.n} points round a circle, numbered 0 to ${s.n - 1}`;
    since = t - 0.2;
  } else if (t < s.fillFrom) {
    const d = s.demos[s.demoNext - 1];
    const m = s.stops[0];
    text = d.product >= s.n ? `${d.k} × ${m} = ${d.product}, past ${s.n - 1}: round again to ${d.product % s.n}` : `Join ${d.k} to ${d.k} × ${m} = ${d.product}`;
    since = t - d.t;
    fill = theme.accent;
  } else if (s.reached < 0) {
    text = '…and the same for every point';
    since = t - s.fillFrom;
  } else if (s.seg === 1 && s.reached === 0) {
    text = 'Now slowly change the multiplier…';
    since = t - s.segs[1].t0;
  }
  if (text) outlined(ctx, theme, text, 540, 548, { size: 42, fill, scale: popIn(since / 0.3), alpha: clamp01(since / 0.2) });
}
