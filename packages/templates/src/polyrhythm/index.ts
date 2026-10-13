import { z } from 'zod';
import { FONT_FAMILY, lighten, paletteAt, rgbToCss, type Ctx2D, type DramaScore, type RGB, type Template } from '@sim/engine';
import { gaussFit } from '../scoring';
import { SCALES, scaleNote, type ScaleName } from '../music';
import * as dm from '@sim/physics/math';
import { PATTERNS, patternRates, polygonSides } from './patterns';
import { drawPendulums3D } from './pendulum3d';

export const POLYRHYTHM_STYLES = ['arcs', 'pendulum-wave', 'polygons', 'string-art', 'piano', 'pendulum-3d'] as const;
export type PolyrhythmStyle = (typeof POLYRHYTHM_STYLES)[number];

export const polyrhythmSchema = z.object({
  style: z.enum(POLYRHYTHM_STYLES).default('arcs').meta({ title: 'Style' }),
  pattern: z.enum(PATTERNS).default('linear').meta({ title: 'Speed pattern' }),
  count: z.number().int().min(5).max(32).default(18).meta({ title: 'Dots / pendulums (polygons: up to 10)' }),
  loopSeconds: z.number().min(12).max(75).default(36).meta({ title: 'Loop length (s)' }),
  baseCycles: z.number().int().min(2).max(40).default(10).meta({ title: 'Cycles of slowest' }),
  cycleStep: z.number().int().min(1).max(3).default(1).meta({ title: 'Cycle step' }),
  scale: z.enum(['random', ...(Object.keys(SCALES) as ScaleName[])]).default('random').meta({ title: 'Scale' }),
  rootNote: z.number().int().min(36).max(72).default(55).meta({ title: 'Root note (MIDI)' }),
  hitVolume: z.number().min(0.1).max(1).default(0.45).meta({ title: 'Note volume', step: 0.05 }),
});

export type PolyrhythmParams = z.infer<typeof polyrhythmSchema>;

interface State {
  p: PolyrhythmParams;
  scale: ScaleName;
  /** Full cycles each element completes in one loop (back-and-forth styles, laps, bounces). */
  cycles: number[];
  /** Notes each element plays per loop, evenly spaced (all whole numbers, so the loop is seamless). */
  notesPerLoop: number[];
  /** Polygons: sides of each shape (innermost first). */
  sides: number[];
  hits: number[];
  flash: number[];
  t: number;
  colorShift: number;
}

const CX = 540;
const BASE_Y = 1260;
const R_MIN = 70;
const R_MAX = 470;
const MAX_POLYGONS = 10;
const MAX_LANES = 24;
/** String art fades out over the last moments so the final frame matches the first (seamless). */
const ART_FADE_S = 1.4;

/** 0 -> 1 -> 0 over one cycle. */
const tri = (phase: number) => {
  const f = phase - Math.floor(phase);
  return f < 0.5 ? 2 * f : 2 - 2 * f;
};
const frac = (x: number) => x - Math.floor(x);
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
/** Root names as keys are usually written (B♭ mixolydian, not A♯). */
const ROOT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const LETTERS = 'CDEFGAB';
const LETTER_PITCH = [0, 2, 4, 5, 7, 9, 11];
const ACCIDENTAL: Record<number, string> = { [-2]: '𝄫', [-1]: '♭', 0: '', 1: '♯', 2: '𝄪' };
const mod12 = (n: number) => ((n % 12) + 12) % 12;

/**
 * Name of the scale's i-th note. Seven-note scales use each letter once (C mixolydian has B♭, not
 * A♯), so the labels read the way the scale is written; other scales fall back to sharps.
 */
export function noteName(scale: ScaleName, root: number, i: number): string {
  const midi = scaleNote(scale, root, i);
  if (SCALES[scale].length !== 7) return `${NOTE_NAMES[mod12(midi)]}${Math.floor(midi / 12) - 1}`;
  const rootLetter = LETTERS.indexOf(ROOT_NAMES[mod12(root)][0]);
  const letter = (rootLetter + (((i % 7) + 7) % 7)) % 7;
  let diff = mod12(midi) - LETTER_PITCH[letter];
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  // Octave of the written letter (B♯3 sounds as C4, C♭4 as B3).
  return `${LETTERS[letter]}${ACCIDENTAL[diff] ?? ''}${Math.floor((midi - diff) / 12) - 1}`;
}

/** Smooth version (cosine) for pendulums: -1..1. */
function pendulumX(s: State, i: number, t: number) {
  return dm.cos((2 * Math.PI * s.cycles[i] * t) / s.p.loopSeconds);
}

