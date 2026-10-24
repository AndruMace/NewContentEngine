import { FONT_FAMILY, type Ctx2D, type Theme } from '@sim/engine';
import { makeLayer } from '../math-curiosities/shared';
import { drawAnswer, drawCommentPrompt } from '../guess';
import { drawStoryCaption, markAt, timeOf, type Director } from '../story';
import { GRID, noteName, type Pattern } from './modes';
import { SANDS, type ChladniParams } from './params';
import { LETTERS, toneAt, type PlateSim } from './script';

/** Where the plate sits (square side / circle diameter); smaller when thumbnails share the screen. */
export function plateBox(p: ChladniParams) {
  return p.mode === 'guess-the-pattern' ? { cx: 540, cy: 1010, size: 700 } : { cx: 540, cy: 880, size: 880 };
}
const WAVE_Y = 1405;
const PROMPT = { x: 540, y: 1478 };
const CAPTION_Y = 1585;

export interface ChladniVis {
  layer: OffscreenCanvas | HTMLCanvasElement | null;
  counts: Uint16Array | null;
  image: ImageData | null;
  thumbs: (OffscreenCanvas | HTMLCanvasElement)[];
  lines: (OffscreenCanvas | HTMLCanvasElement | null)[];
  drive: number;
}

export const newVis = (): ChladniVis => ({ layer: null, counts: null, image: null, thumbs: [], lines: [], drive: 0 });

export interface DrawState {
  p: ChladniParams;
  sim: PlateSim;
  dir: Director<PlateSim>;
  vis: ChladniVis;
}

const MATERIALS = {
  steel: { a: '#30353d', b: '#121519', rim: '#5a626e', grain: 'rgba(255,255,255,0.025)' },
  brass: { a: '#8c6a2e', b: '#4a3414', rim: '#d1a85a', grain: 'rgba(255,230,170,0.05)' },
  aluminium: { a: '#8e959e', b: '#4d535b', rim: '#c9d0d8', grain: 'rgba(255,255,255,0.05)' },
  glass: { a: '#10212c', b: '#060d12', rim: '#5fb6d9', grain: 'rgba(120,220,255,0.03)' },
};

function platePath(ctx: Ctx2D, sim: PlateSim, box: { cx: number; cy: number; size: number }) {
  ctx.beginPath();
  if (sim.plate === 'circle') ctx.arc(box.cx, box.cy, box.size / 2, 0, Math.PI * 2);
  else ctx.roundRect(box.cx - box.size / 2, box.cy - box.size / 2, box.size, box.size, 14);
}

/** The still lines of a pattern as a picture (bright where it doesn't move). */
function nodalImage(pat: Pattern, px: number, colour: [number, number, number], width = 0.06) {
  const c = makeLayer(px, px);
  const g = c.getContext('2d') as Ctx2D;
  const img = g.createImageData(px, px);
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++) {
      const i = Math.floor((y / px) * GRID) * GRID + Math.floor((x / px) * GRID);
      const inside = pat.plate === 'square' || (x / px - 0.5) ** 2 + (y / px - 0.5) ** 2 < 0.25;
      if (!inside) continue;
      const a = Math.abs(pat.amp[i]);
      const k = Math.max(0, 1 - a / width);
      const o = (y * px + x) * 4;
      img.data[o] = colour[0];
      img.data[o + 1] = colour[1];
      img.data[o + 2] = colour[2];
      img.data[o + 3] = Math.round(255 * Math.min(1, k * 1.4));
    }
  g.putImageData(img, 0, 0);
  return c;
}

