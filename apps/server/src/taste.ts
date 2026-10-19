/**
 * The taste model: learns from Review decisions (and Playground work) which templates, themes,
 * copy and — above all — which template *settings* the owner likes, long before YouTube numbers
 * exist. Same Bayesian regression as the YouTube learner, with per-template setting features, so
 * a template whose batch settings were rejected isn't blamed for them: its hand-tuned settings
 * can still carry it.
 */
import { Rng, parseParams } from '@sim/engine';
import { findTemplate, getTemplate } from '@sim/templates';
import type { Arm, ArmModel } from '@sim/planner';
import {
  COPY_ONLY_REASONS,
  NOT_TASTE_REASONS,
  REJECT_REASONS,
  copyFeatures,
  effects,
  fitLearner,
  predict,
  sampleWeights,
  scoreSettings,
  tasteArmModel,
  tasteCatalog,
  type LearnerInput,
  type LearnerModel,
  type ParamSpec,
  type Prediction,
  type TrainingRow,
} from '@sim/analytics';
import { getBatch, getConcept, getRender, reviewableRenders, tasteFingerprint, type RenderRow } from './db';

/** Labelled examples needed before the taste model steers planning and ranking. */
export const TASTE_READY_AT = 20;
const DAY = 86_400_000;

export type Label = 'approved' | 'exported' | 'rejected' | 'rerolled' | 'skipped' | 'manual';

/** Label weight: explicit decisions count fully, implicit ones less. */
const WEIGHT: Record<Label, number> = { approved: 1, exported: 1, manual: 0.6, rejected: 1, rerolled: 0.5, skipped: 0.35 };

interface Example {
  render: RenderRow;
  label: Label;
  liked: boolean;
  weight: number;
  input: LearnerInput;
}

const bucketFor = (s: number) => (s < 25 ? 'short' : s < 40 ? 'medium' : 'long') as Arm['lengthBucket'];

/** A copy or melody reroll (same simulation and settings) says nothing about the settings. */
function copyOnlyReroll(r: RenderRow): boolean {
  const next = r.supersededBy ? getRender(r.supersededBy) : undefined;
  return Boolean(next && next.recipe.seed === r.recipe.seed && JSON.stringify(next.recipe.params) === JSON.stringify(r.recipe.params));
}

/** Batches the owner has looked at: anything left undecided there was passed over. */
function reviewedBatches(rows: RenderRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (r.batchId && r.kind === 'batch' && (r.decision === 'approved' || r.decision === 'rejected' || r.decision === 'rerolled')) out.add(r.batchId);
  return out;
}

function labelFor(r: RenderRow, reviewed: Set<string>, now: number): Label | null {
  if (r.kind === 'export') return 'exported'; // tuned by hand in the Playground and exported
  if (r.decision === 'approved') return 'approved';
  if (r.decision === 'rejected') return r.reasons.length && r.reasons.every((x) => NOT_TASTE_REASONS.has(x)) ? null : 'rejected';
  if (r.decision === 'rerolled') return copyOnlyReroll(r) ? null : 'rerolled';
  if (r.kind === 'manual') return 'manual';
  // Passed over: only once the batch has been reviewed and has had a day to be looked at.
  const b = r.batchId ? getBatch(r.batchId) : undefined;
  if (r.batchId && reviewed.has(r.batchId) && b?.finishedAt && now - b.finishedAt > DAY) return 'skipped';
  return null;
}

