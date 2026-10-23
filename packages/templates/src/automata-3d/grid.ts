/**
 * Voxel grids for the automata. Integer-only, so a run is identical everywhere.
 *
 * Grid3 is unbounded (see the class). It keeps every cell's live-neighbour count up to date as cells
 * change, and each generation only looks at cells that changed or have a neighbour that did: a cell
 * whose state and count are both unchanged can't change (decaying cells change every generation, so
 * they are always looked at). The cost follows the growth front, not the size of the pattern. Totals,
 * the radius and the state hash are kept the same way, so nothing scans the whole grid.
 */
import type { Neighbourhood, Rule2, Rule3 } from './rules';

export interface GenStats {
  /** Cells that came alive / stopped being alive this generation. */
  births: number;
  deaths: number;
  alive: number;
  /** Alive plus decaying. */
  nonzero: number;
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

/** A random-looking 32-bit key per (cell, state), XORed together into the state hash (Zobrist). */
function key(i: number, s: number): number {
  let x = Math.imul(i, 0x9e3779b1) ^ Math.imul(s + 1, 0x85ebca77);
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return x ^ (x >>> 16);
}

/** A growable list of cell indices. */
export class IntList {
  a = new Int32Array(4096);
  n = 0;
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

const B = 16;
const B3 = B * B * B;
/** Chunk coordinates are kept within ±CHUNK_LIMIT (cells within ±16k): far beyond any real run. */
const CHUNK_LIMIT = 1024;
const chunkKey = (cx: number, cy: number, cz: number) => ((cx + CHUNK_LIMIT) * 2048 + (cy + CHUNK_LIMIT)) * 2048 + (cz + CHUNK_LIMIT);

/** A 16³ block of cells. */
interface Chunk {
  cx: number;
  cy: number;
  cz: number;
  /** 0 empty, 1 alive, 2.. decaying. */
  state: Uint8Array;
  /** Live neighbours. */
  count: Uint8Array;
  /** The generation each cell last came alive (for colouring by age). */
  born: Uint16Array;
  /** Dedupes the cells to look at next generation. */
  stamp: Uint16Array;
  /** The 27 chunks around this one (13 = itself), by (dx + 1) + 3·(dy + 1) + 9·(dz + 1); -1 if not made yet. */
  nbr: Int32Array;
}

/**
 * An unbounded 3D grid: 16³ chunks made as cells reach them, so memory follows what the pattern
 * touches, with no walls. A cell is a number, chunk · 4096 + its place in the chunk.
 */
export class Grid3 {
  readonly chunks: Chunk[] = [];
  private readonly byKey = new Map<number, number>();
  /** Neighbour offsets: (dx, dy, dz) and, for a cell inside its chunk, the plain index step. */
  private readonly dirs: Int32Array;
  private readonly steps: Int32Array;
  /** Cells to look at next generation. */
  private cand = new IntList();
  private spare = new IntList();
  /** The last generation's changes: each cell and the state it had before. */
  readonly changed = new IntList();
  private was = new Uint8Array(4096);
  /**
   * When set (visual runs), every cell that changes is also appended here until the renderer drains
   * it: as the cell when it filled or emptied, as ~cell (negative) when it only went from one
   * non-empty state to another (which can't change what its neighbours show).
   */
  log: IntList | null = null;
  gen = 0;
  alive = 0;
  nonzero = 0;
  /** Live cells at each squared distance from the centre (in half-cells, so it stays whole). */
  private r2Count = new Int32Array(1024);
  private r2Max = 0;
  private h = 0;
  /** Pending new states during a step. */
  private next = new IntList();

  constructor(nb: Neighbourhood) {
    const d = nb === 'vn' ? VN : MOORE;
    this.dirs = Int32Array.from(d.flat());
    this.steps = Int32Array.from(d.map(([dx, dy, dz]) => dx + B * dy + B * B * dz));
  }

  /** Cells the chunks made so far can hold (the memory a run is using). */
  get capacity(): number {
    return this.chunks.length * B3;
  }

