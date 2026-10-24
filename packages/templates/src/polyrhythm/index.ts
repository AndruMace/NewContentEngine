import { z } from 'zod';
import { FONT_FAMILY, FPS, VOICES, lighten, paletteAt, rgbToCss, type Ctx2D, type DramaScore, type RGB, type Template, type VoiceId } from '@sim/engine';
import { gaussFit } from '../scoring';
import { SCALES, scaleNote, type ScaleName } from '../music';
import * as dm from '@sim/physics/math';
import { PATTERNS, patternRates, polygonSides } from './patterns';
import { drawPendulums3D } from './pendulum3d';
import { FIGURES, buildEpicycles, drawEpicycles, type Epicycles, type Figure } from './epicycles';
import { MAX_LISSAJOUS, drawLissajous, lissajousColumnX } from './lissajous';
import { MAX_PLANETS, drawOrrery, orbitRadius } from './orrery3d';
import { drawRipples, ripplePan, rippleSyncS } from './ripples';
import { MAX_GEARS, buildGearTrain, reachableRates, trainExtent, type Arbor } from './gears';
import { drawGears } from './gears3d';
import { MAX_LIGHTHOUSES, drawLighthouses, lighthousePan } from './lighthouse3d';

export const POLYRHYTHM_STYLES = ['arcs', 'pendulum-wave', 'polygons', 'string-art', 'piano', 'pendulum-3d', 'orrery', 'lissajous', 'fourier', 'ripples', 'gears', 'lighthouse'] as const;
export type PolyrhythmStyle = (typeof POLYRHYTHM_STYLES)[number];

/** Sidebar rule: show a setting only for the styles it affects. */
const onlyFor = (...styles: PolyrhythmStyle[]) => ({ showWhen: { style: styles } });

