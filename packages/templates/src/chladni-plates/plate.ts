import * as dm from '@sim/physics/math';

/**
 * Free vibration of thin plates with free edges (Kirchhoff plate theory), the physics behind
 * Chladni figures.
 *
 * Square: there is no closed form, so the modes come from the Rayleigh–Ritz method (as in Leissa's
 * "Vibration of Plates"): the deflection is a sum of products of free–free beam functions, and the
 * plate's bending energy (with the Poisson ratio ν) against its kinetic energy gives an eigenproblem.
 * Round: the modes are J_n(κr) + C·I_n(κr), times cos(nθ), with κ a root of the free-edge
 * conditions (no bending moment, no edge shear) at the rim.
 *
 * Eigenvalues are given as λ = ω a² √(ρh / D) (a = side, or radius), the form tables use, so the
 * frequency of a real plate is f = λ / (2π a²) · √(D / (ρh)).
 *
 * Everything goes through @sim/physics/math or plain + − × ÷ √, so Node and the browser agree.
 */

/** Roots of cos β · cosh β = 1 (free–free beam), then (2k+1)π/2 to well within float precision. */
const BETAS = [4.730040744862704, 7.853204624095838, 10.995607838001671, 14.137165491257464, 17.27875965739948, 20.42035224562606, 23.56194490204046, 26.70353755550819, 29.84513020910325];

/** 1D basis on [0, 1]: two rigid motions (lift and tilt), then elastic free–free beam modes. */
const BASIS = 2 + BETAS.length;

interface Beam {
  /** Value, slope and curvature of basis function k at x. */
  at(k: number, x: number): [number, number, number];
}

function beam(): Beam {
  // σ and 1 − σ (in a form that keeps its precision when σ is within 1e-12 of 1).
  const sig = BETAS.map((b) => {
    const eb = dm.exp(b);
    const emb = dm.exp(-b);
    const sinh = (eb - emb) / 2;
    const cosh = (eb + emb) / 2;
    const s = (cosh - dm.cos(b)) / (sinh - dm.sin(b));
    const oneMinus = (-emb - dm.sin(b) + dm.cos(b)) / (sinh - dm.sin(b));
    return { s, oneMinus };
  });
  const SQ3 = Math.sqrt(3);
  const raw = (k: number, x: number): [number, number, number] => {
    if (k === 0) return [1, 0, 0];
    if (k === 1) return [SQ3 * (2 * x - 1), 2 * SQ3, 0];
    const b = BETAS[k - 2];
    const { s, oneMinus } = sig[k - 2];
    const ep = dm.exp(b * x);
    const em = dm.exp(-b * x);
    // cosh − σ·sinh and sinh − σ·cosh, without the huge terms that cancel.
    const cmS = (oneMinus * ep + (1 + s) * em) / 2;
    const smC = (oneMinus * ep - (1 + s) * em) / 2;
    const c = dm.cos(b * x);
    const sn = dm.sin(b * x);
    return [cmS + c - s * sn, b * (smC - sn - s * c), b * b * (cmS - c + s * sn)];
  };
  // Normalise each elastic function to unit mean square (they come out close to 1 already).
  const norm = new Float64Array(BASIS).fill(1);
  const Q = 4000;
  for (let k = 2; k < BASIS; k++) {
    let sum = 0;
    for (let q = 0; q <= Q; q++) {
      const v = raw(k, q / Q)[0];
      sum += (q === 0 || q === Q ? 1 : q % 2 ? 4 : 2) * v * v;
    }
    norm[k] = 1 / Math.sqrt(sum / (3 * Q));
  }
  return {
    at(k, x) {
      const [v, d, dd] = raw(k, x);
      return [v * norm[k], d * norm[k], dd * norm[k]];
    },
  };
}

/** ∫₀¹ f(x) dx by Simpson's rule over Q intervals. */
function simpson(Q: number, f: (x: number) => number): number {
  let s = 0;
  for (let q = 0; q <= Q; q++) s += (q === 0 || q === Q ? 1 : q % 2 ? 4 : 2) * f(q / Q);
  return s / (3 * Q);
}

/** Eigenvalues (ascending) and eigenvectors (columns of V, by index) of a symmetric matrix: cyclic Jacobi. */
function jacobi(A: Float64Array, n: number): { values: number[]; vectors: Float64Array } {
  const a = Float64Array.from(A);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i * n + i] - a[j * n + j] || i - j);
  const vectors = new Float64Array(n * n);
  order.forEach((col, k) => {
    for (let r = 0; r < n; r++) vectors[k * n + r] = v[r * n + col];
  });
  return { values: order.map((i) => a[i * n + i]), vectors };
}

