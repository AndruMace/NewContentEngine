/**
 * Reward: one number per post saying how well it did relative to the channel, built from raw
 * snapshots so it can be recomputed whenever the weights or formulas change.
 *
 * Each component is baseline-relative (rolling median of the previous posts, so channel growth
 * doesn't look like improvement) and robust-z-scored (median/MAD, winsorised so a viral outlier
 * can't swamp everything). Posts are scored at a fixed age (7 days) so different days compare fairly.
 */
import { clamp, median, ols, robustZ } from './stats';

export type RewardComponent = 'retention' | 'reach' | 'engagement' | 'followers';
export type RewardWeights = Record<RewardComponent, number>;

export const REWARD_PRESETS: Record<string, { label: string; weights: RewardWeights }> = {
  'retention-first': { label: 'Retention first', weights: { retention: 0.45, reach: 0.3, engagement: 0.15, followers: 0.1 } },
  balanced: { label: 'Balanced', weights: { retention: 0.3, reach: 0.3, engagement: 0.2, followers: 0.2 } },
  reach: { label: 'Reach', weights: { retention: 0.25, reach: 0.5, engagement: 0.15, followers: 0.1 } },
};
export const DEFAULT_REWARD_WEIGHTS = REWARD_PRESETS['retention-first'].weights;

export interface OutcomeSnapshot {
  ageH: number;
  metrics: Record<string, number>;
}

export interface PostOutcome {
  id: string;
  publishedAt: number;
  /** Age now, in hours. */
  ageH: number;
  durationS: number;
  /** Ordered by age. */
  snapshots: OutcomeSnapshot[];
  /** Mean of YouTube's relativeRetentionPerformance (0.5 = typical for that length). */
  relativeRetention?: number | null;
  manual?: Record<string, number>;
}

export interface RewardOptions {
  weights?: RewardWeights;
  /** Age at which posts are compared. */
  horizonH?: number;
  /** Youngest age that counts at all (Analytics data lags about two days). */
  minAgeH?: number;
}

export interface PostReward {
  id: string;
  /** Weighted blend of component z-scores; null when the post can't be scored yet. */
  reward: number | null;
  /** How much the learner trusts this reward (0.4 at 3 days → 1 at 7 days). */
  weight: number;
  provisional: boolean;
  components: Partial<Record<RewardComponent, number>>;
  /** Inputs before z-scoring, for display. */
  raw: { viewsAtHorizon?: number; apv?: number; expectedApv?: number; engagementRate?: number; subsPer1k?: number };
  reason?: string;
}

export interface RewardResult {
  rewards: PostReward[];
  /** views(t) ∝ t^growth between 3 and 7 days; used to estimate 7-day views for younger posts. */
  growth: number;
  /** Expected log(avg % viewed) = a + b·log(duration). */
  apvCurve: { a: number; b: number };
}

const DEFAULT_HORIZON_H = 168;
const DEFAULT_MIN_AGE_H = 72;
/** Prior: 7-day views ≈ 1.6× 3-day views. */
const PRIOR_GROWTH = Math.log(1.6) / Math.log(168 / 72);
/** Prior: a 30 s Short averages ~80% viewed, longer ones less (slope from typical Shorts curves). */
const PRIOR_APV_B = -0.37;
const PRIOR_APV = { a: Math.log(80) - PRIOR_APV_B * Math.log(30), b: PRIOR_APV_B };

/** Latest value of each metric up to (and including) the given age. */
function merged(snaps: OutcomeSnapshot[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const s of snaps) Object.assign(m, s.metrics);
  return m;
}

