/**
 * Server-side learning loop against a throwaway database: posts + snapshots → rewards → fit →
 * readiness → predictions and planning with experiments.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { chooseArms, type Arm } from '@sim/planner';
import type { PostFeatures } from '@sim/analytics';

process.env.SIM_DATA_DIR = mkdtempSync(join(tmpdir(), 'sim-an-'));

let db: typeof import('./db');
let an: typeof import('./analytics');

const DAY = 86_400_000;
const HOOKS = ['question', 'challenge', 'pick-a-side', 'curiosity'] as const;

function features(arm: Arm): PostFeatures {
  return {
    version: 1,
    arm,
    melodyId: 'ode-to-joy',
    params: {},
    targetS: 30,
    durationS: 30,
    drama: { total: 0.6, parts: {} },
    copy: { hookChars: 40, hookQuestion: true, hookDigit: false, hookEmoji: false, ctaStyle: 'guess' },
    source: 'claude',
    experiment: false,
    rankScore: null,
  };
}

/** A posted video `ageDays` old whose quality (views and % viewed) depends on its hook. */
function addPost(i: number, ageDays: number, hook: (typeof HOOKS)[number]) {
  const arm: Arm = { templateId: Math.floor(i / 4) % 2 ? 'ring-escape' : 'marble-race', themeId: 'sunset', lengthBucket: 'medium', hookStyle: hook };
  const quality = hook === 'pick-a-side' ? 1 : 0;
  const r = db.insertRender({ batchId: null, conceptId: null, kind: 'batch', recipe: { templateId: arm.templateId, themeId: 'sunset', melodyId: 'ode-to-joy', seed: i, params: {} } as any, copy: null, score: 0.6, scoreParts: null, altSeeds: [], rankScore: 0.6 });
  const publishedAt = Date.now() - ageDays * DAY;
  db.insertPredictionOnce({ renderId: r.id, createdAt: publishedAt - DAY, modelVersion: null, mean: null, sd: null, experiment: false, features: features(arm) });
  db.upsertPost({ renderId: r.id, platform: 'youtube', url: `https://youtu.be/${String(i).padStart(11, 'x')}`, postedAt: publishedAt, externalId: String(i).padStart(11, 'x'), publishedAt, linkedBy: 'auto' });
  const wobble = ((i * 37) % 10) / 10 - 0.5;
  for (const d of [3, 8]) {
    if (d > ageDays) continue;
    const views = Math.round(1000 * (1 + quality + 0.3 * wobble) * (d / 7) ** 0.5);
    db.insertSnapshot({
      renderId: r.id,
      platform: 'youtube',
      fetchedAt: publishedAt + d * DAY,
      ageH: d * 24,
      source: 'youtube',
      metrics: { views, likes: views * 0.05, comments: 3, aViews: views, aLikes: views * 0.05, aComments: 3, shares: 2, averageViewPercentage: 75 + 15 * quality + 5 * wobble, subscribersGained: 2, subscribersLost: 0, durationS: 30 },
    });
  }
  return r.id;
}

beforeAll(async () => {
  db = await import('./db');
  an = await import('./analytics');
});

describe('learning loop', () => {
  it('stays flat until enough posts mature', () => {
    for (let i = 0; i < 5; i++) addPost(i, 10, HOOKS[i % 4]);
    addPost(99, 1, 'question'); // too young to score
    const m = an.refitLearner();
    expect(m.ready).toBe(false);
    expect(m.matured).toBe(5);
    expect(an.predictInput({ arm: { templateId: 'ring-escape', themeId: 'sunset', lengthBucket: 'medium', hookStyle: 'question' } })).toBeNull();
    const views = an.listPostViews();
    expect(views.find((v) => v.ageH < 48)!.reward!.reward).toBeNull();
    expect(views.filter((v) => v.reward?.reward !== null)).toHaveLength(5);
  });

  it('starts steering at 8 matured posts and learns the better hook', () => {
    for (let i = 5; i < 24; i++) addPost(i, 9 + (i % 5), HOOKS[i % 4]);
    const m = an.refitLearner();
    expect(m.ready).toBe(true);
    const base = { templateId: 'ring-escape', themeId: 'sunset', lengthBucket: 'medium' as const };
    const good = an.predictInput({ arm: { ...base, hookStyle: 'pick-a-side' } })!;
    const meh = an.predictInput({ arm: { ...base, hookStyle: 'challenge' } })!;
    expect(good.mean).toBeGreaterThan(meh.mean + 0.3);

    const chosen = chooseArms({ count: 9, templateIds: [], themeIds: [], minLengthS: 20, maxLengthS: 45, lastPostedAt: an.lastPostedAt() }, an.planningModel(), new Rng(1));
    expect(chosen.filter((c) => c.experiment)).toHaveLength(2);
    const exploit = chosen.filter((c) => !c.experiment);
    expect(exploit.filter((c) => c.arm.hookStyle === 'pick-a-side').length).toBeGreaterThanOrEqual(4);
  });

  it('re-scores history when the reward weights change', () => {
    const before = an.listPostViews().find((v) => v.reward?.reward !== null)!.reward!.reward!;
    an.setAnalyticsSettings({ preset: 'custom', weights: { retention: 0, reach: 1, engagement: 0, followers: 0 } });
    const after = an.listPostViews().find((v) => v.renderId)!.reward!;
    expect(after.reward).not.toBe(before);
    an.setAnalyticsSettings({ preset: 'retention-first', weights: { retention: 0.45, reach: 0.3, engagement: 0.15, followers: 0.1 } });
  });

  it('reports learning status', () => {
    const s = an.learningStatus();
    expect(s).toMatchObject({ ready: true, readyAt: 8 });
    expect(s.matured).toBeGreaterThanOrEqual(20);
  });
});
