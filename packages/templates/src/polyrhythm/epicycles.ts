/**
 * Fourier style: a chain of rotating circles (epicycles) whose pen draws a figure. Every circle turns
 * a whole number of times per loop, so each is one voice of the polyrhythm (it rings each time it
 * comes back to its starting angle) and the pen closes the drawing exactly at the end.
 *
 * Each term of the figure's Fourier series, frequency k, turns L·k + 1 times per loop: the pen traces
 * the figure L times while the whole figure turns once, so the trail builds a rosette of the figure
 * and every circle lines up only at the end.
 */
import { lighten, mixRgb, rgbToCss, type Ctx2D, type RGB } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { dft } from '../fourier-drawing/fourier';
import { traceLayer } from './trace';

export const FIGURES = ['heart', 'star', 'flower', 'infinity', 'butterfly'] as const;
export type Figure = (typeof FIGURES)[number];

export interface Arm {
  /** Turns per loop (signed: negative turns the other way). */
  freq: number;
  re: number;
  im: number;
  amp: number;
}

export interface Epicycles {
  figure: Figure;
  /** Largest circle first (the order they chain in). */
  arms: Arm[];
  /** Times the pen traces the figure per loop. */
  traces: number;
  /** Pixels per unit, so the drawing fills the circle the rosette sweeps. */
  scale: number;
}

const SAMPLES = 256;
/** Circles smaller than this (as a fraction of the drawing's radius, about 3px) are dropped. */
const MIN_AMP = 0.007;
const CX = 540;
const CY = 1000;
const R_FIG = 440;
/** The rosette fades out over the last moments so the final frame matches the first. */
const FADE_S = 1.4;

/** The figure's outline as flat x,y pairs (×1000, y down, centred, furthest point at 1000). */
function outline(figure: Figure): number[] {
  const pts: number[] = [];
  for (let j = 0; j < SAMPLES; j++) {
    const u = (2 * Math.PI * j) / SAMPLES;
    let x: number;
    let y: number; // y up
    switch (figure) {
      case 'heart':
        x = 16 * dm.sin(u) ** 3;
        y = 13 * dm.cos(u) - 5 * dm.cos(2 * u) - 2 * dm.cos(3 * u) - dm.cos(4 * u);
        break;
      case 'star': {
        // Five-pointed star, walked at constant speed along its ten edges from the top point.
        const e = (j * 10) / SAMPLES;
        const k = Math.floor(e);
        const f = e - k;
        const corner = (c: number) => {
          const a = Math.PI / 2 - (Math.PI * c) / 5;
          const r = c % 2 ? 0.42 : 1;
          return [r * dm.cos(a), r * dm.sin(a)];
        };
        const [ax, ay] = corner(k);
        const [bx, by] = corner(k + 1);
        x = ax + (bx - ax) * f;
        y = ay + (by - ay) * f;
        break;
      }
      case 'flower': {
        // Five round petals.
        const r = 0.55 + 0.45 * Math.abs(dm.cos(2.5 * u));
        x = r * dm.sin(u);
        y = r * dm.cos(u);
        break;
      }
      case 'infinity':
        // Lemniscate of Bernoulli.
        x = dm.cos(u) / (1 + dm.sin(u) ** 2);
        y = (dm.sin(u) * dm.cos(u)) / (1 + dm.sin(u) ** 2);
        break;
      case 'butterfly': {
        const r = dm.exp(dm.cos(u)) - 2 * dm.cos(4 * u);
        x = r * dm.sin(u);
        y = r * dm.cos(u);
        break;
      }
    }
    pts.push(x, -y);
  }
  let mx = 0;
  let my = 0;
  for (let j = 0; j < SAMPLES; j++) {
    mx += pts[2 * j] / SAMPLES;
    my += pts[2 * j + 1] / SAMPLES;
  }
  let far = 0;
  for (let j = 0; j < SAMPLES; j++) far = Math.max(far, dm.hypot(pts[2 * j] - mx, pts[2 * j + 1] - my));
  return pts.map((v, j) => ((v - (j % 2 ? my : mx)) / far) * 1000);
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));

/**
 * The circles for a figure: its biggest Fourier terms (at most `maxArms`, none too small to see),
 * spun up so the loop plays about `notesPerS` notes a second (one per circle turn).
 */
export function buildEpicycles(figure: Figure, maxArms: number, loopSeconds: number, notesPerS: number): Epicycles {
  const { terms } = dft(outline(figure));
  const kept = terms.filter((t) => t.amp >= MIN_AMP).slice(0, maxArms);
  let traces = 2;
  let bestErr = Infinity;
  for (let L = 2; L <= 24; L++) {
    const f = kept.map((t) => L * t.freq + 1);
    // No common factor, so the circles all line up only at the very end.
    if (f.reduce(gcd, 0) !== 1) continue;
    const rate = f.reduce((a, x) => a + Math.abs(x), 0) / loopSeconds;
    const err = Math.abs(Math.log(rate / notesPerS));
    if (err < bestErr) [bestErr, traces] = [err, L];
  }
  const arms = kept.map((t) => ({ freq: traces * t.freq + 1, re: t.re, im: t.im, amp: t.amp }));
  // The figure's furthest point from the centre (turning it doesn't change that).
  let far = 0;
  for (let j = 0; j < 512; j++) {
    let x = 0;
    let y = 0;
    for (const a of kept) {
      const th = (2 * Math.PI * a.freq * j) / 512;
      x += a.re * dm.cos(th) - a.im * dm.sin(th);
      y += a.re * dm.sin(th) + a.im * dm.cos(th);
    }
    far = Math.max(far, dm.hypot(x, y));
  }
  return { figure, arms, traces, scale: R_FIG / Math.max(1e-6, far) };
}

