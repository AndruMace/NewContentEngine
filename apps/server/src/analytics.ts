/**
 * Analytics orchestration: rewards from snapshots, the learner fit, predictions for the planner
 * and Review, and what the Analytics tab shows.
 */
import { join } from 'node:path';
import { scoreRecipe } from '@sim/render/search';
import { findTemplate } from '@sim/templates';
import { flatArmModel, type ArmModel } from '@sim/planner';
import {
  DEFAULT_REWARD_WEIGHTS,
  READY_AT,
  armModel,
  calibration,
  computeRewards,
  copyFeatures,
  defaultCatalog,
  featureSpace,
  fitLearner,
  predict,
  type LearnerInput,
  type LearnerModel,
  type PostFeatures,
  type PostOutcome,
  type PostReward,
  type Prediction,
  type RewardWeights,
} from '@sim/analytics';
import {
  allPosts,
  exportForRender,
  getConcept,
  getKv,
  getRender,
  insertPredictionOnce,
  predictionFor,
  retentionFor,
  setKv,
  snapshotsFor,
  type Platform,
  type PostRow,
  type RenderRow,
} from './db';

const HOUR = 3_600_000;

/** Latest value of every metric across a post's snapshots (later snapshots win). */
export function latestMetrics(renderId: string, platform: Platform): { metrics: Record<string, number>; fetchedAt: number | null; count: number } {
  const snaps = snapshotsFor(renderId, platform);
  const metrics: Record<string, number> = {};
  for (const s of snaps) Object.assign(metrics, s.metrics);
  return { metrics, fetchedAt: snaps.at(-1)?.fetchedAt ?? null, count: snaps.length };
}

/** Everything the learner may use about this video. Re-simulates it to get the exact drama breakdown. */
export function postFeatures(r: RenderRow): PostFeatures {
  const c = r.conceptId ? getConcept(r.conceptId)?.concept : undefined;
  const targetS = r.recipe.targetS ?? c?.targetS ?? 30;
  // Renders of a removed template can't be re-simulated; fall back to the score stored at render time.
  const drama = findTemplate(r.recipe.templateId) ? scoreRecipe(r.recipe, targetS) : { total: r.score ?? 0.5, parts: r.scoreParts ?? {}, durationS: r.durationS ?? targetS };
  const arm = c?.arm ?? { templateId: r.recipe.templateId, themeId: r.recipe.themeId, lengthBucket: bucketFor(drama.durationS), hookStyle: 'question' as const };
  return {
    version: 1,
    arm,
    melodyId: r.recipe.melodyId,
    params: r.recipe.params as Record<string, unknown>,
    targetS,
    durationS: r.durationS ?? drama.durationS,
    drama: { total: drama.total, parts: drama.parts },
    copy: copyFeatures({ hook: r.copy?.hook ?? r.recipe.copy?.hook ?? '', cta: r.copy?.cta ?? r.recipe.copy?.cta ?? '', title: r.copy?.title }),
    source: c?.source ?? r.kind,
    experiment: Boolean(c?.experiment),
    rankScore: r.rankScore,
  };
}

const bucketFor = (s: number) => (s < 25 ? 'short' : s < 40 ? 'medium' : 'long') as 'short' | 'medium' | 'long';

export const featuresToInput = (f: PostFeatures, publishedAt?: number): LearnerInput => ({
  arm: f.arm,
  melodyId: f.melodyId,
  durationS: f.durationS,
  drama: f.drama.total,
  copy: f.copy,
  params: f.params,
  publishedAt,
});

/** Features frozen at export, or (for posts linked without one) derived now and frozen from then on. */
function featuresFor(renderId: string): PostFeatures | null {
  const frozen = predictionFor(renderId)?.features;
  if (frozen) return frozen;
  const r = getRender(renderId);
  if (!r) return null;
  const features = postFeatures(r);
  insertPredictionOnce({ renderId, createdAt: Date.now(), modelVersion: null, mean: null, sd: null, experiment: features.experiment, features });
  return features;
}

