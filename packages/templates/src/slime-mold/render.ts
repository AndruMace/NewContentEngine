import { FONT_FAMILY, hexToRgb, mixRgb, type Ctx2D, type RGB, type Theme } from '@sim/engine';
import { makeLayer } from '../math-curiosities/shared';
import { drawAnswer, drawCommentPrompt } from '../guess';
import { drawStoryCaption, markAt, timeOf, type Director } from '../story';
import { N } from './sim';
import type { MoldParams } from './params';
import type { MoldSim } from './script';

const DISH = { cx: 540, cy: 965, r: 470 };
const PROMPT = { x: 540, y: 1497 };
const CAPTION_Y = 1605;
const CELL = (DISH.r * 2) / N;

const LOOKS = {
  agar: { stops: ['#1d140b', '#4a3412', '#c99a12', '#f5cf2a', '#fff4a8'], dish: '#2a1d10', rim: 'rgba(255,240,200,0.35)', food: '#e9d6a6' },
  neon: { stops: ['#04020c', '#2a0a4a', '#b0157a', '#ff4fb0', '#bff7ff'], dish: '#070312', rim: 'rgba(180,120,255,0.4)', food: '#ffe9a8' },
  glow: { stops: ['#020812', '#04263a', '#0b8a8a', '#3ff2c8', '#e8fff8'], dish: '#03101a', rim: 'rgba(120,255,230,0.35)', food: '#d8f3ff' },
} as const;

export interface MoldVis {
  layer: OffscreenCanvas | HTMLCanvasElement | null;
  image: ImageData | null;
  lut: Uint8ClampedArray | null;
  walls: OffscreenCanvas | HTMLCanvasElement | null;
}

export const newVis = (): MoldVis => ({ layer: null, image: null, lut: null, walls: null });

export interface DrawState {
  p: MoldParams;
  sim: MoldSim;
  dir: Director<MoldSim>;
  vis: MoldVis;
}

function buildLut(p: MoldParams): Uint8ClampedArray {
  const stops = LOOKS[p.palette].stops.map(hexToRgb);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const u = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(u));
    const c: RGB = mixRgb(stops[k], stops[k + 1], u - k);
    lut.set(c, i * 3);
  }
  return lut;
}

/** The maze walls (or the bay), drawn once. */
function wallLayer(sim: MoldSim) {
  const c = makeLayer(N, N);
  const g = c.getContext('2d') as Ctx2D;
  const img = g.createImageData(N, N);
  const cx = (N - 1) / 2;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const inDish = (x - cx) ** 2 + (y - cx) ** 2 <= (N / 2 - 2) ** 2;
      if (!inDish || !sim.mold.wall[y * N + x]) continue;
      const o = (y * N + x) * 4;
      img.data[o] = 58;
      img.data[o + 1] = 62;
      img.data[o + 2] = 70;
      img.data[o + 3] = 235;
    }
  g.putImageData(img, 0, 0);
  return c;
}

