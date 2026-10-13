/**
 * The learner: Bayesian linear regression of reward on video features (Normal–Inverse-Gamma,
 * closed form). Factors are separate features with their own shrinkage, so every post teaches
 * about every arm that shares a template, theme, length or hook style — with 1–3 posts a day the
 * 576 template×theme×length×hook combinations could never be learned one by one.
 */
import type { Arm, ArmModel } from '@sim/planner';
import type { CopyFeatures, CtaStyle } from './features';
import { spearman } from './stats';

export interface Catalog {
  templates: { id: string; name: string }[];
  themes: string[];
  hookStyles: string[];
  lengthBuckets: { id: string; midS: number }[];
  melodies: string[];
  /** Planner-split param values, as "templateId.param=value" (each non-default value is one feature). */
  variants?: string[];
  /**
   * Template settings to learn from (the taste model): each numeric param gets a linear and a
   * squared term (so "extreme values sound off" can be learned), each choice param one feature per
   * option. Effects are per template, so bad settings take the blame instead of the template.
   */
  params?: ParamSpec[];
}

export interface ParamSpec {
  templateId: string;
  param: string;
  title: string;
  kind: 'number' | 'enum';
  default: number | string;
  min?: number;
  max?: number;
  /** Options for choice params (booleans as "true"/"false"). */
  values?: string[];
}

/** Numeric settings in "quarter ranges" from the default: ±1 is a quarter of the slider away. */
export const paramScale = (spec: ParamSpec, v: number) => ((v - (spec.default as number)) / Math.max(1e-9, spec.max! - spec.min!)) * 4;

/** What the model knows about one video. Unknowns (e.g. at planning time) count as "average". */
export interface LearnerInput {
  arm: Arm;
  melodyId?: string;
  durationS?: number;
  drama?: number;
  copy?: CopyFeatures;
  /** Template params, for the planner-split variants (e.g. Ball Battle country vs colour teams). */
  params?: Record<string, unknown>;
  /** Local posting time; unknown when planning. */
  publishedAt?: number;
  /** False when the hook style wasn't planned (Playground videos), so they don't credit any style. */
  hookKnown?: boolean;
}

export interface TrainingRow {
  input: LearnerInput;
  reward: number;
  /** Maturity weight (0..1]. */
  weight: number;
}

interface Feature {
  name: string;
  group: FeatureGroup;
  /** Prior standard deviation (reward is in z units, so 0.3 = "a third of a typical post-to-post swing"). */
  priorSd: number;
  /** Arm features are always known; the rest are centred so "unknown" means "average". */
  centred: boolean;
}

export type FeatureGroup =
  | 'intercept'
  | 'template'
  | 'theme'
  | 'hook'
  | 'length'
  | 'templateLength'
  | 'duration'
  | 'melody'
  | 'drama'
  | 'copy'
  | 'cta'
  | 'time'
  | 'variant'
  | 'param';

const CTA_STYLES: CtaStyle[] = ['guess', 'pick', 'rate', 'opinion', 'other'];
export const HOUR_SLOTS = ['night', 'morning', 'afternoon', 'evening'] as const;
const hourSlot = (ms: number) => HOUR_SLOTS[Math.floor(new Date(ms).getHours() / 6)];

export function featureSpace(c: Catalog): Feature[] {
  const f: Feature[] = [{ name: 'intercept', group: 'intercept', priorSd: 1, centred: false }];
  const add = (group: FeatureGroup, names: string[], priorSd: number, centred: boolean) => names.forEach((name) => f.push({ name, group, priorSd, centred }));
  add('template', c.templates.map((t) => `template:${t.id}`), 0.5, false);
  add('theme', c.themes.map((t) => `theme:${t}`), 0.3, false);
  add('hook', c.hookStyles.map((h) => `hook:${h}`), 0.3, false);
  add('length', c.lengthBuckets.map((b) => `length:${b.id}`), 0.3, false);
  add('templateLength', c.templates.flatMap((t) => c.lengthBuckets.map((b) => `templateLength:${t.id}|${b.id}`)), 0.2, false);
  add('duration', ['duration:log', 'duration:log2'], 0.3, true);
  add('melody', c.melodies.map((m) => `melody:${m}`), 0.15, true);
  add('drama', ['drama'], 0.3, true);
  add('copy', ['copy:hookChars', 'copy:question', 'copy:digit', 'copy:emoji', 'copy:titleEmoji', 'copy:cues'], 0.2, true);
  add('cta', CTA_STYLES.map((s) => `cta:${s}`), 0.2, true);
  add('time', [...HOUR_SLOTS.map((s) => `time:${s}`), 'time:weekend'], 0.2, true);
  add('variant', (c.variants ?? []).map((v) => `variant:${v}`), 0.3, true);
  for (const spec of c.params ?? []) {
    const base = `param:${spec.templateId}.${spec.param}`;
    if (spec.kind === 'number') add('param', [base, `${base}^2`], 0.25, true);
    else add('param', (spec.values ?? []).map((v) => `${base}=${v}`), 0.3, true);
  }
  return f;
}

