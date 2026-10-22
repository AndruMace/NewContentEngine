/**
 * Voxel grids for the automata. Integer-only, so a run is identical everywhere.
 *
 * Grid3 is an n³ cube stored with a one-cell border of always-empty padding, so neighbour counting
 * never needs bounds checks (counts spill into the padding, which is never updated). Only the box
 * around the non-empty cells is visited each generation.
 */
import type { Rule2, Rule3 } from './rules';

export interface GenStats {
  /** Cells that came alive / stopped being alive this generation. */
  births: number;
  deaths: number;
  alive: number;
  /** Alive plus decaying. */
  nonzero: number;
  /** A live cell sits on the cube's outer face. */
  atEdge: boolean;
  /** Furthest live cell from the centre (cells). */
  radius: number;
  /** Mean position of the births (cells, from the centre), for panning. */
  bx: number;
  by: number;
}

const MOORE: [number, number, number][] = [];
for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) MOORE.push([dx, dy, dz]);
const VN: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export class Grid3 {
  readonly n: number;
  /** Padded side (n + 2). */
  readonly p: number;
  /** 0 empty, 1 alive, 2.. decaying. */
  readonly state: Uint8Array;
  /** The generation each cell last came alive (for colouring by age). */
  readonly born: Uint16Array;
  private readonly count: Uint8Array;
  gen = 0;
  /** Inclusive box of the non-empty cells (lo > hi when empty). */
  lo: [number, number, number];
  hi: [number, number, number];

  constructor(n: number) {
    this.n = n;
    this.p = n + 2;
    const size = this.p ** 3;
    this.state = new Uint8Array(size);
    this.born = new Uint16Array(size);
    this.count = new Uint8Array(size);
    this.lo = [n, n, n];
    this.hi = [-1, -1, -1];
  }

  idx(x: number, y: number, z: number): number {
    return x + 1 + this.p * (y + 1 + this.p * (z + 1));
  }

  get(x: number, y: number, z: number): number {
    return this.state[this.idx(x, y, z)];
  }

  set(x: number, y: number, z: number, v: number) {
    this.state[this.idx(x, y, z)] = v;
    this.born[this.idx(x, y, z)] = this.gen;
    if (v) {
      this.lo = [Math.min(this.lo[0], x), Math.min(this.lo[1], y), Math.min(this.lo[2], z)];
      this.hi = [Math.max(this.hi[0], x), Math.max(this.hi[1], y), Math.max(this.hi[2], z)];
    }
  }

  get empty(): boolean {
    return this.lo[0] > this.hi[0];
  }

  /** Advance one generation. */
  step(rule: Rule3): GenStats {
    const { n, p, state, count, born } = this;
    const gen = ++this.gen;
    const stats: GenStats = { births: 0, deaths: 0, alive: 0, nonzero: 0, atEdge: false, radius: 0, bx: 0, by: 0 };
    if (this.empty) return stats;
    const offs = (rule.nb === 'vn' ? VN : MOORE).map(([dx, dy, dz]) => dx + p * (dy + p * dz));
    const [lx, ly, lz] = this.lo;
    const [hx, hy, hz] = this.hi;
    // Scatter: every live cell adds one to each neighbour.
    for (let z = lz; z <= hz; z++)
      for (let y = ly; y <= hy; y++) {
        let i = this.idx(lx, y, z);
        for (let x = lx; x <= hx; x++, i++) if (state[i] === 1) for (const o of offs) count[i + o]++;
      }
    const x0 = Math.max(0, lx - 1);
    const y0 = Math.max(0, ly - 1);
    const z0 = Math.max(0, lz - 1);
    const x1 = Math.min(n - 1, hx + 1);
    const y1 = Math.min(n - 1, hy + 1);
    const z1 = Math.min(n - 1, hz + 1);
    const lo: [number, number, number] = [n, n, n];
    const hi: [number, number, number] = [-1, -1, -1];
    const c = (n - 1) / 2;
    let r2 = 0;
    const { survive, birth, states } = rule;
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) {
        let i = this.idx(x0, y, z);
        for (let x = x0; x <= x1; x++, i++) {
          const s = state[i];
          const k = count[i];
          count[i] = 0;
          let v: number;
          if (s === 0) v = (birth >>> k) & 1;
          else if (s === 1) v = (survive >>> k) & 1 ? 1 : states > 2 ? 2 : 0;
          else v = s + 1 < states ? s + 1 : 0;
          if (v !== s) {
            state[i] = v;
            if (v === 1) {
              born[i] = gen;
              stats.births++;
              stats.bx += x - c;
              stats.by += y - c;
            } else if (s === 1) stats.deaths++;
          }
          if (v === 0) continue;
          stats.nonzero++;
          if (x < lo[0]) lo[0] = x;
          if (y < lo[1]) lo[1] = y;
          if (z < lo[2]) lo[2] = z;
          if (x > hi[0]) hi[0] = x;
          if (y > hi[1]) hi[1] = y;
          if (z > hi[2]) hi[2] = z;
          if (v !== 1) continue;
          stats.alive++;
          if (x === 0 || y === 0 || z === 0 || x === n - 1 || y === n - 1 || z === n - 1) stats.atEdge = true;
          const d2 = (x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2;
          if (d2 > r2) r2 = d2;
        }
      }
    // Where the box was clamped at the cube's face, counts spilled into the padding: clear them.
    this.clearRing(x0 - 1, y0 - 1, z0 - 1, x1 + 1, y1 + 1, z1 + 1);
    this.lo = lo;
    this.hi = hi;
    stats.radius = Math.sqrt(r2);
    if (stats.births) {
      stats.bx /= stats.births;
      stats.by /= stats.births;
    }
    return stats;
  }

  /** Zero the counts on the outer shell of a box (padded coordinates may be -1 or n). */
  private clearRing(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const { count } = this;
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) {
        const face = z === z0 || z === z1 || y === y0 || y === y1;
        if (face) count.fill(0, this.idx(x0, y, z), this.idx(x1, y, z) + 1);
        else {
          count[this.idx(x0, y, z)] = 0;
          count[this.idx(x1, y, z)] = 0;
        }
      }
  }

  /** Hash of the non-empty region, to spot a pattern that has stopped changing or cycles. */
  hash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h ^= v;
      h = Math.imul(h, 0x01000193) >>> 0;
    };
    for (const v of [...this.lo, ...this.hi]) mix(v & 0xff);
    if (this.empty) return h;
    for (let z = this.lo[2]; z <= this.hi[2]; z++)
      for (let y = this.lo[1]; y <= this.hi[1]; y++) {
        let i = this.idx(this.lo[0], y, z);
        for (let x = this.lo[0]; x <= this.hi[0]; x++, i++) mix(this.state[i]);
      }
    return h;
  }
}

