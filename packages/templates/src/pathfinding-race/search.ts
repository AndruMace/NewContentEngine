import { cost, neighbours, type GridMap } from './maps';

export const ALGOS = {
  bfs: { name: 'BFS', blurb: 'breadth-first' },
  dfs: { name: 'DFS', blurb: 'depth-first' },
  dijkstra: { name: 'Dijkstra', blurb: 'cheapest first' },
  astar: { name: 'A*', blurb: 'cost + distance' },
  greedy: { name: 'Greedy', blurb: 'closest first' },
  bidir: { name: 'Bidirectional', blurb: 'from both ends' },
  wall: { name: 'Wall follower', blurb: 'right hand on the wall' },
} as const;

export type AlgoId = keyof typeof ALGOS;

/** Ops: a cell found (queued) or expanded (visited). `side` 1 = the search from the goal (bidirectional). */
export const FOUND = 0;
export const EXPAND = 1;

export interface SearchRecord {
  algo: AlgoId;
  /** Triples of [kind, cell, side]. */
  ops: Int32Array;
  expansions: number;
  path: number[];
  /** Cost of the path (mud counts extra). */
  cost: number;
}

const manhattan = (m: GridMap, a: number, b: number) => Math.abs((a % m.w) - (b % m.w)) + Math.abs(((a / m.w) | 0) - ((b / m.w) | 0));

/** Minimal binary heap on [key1, key2, seq] tuples (seq makes ties deterministic). */
class Heap {
  private items: { k1: number; k2: number; seq: number; c: number }[] = [];
  private seq = 0;
  get size() {
    return this.items.length;
  }
  push(c: number, k1: number, k2: number) {
    const it = { k1, k2, seq: this.seq++, c };
    const a = this.items;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top.c;
  }
  private less(x: { k1: number; k2: number; seq: number }, y: { k1: number; k2: number; seq: number }) {
    return x.k1 !== y.k1 ? x.k1 < y.k1 : x.k2 !== y.k2 ? x.k2 < y.k2 : x.seq < y.seq;
  }
}

function pathFrom(prev: Int32Array, end: number): number[] {
  const path: number[] = [];
  for (let c = end; c !== -1; c = prev[c]) path.push(c);
  return path.reverse();
}

const pathCost = (m: GridMap, path: number[]) => path.slice(1).reduce((s, c) => s + cost(m, c), 0);

