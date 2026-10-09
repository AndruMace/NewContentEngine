import { THEMES, type Rng } from '@sim/engine';
import { TEMPLATES } from '@sim/templates';

/** A bandit arm: one combination the learner can score (Phase 5 updates the stats). */
export interface Arm {
  templateId: string;
  themeId: string;
  lengthBucket: LengthBucket;
  hookStyle: HookStyle;
}

export type LengthBucket = 'short' | 'medium' | 'long';
export type HookStyle = 'question' | 'challenge' | 'pick-a-side' | 'curiosity';

export const LENGTH_BUCKETS: Record<LengthBucket, [number, number]> = {
  short: [15, 25],
  medium: [25, 40],
  long: [40, 60],
};

export const HOOK_STYLES: Record<HookStyle, string> = {
  question: 'Pose a yes/no question about the outcome ("Can it escape all 30 rings?").',
  challenge: 'Dare the viewer ("Bet you can\'t watch without guessing wrong").',
  'pick-a-side': 'Ask viewers to commit to a side before it starts ("Pick a color now").',
  curiosity: 'Tease the satisfying payoff ("Wait for the last layer…").',
};

export const armKey = (a: Arm) => `${a.templateId}|${a.themeId}|${a.lengthBucket}|${a.hookStyle}`;

export interface ArmStats {
  alpha: number;
  beta: number;
}

export interface ArmChoiceSettings {
  count: number;
  templateIds: string[];
  themeIds: string[];
  minLengthS: number;
  maxLengthS: number;
}

/** Gamma(k,1) sampler (Marsaglia–Tsang), for Beta sampling. */
function gamma(rng: Rng, k: number): number {
  if (k < 1) return gamma(rng, k + 1) * Math.pow(rng.next() || 1e-12, 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box-Muller normal.
      x = Math.sqrt(-2 * Math.log(rng.next() || 1e-12)) * Math.cos(2 * Math.PI * rng.next());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng.next();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

const sampleBeta = (rng: Rng, a: number, b: number) => {
  const x = gamma(rng, a);
  return x / (x + gamma(rng, b));
};

/** Length buckets that overlap the requested range. */
export function allowedBuckets(minS: number, maxS: number): LengthBucket[] {
  const out = (Object.keys(LENGTH_BUCKETS) as LengthBucket[]).filter((b) => {
    const [lo, hi] = LENGTH_BUCKETS[b];
    return lo < maxS && hi > minS;
  });
  return out.length ? out : ['medium'];
}

/** Target length for an arm, inside both its bucket and the requested range. */
export function targetLength(bucket: LengthBucket, minS: number, maxS: number, rng: Rng): number {
  const [lo, hi] = LENGTH_BUCKETS[bucket];
  const a = Math.max(lo, minS);
  const b = Math.min(hi, maxS);
  return Math.round(a <= b ? rng.range(a, b) : (minS + maxS) / 2);
}

/**
 * Thompson sampling over arms with diversity constraints: no template more than
 * ceil(count / 2) times (and spread across templates when possible), no exact repeats.
 */
export function chooseArms(settings: ArmChoiceSettings, stats: Map<string, ArmStats>, rng: Rng): Arm[] {
  const templates = settings.templateIds.length ? settings.templateIds : TEMPLATES.map((t) => t.id);
  const themes = settings.themeIds.length ? settings.themeIds : THEMES.map((t) => t.id);
  const buckets = allowedBuckets(settings.minLengthS, settings.maxLengthS);
  const styles = Object.keys(HOOK_STYLES) as HookStyle[];
  const candidates: Arm[] = [];
  for (const templateId of templates)
    for (const themeId of themes)
      for (const lengthBucket of buckets) for (const hookStyle of styles) candidates.push({ templateId, themeId, lengthBucket, hookStyle });

  const scored = candidates
    .map((arm) => {
      const s = stats.get(armKey(arm)) ?? { alpha: 1, beta: 1 };
      return { arm, draw: sampleBeta(rng, s.alpha, s.beta) };
    })
    .sort((a, b) => b.draw - a.draw);

  const maxPerTemplate = Math.max(1, Math.ceil(settings.count / Math.min(templates.length, settings.count)));
  const perTemplate = new Map<string, number>();
  const chosen: Arm[] = [];
  for (const { arm } of scored) {
    if (chosen.length >= settings.count) break;
    const n = perTemplate.get(arm.templateId) ?? 0;
    if (n >= maxPerTemplate) continue;
    perTemplate.set(arm.templateId, n + 1);
    chosen.push(arm);
  }
  // If constraints left us short (tiny template list), fill with the best remaining arms.
  for (const { arm } of scored) {
    if (chosen.length >= settings.count) break;
    if (!chosen.includes(arm)) chosen.push(arm);
  }
  return chosen;
}
