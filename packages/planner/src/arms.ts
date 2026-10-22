import { THEMES, type Rng } from '@sim/engine';
import { TEMPLATES, canonicalTemplateId } from '@sim/templates';

/** One combination a batch can plan: template, theme, length and hook style. */
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

export interface ArmChoiceSettings {
  count: number;
  templateIds: string[];
  themeIds: string[];
  minLengthS: number;
  maxLengthS: number;
}

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
 * Random arms with diversity constraints: no template more than ceil(count / templates) times,
 * no exact repeats.
 */
export function chooseArms(settings: ArmChoiceSettings, rng: Rng): Arm[] {
  // Saved settings may name templates that have since been removed (or renamed).
  const known = [...new Set(settings.templateIds.map(canonicalTemplateId))].filter((id) => TEMPLATES.some((t) => t.id === id));
  const templates = known.length ? known : TEMPLATES.map((t) => t.id);
  const themes = settings.themeIds.length ? settings.themeIds : THEMES.map((t) => t.id);
  const buckets = allowedBuckets(settings.minLengthS, settings.maxLengthS);
  const styles = Object.keys(HOOK_STYLES) as HookStyle[];
  const candidates: Arm[] = [];
  for (const templateId of templates)
    for (const themeId of themes)
      for (const lengthBucket of buckets) for (const hookStyle of styles) candidates.push({ templateId, themeId, lengthBucket, hookStyle });

  const scored = candidates.map((arm) => ({ arm, score: rng.next() })).sort((a, b) => b.score - a.score);

  const maxPerTemplate = Math.max(1, Math.ceil(settings.count / Math.min(templates.length, settings.count)));
  const perTemplate = new Map<string, number>();
  const chosen: Arm[] = [];
  const taken = new Set<string>();
  const take = (arm: Arm) => {
    perTemplate.set(arm.templateId, (perTemplate.get(arm.templateId) ?? 0) + 1);
    taken.add(armKey(arm));
    chosen.push(arm);
  };
  for (const { arm } of scored) {
    if (chosen.length >= settings.count) break;
    if (!taken.has(armKey(arm)) && (perTemplate.get(arm.templateId) ?? 0) < maxPerTemplate) take(arm);
  }
  // If constraints left us short (tiny template list), fill with the remaining arms.
  for (const { arm } of scored) {
    if (chosen.length >= settings.count) break;
    if (!taken.has(armKey(arm))) take(arm);
  }
  return chosen;
}