  /** The chunk at chunk coordinates, made if asked and missing (-1 otherwise). */
  private chunkAt(cx: number, cy: number, cz: number, make: boolean): number {
    const k = chunkKey(cx, cy, cz);
    const found = this.byKey.get(k);
    if (found !== undefined) return found;
    if (!make) return -1;
    if (Math.abs(cx) >= CHUNK_LIMIT || Math.abs(cy) >= CHUNK_LIMIT || Math.abs(cz) >= CHUNK_LIMIT) throw new Error('Grid3: pattern grew too far');
    const id = this.chunks.length;
    const c: Chunk = { cx, cy, cz, state: new Uint8Array(B3), count: new Uint8Array(B3), born: new Uint16Array(B3), stamp: new Uint16Array(B3), nbr: new Int32Array(27).fill(-1) };
    c.nbr[13] = id;
    this.chunks.push(c);
    this.byKey.set(k, id);
    // Link with the chunks already around it, both ways.
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy && !dz) continue;
          const o = this.byKey.get(chunkKey(cx + dx, cy + dy, cz + dz));
          if (o === undefined) continue;
          c.nbr[dx + 1 + 3 * (dy + 1) + 9 * (dz + 1)] = o;
          this.chunks[o].nbr[1 - dx + 3 * (1 - dy) + 9 * (1 - dz)] = id;
        }
    return id;
  }

  /** The cell at world coordinates (made if asked; -1 if missing otherwise). */
  cellAt(x: number, y: number, z: number, make = false): number {
    const c = this.chunkAt(x >> 4, y >> 4, z >> 4, make);
    return c < 0 ? -1 : c * B3 + (x & 15) + B * (y & 15) + B * B * (z & 15);
  }

  /** The cell one step (dx, dy, dz) from a cell: -1 if its chunk doesn't exist and `make` is off. */
  neighbour(id: number, dx: number, dy: number, dz: number, make: boolean): number {
    const ci = id >> 12;
    const l = id & 4095;
    const x = (l & 15) + dx;
    const y = ((l >> 4) & 15) + dy;
    const z = (l >> 8) + dz;
    if ((x | y | z) >= 0 && x < B && y < B && z < B) return id + dx + B * dy + B * B * dz;
    const sx = x < 0 ? -1 : x >= B ? 1 : 0;
    const sy = y < 0 ? -1 : y >= B ? 1 : 0;
    const sz = z < 0 ? -1 : z >= B ? 1 : 0;
    let nc = this.chunks[ci].nbr[sx + 1 + 3 * (sy + 1) + 9 * (sz + 1)];
    if (nc < 0) {
      if (!make) return -1;
      const c = this.chunks[ci];
      nc = this.chunkAt(c.cx + sx, c.cy + sy, c.cz + sz, true);
    }
    return nc * B3 + (x & 15) + B * (y & 15) + B * B * (z & 15);
  }

  /** World coordinates of a cell. */
  xyz(id: number, out: Int32Array) {
    const c = this.chunks[id >> 12];
    const l = id & 4095;
    out[0] = c.cx * B + (l & 15);
    out[1] = c.cy * B + ((l >> 4) & 15);
    out[2] = c.cz * B + (l >> 8);
  }

  state(id: number): number {
    return this.chunks[id >> 12].state[id & 4095];
  }

  born(id: number): number {
    return this.chunks[id >> 12].born[id & 4095];
  }

  /** The sum of the directions of a cell's open faces (a rough outward normal), into out. */
  openDirection(id: number, out: Float32Array) {
    out.fill(0);
    for (const [dx, dy, dz] of VN) {
      const n = this.neighbour(id, dx, dy, dz, false);
      if (n >= 0 && this.state(n)) continue;
      out[0] += dx;
      out[1] += dy;
      out[2] += dz;
    }
  }

  /** Whether any of a cell's six faces is open (its face neighbour empty or not made). */
  faceOpen(id: number): boolean {
    const l = id & 4095;
    const x = l & 15;
    const y = (l >> 4) & 15;
    const z = l >> 8;
    if (x > 0 && x < B - 1 && y > 0 && y < B - 1 && z > 0 && z < B - 1) {
      const st = this.chunks[id >> 12].state;
      return !st[l + 1] || !st[l - 1] || !st[l + B] || !st[l - B] || !st[l + B * B] || !st[l - B * B];
    }
    for (const [dx, dy, dz] of VN) {
      const n = this.neighbour(id, dx, dy, dz, false);
      if (n < 0 || !this.state(n)) return true;
    }
    return false;
  }

  /** Set a cell directly (seeding), at world coordinates. */
  set(x: number, y: number, z: number, v: number) {
    const id = this.cellAt(x, y, z, true);
    this.change(id, v);
    if (v === 1) this.chunks[id >> 12].born[id & 4095] = this.gen;
  }

  get empty(): boolean {
    return this.nonzero === 0;
  }