/** Views at the horizon: interpolated when bracketed, otherwise the nearest snapshot (scaled up if younger). */
function viewsAt(snaps: OutcomeSnapshot[], H: number, growth: number): { value: number; exact: boolean } | null {
  const pts = snaps.filter((s) => s.metrics.views !== undefined);
  if (!pts.length) return null;
  const after = pts.find((s) => s.ageH >= H);
  const before = [...pts].reverse().find((s) => s.ageH < H);
  if (after && before) {
    const f = (H - before.ageH) / Math.max(1e-6, after.ageH - before.ageH);
    return { value: before.metrics.views + f * (after.metrics.views - before.metrics.views), exact: true };
  }
  if (after) return { value: after.metrics.views, exact: true };
  const last = pts[pts.length - 1];
  return { value: last.metrics.views * Math.pow(H / Math.max(1, last.ageH), growth), exact: false };
}

/** Learn the 3→7-day growth exponent from posts that have both, shrunk towards the prior. */
function learnGrowth(posts: PostOutcome[], H: number): number {
  const gs: number[] = [];
  for (const p of posts) {
    const early = p.snapshots.filter((s) => s.metrics.views > 0 && s.ageH >= 36 && s.ageH <= H * 0.75).pop();
    const late = viewsAt(p.snapshots, H, PRIOR_GROWTH);
    if (!early || !late?.exact || late.value <= early.metrics.views * 0.999) continue;
    gs.push(Math.log(late.value / early.metrics.views) / Math.log(H / early.ageH));
  }
  if (!gs.length) return PRIOR_GROWTH;
  const n = gs.length;
  return clamp((n * median(gs) + 5 * PRIOR_GROWTH) / (n + 5), 0, 1.5);
}

/** Each value minus the median of the previous `window` values (or of all values while history is short). */
function rollingResidual(values: (number | undefined)[], window = 20): (number | undefined)[] {
  const all = values.filter((v): v is number => v !== undefined);
  const globalMed = all.length ? median(all) : 0;
  const prev: number[] = [];
  return values.map((v) => {
    if (v === undefined) return undefined;
    const base = prev.length >= 3 ? median(prev.slice(-window)) : globalMed;
    prev.push(v);
    return v - base;
  });
}

/** z-score the defined entries of a sparse column, leaving the gaps. */
function zColumn(values: (number | undefined)[], priorScale: number): (number | undefined)[] {
  const idx = values.flatMap((v, i) => (v === undefined || !Number.isFinite(v) ? [] : [i]));
  const z = robustZ(
    idx.map((i) => values[i]!),
    priorScale,
  );
  const out: (number | undefined)[] = values.map(() => undefined);
  idx.forEach((i, k) => (out[i] = z[k]));
  return out;
}

const weightedMean = (parts: [number | undefined, number][]) => {
  let s = 0;
  let w = 0;
  for (const [v, k] of parts) if (v !== undefined) (s += v * k), (w += k);
  return w ? s / w : undefined;
};