// ---- rewards & learner ---------------------------------------------------------------------------

export interface AnalyticsSettings {
  weights: RewardWeights;
  preset: string;
}

export const analyticsSettings = (): AnalyticsSettings => getKv('analytics_settings', { weights: DEFAULT_REWARD_WEIGHTS, preset: 'retention-first' });
export const setAnalyticsSettings = (s: AnalyticsSettings) => {
  setKv('analytics_settings', s);
  refitLearner();
};

function outcome(p: PostRow, features: PostFeatures | null): PostOutcome {
  const snaps = snapshotsFor(p.renderId, p.platform);
  const publishedAt = p.publishedAt ?? p.postedAt;
  const curve = retentionFor(p.renderId, p.platform);
  const rel = curve?.points.filter((x) => x.relative !== null).map((x) => x.relative!) ?? [];
  const lastDuration = [...snaps].reverse().find((s) => s.metrics.durationS)?.metrics.durationS;
  return {
    id: p.renderId,
    publishedAt,
    ageH: (Date.now() - publishedAt) / HOUR,
    durationS: lastDuration ?? features?.durationS ?? 30,
    snapshots: snaps.map((s) => ({ ageH: s.ageH, metrics: s.metrics })),
    relativeRetention: rel.length ? rel.reduce((a, b) => a + b, 0) / rel.length : null,
    manual: p.manual,
  };
}

/** Rewards for every YouTube post (recomputed from raw snapshots each time). */
export function rewards(): Map<string, PostReward> {
  const posts = allPosts('youtube');
  const { rewards } = computeRewards(
    posts.map((p) => outcome(p, featuresFor(p.renderId))),
    { weights: analyticsSettings().weights },
  );
  return new Map(rewards.map((r) => [r.id, r]));
}

const HORIZON_H = 168;
let cached: LearnerModel | null = null;

/** Refit the learner from all scored posts. Cheap (≤ a few hundred rows), so it runs after every refresh. */
export function refitLearner(): LearnerModel {
  const posts = allPosts('youtube');
  const scored = rewards();
  const rows = posts.flatMap((p) => {
    const r = scored.get(p.renderId);
    const f = featuresFor(p.renderId);
    if (!r || r.reward === null || !f) return [];
    return [{ input: featuresToInput(f, p.publishedAt ?? p.postedAt), reward: r.reward, weight: r.weight }];
  });
  const matured = posts.filter((p) => {
    const r = scored.get(p.renderId);
    return r && r.reward !== null && !r.provisional;
  }).length;
  const previous = getKv<{ version: number } | null>('learner', null);
  cached = fitLearner(rows, defaultCatalog(), { matured, version: (previous?.version ?? 0) + 1 });
  setKv('learner', cached);
  return cached;
}

export function currentModel(): LearnerModel {
  if (cached) return cached;
  const stored = getKv<LearnerModel | null>('learner', null);
  // Refit if missing, or if templates/themes/melodies or the model's inputs changed since it was fitted.
  const catalog = defaultCatalog();
  const fresh = stored && JSON.stringify(stored.catalog) === JSON.stringify(catalog) && JSON.stringify(stored.names) === JSON.stringify(featureSpace(catalog).map((f) => f.name));
  cached = fresh ? stored : refitLearner();
  return cached;
}

/** Arm model for planning: flat (even exploration) until enough posts have matured. */
export function planningModel(): ArmModel {
  const m = currentModel();
  return m.ready ? armModel(m) : flatArmModel;
}

/** Expected reward for a candidate, or null while the model isn't steering yet. */
export function predictInput(input: LearnerInput): Prediction | null {
  const m = currentModel();
  return m.ready ? predict(m, input) : null;
}

export const predictFeatures = (f: PostFeatures) => predictInput(featuresToInput(f));