/** Where arm `i`'s circle is centred (the tip of the arms before it) and where its own tip is. */
function chain(e: Epicycles, u: number, out: Float64Array) {
  let x = CX;
  let y = CY;
  out[0] = x;
  out[1] = y;
  e.arms.forEach((a, i) => {
    const th = 2 * Math.PI * a.freq * u;
    const c = dm.cos(th);
    const s = dm.sin(th);
    x += (a.re * c - a.im * s) * e.scale;
    y += (a.re * s + a.im * c) * e.scale;
    out[2 * i + 2] = x;
    out[2 * i + 3] = y;
  });
}

function pen(e: Epicycles, u: number): [number, number] {
  let x = CX;
  let y = CY;
  for (const a of e.arms) {
    const th = 2 * Math.PI * a.freq * u;
    const c = dm.cos(th);
    const s = dm.sin(th);
    x += (a.re * c - a.im * s) * e.scale;
    y += (a.re * s + a.im * c) * e.scale;
  }
  return [x, y];
}

export interface EpicycleView {
  epi: Epicycles;
  p: { loopSeconds: number };
  flash: number[];
}

/** `color(i)` colours circle i; `paint(u)` colours the trail at loop fraction u. */
export function drawEpicycles(ctx: Ctx2D, s: EpicycleView, t: number, frame: number, color: (i: number) => RGB, paint: (u: number) => RGB) {
  const e = s.epi;
  const T = s.p.loopSeconds;
  const u = t / T;
  // How finely to sample the pen: a few px per step at the pen's fastest.
  const perLoop = 900 * e.traces;

  const layer = traceLayer(s, frame, t, (lc, t0, t1) => {
    const steps = Math.max(1, Math.ceil(((t1 - t0) / T) * perLoop));
    lc.lineWidth = 1.6;
    lc.lineCap = 'round';
    let [px, py] = pen(e, t0 / T);
    for (let k = 1; k <= steps; k++) {
      const uu = (t0 + ((t1 - t0) * k) / steps) / T;
      const [x, y] = pen(e, uu);
      lc.strokeStyle = rgbToCss(paint(uu % 1), 0.3);
      lc.beginPath();
      lc.moveTo(px, py);
      lc.lineTo(x, y);
      lc.stroke();
      [px, py] = [x, y];
    }
  });
  ctx.globalAlpha = Math.min(1, Math.max(0, (T - t) / FADE_S));
  ctx.drawImage(layer as CanvasImageSource, 0, 0);
  ctx.globalAlpha = 1;

  // The last full trace of the figure, bright at the pen and fading behind it. It is drawn turned
  // along with the figure (each point carried round by the turn since the pen passed it), so it
  // shows the figure itself, crisp, rather than the smeared path; it meets the pen at its tip.
  const window = 1 / e.traces;
  const ghost = (uu: number): [number, number] => {
    const [x, y] = pen(e, uu);
    const turn = 2 * Math.PI * (u - uu);
    const c = dm.cos(turn);
    const sn = dm.sin(turn);
    return [CX + (x - CX) * c - (y - CY) * sn, CY + (x - CX) * sn + (y - CY) * c];
  };
  const chunks = 40;
  const per = Math.ceil(perLoop / e.traces / chunks);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let c = 0; c < chunks; c++) {
    const age = 1 - c / chunks; // oldest chunk first
    const ua = u - window * age;
    const ub = u - window * (age - 1 / chunks);
    ctx.strokeStyle = rgbToCss(lighten(paint(((ub % 1) + 1) % 1), 0.25), 0.9 * (1 - age) ** 1.5);
    ctx.lineWidth = 1.5 + 3.5 * (1 - age);
    ctx.beginPath();
    for (let k = 0; k <= per; k++) {
      const [x, y] = ghost(ua + ((ub - ua) * k) / per);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // The circles, each with a tick at its starting angle (where it rings), and the arms.
  const pts = new Float64Array(2 * e.arms.length + 2);
  chain(e, u, pts);
  e.arms.forEach((a, i) => {
    const cx = pts[2 * i];
    const cy = pts[2 * i + 1];
    const r = a.amp * e.scale;
    const fl = s.flash[i];
    const col = color(i);
    // Near-white so the machinery stands apart from the coloured drawing; tinted as it rings.
    ctx.strokeStyle = rgbToCss(mixRgb([235, 240, 255], lighten(col, 0.3), 0.25 + 0.75 * fl), 0.4 + 0.55 * fl);
    ctx.lineWidth = 2.5 + 3 * fl;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    const home = Math.atan2(a.im, a.re);
    ctx.fillStyle = rgbToCss(lighten(col, 0.5), 0.35 + 0.65 * fl);
    ctx.beginPath();
    ctx.arc(cx + dm.cos(home) * r, cy + dm.sin(home) * r, Math.min(r, 3 + 7 * fl), 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.lineWidth = 2.5;
  e.arms.forEach((_, i) => {
    ctx.strokeStyle = rgbToCss(lighten(color(i), 0.35), 0.85);
    ctx.beginPath();
    ctx.moveTo(pts[2 * i], pts[2 * i + 1]);
    ctx.lineTo(pts[2 * i + 2], pts[2 * i + 3]);
    ctx.stroke();
  });
  const end = 2 * e.arms.length;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.arc(pts[end], pts[end + 1], 8, 0, Math.PI * 2);
  ctx.fill();
}