/** What the model sees about one render (stored score/length; nothing is re-simulated). */
export function tasteInput(r: RenderRow): LearnerInput | null {
  const template = findTemplate(r.recipe.templateId);
  // Long-form ambient videos don't teach anything about Shorts.
  if (!template || template.longForm) return null;
  const concept = r.conceptId ? getConcept(r.conceptId)?.concept : undefined;
  const durationS = r.durationS ?? r.recipe.targetS ?? 30;
  return {
    arm: concept?.arm ?? { templateId: r.recipe.templateId, themeId: r.recipe.themeId, lengthBucket: bucketFor(durationS), hookStyle: 'question' },
    melodyId: r.recipe.melodyId,
    durationS,
    drama: r.score ?? undefined,
    copy: r.copy ? copyFeatures({ hook: r.copy.hook, cta: r.copy.cta, title: r.copy.title, nudge: r.recipe.copy?.nudge }) : undefined,
    params: parseParams(template, r.recipe.params ?? {}) as Record<string, unknown>,
    // Playground videos have no planned hook style: don't let them all credit "question".
    hookKnown: Boolean(concept),
  };
}

export function examples(now = Date.now()): Example[] {
  const rows = reviewableRenders();
  const reviewed = reviewedBatches(rows);
  return rows.flatMap((r) => {
    const label = labelFor(r, reviewed, now);
    const input = label && tasteInput(r);
    if (!label || !input) return [];
    const liked = label === 'approved' || label === 'exported' || label === 'manual';
    // Rejected only for the copy: barely about the simulation.
    const copyOnly = label === 'rejected' && r.reasons.length > 0 && r.reasons.every((x) => COPY_ONLY_REASONS.has(x));
    return [{ render: r, label, liked, weight: WEIGHT[label] * (copyOnly ? 0.3 : 1), input }];
  });
}

let cached: { key: string; model: LearnerModel } | null = null;

/** Fitted on demand and refitted whenever a decision changes (or an hour passes: skips age in). */
export function tasteModel(): LearnerModel {
  const key = `${tasteFingerprint()}|${Math.floor(Date.now() / 3_600_000)}`;
  if (cached?.key === key) return cached.model;
  const ex = examples();
  const rows: TrainingRow[] = ex.map((e) => ({ input: e.input, reward: e.liked ? 1 : -1, weight: e.weight }));
  const liked = ex.filter((e) => e.liked).length;
  const m = fitLearner(rows, tasteCatalog(), { matured: rows.length });
  cached = { key, model: { ...m, ready: rows.length >= TASTE_READY_AT && liked >= 5 } };
  return cached.model;
}

/** Approval chance-ish score (0..1) for a candidate, or null until the model is ready. */
export function tastePredict(input: LearnerInput): (Prediction & { chance: number }) | null {
  const m = tasteModel();
  if (!m.ready) return null;
  const p = predict(m, input);
  return { ...p, chance: Math.max(0, Math.min(1, (p.mean + 1) / 2)) };
}

// ---- choosing settings ---------------------------------------------------------------------------

const specsFor = (m: LearnerModel, templateId: string) => (m.catalog.params ?? []).filter((s) => s.templateId === templateId);

function gaussian(rng: Rng): number {
  return Math.sqrt(-2 * Math.log(rng.next() || 1e-12)) * Math.cos(2 * Math.PI * rng.next());
}

/** Explicit options only: a "random" setting hides what was actually shown, so nothing is learned from it. */
const explicit = (spec: ParamSpec) => {
  const vals = (spec.values ?? []).filter((v) => v !== 'random');
  return vals.length ? vals : (spec.values ?? []);
};

const asValue = (spec: ParamSpec, v: string) => (v === 'true' ? true : v === 'false' ? false : v);

/** A nearby setting: numbers move by `spread` of their range, choices switch with probability `spread`. */
function jitter(base: Record<string, unknown>, specs: ParamSpec[], spread: number, rng: Rng): Record<string, unknown> {
  const out = { ...base };
  for (const spec of specs) {
    const cur = out[spec.param];
    if (spec.kind === 'number') {
      const range = spec.max! - spec.min!;
      let v = Number(cur ?? spec.default) + gaussian(rng) * spread * range;
      v = Math.max(spec.min!, Math.min(spec.max!, v));
      out[spec.param] = Number.isInteger(spec.default) && Number.isInteger(spec.min) ? Math.round(v) : Math.round(v * 1000) / 1000;
    } else {
      const options = explicit(spec);
      if (String(cur) === 'random' || rng.chance(spread)) out[spec.param] = asValue(spec, rng.pick(options));
    }
  }
  return out;
}

