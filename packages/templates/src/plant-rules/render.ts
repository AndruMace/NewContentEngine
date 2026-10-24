import { FONT_FAMILY, paletteAt, rgbToCss, type Ctx2D, type Theme } from '@sim/engine';
import { drawAnswer, drawCommentPrompt } from '../guess';
import { drawStoryCaption, markAt, sinceTick, timeOf, type Director } from '../story';
import { bounds, layout, type Shape } from './lsystem';
import type { PlantParams } from './params';
import { BLOOM, GROW, type PlantSim } from './script';

const AREA = { x: 80, y: 610, w: 920, h: 810 };
const PROMPT = { x: 540, y: 1462 };
const CAPTION_Y = 1565;

const SEASONS = {
  spring: { trunk: '#6b4a2b', branch: '#7fb34d', tip: '#c2f27a', leaves: ['#8fdc5a', '#a8e86a', '#6cc24a'], flowers: ['#ff8fc7', '#fff2a8', '#ffffff'] },
  summer: { trunk: '#5a3d22', branch: '#3f8f3a', tip: '#77c94f', leaves: ['#4fae3c', '#3a9a35', '#66c04a'], flowers: ['#ff5c5c', '#ffd23d', '#ff9a3d'] },
  autumn: { trunk: '#5b3a22', branch: '#a8662d', tip: '#e0a040', leaves: ['#e3793b', '#d9a531', '#b5402a'], flowers: ['#ffd27a', '#ff9a3d'] },
  winter: { trunk: '#4a3d36', branch: '#8a8f99', tip: '#dfe8f2', leaves: ['#eaf4ff', '#d6e6f7', '#ffffff'], flowers: ['#ffffff', '#cfe6ff'] },
} as const;

/** Picture-only caches: line positions per plant, reused every frame. */
export interface PlantVis {
  xy: Float32Array[];
  prev: Float32Array[];
}

export const newVis = (): PlantVis => ({ xy: [], prev: [] });

export interface DrawState {
  p: PlantParams;
  sim: PlantSim;
  dir: Director<PlantSim>;
  vis: PlantVis;
}

/** A fixed pseudo-random wobble per line (−1..1), the same every frame. */
function wobbleOf(i: number, plant: number) {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(plant + 7, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 12)) >>> 0) / 2147483648 - 1;
}

function background(ctx: Ctx2D, p: PlantParams) {
  if (p.background === 'paper') {
    const g = ctx.createRadialGradient(540, 900, 200, 540, 960, 1300);
    g.addColorStop(0, '#f6efdd');
    g.addColorStop(1, '#d9cba9');
    ctx.fillStyle = g;
  } else if (p.background === 'greenhouse') {
    const g = ctx.createLinearGradient(0, 0, 0, 1920);
    g.addColorStop(0, '#1a4a42');
    g.addColorStop(1, '#081d1a');
    ctx.fillStyle = g;
  } else {
    const g = ctx.createRadialGradient(540, 1000, 100, 540, 1000, 1300);
    g.addColorStop(0, '#10243a');
    g.addColorStop(1, '#03070e');
    ctx.fillStyle = g;
  }
  ctx.fillRect(0, 0, 1080, 1920);
  if (p.background === 'night') {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let k = 0; k < 90; k++) {
      const x = ((wobbleOf(k, 1) + 1) / 2) * 1080;
      const y = ((wobbleOf(k, 2) + 1) / 2) * 1920;
      ctx.fillRect(x, y, 2, 2);
    }
  } else if (p.background === 'greenhouse') {
    // Soft light through the glass.
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#ffffff';
    for (let k = 0; k < 5; k++) {
      ctx.beginPath();
      ctx.moveTo(150 + k * 220, 0);
      ctx.lineTo(260 + k * 220, 0);
      ctx.lineTo(60 + k * 220, 1920);
      ctx.lineTo(-40 + k * 220, 1920);
      ctx.fill();
    }
    ctx.restore();
  }
}

interface Fit {
  s: number;
  ox: number;
  oy: number;
}

