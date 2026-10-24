import * as dm from '@sim/physics/math';
import type { Rng } from '@sim/engine';

/**
 * Physarum (slime mold) as many tiny agents on a chemical trail (Jeff Jones' model). Each agent
 * smells the trail ahead, ahead-left and ahead-right, turns toward the strongest, steps forward and
 * leaves trail behind; the trail spreads and fades. Food keeps giving off trail. Tubes form where
 * agents keep passing, and the ones between food sources thicken while the rest fade.
 *
 * Headings are whole steps of a 1024-step circle (from a table), positions plain float sums, the
 * trail float multiply-adds: the same in Node and in the browser.
 */
export const N = 300;
const DIRS = 1024;
const SIN = new Float64Array(DIRS);
const COS = new Float64Array(DIRS);
for (let k = 0; k < DIRS; k++) {
  SIN[k] = dm.sin((k / DIRS) * Math.PI * 2);
  COS[k] = dm.cos((k / DIRS) * Math.PI * 2);
}

export interface MoldOpts {
  agents: number;
  /** Degrees. */
  sensorAngle: number;
  /** Cells. */
  sensorDistance: number;
  /** Degrees per tick. */
  turn: number;
  /** Fraction of trail kept each tick. */
  keep: number;
  /** How much the trail spreads each tick (0..1). */
  spread: number;
  /** Fraction of agents moved to a reached food source each tick: keeps the useful tubes fed. */
  respawn: number;
}

export interface Food {
  x: number;
  y: number;
  /** When it was reached (tick), or −1. */
  reached: number;
  start: boolean;
  /** Whether it's on the dish yet. */
  placed: boolean;
}

export interface Mold {
  o: MoldOpts;
  x: Float32Array;
  y: Float32Array;
  h: Int32Array;
  trail: Float32Array;
  tmp: Float32Array;
  /** Agents in each cell this tick. */
  occ: Uint16Array;
  /** 1 = blocked (outside the dish, a maze wall, the bay). */
  wall: Uint8Array;
  food: Food[];
  seed: number;
  tick: number;
  sa: number;
  ra: number;
  /**
   * Maze: each food's scent as it reaches through the corridors (1 at the food, 0 at the far end,
   * by walking distance), and the food each agent is heading for. Agents shuttle between the two,
   * so the tube along the shortest way between them carries all the traffic.
   */
  scent: Float32Array[] | null;
  target: Uint8Array;
}

/** A dish: everything outside the circle is wall. */
export function newMold(o: MoldOpts, wall: Uint8Array, food: Food[], rng: Rng): Mold {
  const n = o.agents;
  const m: Mold = {
    o,
    x: new Float32Array(n),
    y: new Float32Array(n),
    h: new Int32Array(n),
    trail: new Float32Array(N * N),
    tmp: new Float32Array(N * N),
    occ: new Uint16Array(N * N),
    wall,
    food,
    seed: rng.int(1, 0x7fffffff),
    tick: 0,
    sa: Math.round((o.sensorAngle / 360) * DIRS),
    ra: Math.max(1, Math.round((o.turn / 360) * DIRS)),
    scent: null,
    target: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) m.target[i] = i & 1;
  return m;
}

/** Each food's scent through the open cells (walking distance, breadth first), for the maze. */
export function addScents(m: Mold) {
  m.scent = m.food.map((f) => {
    const dist = new Int32Array(N * N).fill(-1);
    const queue = new Int32Array(N * N);
    let head = 0;
    let tail = 0;
    const c0 = Math.floor(f.y) * N + Math.floor(f.x);
    dist[c0] = 0;
    queue[tail++] = c0;
    let max = 1;
    while (head < tail) {
      const c = queue[head++];
      const x = c % N;
      const y = (c - x) / N;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const q = ny * N + nx;
        if (m.wall[q] || dist[q] >= 0) continue;
        dist[q] = dist[c] + 1;
        if (dist[q] > max) max = dist[q];
        queue[tail++] = q;
      }
    }
    const sc = new Float32Array(N * N);
    for (let c = 0; c < N * N; c++) sc[c] = dist[c] < 0 ? 0 : 1 - dist[c] / max;
    return sc;
  });
}

/** How strongly an agent follows its food's scent, against the trail. */
const SCENT = 1500;