/** Settings of everything liked for a template (approved, exported, hand-made). */
function likedSettings(templateId: string): Record<string, unknown>[] {
  return examples()
    .filter((e) => e.liked && e.input.arm.templateId === templateId)
    .map((e) => e.input.params!);
}

/** Candidate settings for a template: its defaults, liked settings and their neighbours, and some exploration. */
function candidates(templateId: string, fixed: Record<string, unknown>, lengthValue: number | null, rng: Rng, m: LearnerModel) {
  const template = getTemplate(templateId);
  const specs = specsFor(m, templateId);
  const defaults = parseParams(template, {}) as Record<string, unknown>;
  const pin = (p: Record<string, unknown>) => {
    const out = { ...p, ...fixed };
    if (lengthValue !== null && template.lengthParam) out[template.lengthParam.param] = lengthValue;
    return parseParams(template, out) as Record<string, unknown>;
  };
  const list: { params: Record<string, unknown>; source: string }[] = [];
  list.push({ params: pin(jitter(defaults, specs, 0, rng)), source: 'template defaults' });
  for (const liked of likedSettings(templateId)) {
    list.push({ params: pin(liked), source: 'a video you approved' });
    for (let k = 0; k < 3; k++) list.push({ params: pin(jitter(liked, specs, 0.06, rng)), source: 'near a video you approved' });
  }
  for (let k = 0; k < 12; k++) list.push({ params: pin(jitter(defaults, specs, 0.1, rng)), source: 'near the defaults' });
  for (let k = 0; k < 6; k++) list.push({ params: pin(jitter(defaults, specs, 0.3, rng)), source: 'exploring' });
  return list;
}

/** Length setting that lands the video on its target (templates that have one). */
function lengthFor(templateId: string, targetS: number): number | null {
  const t = getTemplate(templateId);
  if (!t.lengthParam) return null;
  return Math.max(1, targetS - t.lengthParam.offsetS);
}

/** Share of videos whose settings explore (a posterior draw among near-known candidates) rather than play safe. */
const EXPLORE_SHARE = 0.2;
/** How much uncertainty costs when playing safe (expected fit minus this many sds). */
const CAUTION = 1;

/**
 * Pick the settings for a planned video. Mostly cautious: the candidate with the best expected fit
 * after subtracting its uncertainty, so untested extremes never win just by being uncertain (that
 * made "exploring" picks sound off). A fifth of the time it explores with a posterior draw, but
 * only among settings near the defaults or near liked videos. Before the model is ready it stays
 * close to the template's tuned defaults.
 */
export function chooseParams(arm: Arm, targetS: number, fixed: Record<string, unknown>, rng: Rng): { params: Record<string, unknown>; source: string } {
  const m = tasteModel();
  const list = candidates(arm.templateId, fixed, lengthFor(arm.templateId, targetS), rng, m);
  if (!m.ready) return rng.chance(0.5) ? list[0] : rng.pick(list.filter((c) => c.source === 'near the defaults'));
  const pickBest = (pool: typeof list, score: (c: (typeof list)[number], i: number) => number) => {
    let best = 0;
    pool.forEach((c, i) => score(c, i) > score(pool[best], best) && (best = i));
    return pool[best];
  };
  if (rng.chance(EXPLORE_SHARE)) {
    const pool = list.filter((c) => c.source !== 'exploring');
    const scores = scoreSettings(m, arm, pool.map((c) => c.params), sampleWeights(m, rng, 0.5));
    const pick = pickBest(pool, (_, i) => scores[i]);
    return { ...pick, source: `${pick.source} (exploring)` };
  }
  const preds = list.map((c) => predict(m, { arm, params: c.params }));
  return pickBest(list, (_, i) => preds[i].mean - CAUTION * preds[i].sd);
}

