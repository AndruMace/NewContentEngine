import * as dm from '@sim/physics/math';
import shapeData from './shapes.json';

export interface Shape {
  id: string;
  /** How the answer reads in a sentence ("Italy", "a heart"). */
  name: string;
  category: 'country' | 'state' | 'dinosaur' | 'animal' | 'fantasy';
  icon: string;
  /** Flat x,y pairs, ×1000, centred, longest side 1000, starting at the top. */
  points: number[];
}

export const SHAPES = shapeData.shapes as Shape[];

/** One rotating circle: z(u) = re/im · e^{2πi·freq·u}, u in [0, 1) over a loop. */
export interface Term {
  freq: number;
  re: number;
  im: number;
  amp: number;
  /** Starting angle (atan2(im, re)). */
  phase: number;
}

/**
 * Discrete Fourier transform of a closed outline (points as complex numbers). Returns the centre
 * (the 0-frequency term) and every other term sorted by size, largest first: the order the
 * circles are added in. Uses a twiddle table, so only N trig calls (fdlibm, deterministic).
 */
export function dft(points: number[]): { centre: [number, number]; terms: Term[] } {
  const N = points.length / 2;
  const cos = new Float64Array(N);
  const sin = new Float64Array(N);
  for (let m = 0; m < N; m++) {
    cos[m] = dm.cos((2 * Math.PI * m) / N);
    sin[m] = dm.sin((2 * Math.PI * m) / N);
  }
  const terms: Term[] = [];
  let centre: [number, number] = [0, 0];
  for (let f = -Math.floor(N / 2); f < Math.ceil(N / 2); f++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const x = points[2 * n] / 1000;
      const y = points[2 * n + 1] / 1000;
      const m = (((f * n) % N) + N) % N;
      // (x + iy)·e^{-iθ}
      re += x * cos[m] + y * sin[m];
      im += y * cos[m] - x * sin[m];
    }
    re /= N;
    im /= N;
    if (f === 0) centre = [re, im];
    else terms.push({ freq: f, re, im, amp: dm.hypot(re, im), phase: dm.atan2(im, re) });
  }
  terms.sort((a, b) => b.amp - a.amp || a.freq - b.freq);
  return { centre, terms };
}

/**
 * Mean distance between the outline and its reconstruction from the first `k` terms, sampled at
 * the original points, as a fraction of the shape's size (the shape spans 1).
 */
export function reconstructionError(points: number[], centre: [number, number], terms: Term[], k: number): number {
  const N = points.length / 2;
  const cos = new Float64Array(N);
  const sin = new Float64Array(N);
  for (let m = 0; m < N; m++) {
    cos[m] = dm.cos((2 * Math.PI * m) / N);
    sin[m] = dm.sin((2 * Math.PI * m) / N);
  }
  let total = 0;
  for (let n = 0; n < N; n++) {
    let x = centre[0];
    let y = centre[1];
    for (let j = 0; j < k && j < terms.length; j++) {
      const t = terms[j];
      const m = (((t.freq * n) % N) + N) % N;
      x += t.re * cos[m] - t.im * sin[m];
      y += t.re * sin[m] + t.im * cos[m];
    }
    total += dm.hypot(x - points[2 * n] / 1000, y - points[2 * n + 1] / 1000);
  }
  return total / N;
}

/** Circle counts per stage: 1, 2, 4, 8 … up to the maximum (which is always the last stage). */
export function stageCounts(max: number): number[] {
  const out: number[] = [];
  for (let k = 1; k < max; k *= 2) out.push(k);
  out.push(max);
  return out;
}
