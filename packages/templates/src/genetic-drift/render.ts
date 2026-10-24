import { FONT_FAMILY, hexToRgb, mixRgb, rgbToCss, type Ctx2D, type Theme } from '@sim/engine';
import { makeLayer } from '../math-curiosities/shared';
import { drawAnswer, drawCommentPrompt } from '../guess';
import { drawStoryCaption, markAt, sinceTick, timeOf, type Director } from '../story';
import type { DriftParams } from './params';
import type { DriftSim } from './script';
import type { History } from './sim';

/** Where everything sits (1080×1920). */
export const VIEW = { x: 70, y: 400, w: 940, h: 620 };
const CHART = { x: 100, y: 1110, w: 880, h: 210 };
const PROMPT = { x: 540, y: 1392 };
const CAPTION_Y = 1530;
/** Family trees for populations up to this size (auto view). */
export const LINEAGE_MAX = 48;

/** Picture-only state: smoothed row height, the flashes of colours lost. */
export interface DriftVis {
  rowH: number;
  lastG: number;
  flashes: { text: string; color: string; at: number }[];
  wonAt: number;
}

export const newVis = (): DriftVis => ({ rowH: 64, lastG: 0, flashes: [], wonAt: Infinity });

type Skin = DriftParams['skin'];

const sprites = new Map<string, OffscreenCanvas | HTMLCanvasElement>();

/** An individual, drawn once per look, colour and size and then reused. */
function sprite(skin: Skin, hex: string, px: number) {
  const size = Math.max(6, Math.round(px));
  const key = `${skin}|${hex}|${size}`;
  let c = sprites.get(key);
  if (c) return c;
  const pad = 4;
  c = makeLayer(size + pad * 2, size + pad * 2);
  const g = c.getContext('2d') as Ctx2D;
  g.translate(size / 2 + pad, size / 2 + pad);
  drawCritter(g, skin, hex, size / 2);
  sprites.set(key, c);
  return c;
}

