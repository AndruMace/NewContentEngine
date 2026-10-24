import type { Rng } from '@sim/engine';

/**
 * Wright–Fisher populations, worked out generation by generation before the video plays (the script
 * needs to know when colours vanish and which one takes over). Each generation every individual has
 * one parent, picked at random from the one before (weighted by fitness, when a colour has an edge).
 *
 * Every row is kept in parent order, so the first row's colour blocks stay contiguous for good and
 * the lineage lines barely cross.
 */
export interface History {
  /** Colours. */
  k: number;
  /** Individuals in each generation. */
  rows: Uint8Array[];
  /** For generation g ≥ 1: each individual's parent, an index into row g − 1 (kept only when asked). */
  parents: (Uint16Array | null)[];
  /** Individuals of each colour, per generation. */
  counts: number[][];
}

export interface Grow {
  n: number;
  k: number;
  first: Uint8Array;
  /** Stop after this many generations at most. */
  maxGens: number;
  /** Relative fitness by colour (default all 1). */
  fitness?: number[];
  /** Population size of generation g (default n throughout). */
  sizeAt?: (g: number) => number;
  /** Stop once this holds for a generation's counts (default: one colour left). */
  stop?: (counts: number[], g: number) => boolean;
  /** Keep parent links for generations up to this one (lineage views keep them all). */
  parentsUpTo: number;
}

export const coloursLeft = (counts: number[]) => counts.reduce((a, c) => a + (c > 0 ? 1 : 0), 0);

export function countOf(row: Uint8Array, k: number): number[] {
  const c = new Array<number>(k).fill(0);
  for (let i = 0; i < row.length; i++) c[row[i]]++;
  return c;
}

/** A first generation in colour order, as near equal as the count allows (or as given). */
export function firstRow(n: number, k: number, shares?: number[]): Uint8Array {
  const row = new Uint8Array(n);
  const want = shares ?? new Array<number>(k).fill(1);
  const sum = want.reduce((a, b) => a + b, 0);
  let i = 0;
  let acc = 0;
  for (let c = 0; c < k; c++) {
    acc += want[c];
    const end = c === k - 1 ? n : Math.round((acc / sum) * n);
    for (; i < end; i++) row[i] = c;
  }
  return row;
}

/** Grow a population from its first generation until `stop` or maxGens. */
export function grow(rng: Rng, o: Grow): History {
  const rows: Uint8Array[] = [o.first];
  const parents: (Uint16Array | null)[] = [null];
  const counts: number[][] = [countOf(o.first, o.k)];
  const stop = o.stop ?? ((c: number[]) => coloursLeft(c) <= 1);
  const fit = o.fitness;
  const wMax = fit ? Math.max(...fit) : 1;
  for (let g = 1; g <= o.maxGens; g++) {
    if (stop(counts[g - 1], g - 1)) break;
    const prev = rows[g - 1];
    const m = prev.length;
    const size = o.sizeAt ? o.sizeAt(g) : o.n;
    // Pick each child's parent, then put the children in parent order (counting sort).
    const pick = new Uint16Array(size);
    for (let i = 0; i < size; i++) {
      let j = rng.int(0, m - 1);
      if (fit) while (rng.next() * wMax >= fit[prev[j]]) j = rng.int(0, m - 1);
      pick[i] = j;
    }
    const per = new Uint32Array(m + 1);
    for (let i = 0; i < size; i++) per[pick[i] + 1]++;
    for (let j = 0; j < m; j++) per[j + 1] += per[j];
    const order = new Uint16Array(size);
    for (let j = 0; j < m; j++) for (let q = per[j]; q < per[j + 1]; q++) order[q] = j;
    const row = new Uint8Array(size);
    for (let i = 0; i < size; i++) row[i] = prev[order[i]];
    rows.push(row);
    parents.push(g <= o.parentsUpTo ? order : null);
    counts.push(countOf(row, o.k));
  }
  return { k: o.k, rows, parents, counts };
}

/** Generations after which each colour was last seen (extinctions, in order), and the winner. */
export function milestones(h: History): { lost: { c: number; g: number }[]; winner: number; fixedAt: number; twoLeftAt: number; leadChanges: number } {
  const lost: { c: number; g: number }[] = [];
  let twoLeftAt = -1;
  let leadChanges = 0;
  let lead = leaderOf(h.counts[0]);
  for (let g = 1; g < h.counts.length; g++) {
    for (let c = 0; c < h.k; c++) if (h.counts[g - 1][c] > 0 && h.counts[g][c] === 0) lost.push({ c, g });
    if (twoLeftAt < 0 && coloursLeft(h.counts[g]) === 2 && coloursLeft(h.counts[g - 1]) > 2) twoLeftAt = g;
    const l = leaderOf(h.counts[g]);
    if (l !== lead && h.counts[g][l] > h.counts[g][lead]) {
      leadChanges++;
      lead = l;
    }
  }
  const last = h.counts[h.counts.length - 1];
  const fixed = coloursLeft(last) === 1;
  return { lost, winner: fixed ? last.findIndex((c) => c > 0) : -1, fixedAt: fixed ? h.counts.length - 1 : -1, twoLeftAt, leadChanges };
}

export function leaderOf(counts: number[]): number {
  let best = 0;
  for (let c = 1; c < counts.length; c++) if (counts[c] > counts[best]) best = c;
  return best;
}

/** Glue histories end to end (a series of trials): one timeline of generations. */
export function concat(parts: History[]): { h: History; starts: number[] } {
  const starts: number[] = [];
  const rows: Uint8Array[] = [];
  const parents: (Uint16Array | null)[] = [];
  const counts: number[][] = [];
  for (const p of parts) {
    starts.push(rows.length);
    rows.push(...p.rows);
    parents.push(...p.parents);
    counts.push(...p.counts);
  }
  return { h: { k: parts[0].k, rows, parents, counts }, starts };
}
