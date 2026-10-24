import { FONT_FAMILY, hexToRgb, mixRgb, rgbToCss, type Ctx2D, type Theme } from '@sim/engine';
import { drawAnswer, drawCommentPrompt } from '../guess';
import { drawStoryCaption, markAt, sinceTick, timeOf, type Director } from '../story';
import { WORLD, nearest, neighbourIndex, order, type Predator } from './sim';
import type { FlockParams } from './params';
import type { FlockSim } from './script';

// The whole sky fits between the rule chips and the skyline.
const SKY = { cx: 540, cy: 978, unit: 4.4 };
const PROMPT = { x: 540, y: 1540 };
const CAPTION_Y = 1640;

const SETTINGS = {
  dusk: { sky: ['#241a45', '#6b3a6a', '#e0703a', '#f6b35d'], bird: '#170d1c', ground: '#0e0a12', glow: '#ffcf7a' },
  sunrise: { sky: ['#30508c', '#8a7ab8', '#f0a0b8', '#ffd9a0'], bird: '#22162c', ground: '#16121c', glow: '#fff0c0' },
  overcast: { sky: ['#4f5963', '#6c7680', '#98a1aa', '#b8c0c6'], bird: '#1d2126', ground: '#22272c', glow: '#e6ecf0' },
  neon: { sky: ['#03010b', '#0b0420', '#170a33', '#26104a'], bird: '#7af5ff', ground: '#05020e', glow: '#ff2a6d' },
  ocean: { sky: ['#0d5578', '#0a3a5a', '#05263c', '#021623'], bird: '#d4ecff', ground: '#01101a', glow: '#9fe6ff' },
} as const;

export interface DrawState {
  p: FlockParams;
  sim: FlockSim;
  dir: Director<FlockSim>;
  /** Picture only: how recently each bird turned hard (fades), so a passing turn reads as a wave. */
  alarm: Float32Array | null;
}

const settingOf = (s: DrawState) => SETTINGS[s.sim.fish ? 'ocean' : s.p.setting === 'ocean' ? 'dusk' : s.p.setting];

/** World to screen: a gentle perspective (nearer is bigger) and a slow camera drift. */
function projector(s: DrawState, t: number) {
  const drift = s.p.drift;
  const dx = Math.sin(t * 0.11) * 45 * drift;
  const dy = Math.cos(t * 0.07) * 25 * drift;
  const zoom = 1 + Math.sin(t * 0.05) * 0.05 * drift;
  const F = 240;
  return (x: number, y: number, z: number) => {
    const k = (F / (F + (z - WORLD.d / 2) * 0.9)) * zoom;
    return { x: SKY.cx + dx + (x - WORLD.w / 2) * SKY.unit * k, y: SKY.cy + dy + (y - WORLD.h / 2) * SKY.unit * k, k };
  };
}

function hash(k: number) {
  let h = Math.imul(k + 11, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 12)) >>> 0) / 4294967296;
}

