/**
 * Sorting algorithms that record every comparison, swap and write, so a sort can be
 * replayed step by step. Ops are flat triples: [kind, a, b].
 */
export const CMP = 0;
export const SWAP = 1;
export const SET = 2;

class Recorder {
  ops: number[] = [];
  constructor(public a: number[]) {}
  less(i: number, j: number) {
    this.ops.push(CMP, i, j);
    return this.a[i] < this.a[j];
  }
  lessV(i: number, v: number, j = i) {
    this.ops.push(CMP, i, j);
    return this.a[i] < v;
  }
  swap(i: number, j: number) {
    if (i === j) return;
    this.ops.push(SWAP, i, j);
    [this.a[i], this.a[j]] = [this.a[j], this.a[i]];
  }
  set(i: number, v: number) {
    this.ops.push(SET, i, v);
    this.a[i] = v;
  }
}

type Sorter = (r: Recorder) => void;

const bubble: Sorter = (r) => {
  const n = r.a.length;
  for (let end = n - 1; end > 0; end--) {
    let swapped = false;
    for (let i = 0; i < end; i++) {
      if (r.less(i + 1, i)) {
        r.swap(i, i + 1);
        swapped = true;
      }
    }
    if (!swapped) break;
  }
};

const cocktail: Sorter = (r) => {
  let lo = 0;
  let hi = r.a.length - 1;
  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let i = lo; i < hi; i++) if (r.less(i + 1, i)) (r.swap(i, i + 1), (swapped = true));
    hi--;
    for (let i = hi; i > lo; i--) if (r.less(i, i - 1)) (r.swap(i, i - 1), (swapped = true));
    lo++;
  }
};

const insertion: Sorter = (r) => {
  for (let i = 1; i < r.a.length; i++) for (let j = i; j > 0 && r.less(j, j - 1); j--) r.swap(j, j - 1);
};

const selection: Sorter = (r) => {
  const n = r.a.length;
  for (let i = 0; i < n - 1; i++) {
    let m = i;
    for (let j = i + 1; j < n; j++) if (r.less(j, m)) m = j;
    r.swap(i, m);
  }
};

const gnome: Sorter = (r) => {
  let i = 0;
  while (i < r.a.length) {
    if (i === 0 || !r.less(i, i - 1)) i++;
    else {
      r.swap(i, i - 1);
      i--;
    }
  }
};

const comb: Sorter = (r) => {
  let gap = r.a.length;
  let sorted = false;
  while (!sorted) {
    gap = Math.max(1, Math.floor(gap / 1.3));
    sorted = gap === 1;
    for (let i = 0; i + gap < r.a.length; i++) {
      if (r.less(i + gap, i)) {
        r.swap(i, i + gap);
        sorted = false;
      }
    }
  }
};

const shell: Sorter = (r) => {
  const n = r.a.length;
  for (let gap = Math.floor(n / 2); gap > 0; gap = Math.floor(gap / 2)) {
    for (let i = gap; i < n; i++) for (let j = i; j >= gap && r.less(j, j - gap); j -= gap) r.swap(j, j - gap);
  }
};

const quick: Sorter = (r) => {
  const sort = (lo: number, hi: number) => {
    if (lo >= hi) return;
    r.swap((lo + hi) >> 1, hi); // middle pivot avoids worst case on sorted input
    let p = lo;
    for (let i = lo; i < hi; i++) if (r.less(i, hi)) r.swap(i, p++);
    r.swap(p, hi);
    sort(lo, p - 1);
    sort(p + 1, hi);
  };
  sort(0, r.a.length - 1);
};

const merge: Sorter = (r) => {
  const sort = (lo: number, hi: number) => {
    if (hi - lo < 1) return;
    const mid = (lo + hi) >> 1;
    sort(lo, mid);
    sort(mid + 1, hi);
    const left = r.a.slice(lo, mid + 1);
    const right = r.a.slice(mid + 1, hi + 1);
    let i = 0;
    let j = 0;
    for (let k = lo; k <= hi; k++) {
      // Compare the two heads in place for highlighting.
      if (j >= right.length || (i < left.length && (r.ops.push(CMP, lo + i, mid + 1 + j), left[i] <= right[j]))) r.set(k, left[i++]);
      else r.set(k, right[j++]);
    }
  };
  sort(0, r.a.length - 1);
};

const heap: Sorter = (r) => {
  const n = r.a.length;
  const sift = (start: number, end: number) => {
    let root = start;
    for (;;) {
      let child = 2 * root + 1;
      if (child > end) return;
      if (child + 1 <= end && r.less(child, child + 1)) child++;
      if (r.less(root, child)) {
        r.swap(root, child);
        root = child;
      } else return;
    }
  };
  for (let s = (n >> 1) - 1; s >= 0; s--) sift(s, n - 1);
  for (let end = n - 1; end > 0; end--) {
    r.swap(0, end);
    sift(0, end - 1);
  }
};

const radix: Sorter = (r) => {
  const max = Math.max(...r.a);
  for (let exp = 1; Math.floor(max / exp) > 0; exp *= 4) {
    const buckets: number[][] = [[], [], [], []];
    for (let i = 0; i < r.a.length; i++) {
      r.ops.push(CMP, i, i);
      buckets[Math.floor(r.a[i] / exp) % 4].push(r.a[i]);
    }
    let k = 0;
    for (const b of buckets) for (const v of b) r.set(k++, v);
  }
};

export const ALGORITHMS = {
  bubble: { name: 'Bubble', fn: bubble },
  cocktail: { name: 'Cocktail', fn: cocktail },
  insertion: { name: 'Insertion', fn: insertion },
  selection: { name: 'Selection', fn: selection },
  gnome: { name: 'Gnome', fn: gnome },
  comb: { name: 'Comb', fn: comb },
  shell: { name: 'Shell', fn: shell },
  quick: { name: 'Quick', fn: quick },
  merge: { name: 'Merge', fn: merge },
  heap: { name: 'Heap', fn: heap },
  radix: { name: 'Radix', fn: radix },
} as const;

export type AlgorithmId = keyof typeof ALGORITHMS;

export function recordSort(id: AlgorithmId, input: number[]): Int32Array {
  const r = new Recorder(input.slice());
  ALGORITHMS[id].fn(r);
  for (let i = 1; i < r.a.length; i++) if (r.a[i - 1] > r.a[i]) throw new Error(`${id} failed to sort`);
  return Int32Array.from(r.ops);
}
