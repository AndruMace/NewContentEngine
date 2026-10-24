import * as dm from '@sim/physics/math';
import { MATERIALS, SQUARE_BASIS, circlePlate, circleRadial, plateHz, squarePlate, type CircleMode, type Material } from './plate';

/**
 * The figures a real plate makes, from its free-edge vibration modes (plate.ts), and what can make
 * each one: a speaker under the centre only drives modes in which the centre moves; the rest need
 * a violin bow drawn across the edge (Chladni's own way), where the mode moves most.
 *
 * Square plates have pairs of modes at the same frequency; whatever drives the plate excites the
 * mix of the pair that moves at the drive point (each mode weighted by its own movement there),
 * and that mix is the figure you see.
 *
 * Each figure is a grid of amplitudes (±1 at the most) and its gradient over the unit square (a
 * round plate fills the circle inside it). Sand gathers where the amplitude is 0.
 */
export const GRID = 200;

export type Plate = 'square' | 'circle';
export type Driver = 'auto' | 'speaker' | 'bow';

export interface Figure {
  plate: Plate;
  /** λ = ω a² √(ρh/D) (a = side, or radius). */
  lambda: number;
  /** What makes it: the centre speaker, or a bow at `bow` (plate units, 0..1, on the edge). */
  exciter: 'speaker' | 'bow';
  bow: { x: number; y: number } | null;
  /** Square: coefficients over the beam-function products. Round: the mode. */
  coeffs: Float64Array | null;
  circle: CircleMode | null;
  /** Round: the bow's angle (the figure's cos(nθ) is turned to put an antinode under it). */
  angle: number;
  /**
   * Square, bowed: drawn mirrored across the diagonal, so the bow sits on the left edge instead of
   * the top (a mirror image of a mode is a mode of the same plate, at the same frequency).
   */
  mirrored: boolean;
}

export interface Pattern {
  plate: Plate;
  amp: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
}

/** Below this share of its strongest movement, a point counts as still (nothing can drive it there). */
const DRIVABLE = 0.2;
/** Where a bow can go along the top edge (grid nodes of 0..40, the middle to near a corner). */
const BOW_POINTS = [20, 14, 8, 2];
/** Modes above these λ are beyond what the Ritz basis resolves well. */
const SQUARE_MAX = 180;
const CIRCLE_MAX = 110;

const figureCache = new Map<string, Figure[]>();

/** A plate's figures, lowest note first, each with what drives it (by the driver setting). */
export function figures(plate: Plate, material: Material, driver: Driver): Figure[] {
  const key = `${plate}|${material}|${driver}`;
  const hit = figureCache.get(key);
  if (hit) return hit;
  const nu = MATERIALS[material].nu;
  const out: Figure[] = [];
  if (plate === 'square') {
    const sq = squarePlate(nu);
    const modes = sq.modes.filter((m) => m.lambda < SQUARE_MAX);
    // Group modes at (nearly) the same frequency.
    const groups: (typeof modes)[] = [];
    for (const m of modes) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(m.lambda - g[0].lambda) / g[0].lambda < 0.004) g.push(m);
      else groups.push([m]);
    }
    const B = SQUARE_BASIS;
    const N = B * B;
    // Basis functions on a 41 × 41 grid: drive points and peaks are read from it.
    const G = 41;
    const X = new Float64Array(B * G);
    for (let i = 0; i < G; i++) for (let k = 0; k < B; k++) X[k * G + i] = sq.beam.at(k, i / (G - 1))[0];
    const wAt = (c: Float64Array, i: number, j: number) => {
      let w = 0;
      for (let a = 0; a < B; a++) {
        let t = 0;
        for (let b = 0; b < B; b++) t += c[a * B + b] * X[b * G + j];
        w += t * X[a * G + i];
      }
      return w;
    };
    const peakOf = (c: Float64Array) => {
      let m = 1e-12;
      const t = new Float64Array(B);
      for (let j = 0; j < G; j++) {
        for (let a = 0; a < B; a++) {
          let v = 0;
          for (let b = 0; b < B; b++) v += c[a * B + b] * X[b * G + j];
          t[a] = v;
        }
        for (let i = 0; i < G; i++) {
          let w = 0;
          for (let a = 0; a < B; a++) w += t[a] * X[a * G + i];
          m = Math.max(m, Math.abs(w));
        }
      }
      return m;
    };
    // The mix of a group a drive at grid node (i, j) excites: each mode weighted by its movement there.
    const mixAt = (g: typeof modes, i: number, j: number) => {
      const c = new Float64Array(N);
      for (const m of g) {
        const w = wAt(m.coeffs, i, j);
        for (let q = 0; q < N; q++) c[q] += w * m.coeffs[q];
      }
      return { coeffs: c, share: Math.abs(wAt(c, i, j)) / peakOf(c) };
    };
    for (const g of groups) {
      const lambda = g.reduce((a, m) => a + m.lambda, 0) / g.length;
      const centre = mixAt(g, 20, 20);
      const speakerOk = centre.share >= DRIVABLE;
      if (driver === 'speaker' && !speakerOk) continue;
      if (driver !== 'bow' && speakerOk) {
        out.push({ plate, lambda, exciter: 'speaker', bow: null, coeffs: centre.coeffs, circle: null, angle: 0, mirrored: false });
        continue;
      }
      // Bow where it moves the most (along the top edge, by symmetry any edge would do).
      let best = mixAt(g, BOW_POINTS[0], 0);
      let bx = BOW_POINTS[0];
      for (const x of BOW_POINTS.slice(1)) {
        const m = mixAt(g, x, 0);
        if (m.share > best.share + 1e-9) {
          best = m;
          bx = x;
        }
      }
      if (best.share < DRIVABLE) continue;
      out.push({ plate, lambda, exciter: 'bow', bow: { x: 0, y: bx / 40 }, coeffs: best.coeffs, circle: null, angle: 0, mirrored: true });
    }
  } else {
    for (const m of circlePlate(nu)) {
      if (m.lambda > CIRCLE_MAX) break;
      // Only rings (no diameters) move at the centre.
      const speakerOk = m.n === 0;
      if (driver === 'speaker' && !speakerOk) continue;
      if (driver !== 'bow' && speakerOk) out.push({ plate, lambda: m.lambda, exciter: 'speaker', bow: null, coeffs: null, circle: m, angle: 0, mirrored: false });
      else out.push({ plate, lambda: m.lambda, exciter: 'bow', bow: { x: 1, y: 0.5 }, coeffs: null, circle: m, angle: 0, mirrored: false });
    }
  }
  figureCache.set(key, out);
  return out;
}

