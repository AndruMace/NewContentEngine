import { unitSeconds, type Melody } from '@sim/engine';
import * as dm from '@sim/physics/math';

/** One melody note: when the ball lands on it and what plays. */
export interface Onset {
  /** Landing time (s). */
  t: number;
  /** Time until the next note (s). */
  dur: number;
  midi: number;
  /** The step's other notes (the accompaniment), lowest first. */
  bass: number[];
  /** Which time through the tune (0 = first). */
  pass: number;
}

export interface Timeline {
  onsets: Onset[];
  /** Playback speed relative to the melody's own tempo (above 1 = faster). */
  tempo: number;
  passes: number;
}

/** How far the tempo may stretch either way to land the song on the target length. */
export const TEMPO_RANGE: [number, number] = [0.8, 1.25];
const MAX_PASSES = 8;

/** The key's home pitch class: the lowest note of the first chord. */
export function tonicOf(m: Melody): number {
  const chord = m.steps.find((s) => s.length > 1) ?? m.steps[m.steps.length - 1];
  return Math.min(...chord) % 12;
}

/**
 * The notes to play, starting at `start`: whole phrases in order (looping the tune if needed), ending
 * on a phrase that comes home to the key's tonic, at the tempo (within TEMPO_RANGE) that brings the
 * last note closest to `start + spanS`.
 */
export function buildTimeline(m: Melody, start: number, spanS: number): Timeline {
  const beats = m.beats ?? m.steps.map(() => 1);
  const phrases = m.phrases ?? [0];
  const unitS = unitSeconds(m);
  const tonic = tonicOf(m);
  const ends = phrases.map((p, k) => (k + 1 < phrases.length ? phrases[k + 1] : m.steps.length) - 1);
  const cadence = ends.map((e) => m.steps[e].some((n) => n % 12 === tonic));
  const anyCadence = cadence.some(Boolean);

  let best = { cost: Infinity, steps: 0, tempo: 1 };
  let units = 0;
  let count = 0;
  search: for (let pass = 0; pass < MAX_PASSES; pass++) {
    for (let k = 0; k < phrases.length; k++) {
      for (let i = phrases[k]; i <= ends[k]; i++) {
        units += beats[i];
        count++;
      }
      if (anyCadence && !cadence[k]) continue;
      // Measured to the last note's landing: its own length is the hold before the reveal.
      const natural = (units - beats[ends[k]]) * unitS;
      if (natural <= 0) continue;
      const tempo = Math.min(TEMPO_RANGE[1], Math.max(TEMPO_RANGE[0], natural / spanS));
      const cost = Math.abs(dm.log(natural / tempo / spanS)) + 0.1 * Math.abs(dm.log(tempo));
      if (cost < best.cost) best = { cost, steps: count, tempo };
      if (natural / TEMPO_RANGE[1] > spanS * 1.5) break search;
    }
  }

  const onsets: Onset[] = [];
  let t = start;
  for (let j = 0; j < best.steps; j++) {
    const i = j % m.steps.length;
    const [midi, ...rest] = m.steps[i];
    const dur = (beats[i] * unitS) / best.tempo;
    onsets.push({ t, dur, midi, bass: rest.sort((a, b) => a - b), pass: Math.floor(j / m.steps.length) });
    t += dur;
  }
  return { onsets, tempo: best.tempo, passes: Math.floor((best.steps - 1) / m.steps.length) + 1 };
}

/** A ballistic hop, in screen-style coordinates (y down). */
export interface Arc {
  t0: number;
  dt: number;
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  g: number;
}

/**
 * The hop from (x0, y0) at t0 to (x1, y1) exactly dt later, peaking at height apexY (y down, so
 * apexY <= y0 and y1). Gravity is solved per hop, so every landing is on time.
 */
export function solveArc(x0: number, y0: number, x1: number, y1: number, t0: number, dt: number, apexY: number): Arc {
  const h0 = Math.max(0, y0 - apexY);
  const h1 = Math.max(0, y1 - apexY);
  const s = Math.sqrt(h0) + Math.sqrt(h1);
  const g = (2 * s * s) / (dt * dt);
  return { t0, dt, x0, y0, vx: (x1 - x0) / dt, vy: -Math.sqrt(2 * g * h0), g };
}

export function arcAt(a: Arc, t: number): { x: number; y: number; vx: number; vy: number } {
  const u = Math.min(a.dt, Math.max(0, t - a.t0));
  return { x: a.x0 + a.vx * u, y: a.y0 + a.vy * u + 0.5 * a.g * u * u, vx: a.vx, vy: a.vy + a.g * u };
}

/**
 * How high a hop of length dt rises: longer notes fly higher, but less than real physics would
 * (rise ~ dt^0.75, not dt^2) so held notes stay on screen. `clamped` when the cap cut it.
 */
export function riseFor(dt: number, refDt: number, base: number, min: number, max: number): { rise: number; clamped: boolean } {
  const raw = base * dm.pow(dt / refDt, 0.75);
  return { rise: Math.min(max, Math.max(min, raw)), clamped: raw > max * 1.15 };
}