const STYLE_TEXT: Record<PolyrhythmStyle, string> = {
  arcs: 'dots swinging along concentric arcs',
  'pendulum-wave': 'a pendulum wave seen from above',
  polygons: 'dots tracing nested polygons (triangle, square, pentagon…), a note at every corner',
  'string-art': 'dots orbiting rings, joined by strings that draw a mandala as they go, a note each time a dot passes the top',
  piano: 'balls bouncing on piano keys, each key playing its note',
  'pendulum-3d': 'a real-looking 3D pendulum-wave apparatus (balls on strings) swinging in and out of sync',
};

export const polyrhythm: Template<PolyrhythmParams, State> = {
  id: 'polyrhythm',
  name: 'Polyrhythm Sync',
  family: 'kinetic',
  description: `A polyrhythm visual: every element moves at its own whole-number rate and plays a note on each beat, so they drift into patterns and all line up again exactly at the end; the video loops seamlessly. Styles: ${POLYRHYTHM_STYLES.map((k) => `${k} (${STYLE_TEXT[k]})`).join('; ')}. Speed patterns: linear (even spread), harmonic (multiples, like overtones), primes (few partial lineups, one big one at the end), mirror (slowest in the middle, symmetric twins), random.`,
  schema: polyrhythmSchema,
  lengthParam: { param: 'loopSeconds', offsetS: 0 },
  substeps: 4,
  searchBudget: 24,
  ownMusic: true,
  seamlessLoop: true,
  glowScale: 0.8,
  defaultCopy: {
    hook: 'Wait for them to line up again…',
    cta: 'It loops perfectly. Watch again 🔁',
  },
  nudges: ['Comment the second they sync 👇', 'Rate this rhythm 1–10 👇', 'Which dot is your favourite? 👇', 'Can you hear the pattern? 👇', 'Guess when they line up 👇', 'Rate the sync moment 👇'],

  init({ params: p, rng }) {
    const scale = p.scale === 'random' ? rng.pick(Object.keys(SCALES) as ScaleName[]) : p.scale;
    const n = p.style === 'polygons' ? Math.min(MAX_POLYGONS, p.count) : p.style === 'piano' || p.style === 'pendulum-3d' ? Math.min(MAX_LANES, p.count) : p.count;
    let cycles = patternRates(p.pattern, n, p.baseCycles, p.cycleStep, rng);
    let sides: number[] = [];
    let notesPerLoop: number[];
    switch (p.style) {
      case 'polygons': {
        // Each shape's dot laps at its own whole-number rate (so the dots drift apart and meet again at
        // the top corner at the end) and pings every corner it passes.
        sides = polygonSides(p.pattern, n, p.cycleStep, rng);
        cycles = patternRates(p.pattern === 'mirror' ? 'linear' : p.pattern, n, Math.max(1, Math.round(p.baseCycles / 4)), 1, rng);
        notesPerLoop = sides.map((k, i) => k * cycles[i]);
        break;
      }
      case 'string-art':
      case 'piano':
        notesPerLoop = cycles.slice(); // one note per lap / bounce
        break;
      default:
        notesPerLoop = cycles.map((c) => 2 * c); // a note at each end of the swing
    }
    return { p, scale, cycles, notesPerLoop, sides, hits: cycles.map(() => -1), flash: cycles.map(() => 0), t: 0, colorShift: rng.range(0, 0.2) };
  },

  step(s, { dt, t, emit }) {
    const T = s.p.loopSeconds;
    const t1 = Math.min(T, t + dt);
    for (let i = 0; i < s.notesPerLoop.length; i++) {
      // Notes fall at k * T / notesPerLoop. hits starts at -1 so every element sounds at t=0 (the
      // sync chord opens the video); the note at exactly t=T is the next loop's t=0, so it is skipped.
      const m = s.notesPerLoop[i];
      const k = Math.min(Math.floor((m * t1) / T + 1e-9), m - 1);
      while (s.hits[i] < k) {
        s.hits[i]++;
        s.flash[i] = 1;
        // Slowest element = lowest note.
        emit({ type: 'hit', i, k: s.hits[i], side: panFor(s, i), midi: scaleNote(s.scale, s.p.rootNote, i), vel: s.p.hitVolume });
      }
      s.flash[i] *= dm.exp(-6 * dt);
    }
    s.t = t + dt;
  },

  isDone(s) {
    return s.t >= s.p.loopSeconds - 1e-9;
  },

  hud(s) {
    const left = Math.max(0, s.p.loopSeconds - s.t);
    return { syncIn: `${left.toFixed(1)}s`, outro: false };
  },

  overlays(p, copy) {
    // The piano's keys sit low, so its end card goes up top.
    const ctaY = p.style === 'piano' ? 0.33 : 0.74;
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 3, y: 0.13 },
      { kind: 'counter', key: 'syncIn', label: 'NEXT SYNC IN', y: 0.24, size: 84 },
      { kind: 'cta', text: copy.cta, when: { from: p.loopSeconds - 3.2, to: p.loopSeconds + 1 }, y: ctaY },
    ];
  },

  render(rc, s) {
    const { ctx, theme, t } = rc;
    const n = s.cycles.length;
    const color = (i: number) => paletteAt(theme.palette, ((i / Math.max(1, n - 1)) * 0.95 + s.colorShift) % 1);
    ctx.lineCap = 'round';
    switch (s.p.style) {
      case 'arcs':
        return drawArcs(ctx, s, t, color);
      case 'pendulum-wave':
        return drawPendulumWave(ctx, s, t, color);
      case 'polygons':
        return drawPolygons(ctx, s, t, color);
      case 'string-art':
        return drawStringArt(rc.ctx, s, t, rc.frame, color);
      case 'piano':
        return drawPiano(ctx, s, t, color);
      case 'pendulum-3d':
        return drawPendulums3D(ctx, theme, s, t);
    }
  },

  audio(e, { theme }) {
    if (e.type !== 'hit') return [];
    return [{ kind: 'note', midi: e.midi as number, vel: e.vel as number, voice: theme.voice, pan: (e.side as number) * 0.35 }];
  },

  score(events, { durationS, targetS }): DramaScore {
    const hits = events.filter((e) => e.type === 'hit').length;
    const rate = hits / Math.max(1, durationS);
    const rateFit = rate < 4 ? rate / 4 : rate > 22 ? dm.exp(-(rate - 22) / 10) : 1;
    const durFit = gaussFit(durationS, targetS, targetS * 0.25);
    return { total: durFit * (0.6 + 0.4 * rateFit), parts: { durFit, rateFit }, notes: [`${hits} notes (${rate.toFixed(1)}/s)`] };
  },
};