export function renderMold(ctx: Ctx2D, theme: Theme, s: DrawState, t: number) {
  const { p, sim, vis } = s;
  const look = LOOKS[p.palette];
  const bg = ctx.createRadialGradient(540, 960, 200, 540, 960, 1300);
  bg.addColorStop(0, '#15161a');
  bg.addColorStop(1, '#050507');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1080, 1920);
  // The dish.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 50;
  ctx.fillStyle = look.dish;
  ctx.beginPath();
  ctx.arc(DISH.cx, DISH.cy, DISH.r + 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // The trail, through the palette (more trail: brighter, thicker-looking tubes).
  if (!vis.layer) {
    vis.layer = makeLayer(N, N);
    vis.image = (vis.layer.getContext('2d') as Ctx2D).createImageData(N, N);
    vis.lut = buildLut(p);
  }
  const img = vis.image!;
  const lut = vis.lut!;
  const tr = sim.mold.trail;
  const d = img.data;
  for (let i = 0; i < N * N; i++) {
    const v = tr[i];
    const k = Math.min(255, Math.round(255 * (1 - Math.exp(-v / 7))));
    const o = i * 4;
    d[o] = lut[k * 3];
    d[o + 1] = lut[k * 3 + 1];
    d[o + 2] = lut[k * 3 + 2];
    d[o + 3] = 255;
  }
  (vis.layer.getContext('2d') as Ctx2D).putImageData(img, 0, 0);
  ctx.save();
  ctx.beginPath();
  ctx.arc(DISH.cx, DISH.cy, DISH.r, 0, Math.PI * 2);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(vis.layer as CanvasImageSource, DISH.cx - DISH.r, DISH.cy - DISH.r, DISH.r * 2, DISH.r * 2);
  if (p.mode === 'maze' || p.mode === 'tokyo') {
    vis.walls ??= wallLayer(sim);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(vis.walls as CanvasImageSource, DISH.cx - DISH.r, DISH.cy - DISH.r, DISH.r * 2, DISH.r * 2);
  }
  ctx.restore();

  // Oat flakes.
  sim.mold.food.forEach((f, k) => {
    if (!f.placed) return;
    const x = DISH.cx - DISH.r + f.x * CELL;
    const y = DISH.cy - DISH.r + f.y * CELL;
    const r = p.mode === 'maze' ? 17 : f.start ? 15 : 12;
    if (f.reached >= 0 && !f.start) {
      const since = (sim.mold.tick - f.reached) / 40;
      if (since < 1) {
        ctx.strokeStyle = theme.accent;
        ctx.globalAlpha = 1 - since;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(x, y, r + 8 + since * 40, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(k * 1.3);
    ctx.fillStyle = look.food;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.25, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(120,90,40,0.35)';
    ctx.beginPath();
    ctx.ellipse(r * 0.2, r * 0.15, r * 0.7, r * 0.35, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // The shortest route, once revealed.
  if (sim.showRoute && sim.route.length) {
    const since = t - markAt(s.dir, 'reveal');
    ctx.save();
    ctx.globalAlpha = Math.min(0.9, Math.max(0, since * 1.5));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([16, 12]);
    for (const line of sim.route) {
      ctx.beginPath();
      line.forEach(([x, y], k) => {
        const sx = DISH.cx - DISH.r + x * CELL;
        const sy = DISH.cy - DISH.r + y * CELL;
        if (k === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
    }
    ctx.restore();
  }

  // Glass rim.
  ctx.strokeStyle = look.rim;
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(DISH.cx, DISH.cy, DISH.r + 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(DISH.cx, DISH.cy, DISH.r - 10, Math.PI * 1.1, Math.PI * 1.45);
  ctx.stroke();
}

export function renderMoldTop(ctx: Ctx2D, theme: Theme, s: DrawState, t: number) {
  const { p, sim, dir } = s;
  const food = sim.mold.food.filter((f) => !f.start);
  ctx.save();
  ctx.font = `900 34px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = theme.textStroke;
  const text = p.mode === 'maze' ? 'ONE CELL · NO BRAIN' : `FOOD FOUND  ${food.filter((f) => f.reached >= 0).length} / ${food.length}`;
  ctx.strokeText(text, 540, 400);
  ctx.fillStyle = theme.text;
  ctx.fillText(text, 540, 400);
  ctx.restore();
  const guess = dir.said.find((x) => x.beat.id === 'guess');
  const revealAt = markAt(dir, 'reveal');
  if (p.guess && guess && t < revealAt) {
    const left = Math.min(revealAt - t, guess.at + guess.durationS + 8 - t);
    if (left > 0) drawCommentPrompt(ctx, theme, t - guess.at, left, PROMPT);
  }
  if (t >= revealAt + 0.6 && p.mode === 'maze') drawAnswer(ctx, theme, sim.answer, 540, 465, t - revealAt - 0.6, 74);
  if (p.captions) drawStoryCaption(ctx, theme, dir, timeOf(dir), { y: CAPTION_Y });
}