export function computeRewards(posts: PostOutcome[], opts: RewardOptions = {}): RewardResult {
  const H = opts.horizonH ?? DEFAULT_HORIZON_H;
  const minAge = opts.minAgeH ?? DEFAULT_MIN_AGE_H;
  const weights = opts.weights ?? DEFAULT_REWARD_WEIGHTS;
  const sorted = [...posts].sort((a, b) => a.publishedAt - b.publishedAt);
  const eligible = sorted.filter((p) => p.ageH >= minAge && p.snapshots.some((s) => s.metrics.views !== undefined));
  const growth = learnGrowth(eligible, H);

  // Per-post raw inputs.
  const rows = eligible.map((p) => {
    const atH = p.snapshots.filter((s) => s.ageH <= Math.max(H, p.snapshots[0]?.ageH ?? 0) + 24);
    const m = merged(atH.length ? atH : p.snapshots);
    const views = viewsAt(p.snapshots, H, growth);
    const aViews = m.aViews ?? 0;
    const engagementRate =
      aViews > 0
        ? ((m.aLikes ?? 0) + 2 * (m.aComments ?? 0) + 3 * (m.shares ?? 0)) / aViews
        : m.views > 0
          ? ((m.likes ?? 0) + 2 * (m.comments ?? 0)) / m.views
          : undefined;
    const viewsForSubs = aViews || m.views;
    return {
      p,
      viewsH: views?.value,
      exact: views?.exact ?? false,
      apv: m.averageViewPercentage > 0 ? m.averageViewPercentage : undefined,
      replay: m.engagedViews > 0 && aViews > 0 ? Math.log(aViews / m.engagedViews) : undefined,
      rel: p.relativeRetention ?? undefined,
      stayed: p.manual?.stayedPct,
      engagementRate,
      subsPer1k: m.subscribersGained !== undefined && viewsForSubs > 0 ? ((m.subscribersGained - (m.subscribersLost ?? 0)) / viewsForSubs) * 1000 : undefined,
    };
  });

  // Length-adjusted retention: fit log(APV) on log(duration), shrunk towards the prior curve.
  const withApv = rows.filter((r) => r.apv !== undefined && r.p.durationS > 0);
  const fit = ols(
    withApv.map((r) => Math.log(r.p.durationS)),
    withApv.map((r) => Math.log(r.apv!)),
  );
  const k = withApv.length / (withApv.length + 10);
  const b = fit ? k * fit.b + (1 - k) * PRIOR_APV.b : PRIOR_APV.b;
  // Intercept: keep the channel's own level (median residual vs the slope), so the curve fits this channel.
  const a = withApv.length ? median(withApv.map((r) => Math.log(r.apv!) - b * Math.log(r.p.durationS))) : PRIOR_APV.a;
  const expected = (d: number) => a + b * Math.log(d);

  const apvZ = zColumn(rows.map((r) => (r.apv !== undefined ? Math.log(r.apv) - expected(r.p.durationS) : undefined)), 0.2);
  const relZ = zColumn(rows.map((r) => (r.rel !== undefined ? r.rel - 0.5 : undefined)), 0.15);
  const replayZ = zColumn(rows.map((r) => r.replay), 0.15);
  const stayedZ = zColumn(rows.map((r) => r.stayed), 10);
  const reachZ = zColumn(rollingResidual(rows.map((r) => (r.viewsH !== undefined ? Math.log(r.viewsH + 1) : undefined))), 0.8);
  const engZ = zColumn(rollingResidual(rows.map((r) => (r.engagementRate !== undefined ? Math.log(r.engagementRate + 1e-4) : undefined))), 0.4);
  const subsZ = zColumn(rollingResidual(rows.map((r) => r.subsPer1k)), 1);

  const scored = new Map<string, PostReward>();
  rows.forEach((r, i) => {
    const components: Partial<Record<RewardComponent, number>> = {};
    const retention = weightedMean([
      [apvZ[i], 2],
      [relZ[i], 1],
      [replayZ[i], 1],
      [stayedZ[i], 2],
    ]);
    if (retention !== undefined) components.retention = retention;
    if (reachZ[i] !== undefined) components.reach = reachZ[i];
    if (engZ[i] !== undefined) components.engagement = engZ[i];
    if (subsZ[i] !== undefined) components.followers = subsZ[i];
    const reward = weightedMean((Object.keys(components) as RewardComponent[]).map((c) => [components[c], weights[c]]));
    const maturity = clamp((r.p.ageH - minAge) / Math.max(1, H - minAge), 0, 1);
    scored.set(r.p.id, {
      id: r.p.id,
      reward: reward ?? null,
      weight: reward === undefined ? 0 : 0.4 + 0.6 * maturity,
      provisional: r.p.ageH < H,
      components,
      raw: {
        viewsAtHorizon: r.viewsH,
        apv: r.apv,
        expectedApv: r.p.durationS > 0 ? Math.exp(expected(r.p.durationS)) : undefined,
        engagementRate: r.engagementRate,
        subsPer1k: r.subsPer1k,
      },
    });
  });

  const rewards = posts.map(
    (p) =>
      scored.get(p.id) ?? {
        id: p.id,
        reward: null,
        weight: 0,
        provisional: true,
        components: {},
        raw: {},
        reason: p.ageH < minAge ? `Scored from ${Math.round(minAge / 24)} days old` : 'No stats yet',
      },
  );
  return { rewards, growth, apvCurve: { a, b } };
}
