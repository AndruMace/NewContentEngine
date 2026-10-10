import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { chooseArms, flatArmModel, type Arm } from '@sim/planner';
import { defaultCatalog } from './catalog';
import { armModel, calibration, effects, fitLearner, predict, type TrainingRow } from './learner';
import { computeRewards, type PostOutcome } from './reward';
import { robustZ } from './stats';

const DAY_H = 24;
const H = 3_600_000;

/** A post with snapshots at 1, 3, 5 and 8 days. */
function post(id: string, i: number, opts: { views7d: number; apv: number; durationS?: number; likes?: number; subs?: number; ageH?: number }): PostOutcome {
  const ages = [1, 3, 5, 8].map((d) => d * DAY_H).filter((a) => a <= (opts.ageH ?? 200));
  return {
    id,
    publishedAt: Date.UTC(2026, 0, 1) + i * 86_400_000,
    ageH: opts.ageH ?? 200,
    durationS: opts.durationS ?? 30,
    snapshots: ages.map((a) => {
      const views = Math.round(opts.views7d * Math.pow(a / 168, 0.55));
      const analytics = a >= 72 ? { aViews: views, averageViewPercentage: opts.apv, aLikes: (opts.likes ?? 0.04) * views, aComments: 0.005 * views, shares: 0.002 * views, subscribersGained: ((opts.subs ?? 1) * views) / 1000, subscribersLost: 0 } : {};
      return { ageH: a, metrics: { views, likes: Math.round((opts.likes ?? 0.04) * views), comments: 1, ...analytics } as Record<string, number> };
    }),
  };
}

describe('reward', () => {
  const base = Array.from({ length: 12 }, (_, i) => post(`p${i}`, i, { views7d: 1000 + (i % 3) * 100, apv: 80 + (i % 4) }));

  it('rises with each component', () => {
    const variants = {
      views: post('x', 20, { views7d: 5000, apv: 81 }),
      apv: post('x', 20, { views7d: 1100, apv: 110 }),
      likes: post('x', 20, { views7d: 1100, apv: 81, likes: 0.12 }),
      subs: post('x', 20, { views7d: 1100, apv: 81, subs: 8 }),
    };
    const plain = computeRewards([...base, post('x', 20, { views7d: 1100, apv: 81 })]).rewards.at(-1)!.reward!;
    for (const [k, p] of Object.entries(variants)) {
      const r = computeRewards([...base, p]).rewards.at(-1)!.reward!;
      expect(r, k).toBeGreaterThan(plain);
    }
  });

  it('weights retention above reach above followers by default', () => {
    const r = computeRewards([...base, post('x', 20, { views7d: 1100, apv: 81 })]).rewards.at(-1)!;
    expect(Object.keys(r.components).sort()).toEqual(['engagement', 'followers', 'reach', 'retention']);
  });

  it('removes channel growth from reach', () => {
    // Views double every 10 posts (with ±30% noise); later posts must not look better just for being later.
    const rng = new Rng(8);
    const growing = Array.from({ length: 60 }, (_, i) => post(`g${i}`, i, { views7d: 1000 * 2 ** (i / 10) * Math.exp(0.3 * gauss(rng)), apv: 80 }));
    const reach = computeRewards(growing).rewards.map((r) => r.components.reach!);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(mean(reach.slice(40)) - mean(reach.slice(10, 30)))).toBeLessThan(0.4);
    // Without the baseline, the last posts would be ~4× the views of the early ones.
    expect(Math.log(computeRewards(growing).rewards[55].raw.viewsAtHorizon! / computeRewards(growing).rewards[15].raw.viewsAtHorizon!)).toBeGreaterThan(1.5);
  });

  it("doesn't let a viral outlier swamp everyone else", () => {
    const posts = [...base, post('viral', 30, { views7d: 100_000_000, apv: 81 })];
    const rewards = computeRewards(posts).rewards;
    expect(rewards.at(-1)!.components.reach).toBe(3);
    const others = rewards.slice(0, -1).map((r) => r.components.reach!);
    expect(Math.max(...others.map(Math.abs))).toBeLessThan(2);
  });

  it('adjusts retention for length', () => {
    // Longer videos naturally have lower % viewed; a 55 s video at 62% is as good as a 20 s one at 92%.
    const mixed = Array.from({ length: 20 }, (_, i) => {
      const d = i % 2 ? 55 : 20;
      return post(`m${i}`, i, { views7d: 1000, apv: d === 55 ? 62 : 92, durationS: d });
    });
    const ret = computeRewards(mixed).rewards.map((r) => r.components.retention!);
    expect(Math.max(...ret.map(Math.abs))).toBeLessThan(0.5);
  });

  it('scores young posts provisionally and skips the youngest', () => {
    const posts = [...base, post('young', 20, { views7d: 1000, apv: 80, ageH: 100 }), post('baby', 21, { views7d: 1000, apv: 80, ageH: 30 })];
    const rs = computeRewards(posts).rewards;
    const young = rs.find((r) => r.id === 'young')!;
    expect(young.provisional).toBe(true);
    expect(young.weight).toBeGreaterThan(0.4);
    expect(young.weight).toBeLessThan(1);
    // Views at 4 days are extrapolated to 7 days.
    expect(young.raw.viewsAtHorizon).toBeGreaterThan(900);
    expect(rs.find((r) => r.id === 'baby')!.reward).toBeNull();
  });

  it('robustZ shrinks toward the prior with little data', () => {
    expect(robustZ([0, 10], 1)).toEqual([0, 3]);
    // Identical-ish values don't explode into ±3.
    expect(Math.max(...robustZ([1, 1, 1, 1, 1.01], 1).map(Math.abs))).toBeLessThan(0.1);
  });
});

