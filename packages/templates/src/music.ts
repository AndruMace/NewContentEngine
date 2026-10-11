/** Scales for templates that generate their own pitches. Intervals in semitones. */
export const SCALES = {
  pentatonic: [0, 2, 4, 7, 9],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  hirajoshi: [0, 2, 3, 7, 8],
} as const;

export type ScaleName = keyof typeof SCALES;

/** The degree-th note of the scale above root (degree may exceed the scale length). */
export function scaleNote(scale: ScaleName, root: number, degree: number): number {
  const s = SCALES[scale];
  return root + Math.floor(degree / s.length) * 12 + s[((degree % s.length) + s.length) % s.length];
}
