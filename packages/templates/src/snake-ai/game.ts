import type { Rng } from '@sim/engine';

/**
 * A complete snake game played by a simple AI, computed up front (it's a pure grid game, so the
 * whole match is known at init and the template only plays it back).
 *
 * The AI heads for the apple only if, after eating it, it could still reach its own tail (so it
 * can't box itself in). Otherwise it stalls by following its tail along the longest route. If it
 * stalls for too long it gambles and goes for the apple anyway — which, late in the game, is what
 * makes "will it fill the board?" a real question: most games end either full or trapped a few
 * cells short.
 */
export interface SnakeGame {
  n: number;
  /** Head cell after each move; the first `startLength` entries are the starting body (tail first). */
  heads: Int16Array;
  /** Snake length after each move (same indexing as heads). */
  lens: Int16Array;
  /** Apple cell visible after each move (-1 once the board is full). */
  apples: Int16Array;
  /** 1 where that move ate an apple. */
  ate: Uint8Array;
  /** 1 where the AI took an apple it knew might trap it. */
  gamble: Uint8Array;
  startLength: number;
  /** Index of the last entry. */
  last: number;
  result: 'filled' | 'trapped';
}

const START_LENGTH = 3;

export function playSnake(n: number, rng: Rng): SnakeGame {
  const N = n * n;
  const cap = N * 400;
  const heads: number[] = [];
  const lens: number[] = [];
  const apples: number[] = [];
  const ate: number[] = [];
  const gamble: number[] = [];

  const row = Math.floor(n / 2);
  const body: number[] = [];
  for (let k = 0; k < START_LENGTH; k++) body.push(row * n + 1 + k);
  const occ = new Uint8Array(N);
  for (const c of body) occ[c] = 1;

  const free = () => {
    const out: number[] = [];
    for (let c = 0; c < N; c++) if (!occ[c]) out.push(c);
    return out;
  };
  const placeApple = () => {
    const f = free();
    return f.length ? f[rng.int(0, f.length - 1)] : -1;
  };
  let apple = placeApple();
  for (let k = 0; k < START_LENGTH; k++) {
    heads.push(body[k]);
    lens.push(k + 1);
    apples.push(apple);
    ate.push(0);
    gamble.push(0);
  }

  const nbrs = (c: number, out: number[]) => {
    out.length = 0;
    const x = c % n;
    const y = (c / n) | 0;
    if (y > 0) out.push(c - n);
    if (x < n - 1) out.push(c + 1);
    if (y < n - 1) out.push(c + n);
    if (x > 0) out.push(c - 1);
    return out;
  };

  // BFS that knows the body moves: the cell j places from the tail is free after j + 1 moves.
  const dist = new Int32Array(N);
  const prev = new Int32Array(N);
  const vac = new Int32Array(N);
  const queue = new Int32Array(N);
  const nb: number[] = [];
  function bfs(b: number[]): void {
    vac.fill(0);
    for (let j = 0; j < b.length; j++) vac[b[j]] = j + 1;
    dist.fill(-1);
    const h = b[b.length - 1];
    dist[h] = 0;
    prev[h] = -1;
    let qh = 0;
    let qt = 0;
    queue[qt++] = h;
    while (qh < qt) {
      const c = queue[qh++];
      for (const d of nbrs(c, nb)) {
        if (dist[d] >= 0 || vac[d] > dist[c] + 1) continue;
        dist[d] = dist[c] + 1;
        prev[d] = c;
        queue[qt++] = d;
      }
    }
  }
  const pathTo = (target: number): number[] | null => {
    if (target < 0 || dist[target] < 0) return null;
    const path: number[] = [];
    for (let c = target; prev[c] !== -1; c = prev[c]) path.push(c);
    return path.reverse();
  };
  /** Body after following `path` (eating the apple if the path ends on it). */
  const advance = (b: number[], path: number[]) => {
    const v = b.slice();
    for (const c of path) {
      if (c !== apple) v.shift();
      v.push(c);
    }
    return v;
  };
  const tailReachable = (v: number[]) => {
    if (v.length >= N) return true;
    bfs(v);
    return dist[v[0]] > 0;
  };

  let plan: number[] = [];
  let sinceApple = 0;
  let result: SnakeGame['result'] = 'trapped';

  for (let moves = 0; moves < cap; moves++) {
    if (!plan.length) {
      bfs(body);
      const path = pathTo(apple);
      let risky = 0;
      if (path) {
        const safe = tailReachable(advance(body, path));
        if (safe) plan = path;
        else if (sinceApple > 3 * N) {
          plan = path;
          risky = 1;
        }
      }
      if (!plan.length) {
        // Stall: the safe single step that leaves the longest route back to the tail. (Edging toward
        // the apple or hugging the tail instead cut the moves by ~40% but trap the snake around 70%.)
        let best = -1;
        let bestScore = -Infinity;
        for (const d of nbrs(body[body.length - 1], [])) {
          if (d === apple) continue;
          if (occ[d] && d !== body[0]) continue;
          const v = advance(body, [d]);
          bfs(v);
          const toTail = dist[v[0]];
          if (toTail <= 0 && v.length < N) continue;
          const score = toTail;
          if (score > bestScore) {
            bestScore = score;
            best = d;
          }
        }
        if (best < 0) {
          // Nothing safe: take any legal step (including the apple) and hope.
          for (const d of nbrs(body[body.length - 1], [])) if (!occ[d] || d === body[0]) best = d;
        }
        if (best < 0 || sinceApple > 8 * N) break; // boxed in (or circling forever): trapped
        plan = [best];
      }
      gamble[gamble.length - 1] = risky;
    }
    const c = plan.shift()!;
    const eat = c === apple;
    if (!eat) occ[body.shift()!] = 0;
    if (occ[c]) break; // ran into itself
    body.push(c);
    occ[c] = 1;
    if (eat) {
      sinceApple = 0;
      plan = [];
      apple = body.length >= N ? -1 : placeApple();
    } else sinceApple++;
    heads.push(c);
    lens.push(body.length);
    apples.push(apple);
    ate.push(eat ? 1 : 0);
    gamble.push(0);
    if (body.length >= N) {
      result = 'filled';
      break;
    }
    // Is there any legal move left? If not, the game ends here.
    const h = c;
    if (!nbrs(h, nb).some((d) => !occ[d] || d === body[0])) break;
  }
  return {
    n,
    heads: Int16Array.from(heads),
    lens: Int16Array.from(lens),
    apples: Int16Array.from(apples),
    ate: Uint8Array.from(ate),
    gamble: Uint8Array.from(gamble),
    startLength: START_LENGTH,
    last: heads.length - 1,
    result,
  };
}
