import { z } from 'zod';
import { FONT_FAMILY, lighten, mixRgb, paletteAt, rgbToCss, type Ctx2D, type DramaScore, type RGB, type Rng, type Template, type Theme, type VoiceId } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { burst, drawSparks, updateSparks, type Spark } from '../fx';
import { drawAnswer, drawCommentPrompt } from '../guess';
import { gaussFit } from '../scoring';
import { arcAt, bounceNormal, buildTimeline, riseFor, solveArc, type Arc, type Onset, type Pt } from './timeline';
import { drawCascade3D } from './view3d';

export const BOUNCE_KEYS_STYLES = ['cascade', 'keys', 'cascade-3d', 'spiral', 'falling'] as const;
export type BounceKeysStyle = (typeof BOUNCE_KEYS_STYLES)[number];
/** Styles drawn with three.js (the sim is the same; only the layout and the view differ). */
export const is3D = (style: BounceKeysStyle) => style === 'cascade-3d' || style === 'spiral' || style === 'falling';

export const bounceKeysSchema = z.object({
  style: z.enum(BOUNCE_KEYS_STYLES).default('cascade').meta({ title: 'Style' }),
  durationS: z.number().min(18).max(60).default(32).meta({ title: 'Length (s)' }),
  bassBall: z.boolean().default(true).meta({ title: 'Bass ball' }),
  bassEntry: z.enum(['half', 'quarter']).default('half').meta({ title: 'Bass ball joins' }),
  voice: z.enum(['theme', 'marimba', 'bell', 'pluck', 'glass']).default('theme').meta({ title: 'Voice' }),
});

export type BounceKeysParams = z.infer<typeof bounceKeysSchema>;

/** The ball drops in and lands the first note this far in. */
const LEAD_S = 0.9;
/** The title appears this long after the last note lands, and stays up REVEAL_S. */
const REVEAL_DELAY_S = 0.35;
const REVEAL_S = 3.6;
/** The CTA replaces the question this long after the reveal starts. */
const OUTRO_DELAY_S = 1.0;

export const BALL_R = 26;
const BASS_R = 30;
/** Keys: top of the keyboard (where the ball lands). */
const KEY_TOP = 1080;
const WHITE_H = 220;
const BLACK_H = 135;
/** Cascade: where the current landing sits on screen; blocks scroll up past it. */
const ANCHOR = 980;
/** Cascade: how far the blocks step down per second of music. */
const DROP_PER_S = 250;
export const BLOCK_W = 118;
export const BLOCK_H = 30;
/** The steepest a bar tilts from flat to bounce the ball on toward the next note. */
const MAX_TILT = 0.6;
/** 3D styles: how far the blocks step down per second of music. */
const DROP_3D: Record<string, number> = { 'cascade-3d': 250, spiral: 230, falling: 320 };
/** Cascade: blocks shatter this long after the ball lands on them. */
export const BREAK_DELAY_S = 0.07;
/** The bass rail along the bottom (top of its pads). */
const BASS_Y = 1560;
const PAD_W = 74;
const PAD_H = 16;
const PROGRESS = { y: 310, w: 600 };
const PROMPT = { x: 560, y: 400 };
const ANSWER_Y = 720;
const GUESS_HOOK = 'Guess the song 🎵';

const BLACK = new Set([1, 3, 6, 8, 10]);
const isBlack = (midi: number) => BLACK.has(((midi % 12) + 12) % 12);

interface Keyboard {
  lo: number;
  hi: number;
  x0: number;
  keyW: number;
  /** Index among the white keys, for each white midi note. */
  whiteIndex: Map<number, number>;
}

interface BassNote {
  t: number;
  dur: number;
  midi: number;
  x: number;
}

/** A 3D spark (sim space, y down), for the three.js styles. */
export interface Spark3 {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  col: RGB;
}