export const polyrhythmSchema = z.object({
  style: z.enum(POLYRHYTHM_STYLES).default('arcs').meta({ title: 'Style' }),
  pattern: z.enum(PATTERNS).default('linear').meta({ title: 'Speed pattern' }),
  count: z.number().int().min(5).max(32).default(18).meta({ title: 'Dots / pendulums (polygons: up to 10)' }),
  loopSeconds: z.number().min(12).max(75).default(36).meta({ title: 'Loop length (s)' }),
  baseCycles: z.number().int().min(1).max(40).default(10).meta({ title: 'Cycles of slowest' }),
  cycleStep: z.number().int().min(1).max(3).default(1).meta({ title: 'Cycle step' }),
  scale: z.enum(['random', ...(Object.keys(SCALES) as ScaleName[])]).default('random').meta({ title: 'Scale' }),
  rootNote: z.number().int().min(36).max(72).default(55).meta({ title: 'Root note (MIDI)' }),
  hitVolume: z.number().min(0.1).max(1).default(0.45).meta({ title: 'Note volume', step: 0.05 }),
  voice: z.enum(['theme', ...VOICES]).default('theme').meta({ title: 'Instrument (theme = the theme\'s own)' }),
  notes: z.enum(['scale', 'chord', 'chord7']).default('scale').meta({ title: 'Notes (chord: root, 3rd and 5th only; chord7 adds the 7th)' }),
  pitchRange: z.number().min(1).max(5).default(3.5).meta({ title: 'Pitch range (octaves above the root)', step: 0.5 }),
  soften: z.number().min(0).max(1).default(0.5).meta({ title: 'Soften high notes', step: 0.05 }),
  figure: z.enum(['random', ...FIGURES]).default('random').meta({ title: 'Figure', ...onlyFor('fourier') }),
  orreryStart: z.enum(['aligned', 'scattered']).default('aligned').meta({ title: 'Planets start (scattered: they align only at the end)', ...onlyFor('orrery') }),
  rippleLife: z.number().min(1).max(8).default(2.8).meta({ title: 'Ripple lifetime (s)', step: 0.1, ...onlyFor('ripples') }),
  stringBrightness: z.number().min(0.1).max(2).default(1).meta({ title: 'String brightness', step: 0.05, ...onlyFor('string-art') }),
  stringLife: z.number().min(0).max(15).default(0).meta({ title: 'String lifetime (s, 0 = build up all loop)', step: 0.5, ...onlyFor('string-art') }),
  gearFlash: z.boolean().default(true).meta({ title: 'Flash each gear as it rings', ...onlyFor('gears') }),
  gearLinks: z.boolean().default(true).meta({ title: 'Link gears that ring together', ...onlyFor('gears') }),
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
  /**
   * Scale degree each element plays: slowest lowest, fitted into the pitch range (and onto chord
   * tones when asked).
   */
  degree: number[];
  /** Each element's share of the note volume. */
  vel: number[];
  /** Fourier: the circles and the figure they draw. */
  epi?: Epicycles;
  /** Gears: the train's arbors (empty for other styles). Element i turns on the arbor whose element is i. */
  arbors: Arbor[];
  /**
   * Seconds the final sync is held after the loop (0: the video loops seamlessly). Styles that build
   * to a finish (a drawing completing, planets coming into line) end on the sync chord and hold it.
   */
  holdS: number;
  /**
   * Seconds into the loop of the sync (0: the video opens on it). Every beat is shifted by it, so the
   * loop stays seamless: ripples open with every drop already falling and land together just after.
   */
  syncS: number;
  /** With a hold: beats per loop (may be fractional) and where in its beat each element starts. */
  beatRate: number[];
  beatOffset: number[];
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
/** How long a style that builds to its finish holds the final sync. */
const HOLD_S = 2;
const DEFAULT_COPY = {
  hook: 'Wait for them to line up again…',
  cta: 'It loops perfectly. Watch again 🔁',
};
/** Default copy for the finishes that don't loop (the seamless-loop lines would be untrue). */
const HELD_COPY: Partial<Record<PolyrhythmStyle, typeof DEFAULT_COPY>> = {
  orrery: { hook: 'Wait for the planets to align…', cta: 'Perfect alignment ✨ Watch again 🔁' },
  fourier: { hook: 'Watch what the circles draw…', cta: 'Every circle in sync ✨ Watch again 🔁' },
};
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
  orrery: 'a 3D orrery: planets circling a sun at whole-number laps, a note each time one crosses the alignment beam, all aligned again at the end',
  lissajous: 'a Lissajous table: orbiting dots along the top and side, every cell tracing the curve made by its row and column, all closing at the end',
  fourier: 'a chain of spinning circles (Fourier epicycles) whose pen draws a figure (heart, star, flower, infinity, butterfly) over the video, finishing exactly as everything lines up; each circle is a clock face that rings as its arm sweeps past each tick. "Watch what it draws" / "guess the shape" angles work',
  gears: 'a 3D brass clockwork movement: a compound gear train (wheels in two layers on shared arbors, as in a real clock), each ringing gear turning a whole number of times per loop; each wears a coloured clock hand that starts pointing straight up and rings every time it comes back up, and every hand points up together at the end. "When will every hand point up again?" angles work',
  lighthouse: 'lighthouses round a bay at night, their beams sweeping at different speeds; each flashes and rings its note when its beam swings round to face you, and they all flash together at the end',
  ripples: 'a ring of drops hanging from a rail over still water; each swells on its tip (its size shows when it will fall), falls and lands with a note and a ripple; the video opens with every drop falling together, and ends as they all let go together again',
};

/** How many elements a style shows (some layouts only read up to a point). */
function elementCount(style: PolyrhythmStyle, count: number): number {
  switch (style) {
    case 'polygons':
      return Math.min(MAX_POLYGONS, count);
    case 'orrery':
      return Math.min(MAX_PLANETS, count);
    case 'gears':
      return Math.min(MAX_GEARS, count);
    case 'lighthouse':
      return Math.min(MAX_LIGHTHOUSES, count);
    case 'lissajous':
      // Circles per side: the count is shared between the top row and the side column.
      return Math.max(3, Math.min(MAX_LISSAJOUS, Math.round(count / 2)));
    case 'piano':
    case 'pendulum-3d':
      return Math.min(MAX_LANES, count);
    default:
      return count;
  }
}

export const polyrhythm: Template<PolyrhythmParams, State> = {
  id: 'polyrhythm',
  name: 'Polyrhythm Sync',
  family: 'kinetic',
  category: 'machines',
  description: `A polyrhythm visual: every element moves at its own whole-number rate and plays a note on each beat, so they drift into patterns and all line up again exactly at the end; the video loops seamlessly. Styles: ${POLYRHYTHM_STYLES.map((k) => `${k} (${STYLE_TEXT[k]})`).join('; ')}. Speed patterns: linear (even spread), harmonic (multiples, like overtones), primes (few partial lineups, one big one at the end), mirror (slowest in the middle, symmetric twins), random.`,
  schema: polyrhythmSchema,
  lengthParam: { param: 'loopSeconds', offsetS: 0 },
  substeps: 4,
  searchBudget: 24,
  ownMusic: true,
  seamlessLoop: true,
  // Polished clockwork glares under full glow.
  glowScale: (p) => (p.style === 'gears' ? 0.35 : 0.8),
  defaultCopy: DEFAULT_COPY,
  nudges: ['Comment the second they sync 👇', 'Rate this rhythm 1–10 👇', 'Which dot is your favourite? 👇', 'Can you hear the pattern? 👇', 'Guess when they line up 👇', 'Rate the sync moment 👇'],

  init({ params: p, rng }) {
    // Drawn even when a scale is chosen, so the rest of the seed (gear layout, random speeds, colours)
    // stays the same whichever scale plays.
    const randomScale = rng.pick(Object.keys(SCALES) as ScaleName[]);
    const scale = p.scale === 'random' ? randomScale : p.scale;
    const n = elementCount(p.style, p.count);
    let cycles = patternRates(p.pattern, n, p.baseCycles, p.cycleStep, rng);
    let sides: number[] = [];
    let notesPerLoop: number[];
    let degree = cycles.map((_, i) => i);
    let vel = cycles.map(() => 1);
    let epi: Epicycles | undefined;
    let arbors: Arbor[] = [];
    let holdS = 0;
    let syncS = 0;
    let beatOffset: number[] | undefined;
    switch (p.style) {
      case 'polygons': {
        // Each shape's dot laps at its own whole-number rate (so the dots drift apart and meet again at
        // the top corner at the end) and pings every corner it passes.
        sides = polygonSides(p.pattern, n, p.cycleStep, rng);
        cycles = patternRates(p.pattern === 'mirror' ? 'linear' : p.pattern, n, Math.max(1, Math.round(p.baseCycles / 4)), 1, rng);
        notesPerLoop = sides.map((k, i) => k * cycles[i]);
        break;
      }
      case 'lissajous': {
        // One run of rates dealt alternately to the columns and the rows, so every circle has its own
        // rate (and note: they climb the scale column, row, column…). Each dot rings at the top and
        // bottom of its circle.
        const rates = patternRates(p.pattern, 2 * n, Math.max(1, Math.round(p.baseCycles / 2)), p.cycleStep, rng);
        const order = [...rates.keys()].filter((k) => k % 2 === 0).concat([...rates.keys()].filter((k) => k % 2 === 1));
        cycles = order.map((k) => rates[k]);
        notesPerLoop = cycles.map((c) => 2 * c);
        degree = order;
        vel = cycles.map(() => 1);
        break;
      }
      case 'fourier': {
        // The circles turn as the figure's Fourier series says (the drawing appears once over the
        // loop); their ticks come from the speed pattern, biggest circle slowest.
        const figure: Figure = p.figure === 'random' ? rng.pick([...FIGURES]) : p.figure;
        epi = buildEpicycles(figure, p.count, (k) => patternRates(p.pattern, k, p.baseCycles, p.cycleStep, rng));
        const e = epi;
        cycles = e.arms.map((a) => Math.abs(a.freq));
        notesPerLoop = e.arms.map((a, i) => Math.abs(a.freq) * e.ticks[i]);
        // Fewest notes lowest; small circles quieter.
        const bySpeed = notesPerLoop.map((c, i) => [c, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        degree = notesPerLoop.map(() => 0);
        bySpeed.forEach(([, i], rank) => (degree[i] = rank));
        vel = e.arms.map((a) => 0.5 + 0.5 * Math.sqrt(a.amp / e.arms[0].amp));
        holdS = HOLD_S;
        break;
      }
      case 'orrery':
        notesPerLoop = cycles.slice(); // one note per lap
        if (p.orreryStart === 'scattered') {
          // Each planet gets part of an extra lap, so they start spread round their orbits and come
          // into line only at the very end (the video ends on the alignment, not a seamless loop).
          const spread = rng.range(0, 1);
          beatOffset = cycles.map((_, i) => 0.12 + 0.76 * frac(spread + i * 0.6180339887));
          holdS = HOLD_S;
        }
        break;
      case 'gears': {
        // A compound gear train built so each ringing arbor turns exactly its element's rate (the speed
        // pattern, as in every other style); one note per turn as its hand comes back up. Elements the
        // layout can't fit drop out (normally none), the rest keeping their order. Speeds no clock train
        // can reach (a prime factor above 72) are nudged to the nearest one that can.
        cycles = reachableRates(cycles);
        const train = buildGearTrain(cycles, rng);
        const keep = cycles.map((_, i) => i).filter((i) => !train.dropped.includes(i));
        for (const a of train.arbors) if (a.element >= 0) a.element = keep.indexOf(a.element);
        arbors = train.arbors;
        cycles = keep.map((i) => cycles[i]);
        notesPerLoop = cycles.slice();
        degree = cycles.map((_, i) => i);
        vel = cycles.map(() => 1);
        break;
      }
      case 'lighthouse':
        notesPerLoop = cycles.slice(); // one flash per turn, as the beam faces the camera
        break;
      case 'ripples':
        // One note per drop. The landings are shifted a moment into the loop, so it opens (and ends)
        // with every drop in the air together.
        notesPerLoop = cycles.slice();
        syncS = rippleSyncS(notesPerLoop, p.loopSeconds);
        break;
      case 'string-art':
      case 'piano':
        notesPerLoop = cycles.slice(); // one note per lap / bounce
        break;
      default:
        notesPerLoop = cycles.map((c) => 2 * c); // a note at each end of the swing
    }
    const offsets = beatOffset ?? notesPerLoop.map(() => 0);
    degree = pitchDegrees(degree, scale, p.pitchRange, p.notes);
    return {
      p,
      scale,
      cycles,
      notesPerLoop,
      sides,
      degree,
      vel,
      epi,
      arbors,
      holdS,
      syncS,
      beatRate: notesPerLoop.map((m, i) => m + offsets[i]),
      beatOffset: offsets,
      hits: cycles.map(() => -1),
      flash: cycles.map(() => 0),
      t: 0,
      colorShift: rng.range(0, 0.2),
    };
  },

  step(s, { dt, t, emit }) {
    const T = s.p.loopSeconds;
    const t1 = Math.min(T, t + dt);
    const voice = s.p.voice === 'theme' ? {} : { voice: s.p.voice };
    for (let i = 0; i < s.notesPerLoop.length; i++) {
      // Notes fall at k * T / notesPerLoop. hits starts at -1 so every element sounds at t=0 (the
      // sync chord opens the video); the note at exactly t=T is the next loop's t=0, so it is skipped.
      // With a sync shift they fall at syncS + k · T / notesPerLoop. With a hold, notes fall at
      // (k + offset) · T / beatRate and the one at exactly t=T is the finale, so it plays.
      const m = s.notesPerLoop[i];
      const k = s.holdS ? Math.floor((s.beatRate[i] * t1) / T - s.beatOffset[i] + 1e-9) : Math.min(Math.floor((m * (t1 - s.syncS)) / T + 1e-9), m - 1);
      while (s.hits[i] < k) {
        s.hits[i]++;
        s.flash[i] = 1;
        // Slowest element = lowest note.
        const midi = scaleNote(s.scale, s.p.rootNote, s.degree[i]);
        // High notes cut through, so they come in quieter and darker (by the soften setting).
        const soft = s.p.soften * Math.max(0, Math.min(1, (midi - SOFT_FROM) / SOFT_SPAN));
        emit({ type: 'hit', i, k: s.hits[i], side: panFor(s, i), midi, vel: s.p.hitVolume * s.vel[i] * (1 - 0.6 * soft), ...(soft > 0 ? { bright: 1 - 0.85 * soft } : {}), ...voice });
      }
      s.flash[i] *= dm.exp(-6 * dt);
    }
    s.t = t + dt;
  },

  isDone(s) {
    return s.t >= s.p.loopSeconds + s.holdS - 1e-9;
  },

  hud(s) {
    // Runs down to the next sync: with a shift, the opening one, then the one just after the loop
    // ends (which the replay shows), so the counter loops too.
    const left = Math.max(0, (s.t < s.syncS ? s.syncS : s.p.loopSeconds + s.syncS) - s.t);
    return { syncIn: `${left.toFixed(1)}s`, outro: false };
  },

  overlays(p, copy) {
    // The piano's keys sit low, so its end card goes up top.
    // The Lissajous table runs down past the usual spot, so its end card sits below it.
    // The Fourier drawing fills the middle, so its end card sits below it.
    const ctaY = p.style === 'piano' ? 0.33 : p.style === 'lissajous' || p.style === 'fourier' ? 0.88 : 0.74;
    const hold = holdFor(p);
    const end = p.loopSeconds;
    // Held finishes swap in their own lines when the copy is still the template's default.
    const held = hold ? HELD_COPY[p.style] : undefined;
    if (held) copy = { ...copy, hook: copy.hook === DEFAULT_COPY.hook ? held.hook : copy.hook, cta: copy.cta === DEFAULT_COPY.cta ? held.cta : copy.cta };
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 3, y: 0.13 },
      { kind: 'counter', key: 'syncIn', label: 'NEXT SYNC IN', y: 0.24, size: 84 },
      // A held finish shows the card from just before the sync to the end.
      { kind: 'cta', text: copy.cta, when: hold ? { from: end - 1, to: end + hold + 1 } : { from: p.loopSeconds - 3.2, to: p.loopSeconds + 1 }, y: ctaY },
    ];
  },

  render(rc, s) {
    const { ctx, theme } = rc;
    // A held finish freezes on the sync.
    const t = Math.min(rc.t, s.p.loopSeconds);
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
      case 'orrery':
        return drawOrrery(ctx, theme, s, t);
      case 'lissajous':
        return drawLissajous(ctx, s, t, rc.frame, color);
      case 'fourier':
        return drawEpicycles(ctx, { epi: s.epi!, p: s.p, hits: s.hits, flash: s.flash }, t, rc.frame, color, (u) => paletteAt(theme.palette, (u + s.colorShift) % 1));
      case 'ripples':
        return drawRipples(ctx, theme, s, t, color);
      case 'gears':
        return drawGears(ctx, theme, s, t);
      case 'lighthouse':
        return drawLighthouses(ctx, theme, s, t);
    }
  },

  audio(e, { theme }) {
    if (e.type !== 'hit') return [];
    return [{ kind: 'note', midi: e.midi as number, vel: e.vel as number, voice: (e.voice as VoiceId | undefined) ?? theme.voice, pan: (e.side as number) * 0.35, bright: e.bright as number | undefined }];
  },

  score(events, { durationS, targetS }): DramaScore {
    const hits = events.filter((e) => e.type === 'hit').length;
    const rate = hits / Math.max(1, durationS);
    const rateFit = rate < 4 ? rate / 4 : rate > 22 ? dm.exp(-(rate - 22) / 10) : 1;
    const durFit = gaussFit(durationS, targetS, targetS * 0.25);
    return { total: durFit * (0.6 + 0.4 * rateFit), parts: { durFit, rateFit }, notes: [`${hits} notes (${rate.toFixed(1)}/s)`] };
  },
};

