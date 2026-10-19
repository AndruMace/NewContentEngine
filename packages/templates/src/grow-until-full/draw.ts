import { rgbToCss, type Ctx2D, type RGB } from '@sim/engine';
import { TAU } from '@sim/physics';

const INK = '#1b1b2a';

export type Mood = 'calm' | 'worried' | 'panic' | 'happy' | 'sad';

export interface FaceBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** 1 on a wall hit, decaying: squeezes the eyes shut for a moment. */
  hit: number;
}

/** Cartoon face on a ball: looks where it's heading, blinks, winces on hits, and reacts to its mood. */
export function drawFace(ctx: Ctx2D, b: FaceBall, mood: Mood, t: number, idx: number) {
  const { r } = b;
  if (r < 6) return;
  const sp = Math.hypot(b.vx, b.vy);
  const look = sp > 1 ? Math.min(1, sp / 900) : 0;
  const lx = look ? (b.vx / sp) * look : 0;
  const ly = look ? (b.vy / sp) * look : 0;
  ctx.save();
  ctx.translate(b.x + lx * r * 0.1, b.y + ly * r * 0.1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  const lw = Math.max(1.5, r * 0.065);
  ctx.lineWidth = lw;

  // Cheeks.
  ctx.fillStyle = 'rgba(255,110,140,0.35)';
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(sx * r * 0.52, r * 0.2, r * 0.13, r * 0.08, 0, 0, TAU);
    ctx.fill();
  }

  const ex = r * 0.32;
  const ey = -r * 0.12;
  const blink = (t + idx * 1.37) % 3.3 < 0.12;
  const wince = b.hit > 0.5 && mood !== 'happy';
  for (const sx of [-1, 1]) {
    const x = sx * ex;
    if (mood === 'happy') {
      // ^ ^
      ctx.beginPath();
      ctx.arc(x, ey + r * 0.06, r * 0.13, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    } else if (wince) {
      // > <
      const w = r * 0.12;
      ctx.beginPath();
      ctx.moveTo(x - sx * w, ey - w);
      ctx.lineTo(x + sx * w, ey);
      ctx.lineTo(x - sx * w, ey + w);
      ctx.stroke();
    } else if (blink) {
      ctx.beginPath();
      ctx.moveTo(x - r * 0.13, ey);
      ctx.lineTo(x + r * 0.13, ey);
      ctx.stroke();
    } else {
      const er = mood === 'panic' ? r * 0.22 : r * 0.18;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, ey, er, 0, TAU);
      ctx.fill();
      ctx.lineWidth = lw * 0.6;
      ctx.stroke();
      ctx.lineWidth = lw;
      ctx.fillStyle = INK;
      const pr = mood === 'panic' ? er * 0.35 : er * 0.55;
      ctx.beginPath();
      ctx.arc(x + lx * (er - pr) * 0.9, ey + ly * (er - pr) * 0.9, pr, 0, TAU);
      ctx.fill();
    }
    // Brows: tilted up in the middle when worried, raised high in a panic.
    if (mood === 'worried' || mood === 'panic' || mood === 'sad') {
      const by = ey - r * (mood === 'panic' ? 0.36 : 0.3);
      ctx.beginPath();
      ctx.moveTo(x - sx * r * 0.14, by - r * 0.06);
      ctx.lineTo(x + sx * r * 0.12, by + r * 0.03);
      ctx.stroke();
    }
  }

  // Mouth.
  const my = r * 0.28;
  ctx.beginPath();
  switch (mood) {
    case 'calm':
      ctx.arc(0, my - r * 0.12, r * 0.2, Math.PI * 0.2, Math.PI * 0.8);
      ctx.stroke();
      break;
    case 'worried':
      ctx.moveTo(-r * 0.16, my + r * 0.02);
      ctx.quadraticCurveTo(-r * 0.05, my - r * 0.06, 0, my);
      ctx.quadraticCurveTo(r * 0.05, my + r * 0.06, r * 0.16, my - r * 0.02);
      ctx.stroke();
      break;
    case 'panic':
      ctx.ellipse(0, my + r * 0.02, r * 0.11, r * 0.15, 0, 0, TAU);
      ctx.fill();
      break;
    case 'happy':
      ctx.arc(0, my - r * 0.06, r * 0.22, 0, Math.PI);
      ctx.closePath();
      ctx.fill();
      break;
    case 'sad':
      ctx.arc(0, my + r * 0.12, r * 0.16, Math.PI * 1.2, Math.PI * 1.8);
      ctx.stroke();
      break;
  }

  // Sweat drop.
  if (mood === 'panic') {
    const sx = r * 0.62;
    const sy = -r * 0.42;
    const s = r * 0.1;
    ctx.fillStyle = '#7fd4ff';
    ctx.beginPath();
    ctx.moveTo(sx, sy - s * 1.8);
    ctx.quadraticCurveTo(sx + s, sy - s * 0.2, sx, sy + s);
    ctx.quadraticCurveTo(sx - s, sy - s * 0.2, sx, sy - s * 1.8);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Ball drawn as tree rings: one band per bounce, newest outside. `rings` is how many bounces it has
 * had, `step` the band width, `colorAt(k)` the colour of the band added on bounce k, and `trace(rr)`
 * starts a path of the ball's shape at size rr.
 */
export function drawRings(ctx: Ctx2D, r: number, rings: number, step: number, colorAt: (k: number) => RGB, trace: (rr: number) => void) {
  const maxBands = 160;
  const w = Math.max(step, r / maxBands, 2.5);
  for (let j = 0; ; j++) {
    const rr = r - j * w;
    const core = j >= rings || rr - w <= 0;
    ctx.fillStyle = rgbToCss(colorAt(core ? 0 : rings - j));
    trace(rr);
    ctx.fill();
    if (core) break;
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
