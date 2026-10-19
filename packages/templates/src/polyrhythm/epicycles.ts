/**
 * Fourier style: a chain of rotating circles (epicycles) whose pen draws a figure once over the loop,
 * finishing exactly at the end. Each circle is a clock face with its own number of ticks, and rings
 * every time its arm sweeps past a tick, so every circle is one voice of the polyrhythm: a circle
 * that turns k times with m ticks plays k·m evenly spaced notes. Everything starts together, drifts,
 * and comes back home at the end as the drawing closes.
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
  /** Ticks (notes per turn) on each circle. */
  ticks: number[];
  /** Pixels per unit, so the drawing fills its space. */
  scale: number;
}

const SAMPLES = 256;
/** Circles smaller than this (as a fraction of the drawing's radius, about 3px) are dropped. */
const MIN_AMP = 0.007;
const CX = 540;
const CY = 1000;
const R_FIG = 430;

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

/**
 * The circles for a figure: its biggest Fourier terms (at most `maxArms`, none too small to see),
 * each turning its own whole number of times per loop. `ticksFor(n)` gives each circle's ticks,
 * biggest circle first.
 */
export function buildEpicycles(figure: Figure, maxArms: number, ticksFor: (n: number) => number[]): Epicycles {
  const { terms } = dft(outline(figure));
  const arms = terms
    .filter((t) => t.amp >= MIN_AMP)
    .slice(0, maxArms)
    .map((t) => ({ freq: t.freq, re: t.re, im: t.im, amp: t.amp }));
  // Fit the drawing to its space: the pen's furthest point from the centre.
  let far = 0;
  for (let j = 0; j < 512; j++) far = Math.max(far, dm.hypot(...penAt(arms, j / 512)));
  return { figure, arms, ticks: ticksFor(arms.length), scale: R_FIG / Math.max(1e-6, far) };
}

/** Pen position (units, around the centre) at loop fraction u. */
function penAt(arms: Arm[], u: number): [number, number] {
  let x = 0;
  let y = 0;
  for (const a of arms) {
    const th = 2 * Math.PI * a.freq * u;
    const c = dm.cos(th);
    const s = dm.sin(th);
    x += a.re * c - a.im * s;
    y += a.re * s + a.im * c;
  }
  return [x, y];
}

export interface EpicycleView {
  epi: Epicycles;
  p: { loopSeconds: number };
  hits: number[];
  flash: number[];
}

/** `color(i)` colours circle i; `paint(u)` colours the drawing at loop fraction u. */
export function drawEpicycles(ctx: Ctx2D, s: EpicycleView, t: number, frame: number, color: (i: number) => RGB, paint: (u: number) => RGB) {
  const e = s.epi;
  const T = s.p.loopSeconds;
  const u = Math.min(1, t / T);
  const toScreen = ([x, y]: [number, number]): [number, number] => [CX + x * e.scale, CY + y * e.scale];
  // Pen samples per loop: a few px apart at the pen's fastest.
  const perLoop = 600 + e.arms.reduce((a, arm) => a + Math.abs(arm.freq) * arm.amp * e.scale, 0);

  // The drawing so far: a soft glow under a solid line, coloured along the loop.
  const layer = traceLayer(s, frame, Math.min(t, T), (lc, t0, t1) => {
    const steps = Math.max(1, Math.ceil(((t1 - t0) / T) * perLoop));
    lc.lineCap = 'round';
    let [px, py] = toScreen(penAt(e.arms, t0 / T));
    for (let k = 1; k <= steps; k++) {
      const uu = (t0 + ((t1 - t0) * k) / steps) / T;
      const [x, y] = toScreen(penAt(e.arms, uu));
      const col = lighten(paint(uu), 0.15);
      for (const [w, a] of [
        [18, 0.1],
        [6, 1],
      ]) {
        lc.strokeStyle = rgbToCss(col, a);
        lc.lineWidth = w;
        lc.beginPath();
        lc.moveTo(px, py);
        lc.lineTo(x, y);
        lc.stroke();
      }
      [px, py] = [x, y];
    }
  });
  ctx.drawImage(layer as CanvasImageSource, 0, 0);

  // The circles: clock faces with a tick per note (the home tick brighter), the tick just struck lit
  // in the circle's colour.
  let cx = CX;
  let cy = CY;
  const joints: [number, number][] = [[cx, cy]];
  e.arms.forEach((a, i) => {
    const r = a.amp * e.scale;
    const fl = s.flash[i];
    const col = color(i);
    const home = Math.atan2(a.im, a.re);
    ctx.strokeStyle = rgbToCss(mixRgb([235, 240, 255], lighten(col, 0.3), 0.3 + 0.7 * fl), 0.42 + 0.5 * fl);
    ctx.lineWidth = 2.5 + 2 * fl;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    const m = e.ticks[i];
    if (r >= 9) {
      const len = Math.min(14, r * 0.28);
      const lit = s.hits[i] >= 0 ? s.hits[i] % m : -1;
      for (let j = 0; j < m; j++) {
        // Ticks run the way the arm turns, from its starting angle.
        const ang = home + (Math.sign(a.freq) * 2 * Math.PI * j) / m;
        const on = j === lit ? fl : 0;
        ctx.strokeStyle = on > 0.02 ? rgbToCss(lighten(col, 0.5), 0.5 + 0.5 * on) : j === 0 ? 'rgba(255,255,255,0.8)' : 'rgba(235,240,255,0.4)';
        ctx.lineWidth = j === 0 ? 3.5 : 2 + 2 * on;
        const inner = r - len * (1 + on);
        ctx.beginPath();
        ctx.moveTo(cx + dm.cos(ang) * inner, cy + dm.sin(ang) * inner);
        ctx.lineTo(cx + dm.cos(ang) * r, cy + dm.sin(ang) * r);
        ctx.stroke();
      }
    }
    const th = home + 2 * Math.PI * a.freq * u;
    cx += dm.cos(th) * r;
    cy += dm.sin(th) * r;
    joints.push([cx, cy]);
  });
  // The arms, each in its circle's colour.
  ctx.lineCap = 'round';
  e.arms.forEach((_, i) => {
    ctx.strokeStyle = rgbToCss(lighten(color(i), 0.35 + 0.4 * s.flash[i]));
    ctx.lineWidth = 3.5 + 2 * s.flash[i];
    ctx.beginPath();
    ctx.moveTo(...joints[i]);
    ctx.lineTo(...joints[i + 1]);
    ctx.stroke();
  });
  const [ex, ey] = joints[joints.length - 1];
  ctx.fillStyle = rgbToCss(lighten(paint(u % 1), 0.5), 0.35);
  ctx.beginPath();
  ctx.arc(ex, ey, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.arc(ex, ey, 8, 0, Math.PI * 2);
  ctx.fill();
}