/** Softening of high notes starts at E4 and reaches full strength three octaves up. */
const SOFT_FROM = 64;
const SOFT_SPAN = 36;

/**
 * The scale's chord tones as positions in it: root, 3rd and 5th, plus the 7th when asked for and
 * the scale has one (pentatonic and hirajoshi don't, so they stay triads).
 */
export function chordSteps(scale: ScaleName, seventh: boolean): number[] {
  const iv: readonly number[] = SCALES[scale];
  const at = (...semis: number[]) => iv.findIndex((x) => semis.includes(x));
  const steps = [0, at(3, 4), at(7)];
  if (seventh) steps.push(at(10, 11));
  return steps.filter((k) => k >= 0);
}

/**
 * Scale degrees for elements ranked by pitch (0 = lowest). Up to `range` octaves they climb a step at
 * a time (a step is a scale note, or a chord tone in chord mode); more elements than that are spread
 * evenly across the range, neighbours sharing a note, so a big count never runs up into shrill highs.
 */
export function pitchDegrees(ranks: number[], scale: ScaleName, range: number, notes: PolyrhythmParams['notes']): number[] {
  const chord = notes === 'scale' ? null : chordSteps(scale, notes === 'chord7');
  const perOctave = chord ? chord.length : SCALES[scale].length;
  const limit = Math.max(1, Math.floor(range * perOctave));
  const top = Math.max(0, ...ranks);
  const fitted = top > limit ? ranks.map((r) => Math.round((r * limit) / top)) : ranks;
  if (!chord) return fitted;
  return fitted.map((r) => Math.floor(r / perOctave) * SCALES[scale].length + chord[r % perOctave]);
}