  /** Furthest live cell from the centre (cells). The centre is between cells, at (-½, -½, -½). */
  get radius(): number {
    return Math.sqrt(this.r2Max) / 2;
  }

  /** The state hash: equal states give equal hashes, to spot a pattern that has stopped changing or cycles. */
  hash(): number {
    return this.h >>> 0;
  }

  /** The state a cell of the last generation's `changed` list had before it (by position in the list). */
  wasAt(k: number): number {
    return this.was[k];
  }

  private addCand(id: number) {
    const c = this.chunks[id >> 12];
    const tag = (this.gen + 1) & 0xffff;
    if (c.stamp[id & 4095] === tag) return;
    c.stamp[id & 4095] = tag;
    this.cand.push(id);
  }

  /** Set a cell's state, keeping counts, totals, the hash and next generation's cells to look at. */
  private change(id: number, v: number) {
    const ch = this.chunks[id >> 12];
    const l = id & 4095;
    const s = ch.state[l];
    if (s === v) return;
    ch.state[l] = v;
    if (s) this.h ^= key(id, s);
    if (v) this.h ^= key(id, v);
    if (!s) this.nonzero++;
    if (!v) this.nonzero--;
    this.log?.push(s && v ? ~id : id);
    this.addCand(id);
    if ((s === 1) === (v === 1)) return;
    // Live status changed: every neighbour's count moves, and they may change next.
    const d = v === 1 ? 1 : -1;
    const x = l & 15;
    const y = (l >> 4) & 15;
    const z = l >> 8;
    const { steps, dirs } = this;
    if (x > 0 && x < B - 1 && y > 0 && y < B - 1 && z > 0 && z < B - 1) {
      // Inside the chunk: plain index steps, and the candidate dedupe inlined (this is the hot path).
      const { count, stamp } = ch;
      const tag = (this.gen + 1) & 0xffff;
      const cand = this.cand;
      for (let q = 0; q < steps.length; q++) {
        const n = l + steps[q];
        count[n] += d;
        if (stamp[n] !== tag) {
          stamp[n] = tag;
          if (cand.n === cand.a.length) cand.push(id + steps[q]);
          else cand.a[cand.n++] = id + steps[q];
        }
      }
    } else {
      for (let q = 0; q < steps.length; q++) {
        const n = this.neighbour(id, dirs[3 * q], dirs[3 * q + 1], dirs[3 * q + 2], true);
        this.chunks[n >> 12].count[n & 4095] += d;
        this.addCand(n);
      }
    }
    this.alive += d;
    const wx = ch.cx * B + x;
    const wy = ch.cy * B + y;
    const wz = ch.cz * B + z;
    const r2 = (2 * wx + 1) ** 2 + (2 * wy + 1) ** 2 + (2 * wz + 1) ** 2;
    if (r2 >= this.r2Count.length) {
      const bigger = new Int32Array(Math.max(r2 + 1, this.r2Count.length * 2));
      bigger.set(this.r2Count);
      this.r2Count = bigger;
    }
    if (d > 0) {
      this.r2Count[r2]++;
      if (r2 > this.r2Max) this.r2Max = r2;
    } else {
      this.r2Count[r2]--;
      while (this.r2Max > 0 && this.r2Count[this.r2Max] === 0) this.r2Max--;
    }
  }