/** The frequency of a figure on a real plate: `size` is the side (square) or diameter (round), in cm; thickness in mm. */
export function figureHz(f: Figure, material: Material, sizeCm: number, thicknessMm: number): number {
  const a = f.plate === 'square' ? sizeCm / 100 : sizeCm / 200;
  return plateHz(f.lambda, material, a, thicknessMm / 1000);
}

/** The diameter (cm) a round plate needs for its figure to sound at `hz`. */
export function diameterFor(f: Figure, material: Material, hz: number, thicknessMm: number): number {
  const h = thicknessMm / 1000;
  const { E, rho, nu } = MATERIALS[material];
  const D = (E * h * h * h) / (12 * (1 - nu * nu));
  const a = Math.sqrt((f.lambda / (2 * Math.PI * hz)) * Math.sqrt(D / (rho * h)));
  return 200 * a;
}

function gradients(amp: Float32Array): { gx: Float32Array; gy: Float32Array } {
  const N = GRID;
  const gx = new Float32Array(N * N);
  const gy = new Float32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(N - 1, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(N - 1, j + 1);
      gx[j * N + i] = ((amp[j * N + i1] - amp[j * N + i0]) * N) / (i1 - i0);
      gy[j * N + i] = ((amp[j1 * N + i] - amp[j0 * N + i]) * N) / (j1 - j0);
    }
  return { gx, gy };
}

function normalise(amp: Float32Array) {
  let max = 1e-9;
  for (let i = 0; i < amp.length; i++) max = Math.max(max, Math.abs(amp[i]));
  for (let i = 0; i < amp.length; i++) amp[i] /= max;
}

/** A figure's grid (picture only: the sand settles on it). */
export function patternOf(f: Figure, material: Material): Pattern {
  const N = GRID;
  const amp = new Float32Array(N * N);
  if (f.plate === 'square') {
    const sq = squarePlate(MATERIALS[material].nu);
    const B = SQUARE_BASIS;
    const X = new Float64Array(B * N);
    for (let i = 0; i < N; i++) for (let k = 0; k < B; k++) X[k * N + i] = sq.beam.at(k, (i + 0.5) / N)[0];
    const c = f.coeffs!;
    const t = new Float64Array(B);
    for (let j = 0; j < N; j++) {
      for (let a = 0; a < B; a++) {
        let s = 0;
        for (let b = 0; b < B; b++) s += c[a * B + b] * X[b * N + j];
        t[a] = s;
      }
      for (let i = 0; i < N; i++) {
        let w = 0;
        for (let a = 0; a < B; a++) w += t[a] * X[a * N + i];
        // Mirrored across the diagonal: the grid's x and y swap.
        if (f.mirrored) amp[i * N + j] = w;
        else amp[j * N + i] = w;
      }
    }
  } else {
    const m = f.circle!;
    const R = 512;
    const radial = new Float64Array(R + 1);
    for (let q = 0; q <= R; q++) radial[q] = circleRadial(m, q / R);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = ((i + 0.5) / N) * 2 - 1;
        const y = ((j + 0.5) / N) * 2 - 1;
        const r = Math.sqrt(x * x + y * y);
        if (r > 1) continue;
        amp[j * N + i] = radial[Math.min(R, Math.round(r * R))] * dm.cos(m.n * (dm.atan2(y, x) - f.angle));
      }
  }
  normalise(amp);
  return { plate: f.plate, amp, ...gradients(amp) };
}

/** A note's name (A4 = 440 Hz). */
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export function noteName(hz: number): string {
  const midi = Math.round(69 + (12 * dm.log(hz / 440)) / dm.log(2));
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