/** A square-plate mode: λ and its coefficients over the BASIS × BASIS products (row-major: i for x, j for y). */
export interface SquareMode {
  lambda: number;
  coeffs: Float64Array;
}

const squareCache = new Map<number, { modes: SquareMode[]; beam: Beam }>();

/** Square free plate's elastic modes for Poisson ratio ν (rigid motions dropped), lowest first. */
export function squarePlate(nu: number): { modes: SquareMode[]; beam: Beam } {
  const hit = squareCache.get(nu);
  if (hit) return hit;
  const b = beam();
  const n = BASIS;
  const Q = 2000;
  const A = new Float64Array(n * n); // ∫ X_i'' X_k''
  const B = new Float64Array(n * n); // ∫ X_i'' X_k
  const C = new Float64Array(n * n); // ∫ X_i' X_k'
  const cache: [number, number, number][][] = [];
  for (let q = 0; q <= Q; q++) cache.push(Array.from({ length: n }, (_, k) => b.at(k, q / Q)));
  const at = (q: number, k: number) => cache[Math.round(q * Q)][k];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) {
      A[i * n + k] = simpson(Q, (x) => at(x, i)[2] * at(x, k)[2]);
      B[i * n + k] = simpson(Q, (x) => at(x, i)[2] * at(x, k)[0]);
      C[i * n + k] = simpson(Q, (x) => at(x, i)[1] * at(x, k)[1]);
    }
  // Bending energy over the products X_i(x)·X_j(y): w_xx², w_yy², 2ν·w_xx·w_yy, 2(1−ν)·w_xy².
  const N = n * n;
  const K = new Float64Array(N * N);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++)
        for (let l = 0; l < n; l++) {
          let v = 2 * (1 - nu) * C[i * n + k] * C[j * n + l] + nu * (B[i * n + k] * B[l * n + j] + B[k * n + i] * B[j * n + l]);
          if (j === l) v += A[i * n + k];
          if (i === k) v += A[j * n + l];
          K[(i * n + j) * N + (k * n + l)] = v;
        }
  // Symmetrise away the quadrature's last digits, then solve (the basis is orthonormal: mass = identity).
  for (let r = 0; r < N; r++)
    for (let c = r + 1; c < N; c++) {
      const m = (K[r * N + c] + K[c * N + r]) / 2;
      K[r * N + c] = m;
      K[c * N + r] = m;
    }
  const { values, vectors } = jacobi(K, N);
  const modes: SquareMode[] = [];
  values.forEach((omega2, k) => {
    const lambda = Math.sqrt(Math.max(0, omega2));
    if (lambda < 2) return; // rigid motions
    modes.push({ lambda, coeffs: vectors.slice(k * N, (k + 1) * N) });
  });
  const out = { modes, beam: b };
  squareCache.set(nu, out);
  return out;
}

/** A square mode's deflection at (x, y) in [0, 1]². */
export function squareAt(sq: { beam: Beam }, coeffs: Float64Array, x: number, y: number): number {
  let w = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < BASIS; k++) {
    xs.push(sq.beam.at(k, x)[0]);
    ys.push(sq.beam.at(k, y)[0]);
  }
  for (let i = 0; i < BASIS; i++) for (let j = 0; j < BASIS; j++) w += coeffs[i * BASIS + j] * xs[i] * ys[j];
  return w;
}

export const SQUARE_BASIS = BASIS;

/** J_n(x), from its integral (trapezoid on a periodic integrand: exact to float precision). */
export function besselJ(n: number, x: number): number {
  const K = 96;
  let s = 0;
  for (let k = 0; k < K; k++) {
    const t = ((k + 0.5) / K) * Math.PI;
    s += dm.cos(n * t - x * dm.sin(t));
  }
  return s / K;
}

/** I_n(x) (modified Bessel), from its integral the same way. */
export function besselI(n: number, x: number): number {
  const K = 96;
  let s = 0;
  for (let k = 0; k < K; k++) {
    const t = ((k + 0.5) / K) * Math.PI;
    s += dm.exp(x * dm.cos(t)) * dm.cos(n * t);
  }
  return s / K;
}