  /** Advance one generation. */
  step(rule: Rule3): GenStats {
    const gen = ++this.gen;
    const stats: GenStats = { births: 0, deaths: 0, alive: 0, nonzero: 0, radius: 0, bx: 0, by: 0 };
    // Work out every candidate's new state first (all at once), then apply the changes.
    const list = this.cand;
    this.cand = this.spare;
    this.cand.n = 0;
    this.spare = list;
    const { survive, birth, states } = rule;
    const { next, changed, chunks } = this;
    next.n = 0;
    changed.n = 0;
    for (let k = 0; k < list.n; k++) {
      const id = list.a[k];
      const ch = chunks[id >> 12];
      const s = ch.state[id & 4095];
      const c = ch.count[id & 4095];
      const v = s === 0 ? (birth >>> c) & 1 : s === 1 ? ((survive >>> c) & 1 ? 1 : states > 2 ? 2 : 0) : s + 1 < states ? s + 1 : 0;
      if (v !== s) {
        changed.push(id);
        next.push(v);
      }
    }
    if (this.was.length < changed.n) this.was = new Uint8Array(changed.a.length);
    const at = new Int32Array(3);
    for (let k = 0; k < changed.n; k++) {
      const id = changed.a[k];
      const s = this.state(id);
      const v = next.a[k];
      this.was[k] = s;
      this.change(id, v);
      if (v === 1) {
        chunks[id >> 12].born[id & 4095] = gen;
        stats.births++;
        this.xyz(id, at);
        stats.bx += at[0] + 0.5;
        stats.by += at[1] + 0.5;
      } else if (s === 1) stats.deaths++;
    }
    stats.alive = this.alive;
    stats.nonzero = this.nonzero;
    stats.radius = this.radius;
    if (stats.births) {
      stats.bx /= stats.births;
      stats.by /= stats.births;
    }
    return stats;
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

/** Side of the tiles a Life board is split into: only tiles with recent changes are recomputed. */
const TILE = 8;
/** An unbounded board never grows beyond this (its edge is then a wall). */
export const MAX_LIFE_BOARD = 8192;

/**
 * A 2D Life-like board. Unbounded: it starts w × w and grows by half (re-centred) whenever live cells get
 * near an edge, so patterns run as on an infinite plane. Or a torus of fixed size (`wrap`).
 *
 * Cells are stored with a one-cell border (empty, or holding the wrapped-round cells), so neighbour
 * sums need no edge cases. Only tiles where something changed last generation, or next to one, are
 * recomputed: elsewhere nothing can change, and the other buffer already holds the same cells (they
 * didn't change last time either). Empty space costs nothing.
 *
 * Positions outside are "world" coordinates: where the starting cells were set, however far the
 * board has grown since.
 */
export class Life2 {
  w: number;
  readonly wrap: boolean;
  /** World (x, y) is board cell (x + off, y + off). */
  off = 0;
  /** Padded side (w + 2). */
  private pw: number;
  private cur: Uint8Array;
  private nxt: Uint8Array;
  private tw: number;
  /** Tiles that changed last generation. */
  private active: IntList = new IntList();
  private nextActive: IntList = new IntList();
  private dirtyStamp: Uint32Array;
  /** Live cells per tile. */
  private tileAlive: Int32Array;
  private h = 0;
  private alive = 0;
  gen = 0;

  constructor(w: number, wrap: boolean) {
    this.wrap = wrap;
    this.w = w;
    this.pw = w + 2;
    this.cur = new Uint8Array(this.pw * this.pw);
    this.nxt = new Uint8Array(this.pw * this.pw);
    this.tw = Math.ceil(w / TILE);
    this.dirtyStamp = new Uint32Array(this.tw * this.tw);
    this.tileAlive = new Int32Array(this.tw * this.tw);
  }

  get population(): number {
    return this.alive;
  }

  /** Set a cell (world coordinates; ignored off a torus or a full-grown board). */
  set(wx: number, wy: number, v: number) {
    const x = wx + this.off;
    const y = wy + this.off;
    if (x < 0 || y < 0 || x >= this.w || y >= this.w) return;
    const i = x + 1 + (y + 1) * this.pw;
    if (this.cur[i] === v) return;
    this.h ^= key(x + y * this.w, 0);
    const d = v ? 1 : -1;
    this.alive += d;
    this.cur[i] = v;
    const t = Math.floor(y / TILE) * this.tw + Math.floor(x / TILE);
    this.tileAlive[t] += d;
    this.active.push(t);
    if (this.wrap) this.syncBorder(this.cur);
  }

  /** Live cells in world coordinates, as x, y pairs. */
  liveCells(): Int32Array {
    const { w, pw, tw, cur, tileAlive, off } = this;
    const out = new Int32Array(this.alive * 2);
    let n = 0;
    for (let t = 0; t < tileAlive.length; t++) {
      if (!tileAlive[t]) continue;
      const x0 = (t % tw) * TILE;
      const y0 = Math.floor(t / tw) * TILE;
      for (let y = y0; y < Math.min(w, y0 + TILE); y++)
        for (let x = x0, i = x0 + 1 + (y + 1) * pw; x < Math.min(w, x0 + TILE); x++, i++)
          if (cur[i]) {
            out[n++] = x - off;
            out[n++] = y - off;
          }
    }
    return out;
  }

  /** Copy the opposite edges (and corners) into the border, for a wrapping board. */
  private syncBorder(b: Uint8Array) {
    const { w, pw } = this;
    for (let y = 1; y <= w; y++) {
      b[y * pw] = b[y * pw + w];
      b[y * pw + w + 1] = b[y * pw + 1];
    }
    b.copyWithin(0, w * pw, w * pw + pw);
    b.copyWithin((w + 1) * pw, pw, 2 * pw);
  }

  /** Whether a live tile sits in the outer ring of tiles (time to grow). */
  private nearEdge(): boolean {
    const { tw, tileAlive } = this;
    for (let k = 0; k < tw; k++)
      if (tileAlive[k] || tileAlive[(tw - 1) * tw + k] || tileAlive[k * tw] || tileAlive[k * tw + tw - 1]) return true;
    return false;
  }

  /** Grow the board by half, keeping the cells centred. */
  private grow() {
    const { w: ow, pw: opw, cur } = this;
    const w = Math.min(MAX_LIFE_BOARD, Math.ceil((ow * 1.5) / TILE) * TILE);
    const shift = Math.floor((w - ow) / 2);
    const pw = w + 2;
    const next = new Uint8Array(pw * pw);
    for (let y = 0; y < ow; y++) next.set(cur.subarray((y + 1) * opw + 1, (y + 1) * opw + 1 + ow), (y + 1 + shift) * pw + 1 + shift);
    this.w = w;
    this.pw = pw;
    this.off += shift;
    this.cur = next;
    this.nxt = new Uint8Array(pw * pw);
    this.tw = Math.ceil(w / TILE);
    this.dirtyStamp = new Uint32Array(this.tw * this.tw);
    this.tileAlive = new Int32Array(this.tw * this.tw);
    // Recount the tiles and the hash for the new layout; every live tile is looked at next step.
    this.active.n = 0;
    this.h = 0;
    for (let y = 0; y < w; y++)
      for (let x = 0, i = (y + 1) * pw + 1; x < w; x++, i++)
        if (next[i]) {
          const t = Math.floor(y / TILE) * this.tw + Math.floor(x / TILE);
          if (!this.tileAlive[t]++) this.active.push(t);
          this.h ^= key(x + y * w, 0);
        }
  }

  step(rule: Rule2): LifeStats {
    if (!this.wrap && this.w < MAX_LIFE_BOARD && this.nearEdge()) this.grow();
    const { w, pw, tw, wrap, cur, nxt, tileAlive } = this;
    const { birth, survive } = rule;
    const tag = ++this.gen;
    // Tiles to recompute: every tile that changed last generation and the eight around it.
    const dirty: number[] = [];
    const act = this.active;
    for (let k = 0; k < act.n; k++) {
      const t = act.a[k];
      const tx = t % tw;
      const ty = Math.floor(t / tw);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          let x = tx + dx;
          let y = ty + dy;
          if (x < 0 || y < 0 || x >= tw || y >= tw) {
            if (!wrap) continue;
            x = (x + tw) % tw;
            y = (y + tw) % tw;
          }
          const u = y * tw + x;
          if (this.dirtyStamp[u] === tag) continue;
          this.dirtyStamp[u] = tag;
          dirty.push(u);
        }
    }
    const nextActive = this.nextActive;
    nextActive.n = 0;
    let births = 0;
    let deaths = 0;
    let h = this.h;
    for (const t of dirty) {
      const x0 = (t % tw) * TILE;
      const y0 = Math.floor(t / tw) * TILE;
      const x1 = Math.min(w, x0 + TILE);
      const y1 = Math.min(w, y0 + TILE);
      let changed = false;
      let live = 0;
      for (let y = y0; y < y1; y++) {
        let mid = x0 + 1 + (y + 1) * pw;
        for (let x = x0; x < x1; x++, mid++) {
          const up = mid - pw;
          const dn = mid + pw;
          const k = cur[up - 1] + cur[up] + cur[up + 1] + cur[mid - 1] + cur[mid + 1] + cur[dn - 1] + cur[dn] + cur[dn + 1];
          const s = cur[mid];
          const v = s ? (survive >>> k) & 1 : (birth >>> k) & 1;
          nxt[mid] = v;
          live += v;
          if (v !== s) {
            changed = true;
            h ^= key(x + y * w, 0);
            if (v) births++;
            else deaths++;
          }
        }
      }
      tileAlive[t] = live;
      if (changed) nextActive.push(t);
    }
    if (wrap) this.syncBorder(nxt);
    this.h = h;
    this.alive += births - deaths;
    this.cur = nxt;
    this.nxt = cur;
    this.nextActive = act;
    this.active = nextActive;
    return { births, deaths, alive: this.alive };
  }

  /** The state hash: equal boards (of the same size) give equal hashes. */
  hash(): number {
    return this.h >>> 0;
  }
}