export interface State {
  p: BounceKeysParams;
  title: string;
  composer: string;
  onsets: Onset[];
  /** Ball centre at each landing (world coordinates; the cascade scrolls, keys don't). */
  lands: Pt[];
  /** Surface normal of each landing's bar, tilted to bounce the ball on toward the next note. */
  normals: Pt[];
  /** Spiral: angle round the column of each landing (unwrapped, increasing). */
  theta: number[];
  /** arcs[i] ends on landing i (arcs[0] is the drop-in). */
  arcs: Arc[];
  bass: BassNote[];
  bassArcs: Arc[];
  /** When the bass ball starts dropping in (Infinity: never). */
  bassEnterAt: number;
  bassPads: { midi: number; x: number }[];
  kb: Keyboard | null;
  /** Rotates which palette colour each pitch class gets (per seed). */
  hueShift: number;
  tempo: number;
  passes: number;
  clamped: number;
  revealAt: number;
  next: number;
  nextBass: number;
  nextBreak: number;
  started: boolean;
  bassEntered: boolean;
  revealed: boolean;
  t: number;
  // Visual only.
  visual: boolean;
  fxRng: Rng;
  /** For spark colours only. */
  theme: Theme;
  sparks: Spark[];
  sparks3: Spark3[];
  ripples: { x: number; y: number; t0: number; midi: number; a: number }[];
  lastHit: Map<number, number>;
  lastBassHit: Map<number, number>;
}

/** Pitch-class colour: ordered round the circle of fifths so neighbouring notes contrast. */
export function noteColor(theme: Theme, s: State, midi: number): RGB {
  const k = (((midi % 12) * 7) % 12 + s.hueShift) % 12;
  return paletteAt(theme.palette, k / 11);
}

function keyboardFor(lo: number, hi: number): Keyboard {
  while (isBlack(lo)) lo--;
  while (isBlack(hi)) hi++;
  const whiteIndex = new Map<number, number>();
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) whiteIndex.set(m, whiteIndex.size);
  const keyW = Math.min(92, 980 / whiteIndex.size);
  return { lo, hi, x0: 540 - (whiteIndex.size * keyW) / 2, keyW, whiteIndex };
}

function keyX(kb: Keyboard, midi: number): number {
  const m = Math.max(kb.lo, Math.min(kb.hi, midi));
  if (!isBlack(m)) return kb.x0 + (kb.whiteIndex.get(m)! + 0.5) * kb.keyW;
  return kb.x0 + (kb.whiteIndex.get(m - 1)! + 1) * kb.keyW;
}

