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

/** What the planner needs from the learner. The flat model (no data yet) explores evenly. */
export interface ArmModel {
  /** False until enough posts have matured; the chooser then explores evenly and runs no experiments. */
  ready: boolean;
  /** One posterior draw for the whole batch (Thompson sampling): arm → sampled reward. */
  sample(rng: Rng): (arm: Arm) => number;
  /** Expected reward and its uncertainty. */
  mean(arm: Arm): number;
  sd(arm: Arm): number;
  /** Least-tested aspect of this arm, shown on the Experiment badge. */
  experimentReason(arm: Arm): string;
}

export const flatArmModel: ArmModel = {
  ready: false,
  sample: (rng) => {
    const draws = new Map<string, number>();
    return (arm) => {
      const k = armKey(arm);
      if (!draws.has(k)) draws.set(k, rng.next());
      return draws.get(k)!;
    };
  },
  mean: () => 0,
  sd: () => 1,
  experimentReason: () => 'Exploring',
};

export interface ArmChoiceSettings {
  count: number;
  templateIds: string[];
  themeIds: string[];
  minLengthS: number;
  maxLengthS: number;
  /** Last time each template was posted, so none is starved (ms since epoch). */
  lastPostedAt?: Record<string, number>;
  now?: number;
}

export interface ChosenArm {
  arm: Arm;
  /** Set for exploration picks: chosen to learn, not because they are expected to win. */
  experiment?: { reason: string };
}

/** Share of each batch reserved for experiments once the model is steering. */
export const EXPERIMENT_SHARE = 0.2;
/** Templates not posted for this long get a boost so nothing silently starves. */
const STALE_MS = 14 * 86_400_000;
const STALE_BONUS = 0.3;
/** Experiments must still be plausible: expected reward within this of the best arm. */
const PLAUSIBLE_GAP = 1;
const UCB_Z = 1.5;

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
 * ceil(count / templates) times, no exact repeats. Once the model is steering, about a fifth of
 * the slots go to plausible arms with the highest upside (experiments), and long-unposted templates
 * get a boost.
 */
export function chooseArms(settings: ArmChoiceSettings, model: ArmModel, rng: Rng): ChosenArm[] {
  // Saved settings may name templates that have since been removed.
  const known = settings.templateIds.filter((id) => TEMPLATES.some((t) => t.id === id));
  const templates = known.length ? known : TEMPLATES.map((t) => t.id);
  const themes = settings.themeIds.length ? settings.themeIds : THEMES.map((t) => t.id);
  const buckets = allowedBuckets(settings.minLengthS, settings.maxLengthS);
  const styles = Object.keys(HOOK_STYLES) as HookStyle[];
  const candidates: Arm[] = [];
  for (const templateId of templates)
    for (const themeId of themes)
      for (const lengthBucket of buckets) for (const hookStyle of styles) candidates.push({ templateId, themeId, lengthBucket, hookStyle });

  const now = settings.now ?? Date.now();
  const stale = (t: string) => (model.ready && settings.lastPostedAt && now - (settings.lastPostedAt[t] ?? 0) > STALE_MS ? STALE_BONUS : 0);
  const draw = model.sample(rng);
  const scored = candidates.map((arm) => ({ arm, score: draw(arm) + stale(arm.templateId) })).sort((a, b) => b.score - a.score);

  const nExperiments = model.ready && settings.count >= 2 ? Math.max(1, Math.round(settings.count * EXPERIMENT_SHARE)) : 0;
  const maxPerTemplate = Math.max(1, Math.ceil(settings.count / Math.min(templates.length, settings.count)));
  const perTemplate = new Map<string, number>();
  const chosen: ChosenArm[] = [];
  const taken = new Set<string>();
  const take = (arm: Arm, experiment?: { reason: string }) => {
    perTemplate.set(arm.templateId, (perTemplate.get(arm.templateId) ?? 0) + 1);
    taken.add(armKey(arm));
    chosen.push(experiment ? { arm, experiment } : { arm });
  };
  const fits = (arm: Arm) => !taken.has(armKey(arm)) && (perTemplate.get(arm.templateId) ?? 0) < maxPerTemplate;

  for (const { arm } of scored) {
    if (chosen.length >= settings.count - nExperiments) break;
    if (fits(arm)) take(arm);
  }
  if (nExperiments) {
    const means = candidates.map((arm) => ({ arm, mean: model.mean(arm) }));
    const best = Math.max(...means.map((m) => m.mean));
    // Optimistic exploration: the arm that could plausibly be best (mean + 1.5 sd), not merely the
    // most uncertain one. Pure-uncertainty picks spent experiments on arms that were rarely worth it.
    const exploratory = means
      .filter((m) => m.mean >= best - PLAUSIBLE_GAP)
      .map((m) => ({ arm: m.arm, upper: m.mean + UCB_Z * model.sd(m.arm) }))
      .sort((a, b) => b.upper - a.upper);
    for (const { arm } of exploratory) {
      if (chosen.length >= settings.count) break;
      if (fits(arm)) take(arm, { reason: model.experimentReason(arm) });
    }
  }
  // If constraints left us short (tiny template list), fill with the best remaining arms.
  for (const { arm } of scored) {
    if (chosen.length >= settings.count) break;
    if (!taken.has(armKey(arm))) take(arm);
  }
  return chosen;
}