function fitTo(xy: Float32Array, n: number, box: { x: number; y: number; w: number; h: number }, plant: boolean): Fit {
  const b = bounds(xy, n);
  const w = Math.max(1e-6, b.x1 - b.x0);
  const h = Math.max(1e-6, b.y1 - b.y0);
  const s = Math.min(box.w / w, box.h / h);
  const ox = box.x + box.w / 2 - ((b.x0 + b.x1) / 2) * s;
  // Plants stand on the bottom of their box; fractals sit in its middle.
  const oy = plant ? box.y + box.h - b.y1 * s : box.y + box.h / 2 - ((b.y0 + b.y1) / 2) * s;
  return { s, ox, oy };
}

/** Grown in up to `upTo` (a line's birth, fractional at the frontier). */
function drawShape(ctx: Ctx2D, sh: Shape, xy: Float32Array, f: Fit, upTo: number, p: PlantParams, kind: 'plant' | 'fractal', theme: Theme, alpha: number, leafScale: number) {
  if (alpha <= 0 || !sh.n) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const X = (v: number) => f.ox + v * f.s;
  const Y = (v: number) => f.oy + v * f.s;
  const seg = (i: number) => {
    const b = sh.birth[i];
    if (b >= upTo) return false;
    const k = Math.min(1, upTo - b);
    const x0 = xy[i * 4];
    const y0 = xy[i * 4 + 1];
    ctx.moveTo(X(x0), Y(y0));
    ctx.lineTo(X(x0 + (xy[i * 4 + 2] - x0) * k), Y(y0 + (xy[i * 4 + 3] - y0) * k));
    return true;
  };
  if (kind === 'fractal') {
    // Coloured along the line, from the theme's palette.
    const buckets = 24;
    ctx.lineWidth = Math.max(2.2, Math.min(8, f.s * 0.3));
    for (let c = 0; c < buckets; c++) {
      ctx.strokeStyle = rgbToCss(paletteAt(theme.palette, c / (buckets - 1)));
      ctx.beginPath();
      const lo = (c / buckets) * (sh.maxBirth + 1);
      const hi = ((c + 1) / buckets) * (sh.maxBirth + 1);
      for (let i = 0; i < sh.n; i++) if (sh.birth[i] >= lo && sh.birth[i] < hi) seg(i);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  const season = SEASONS[p.season];
  const base = Math.max(2.4, Math.min(18, f.s * 0.6));
  const depths = sh.maxDepth + 1;
  for (let d = 0; d < depths; d++) {
    const u = depths > 1 ? d / (depths - 1) : 0;
    ctx.lineWidth = Math.max(1.3, base * Math.pow(p.taper, d));
    ctx.strokeStyle = u < 0.2 ? season.trunk : u < 0.7 ? season.branch : season.tip;
    ctx.beginPath();
    for (let i = 0; i < sh.n; i++) if (sh.depth[i] === d) seg(i);
    ctx.stroke();
  }
  if (p.leaves && leafScale > 0) {
    const r = Math.max(4.5, Math.min(16, f.s * 0.8)) * leafScale;
    season.leaves.forEach((colour, c) => {
      ctx.fillStyle = colour;
      ctx.beginPath();
      for (let i = c; i < sh.n; i += season.leaves.length) {
        if (!sh.tip[i] || sh.birth[i] + 1 > upTo) continue;
        const x = X(xy[i * 4 + 2]);
        const y = Y(xy[i * 4 + 3]);
        const a = Math.atan2(xy[i * 4 + 3] - xy[i * 4 + 1], xy[i * 4 + 2] - xy[i * 4]);
        ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        ctx.ellipse(x, y, r, r * 0.45, a, 0, Math.PI * 2);
      }
      ctx.fill();
    });
  }
  ctx.restore();
}

/** Flowers open at some of the tips once the plant is done. */
function drawFlowers(ctx: Ctx2D, sh: Shape, xy: Float32Array, f: Fit, p: PlantParams, open: number) {
  if (open <= 0) return;
  const colours = SEASONS[p.season].flowers;
  let tips = 0;
  for (let i = 0; i < sh.n; i++) tips += sh.tip[i];
  const every = Math.max(1, Math.ceil(tips / 160));
  const r = Math.max(7, Math.min(20, f.s * 1.1));
  let k = 0;
  for (let i = 0; i < sh.n; i++) {
    if (!sh.tip[i] || k++ % every) continue;
    const stagger = Math.max(0, Math.min(1, open * 1.6 - ((k * 37) % 100) / 160));
    if (stagger <= 0) continue;
    const pop = stagger < 1 ? 1 + 0.25 * Math.sin(Math.PI * stagger) : 1;
    const rr = r * stagger * pop;
    const x = f.ox + xy[i * 4 + 2] * f.s;
    const y = f.oy + xy[i * 4 + 3] * f.s;
    ctx.fillStyle = colours[k % colours.length];
    for (let q = 0; q < 5; q++) {
      const a = (q / 5) * Math.PI * 2 + k;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * rr * 0.55, y + Math.sin(a) * rr * 0.55, rr * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ffe36b';
    ctx.beginPath();
    ctx.arc(x, y, rr * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

const SYMBOL_COLOURS: Record<string, string> = { F: '#8fe36a', G: '#8fe36a', A: '#8fe36a', B: '#7ad0ff', X: '#d9a2ff', Y: '#ffb37a', '+': '#ffd35c', '-': '#ffd35c', '[': '#7ad0ff', ']': '#7ad0ff' };

/** A rule, symbol by symbol in colour, shrunk to fit. */
function drawRule(ctx: Ctx2D, theme: Theme, text: string, x: number, y: number, size: number, maxW: number, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `900 ${size}px ${FONT_FAMILY}`;
  const w = ctx.measureText(text).width;
  const k = Math.min(1, maxW / w);
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size / 7;
  ctx.strokeStyle = theme.textStroke;
  let cx = -w / 2;
  for (const ch of text) {
    const cw = ctx.measureText(ch).width;
    ctx.strokeText(ch, cx, 0);
    ctx.fillStyle = SYMBOL_COLOURS[ch] ?? theme.text;
    ctx.fillText(ch, cx, 0);
    cx += cw;
  }
  ctx.restore();
}

function label(ctx: Ctx2D, theme: Theme, text: string, x: number, y: number, size: number, fill = theme.text, alpha = 1, weight = 900) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, size / 7);
  ctx.strokeStyle = theme.textStroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

export function renderPlant(ctx: Ctx2D, theme: Theme, s: DrawState, t: number) {
  const { p, sim, dir, vis } = s;
  background(ctx, p);
  const kind = sim.preset.kind;
  const n = sim.plants.length;
  const growNow = Math.min(GROW, sim.grow + (sim.grow < GROW ? sinceTick(dir, 0.1) : 0));
  const f = growNow / GROW;
  const sway = (d: number) => (kind === 'plant' ? p.wind * 0.018 * d * Math.sin(t * 1.25 + d * 0.6) : 0);
  const wob = p.jitter > 0 && kind === 'plant' ? (plant: number) => (i: number) => wobbleOf(i, plant) * ((p.jitter * Math.PI) / 180) : () => undefined;
  const boxes = Array.from({ length: n }, (_, k) => ({ x: AREA.x + (AREA.w / n) * k, y: AREA.y, w: AREA.w / n, h: AREA.h }));

  // Ground under the plants.
  if (kind === 'plant') {
    ctx.save();
    ctx.globalAlpha = p.background === 'paper' ? 0.18 : 0.35;
    ctx.fillStyle = p.background === 'paper' ? '#5b4630' : '#000000';
    ctx.beginPath();
    ctx.ellipse(540, AREA.y + AREA.h + 6, 460, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // One scale for every plant in a garden, so they compare.
  const layouts = sim.plants.map((g, k) => {
    const sh = g.shapes[Math.min(sim.round, g.shapes.length - 1)];
    vis.xy[k] = layout(sh, sim.angle, sim.preset.heading, sway, vis.xy[k], wob(k));
    return sh;
  });
  const fits = layouts.map((sh, k) => fitTo(vis.xy[k], sh.n, boxes[k], kind === 'plant'));
  if (n > 1) {
    const sMin = Math.min(...fits.map((x) => x.s));
    fits.forEach((x, k) => {
      const sh = layouts[k];
      const b = bounds(vis.xy[k], sh.n);
      x.s = sMin;
      x.ox = boxes[k].x + boxes[k].w / 2 - ((b.x0 + b.x1) / 2) * sMin;
      x.oy = boxes[k].y + boxes[k].h - b.y1 * sMin;
    });
  }

  // The round before fades out as the new one grows in over it.
  if (sim.round > sim.firstRound && f < 1) {
    sim.plants.forEach((g, k) => {
      const sh = g.shapes[Math.min(sim.round - 1, g.shapes.length - 1)];
      vis.prev[k] = layout(sh, sim.angle, sim.preset.heading, sway, vis.prev[k], wob(k));
      const fit = n > 1 ? fits[k] : fitTo(vis.prev[k], sh.n, boxes[k], kind === 'plant');
      drawShape(ctx, sh, vis.prev[k], fit, Infinity, p, kind, theme, (1 - f * 1.4) * 0.6, 1);
    });
  }
  layouts.forEach((sh, k) => drawShape(ctx, sh, vis.xy[k], fits[k], f * (sh.maxBirth + 1), p, kind, theme, 1, sim.round >= sim.lastRound ? 1 : 0.7));
  if (sim.revealed && p.flowers && kind === 'plant') layouts.forEach((sh, k) => drawFlowers(ctx, sh, vis.xy[k], fits[k], p, Math.min(1, sim.bloom / BLOOM + sinceTick(dir, 0.1) / BLOOM)));
}

export function renderPlantTop(ctx: Ctx2D, theme: Theme, s: DrawState, t: number) {
  const { p, sim, dir } = s;
  const pre = sim.preset;
  // The rule(s), up top.
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.beginPath();
  ctx.roundRect(70, 300, 940, p.showString ? 250 : 210, 26);
  ctx.fill();
  ctx.restore();
  const rules = Object.entries(pre.rules);
  label(ctx, theme, `START  ${pre.axiom}`, 540, 338, 30, 'rgba(255,255,255,0.7)', 1, 800);
  rules.forEach(([from, to], k) => {
    const text = to.length > 1 ? `${from} → ${to.join('  or  ')}` : `${from} → ${to[0]}`;
    drawRule(ctx, theme, text, 540, 392 + k * 56, rules.length > 1 ? 44 : 50, 880);
  });
  if (p.showString) {
    const str = sim.plants[0].strings[Math.min(sim.round, sim.plants[0].strings.length - 1)];
    const shown = str.length > 46 ? `${str.slice(0, 46)}…` : str;
    drawRule(ctx, theme, shown, 540, 392 + rules.length * 56 + 6, 24, 880, 0.75);
  }
  const lines = sim.plants.reduce((a, g) => a + (g.shapes[Math.min(sim.round, g.shapes.length - 1)]?.n ?? 0), 0);
  const symbols = sim.plants[0].strings[Math.min(sim.round, sim.plants[0].strings.length - 1)].length;
  label(ctx, theme, `ROUND ${sim.round}  ·  ${lines.toLocaleString('en-US')} LINES${p.showString ? `  ·  ${symbols.toLocaleString('en-US')} SYMBOLS` : ''}`, 540, 588, 32, theme.text, 0.9);
  if (sim.sweep || p.mode === 'angle-sweep') label(ctx, theme, `${sim.angle.toFixed(1)}°`, 900, 680, 64, theme.accent);

  const guess = dir.said.find((x) => x.beat.id === 'guess');
  const revealAt = markAt(dir, 'reveal');
  if (p.guess && guess && t < revealAt) {
    const left = Math.min(revealAt - t, guess.at + guess.durationS + 6 - t);
    if (left > 0) drawCommentPrompt(ctx, theme, t - guess.at, left, PROMPT);
  }
  if (sim.revealed && p.mode !== 'angle-sweep') drawAnswer(ctx, theme, sim.answer, 540, AREA.y + AREA.h + 34, t - revealAt, sim.answer.length > 14 ? 60 : 78);
  if (p.captions) drawStoryCaption(ctx, theme, dir, timeOf(dir), { y: CAPTION_Y });
}
