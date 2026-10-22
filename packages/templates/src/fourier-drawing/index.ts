import { z } from 'zod';
import { FONT_FAMILY, lighten, paletteAt, rgbToCss, type Ctx2D, type DramaScore, type Template, type Theme } from '@sim/engine';
import { gaussFit } from '../scoring';
import { drawAnswer, drawCommentPrompt } from '../guess';
import { SHAPES, dft, reconstructionError, type Shape, type Term } from './fourier';

const SUBJECTS = ['random', 'countries', 'states', 'dinosaurs', 'animals', 'fantasy'] as const;
const CATEGORY: Record<Exclude<(typeof SUBJECTS)[number], 'random'>, Shape['category']> = {
  countries: 'country',
  states: 'state',
  dinosaurs: 'dinosaur',
  animals: 'animal',
  fantasy: 'fantasy',
};
/** The on-screen question, by category (it tells viewers what kind of thing to guess, not which). */
export const GUESS: Record<Shape['category'], string> = {
  country: 'Guess what country the circles are drawing?',
  state: 'Guess which US state the circles are drawing?',
  dinosaur: 'Guess which dinosaur the circles are drawing?',
  animal: 'Guess what animal the circles are drawing?',
  fantasy: 'Guess what mythical creature the circles are drawing?',
};

export const fourierDrawingSchema = z.object({
  subject: z.enum(SUBJECTS).default('random').meta({ title: 'Subject' }),
  shape: z.enum(['random', ...SHAPES.map((s) => s.id)] as [string, ...string[]]).default('random').meta({ title: 'Shape' }),
  maxCircles: z.number().int().min(32).max(300).default(200).meta({ title: 'Circles in the last stage' }),
  durationS: z.number().min(20).max(60).default(34).meta({ title: 'Length (s)' }),
});

export type FourierDrawingParams = z.infer<typeof fourierDrawingSchema>;

interface Stage {
  circles: number;
  start: number;
  dur: number;
  err: number;
  /** Beats in this stage's loop (one loop is one bar). */
  beats: number;
  /** Index into CHORDS. */
  chord: number;
}

interface State {
  p: FourierDrawingParams;
  shape: Shape;
  centre: [number, number];
  terms: Term[];
  stages: Stage[];
  stage: number;
  revealAt: number;
  /** The last sixteenth-note slot handled in the current stage. */
  lastSlot: number;
  t: number;
}

/** Circle counts per stage (finer steps early, where each extra circle changes the most). */
const COUNTS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128, 200, 300];
/** The biggest circles each ping as they pass 12 o'clock. */
const SINGERS = 10;
/**
 * One chord per stage, cycling I-vi-IV-V in C major (pitch classes, root first), lined up so the last
 * stage sits on G and the reveal resolves home to C.
 */
const CHORDS = [
  [0, 4, 7],
  [9, 0, 4],
  [5, 9, 0],
  [7, 11, 2],
];
const LEAD_S = 0.6;
const REVEAL_S = 4.2;
/** The CTA appears this long after the reveal starts. */
const OUTRO_DELAY_S = 1.0;
const RECOGNISABLE = 0.02;
const CX = 540;
const CY = 870;
const SCALE = 740;
/** Pen magnifier: shown from this many circles on. */
const MAGNIFY_FROM = 12;
const MAG = { x: 190, y: 1385, r: 122 };
/** Comment prompt for the second half of the drawing: under the caption, above the platform's bottom UI. */
const PROMPT = { x: 580, y: 1500 };
const TRACE_SAMPLES = 720;

/** The arm's angle as a fraction of a turn, measured from 12 o'clock (screen y points down). */
const turnsFromTop = (term: Term, u: number) => term.freq * u + (term.phase + Math.PI / 2) / (2 * Math.PI);