/** Raw (uncentred) feature values; centred features that are unknown are left out (→ average). */
function rawValues(x: LearnerInput, c: Catalog): Map<string, number> {
  const v = new Map<string, number>([['intercept', 1]]);
  v.set(`template:${x.arm.templateId}`, 1);
  v.set(`theme:${x.arm.themeId}`, 1);
  if (x.hookKnown !== false) v.set(`hook:${x.arm.hookStyle}`, 1);
  v.set(`length:${x.arm.lengthBucket}`, 1);
  v.set(`templateLength:${x.arm.templateId}|${x.arm.lengthBucket}`, 1);
  const dur = x.durationS ?? c.lengthBuckets.find((b) => b.id === x.arm.lengthBucket)?.midS;
  if (dur && dur > 0) {
    const l = Math.log(dur / 30);
    v.set('duration:log', l);
    v.set('duration:log2', l * l);
  }
  if (x.melodyId) v.set(`melody:${x.melodyId}`, 1);
  if (x.drama !== undefined) v.set('drama', x.drama / 0.1);
  if (x.copy) {
    v.set('copy:hookChars', x.copy.hookChars / 20);
    v.set('copy:question', x.copy.hookQuestion ? 1 : 0);
    v.set('copy:digit', x.copy.hookDigit ? 1 : 0);
    v.set('copy:emoji', x.copy.hookEmoji ? 1 : 0);
    if (x.copy.titleEmoji !== undefined) v.set('copy:titleEmoji', x.copy.titleEmoji ? 1 : 0);
    if (x.copy.cues !== undefined) v.set('copy:cues', x.copy.cues ? 1 : 0);
    v.set(`cta:${x.copy.ctaStyle}`, 1);
  }
  for (const variant of c.variants ?? []) {
    const [, templateId, param, value] = /^(.+?)\.(.+?)=(.+)$/.exec(variant) ?? [];
    if (templateId === x.arm.templateId && x.params && param in x.params) v.set(`variant:${variant}`, x.params[param] === value ? 1 : 0);
  }
  if (x.params) {
    for (const spec of c.params ?? []) {
      if (spec.templateId !== x.arm.templateId) continue;
      const base = `param:${spec.templateId}.${spec.param}`;
      const value = x.params[spec.param] ?? spec.default;
      if (spec.kind === 'number') {
        const u = paramScale(spec, Number(value));
        if (!Number.isFinite(u)) continue;
        v.set(base, u);
        v.set(`${base}^2`, u * u);
      } else for (const option of spec.values ?? []) v.set(`${base}=${option}`, String(value) === option ? 1 : 0);
    }
  }
  if (x.publishedAt !== undefined) {
    v.set(`time:${hourSlot(x.publishedAt)}`, 1);
    const d = new Date(x.publishedAt).getDay();
    v.set('time:weekend', d === 0 || d === 6 ? 1 : 0);
  }
  return v;
}

/** Which centred groups a raw map actually specifies (one-hot siblings of a known value are 0, not unknown). */
function knownGroups(raw: Map<string, number>, features: Feature[]): Set<FeatureGroup> {
  const g = new Set<FeatureGroup>();
  for (const f of features) if (raw.has(f.name)) g.add(f.group);
  return g;
}

/** Variants and settings belong to different templates, so each is known on its own rather than per group. */
const isKnown = (f: Feature, raw: Map<string, number>, known: Set<FeatureGroup>) => (f.group === 'variant' || f.group === 'param' ? raw.has(f.name) : known.has(f.group));