/** Stereo position of a note (-1..1): which side it sounds on, matching where it happens on screen. */
function panFor(s: State, i: number): number {
  const n = s.notesPerLoop.length;
  switch (s.p.style) {
    case 'arcs':
    case 'pendulum-wave':
    case 'pendulum-3d':
      return s.hits[i] % 2 ? 1 : -1;
    case 'piano':
      return n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
    case 'polygons': {
      const a = -Math.PI / 2 + (2 * Math.PI * (s.hits[i] % s.sides[i])) / s.sides[i];
      return dm.cos(a);
    }
    case 'string-art':
      return 0;
  }
}

type ColorFn = (i: number) => RGB;

function drawArcs(ctx: Ctx2D, s: State, t: number, color: ColorFn) {
  const n = s.cycles.length;
  const T = s.p.loopSeconds;
  ctx.strokeStyle = rgbToCss(lighten(color(n - 1), 0.3), 0.8);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(CX - R_MAX - 40, BASE_Y);
  ctx.lineTo(CX + R_MAX + 40, BASE_Y);
  ctx.stroke();
  for (let i = 0; i < n; i++) {
    // Slowest on the outside.
    const r = R_MAX - (i * (R_MAX - R_MIN)) / Math.max(1, n - 1);
    const col = color(i);
    const fl = s.flash[i];
    ctx.strokeStyle = rgbToCss(lighten(col, fl * 0.6), 0.35 + 0.65 * fl);
    ctx.lineWidth = 3 + fl * 4;
    ctx.beginPath();
    ctx.arc(CX, BASE_Y, r, Math.PI, 2 * Math.PI);
    ctx.stroke();
    // Endpoint impact glows.
    for (const side of [-1, 1]) {
      ctx.fillStyle = rgbToCss(lighten(col, 0.5), 0.25 + fl * 0.75);
      ctx.beginPath();
      ctx.arc(CX + side * r, BASE_Y, 6 + fl * 6, 0, Math.PI * 2);
      ctx.fill();
    }
    const a = Math.PI + Math.PI * tri((s.cycles[i] * t) / T);
    ctx.fillStyle = rgbToCss(lighten(col, 0.35));
    ctx.beginPath();
    ctx.arc(CX + dm.cos(a) * r, BASE_Y + dm.sin(a) * r, 12, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPendulumWave(ctx: Ctx2D, s: State, t: number, color: ColorFn) {
  // Pendulum wave seen from above: one bob per row, slowest at the top. Turnarounds ring.
  const n = s.cycles.length;
  const y0 = 560;
  const y1 = 1330;
  const amp = 400;
  for (let i = 0; i < n; i++) {
    const y = y0 + (i * (y1 - y0)) / Math.max(1, n - 1);
    const col = color(i);
    const fl = s.flash[i];
    ctx.strokeStyle = rgbToCss(col, 0.18);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CX - amp, y);
    ctx.lineTo(CX + amp, y);
    ctx.stroke();
    const side = s.hits[i] % 2 ? -1 : 1;
    ctx.fillStyle = rgbToCss(lighten(col, 0.5), 0.2 + fl * 0.8);
    ctx.beginPath();
    ctx.arc(CX + side * amp, y, 5 + fl * 8, 0, Math.PI * 2);
    ctx.fill();
    const x = CX + amp * pendulumX(s, i, t);
    ctx.fillStyle = rgbToCss(lighten(col, 0.3 + fl * 0.4));
    ctx.beginPath();
    ctx.arc(x, y, Math.min(20, ((y1 - y0) / n) * 0.42) + fl * 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Nested regular polygons sharing a top corner; each dot laps its shape, pinging every corner. */
function drawPolygons(ctx: Ctx2D, s: State, t: number, color: ColorFn) {
  const n = s.sides.length;
  const T = s.p.loopSeconds;
  const cy = 1000;
  const rMin = 95;
  const rMax = 450;
  for (let i = n - 1; i >= 0; i--) {
    const k = s.sides[i];
    const r = rMin + ((rMax - rMin) * i) / Math.max(1, n - 1);
    const col = color(i);
    const fl = s.flash[i];
    const corner = (j: number): [number, number] => {
      const a = -Math.PI / 2 + (2 * Math.PI * j) / k;
      return [CX + dm.cos(a) * r, cy + dm.sin(a) * r];
    };
    ctx.strokeStyle = rgbToCss(lighten(col, 0.15), 0.45 + 0.35 * fl);
    ctx.lineWidth = 3 + 2 * fl;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let j = 0; j <= k; j++) {
      const [x, y] = corner(j % k);
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // The corner just hit rings out.
    const u = (s.notesPerLoop[i] * t) / T;
    const lastCorner = ((Math.floor(u) % k) + k) % k;
    for (let j = 0; j < k; j++) {
      const [x, y] = corner(j);
      const hot = j === lastCorner ? fl : 0;
      ctx.fillStyle = rgbToCss(lighten(col, 0.4 + 0.4 * hot), 0.35 + 0.65 * hot);
      ctx.beginPath();
      ctx.arc(x, y, 5 + 9 * hot, 0, Math.PI * 2);
      ctx.fill();
    }
    // The dot, with a short fading trail along the edge behind it.
    for (let tr = 6; tr >= 0; tr--) {
      const uu = u - tr * 0.045;
      const j = Math.floor(uu);
      const f = frac(uu);
      const [ax, ay] = corner(((j % k) + k) % k);
      const [bx, by] = corner((((j + 1) % k) + k) % k);
      ctx.fillStyle = rgbToCss(lighten(col, 0.45), tr ? 0.5 * (1 - tr / 7) : 1);
      ctx.beginPath();
      ctx.arc(ax + (bx - ax) * f, ay + (by - ay) * f, tr ? 9 - tr : 13, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

const ART_ALPHA = 0.032;
/** Strings passing closer than this (px) to the centre are faded. */
const ART_FALLOFF = 170;

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

const artLayers = new WeakMap<State, { canvas: OffscreenCanvas | HTMLCanvasElement; lastFrame: number }>();

/**
 * Dots orbit concentric rings (one lap per note, passing the top trigger); strings joining
 * neighbouring dots are traced onto a layer that builds into string art, fading at the very end
 * so the loop stays seamless.
 */
function drawStringArt(ctx: Ctx2D, s: State, t: number, frame: number, color: ColorFn) {
  const n = s.cycles.length;
  const T = s.p.loopSeconds;
  const cy = 1000;
  const rMin = 60;
  const rMax = 455;
  const pos = (i: number): [number, number] => {
    const r = rMin + ((rMax - rMin) * i) / Math.max(1, n - 1);
    const a = -Math.PI / 2 + 2 * Math.PI * frac((s.notesPerLoop[i] * t) / T);
    return [CX + dm.cos(a) * r, cy + dm.sin(a) * r];
  };
  let layer = artLayers.get(s);
  if (!layer || frame < layer.lastFrame) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1080, 1920) : Object.assign(document.createElement('canvas'), { width: 1080, height: 1920 });
    layer = { canvas, lastFrame: -1 };
    artLayers.set(s, layer);
  }
  if (frame !== layer.lastFrame) {
    const lc = layer.canvas.getContext('2d') as Ctx2D;
    lc.lineWidth = 1.2;
    for (let i = 0; i + 1 < n; i++) {
      const [ax, ay] = pos(i);
      const [bx, by] = pos(i + 1);
      // Every string that passes near the middle paints it (the short inner ones and the long ones
      // between dots on opposite sides), so the centre would burn out: fade strings by how close they
      // pass to it.
      const near = distToSegment(CX, cy, ax, ay, bx, by);
      lc.strokeStyle = rgbToCss(color(i), ART_ALPHA * Math.max(0.14, Math.min(1, near / ART_FALLOFF) ** 1.2));
      lc.beginPath();
      lc.moveTo(ax, ay);
      lc.lineTo(bx, by);
      lc.stroke();
    }
    layer.lastFrame = frame;
  }
  const fade = Math.min(1, Math.max(0, (T - t) / ART_FADE_S));
  ctx.globalAlpha = fade;
  ctx.drawImage(layer.canvas as CanvasImageSource, 0, 0);
  ctx.globalAlpha = 1;
  // Rings and the top trigger.
  for (let i = 0; i < n; i++) {
    const r = rMin + ((rMax - rMin) * i) / Math.max(1, n - 1);
    ctx.strokeStyle = rgbToCss(color(i), 0.16 + 0.4 * s.flash[i]);
    ctx.lineWidth = 1.5 + 2 * s.flash[i];
    ctx.beginPath();
    ctx.arc(CX, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(CX, cy - rMin + 20);
  ctx.lineTo(CX, cy - rMax - 30);
  ctx.stroke();
  // Live strings and dots.
  ctx.lineWidth = 2.5;
  for (let i = 0; i + 1 < n; i++) {
    const [ax, ay] = pos(i);
    const [bx, by] = pos(i + 1);
    ctx.strokeStyle = rgbToCss(lighten(color(i), 0.35), 0.75);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = pos(i);
    const fl = s.flash[i];
    ctx.fillStyle = rgbToCss(lighten(color(i), 0.45 + 0.4 * fl));
    ctx.beginPath();
    ctx.arc(x, y, 9 + 6 * fl, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Balls bounce on a row of piano keys; each landing presses its key and plays its note. */
function drawPiano(ctx: Ctx2D, s: State, t: number, color: ColorFn) {
  const n = s.cycles.length;
  const T = s.p.loopSeconds;
  const x0 = 70;
  const x1 = 1010;
  const w = (x1 - x0) / n;
  const keyTop = 1250;
  const keyH = 200;
  const hMax = 640;
  const slowest = Math.min(...s.cycles);
  for (let i = 0; i < n; i++) {
    const col = color(i);
    const fl = s.flash[i];
    const x = x0 + i * w;
    const press = 10 * fl;
    // Key: pale tint of its colour, lit up when struck.
    ctx.fillStyle = rgbToCss(lighten(col, 0.45 - 0.25 * fl), 0.55 + 0.4 * fl);
    ctx.beginPath();
    ctx.roundRect(x + 2, keyTop + press, w - 4, keyH, [0, 0, 10, 10]);
    ctx.fill();
    ctx.fillStyle = rgbToCss(col, 0.55 + 0.45 * fl);
    ctx.fillRect(x + 2, keyTop + press, w - 4, 10);
    if (w >= 34) {
      ctx.fillStyle = 'rgba(15,15,25,0.85)';
      ctx.font = `900 ${Math.round(Math.min(30, w * 0.5))}px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(noteName(s.scale, s.p.rootNote, i), x + w / 2, keyTop + press + keyH - 30);
    }
    // Ball: higher, slower bounces for the slow lanes (height ∝ period², like real bounces).
    const f = frac((s.notesPerLoop[i] * t) / T);
    const apex = Math.max(60, hMax * (slowest / s.cycles[i]) ** 2);
    const r = Math.min(22, w * 0.36);
    const y = keyTop - r - 4 * apex * f * (1 - f);
    ctx.fillStyle = rgbToCss(lighten(col, 0.25 + 0.4 * fl));
    ctx.beginPath();
    ctx.arc(x + w / 2, y + press * (1 - Math.min(1, f * 8)), r, 0, Math.PI * 2);
    ctx.fill();
    // Contact glow on the key.
    if (fl > 0.05) {
      ctx.fillStyle = rgbToCss(lighten(col, 0.6), 0.5 * fl);
      ctx.beginPath();
      ctx.ellipse(x + w / 2, keyTop + press, w * 0.45, 10, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