export function dishWalls(): Uint8Array {
  const w = new Uint8Array(N * N);
  const c = (N - 1) / 2;
  const r2 = (N / 2 - 2) ** 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x - c) ** 2 + (y - c) ** 2 > r2) w[y * N + x] = 1;
  return w;
}

const lcg = (s: number) => (Math.imul(s, 1664525) + 1013904223) >>> 0;

/** Put every agent in a disc around (cx, cy) (or anywhere open, with r = Infinity). */
export function seedAgents(m: Mold, cx: number, cy: number, r: number) {
  let s = m.seed;
  for (let i = 0; i < m.o.agents; i++) {
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 50; tries++) {
      s = lcg(s);
      const a = s % DIRS;
      s = lcg(s);
      const d = r === Infinity ? 0 : Math.sqrt(s / 4294967296) * r;
      if (r === Infinity) {
        s = lcg(s);
        x = (s / 4294967296) * N;
        s = lcg(s);
        y = (s / 4294967296) * N;
      } else {
        x = cx + COS[a] * d;
        y = cy + SIN[a] * d;
      }
      if (!blocked(m, x, y)) break;
    }
    m.x[i] = x;
    m.y[i] = y;
    s = lcg(s);
    m.h[i] = s % DIRS;
  }
  m.seed = s;
}

const blocked = (m: Mold, x: number, y: number) => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  return ix < 0 || iy < 0 || ix >= N || iy >= N || m.wall[iy * N + ix] === 1;
};

const sense = (m: Mold, x: number, y: number, h: number, scent: Float32Array | null) => {
  const d = m.o.sensorDistance;
  const k = ((h % DIRS) + DIRS) % DIRS;
  const ix = Math.floor(x + COS[k] * d);
  const iy = Math.floor(y + SIN[k] * d);
  if (ix < 0 || iy < 0 || ix >= N || iy >= N) return -1;
  const c = iy * N + ix;
  if (m.wall[c]) return -1;
  return scent ? m.trail[c] * 0.25 + scent[c] * SCENT : m.trail[c];
};

export function stepMold(m: Mold) {
  const { trail, wall } = m;
  let s = m.seed;
  const reached = m.food.filter((f) => f.placed && (f.reached >= 0 || f.start));
  const occ = m.occ;
  occ.fill(0);
  for (let i = 0; i < m.o.agents; i++) {
    let x = m.x[i];
    let y = m.y[i];
    let h = m.h[i];
    const goal = m.scent && m.food[m.target[i]].placed ? m.scent[m.target[i]] : null;
    const f = sense(m, x, y, h, goal);
    const l = sense(m, x, y, h - m.sa, goal);
    const r = sense(m, x, y, h + m.sa, goal);
    s = lcg(s);
    if (f >= l && f >= r) {
      // Straight on (a tiny wobble now and then).
      if ((s & 31) === 0) h += (s & 32 ? 1 : -1) * m.ra;
    } else if (l > r) h -= m.ra;
    else if (r > l) h += m.ra;
    else h += (s & 1 ? 1 : -1) * m.ra;
    h = ((h % DIRS) + DIRS) % DIRS;
    const nx = x + COS[h];
    const ny = y + SIN[h];
    if (blocked(m, nx, ny)) {
      s = lcg(s);
      h = s % DIRS;
    } else {
      x = nx;
      y = ny;
      trail[Math.floor(y) * N + Math.floor(x)] += 1;
    }
    s = lcg(s);
    if (reached.length && s / 4294967296 < m.o.respawn) {
      s = lcg(s);
      const fd = reached[s % reached.length];
      s = lcg(s);
      x = fd.x + ((s & 7) - 3.5);
      y = fd.y + (((s >>> 3) & 7) - 3.5);
      h = (s >>> 6) % DIRS;
    }
    // Arrived: turn round for the other food.
    if (goal && goal[Math.floor(y) * N + Math.floor(x)] > 0.985) {
      m.target[i] ^= 1;
      h = (h + DIRS / 2) % DIRS;
    }
    m.x[i] = x;
    m.y[i] = y;
    m.h[i] = h;
    const c = Math.floor(y) * N + Math.floor(x);
    if (c >= 0 && c < N * N && occ[c] < 65535) occ[c]++;
  }
  m.seed = s;
  // Food keeps giving off trail.
  for (const f of m.food) {
    if (!f.placed) continue;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const c = (Math.floor(f.y) + dy) * N + Math.floor(f.x) + dx;
        if (c >= 0 && c < N * N && !wall[c]) trail[c] += 6;
      }
  }
  // Spread (3×3 blur, blended) and fade.
  const t = m.tmp;
  const keep = m.o.keep;
  const sp = m.o.spread;
  for (let y = 0; y < N; y++) {
    const row = y * N;
    for (let x = 0; x < N; x++) {
      const c = row + x;
      if (wall[c]) {
        t[c] = 0;
        continue;
      }
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= N) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= N) continue;
          const q = yy * N + xx;
          if (wall[q]) continue;
          sum += trail[q];
          cnt++;
        }
      }
      t[c] = (trail[c] * (1 - sp) + (sum / cnt) * sp) * keep;
    }
  }
  m.trail = t;
  m.tmp = trail;
  m.tick++;
  // Food reached: thick trail on it.
  for (const f of m.food) {
    if (!f.placed || f.start || f.reached >= 0) continue;
    if (agentsNear(m, f.x, f.y, 3) >= 6) f.reached = m.tick;
  }
}