/** Most recent post time per template, so the planner can boost neglected ones. */
export function lastPostedAt(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of allPosts()) {
    const t = predictionFor(p.renderId)?.features.arm.templateId ?? getRender(p.renderId)?.recipe.templateId;
    if (t) out[t] = Math.max(out[t] ?? 0, p.publishedAt ?? p.postedAt);
  }
  return out;
}

export function learningStatus() {
  const m = currentModel();
  const scored = rewards();
  const points = allPosts('youtube')
    .sort((a, b) => (a.publishedAt ?? a.postedAt) - (b.publishedAt ?? b.postedAt))
    .flatMap((p) => {
      const r = scored.get(p.renderId);
      const pred = predictionFor(p.renderId);
      if (!r || r.reward === null || r.provisional || pred?.mean === null || pred?.mean === undefined) return [];
      return [{ predicted: pred.mean, actual: r.reward, drama: pred.features.drama.total }];
    });
  return {
    ready: m.ready,
    readyAt: READY_AT,
    matured: m.matured,
    scored: m.n,
    modelVersion: m.version,
    fittedAt: m.fittedAt,
    noiseSd: Math.sqrt(m.bn / Math.max(1e-6, m.an - 1)),
    calibration: calibration(points),
    horizonDays: HORIZON_H / 24,
    settings: analyticsSettings(),
  };
}

export function postView(p: PostRow, scored?: Map<string, PostReward>) {
  const r = getRender(p.renderId);
  const c = r?.conceptId ? getConcept(r.conceptId)?.concept : undefined;
  const ex = exportForRender(p.renderId);
  const pred = predictionFor(p.renderId);
  const live = latestMetrics(p.renderId, p.platform);
  const publishedAt = p.publishedAt ?? p.postedAt;
  const curve = retentionFor(p.renderId, p.platform);
  return {
    renderId: p.renderId,
    batchId: r?.batchId ?? null,
    platform: p.platform,
    url: p.url,
    externalId: p.externalId ?? null,
    linkedBy: p.linkedBy ?? 'paste',
    publishedAt,
    ageH: (Date.now() - publishedAt) / HOUR,
    title: r?.copy?.title ?? '',
    hook: r?.copy?.hook ?? r?.recipe.copy?.hook ?? '',
    templateId: r?.recipe.templateId ?? pred?.features.arm.templateId ?? '',
    themeId: r?.recipe.themeId ?? '',
    arm: c?.arm ?? pred?.features.arm ?? null,
    durationS: r?.durationS ?? pred?.features.durationS ?? null,
    cover: r?.dir ? { kind: 'render' as const, path: join(r.dir, 'cover.jpg') } : ex ? { kind: 'export' as const, exportId: ex.id } : null,
    experiment: pred?.experiment ?? false,
    manual: p.manual ?? {},
    metrics: live.metrics,
    lastFetchedAt: live.fetchedAt,
    snapshots: live.count,
    retention: curve ? { fetchedAt: curve.fetchedAt, ageH: curve.ageH, points: curve.points.length } : null,
    reward: scored?.get(p.renderId) ?? null,
    predicted: pred?.mean !== null && pred?.mean !== undefined ? { mean: pred.mean, sd: pred.sd ?? 0 } : null,
  };
}

export type PostView = ReturnType<typeof postView>;

export function listPostViews(platform: Platform = 'youtube'): PostView[] {
  const scored = rewards();
  return allPosts(platform)
    .map((p) => postView(p, scored))
    .sort((a, b) => b.publishedAt - a.publishedAt);
}

export function postDetail(renderId: string, platform: Platform = 'youtube') {
  const p = allPosts(platform).find((x) => x.renderId === renderId);
  if (!p) return null;
  return { ...postView(p, rewards()), history: snapshotsFor(renderId, platform), curve: retentionFor(renderId, platform)?.points ?? [] };
}