function drawCritter(g: Ctx2D, skin: Skin, hex: string, r: number) {
  const rgb = hexToRgb(hex);
  const dark = rgbToCss(mixRgb(rgb, [10, 10, 20], 0.55));
  const light = rgbToCss(mixRgb(rgb, [255, 255, 255], 0.45));
  g.lineJoin = 'round';
  g.lineCap = 'round';
  switch (skin) {
    case 'cells': {
      const gr = g.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
      gr.addColorStop(0, light);
      gr.addColorStop(1, hex);
      g.fillStyle = gr;
      g.beginPath();
      g.arc(0, 0, r * 0.92, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = dark;
      g.lineWidth = Math.max(1, r * 0.12);
      g.stroke();
      g.fillStyle = dark;
      g.beginPath();
      g.arc(r * 0.15, r * 0.1, r * 0.28, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'marbles': {
      const gr = g.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.05, 0, 0, r);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(0.25, light);
      gr.addColorStop(1, dark);
      g.fillStyle = gr;
      g.beginPath();
      g.arc(0, 0, r * 0.95, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'beetles': {
      g.strokeStyle = dark;
      g.lineWidth = Math.max(1, r * 0.12);
      for (const side of [-1, 1])
        for (const k of [-0.4, 0.1, 0.55]) {
          g.beginPath();
          g.moveTo(side * r * 0.3, k * r);
          g.lineTo(side * r * 0.85, k * r + r * 0.18);
          g.stroke();
        }
      g.fillStyle = dark;
      g.beginPath();
      g.arc(0, -r * 0.62, r * 0.28, 0, Math.PI * 2);
      g.fill();
      const gr = g.createLinearGradient(-r, 0, r, 0);
      gr.addColorStop(0, hex);
      gr.addColorStop(0.45, light);
      gr.addColorStop(1, hex);
      g.fillStyle = gr;
      g.beginPath();
      g.ellipse(0, r * 0.12, r * 0.55, r * 0.72, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = dark;
      g.lineWidth = Math.max(1, r * 0.08);
      g.beginPath();
      g.moveTo(0, -r * 0.55);
      g.lineTo(0, r * 0.82);
      g.stroke();
      break;
    }
    case 'flowers': {
      g.fillStyle = hex;
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
        g.beginPath();
        g.ellipse(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, r * 0.42, r * 0.3, a, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = light;
      g.beginPath();
      g.arc(0, 0, r * 0.3, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = dark;
      g.beginPath();
      g.arc(0, 0, r * 0.14, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'fish': {
      g.fillStyle = dark;
      g.beginPath();
      g.moveTo(r * 0.45, 0);
      g.lineTo(r * 0.98, -r * 0.45);
      g.lineTo(r * 0.98, r * 0.45);
      g.closePath();
      g.fill();
      const gr = g.createLinearGradient(0, -r, 0, r);
      gr.addColorStop(0, light);
      gr.addColorStop(1, hex);
      g.fillStyle = gr;
      g.beginPath();
      g.ellipse(-r * 0.1, 0, r * 0.68, r * 0.44, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(-r * 0.45, -r * 0.08, r * 0.14, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#111';
      g.beginPath();
      g.arc(-r * 0.47, -r * 0.08, r * 0.07, 0, Math.PI * 2);
      g.fill();
      break;
    }
  }
}

function drawSprite(ctx: Ctx2D, skin: Skin, hex: string, x: number, y: number, px: number, scale = 1) {
  if (px < 9) {
    ctx.fillStyle = hex;
    ctx.beginPath();
    ctx.arc(x, y, (px / 2) * scale, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const img = sprite(skin, hex, px);
  const w = img.width * scale;
  ctx.drawImage(img as CanvasImageSource, x - w / 2, y - w / 2, w, w);
}

/** Is a population drawn as a family tree (rows of generations) or a grid? */
export function lineageFor(p: DriftParams, n: number, limit = LINEAGE_MAX) {
  return p.view === 'lineage' || (p.view === 'auto' && n <= limit);
}

/** A population as a family tree: generations as rows from the top, lines to each parent; scrolls once full. */
function drawLineage(ctx: Ctx2D, h: History, g: number, box: typeof VIEW, colours: string[], skin: Skin, vis: DriftVis, u: number, linesTo: number) {
  // Rows shrink as the generations speed up, but never so far that the tree leaves the panel half empty.
  const rowH = Math.max(vis.rowH, Math.min(64, (box.h - 12) / (g + 1)));
  const x = (i: number, m: number) => box.x + ((i + 0.5) * box.w) / m;
  // The newest row slides in; the rows scroll up once they reach the bottom.
  const c = g - 1 + u;
  const scroll = Math.max(0, (c + 1) * rowH + rowH * 0.6 - box.h);
  const yOf = (row: number) => box.y + rowH * 0.6 + row * rowH - scroll;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x - 20, box.y, box.w + 40, box.h);
  ctx.clip();
  const from = Math.max(0, Math.floor(scroll / rowH) - 1);
  if (rowH < 13) {
    // Fast: each generation is a band of colour (the rows stay in colour order).
    for (let row = from; row <= g; row++) {
      const counts = h.counts[row];
      const m = h.rows[row].length;
      const y = yOf(row);
      ctx.globalAlpha = row === g ? Math.min(1, u * 1.5) : 1;
      let x0 = box.x + (box.w * (1 - m / Math.max(m, h.rows[0].length))) / 2;
      const span = (box.w * m) / Math.max(m, h.rows[0].length);
      for (let k = 0; k < counts.length; k++) {
        if (!counts[k]) continue;
        const w = (counts[k] / m) * span;
        ctx.fillStyle = colours[k];
        ctx.fillRect(x0, y - rowH / 2, w + 0.6, rowH + 0.6);
        x0 += w;
      }
    }
    ctx.globalAlpha = 1;
  } else {
    // Lines first, then the individuals over them.
    ctx.lineWidth = Math.max(2, Math.min(5, rowH / 12));
    ctx.lineCap = 'round';
    for (let row = Math.max(1, from); row <= g; row++) {
      const par = h.parents[row];
      if (!par || row > linesTo) continue;
      const m = h.rows[row].length;
      const pm = h.rows[row - 1].length;
      const y1 = yOf(row);
      const y0 = yOf(row - 1);
      const grow = row === g ? Math.min(1, u * 1.3) : 1;
      ctx.globalAlpha = 0.7;
      for (let i = 0; i < m; i++) {
        const xa = x(par[i], pm);
        const xb = x(i, m);
        ctx.strokeStyle = colours[h.rows[row][i]];
        ctx.beginPath();
        ctx.moveTo(xa, y0);
        // Drawn down from the parent as the row arrives.
        const ex = xa + (xb - xa) * grow;
        const ey = y0 + (y1 - y0) * grow;
        ctx.bezierCurveTo(xa, y0 + rowH * 0.5 * grow, ex, ey - rowH * 0.5 * grow, ex, ey);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    for (let row = from; row <= g; row++) {
      const r = h.rows[row];
      const m = r.length;
      const px = Math.min(52, Math.min(box.w / m, rowH) * 0.8);
      const y = yOf(row);
      const pop = row === g ? Math.max(0, Math.min(1, (u - 0.35) * 2.2)) : 1;
      if (pop <= 0) continue;
      for (let i = 0; i < m; i++) drawSprite(ctx, skin, colours[r[i]], x(i, m), y, px, pop < 1 ? 0.6 + 0.4 * pop + 0.15 * Math.sin(Math.PI * pop) : 1);
    }
  }
  ctx.restore();
}

/** A population as a grid, sorted by colour; empty places for the ones a crash took. */
function drawGrid(ctx: Ctx2D, h: History, g: number, box: typeof VIEW, colours: string[], skin: Skin, u: number, slow: boolean) {
  const n = Math.max(...h.rows.slice(0, Math.min(h.rows.length, 40)).map((r) => r.length));
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * box.w) / box.h)));
  const rows = Math.ceil(n / cols);
  const cell = Math.min(box.w / cols, box.h / rows);
  const ox = box.x + (box.w - cols * cell) / 2;
  const oy = box.y + (box.h - rows * cell) / 2;
  const cur = h.rows[g];
  const prev = g > 0 ? h.rows[g - 1] : cur;
  for (let i = 0; i < n; i++) {
    const cx = ox + (i % cols) * cell + cell / 2;
    const cy = oy + Math.floor(i / cols) * cell + cell / 2;
    if (i >= cur.length) {
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    const was = i < prev.length ? prev[i] : cur[i];
    const changed = was !== cur[i] || i >= prev.length;
    const scale = changed && slow ? 1 + 0.3 * Math.sin(Math.PI * u) : 1;
    drawSprite(ctx, skin, colours[cur[i]], cx, cy, cell * 0.84, scale);
    if (changed && u < 1) {
      // Cross-fade from the old colour.
      ctx.globalAlpha = 1 - u;
      drawSprite(ctx, skin, colours[was], cx, cy, cell * 0.84, scale);
      ctx.globalAlpha = 1;
    }
  }
}

/** Each colour's share over the generations so far. */
function drawChart(ctx: Ctx2D, theme: Theme, pops: { h: History; g: number; alpha: number; width: number; dash: number[] }[], colours: string[]) {
  const b = CHART;
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.beginPath();
  ctx.roundRect(b.x - 24, b.y - 30, b.w + 48, b.h + 64, 22);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  for (const f of [0, 0.5, 1]) {
    ctx.beginPath();
    ctx.moveTo(b.x, b.y + b.h * (1 - f));
    ctx.lineTo(b.x + b.w, b.y + b.h * (1 - f));
    ctx.stroke();
  }
  const gMax = Math.max(40, ...pops.map((p) => p.g));
  ctx.font = `800 24px ${FONT_FAMILY}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('SHARE', b.x - 6, b.y - 12);
  ctx.textAlign = 'right';
  ctx.fillText(`GENERATION ${pops[0].g.toLocaleString('en-US')}`, b.x + b.w + 6, b.y + b.h + 18);
  for (const pop of pops) {
    const step = Math.max(1, Math.ceil(pop.g / 500));
    ctx.globalAlpha = pop.alpha;
    ctx.lineWidth = pop.width;
    ctx.setLineDash(pop.dash);
    ctx.lineJoin = 'round';
    for (let c = 0; c < pop.h.k; c++) {
      ctx.strokeStyle = colours[c];
      ctx.beginPath();
      let dead = -1;
      for (let gg = 0; gg <= pop.g; gg += gg + step > pop.g && gg !== pop.g ? pop.g - gg : step) {
        const share = pop.h.counts[gg][c] / pop.h.rows[gg].length;
        const x = b.x + (gg / gMax) * b.w;
        const y = b.y + b.h * (1 - share);
        if (gg === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        if (share === 0) {
          dead = gg;
          break;
        }
        if (gg === pop.g) break;
      }
      ctx.stroke();
      if (dead > 0) {
        const x = b.x + (dead / gMax) * b.w;
        ctx.setLineDash([]);
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x - 9, b.y + b.h - 9);
        ctx.lineTo(x + 9, b.y + b.h + 9);
        ctx.moveTo(x + 9, b.y + b.h - 9);
        ctx.lineTo(x - 9, b.y + b.h + 9);
        ctx.stroke();
        ctx.lineWidth = pop.width;
        ctx.setLineDash(pop.dash);
      }
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  void theme;
}

function label(ctx: Ctx2D, theme: Theme, text: string, x: number, y: number, size: number, fill = theme.text, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `900 ${size}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(5, size / 7);
  ctx.strokeStyle = theme.textStroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

export interface DrawState {
  p: DriftParams;
  sim: DriftSim;
  dir: Director<DriftSim>;
  vis: DriftVis;
}

/** Note colours that vanish (and the takeover) as the generations go by, for their flashes. */
function track(s: DrawState, t: number) {
  const { sim, vis } = s;
  if (sim.g < vis.lastG) vis.lastG = sim.g;
  for (let g = vis.lastG + 1; g <= sim.g; g++) {
    const c0 = sim.hist.counts[g - 1];
    const c1 = sim.hist.counts[g];
    if (!c0 || !c1) break;
    const trialStart = sim.starts.includes(g);
    if (trialStart) continue;
    for (let c = 0; c < c1.length; c++) if (c0[c] > 0 && c1[c] === 0) vis.flashes.push({ text: `${sim.colours[c].name.toUpperCase()} IS GONE`, color: sim.colours[c].hex, at: t });
  }
  vis.lastG = sim.g;
  if (sim.revealed && vis.wonAt === Infinity) vis.wonAt = t;
}

export function renderDrift(ctx: Ctx2D, theme: Theme, s: DrawState, t: number) {
  const { p, sim, dir, vis } = s;
  track(s, t);
  const hexes = sim.colours.map((c) => c.hex);
  const u = sinceTick(dir, 0.55);
  const secPerTick = dir.tickGap ? dir.tickGap / dir.stepsPerS : 1;
  const slow = secPerTick > 0.15;
  vis.rowH += (Math.max(5, Math.min(64, secPerTick * 220)) - vis.rowH) * 0.08;
  const g = Math.min(sim.g, sim.hist.rows.length - 1);
  const linesTo = vis.rowH >= 13 ? Infinity : sim.showLinesTo;

  // The population(s).
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(VIEW.x - 24, VIEW.y - 24, VIEW.w + 48, VIEW.h + 48, 28);
  ctx.fill();
  ctx.stroke();
  if (sim.big) {
    const left = { x: VIEW.x, y: VIEW.y + 40, w: VIEW.w / 2 - 30, h: VIEW.h - 40 };
    const right = { x: VIEW.x + VIEW.w / 2 + 30, y: VIEW.y + 40, w: VIEW.w / 2 - 30, h: VIEW.h - 40 };
    const gs = Math.min(sim.g, sim.hist.rows.length - 1);
    const gb = Math.min(sim.g, sim.big.rows.length - 1);
    if (lineageFor(p, sim.hist.rows[0].length, 24)) drawLineage(ctx, sim.hist, gs, left, hexes, p.skin, vis, u, linesTo);
    else drawGrid(ctx, sim.hist, gs, left, hexes, p.skin, gs === sim.g ? u : 1, slow);
    drawGrid(ctx, sim.big, gb, right, hexes, p.skin, gb === sim.g ? u : 1, slow);
    label(ctx, theme, `${sim.hist.rows[0].length} ${p.skin.toUpperCase()}`, left.x + left.w / 2, VIEW.y + 8, 32, theme.text, 0.85);
    label(ctx, theme, `${sim.big.rows[0].length} ${p.skin.toUpperCase()}`, right.x + right.w / 2, VIEW.y + 8, 32, theme.text, 0.85);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(VIEW.x + VIEW.w / 2 - 1, VIEW.y, 2, VIEW.h);
  } else if (lineageFor(p, sim.hist.rows[0].length)) drawLineage(ctx, sim.hist, g, VIEW, hexes, p.skin, vis, u, linesTo);
  else drawGrid(ctx, sim.hist, g, VIEW, hexes, p.skin, u, slow);

  // Colours lost, and the takeover.
  vis.flashes = vis.flashes.filter((f) => t - f.at < 1.6);
  vis.flashes.forEach((f, k) => {
    const since = t - f.at;
    const a = Math.min(1, since / 0.12, (1.6 - since) / 0.4);
    label(ctx, theme, f.text, 540, VIEW.y + VIEW.h * 0.42 + k * 64 - since * 30, 56, f.color, a);
  });

  if (p.chart) {
    const pops = [{ h: sim.hist, g, alpha: 1, width: 5, dash: [] as number[] }];
    if (sim.big) {
      pops[0] = { h: sim.hist, g: Math.min(sim.g, sim.hist.rows.length - 1), alpha: 0.75, width: 3, dash: [10, 8] };
      pops.unshift({ h: sim.big, g: Math.min(sim.g, sim.big.rows.length - 1), alpha: 1, width: 5, dash: [] });
    }
    drawChart(ctx, theme, pops, hexes);
  }
}

/** Crisp layer: the generation counter, the guess prompt, the answer, the caption. */
export function renderDriftTop(ctx: Ctx2D, theme: Theme, s: DrawState, t: number) {
  const { p, sim, dir, vis } = s;
  const trial = sim.starts.length > 1 || p.mode === 'lucky-mutant' ? lastIndexAtMost(sim.starts, sim.g) : -1;
  const gen = trial >= 0 ? sim.g - sim.starts[trial] : sim.g;
  const text = trial >= 0 ? `TRY ${trial + 1}  ·  GENERATION ${gen.toLocaleString('en-US')}` : `GENERATION ${gen.toLocaleString('en-US')}`;
  label(ctx, theme, text, 540, VIEW.y - 52, 38, theme.text, Math.min(1, t / 0.6));

  const guess = dir.said.find((x) => x.beat.id === 'guess');
  const revealAt = markAt(dir, 'reveal');
  if (p.guess && guess && t < revealAt) {
    const since = t - guess.at;
    const left = Math.min(revealAt - t, guess.at + guess.durationS + 6 - t);
    if (left > 0) drawCommentPrompt(ctx, theme, since, left, PROMPT);
  }
  if (sim.revealed) {
    const since = t - vis.wonAt;
    const k = Math.min(1, since / 0.5);
    ctx.save();
    ctx.globalAlpha = 0.5 * k;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 10 * (1 - k) + 2;
    ctx.beginPath();
    ctx.arc(540, VIEW.y + VIEW.h / 2, 120 + since * 500, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    drawAnswer(ctx, theme, sim.answer, 540, VIEW.y + VIEW.h / 2, since, sim.answer.length > 12 ? 74 : 92);
  }
  if (p.captions) drawStoryCaption(ctx, theme, dir, timeOf(dir), { y: CAPTION_Y });
}

function lastIndexAtMost(xs: number[], v: number) {
  let k = 0;
  for (let i = 0; i < xs.length; i++) if (xs[i] <= v) k = i;
  return k;
}
