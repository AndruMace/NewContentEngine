/** Small robust-statistics helpers. */

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median absolute deviation scaled to match the standard deviation of a normal distribution. */
export function mad(xs: number[]): number {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Robust z-scores (median/MAD), winsorised to ±cap so one viral post can't swamp the rest.
 * With few points the spread falls back towards `priorScale`, so early scores aren't wild.
 */
export function robustZ(xs: number[], priorScale: number, cap = 3): number[] {
  if (!xs.length) return [];
  const center = xs.length >= 3 ? median(xs) : 0;
  const n = xs.length;
  const observed = n >= 3 ? mad(xs) : priorScale;
  // Shrink the spread estimate towards the prior while n is small.
  const k = 8;
  // Floor at half the prior: near-identical values must not turn tiny differences into ±3.
  const scale = Math.max(priorScale / 2, (n * (observed || priorScale) + k * priorScale) / (n + k));
  return xs.map((x) => clamp((x - center) / scale, -cap, cap));
}

/** Spearman rank correlation (average ranks for ties). */
export function spearman(a: number[], b: number[]): number {
  if (a.length < 3) return NaN;
  const rank = (xs: number[]) => {
    const idx = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(xs.length);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const ma = ra.reduce((s, x) => s + x, 0) / ra.length;
  const mb = rb.reduce((s, x) => s + x, 0) / rb.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Ordinary least squares y = a + b·x (returns null with fewer than 3 points or no spread in x). */
export function ols(x: number[], y: number[]): { a: number; b: number } | null {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  if (sxx < 1e-9) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}