function positionAt(s: State, k: number, u: number, out: number[] = []): number[] {
  out.length = 0;
  let x = s.centre[0];
  let y = s.centre[1];
  out.push(x, y);
  for (let j = 0; j < k; j++) {
    const t = s.terms[j];
    const a = 2 * Math.PI * t.freq * u;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    x += t.re * c - t.im * sn;
    y += t.re * sn + t.im * c;
    out.push(x, y);
  }
  return out;
}

export const fourierDrawing: Template<FourierDrawingParams, State> = {
  id: 'fourier-drawing',
  name: 'Fourier Drawing',
  family: 'kinetic',
  category: 'brainy',
  description:
    'A chain of spinning circles draws a mystery outline (a country, US state, dinosaur, animal or mythical creature). It starts with one circle drawing a blob, then 2, 4, 8… up to hundreds, and the shape sharpens until the reveal. Any closed shape is a sum of circles.',
  schema: fourierDrawingSchema,
  lengthParam: { param: 'durationS', offsetS: 0 },
  // No physics, but notes are timed to the step, so 240 Hz keeps the beat tight (within ~4 ms).
  substeps: 4,
  searchBudget: 6,
  glowScale: 0.55,
  ownMusic: true,
  defaultCopy: {
    // {guess} comes from hud(): the question names the kind of thing (country, US state, dinosaur…).
    hook: '{guess}',
    cta: 'It was {answer} {icon}! Did you get it?',
  },
  nudges: ['Know it yet? Comment 👇', 'Drop your guess before the reveal 👇', 'Lock in your answer 👇', 'How many circles until you knew? 👇', 'Guessed it already? 👇', 'Comment your guess 👇'],
  // The question stays up top for the whole drawing, so the prompt sits just under the circle count.
  nudgeY: 0.245,

  init({ params: p, rng }) {
    const pool = p.subject === 'random' ? SHAPES : SHAPES.filter((s) => s.category === CATEGORY[p.subject as keyof typeof CATEGORY]);
    const shape = p.shape !== 'random' ? SHAPES.find((s) => s.id === p.shape)! : rng.pick(pool);
    const { centre, terms } = dft(shape.points);
    const max = Math.min(p.maxCircles, terms.length);
    const counts = [...COUNTS.filter((c) => c < max), max];
    // Every loop is a whole bar at one steady tempo, so the music keeps a pulse: two beats per loop
    // early on, four once detail arrives, and eight for the last one, which lingers.
    const n = counts.length;
    const beats = counts.map((_, i) => (i === n - 1 ? 8 : i < n / 2 ? 2 : 4));
    const beatS = (p.durationS - REVEAL_S - LEAD_S) / beats.reduce((a, b) => a + b, 0);
    let at = LEAD_S;
    const stages: Stage[] = counts.map((circles, i) => {
      const st = {
        circles,
        start: at,
        dur: beats[i] * beatS,
        err: reconstructionError(shape.points, centre, terms, circles),
        beats: beats[i],
        chord: (((i - (n - 1)) % 4) + 4 + 3) % 4,
      };
      at += st.dur;
      return st;
    });
    return {
      p,
      shape,
      centre,
      terms,
      stages,
      stage: -1,
      revealAt: at,
      lastSlot: -1,
      t: 0,
    };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    if (t >= s.revealAt) {
      if (s.stage < s.stages.length) {
        s.stage = s.stages.length;
        emit({ type: 'reveal', shape: s.shape.id });
      }
      return;
    }
    let i = s.stage;
    while (i + 1 < s.stages.length && t >= s.stages[i + 1].start) i++;
    if (i < 0) return;
    const st = s.stages[i];
    const u = (t - st.start) / st.dur;
    if (i !== s.stage) {
      s.stage = i;
      s.lastSlot = -1;
      emit({ type: 'stage', stage: i, circles: st.circles, err: st.err, chord: st.chord });
    }
    const slots = st.beats * 4;
    const slot = Math.floor(u * slots);
    if (slot === s.lastSlot) return;
    s.lastSlot = slot;
    if (slot % 4 === 0) emit({ type: 'beat', chord: st.chord, k: slot / 4 });
    // Each big circle pings when its arm passes 12 o'clock: the soundtrack is the circles' own rhythm,
    // snapped to the nearest sixteenth note so it stays in time. Every circle turns a whole number of
    // times per loop, so the window may reach back before u = 0 at the start of a loop.
    const half = 0.5 / slots;
    const at = slot / slots;
    const amp0 = s.terms[0].amp;
    const ranks: number[] = [];
    const sizes: number[] = [];
    for (let j = 0; j < Math.min(SINGERS, st.circles) && ranks.length < 2; j++) {
      const term = s.terms[j];
      if (Math.floor(turnsFromTop(term, at - half)) === Math.floor(turnsFromTop(term, at + half))) continue;
      ranks.push(j);
      sizes.push(Math.sqrt(term.amp / amp0));
    }
    if (ranks.length) emit({ type: 'ping', ranks, sizes, chord: st.chord });
  },

  isDone(s) {
    return s.t >= s.revealAt + REVEAL_S;
  },

  hud(s) {
    const st = s.stages[Math.min(Math.max(0, s.stage), s.stages.length - 1)];
    return {
      answer: s.shape.name,
      icon: s.shape.icon,
      guess: GUESS[s.shape.category],
      circles: st.circles,
      outro: s.t >= s.revealAt + OUTRO_DELAY_S,
    };
  },

  overlays(p, copy) {
    // The question stays up for the whole drawing and hands over to the CTA (same spot) at the reveal.
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: p.durationS - REVEAL_S + OUTRO_DELAY_S, y: 0.12 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.12 },
    ];
  },

  render({ ctx, theme }, s) {
    const t = s.t;
    const revealed = t >= s.revealAt;
    const idx = revealed ? s.stages.length - 1 : Math.max(0, s.stage);
    const st = s.stages[idx];
    const u = revealed ? 1 : Math.max(0, (t - st.start) / st.dur);
    const X = (x: number) => CX + x * SCALE;
    const Y = (y: number) => CY + y * SCALE;
    const ink = paletteAt(theme.palette, 0.45);
    const chain = positionAt(s, st.circles, u);

    // The answer, filled in at the reveal.
    if (revealed) {
      const a = Math.min(1, (t - s.revealAt) / 0.6);
      const pts = s.shape.points;
      ctx.beginPath();
      for (let n = 0; n < pts.length; n += 2) ctx.lineTo(X(pts[n] / 1000), Y(pts[n + 1] / 1000));
      ctx.closePath();
      ctx.fillStyle = rgbToCss(ink, 0.28 * a);
      ctx.fill();
    }

    const fadeOut = revealed ? Math.max(0, 1 - (t - s.revealAt) / 0.6) : 1;
    drawScene(ctx, theme, s, idx, u, chain, X, Y, SCALE, { circles: fadeOut, labels: !revealed, ghost: !revealed });

    // Magnifier on the pen once there are small circles worth seeing.
    const zoomOn = !revealed && st.circles >= MAGNIFY_FROM;
    const zoomA = zoomOn ? Math.min(1, (t - Math.max(st.start, s.stages.find((x) => x.circles >= MAGNIFY_FROM)!.start)) / 0.4) : 0;
    if (zoomA > 0) drawMagnifier(ctx, theme, s, idx, u, chain, X, Y, zoomA);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (revealed) {
      drawAnswer(ctx, theme, `${s.shape.icon} ${s.shape.name.replace(/^(a|an|the) /, '').toUpperCase()}`, 540, 1390, t - s.revealAt - 0.3);
      return;
    }
    if (s.stage < 0) return;

    // Circle count (top) and what this stage shows (bottom).
    const since = t - st.start;
    const pop = 1 + 0.2 * Math.exp(-since * 7);
    ctx.save();
    ctx.translate(540, 345);
    ctx.scale(pop, pop);
    ctx.font = `900 72px ${FONT_FAMILY}`;
    ctx.lineWidth = 10;
    ctx.strokeStyle = theme.textStroke;
    const label = `${st.circles} circle${st.circles === 1 ? '' : 's'}`;
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = theme.accent;
    ctx.fillText(label, 0, 0);
    ctx.restore();
    ctx.font = `700 26px ${FONT_FAMILY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('×3 = spins 3 times per loop, arrow shows which way', 540, 402);

    const text = captionFor(st.circles, idx === s.stages.length - 1);
    const capA = Math.min(1, since / 0.35);
    ctx.globalAlpha = capA;
    ctx.font = `800 31px ${FONT_FAMILY}`;
    ctx.fillStyle = theme.text;
    if (zoomOn) {
      ctx.textAlign = 'left';
      wrapLines(ctx, text, 560).forEach((line, i, all) => ctx.fillText(line, 350, 1385 + (i - (all.length - 1) / 2) * 42));
    } else {
      wrapLines(ctx, text, 860).forEach((line, i, all) => ctx.fillText(line, 540, 1385 + (i - (all.length - 1) / 2) * 42));
    }
    ctx.globalAlpha = 1;

    const promptFrom = s.p.durationS / 2;
    if (t >= promptFrom) drawCommentPrompt(ctx, theme, t - promptFrom, s.revealAt - t, PROMPT);
  },

  audio(e) {
    // Every note is a tone of the current stage's chord, on a steady beat, so the circles, the bass
    // and the stage bells always agree, and the reveal resolves the last stage's G chord to C.
    const chord = CHORDS[(e.chord as number) ?? 0];
    switch (e.type) {
      case 'ping': {
        // Bigger circles ring lower, smaller (faster) ones higher. Two circles that land on the same
        // pitch play it once.
        const ladder = chordNotes(chord, 64, 88);
        const sizes = e.sizes as number[];
        const midis = (e.ranks as number[]).map((rank) => ladder[rank % ladder.length]);
        return midis
          .filter((midi, i) => midis.indexOf(midi) === i)
          .map((midi, i) => ({ kind: 'note' as const, midi, vel: 0.16 + 0.3 * sizes[i], voice: 'marimba' as const, dur: 0.8 }));
      }
      case 'beat': {
        // A soft bass on every beat: root, fifth, octave, fifth.
        const root = 41 + ((chord[0] - 41 + 120) % 12);
        return [{ kind: 'note', midi: root + [0, 7, 12, 7][(e.k as number) % 4], vel: 0.3, voice: 'softsine', dur: 0.9 }];
      }
      case 'stage': {
        // A bell on each new loop: the first chord tone at or above a line that climbs a step per stage (capped
        // so the late stages don't get shrill).
        const target = 72 + Math.min(e.stage as number, 12);
        return [{ kind: 'note', midi: chordNotes(chord, target, target + 12)[0], vel: 0.26, voice: 'bell', dur: 1.2 }];
      }
      case 'reveal':
        return [
          { kind: 'sfx', name: 'whoosh', vel: 0.45 },
          { kind: 'note', midi: 48, vel: 0.4, voice: 'softsine', dur: 3 },
          ...[60, 64, 67, 72, 76].map((midi, i) => ({ kind: 'note' as const, midi, vel: 0.36, voice: 'bell' as const, dur: 2.4 + i * 0.1 })),
        ];
    }
    return [];
  },

  score(events, { durationS, targetS }): DramaScore {
    const stages = events.filter((e) => e.type === 'stage');
    const reveal = events.find((e) => e.type === 'reveal');
    const durFit = gaussFit(durationS, targetS, targetS * 0.3);
    // Suspense: when does the outline become recognisable? Ideally around the middle of the drawing.
    const first = stages[0]?.t ?? 0;
    const end = reveal?.t ?? durationS;
    const clear = stages.find((e) => (e.err as number) < RECOGNISABLE);
    const frac = clear ? (clear.t - first) / Math.max(1e-6, end - first) : 1;
    const suspense = gaussFit(frac, 0.5, 0.22);
    return { total: durFit * (0.75 + 0.25 * suspense), parts: { durFit, suspense }, notes: [`recognisable at ${(frac * 100).toFixed(0)}% (${clear?.circles ?? '–'} circles)`] };
  },
};

/** The notes in [lo, hi) whose pitch class is in the chord, lowest first. */
function chordNotes(chord: number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let m = lo; m < hi; m++) if (chord.includes(m % 12)) out.push(m);
  return out;
}

function captionFor(circles: number, last: boolean): string {
  if (last) return 'Every circle spins a whole number of times per loop. Enough of them can draw any closed shape.';
  if (circles === 1) return 'One circle on its own can only draw a circle.';
  if (circles === 2) return 'Add a second one riding on the first, spinning at another speed: now it bends.';
  if (circles <= 8) return 'Each new circle rides on the last. Biggest first: they set the rough shape.';
  if (circles <= 32) return 'Smaller, faster circles add the bumps and corners.';
  return 'Tiny, fast circles trace the finest edges.';
}

function wrapLines(ctx: Ctx2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Ghost of the last stage, the trace so far, then the circles (coloured by size order, biggest
 * brightest) with their arms. `k` is pixels per shape unit, so the magnifier can reuse it.
 */
function drawScene(
  ctx: Ctx2D,
  theme: Theme,
  s: State,
  idx: number,
  u: number,
  chain: number[],
  X: (x: number) => number,
  Y: (y: number) => number,
  k: number,
  opts: { circles: number; labels: boolean; ghost: boolean; thin?: boolean; maxRadius?: number },
) {
  const st = s.stages[idx];
  const ink = paletteAt(theme.palette, 0.45);
  if (opts.ghost && idx > 0) {
    const fade = Math.max(0.1, 0.32 - u * 0.25);
    strokeTrace(ctx, traceFor(s, idx - 1), TRACE_SAMPLES, X, Y, rgbToCss([255, 255, 255], fade), opts.thin ? 2 : 3);
  }
  strokeTrace(ctx, traceFor(s, idx), Math.floor(u * TRACE_SAMPLES), X, Y, rgbToCss(lighten(ink, 0.35)), opts.thin ? 4 : 5);
  if (opts.circles <= 0) return;
  ctx.globalAlpha = opts.circles;
  const amp0 = s.terms[0].amp;
  const colours = Math.min(st.circles, 16);
  for (let j = 0; j < st.circles; j++) {
    const term = s.terms[j];
    const r = term.amp * k;
    const share = Math.sqrt(term.amp / amp0);
    const cx = X(chain[2 * j]);
    const cy = Y(chain[2 * j + 1]);
    const col = paletteAt(theme.palette, colours > 1 ? (Math.min(j, colours - 1) / (colours - 1)) * 0.9 : 0.1);
    // In the magnifier the big circles would only cross it as long arcs and lines: leave them out.
    if (opts.maxRadius && r > opts.maxRadius) continue;
    if (r > 2) {
      if (j < 6) {
        ctx.fillStyle = rgbToCss(col, 0.06 * share);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = rgbToCss(lighten(col, 0.2), 0.45 + 0.5 * share);
      ctx.lineWidth = 2 + 2 * share;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = `rgba(255,255,255,${(0.55 + 0.45 * share).toFixed(3)})`;
    ctx.lineWidth = 1.5 + 2.5 * share;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(X(chain[2 * j + 2]), Y(chain[2 * j + 3]));
    ctx.stroke();
    if (r > 6) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, 2 + 3 * share, 0, Math.PI * 2);
      ctx.fill();
    }
    // Spin speed and direction on the biggest circles.
    if (opts.labels && j < 4 && r > 60) {
      const dir = Math.sign(term.freq); // + is clockwise on screen (y points down)
      const a0 = -Math.PI / 2 - 0.5 * dir;
      const a1 = -Math.PI / 2 + 0.5 * dir;
      const rr = r + 9;
      ctx.strokeStyle = rgbToCss(lighten(col, 0.35));
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, rr, Math.min(a0, a1), Math.max(a0, a1));
      ctx.stroke();
      // Arrowhead at the leading end, pointing along the spin.
      const hx = cx + rr * Math.cos(a1);
      const hy = cy + rr * Math.sin(a1);
      const tx = -Math.sin(a1) * dir;
      const ty = Math.cos(a1) * dir;
      ctx.fillStyle = rgbToCss(lighten(col, 0.35));
      ctx.beginPath();
      ctx.moveTo(hx + tx * 14, hy + ty * 14);
      ctx.lineTo(hx - tx * 2 + Math.cos(a1) * 9, hy - ty * 2 + Math.sin(a1) * 9);
      ctx.lineTo(hx - tx * 2 - Math.cos(a1) * 9, hy - ty * 2 - Math.sin(a1) * 9);
      ctx.closePath();
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 26px ${FONT_FAMILY}`;
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      const txt = `×${Math.abs(term.freq)}`;
      ctx.strokeText(txt, cx, cy - r - 34);
      ctx.fillStyle = rgbToCss(lighten(col, 0.35));
      ctx.fillText(txt, cx, cy - r - 34);
    }
  }
  const px = X(chain[chain.length - 2]);
  const py = Y(chain[chain.length - 1]);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(px, py, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** A round inset following the pen, zoomed in so the smallest circles can be seen at work. */
function drawMagnifier(ctx: Ctx2D, theme: Theme, s: State, idx: number, u: number, chain: number[], X: (x: number) => number, Y: (y: number) => number, alpha: number) {
  const circles = s.stages[idx].circles;
  const zoom = circles >= 100 ? 7 : circles >= 32 ? 5 : 3.5;
  const px = X(chain[chain.length - 2]);
  const py = Y(chain[chain.length - 1]);
  const MX = (x: number) => MAG.x + (X(x) - px) * zoom;
  const MY = (y: number) => MAG.y + (Y(y) - py) * zoom;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Faint link from the inset to the pen.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  const ang = Math.atan2(py - MAG.y, px - MAG.x);
  ctx.moveTo(MAG.x + Math.cos(ang) * MAG.r, MAG.y + Math.sin(ang) * MAG.r);
  ctx.lineTo(px, py);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(MAG.x, MAG.y, MAG.r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(8,8,16,0.88)';
  ctx.fill();
  ctx.save();
  ctx.clip();
  drawScene(ctx, theme, s, idx, u, chain, MX, MY, SCALE * zoom, { circles: alpha, labels: false, ghost: true, thin: true, maxRadius: MAG.r * 0.9 });
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(MAG.x, MAG.y, MAG.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 22px ${FONT_FAMILY}`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(`ZOOM ×${zoom}`, MAG.x, MAG.y - MAG.r - 18);
  ctx.restore();
}

const traces = new WeakMap<State, Map<number, Float32Array>>();

/** The full outline drawn by stage i's circles (visual only; Math trig is fine here). */
function traceFor(s: State, i: number): Float32Array {
  let m = traces.get(s);
  if (!m) traces.set(s, (m = new Map()));
  let tr = m.get(i);
  if (!tr) {
    tr = new Float32Array((TRACE_SAMPLES + 1) * 2);
    const tmp: number[] = [];
    for (let k = 0; k <= TRACE_SAMPLES; k++) {
      const chain = positionAt(s, s.stages[i].circles, k / TRACE_SAMPLES, tmp);
      tr[2 * k] = chain[chain.length - 2];
      tr[2 * k + 1] = chain[chain.length - 1];
    }
    m.set(i, tr);
  }
  return tr;
}

function strokeTrace(ctx: Ctx2D, tr: Float32Array, upto: number, X: (x: number) => number, Y: (y: number) => number, style: string, width: number) {
  if (upto < 1) return;
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(X(tr[0]), Y(tr[1]));
  for (let k = 1; k <= upto; k++) ctx.lineTo(X(tr[2 * k]), Y(tr[2 * k + 1]));
  ctx.stroke();
}