function agentsNear(m: Mold, x: number, y: number, r: number): number {
  let sum = 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const c = (Math.floor(y) + dy) * N + Math.floor(x) + dx;
      if (c >= 0 && c < N * N) sum += m.occ[c];
    }
  return sum;
}

/** Share of the open dish the mold covers (trail above a threshold). */
export function coverage(m: Mold, threshold = 0.6): number {
  let on = 0;
  let open = 0;
  for (let c = 0; c < N * N; c++) {
    if (m.wall[c]) continue;
    open++;
    if (m.trail[c] > threshold) on++;
  }
  return open ? on / open : 0;
}

/** A perfect maze (one way between any two cells) carved into the dish's square middle. */
export function mazeWalls(rng: Rng, cells: number): { wall: Uint8Array; path: [number, number][]; entrance: [number, number]; exit: [number, number] } {
  const wall = new Uint8Array(N * N).fill(1);
  const size = Math.floor(N * 0.68);
  const ox = Math.floor((N - size) / 2);
  const cell = Math.floor(size / cells);
  const corridor = Math.max(4, Math.floor(cell * 0.62));
  const open = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < N && y < N) wall[y * N + x] = 0;
  };
  const centre = (i: number) => ox + i * cell + Math.floor((cell - corridor) / 2);
  const seen = new Uint8Array(cells * cells);
  const parent = new Int32Array(cells * cells).fill(-1);
  const stack = [0];
  seen[0] = 1;
  open(centre(0), centre(0), corridor, corridor);
  while (stack.length) {
    const c = stack[stack.length - 1];
    const cx = c % cells;
    const cy = Math.floor(c / cells);
    const options = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ].filter(([x, y]) => x >= 0 && y >= 0 && x < cells && y < cells && !seen[y * cells + x]);
    if (!options.length) {
      stack.pop();
      continue;
    }
    const [nx, ny] = options[rng.int(0, options.length - 1)];
    const nc = ny * cells + nx;
    seen[nc] = 1;
    parent[nc] = c;
    // Open the corridor from this cell to the next.
    const x0 = Math.min(centre(cx), centre(nx));
    const y0 = Math.min(centre(cy), centre(ny));
    open(x0, y0, Math.abs(centre(nx) - centre(cx)) + corridor, Math.abs(centre(ny) - centre(cy)) + corridor);
    stack.push(nc);
  }
  // The one path from the entrance (top left) to the exit (bottom right).
  const path: [number, number][] = [];
  for (let c = cells * cells - 1; c >= 0; c = parent[c]) {
    path.push([centre(c % cells) + corridor / 2, centre(Math.floor(c / cells)) + corridor / 2]);
    if (c === 0) break;
  }
  path.reverse();
  return { wall, path, entrance: path[0], exit: path[path.length - 1] };
}

/** Minimum spanning tree over the food (Prim), as pairs of indices. */
export function spanningTree(food: { x: number; y: number }[]): [number, number][] {
  const n = food.length;
  if (n < 2) return [];
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  best[0] = 0;
  const edges: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
    inTree[u] = 1;
    if (from[u] >= 0) edges.push([from[u], u]);
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const d = dm.hypot(food[u].x - food[v].x, food[u].y - food[v].y);
      if (d < best[v]) {
        best[v] = d;
        from[v] = u;
      }
    }
  }
  return edges;
}
