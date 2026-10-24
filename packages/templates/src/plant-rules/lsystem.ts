import * as dm from '@sim/physics/math';
import type { Rng } from '@sim/engine';

/**
 * Lindenmayer systems: a string of symbols, rewritten in rounds by rules (F → F[+F]F[-F]F), then
 * drawn by a turtle: F draws a line forward, + and − turn by the angle, [ and ] save and return to a
 * branch point. Rules with several options pick one at random each time (stochastic plants).
 */
export interface Preset {
  id: string;
  /** What the narration calls it. */
  name: string;
  axiom: string;
  rules: Record<string, string[]>;
  /** Degrees. */
  angle: number;
  /** Rounds that look best (capped by the segment budget). */
  rounds: number;
  /** Symbols that draw a line. */
  draws: string;
  kind: 'plant' | 'fractal';
  /** Starting heading in degrees (−90 = straight up). */
  heading: number;
  /** Has flowers at its tips when finished. */
  flowers?: boolean;
}

export const PRESETS: Preset[] = [
  { id: 'fern', name: 'fern', axiom: 'X', rules: { X: ['F+[[X]-X]-F[-FX]+X'], F: ['FF'] }, angle: 25, rounds: 6, draws: 'F', kind: 'plant', heading: -90 },
  { id: 'bush', name: 'bush', axiom: 'F', rules: { F: ['FF+[+F-F-F]-[-F+F+F]'] }, angle: 22.5, rounds: 4, draws: 'F', kind: 'plant', heading: -90 },
  { id: 'tree', name: 'tree', axiom: 'F', rules: { F: ['F[+F]F[-F]F'] }, angle: 25.7, rounds: 5, draws: 'F', kind: 'plant', heading: -90 },
  { id: 'seaweed', name: 'seaweed', axiom: 'F', rules: { F: ['F[+F]F[-F][F]'] }, angle: 20, rounds: 5, draws: 'F', kind: 'plant', heading: -90 },
  { id: 'grass', name: 'grass', axiom: 'X', rules: { X: ['F[+X]F[-X]+X'], F: ['FF'] }, angle: 20, rounds: 7, draws: 'F', kind: 'plant', heading: -90 },
  { id: 'flowering', name: 'flowering plant', axiom: 'X', rules: { X: ['F[+X][-X]FX'], F: ['FF'] }, angle: 25.7, rounds: 7, draws: 'F', kind: 'plant', heading: -90, flowers: true },
  { id: 'dragon', name: 'dragon curve', axiom: 'FX', rules: { X: ['X+YF+'], Y: ['-FX-Y'] }, angle: 90, rounds: 11, draws: 'F', kind: 'fractal', heading: 0 },
  { id: 'koch', name: 'Koch snowflake', axiom: 'F--F--F', rules: { F: ['F+F--F+F'] }, angle: 60, rounds: 4, draws: 'F', kind: 'fractal', heading: 0 },
  { id: 'sierpinski', name: 'Sierpinski triangle', axiom: 'A', rules: { A: ['B-A-B'], B: ['A+B+A'] }, angle: 60, rounds: 7, draws: 'AB', kind: 'fractal', heading: 0 },
  { id: 'hilbert', name: 'Hilbert curve', axiom: 'A', rules: { A: ['+BF-AFA-FB+'], B: ['-AF+BFB+FA-'] }, angle: 90, rounds: 5, draws: 'F', kind: 'fractal', heading: 0 },
];

/** Stochastic rules for the garden: each F picks one of three growth habits. */
export const GARDEN: Preset = { id: 'garden', name: 'garden', axiom: 'F', rules: { F: ['F[+F]F[-F]F', 'F[+F]F', 'F[-F]F'] }, angle: 25.7, rounds: 5, draws: 'F', kind: 'plant', heading: -90 };

export const presetById = (id: string) => PRESETS.find((p) => p.id === id) ?? GARDEN;

/** One round of rewriting. */
export function rewrite(s: string, rules: Record<string, string[]>, rng: Rng | null): string {
  const out: string[] = [];
  for (const ch of s) {
    const opts = rules[ch];
    if (!opts) out.push(ch);
    else out.push(opts.length === 1 || !rng ? opts[0] : opts[rng.int(0, opts.length - 1)]);
  }
  return out.join('');
}

export const countDraws = (s: string, draws: string) => {
  let n = 0;
  for (const ch of s) if (draws.includes(ch)) n++;
  return n;
};

/**
 * A drawn string, angle-free: for each line, the number of turns before it (so any angle can be
 * drawn without re-reading the string), its branch depth, the line it grows from and when it grows
 * (its distance from the root, in lines).
 */
export interface Shape {
  n: number;
  turns: Int32Array;
  depth: Uint8Array;
  parent: Int32Array;
  birth: Int32Array;
  /** True for lines nothing grows from (leaves and flowers go there). */
  tip: Uint8Array;
  maxBirth: number;
  maxDepth: number;
}

export function shapeOf(s: string, draws: string): Shape {
  const n = countDraws(s, draws);
  const turns = new Int32Array(n);
  const depth = new Uint8Array(n);
  const parent = new Int32Array(n);
  const birth = new Int32Array(n);
  const kids = new Uint8Array(n);
  const stack: [number, number, number][] = [];
  let turn = 0;
  let last = -1;
  let b = 0;
  let k = 0;
  let maxBirth = 0;
  for (const ch of s) {
    if (draws.includes(ch)) {
      turns[k] = turn;
      depth[k] = Math.min(255, stack.length);
      parent[k] = last;
      if (last >= 0) kids[last] = 1;
      birth[k] = b;
      if (b > maxBirth) maxBirth = b;
      last = k++;
      b++;
    } else if (ch === '+') turn++;
    else if (ch === '-') turn--;
    else if (ch === '[') stack.push([turn, last, b]);
    else if (ch === ']') {
      const top = stack.pop();
      if (top) [turn, last, b] = top;
    }
  }
  const tip = new Uint8Array(n);
  let maxDepth = 0;
  for (let i = 0; i < n; i++) {
    tip[i] = kids[i] ? 0 : 1;
    if (depth[i] > maxDepth) maxDepth = depth[i];
  }
  return { n, turns, depth, parent, birth, tip, maxBirth, maxDepth };
}

/**
 * Line end points for a shape at an angle (unit-length lines; `sway` bends each line by its depth,
 * for wind). Visual-only callers may pass any sway; the sim never reads these.
 */
export function layout(sh: Shape, angleDeg: number, headingDeg: number, sway: (depth: number) => number, out?: Float32Array, wobble?: (i: number) => number): Float32Array {
  const xy = out && out.length >= sh.n * 4 ? out : new Float32Array(sh.n * 4);
  const a = (angleDeg * Math.PI) / 180;
  const h = (headingDeg * Math.PI) / 180;
  for (let i = 0; i < sh.n; i++) {
    const p = sh.parent[i];
    const x0 = p >= 0 ? xy[p * 4 + 2] : 0;
    const y0 = p >= 0 ? xy[p * 4 + 3] : 0;
    const dir = h + sh.turns[i] * a + sway(sh.depth[i]) + (wobble ? wobble(i) : 0);
    xy[i * 4] = x0;
    xy[i * 4 + 1] = y0;
    xy[i * 4 + 2] = x0 + dm.cos(dir);
    xy[i * 4 + 3] = y0 + dm.sin(dir);
  }
  return xy;
}

export function bounds(xy: Float32Array, n: number): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n * 4; i += 2) {
    const x = xy[i];
    const y = xy[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return n ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 1, y1: 1 };
}
