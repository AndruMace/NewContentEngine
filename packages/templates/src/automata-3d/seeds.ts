/** Starting patterns: symmetric 3D seeds and the classic 2D Life patterns. */
import type { Rng } from '@sim/engine';

export const SYMMETRIES = ['none', 'mirror', 'cubic'] as const;
export type Symmetry = (typeof SYMMETRIES)[number];

const PERMS: [number, number, number][] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/**
 * Random cells near the centre of an n³ cube (n even), copied into every mirror image (8-fold) or
 * every mirror image and axis swap (48-fold, the cube's full symmetry). Isotropic rules keep that
 * symmetry exactly as the pattern grows. `ball` keeps the seed round instead of cubic.
 */
export function symmetricSeed(n: number, rng: Rng, o: { size: number; density: number; symmetry: Symmetry; ball?: boolean }): [number, number, number][] {
  const c = n / 2;
  const cells = new Set<number>();
  const add = (x: number, y: number, z: number) => {
    if (x >= 0 && y >= 0 && z >= 0 && x < n && y < n && z < n) cells.add(x + n * (y + n * z));
  };
  const inBall = (dx: number, dy: number, dz: number) => !o.ball || (dx + 0.5) ** 2 + (dy + 0.5) ** 2 + (dz + 0.5) ** 2 <= o.size * o.size;
  if (o.symmetry === 'none') {
    for (let dz = -o.size; dz < o.size; dz++)
      for (let dy = -o.size; dy < o.size; dy++)
        for (let dx = -o.size; dx < o.size; dx++) {
          const a = dx < 0 ? -dx - 1 : dx;
          const b = dy < 0 ? -dy - 1 : dy;
          const d = dz < 0 ? -dz - 1 : dz;
          if (inBall(a, b, d) && rng.chance(o.density)) add(c + dx, c + dy, c + dz);
        }
  } else {
    // Offsets (≥ 0) in one octant; the mirror of offset d is the cell at c - 1 - d.
    for (let dz = 0; dz < o.size; dz++)
      for (let dy = 0; dy < o.size; dy++)
        for (let dx = 0; dx < o.size; dx++) {
          if (!inBall(dx, dy, dz) || !rng.chance(o.density)) continue;
          const d = [dx, dy, dz];
          for (const perm of o.symmetry === 'cubic' ? PERMS : PERMS.slice(0, 1)) {
            const [a, b, e] = perm.map((k) => d[k]);
            for (let m = 0; m < 8; m++) add(m & 1 ? c - 1 - a : c + a, m & 2 ? c - 1 - b : c + b, m & 4 ? c - 1 - e : c + e);
          }
        }
  }
  return [...cells].sort((a, b) => a - b).map((i) => [i % n, Math.floor(i / n) % n, Math.floor(i / (n * n))]);
}

/** Rows of a 2D pattern ('O' = alive). */
const pattern = (rows: string[]): [number, number][] => rows.flatMap((row, y) => [...row].flatMap((ch, x) => (ch === 'O' ? [[x, y] as [number, number]] : [])));

export interface LifePattern {
  label: string;
  /** What it's known for, for the description and copy. */
  note: string;
  cells?: [number, number][];
}

export const LIFE_PATTERNS = {
  'r-pentomino': { label: 'R-pentomino', note: 'five cells that churn for over a thousand generations', cells: pattern(['.OO', 'OO.', '.O.']) },
  acorn: { label: 'Acorn', note: 'seven cells that grow into thousands', cells: pattern(['.O.....', '...O...', 'OO..OOO']) },
  diehard: { label: 'Diehard', note: 'seven cells that vanish completely after 130 generations', cells: pattern(['......O.', 'OO......', '.O...OOO']) },
  'pi-heptomino': { label: 'Pi-heptomino', note: 'a seven-cell arch that explodes', cells: pattern(['OOO', 'O.O', 'O.O']) },
  'b-heptomino': { label: 'B-heptomino', note: 'seven cells that throw off gliders', cells: pattern(['O.OO', 'OOO.', '.O..']) },
  herschel: { label: 'Herschel', note: 'a seven-cell spark that builds and burns out', cells: pattern(['O..', 'OOO', 'O.O', '..O']) },
  thunderbird: { label: 'Thunderbird', note: 'a T of six cells that blooms', cells: pattern(['OOO', '...', '.O.', '.O.', '.O.']) },
  'glider-gun': {
    label: 'Glider gun',
    note: 'a machine that fires gliders forever',
    cells: pattern([
      '........................O...........',
      '......................O.O...........',
      '............OO......OO............OO',
      '...........O...O....OO............OO',
      'OO........O.....O...OO..............',
      'OO........O...O.OO....O.O...........',
      '..........O.....O.......O...........',
      '...........O...O....................',
      '............OO......................',
    ]),
  },
  gliders: { label: 'Glider swarm', note: 'gliders flying in from every side' },
  soup: { label: 'Random soup', note: 'a random scatter of cells' },
} satisfies Record<string, LifePattern>;

export type LifePatternId = keyof typeof LIFE_PATTERNS;
export const LIFE_PATTERN_IDS = Object.keys(LIFE_PATTERNS) as LifePatternId[];

/** A glider heading toward (+1/-1, +1/-1). */
const glider = (sx: number, sy: number): [number, number][] =>
  pattern(['.O.', '..O', 'OOO']).map(([x, y]) => [sx > 0 ? x : 2 - x, sy > 0 ? y : 2 - y]);

/** The starting cells of a pattern, centred on a w × w board. */
export function lifeStart(id: LifePatternId, w: number, rng: Rng): [number, number][] {
  const c = Math.floor(w / 2);
  const def: LifePattern = LIFE_PATTERNS[id];
  if (def.cells) {
    const pw = Math.max(...def.cells.map(([x]) => x)) + 1;
    const ph = Math.max(...def.cells.map(([, y]) => y)) + 1;
    return def.cells.map(([x, y]) => [x + c - Math.floor(pw / 2), y + c - Math.floor(ph / 2)]);
  }
  const out: [number, number][] = [];
  if (id === 'gliders') {
    // Gliders on a ring, each aimed roughly at the centre, so they collide there.
    const count = rng.int(6, 10);
    const ring = w * 0.36;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const gx = Math.round(c + Math.cos(a) * ring);
      const gy = Math.round(c + Math.sin(a) * ring);
      for (const [x, y] of glider(gx < c ? 1 : -1, gy < c ? 1 : -1)) out.push([gx + x - 1, gy + y - 1]);
    }
    return out;
  }
  // Soup: a disc a third of the board across.
  const r = w * 0.17;
  for (let y = Math.floor(c - r); y <= c + r; y++) for (let x = Math.floor(c - r); x <= c + r; x++) if ((x - c) ** 2 + (y - c) ** 2 <= r * r && rng.chance(0.38)) out.push([x, y]);
  return out;
}