/** Seconds a video with these settings holds its final sync (0: it loops seamlessly). */
function holdFor(p: PolyrhythmParams): number {
  return p.style === 'fourier' || (p.style === 'orrery' && p.orreryStart === 'scattered') ? HOLD_S : 0;
}


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
    case 'orrery':
      // The beam runs to the sun's right; outer planets cross it further out.
      return 0.2 + 0.6 * (orbitRadius(i, n) / orbitRadius(0, n));
    case 'lissajous': {
      const cols = n / 2;
      return i < cols ? (lissajousColumnX(i, cols) - CX) / CX : -0.6;
    }
    case 'fourier': {
      // Where the tick being struck sits on its circle.
      const a = s.epi!.arms[i];
      const m = s.epi!.ticks[i];
      return 0.6 * dm.cos(dm.atan2(a.im, a.re) + (Math.sign(a.freq) * 2 * Math.PI * (s.hits[i] % m)) / m);
    }
    case 'ripples':
      return 0.8 * ripplePan(i, n);
    case 'gears': {
      // Where the gear sits across the train.
      return (0.8 * s.arbors.find((a) => a.element === i)!.x) / trainExtent(s.arbors).w;
    }
    case 'lighthouse':
      return 0.8 * lighthousePan(i, n);
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
  const posAt = (i: number, tt: number): [number, number] => {
    const r = rMin + ((rMax - rMin) * i) / Math.max(1, n - 1);
    const a = -Math.PI / 2 + 2 * Math.PI * frac((s.notesPerLoop[i] * tt) / T);
    return [CX + dm.cos(a) * r, cy + dm.sin(a) * r];
  };
  const pos = (i: number) => posAt(i, t);
  // Every string that passes near the middle paints it (the short inner ones and the long ones
  // between dots on opposite sides), so the centre would burn out: fade strings by how close they
  // pass to it. The brightness setting scales them all.
  const stringAlpha = (ax: number, ay: number, bx: number, by: number) =>
    ART_ALPHA * s.p.stringBrightness * Math.max(0.14, Math.min(1, distToSegment(CX, cy, ax, ay, bx, by) / ART_FALLOFF) ** 1.2);

  if (s.p.stringLife > 0) {
    // With a lifetime: the strings laid in the last `stringLife` seconds (one set per frame, as the
    // build-up draws them), each fading out as it ages. The dots repeat every loop, so the trail at the
    // start carries on from the end's and the loop stays seamless without a fade.
    const life = s.p.stringLife;
    const css = Array.from({ length: n }, (_, i) => rgbToCss(color(i)));
    ctx.lineWidth = 1.2;
    for (let k = Math.ceil((t - life) * FPS - 1e-6); k <= Math.floor(t * FPS + 1e-6); k++) {
      const tau = k / FPS;
      const fade = 1 - (t - tau) / life;
      if (fade <= 0) continue;
      let [ax, ay] = posAt(0, tau);
      for (let i = 0; i + 1 < n; i++) {
        const [bx, by] = posAt(i + 1, tau);
        ctx.strokeStyle = css[i];
        ctx.globalAlpha = fade * stringAlpha(ax, ay, bx, by);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        [ax, ay] = [bx, by];
      }
    }
    ctx.globalAlpha = 1;
  } else {
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
        lc.strokeStyle = rgbToCss(color(i), stringAlpha(ax, ay, bx, by));
        lc.beginPath();
        lc.moveTo(ax, ay);
        lc.lineTo(bx, by);
        lc.stroke();
      }
      layer.lastFrame = frame;
    }
    // The build-up fades out at the very end so the last frame matches the first.
    const fade = Math.min(1, Math.max(0, (T - t) / ART_FADE_S));
    ctx.globalAlpha = fade;
    ctx.drawImage(layer.canvas as CanvasImageSource, 0, 0);
    ctx.globalAlpha = 1;
  }
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
      ctx.fillText(noteName(s.scale, s.p.rootNote, s.degree[i]), x + w / 2, keyTop + press + keyH - 30);
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