/** Value, slope and curvature of J_n and I_n at x (slopes by recurrence, curvature from Bessel's equation). */
function bessels(n: number, x: number) {
  const J = besselJ(n, x);
  const Jp = n === 0 ? -besselJ(1, x) : (besselJ(n - 1, x) - besselJ(n + 1, x)) / 2;
  const I = besselI(n, x);
  const Ip = n === 0 ? besselI(1, x) : (besselI(n - 1, x) + besselI(n + 1, x)) / 2;
  const Jpp = -Jp / x - (1 - (n * n) / (x * x)) * J;
  const Ipp = -Ip / x + (1 + (n * n) / (x * x)) * I;
  return { J, Jp, Jpp, I, Ip, Ipp };
}

/**
 * The free-edge conditions at the rim (r = 1) for w = [J_n(κr) + C·I_n(κr)]·cos(nθ): bending moment
 * M_r and the effective (Kirchhoff) shear V_r, for each of the two parts.
 */
function rim(n: number, kappa: number, nu: number) {
  const b = bessels(n, kappa);
  const k2 = kappa * kappa;
  const n2 = n * n;
  const mJ = k2 * b.Jpp + nu * (kappa * b.Jp - n2 * b.J);
  const mI = k2 * b.Ipp + nu * (kappa * b.Ip - n2 * b.I);
  const vJ = -k2 * kappa * b.Jp + (1 - nu) * n2 * (b.J - kappa * b.Jp);
  const vI = k2 * kappa * b.Ip + (1 - nu) * n2 * (b.I - kappa * b.Ip);
  return { mJ, mI, vJ, vI };
}

export interface CircleMode {
  /** Nodal diameters. */
  n: number;
  /** Nodal circles. */
  s: number;
  kappa: number;
  lambda: number;
  /** Weight of I_n against J_n. */
  c: number;
}

const circleCache = new Map<number, CircleMode[]>();

/** Round free plate's elastic modes for Poisson ratio ν, lowest first (λ = κ², a = radius). */
export function circlePlate(nu: number): CircleMode[] {
  const hit = circleCache.get(nu);
  if (hit) return hit;
  const out: CircleMode[] = [];
  for (let n = 0; n <= 9; n++) {
    const det = (k: number) => {
      const r = rim(n, k, nu);
      return r.mJ * r.vI - r.mI * r.vJ;
    };
    const roots: number[] = [];
    let a = 0.6;
    let fa = det(a);
    for (let k = a + 0.02; k < 16 && roots.length < 5; k += 0.02) {
      const fk = det(k);
      if (fa === 0 || (fa < 0) !== (fk < 0)) {
        let lo = a;
        let hi = k;
        for (let it = 0; it < 60; it++) {
          const mid = (lo + hi) / 2;
          if ((det(mid) < 0) === (det(lo) < 0)) lo = mid;
          else hi = mid;
        }
        roots.push((lo + hi) / 2);
      }
      a = k;
      fa = fk;
    }
    roots.forEach((kappa) => {
      const r = rim(n, kappa, nu);
      const c = -r.mJ / r.mI;
      // Count nodal circles: sign changes of the radial shape inside the plate.
      let s = 0;
      let prev = besselJ(n, 0.02 * kappa) + c * besselI(n, 0.02 * kappa);
      for (let q = 2; q <= 100; q++) {
        const rr = q / 100;
        const v = besselJ(n, rr * kappa) + c * besselI(n, rr * kappa);
        if ((v < 0) !== (prev < 0)) s++;
        prev = v;
      }
      out.push({ n, s, kappa, lambda: kappa * kappa, c });
    });
  }
  out.sort((x, y) => x.lambda - y.lambda);
  circleCache.set(nu, out);
  return out;
}

/** A round mode's radial shape at r in [0, 1]. */
export const circleRadial = (m: CircleMode, r: number) => besselJ(m.n, r * m.kappa) + m.c * besselI(m.n, r * m.kappa);

/** Plate materials (isotropic): Young's modulus (Pa), density (kg/m³), Poisson ratio. */
export const MATERIALS = {
  steel: { E: 200e9, rho: 7850, nu: 0.29 },
  brass: { E: 100e9, rho: 8500, nu: 0.34 },
  aluminium: { E: 69e9, rho: 2700, nu: 0.33 },
  glass: { E: 70e9, rho: 2500, nu: 0.22 },
} as const;
export type Material = keyof typeof MATERIALS;

/** Frequency (Hz) of a mode with eigenvalue λ on a real plate: a = side (square) or radius (round), in metres. */
export function plateHz(lambda: number, material: Material, a: number, thickness: number): number {
  const { E, rho, nu } = MATERIALS[material];
  const D = (E * thickness * thickness * thickness) / (12 * (1 - nu * nu));
  return (lambda / (2 * Math.PI * a * a)) * Math.sqrt(D / (rho * thickness));
}