/** Run one algorithm to the goal, recording every step for playback. */
export function recordSearch(algo: AlgoId, m: GridMap): SearchRecord {
  const ops: number[] = [];
  const N = m.w * m.h;
  const prev = new Int32Array(N).fill(-1);
  const nb: number[] = [];
  let expansions = 0;
  const found = (c: number, side = 0) => ops.push(FOUND, c, side);
  const expand = (c: number, side = 0) => {
    ops.push(EXPAND, c, side);
    expansions++;
  };
  const done = (path: number[]): SearchRecord => ({ algo, ops: Int32Array.from(ops), expansions, path, cost: pathCost(m, path) });

  switch (algo) {
    case 'bfs': {
      const seen = new Uint8Array(N);
      const queue = [m.start];
      seen[m.start] = 1;
      found(m.start);
      for (let i = 0; i < queue.length; i++) {
        const c = queue[i];
        expand(c);
        if (c === m.goal) break;
        for (const d of neighbours(m, c, nb)) if (!seen[d]) {
          seen[d] = 1;
          prev[d] = c;
          queue.push(d);
          found(d);
        }
      }
      return done(pathFrom(prev, m.goal));
    }
    case 'dfs': {
      const visited = new Uint8Array(N);
      const stack = [m.start];
      found(m.start);
      while (stack.length) {
        const c = stack.pop()!;
        if (visited[c]) continue;
        visited[c] = 1;
        expand(c);
        if (c === m.goal) break;
        // Pushed in reverse so the first neighbour (up, right, down, left) is tried first.
        const ns = neighbours(m, c, nb).slice().reverse();
        for (const d of ns) if (!visited[d]) {
          prev[d] = c;
          stack.push(d);
          found(d);
        }
      }
      return done(pathFrom(prev, m.goal));
    }
    case 'dijkstra':
    case 'astar':
    case 'greedy': {
      const g = new Float64Array(N).fill(Infinity);
      const closed = new Uint8Array(N);
      const heap = new Heap();
      const h = (c: number) => manhattan(m, c, m.goal);
      const key = (c: number) => (algo === 'dijkstra' ? g[c] : algo === 'astar' ? g[c] + h(c) : h(c));
      g[m.start] = 0;
      heap.push(m.start, key(m.start), h(m.start));
      found(m.start);
      while (heap.size) {
        const c = heap.pop();
        if (closed[c]) continue;
        closed[c] = 1;
        expand(c);
        if (c === m.goal) break;
        for (const d of neighbours(m, c, nb)) {
          if (closed[d]) continue;
          // Greedy ignores costs entirely: it only cares how close a cell looks.
          const gd = g[c] + (algo === 'greedy' ? 1 : cost(m, d));
          if (algo === 'greedy' ? g[d] !== Infinity : gd >= g[d]) continue;
          if (g[d] === Infinity) found(d);
          g[d] = gd;
          prev[d] = c;
          heap.push(d, key(d), h(d));
        }
      }
      return done(pathFrom(prev, m.goal));
    }
    case 'bidir': {
      const owner = new Int8Array(N).fill(-1);
      const prevB = new Int32Array(N).fill(-1);
      const qs = [[m.start], [m.goal]];
      const heads = [0, 0];
      owner[m.start] = 0;
      owner[m.goal] = 1;
      found(m.start, 0);
      found(m.goal, 1);
      let meet: [number, number] | null = null;
      while (!meet && (heads[0] < qs[0].length || heads[1] < qs[1].length)) {
        for (const side of [0, 1]) {
          if (meet || heads[side] >= qs[side].length) continue;
          const c = qs[side][heads[side]++];
          expand(c, side);
          for (const d of neighbours(m, c, nb)) {
            if (owner[d] === side) continue;
            if (owner[d] === 1 - side) {
              meet = side === 0 ? [c, d] : [d, c];
              break;
            }
            owner[d] = side;
            (side === 0 ? prev : prevB)[d] = c;
            qs[side].push(d);
            found(d, side);
          }
        }
      }
      if (!meet) return done([]);
      const a = pathFrom(prev, meet[0]);
      const b: number[] = [];
      for (let c = meet[1]; c !== -1; c = prevB[c]) b.push(c);
      return done([...a, ...b]);
    }
    case 'wall': {
      // Right hand on the wall. Each step counts as an expansion; the shown path drops dead-end
      // detours (the walk with backtracking removed).
      const dx = [0, 1, 0, -1];
      const dy = [-1, 0, 1, 0];
      const open = (c: number, d: number) => {
        const x = (c % m.w) + dx[d];
        const y = ((c / m.w) | 0) + dy[d];
        return x >= 0 && y >= 0 && x < m.w && y < m.h && m.cells[y * m.w + x] !== 1 ? y * m.w + x : -1;
      };
      let c = m.start;
      let dir = 1;
      const route = [c];
      const seen = new Uint8Array(N);
      seen[c] = 1;
      found(c);
      expand(c);
      for (let guard = 0; c !== m.goal && guard < N * 8; guard++) {
        for (const turn of [1, 0, 3, 2]) {
          const nd = (dir + turn) % 4;
          const next = open(c, nd);
          if (next >= 0) {
            dir = nd;
            c = next;
            break;
          }
        }
        if (!seen[c]) {
          seen[c] = 1;
          found(c);
        }
        expand(c);
        if (route.length > 1 && route[route.length - 2] === c) route.pop();
        else route.push(c);
      }
      return done(route);
    }
  }
}

/** Cost of the cheapest route (for the ✓ shortest badge). */
export const optimalCost = (m: GridMap) => recordSearch('dijkstra', m).cost;