/**
 * Remembers recent hashes; `period()` is the length of the cycle the pattern has fallen into (1 =
 * still life), or 0 while it is still changing.
 */
export class CycleWatch {
  private hashes: number[] = [];
  constructor(private readonly maxPeriod = 6) {}

  push(h: number) {
    this.hashes.push(h);
    if (this.hashes.length > this.maxPeriod * 2 + 1) this.hashes.shift();
  }

  period(): number {
    const hs = this.hashes;
    const last = hs.length - 1;
    for (let k = 1; k <= this.maxPeriod && last - 2 * k >= 0; k++) {
      // Seen twice over, so a coincidence (and a pattern that moves) doesn't count.
      if (hs[last] === hs[last - k] && hs[last - k] === hs[last - 2 * k]) return k;
    }
    return 0;
  }
}

export interface LifeStats {
  births: number;
  deaths: number;
  alive: number;
}

/** A 2D Life-like board (w × w), optionally wrapping round its edges (a torus). */
export class Life2 {
  readonly w: number;
  readonly wrap: boolean;
  cells: Uint8Array;
  private nextCells: Uint8Array;
  gen = 0;

  constructor(w: number, wrap: boolean) {
    this.w = w;
    this.wrap = wrap;
    this.cells = new Uint8Array(w * w);
    this.nextCells = new Uint8Array(w * w);
  }

  get(x: number, y: number): number {
    return this.cells[x + y * this.w];
  }

  set(x: number, y: number, v: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.w) return;
    this.cells[x + y * this.w] = v;
  }

  step(rule: Rule2): LifeStats {
    const { w, wrap, cells, nextCells } = this;
    const stats: LifeStats = { births: 0, deaths: 0, alive: 0 };
    for (let y = 0; y < w; y++) {
      const ym = y === 0 ? (wrap ? w - 1 : -1) : y - 1;
      const yp = y === w - 1 ? (wrap ? 0 : -1) : y + 1;
      for (let x = 0; x < w; x++) {
        const xm = x === 0 ? (wrap ? w - 1 : -1) : x - 1;
        const xp = x === w - 1 ? (wrap ? 0 : -1) : x + 1;
        let k = 0;
        for (const yy of [ym, y, yp]) {
          if (yy < 0) continue;
          const row = yy * w;
          if (xm >= 0) k += cells[row + xm];
          if (yy !== y) k += cells[row + x];
          if (xp >= 0) k += cells[row + xp];
        }
        const s = cells[x + y * w];
        const v = s ? (rule.survive >>> k) & 1 : (rule.birth >>> k) & 1;
        nextCells[x + y * w] = v;
        if (v && !s) stats.births++;
        else if (s && !v) stats.deaths++;
        stats.alive += v;
      }
    }
    this.cells = nextCells;
    this.nextCells = cells;
    this.gen++;
    return stats;
  }

  hash(): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < this.cells.length; i++) {
      h ^= this.cells[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }
}