/** The latest landing at or before t (-1 before the first). Onsets are sorted. */
export function landedIndex(onsets: { t: number }[], t: number): number {
  let lo = 0;
  let hi = onsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Ball centre (world coordinates) at time t: on an arc, or resting after its last landing. */
export function ballAt(arcs: Arc[], onsets: { t: number }[], t: number) {
  const i = landedIndex(onsets, t);
  return i + 1 < arcs.length ? arcAt(arcs[i + 1], t) : arcAt(arcs[arcs.length - 1], Infinity);
}

/**
 * Where the camera follows: eases from one landing to the next during each hop (`k` = 0 at the
 * landing, 1 at the next), so the view glides instead of tracking every bounce.
 */
export function followAt(s: State, t: number): { i: number; e: number } {
  const i = landedIndex(s.onsets, t);
  if (i < 0) return { i: 0, e: 0 };
  if (i + 1 >= s.lands.length) return { i, e: 0 };
  const u = Math.min(1, (t - s.onsets[i].t) / s.onsets[i].dur);
  return { i, e: u * u * (3 - 2 * u) };
}

/** 2D cascade camera offset (keys don't scroll). */
function cameraY(s: State, t: number): number {
  if (s.p.style !== 'cascade') return 0;
  const { i, e } = followAt(s, t);
  const j = Math.min(s.lands.length - 1, i + 1);
  return s.lands[i].y + (s.lands[j].y - s.lands[i].y) * e - ANCHOR;
}

/** Where the ball touches landing i's bar (ball centre minus the radius along the bar's normal). */
export function contactAt(s: State, i: number): Pt {
  const c = s.lands[i];
  const n = s.normals[i];
  return { x: c.x - n.x * BALL_R, y: c.y - n.y * BALL_R, z: c.z - n.z * BALL_R };
}

export const bounceKeys: Template<BounceKeysParams, State> = {
  id: 'bounce-keys',
  name: 'Bounce Keys',
  family: 'bounce',
  description:
    'A mystery tune played by a bouncing ball: every landing is the next note, exactly on the beat. Styles: note blocks running down the screen (cascade), a piano keyboard (keys), glossy 3D blocks receding into depth (3D cascade), blocks spiralling down a glowing column with an orbiting camera (spiral), or a top-down drop through layers of blocks (falling). Bars lean so each bounce carries the ball on to the next note, and longer notes fly higher. Partway through, a second ball joins on the bass line. The title of the song is revealed at the end.',
  schema: bounceKeysSchema,
  lengthParam: { param: 'durationS', offsetS: 0 },
  // No physics; 240 Hz keeps every landing within ~4 ms of its beat.
  substeps: 4,
  // The run is fixed by the song; seeds only change colours and layout jitter.
  searchBudget: 6,
  melodyDriven: true,
  glowScale: 0.8,
  defaultCopy: {
    hook: GUESS_HOOK,
    cta: 'It was {answer}! Did you get it? 🎵',
  },
  nudges: ['Name that tune 👇', 'Got it yet? Comment 👇', 'How many notes did you need? 👇', 'Drop your guess before the reveal 👇', 'Know this song? 👇', 'Lock in your answer 👇'],
  // The question stays up top, so the prompt sits under the progress bar.
  nudgeY: 0.21,

  init({ params: p, rng, fxRng, visual, melody, theme }) {
    const span = Math.max(4, p.durationS - LEAD_S - REVEAL_DELAY_S - REVEAL_S);
    const { onsets, tempo, passes } = buildTimeline(melody, LEAD_S, span);
    const pitches = onsets.map((o) => o.midi);
    const lo = Math.min(...pitches);
    const hi = Math.max(...pitches);
    const durs = onsets.map((o) => o.dur).sort((a, b) => a - b);
    const refDt = durs[durs.length >> 1];
    const kb = p.style === 'keys' ? keyboardFor(lo - 1, hi + 1) : null;
    /** Pitch as a 0..1 fraction of the song's range. */
    const frac = (midi: number) => (hi === lo ? 0.5 : (midi - lo) / (hi - lo));

    // Landing points. Keys: on the keyboard. The cascades step down in proportion to the time
    // between notes (so the camera scrolls steadily), with pitch across the screen; the spiral puts
    // pitch on the distance from the column and turns with time; falling puts pitch up the screen
    // (seen from above) and zigzags across it.
    const lands: Pt[] = [];
    const theta: number[] = [];
    let y = 0;
    let angle = rng.range(0, Math.PI * 2);
    const drop = DROP_3D[p.style] ?? DROP_PER_S;
    onsets.forEach((o, i) => {
      if (kb) {
        lands.push({ x: keyX(kb, o.midi), y: KEY_TOP - BALL_R, z: 0 });
        return;
      }
      if (i > 0) y += Math.max(60, drop * onsets[i - 1].dur * rng.range(0.8, 1.2));
      const f = frac(o.midi);
      if (p.style === 'spiral') {
        if (i > 0) angle += Math.min(1.4, Math.max(0.3, 1.1 * onsets[i - 1].dur));
        const r = 170 + 180 * f;
        theta.push(angle);
        lands.push({ x: 540 + r * Math.cos(angle), y, z: r * Math.sin(angle) });
      } else if (p.style === 'falling') {
        const side = i % 2 ? 1 : -1;
        lands.push({ x: 540 + side * rng.range(50, 150), y, z: 330 - 660 * f });
      } else if (p.style === 'cascade-3d') {
        lands.push({ x: 170 + 740 * f, y, z: rng.range(-150, 150) });
      } else {
        lands.push({ x: 170 + 740 * f, y, z: 0 });
      }
    });

    // Hops: the drop-in from above the screen, then one arc per note, rising more for longer notes.
    // Falling looks straight down the drop, so hops toward the camera stay lower.
    const maxRise = kb ? 500 : p.style === 'falling' ? 240 : 420;
    let clamped = 0;
    const top = kb ? -60 : lands[0].y - ANCHOR - 60;
    const arcs: Arc[] = [solveArc({ ...lands[0], y: top }, lands[0], 0, LEAD_S, top)];
    for (let i = 1; i < onsets.length; i++) {
      const a = lands[i - 1];
      const b = lands[i];
      const r = riseFor(onsets[i - 1].dur, refDt, 150, 22, maxRise);
      if (r.clamped) clamped++;
      arcs.push(solveArc(a, b, onsets[i - 1].t, onsets[i - 1].dur, Math.min(a.y, b.y) - r.rise));
    }
    // Each bar leans so the ball bounces off it toward the next note, as a real bounce would (the
    // keyboard stays flat, and so does the last bar, where the ball comes to rest).
    const normals = lands.map((_, i): Pt => {
      if (kb || i + 1 >= arcs.length) return { x: 0, y: -1, z: 0 };
      const vin = arcAt(arcs[i], Infinity);
      const out = arcs[i + 1];
      return bounceNormal(vin, { x: out.vx, y: out.vy, z: out.vz }, MAX_TILT);
    });

    // The bass ball joins on the second time through the tune, or halfway if it plays once.
    const bass: BassNote[] = [];
    const bassArcs: Arc[] = [];
    let bassEnterAt = Infinity;
    const bassMidis = [...new Set(onsets.flatMap((o) => (o.bass.length ? [o.bass[0]] : [])))].sort((a, b) => a - b);
    const bassPads = bassMidis.map((midi, i) => ({ midi, x: bassMidis.length === 1 ? 540 : 200 + (i / (bassMidis.length - 1)) * 680 }));
    if (p.bassBall && bassPads.length) {
      const second = onsets.find((o) => o.pass === 1);
      const from = p.bassEntry === 'quarter' ? LEAD_S + span * 0.22 : second ? second.t : LEAD_S + span * 0.45;
      const timed = onsets.filter((o) => o.bass.length && o.t >= from + 0.6);
      timed.forEach((o, i) => {
        const end = i + 1 < timed.length ? timed[i + 1].t : o.t + o.dur;
        bass.push({ t: o.t, dur: end - o.t, midi: o.bass[0], x: bassPads.find((b) => b.midi === o.bass[0])!.x });
      });
      if (bass.length) {
        const padY = BASS_Y - BASS_R;
        bassEnterAt = bass[0].t - 0.7;
        bassArcs.push(solveArc({ x: bass[0].x, y: -80, z: 0 }, { x: bass[0].x, y: padY, z: 0 }, bassEnterAt, 0.7, -80));
        const bassRef = [...bass].sort((a, b) => a.dur - b.dur)[bass.length >> 1].dur;
        for (let i = 1; i < bass.length; i++) {
          const r = riseFor(bass[i - 1].dur, bassRef, 110, 30, 200);
          bassArcs.push(solveArc({ x: bass[i - 1].x, y: padY, z: 0 }, { x: bass[i].x, y: padY, z: 0 }, bass[i - 1].t, bass[i - 1].dur, padY - r.rise));
        }
      }
    }

    const last = onsets[onsets.length - 1];
    return {
      p,
      title: melody.title,
      composer: melody.composer,
      onsets,
      lands,
      normals,
      theta,
      arcs,
      bass,
      bassArcs,
      bassEnterAt,
      bassPads,
      kb,
      hueShift: rng.int(0, 11),
      tempo,
      passes,
      clamped,
      revealAt: last.t + REVEAL_DELAY_S,
      next: 0,
      nextBass: 0,
      nextBreak: 0,
      started: false,
      bassEntered: false,
      revealed: false,
      t: 0,
      visual,
      fxRng,
      theme,
      sparks: [],
      sparks3: [],
      ripples: [],
      lastHit: new Map(),
      lastBassHit: new Map(),
    };
  },

  step(s, { dt, t, emit }) {
    const end = t + dt;
    if (!s.started) {
      s.started = true;
      emit({ type: 'start', tempo: s.tempo, passes: s.passes, notes: s.onsets.length, clamped: s.clamped });
    }
    while (s.next < s.onsets.length && s.onsets[s.next].t < end) {
      const o = s.onsets[s.next];
      const at = s.lands[s.next];
      const voice = s.p.voice === 'theme' ? {} : { voice: s.p.voice };
      emit({ type: 'land', i: s.next, midi: o.midi, dur: o.dur, accent: o.bass.length > 0, pan: ((at.x - 540) / 540) * 0.6, ...voice });
      if (s.visual) {
        s.lastHit.set(o.midi, o.t);
        const c = contactAt(s, s.next);
        const col = lighten(noteColor(s.theme, s, o.midi), 0.3);
        if (is3D(s.p.style)) burst3(s, c, o.bass.length ? 14 : 8, 380, () => col);
        else {
          s.ripples.push({ x: c.x, y: c.y, t0: o.t, midi: o.midi, a: tiltOf(s.normals[s.next]) });
          burst(s.sparks, s.fxRng, c.x, c.y, o.bass.length ? 12 : 7, 360, rgbToCss(col), 7);
        }
      }
      s.next++;
    }
    if (!s.bassEntered && s.bassEnterAt < end) {
      s.bassEntered = true;
      emit({ type: 'bassEnter' });
    }
    while (s.nextBass < s.bass.length && s.bass[s.nextBass].t < end) {
      const b = s.bass[s.nextBass];
      emit({ type: 'bassLand', midi: b.midi, dur: b.dur, pan: ((b.x - 540) / 540) * 0.5 });
      if (s.visual) s.lastBassHit.set(b.midi, b.t);
      s.nextBass++;
    }
    if (!s.revealed && s.revealAt < end) {
      s.revealed = true;
      emit({ type: 'reveal' });
      if (s.visual) {
        const at = s.lands[s.lands.length - 1];
        if (is3D(s.p.style)) burst3(s, at, 140, 1300, () => paletteAt(s.theme.palette, s.fxRng.next()));
        else burst(s.sparks, s.fxRng, at.x, at.y, 90, 1300, () => rgbToCss(paletteAt(s.theme.palette, s.fxRng.next())), 9);
      }
    }
    if (s.visual) {
      // Cascade blocks shatter just after the ball leaves them.
      if (s.p.style !== 'keys') {
        // (Not the last one: the ball comes to rest there.)
        while (s.nextBreak < s.onsets.length - 1 && s.onsets[s.nextBreak].t + BREAK_DELAY_S < end) {
          const c = contactAt(s, s.nextBreak);
          const col = noteColor(s.theme, s, s.onsets[s.nextBreak].midi);
          if (is3D(s.p.style)) burst3(s, { ...c, y: c.y + BLOCK_H / 2 }, 22, 420, () => col);
          else burst(s.sparks, s.fxRng, c.x, c.y + BLOCK_H / 2, 16, 420, rgbToCss(col), 11);
          s.nextBreak++;
        }
      }
      s.sparks = updateSparks(s.sparks, dt, 1700);
      if (s.sparks3.length) {
        for (const q of s.sparks3) {
          q.vy += 1700 * dt;
          q.x += q.vx * dt;
          q.y += q.vy * dt;
          q.z += q.vz * dt;
          q.life -= dt;
        }
        if (s.sparks3.some((q) => q.life <= 0)) s.sparks3 = s.sparks3.filter((q) => q.life > 0);
      }
      if (s.ripples.length && end - s.ripples[0].t0 > 0.6) s.ripples.shift();
    }
    s.t = end;
  },

  isDone(s) {
    return s.t >= s.revealAt + REVEAL_S;
  },

  hud(s) {
    return { answer: s.title, composer: s.composer, notes: s.next, outro: s.t >= s.revealAt + OUTRO_DELAY_S };
  },

  overlays(_p, copy) {
    // The question stays up for the whole tune and hands over to the CTA (same spot) at the reveal.
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 600, y: 0.12, untilOutro: true },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.12 },
    ];
  },

  render({ ctx, theme, t }, s) {
    const cam = cameraY(s, t);
    const sy = (y: number) => y - cam;
    const revealK = t >= s.revealAt ? t - s.revealAt : -1;

    const three = is3D(s.p.style);
    if (three) drawCascade3D(ctx, theme, s, t, revealK);
    else if (s.kb) drawKeyboard(ctx, theme, s, t, revealK);
    else drawBlocks(ctx, theme, s, t, cam, revealK);
    drawBassRail(ctx, theme, s, t);

    // Ripples where the ball lands, in the note's colour.
    for (const r of s.ripples) {
      const u = (t - r.t0) / 0.55;
      if (u < 0 || u > 1) continue;
      ctx.strokeStyle = rgbToCss(lighten(noteColor(theme, s, r.midi), 0.3), 0.7 * (1 - u));
      ctx.lineWidth = 6 * (1 - u) + 1;
      ctx.beginPath();
      ctx.ellipse(r.x, sy(r.y), 24 + 90 * u, 8 + 26 * u, r.a, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(0, -cam);
    drawSparks(ctx, s.sparks);
    ctx.restore();

    if (!three) drawBall(ctx, theme, s, s.arcs, s.onsets, t, cam, BALL_R, true);
    if (t >= s.bassEnterAt) drawBall(ctx, theme, s, s.bassArcs, s.bass, t, 0, BASS_R, false);

    if (revealK >= 0 && revealK < 0.6) {
      ctx.fillStyle = `rgba(255,255,255,${(0.35 * (1 - revealK / 0.6)).toFixed(3)})`;
      ctx.fillRect(0, 0, 1080, 1920);
    }
  },

  renderTop({ ctx, theme, t }, s) {
    drawProgress(ctx, theme, s, t);
    if (t >= s.revealAt) {
      const since = t - s.revealAt - 0.2;
      const lines = splitTitle(s.title.toUpperCase());
      const size = lines.length > 1 ? 70 : 80;
      lines.forEach((line, i) => drawAnswer(ctx, theme, line, 540, ANSWER_Y + (i - (lines.length - 1) / 2) * size * 1.1, since - i * 0.08, size));
      const a = Math.min(1, Math.max(0, (since - 0.35) / 0.3));
      if (a > 0) {
        ctx.save();
        ctx.globalAlpha = a;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `800 40px ${FONT_FAMILY}`;
        ctx.lineWidth = 6;
        ctx.strokeStyle = theme.textStroke;
        const by = ANSWER_Y + (lines.length / 2) * size * 1.1 + 34;
        ctx.strokeText(s.composer, 540, by);
        ctx.fillStyle = theme.accent;
        ctx.fillText(s.composer, 540, by);
        ctx.restore();
      }
      return;
    }
    const first = s.onsets[0].t;
    const promptFrom = first + (s.revealAt - first) * 0.5;
    if (t >= promptFrom) drawCommentPrompt(ctx, theme, t - promptFrom, s.revealAt - t, PROMPT);
  },

  audio(e, { theme }) {
    const pan = typeof e.pan === 'number' ? e.pan : 0;
    switch (e.type) {
      case 'land': {
        // Notes are held for their written length (a little more, so they ring into the next).
        const dur = Math.max(0.25, Math.min(2.5, (e.dur as number) * 1.6));
        const voice: VoiceId = (e.voice as VoiceId | undefined) ?? theme.voice;
        return [{ kind: 'note', midi: e.midi as number, vel: e.accent ? 0.82 : 0.66, voice, dur, pan }];
      }
      case 'bassLand': {
        const midi = (e.midi as number) >= 48 ? (e.midi as number) - 12 : (e.midi as number);
        const dur = Math.max(0.4, Math.min(3, (e.dur as number) * 1.2));
        return [
          { kind: 'note', midi, vel: 0.5, voice: 'softsine', dur, pan },
          { kind: 'note', midi: midi + 12, vel: 0.18, voice: 'pluck', dur: 0.5, pan },
        ];
      }
      case 'bassEnter':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.45 }];
      case 'reveal':
        return [
          { kind: 'sfx', name: 'chime', vel: 0.9 },
          { kind: 'sfx', name: 'whoosh', vel: 0.5 },
        ];
    }
    return [];
  },

  score(events, { durationS, targetS }): DramaScore {
    const start = events.find((e) => e.type === 'start');
    const lands = events.filter((e) => e.type === 'land').length;
    const durFit = gaussFit(durationS, targetS, targetS * 0.18);
    if (!start || !lands) return { total: 0, parts: { durFit }, notes: ['no notes played'] };
    const tempoFit = gaussFit(dm.log(start.tempo as number), 0, 0.25);
    const clampFit = 1 - 0.5 * Math.min(1, (start.clamped as number) / lands);
    const rate = lands / durationS;
    const densityFit = rate < 1 ? rate : rate > 7 ? dm.exp(-(rate - 7) / 3) : 1;
    const total = durFit * (0.7 + 0.3 * tempoFit) * clampFit * (0.8 + 0.2 * densityFit);
    return {
      total,
      parts: { durFit, tempoFit, clampFit, densityFit },
      notes: [`${lands} notes, ${start.passes} pass${start.passes === 1 ? '' : 'es'}`, `tempo ×${(start.tempo as number).toFixed(2)}`],
    };
  },
};

