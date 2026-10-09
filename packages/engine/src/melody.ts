/** A melody is a sequence of steps; each step is one or more MIDI notes (melody note first). */
export interface Melody {
  id: string;
  title: string;
  composer: string;
  /** Composition status AND transcription status. Only 'public-domain' or 'cc0' allowed in the library. */
  license: 'public-domain' | 'cc0' | 'generated';
  steps: number[][];
}

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
 * e.g. "E5 D#5 E5 A3+C4+E4". "|" bar lines are ignored.
 */
export function parseSteps(src: string): number[][] {
  return src
    .split(/\s+/)
    .filter((tok) => tok && tok !== '|')
    .map((tok) => tok.split('+').map(noteToMidi));
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