// ---- learner on synthetic data -----------------------------------------------------------------

const catalog = defaultCatalog();
const TRUTH = {
  hook: { 'pick-a-side': 0.5, question: 0, challenge: -0.2, curiosity: 0 } as Record<string, number>,
  length: { short: 0.1, medium: 0, long: -0.3 } as Record<string, number>,
  template: { 'ring-escape': 0.4, 'sand-pour': -0.4 } as Record<string, number>,
};
const trueValue = (a: Arm) => (TRUTH.hook[a.hookStyle] ?? 0) + (TRUTH.length[a.lengthBucket] ?? 0) + (TRUTH.template[a.templateId] ?? 0);

function randomArm(rng: Rng): Arm {
  return {
    templateId: rng.pick(catalog.templates).id,
    themeId: rng.pick(catalog.themes),
    lengthBucket: rng.pick(catalog.lengthBuckets).id as Arm['lengthBucket'],
    hookStyle: rng.pick(catalog.hookStyles) as Arm['hookStyle'],
  };
}

const gauss = (rng: Rng) => Math.sqrt(-2 * Math.log(rng.next() || 1e-12)) * Math.cos(2 * Math.PI * rng.next());

describe('learner', () => {
  it('recovers known effects from ~60 noisy posts', () => {
    const rng = new Rng(42);
    const rows: TrainingRow[] = Array.from({ length: 60 }, () => {
      const arm = randomArm(rng);
      return { input: { arm }, reward: trueValue(arm) + 0.8 * gauss(rng), weight: 1 };
    });
    const m = fitLearner(rows, catalog, { matured: 60 });
    const e = new Map(effects(m).map((x) => [x.name, x]));
    const diff = (a: string, b: string) => e.get(a)!.mean - e.get(b)!.mean;
    expect(diff('hook:pick-a-side', 'hook:challenge')).toBeGreaterThan(0.2);
    expect(diff('template:ring-escape', 'template:sand-pour')).toBeGreaterThan(0.2);
    // Intervals are honest: every effect sd is positive and the noise estimate is near 0.8².
    expect([...e.values()].every((x) => x.sd > 0)).toBe(true);
    expect(m.bn / (m.an - 1)).toBeGreaterThan(0.3);
    expect(m.bn / (m.an - 1)).toBeLessThan(1.2);
    // Predictions order arms like the truth does.
    const best = predict(m, { arm: { templateId: 'ring-escape', themeId: 'sunset', lengthBucket: 'short', hookStyle: 'pick-a-side' } });
    const worst = predict(m, { arm: { templateId: 'sand-pour', themeId: 'sunset', lengthBucket: 'long', hookStyle: 'challenge' } });
    expect(best.mean).toBeGreaterThan(worst.mean);
  });

  it('treats unknown details as average and uses known ones', () => {
    const rng = new Rng(7);
    const rows: TrainingRow[] = Array.from({ length: 50 }, () => {
      const arm = randomArm(rng);
      const drama = rng.range(0.3, 0.9);
      return { input: { arm, drama }, reward: 3 * (drama - 0.6) + 0.3 * gauss(rng), weight: 1 };
    });
    const m = fitLearner(rows, catalog, { matured: 50 });
    const arm = randomArm(rng);
    const hi = predict(m, { arm, drama: 0.85 }).mean;
    const avg = predict(m, { arm }).mean;
    const lo = predict(m, { arm, drama: 0.35 }).mean;
    expect(hi).toBeGreaterThan(avg);
    expect(avg).toBeGreaterThan(lo);
  });

  it('learns planner-split variants for their own template only', () => {
    expect(catalog.variants).toContain('ball-battle.teams=countries');
    const rng = new Rng(11);
    const rows: TrainingRow[] = Array.from({ length: 80 }, (_, i) => {
      const arm = { ...randomArm(rng), templateId: i % 2 ? 'ball-battle' : 'ring-escape' };
      const teams = rng.chance(0.5) ? 'countries' : 'colors';
      const bonus = arm.templateId === 'ball-battle' && teams === 'countries' ? 0.8 : 0;
      return { input: { arm, params: arm.templateId === 'ball-battle' ? { teams } : { gravity: 1 } }, reward: bonus + 0.8 * gauss(rng), weight: 1 };
    });
    const m = fitLearner(rows, catalog, { matured: 80 });
    expect(effects(m).find((e) => e.name === 'variant:ball-battle.teams=countries')!.mean).toBeGreaterThan(0.25);
    const arm = { templateId: 'ball-battle', themeId: 'sunset', lengthBucket: 'medium' as const, hookStyle: 'question' as const };
    const countries = predict(m, { arm, params: { teams: 'countries' } }).mean;
    const colors = predict(m, { arm, params: { teams: 'colors' } }).mean;
    const unknown = predict(m, { arm }).mean;
    expect(countries).toBeGreaterThan(colors + 0.25);
    expect(unknown).toBeGreaterThan(colors);
    expect(unknown).toBeLessThan(countries);
    // Other templates' params never touch the variant.
    const ring = { ...arm, templateId: 'ring-escape' };
    expect(predict(m, { arm: ring, params: { teams: 'countries' } }).mean).toBeCloseTo(predict(m, { arm: ring }).mean, 6);
  });

  it('chooses experiments and is reproducible with a fixed seed', () => {
    const rng = new Rng(3);
    const rows: TrainingRow[] = Array.from({ length: 20 }, () => {
      const arm = randomArm(rng);
      return { input: { arm }, reward: trueValue(arm) + gauss(rng), weight: 1 };
    });
    const am = armModel(fitLearner(rows, catalog, { matured: 20 }));
    const settings = { count: 9, templateIds: [], themeIds: [], minLengthS: 15, maxLengthS: 60 };
    const a = chooseArms(settings, am, new Rng(9));
    const b = chooseArms(settings, am, new Rng(9));
    expect(a).toEqual(b);
    expect(a.filter((c) => c.experiment).length).toBe(2);
    expect(a.find((c) => c.experiment)!.experiment!.reason).toMatch(/^Testing /);
  });

  it('beats uniform and per-arm Beta baselines over 90 simulated days', () => {
    const days = 90;
    const perDay = 3;
    const noise = 1;
    const settings = { count: perDay, templateIds: [], themeIds: [], minLengthS: 15, maxLengthS: 60 };
    const run = (policy: 'learner' | 'uniform' | 'beta', seed: number) => {
      const rng = new Rng(seed);
      const rows: TrainingRow[] = [];
      const beta = new Map<string, { a: number; b: number }>();
      let late = 0;
      for (let day = 0; day < days; day++) {
        let arms: Arm[];
        if (policy === 'learner') {
          const model = rows.length >= 8 ? armModel(fitLearner(rows, catalog, { matured: rows.length })) : flatArmModel;
          arms = chooseArms(settings, model, rng).map((c) => c.arm);
        } else if (policy === 'beta') {
          // The Phase 4 approach: an independent Beta per arm, success = above-zero reward.
          const betaModel = {
            ...flatArmModel,
            sample: (r: Rng) => (arm: Arm) => {
              const s = beta.get(JSON.stringify(arm)) ?? { a: 1, b: 1 };
              // Mean plus noise is enough to show the problem: almost every arm is unseen.
              return s.a / (s.a + s.b) + 0.3 * r.next();
            },
          };
          arms = chooseArms(settings, betaModel, rng).map((c) => c.arm);
        } else arms = Array.from({ length: perDay }, () => randomArm(rng));
        for (const arm of arms) {
          const v = trueValue(arm);
          const reward = v + noise * gauss(rng);
          rows.push({ input: { arm }, reward, weight: 1 });
          const k = JSON.stringify(arm);
          const s = beta.get(k) ?? { a: 1, b: 1 };
          beta.set(k, reward > 0 ? { a: s.a + 1, b: s.b } : { a: s.a, b: s.b + 1 });
          if (day >= days - 30) late += v;
        }
      }
      return late / (30 * perDay);
    };
    // Eight seeds: single runs swing by ±0.1, so fewer made this a test of luck (adding unrelated
    // features to the model shifts the random stream).
    const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
    const avg = (p: 'learner' | 'uniform' | 'beta') => SEEDS.map((s) => run(p, s)).reduce((a, b) => a + b, 0) / SEEDS.length;
    const learner = avg('learner');
    const uniform = avg('uniform');
    const beta = avg('beta');
    // Best achievable with three different templates a day is ≈0.73.
    expect(learner).toBeGreaterThan(0.6);
    expect(learner).toBeGreaterThan(uniform + 0.4);
    expect(learner).toBeGreaterThan(beta);
  }, 180_000);

  it('calibration rewards a model that ranks well', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ predicted: i, actual: i + (i % 3), drama: 20 - i }));
    const c = calibration(pts);
    expect(c.model).toBeGreaterThan(0.8);
    expect(c.dramaBaseline).toBeLessThan(0);
  });
});