/** Long titles on two lines, split at the space nearest the middle. */
function splitTitle(title: string): string[] {
  if (title.length <= 16) return [title];
  const mid = title.length / 2;
  let best = -1;
  for (let i = 0; i < title.length; i++) if (title[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? [title] : [title.slice(0, best), title.slice(best + 1)];
}

/** A 2D bar's clockwise rotation for its normal (0 = flat). */
const tiltOf = (n: Pt) => Math.atan2(n.x, -n.y);

/** 3D spark burst at p (sim space), for the three.js styles. Visual only. */
function burst3(s: State, p: Pt, n: number, power: number, color: () => RGB) {
  for (let k = 0; k < n; k++) {
    // A random direction on the sphere, biased upward so bursts spray off the bar.
    const u = s.fxRng.range(-1, 0.4);
    const a = s.fxRng.range(0, Math.PI * 2);
    const h = Math.sqrt(1 - u * u);
    const v = s.fxRng.range(0.25, 1) * power;
    const life = s.fxRng.range(0.5, 1.3);
    s.sparks3.push({ x: p.x, y: p.y, z: p.z, vx: h * Math.cos(a) * v, vy: u * v, vz: h * Math.sin(a) * v, life, maxLife: life, col: color() });
  }
}

/** How lit a key/block is: a flash when struck, fading over ~0.4 s. */
export const glow = (since: number) => (since < 0 ? 0 : Math.exp(-since * 6));

function drawKeyboard(ctx: Ctx2D, theme: Theme, s: State, t: number, revealK: number) {
  const kb = s.kb!;
  const w = kb.keyW;
  const width = kb.whiteIndex.size * w;
  // Case behind the keys, with an accent rim along the top.
  ctx.fillStyle = 'rgba(8,6,16,0.75)';
  ctx.beginPath();
  ctx.roundRect(kb.x0 - 14, KEY_TOP - 18, width + 28, WHITE_H + 32, 16);
  ctx.fill();
  ctx.fillStyle = theme.accent;
  ctx.globalAlpha = 0.8;
  ctx.fillRect(kb.x0 - 14, KEY_TOP - 18, width + 28, 5);
  ctx.globalAlpha = 1;

  const lit = (midi: number, x: number) => {
    let l = glow(t - (s.lastHit.get(midi) ?? -10));
    if (revealK >= 0) l = Math.max(l, 0.7 * Math.exp(-revealK * 0.9) * (0.5 + 0.5 * dm.sin(9 * revealK - x / 70)));
    return l;
  };
  const drawKey = (midi: number, x: number, kw: number, h: number, base: RGB) => {
    const l = lit(midi, x);
    const col = noteColor(theme, s, midi);
    const press = 7 * glow(t - (s.lastHit.get(midi) ?? -10));
    ctx.fillStyle = rgbToCss(mixRgb(base, col, Math.min(1, l * 1.3)));
    ctx.beginPath();
    ctx.roundRect(x + 2, KEY_TOP + press, kw - 4, h, [0, 0, 8, 8]);
    ctx.fill();
    // Each key carries a thin strip of its note colour, so the colours are learnable before they light.
    ctx.fillStyle = rgbToCss(col, 0.35 + 0.65 * l);
    ctx.fillRect(x + 2, KEY_TOP + press + h - 14, kw - 4, 6);
  };
  for (const [midi, i] of kb.whiteIndex) drawKey(midi, kb.x0 + i * w, w, WHITE_H, [178, 176, 188]);
  for (let m = kb.lo; m <= kb.hi; m++) {
    if (!isBlack(m)) continue;
    const bw = w * 0.62;
    drawKey(m, keyX(kb, m) - bw / 2, bw, BLACK_H, [26, 24, 38]);
  }
}

function drawBlocks(ctx: Ctx2D, theme: Theme, s: State, t: number, cam: number, revealK: number) {
  const nextIdx = landedIndex(s.onsets, t) + 1;
  for (let i = Math.max(0, nextIdx - 2); i < s.onsets.length; i++) {
    const o = s.onsets[i];
    if (t > o.t + BREAK_DELAY_S && i < s.onsets.length - 1) continue;
    const c = contactAt(s, i);
    const y = c.y - cam;
    if (y > 1500) break;
    // Fade in from the bottom, clear of the bass rail.
    const fade = Math.min(1, Math.max(0, (1500 - y) / 160));
    const col = noteColor(theme, s, o.midi);
    let l = glow(t - o.t);
    if (i === nextIdx) l = Math.max(l, 0.25 + 0.15 * dm.sin(t * 10));
    if (revealK >= 0) l = Math.max(l, 0.8 * Math.exp(-revealK));
    // The bar's top surface passes through the contact point, leaning along its normal.
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(c.x, y);
    ctx.rotate(tiltOf(s.normals[i]));
    ctx.fillStyle = rgbToCss(lighten(col, 0.1 + 0.6 * l), 0.82 + 0.18 * l);
    ctx.beginPath();
    ctx.roundRect(-BLOCK_W / 2, 0, BLOCK_W, BLOCK_H, 9);
    ctx.fill();
    ctx.fillStyle = rgbToCss(lighten(col, 0.65), 0.9);
    ctx.fillRect(-BLOCK_W / 2 + 8, 3, BLOCK_W - 16, 4);
    ctx.restore();
  }
}

function drawBassRail(ctx: Ctx2D, theme: Theme, s: State, t: number) {
  if (!s.bass.length) return;
  const a = Math.min(1, Math.max(0, (t - s.bassEnterAt + 0.6) / 0.5));
  if (a <= 0) return;
  ctx.globalAlpha = a;
  ctx.fillStyle = 'rgba(8,6,16,0.6)';
  ctx.beginPath();
  ctx.roundRect(160, BASS_Y - 10, 760, PAD_H + 26, 14);
  ctx.fill();
  for (const pad of s.bassPads) {
    const l = glow(t - (s.lastBassHit.get(pad.midi) ?? -10));
    const col = noteColor(theme, s, pad.midi);
    ctx.fillStyle = rgbToCss(lighten(col, 0.1 + 0.6 * l), 0.55 + 0.45 * l);
    ctx.beginPath();
    ctx.roundRect(pad.x - PAD_W / 2, BASS_Y + 3 * l, PAD_W, PAD_H, 8);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** A ball with a short trail, squashed for a moment after each landing and coloured for the note it's heading to. */
function drawBall(ctx: Ctx2D, theme: Theme, s: State, arcs: Arc[], onsets: { t: number; midi?: number }[], t: number, cam: number, r: number, lead: boolean) {
  if (!arcs.length) return;
  const i = landedIndex(onsets, t);
  const target = onsets[Math.min(onsets.length - 1, i + 1)] as { midi?: number };
  const col = noteColor(theme, s, target.midi ?? 60);
  const trail = Math.round(14 * Math.min(1, theme.trail));
  for (let k = trail; k >= 1; k--) {
    const pt = ballAt(arcs, onsets, t - k * 0.014);
    const u = 1 - k / (trail + 1);
    ctx.fillStyle = rgbToCss(col, 0.3 * u);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y - cam, r * (0.4 + 0.55 * u), 0, Math.PI * 2);
    ctx.fill();
  }
  const pt = ballAt(arcs, onsets, t);
  const since = i >= 0 ? t - onsets[i].t : 10;
  const sq = 0.3 * Math.exp(-since * 22);
  const stretch = Math.min(0.18, Math.abs(pt.vy) / 9000);
  const rx = r * (1 + sq - stretch * 0.5);
  const ry = r * (1 - sq + stretch);
  ctx.fillStyle = lead ? theme.ball : rgbToCss(lighten(col, 0.55));
  ctx.strokeStyle = rgbToCss(lighten(col, 0.2));
  ctx.lineWidth = lead ? 7 : 5;
  ctx.beginPath();
  ctx.ellipse(pt.x, pt.y - cam + r * sq, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/** A thin bar that fills toward the reveal, with a lock at the end that opens. */
function drawProgress(ctx: Ctx2D, theme: Theme, s: State, t: number) {
  const first = s.onsets[0].t;
  const u = Math.min(1, Math.max(0, (t - first) / (s.revealAt - first)));
  // Makes way for the CTA, which can run to two lines.
  const alpha = Math.min(1, Math.max(0, 1 - (t - s.revealAt - OUTRO_DELAY_S) / 0.25));
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const x0 = 540 - PROGRESS.w / 2 - 24;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.roundRect(x0, PROGRESS.y - 7, PROGRESS.w, 14, 7);
  ctx.fill();
  if (u > 0) {
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.roundRect(x0, PROGRESS.y - 7, Math.max(14, PROGRESS.w * u), 14, 7);
    ctx.fill();
  }
  ctx.font = `44px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(u >= 1 ? '🔓' : '🔒', x0 + PROGRESS.w + 40, PROGRESS.y);
  ctx.restore();
}

