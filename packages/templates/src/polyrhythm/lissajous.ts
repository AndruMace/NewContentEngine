/**
 * Lissajous table: a row of circles across the top and a column down the side, each with a dot
 * orbiting at its own whole-number rate. Every cell's dot takes its x from its column's dot and its
 * y from its row's dot, so it traces a Lissajous curve (the diagonal draws circles); all of them
 * close exactly at the end of the loop.
 */
import { lighten, mixRgb, rgbToCss, type Ctx2D, type RGB } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { traceLayer } from './trace';

/** Circles per side (so up to 36 curves). */
export const MAX_LISSAJOUS = 6;
const CX = 540;
const TOP = 560;
/** The curves fade out over the last moments so the final frame matches the first. */
const FADE_S = 1.4;

export interface LissajousView {
  /** Columns' rates, then rows' (n each). */
  cycles: number[];
  p: { loopSeconds: number };
  flash: number[];
}

function layout(n: number) {
  const cell = Math.min(150, 1000 / (n + 1));
  return { cell, x0: CX - ((n + 1) * cell) / 2, r: cell * 0.36 };
}

/** Screen x of a column's centre (for stereo placement). */
export function lissajousColumnX(i: number, n: number): number {
  const { cell, x0 } = layout(n);
  return x0 + (i + 1.5) * cell;
}

export function drawLissajous(ctx: Ctx2D, s: LissajousView, t: number, frame: number, color: (i: number) => RGB) {
  const n = s.cycles.length / 2;
  const T = s.p.loopSeconds;
  const { cell, x0, r } = layout(n);
  const colX = (i: number) => x0 + (i + 1.5) * cell;
  const rowY = (j: number) => TOP + (j + 1.5) * cell;
  const angle = (e: number, tt: number) => -Math.PI / 2 + (2 * Math.PI * s.cycles[e] * tt) / T;
  const cellColor = (i: number, j: number) => mixRgb(color(i), color(n + j), 0.5);
  const maxRate = Math.max(...s.cycles);

  const layer = traceLayer(s, frame, t, (lc, t0, t1) => {
    const steps = Math.max(1, Math.ceil(((t1 - t0) / T) * maxRate * 120));
    lc.lineWidth = 2.2;
    lc.lineCap = 'round';
    lc.lineJoin = 'round';
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        lc.strokeStyle = rgbToCss(lighten(cellColor(i, j), 0.15), 0.8);
        lc.beginPath();
        for (let k = 0; k <= steps; k++) {
          const tt = t0 + ((t1 - t0) * k) / steps;
          const x = colX(i) + r * dm.cos(angle(i, tt));
          const y = rowY(j) + r * dm.sin(angle(n + j, tt));
          if (k === 0) lc.moveTo(x, y);
          else lc.lineTo(x, y);
        }
        lc.stroke();
      }
    }
  });

  // Guide lines from each header dot through its column / row.
  const bottom = rowY(n - 1) + cell / 2;
  const right = colX(n - 1) + cell / 2;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < n; i++) {
    const x = colX(i) + r * dm.cos(angle(i, t));
    ctx.strokeStyle = rgbToCss(color(i), 0.14 + 0.3 * s.flash[i]);
    ctx.beginPath();
    ctx.moveTo(x, TOP + cell / 2);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  for (let j = 0; j < n; j++) {
    const y = rowY(j) + r * dm.sin(angle(n + j, t));
    ctx.strokeStyle = rgbToCss(color(n + j), 0.14 + 0.3 * s.flash[n + j]);
    ctx.beginPath();
    ctx.moveTo(x0 + cell / 2, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  ctx.globalAlpha = Math.min(1, Math.max(0, (T - t) / FADE_S));
  ctx.drawImage(layer as CanvasImageSource, 0, 0);
  ctx.globalAlpha = 1;

  // Header circles: a tick at the top (where each rings) and the orbiting dot.
  for (let e = 0; e < 2 * n; e++) {
    const cx = e < n ? colX(e) : x0 + cell / 2;
    const cy = e < n ? TOP + cell / 2 : rowY(e - n);
    const col = color(e);
    const fl = s.flash[e];
    ctx.strokeStyle = rgbToCss(lighten(col, 0.2 + 0.4 * fl), 0.45 + 0.5 * fl);
    ctx.lineWidth = 3 + 3 * fl;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = rgbToCss(lighten(col, 0.5), 0.3 + 0.7 * fl);
    ctx.beginPath();
    ctx.arc(cx, cy - r, 4 + 6 * fl, 0, Math.PI * 2);
    ctx.fill();
    const a = angle(e, t);
    ctx.fillStyle = rgbToCss(lighten(col, 0.4 + 0.3 * fl));
    ctx.beginPath();
    ctx.arc(cx + r * dm.cos(a), cy + r * dm.sin(a), 8 + 3 * fl, 0, Math.PI * 2);
    ctx.fill();
  }

  // The dot drawing each curve.
  for (let j = 0; j < n; j++) {
    const y = rowY(j) + r * dm.sin(angle(n + j, t));
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = rgbToCss(lighten(cellColor(i, j), 0.55));
      ctx.beginPath();
      ctx.arc(colX(i) + r * dm.cos(angle(i, t)), y, 5.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