function background(ctx: Ctx2D, s: DrawState, t: number) {
  const set = settingOf(s);
  const g = ctx.createLinearGradient(0, 0, 0, 1920);
  set.sky.forEach((c, k) => g.addColorStop(k / (set.sky.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1080, 1920);
  if (s.sim.fish) {
    // Light from the surface.
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = '#ffffff';
    for (let k = 0; k < 6; k++) {
      const x = 120 + k * 170 + Math.sin(t * 0.3 + k) * 30;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 70, 0);
      ctx.lineTo(x - 60, 1500);
      ctx.lineTo(x - 140, 1500);
      ctx.fill();
    }
    ctx.restore();
  } else {
    const sun = ctx.createRadialGradient(700, 1460, 10, 700, 1460, 520);
    sun.addColorStop(0, `${set.glow}aa`);
    sun.addColorStop(1, `${set.glow}00`);
    ctx.fillStyle = sun;
    ctx.fillRect(0, 900, 1080, 1020);
  }
  // The ground: trees and rooftops, or a seabed with weed.
  ctx.fillStyle = set.ground;
  ctx.beginPath();
  ctx.moveTo(0, 1920);
  const base = 1505;
  for (let x = 0; x <= 1080; x += 12) {
    const k = x / 12;
    const h = s.sim.fish ? 30 + hash(k) * 50 + Math.sin(x * 0.01) * 20 : 40 + Math.sin(x * 0.006) * 30 + (hash(Math.floor(x / 36)) > 0.7 ? 60 + hash(k) * 40 : hash(k) * 25);
    ctx.lineTo(x, base + 120 - h);
  }
  ctx.lineTo(1080, 1920);
  ctx.fill();
  if (s.sim.fish) {
    ctx.strokeStyle = set.ground;
    ctx.lineWidth = 7;
    for (let k = 0; k < 14; k++) {
      const x = 40 + hash(k + 99) * 1000;
      ctx.beginPath();
      ctx.moveTo(x, 1600);
      for (let q = 1; q <= 8; q++) ctx.lineTo(x + Math.sin(t * 0.8 + q * 0.7 + k) * 10, 1600 - q * 22);
      ctx.stroke();
    }
  }
}

export function renderFlock(ctx: Ctx2D, theme: Theme, s: DrawState, t: number) {
  background(ctx, s, t);
  const { sim, p } = s;
  const f = sim.flock;
  const set = settingOf(s);
  const proj = projector(s, t);
  const u = sinceTick(s.dir, 0.1);
  const n = f.o.n;
  const bird = hexToRgb(set.bird);
  const hot = hexToRgb(theme.accent);
  const ripple = p.mode === 'seven-neighbours' && sim.startled >= 0;
  if (ripple) {
    if (!s.alarm || s.alarm.length !== n) s.alarm = new Float32Array(n);
    for (let i = 0; i < n; i++) s.alarm[i] = Math.max(s.alarm[i] * 0.94, Math.min(1, f.turn[i] * 2500));
  }
  // Far birds first; three depth bands, each one path.
  const bands = 3;
  for (let b = 0; b < bands; b++) {
    const z0 = (WORLD.d * (bands - 1 - b)) / bands;
    const z1 = z0 + WORLD.d / bands;
    const alpha = p.setting === 'neon' && !sim.fish ? 0.55 + 0.15 * b : 0.6 + 0.2 * b;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = set.bird;
    ctx.beginPath();
    const hotOnes: number[] = [];
    const scared: number[] = [];
    for (let i = 0; i < n; i++) {
      const z = f.pz[i] + (f.z[i] - f.pz[i]) * u;
      if (z < z0 || z >= z1) continue;
      if (ripple && s.alarm![i] > 0.08) {
        hotOnes.push(i);
        continue;
      }
      if (f.fear[i] > 0.12) {
        scared.push(i);
        continue;
      }
      birdPath(ctx, f, i, u, proj, t, sim.fish, 0);
    }
    ctx.fill();
    if (scared.length) {
      // Panicking birds bank hard, showing their wings (fish flash their flanks): a dark band (a
      // bright one, for light birds) that sweeps across the flock as the panic spreads.
      const light = sim.fish || (p.setting === 'neon' && !sim.fish);
      ctx.globalAlpha = 1;
      for (let band = 0; band < 3; band++) {
        const level = (band + 1) / 3;
        ctx.fillStyle = light ? rgbToCss(mixRgb(bird, [255, 255, 255], 0.65 * level)) : rgbToCss(mixRgb(bird, [0, 0, 0], 0.5 * level));
        ctx.beginPath();
        for (const i of scared) {
          if (Math.min(2, Math.floor(f.fear[i] * 3)) === band) birdPath(ctx, f, i, u, proj, t, sim.fish, f.fear[i]);
        }
        ctx.fill();
      }
      ctx.globalAlpha = alpha;
    }
    if (hotOnes.length) {
      // Birds mid-turn light up: the wave of a turn passing through.
      for (const i of hotOnes) {
        const k = s.alarm![i];
        ctx.fillStyle = rgbToCss(mixRgb(bird, hot, k));
        ctx.beginPath();
        birdPath(ctx, f, i, u, proj, t, sim.fish, 0);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;
  // The bird we follow, and the neighbours it watches.
  if (sim.focus >= 0 && p.mode === 'seven-neighbours') {
    const i = sim.focus;
    const a = proj(f.x[i], f.y[i], f.z[i]);
    const k = nearest(f, i, p.neighbours || 7);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.85;
    for (let q = 0; q < k; q++) {
      const j = neighbourIndex(q);
      const b = proj(f.x[j], f.y[j], f.z[j]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(b.x, b.y, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 11, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const pr of f.predators) {
    const a = proj(pr.x, pr.y, pr.z);
    drawPredator(ctx, a.x, a.y, a.k, Math.atan2(pr.vy, pr.vx), sim.fish, pr.mode, t);
  }
}

/** A bird (or fish), banked by `bank` (0..1): wider wings, a longer body. */
function birdPath(ctx: Ctx2D, f: FlockSim['flock'], i: number, u: number, proj: ReturnType<typeof projector>, t: number, fish: boolean, bank: number) {
  const x = f.px[i] + (f.x[i] - f.px[i]) * u;
  const y = f.py[i] + (f.y[i] - f.py[i]) * u;
  const z = f.pz[i] + (f.z[i] - f.pz[i]) * u;
  const a = proj(x, y, z);
  const vx = f.vx[i];
  const vy = f.vy[i];
  const l = Math.sqrt(vx * vx + vy * vy) || 1;
  const dx = vx / l;
  const dy = vy / l;
  const L = (fish ? 8.5 : 7) * a.k * (1 + 0.25 * bank);
  if (fish) {
    // A slim body with a tail.
    const sw = Math.sin(t * 9 + i) * 0.3;
    ctx.moveTo(a.x + dx * L, a.y + dy * L);
    ctx.lineTo(a.x - dy * L * 0.3, a.y + dx * L * 0.3);
    ctx.lineTo(a.x - dx * L * (1 - sw * 0.2) - dy * L * 0.45, a.y - dy * L + dx * L * 0.45);
    ctx.lineTo(a.x - dx * L * 0.8, a.y - dy * L * 0.8);
    ctx.lineTo(a.x - dx * L + dy * L * 0.45, a.y - dy * L * (1 + sw * 0.2) - dx * L * 0.45);
    ctx.lineTo(a.x + dy * L * 0.3, a.y - dx * L * 0.3);
    ctx.closePath();
    return;
  }
  // Wings beating: a flattened V that opens and closes.
  const flap = 0.55 + 0.45 * Math.sin(t * (14 + 8 * bank) + i * 1.7);
  const W = (5.8 * a.k * flap + 1.2) * (1 + 1.2 * bank);
  ctx.moveTo(a.x + dx * L * 0.6, a.y + dy * L * 0.6);
  ctx.lineTo(a.x - dx * L * 0.5 - dy * W, a.y - dy * L * 0.5 + dx * W);
  ctx.lineTo(a.x - dx * L * 0.2, a.y - dy * L * 0.2);
  ctx.lineTo(a.x - dx * L * 0.5 + dy * W, a.y - dy * L * 0.5 - dx * W);
  ctx.closePath();
}

/**
 * The predator, about three starlings long (a shark much bigger than its fish). A falcon glides
 * on spread wings with a few beats now and then while it circles, folds into a dart for the stoop,
 * and beats hard as it climbs out.
 */
function drawPredator(ctx: Ctx2D, x: number, y: number, k: number, angle: number, fish: boolean, mode: Predator['mode'], t: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const s = k * (fish ? 2.2 : 1.6);
  ctx.scale(s, s);
  ctx.fillStyle = fish ? '#40525f' : '#120a10';
  ctx.beginPath();
  if (fish) {
    const sway = Math.sin(t * (mode === 'stoop' ? 9 : 4)) * 2.5;
    ctx.ellipse(0, 0, 15, 4.2, 0, 0, Math.PI * 2);
    ctx.moveTo(-13, 0);
    ctx.lineTo(-21, -7 + sway);
    ctx.lineTo(-18, sway * 0.3);
    ctx.lineTo(-21, 7 + sway);
    ctx.closePath();
    ctx.moveTo(1, -4);
    ctx.lineTo(-3, -10);
    ctx.lineTo(-5, -4);
    ctx.closePath();
  } else {
    // Wing span and sweep by what it's doing.
    let span: number;
    let sweep: number;
    if (mode === 'stoop') {
      span = 3.2;
      sweep = 8;
    } else if (mode === 'climb') {
      span = 7 + 4 * Math.sin(t * 11);
      sweep = 3;
    } else {
      // Gliding, with a short burst of beats every couple of seconds.
      const burst = Math.max(0, Math.sin(t * 1.6)) > 0.85 ? Math.sin(t * 12) : 0;
      span = 11 - 3 * Math.abs(burst);
      sweep = 2.5;
    }
    // Body, from beak to tail.
    ctx.moveTo(7, 0);
    ctx.quadraticCurveTo(4, -1.6, -3, -1.3);
    ctx.lineTo(-8, -2.2);
    ctx.lineTo(-8, 2.2);
    ctx.lineTo(-3, 1.3);
    ctx.quadraticCurveTo(4, 1.6, 7, 0);
    ctx.closePath();
    // Long pointed wings.
    for (const side of [-1, 1]) {
      ctx.moveTo(2.5, side * 1);
      ctx.quadraticCurveTo(0, side * (span * 0.6), -sweep, side * span);
      ctx.quadraticCurveTo(-1.5, side * span * 0.45, -2.5, side * 1);
      ctx.closePath();
    }
  }
  ctx.fill();
  ctx.restore();
}

function pill(ctx: Ctx2D, theme: Theme, text: string, x: number, y: number, on: boolean) {
  ctx.save();
  ctx.font = `900 28px ${FONT_FAMILY}`;
  const w = ctx.measureText(text).width + 40;
  ctx.fillStyle = on ? theme.accent : 'rgba(0,0,0,0.45)';
  ctx.globalAlpha = on ? 0.95 : 0.8;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 24, w, 48, 24);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = on ? '#0b0b0b' : 'rgba(255,255,255,0.55)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 1);
  ctx.restore();
}

export function renderFlockTop(ctx: Ctx2D, theme: Theme, s: DrawState, t: number) {
  const { p, sim, dir } = s;
  const r = sim.flock.rules;
  if (sim.hidden && !sim.revealed) {
    pill(ctx, theme, 'ONE RULE IS OFF', 540, 340, false);
  } else {
    const names: [keyof typeof r, string][] = [
      ['separation', 'SEPARATION'],
      ['alignment', 'ALIGNMENT'],
      ['cohesion', 'COHESION'],
    ];
    names.forEach(([k, label], i) => pill(ctx, theme, label, 210 + i * 330, 340, r[k]));
  }
  // How much of the flock points the same way.
  const o = order(sim.flock);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.roundRect(240, 392, 600, 20, 10);
  ctx.fill();
  ctx.fillStyle = theme.accent;
  ctx.beginPath();
  ctx.roundRect(240, 392, Math.max(20, 600 * o), 20, 10);
  ctx.fill();
  ctx.font = `800 24px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(`${Math.round(o * 100)}% FLYING THE SAME WAY`, 540, 444);
  ctx.restore();

  const guess = dir.said.find((x) => x.beat.id === 'guess');
  const revealAt = markAt(dir, 'reveal');
  if (p.guess && guess && t < revealAt) {
    const left = Math.min(revealAt - t, guess.at + guess.durationS + 8 - t);
    if (left > 0) drawCommentPrompt(ctx, theme, t - guess.at, left, PROMPT);
  }
  if (p.mode === 'remove-one' && sim.revealed) drawAnswer(ctx, theme, sim.answer, 540, 520, t - revealAt, 80);
  if (p.captions) drawStoryCaption(ctx, theme, dir, timeOf(dir), { y: CAPTION_Y });
}