export interface LearnerModel {
  version: number;
  fittedAt: number;
  /** Training rows used, and their total weight. */
  n: number;
  nEff: number;
  /** Posts at full maturity; the model only steers planning once this reaches READY_AT. */
  matured: number;
  ready: boolean;
  catalog: Catalog;
  names: string[];
  mu: number[];
  /** Lower Cholesky factor of the posterior precision. */
  L: number[][];
  an: number;
  bn: number;
  /** Training means of centred features. */
  means: Record<string, number>;
  /** Training rows per one-hot feature (for "few posts so far" reasons). */
  counts: Record<string, number>;
}

export const READY_AT = 8;
const A0 = 2;
const B0 = 1;

function vector(x: LearnerInput, features: Feature[], means: Record<string, number>, catalog: Catalog): number[] {
  const raw = rawValues(x, catalog);
  const known = knownGroups(raw, features);
  return features.map((f) => {
    if (!f.centred) return raw.get(f.name) ?? 0;
    if (!isKnown(f, raw, known)) return 0;
    return (raw.get(f.name) ?? 0) - (means[f.name] ?? 0);
  });
}

function cholesky(A: number[][]): number[][] {
  const n = A.length;
  const L = A.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) L[i][i] = Math.sqrt(Math.max(s, 1e-12));
      else L[i][j] = s / L[j][j];
    }
  }
  return L;
}

