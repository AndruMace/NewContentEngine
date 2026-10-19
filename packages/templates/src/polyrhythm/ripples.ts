/**
 * Raindrops on still water: each drip point drops at its own whole-number rate, every landing rings
 * its note and sends out ripples. Ripples are worked out from the drop times (including the last
 * loop's), so the scene is the same at the end of the loop as at the start.
 */
import { lighten, rgbToCss, type Ctx2D, type RGB } from '@sim/engine';
import * as dm from '@sim/physics/math';

const CX = 540;
const WATER_Y = 1150;
const RING_RX = 360;
/** Vertical squash of circles lying on the water (the camera looks down at a shallow angle). */
const SQUASH = 0.36;
const HORIZON_Y = 720;
const LIFE_S = 3.4;
const SPEED = 135; // px/s
const FALL_H = 470;

export interface RippleView {
  notesPerLoop: number[];
  p: { loopSeconds: number };
  flash: number[];
}

/** Where drop point i (of n) lands, and how near the camera it is (bigger when nearer). */
export function rippleSpot(i: number, n: number): { x: number; y: number; scale: number } {
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
  const depth = (dm.sin(a) + 1) / 2;
  return { x: CX + RING_RX * dm.cos(a), y: WATER_Y + RING_RX * SQUASH * dm.sin(a), scale: 0.8 + 0.4 * depth };
}

export function drawRipples(ctx: Ctx2D, s: RippleView, t: number, color: (i: number) => RGB, water: RGB) {
  const n = s.notesPerLoop.length;
  const T = s.p.loopSeconds;

  // Water: a soft tint below the horizon with a few slow glints.
  const g = ctx.createLinearGradient(0, HORIZON_Y, 0, 1920);
  g.addColorStop(0, rgbToCss(water, 0));
  g.addColorStop(0.25, rgbToCss(water, 0.1));
  g.addColorStop(1, rgbToCss(water, 0.2));
  ctx.fillStyle = g;
  ctx.fillRect(0, HORIZON_Y, 1080, 1920 - HORIZON_Y);
  ctx.lineWidth = 2;
  for (let k = 0; k < 14; k++) {
    const y = HORIZON_Y + 40 + ((k * 0.61803) % 1) * 1100;
    const w = 60 + 140 * ((k * 0.377) % 1);
    const x = 540 + 420 * dm.sin(k * 2.3 + (2 * Math.PI * t) / T);
    ctx.strokeStyle = rgbToCss(lighten(water, 0.5), 0.05 + 0.05 * ((k * 0.73) % 1));
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y);
    ctx.lineTo(x + w / 2, y);
    ctx.stroke();
  }

  // Back to front, so nearer drops draw over further ones.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => rippleSpot(a, n).y - rippleSpot(b, n).y);
  for (const i of order) {
    const { x, y, scale } = rippleSpot(i, n);
    const col = color(i);
    const P = T / s.notesPerLoop[i];
    // Ripples from every landing still spreading (k may be negative: the previous loop's drops).
    for (let k = Math.ceil((t - LIFE_S) / P); k * P <= t + 1e-9; k++) {
      const age = t - k * P;
      const fade = (1 - age / LIFE_S) ** 1.6;
      for (const [frac, a] of [
        [1, 0.85],
        [0.78, 0.5],
        [0.56, 0.3],
      ]) {
        const r = SPEED * age * frac * scale;
        if (r < 1) continue;
        ctx.strokeStyle = rgbToCss(lighten(col, 0.3), a * fade);
        ctx.lineWidth = (1.5 + 2 * fade) * scale;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * SQUASH, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Splash crown just after the landing.
      if (age < 0.4) {
        ctx.fillStyle = rgbToCss(lighten(col, 0.6), 1 - age / 0.4);
        for (let d = 0; d < 7; d++) {
          const ang = (2 * Math.PI * d) / 7 + i;
          const dx = dm.cos(ang) * 70 * age * scale;
          const dy = dm.sin(ang) * 70 * age * SQUASH * scale - (260 * age - 900 * age * age) * scale;
          ctx.beginPath();
          ctx.arc(x + dx, y + dy, 3 * scale, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Landing spot: brightens as the next drop nears, flashes as it lands.
    const next = (Math.floor(t / P + 1e-9) + 1) * P;
    const fall = Math.min(0.6, 0.8 * P);
    const u = Math.max(0, 1 - (next - t) / fall);
    const fl = s.flash[i];
    ctx.fillStyle = rgbToCss(lighten(col, 0.4), 0.12 + 0.3 * u + 0.5 * fl);
    ctx.beginPath();
    ctx.ellipse(x, y, (10 + 10 * fl) * scale, (10 + 10 * fl) * SQUASH * scale, 0, 0, Math.PI * 2);
    ctx.fill();

    // The falling drop, accelerating, with a faint streak.
    if (u > 0) {
      const dy = y - FALL_H * scale * (1 - u * u);
      ctx.strokeStyle = rgbToCss(lighten(col, 0.5), 0.35 * Math.min(1, u * 4));
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      ctx.moveTo(x, dy - 34 * u * scale);
      ctx.lineTo(x, dy);
      ctx.stroke();
      ctx.fillStyle = rgbToCss(lighten(col, 0.6), Math.min(1, u * 4));
      ctx.beginPath();
      ctx.ellipse(x, dy, 5.5 * scale, 9 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