function drawPlate(ctx: Ctx2D, p: ChladniParams, sim: PlateSim, box: { cx: number; cy: number; size: number }, shake: number) {
  const m = MATERIALS[p.material];
  ctx.save();
  ctx.translate(shake, -shake * 0.6);
  // Shadow under the plate.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 18;
  platePath(ctx, sim, box);
  const g = ctx.createLinearGradient(box.cx - box.size / 2, box.cy - box.size / 2, box.cx + box.size / 2, box.cy + box.size / 2);
  g.addColorStop(0, m.a);
  g.addColorStop(1, m.b);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  // Brushed grain, clipped to the plate.
  ctx.save();
  platePath(ctx, sim, box);
  ctx.clip();
  ctx.strokeStyle = m.grain;
  ctx.lineWidth = 2;
  for (let k = 0; k < 70; k++) {
    const y = box.cy - box.size / 2 + (k / 70) * box.size;
    ctx.beginPath();
    ctx.moveTo(box.cx - box.size / 2, y);
    ctx.lineTo(box.cx + box.size / 2, y + ((k * 37) % 11) - 5);
    ctx.stroke();
  }
  const sheen = ctx.createLinearGradient(box.cx - box.size / 2, box.cy - box.size / 2, box.cx + box.size / 4, box.cy + box.size / 2);
  sheen.addColorStop(0, 'rgba(255,255,255,0.08)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(box.cx - box.size / 2, box.cy - box.size / 2, box.size, box.size);
  ctx.restore();
  platePath(ctx, sim, box);
  ctx.strokeStyle = m.rim;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();
}

/** The sand: every grain counted into a small image, coloured by how many sit in each pixel. */
function drawSand(ctx: Ctx2D, p: ChladniParams, sim: PlateSim, vis: ChladniVis, box: { cx: number; cy: number; size: number }, shake: number) {
  const res = Math.round(box.size / p.grainSize);
  if (!vis.layer || vis.layer.width !== res) {
    vis.layer = makeLayer(res, res);
    vis.counts = new Uint16Array(res * res);
    vis.image = (vis.layer.getContext('2d') as Ctx2D).createImageData(res, res);
  }
  const counts = vis.counts!;
  const img = vis.image!;
  counts.fill(0);
  for (let i = 0; i < sim.sx.length; i++) {
    const x = Math.floor(sim.sx[i] * res);
    const y = Math.floor(sim.sy[i] * res);
    if (x >= 0 && y >= 0 && x < res && y < res) counts[y * res + x]++;
  }
  const [r, g, b] = SANDS[p.sand].rgb;
  const d = img.data;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    const o = i * 4;
    if (!c) {
      d[o + 3] = 0;
      continue;
    }
    // Piles get brighter (more grains catch the light), single grains stay faint.
    const k = Math.min(1, 0.62 + c * 0.16);
    d[o] = Math.min(255, r * k + 30 * (c > 3 ? 1 : 0));
    d[o + 1] = Math.min(255, g * k + 30 * (c > 3 ? 1 : 0));
    d[o + 2] = Math.min(255, b * k + 20 * (c > 3 ? 1 : 0));
    d[o + 3] = Math.min(255, 170 + c * 40);
  }
  (vis.layer.getContext('2d') as Ctx2D).putImageData(img, 0, 0);
  ctx.save();
  ctx.translate(shake, -shake * 0.6);
  platePath(ctx, sim, box);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(vis.layer as CanvasImageSource, box.cx - box.size / 2, box.cy - box.size / 2, box.size, box.size);
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

/**
 * A violin bow seen from above, drawn across the plate's edge at `at` (plate units), sawing back
 * and forth along its length.
 */
function drawBow(ctx: Ctx2D, box: { cx: number; cy: number; size: number }, plate: 'square' | 'circle', at: { x: number; y: number }, t: number, drive: number) {
  const half = box.size / 2;
  // Point on the edge, and the outward direction there.
  let px: number;
  let py: number;
  let ox: number;
  let oy: number;
  if (plate === 'circle') {
    const ang = Math.atan2(at.y - 0.5, at.x - 0.5);
    ox = Math.cos(ang);
    oy = Math.sin(ang);
    px = box.cx + ox * half;
    py = box.cy + oy * half;
  } else {
    px = box.cx - half + at.x * box.size;
    py = box.cy - half + at.y * box.size;
    // Out through whichever edge it's on.
    const onSide = at.x <= 0.001 || at.x >= 0.999;
    ox = onSide ? (at.x < 0.5 ? -1 : 1) : 0;
    oy = onSide ? 0 : at.y < 0.5 ? -1 : 1;
  }
  // The bow lies across the edge, tilted a little, and saws along itself.
  const ax = -oy * 0.94 + ox * 0.34;
  const ay = ox * 0.94 + oy * 0.34;
  const saw = Math.sin(t * 5) * 60 * drive;
  const len = 300;
  const x0 = px + ax * (-len / 2 + saw) + ox * 6;
  const y0 = py + ay * (-len / 2 + saw) + oy * 6;
  const x1 = px + ax * (len / 2 + saw) + ox * 6;
  const y1 = py + ay * (len / 2 + saw) + oy * 6;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#5a2e16';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(x0 + ox * 10, y0 + oy * 10);
  ctx.lineTo(x1 + ox * 10, y1 + oy * 10);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(245,240,225,0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  // The frog at one end.
  ctx.fillStyle = '#1b1410';
  ctx.fillRect(x1 + ox * 2 - 9, y1 + oy * 2 - 9, 18, 18);
  ctx.restore();
}

export function renderChladni(ctx: Ctx2D, theme: Theme, s: DrawState, t: number) {
  const { p, sim, vis } = s;
  const bg = ctx.createRadialGradient(540, 900, 100, 540, 900, 1300);
  bg.addColorStop(0, '#1b1f27');
  bg.addColorStop(1, '#06070a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1080, 1920);
  const box = plateBox(p);
  const tone = toneAt(sim.keys, sim.tick);
  vis.drive += ((tone.on ? 1 : 0) - vis.drive) * 0.12;
  // A buzz you can see: a pixel of shake while the plate sings.
  const shake = vis.drive * 1.2 * Math.sin(t * 97);
  drawPlate(ctx, p, sim, box, shake);
  drawSand(ctx, p, sim, vis, box, shake);
  // The post under the centre (the speaker's, which holds the plate), pulsing while the speaker plays.
  ctx.fillStyle = '#9aa3ad';
  ctx.beginPath();
  ctx.arc(box.cx + shake, box.cy - shake * 0.6, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3b4149';
  ctx.beginPath();
  ctx.arc(box.cx + shake, box.cy - shake * 0.6, 5, 0, Math.PI * 2);
  ctx.fill();
  if (tone.on && !tone.bow) {
    ctx.save();
    ctx.strokeStyle = theme.accent;
    for (let k = 0; k < 2; k++) {
      const u = (t * 1.6 + k / 2) % 1;
      ctx.globalAlpha = (1 - u) * 0.6 * vis.drive;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(box.cx, box.cy, 16 + u * 50, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  // The bow, drawn across the edge where the figure is bowed.
  const idx = currentMode(sim);
  const bowAt = idx >= 0 ? sim.modes[idx].bow : null;
  if (tone.on && tone.bow && bowAt) drawBow(ctx, box, sim.plate, bowAt, t, vis.drive);
  if (p.nodalHint && t >= markAt(s.dir, 'reveal') + 2) {
    if (idx >= 0 && sim.patterns[idx]) {
      vis.lines[idx] ??= nodalImage(sim.patterns[idx]!, 400, [120, 230, 255], 0.03);
      ctx.save();
      ctx.globalAlpha = Math.min(0.7, (t - markAt(s.dir, 'reveal') - 2) * 0.7);
      ctx.drawImage(vis.lines[idx] as CanvasImageSource, box.cx - box.size / 2, box.cy - box.size / 2, box.size, box.size);
      ctx.restore();
    }
  }
}

/** The mode the sand is settling on now (the plate's mode nearest the tone). */
export function currentMode(sim: PlateSim): number {
  const tone = toneAt(sim.keys, sim.tick);
  let best = -1;
  let bestD = Infinity;
  sim.modes.forEach((m, i) => {
    if (m.plate !== sim.plate) return;
    const d = Math.abs(Math.log(m.hz / tone.hz));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

export function renderChladniTop(ctx: Ctx2D, theme: Theme, s: DrawState, t: number) {
  const { p, sim, dir, vis } = s;
  const tone = toneAt(sim.keys, sim.tick);
  const box = plateBox(p);
  // The readout appears with the first note (before it there is nothing to read).
  const firstNote = sim.keys.find((k) => k.on)?.tick ?? Infinity;
  if (p.showHz && p.mode !== 'guess-the-pattern' && sim.tick >= firstNote) {
    const a = 0.35 + 0.65 * vis.drive;
    label(ctx, theme, `${Math.round(tone.hz)} Hz`, 540, 355, 64, tone.on ? theme.accent : theme.text, a);
    label(ctx, theme, `${noteName(tone.hz)} · ${tone.bow ? 'BOWED' : 'SPEAKER'}`, 540, 410, 30, 'rgba(255,255,255,0.75)', a, 800);
  }
  if (p.mode === 'guess-the-pattern' && sim.options.length) {
    const ids = sim.options[Math.min(sim.round, sim.options.length - 1)];
    const size = Math.min(200, 860 / ids.length - 30);
    const total = ids.length * size + (ids.length - 1) * 30;
    ids.forEach((id, k) => {
      const x = 540 - total / 2 + k * (size + 30);
      const y = 380;
      const pat = sim.patterns[id];
      if (pat && !vis.thumbs[id]) vis.thumbs[id] = nodalImage(pat, 180, [240, 226, 190]);
      const done = sim.revealed[sim.round];
      const right = k === sim.answers[sim.round];
      ctx.save();
      ctx.globalAlpha = done && !right ? 0.3 : 1;
      ctx.fillStyle = '#15181d';
      ctx.beginPath();
      if (sim.plate === 'circle') ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
      else ctx.roundRect(x, y, size, size, 12);
      ctx.fill();
      if (vis.thumbs[id]) ctx.drawImage(vis.thumbs[id] as CanvasImageSource, x, y, size, size);
      ctx.strokeStyle = done && right ? theme.accent : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = done && right ? 8 : 3;
      ctx.stroke();
      ctx.restore();
      label(ctx, theme, LETTERS[k], x + size / 2, y + size + 34, 44, done && right ? theme.accent : theme.text, done && !right ? 0.4 : 1);
    });
    if (p.showHz && tone.on) label(ctx, theme, `${Math.round(tone.hz)} Hz`, 540, 322, 40, theme.accent, vis.drive);
  }
  // The real plate it is (its frequencies are this plate's).
  ctx.save();
  ctx.font = `800 24px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(sim.labels[sim.plate].toUpperCase(), 540, box.cy + box.size / 2 + 24);
  ctx.restore();
  // The tone as a wave under the plate: more cycles for higher notes, flat in silence.
  ctx.save();
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = 0.25 + 0.6 * vis.drive;
  ctx.lineWidth = 4;
  ctx.beginPath();
  const cycles = Math.min(40, tone.hz / 40);
  for (let x = 0; x <= 760; x += 4) {
    const y = WAVE_Y + Math.sin((x / 760) * cycles * Math.PI * 2 - t * 8) * 22 * vis.drive * Math.sin((x / 760) * Math.PI);
    if (x === 0) ctx.moveTo(160 + x, y);
    else ctx.lineTo(160 + x, y);
  }
  ctx.stroke();
  ctx.restore();

  const guess = dir.said.find((x) => x.beat.id === 'guess');
  const revealAt = markAt(dir, 'reveal');
  if (p.guess && guess && t < revealAt) {
    const left = Math.min(revealAt - t, guess.at + guess.durationS + 6 - t);
    if (left > 0) drawCommentPrompt(ctx, theme, t - guess.at, left, PROMPT);
  }
  if (p.mode === 'plate-shapes' && t >= revealAt) drawAnswer(ctx, theme, sim.answer, 540, 470, t - revealAt, 76);
  if (p.captions) drawStoryCaption(ctx, theme, dir, timeOf(dir), { y: CAPTION_Y });
}