/** Arm model for planning from taste: each template judged by its best candidate settings. */
export function tasteArmPlanningModel(): ArmModel | null {
  const m = tasteModel();
  if (!m.ready) return null;
  const rng = new Rng(m.n * 7919 + 13);
  const byTemplate: Record<string, Record<string, unknown>[]> = {};
  for (const t of m.catalog.templates) {
    if (!findTemplate(t.id)) continue;
    byTemplate[t.id] = candidates(t.id, {}, null, rng, m).map((c) => c.params);
  }
  return tasteArmModel(m, byTemplate);
}

// ---- what the Analytics tab shows ---------------------------------------------------------------

const describeValue = (spec: ParamSpec, v: unknown) => (spec.kind === 'number' ? String(Math.round(Number(v) * 100) / 100) : String(v));

export function tasteStatus() {
  const m = tasteModel();
  const ex = examples();
  const all = reviewableRenders().filter((r) => r.kind === 'batch');
  const templates = m.catalog.templates
    .filter((t) => findTemplate(t.id))
    .map((t) => {
      const mine = ex.filter((e) => e.input.arm.templateId === t.id);
      const reasons: Record<string, number> = {};
      for (const r of all) if (r.recipe.templateId === t.id && r.decision === 'rejected') for (const x of r.reasons) reasons[x] = (reasons[x] ?? 0) + 1;
      return {
        id: t.id,
        name: t.name,
        liked: mine.filter((e) => e.liked).length,
        rejected: mine.filter((e) => e.label === 'rejected' || e.label === 'rerolled').length,
        skipped: mine.filter((e) => e.label === 'skipped').length,
        reasons,
        settings: settingInsights(m, t.id),
      };
    })
    .sort((a, b) => b.liked + b.rejected + b.skipped - (a.liked + a.rejected + a.skipped));
  return {
    ready: m.ready,
    readyAt: TASTE_READY_AT,
    examples: ex.length,
    liked: ex.filter((e) => e.liked).length,
    reasons: REJECT_REASONS,
    templates,
  };
}

/**
 * Plain-language setting effects for one template, strongest first: what the model has learned
 * about settings it has actually seen vary. `sure` marks effects well clear of their uncertainty;
 * the rest are leanings (the direction it's heading with little data).
 */
function settingInsights(m: LearnerModel, templateId: string): { text: string; direction: 'up' | 'down'; strength: number; sure: boolean }[] {
  const specs = specsFor(m, templateId);
  const eff = new Map(effects(m).map((e) => [e.name, e]));
  const out: { text: string; direction: 'up' | 'down'; strength: number; sure: boolean }[] = [];
  const push = (text: string, direction: 'up' | 'down', mean: number, sd: number) => {
    const strength = Math.abs(mean) / sd;
    if (strength >= 0.3 && Math.abs(mean) >= 0.03) out.push({ text, direction, strength, sure: strength >= 0.8 });
  };
  for (const spec of specs) {
    const base = `param:${templateId}.${spec.param}`;
    if (spec.kind === 'number') {
      const lin = eff.get(base);
      const quad = eff.get(`${base}^2`);
      if (lin && lin.n >= 3) push(`${lin.mean > 0 ? 'Higher' : 'Lower'} ${spec.title.toLowerCase()} (default ${describeValue(spec, spec.default)})`, 'up', lin.mean, lin.sd);
      if (quad && quad.n >= 3 && quad.mean < 0) push(`Extreme ${spec.title.toLowerCase()} values`, 'down', quad.mean, quad.sd);
    } else {
      for (const v of spec.values ?? []) {
        const e = eff.get(`${base}=${v}`);
        if (e && e.n >= 2) push(`${spec.title}: ${v}`, e.mean > 0 ? 'up' : 'down', e.mean, e.sd);
      }
    }
  }
  return out.sort((a, b) => b.strength - a.strength).slice(0, 5);
}
