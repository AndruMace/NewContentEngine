import type { Rng } from '@sim/engine';

export const OPEN = 0;
export const WALL = 1;
export const MUD = 2;
/** Cost of stepping onto a mud cell (open cells cost 1). */
export const MUD_COST = 5;

export const MAP_KINDS = ['maze', 'braided', 'open', 'weighted'] as const;
export type MapKind = (typeof MAP_KINDS)[number];

export interface GridMap {
  kind: MapKind;
  w: number;
  h: number;
  cells: Uint8Array;
  start: number;
  goal: number;
  /**
   * The order the map builds in for the intro: cells carved open (mazes, which start solid) or
   * walls/mud placed (open maps, which start empty).
   */
  build: Int32Array;
  buildCarves: boolean;
}

export const cost = (m: GridMap, c: number) => (m.cells[c] === MUD ? MUD_COST : 1);

/** Open neighbours in a fixed order (up, right, down, left). */
export function neighbours(m: GridMap, c: number, out: number[]): number[] {
  out.length = 0;
  const x = c % m.w;
  const y = (c / m.w) | 0;
  if (y > 0 && m.cells[c - m.w] !== WALL) out.push(c - m.w);
  if (x < m.w - 1 && m.cells[c + 1] !== WALL) out.push(c + 1);
  if (y < m.h - 1 && m.cells[c + m.w] !== WALL) out.push(c + m.w);
  if (x > 0 && m.cells[c - 1] !== WALL) out.push(c - 1);
  return out;
}

export function reachable(m: GridMap): boolean {
  const seen = new Uint8Array(m.w * m.h);
  const queue = [m.start];
  seen[m.start] = 1;
  const nb: number[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (queue[i] === m.goal) return true;
    for (const d of neighbours(m, queue[i], nb)) if (!seen[d]) {
      seen[d] = 1;
      queue.push(d);
    }
  }
  return false;
}

const odd = (n: number) => (n % 2 ? n : n - 1);

/** Start and goal in opposite corners (which pair is seeded). */
function corners(w: number, h: number, rng: Rng): [number, number] {
  const tl = 1 * w + 1;
  const br = (h - 2) * w + (w - 2);
  const tr = 1 * w + (w - 2);
  const bl = (h - 2) * w + 1;
  const pairs: [number, number][] = [[tl, br], [br, tl], [tr, bl], [bl, tr]];
  return pairs[rng.int(0, 3)];
}

/** Recursive backtracker on the odd cells: long winding corridors and a single route to the goal. */
function carveMaze(w: number, h: number, rng: Rng, start: number): { cells: Uint8Array; order: number[] } {
  const cells = new Uint8Array(w * h).fill(WALL);
  const order: number[] = [];
  const stack = [start];
  cells[start] = OPEN;
  order.push(start);
  const dirs = [-2 * w, 2, 2 * w, -2];
  while (stack.length) {
    const c = stack[stack.length - 1];
    const x = c % w;
    const y = (c / w) | 0;
    const options = dirs.filter((d) => {
      const nx = x + (d === 2 ? 2 : d === -2 ? -2 : 0);
      const ny = y + (d === 2 * w ? 2 : d === -2 * w ? -2 : 0);
      return nx > 0 && nx < w - 1 && ny > 0 && ny < h - 1 && cells[c + d] === WALL;
    });
    if (!options.length) {
      stack.pop();
      continue;
    }
    const d = options[rng.int(0, options.length - 1)];
    cells[c + d / 2] = OPEN;
    cells[c + d] = OPEN;
    order.push(c + d / 2, c + d);
    stack.push(c + d);
  }
  return { cells, order };
}

export function makeMap(kind: MapKind, wIn: number, hIn: number, rng: Rng): GridMap {
  const w = odd(Math.max(7, wIn));
  const h = odd(Math.max(7, hIn));
  const [start, goal] = corners(w, h, rng);
  if (kind === 'maze' || kind === 'braided') {
    const { cells, order } = carveMaze(w, h, rng, start);
    if (kind === 'braided') {
      // Knock out walls between two corridors (about 1 in 9 of them), so there are loops and
      // genuinely shorter and longer routes.
      const knock: number[] = [];
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const c = y * w + x;
          if (cells[c] !== WALL || (x % 2) + (y % 2) !== 1) continue;
          const horiz = x % 2 === 0;
          const a = horiz ? c - 1 : c - w;
          const b = horiz ? c + 1 : c + w;
          if (cells[a] === OPEN && cells[b] === OPEN) knock.push(c);
        }
      for (const c of knock) if (rng.chance(0.11)) {
        cells[c] = OPEN;
        order.push(c);
      }
    }
    return { kind, w, h, cells, start, goal, build: Int32Array.from(order), buildCarves: true };
  }

  for (let attempt = 0; ; attempt++) {
    const cells = new Uint8Array(w * h);
    const order: number[] = [];
    const set = (c: number, v: number) => {
      if (cells[c] === OPEN && c !== start && c !== goal) {
        cells[c] = v;
        order.push(c);
      }
    };
    // Frame.
    for (let x = 0; x < w; x++) {
      cells[x] = WALL;
      cells[(h - 1) * w + x] = WALL;
    }
    for (let y = 0; y < h; y++) {
      cells[y * w] = WALL;
      cells[y * w + w - 1] = WALL;
    }
    const inner = (w - 2) * (h - 2);
    const wallTarget = inner * (kind === 'open' ? 0.24 : 0.1);
    let walls = 0;
    for (let guard = 0; walls < wallTarget && guard < 10000; guard++) {
      const x0 = rng.int(1, w - 2);
      const y0 = rng.int(1, h - 2);
      if (rng.chance(0.2)) {
        // A small block.
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) if (x0 + dx < w - 1 && y0 + dy < h - 1) {
            const before = order.length;
            set((y0 + dy) * w + x0 + dx, WALL);
            walls += order.length - before;
          }
        continue;
      }
      const horiz = rng.chance(0.5);
      const len = rng.int(3, Math.max(4, Math.round(Math.min(w, h) * 0.45)));
      for (let k = 0; k < len; k++) {
        const x = horiz ? x0 + k : x0;
        const y = horiz ? y0 : y0 + k;
        if (x >= w - 1 || y >= h - 1) break;
        const before = order.length;
        set(y * w + x, WALL);
        walls += order.length - before;
      }
    }
    if (kind === 'weighted') {
      // Mud blobs over about a third of the field.
      const mudTarget = inner * 0.32;
      let mud = 0;
      for (let guard = 0; mud < mudTarget && guard < 5000; guard++) {
        const cx = rng.range(1, w - 2);
        const cy = rng.range(1, h - 2);
        const r = rng.range(1.6, Math.max(2.2, Math.min(w, h) * 0.18));
        for (let y = Math.max(1, Math.floor(cy - r)); y <= Math.min(h - 2, Math.ceil(cy + r)); y++)
          for (let x = Math.max(1, Math.floor(cx - r)); x <= Math.min(w - 2, Math.ceil(cx + r)); x++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
            const before = order.length;
            set(y * w + x, MUD);
            mud += order.length - before;
          }
      }
    }
    const m: GridMap = { kind, w, h, cells, start, goal, build: Int32Array.from(order), buildCarves: false };
    if (reachable(m) || attempt > 40) return m;
  }
}