/** Solve L y = b. */
function forward(L: number[][], b: number[]): number[] {
  const y = new Array<number>(b.length);
  for (let i = 0; i < b.length; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  return y;
}

/** Solve Lᵀ x = y. */
function backward(L: number[][], y: number[]): number[] {
  const n = y.length;
  const x = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

export function fitLearner(rows: TrainingRow[], catalog: Catalog, opts: { matured: number; version?: number; now?: number }): LearnerModel {
  const features = featureSpace(catalog);
  const p = features.length;
  // Training means for centred features (weighted, over rows where the group is known).
  const means: Record<string, number> = {};
  const raws = rows.map((r) => rawValues(r.input, catalog));
  for (const f of features) {
    if (!f.centred) continue;
    let s = 0;
    let w = 0;
    raws.forEach((raw, i) => {
      if (!isKnown(f, raw, knownGroups(raw, features))) return;
      s += (raw.get(f.name) ?? 0) * rows[i].weight;
      w += rows[i].weight;
    });
    means[f.name] = w ? s / w : 0;
  }
  const X = rows.map((r) => vector(r.input, features, means, catalog));
  const Lambda = features.map((f, i) => features.map((_, j) => (i === j ? 1 / f.priorSd ** 2 : 0)));
  const Xty = new Array<number>(p).fill(0);
  let yWy = 0;
  let nEff = 0;
  rows.forEach((r, k) => {
    const x = X[k];
    for (let i = 0; i < p; i++) {
      if (!x[i]) continue;
      Xty[i] += r.weight * x[i] * r.reward;
      for (let j = 0; j < p; j++) if (x[j]) Lambda[i][j] += r.weight * x[i] * x[j];
    }
    yWy += r.weight * r.reward * r.reward;
    nEff += r.weight;
  });
  const L = cholesky(Lambda);
  const mu = backward(L, forward(L, Xty));
  const an = A0 + nEff / 2;
  const bn = B0 + 0.5 * Math.max(0, yWy - dot(mu, Xty));
  const counts: Record<string, number> = {};
  for (const f of features) counts[f.name] = raws.filter((raw) => (raw.get(f.name) ?? 0) !== 0).length;
  return {
    version: opts.version ?? 1,
    fittedAt: opts.now ?? Date.now(),
    n: rows.length,
    nEff,
    matured: opts.matured,
    ready: opts.matured >= READY_AT,
    catalog,
    names: features.map((f) => f.name),
    mu,
    L,
    an,
    bn,
    means,
    counts,
  };
}

/** Expected noise variance E[σ²]. */
const sigma2 = (m: LearnerModel) => m.bn / Math.max(1e-6, m.an - 1);

export interface Prediction {
  mean: number;
  /** Uncertainty about the expected reward (not including post-to-post noise). */
  sd: number;
  modelVersion: number;
}

const spaces = new WeakMap<Catalog, Feature[]>();
const spaceFor = (c: Catalog) => spaces.get(c) ?? (spaces.set(c, featureSpace(c)), spaces.get(c)!);

export function predict(m: LearnerModel, x: LearnerInput): Prediction {
  const features = spaceFor(m.catalog);
  const v = vector(x, features, m.means, m.catalog);
  const u = forward(m.L, v);
  return { mean: dot(v, m.mu), sd: Math.sqrt(sigma2(m) * dot(u, u)), modelVersion: m.version };
}

/** Posterior mean ± sd of each feature's effect. */
export function effects(m: LearnerModel): { name: string; group: FeatureGroup; mean: number; sd: number; n: number }[] {
  const features = featureSpace(m.catalog);
  const s2 = sigma2(m);
  return features.map((f, i) => {
    const e = new Array<number>(features.length).fill(0);
    e[i] = 1;
    const u = forward(m.L, e);
    return { name: f.name, group: f.group, mean: m.mu[i], sd: Math.sqrt(s2 * dot(u, u)), n: m.counts[f.name] ?? 0 };
  });
}

// ---- sampling ----------------------------------------------------------------------------------

interface UniformSource {
  next(): number;
}

function normal(rng: UniformSource): number {
  return Math.sqrt(-2 * Math.log(rng.next() || 1e-12)) * Math.cos(2 * Math.PI * rng.next());
}

function gamma(rng: UniformSource, k: number): number {
  if (k < 1) return gamma(rng, k + 1) * Math.pow(rng.next() || 1e-12, 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng.next();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** One draw of the weights from the posterior (Thompson sampling). */
export function sampleWeights(m: LearnerModel, rng: UniformSource, temperature = 1): number[] {
  const s2 = m.bn / gamma(rng, m.an);
  const z = m.mu.map(() => normal(rng));
  const u = backward(m.L, z);
  return m.mu.map((v, i) => v + temperature * Math.sqrt(s2) * u[i]);
}

// ---- planner adapter ---------------------------------------------------------------------------

const describeFactor = (name: string, c: Catalog): string => {
  const [kind, id] = name.split(/:(.*)/s);
  const tname = (t: string) => c.templates.find((x) => x.id === t)?.name ?? t;
  if (kind === 'template') return tname(id);
  if (kind === 'theme') return `the ${id} theme`;
  if (kind === 'hook') return `${id} hooks`;
  if (kind === 'length') return `${id} videos`;
  if (kind === 'templateLength') {
    const [t, b] = id.split('|');
    return `${b} ${tname(t)} videos`;
  }
  return name;
};

/** Wrap a fitted model for the planner's arm chooser. */
/**
 * Thompson draws are tempered (posterior spread × 0.5): with explicit experiment slots doing the
 * exploring, full-width draws kept exploiting picks too random. Tuned on the 90-day simulation
 * in learning.test.ts (tempered + optimistic experiments ≈ 92% of the best achievable reward).
 */
export const THOMPSON_TEMPERATURE = 0.5;

export function armModel(m: LearnerModel, opts: { temperature?: number } = {}): ArmModel {
  const features = spaceFor(m.catalog);
  const armInput = (arm: Arm): LearnerInput => ({ arm });
  const cache = new Map<string, Prediction>();
  const pred = (arm: Arm) => {
    const k = `${arm.templateId}|${arm.themeId}|${arm.lengthBucket}|${arm.hookStyle}`;
    if (!cache.has(k)) cache.set(k, predict(m, armInput(arm)));
    return cache.get(k)!;
  };
  return {
    ready: m.ready,
    sample(rng) {
      const w = sampleWeights(m, rng, opts.temperature ?? THOMPSON_TEMPERATURE);
      return (arm) => dot(vector(armInput(arm), features, m.means, m.catalog), w);
    },
    mean: (arm) => pred(arm).mean,
    sd: (arm) => pred(arm).sd,
    experimentReason(arm) {
      const factors = [`hook:${arm.hookStyle}`, `template:${arm.templateId}`, `theme:${arm.themeId}`, `length:${arm.lengthBucket}`, `templateLength:${arm.templateId}|${arm.lengthBucket}`];
      const least = factors.map((f) => ({ f, n: m.counts[f] ?? 0 })).sort((a, b) => a.n - b.n)[0];
      return `Testing ${describeFactor(least.f, m.catalog)}: ${least.n === 0 ? 'no posts yet' : `${least.n} post${least.n === 1 ? '' : 's'} so far`}`;
    },
  };
}

/**
 * Arm model for the taste model: a template is judged by what it could do with its best known
 * settings, not by the average of what the batches happened to try. Each draw scores every
 * candidate setting of a template and keeps the best, so a template whose batch settings were poor
 * but whose hand-tuned settings were loved still gets picked.
 */
export function tasteArmModel(m: LearnerModel, candidates: Record<string, Record<string, unknown>[]>, opts: { temperature?: number; ready?: boolean } = {}): ArmModel {
  const features = spaceFor(m.catalog);
  const settingIdx = features.flatMap((f, i) => (f.group === 'param' || f.group === 'variant' ? [i] : []));
  const armIdx = features.flatMap((f, i) => (f.group === 'param' || f.group === 'variant' ? [] : [i]));
  const probe = (templateId: string): Arm => ({ templateId, themeId: '', lengthBucket: 'medium', hookStyle: 'question' });
  // Setting-only vectors per template (centred), computed once.
  const settingVecs = new Map<string, number[][]>();
  for (const [t, list] of Object.entries(candidates)) {
    settingVecs.set(
      t,
      list.map((params) => {
        const v = vector({ arm: probe(t), params }, features, m.means, m.catalog);
        return settingIdx.map((i) => v[i]);
      }),
    );
  }
  const armPart = (arm: Arm, w: number[]) => {
    const v = vector({ arm }, features, m.means, m.catalog);
    return armIdx.reduce((s, i) => s + v[i] * w[i], 0);
  };
  const bestSetting = (t: string, w: number[]) => {
    const vecs = settingVecs.get(t);
    if (!vecs?.length) return 0;
    const ws = settingIdx.map((i) => w[i]);
    return Math.max(...vecs.map((v) => dot(v, ws)));
  };
  const meanBest = new Map<string, number>();
  const meanFor = (arm: Arm) => {
    if (!meanBest.has(arm.templateId)) meanBest.set(arm.templateId, bestSetting(arm.templateId, m.mu));
    return armPart(arm, m.mu) + meanBest.get(arm.templateId)!;
  };
  return {
    ready: opts.ready ?? m.ready,
    sample(rng) {
      const w = sampleWeights(m, rng, opts.temperature ?? THOMPSON_TEMPERATURE);
      const best = new Map<string, number>();
      return (arm) => {
        if (!best.has(arm.templateId)) best.set(arm.templateId, bestSetting(arm.templateId, w));
        return armPart(arm, w) + best.get(arm.templateId)!;
      };
    },
    mean: meanFor,
    sd: (arm) => predict(m, { arm }).sd,
    experimentReason(arm) {
      const n = m.counts[`template:${arm.templateId}`] ?? 0;
      return `Exploring ${m.catalog.templates.find((t) => t.id === arm.templateId)?.name ?? arm.templateId}: ${n === 0 ? 'not reviewed yet' : `${n} reviewed so far`}`;
    },
  };
}

/** Score candidate settings for one template with one posterior draw (or the mean when no rng). */
export function scoreSettings(m: LearnerModel, arm: Arm, candidates: Record<string, unknown>[], w?: number[]): number[] {
  const features = spaceFor(m.catalog);
  const weights = w ?? m.mu;
  return candidates.map((params) => dot(vector({ arm, params }, features, m.means, m.catalog), weights));
}

// ---- calibration -------------------------------------------------------------------------------

export interface CalibrationPoint {
  predicted: number;
  actual: number;
  drama: number | null;
}

/**
 * Is the learner actually learning? Rank agreement between what it predicted at export time and
 * what happened, next to the same score for "just trust the drama score" as a baseline.
 */
export function calibration(points: CalibrationPoint[], lastN = 20) {
  const recent = points.slice(-lastN);
  const withDrama = recent.filter((p) => p.drama !== null);
  return {
    n: recent.length,
    model: spearman(
      recent.map((p) => p.predicted),
      recent.map((p) => p.actual),
    ),
    dramaBaseline: spearman(
      withDrama.map((p) => p.drama!),
      withDrama.map((p) => p.actual),
    ),
  };
}
