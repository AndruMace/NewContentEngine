/** A melody is a sequence of steps; each step is one or more MIDI notes (melody note first). */
export interface Melody {
  id: string;
  title: string;
  composer: string;
  /** Composition status AND transcription status. Only 'public-domain' or 'cc0' allowed in the library. */
  license: 'public-domain' | 'cc0' | 'generated';
  steps: number[][];
  /** Timed melodies: each step's length in units (the time until the next step starts). */
  beats?: number[];
  /** Timed melodies: index of the first step of each phrase (one source line each). */
  phrases?: number[];
  /** Timed melodies: tempo in quarter notes per minute. */
  bpm?: number;
  /** Quarter notes per unit of `beats` (0.5 = eighth-note units, 0.25 = sixteenths). Default 1. */
  unit?: number;
}

/** Seconds per unit of `beats` at the melody's own tempo. */
export const unitSeconds = (m: Melody) => (60 / (m.bpm ?? 100)) * (m.unit ?? 1);

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C#4" -> 61. */
export function noteToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name.trim());
  if (!m) throw new Error(`Bad note name: ${name}`);
  const base = NOTE_INDEX[m[1].toUpperCase()];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + base + acc;
}

/**
 * Parse a compact melody string: whitespace-separated steps, chords joined with "+",
 * e.g. "E5 D#5 E5 A3+C4+E4". "|" bar lines are ignored. Timing marks (see parseMelody) are
 * ignored too, so untimed templates step through the same notes either way.
 */
export function parseSteps(src: string): number[][] {
  return parseMelody(src).steps;
}

/**
 * Parse a timed melody string. A "*n" suffix sets a step's length in units ("E5*2", "C5+A3*1.5",
 * default 1); a rest "r*n" (or "r", 1 unit) lengthens the step before it. Each line is a phrase.
 */
export function parseMelody(src: string): { steps: number[][]; beats: number[]; phrases: number[] } {
  const steps: number[][] = [];
  const beats: number[] = [];
  const phrases: number[] = [];
  for (const line of src.split('\n')) {
    const toks = line.split(/\s+/).filter((tok) => tok && tok !== '|');
    if (!toks.length) continue;
    phrases.push(steps.length);
    for (const tok of toks) {
      const [notes, len = '1'] = tok.split('*');
      const n = Number(len);
      if (!(n > 0)) throw new Error(`Bad length in ${tok}`);
      if (notes === 'r') {
        if (!beats.length) throw new Error('A melody cannot start with a rest');
        beats[beats.length - 1] += n;
        continue;
      }
      steps.push(notes.split('+').map(noteToMidi));
      beats.push(n);
    }
  }
  return { steps, beats, phrases };
}

/** The melody moved by `semitones` (timing unchanged). */
export function transposeMelody(m: Melody, semitones: number): Melody {
  return semitones ? { ...m, steps: m.steps.map((s) => s.map((n) => n + semitones)) } : m;
}

export class MelodyCursor {
  index = 0;
  constructor(readonly melody: Melody, readonly transpose = 0) {}

  /** Returns the next step's notes and advances (wrapping). */
  next(): number[] {
    const step = this.melody.steps[this.index % this.melody.steps.length];
    this.index++;
    return step.map((n) => n + this.transpose);
  }

  peek(): number[] {
    return this.melody.steps[this.index % this.melody.steps.length].map((n) => n + this.transpose);
  }
}

/** Deterministic pentatonic random walk, for templates/videos without a song. */
export function generatedMelody(seed: number, length = 64, root = 60): Melody {
  const scale = [0, 2, 4, 7, 9];
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  let degree = 5;
  const steps: number[][] = [];
  for (let i = 0; i < length; i++) {
    degree = Math.max(0, Math.min(14, degree + Math.round((rnd() - 0.5) * 4)));
    const note = root + Math.floor(degree / 5) * 12 + scale[degree % 5];
    steps.push(i % 8 === 0 ? [note, note - 12] : [note]);
  }
  return { id: `generated-${seed}`, title: 'Generated pentatonic', composer: '—', license: 'generated', steps };
}
