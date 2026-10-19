import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Recipe } from '@sim/engine';
import type { Concept, SocialCopy } from '@sim/planner';
import { ROOT, type QcReport } from '@sim/render';
import type { PostFeatures } from '@sim/analytics';
import { LONG_FORM_TEMPLATES } from '@sim/templates';

/** SIM_DATA_DIR points the database (and tokens) elsewhere, e.g. for tests. */
export const DATA_DIR = process.env.SIM_DATA_DIR ?? join(ROOT, 'data');
export const EXPORTS_DIR = join(DATA_DIR, 'exports');
mkdirSync(DATA_DIR, { recursive: true });

export const newId = () => randomUUID().replace(/-/g, '').slice(0, 12);

export interface BatchSettings {
  postsWanted: number;
  factor: number;
  templateIds: string[];
  themeIds: string[];
  melodyIds: string[];
  minLengthS: number;
  maxLengthS: number;
  useClaude: boolean;
  notes: string;
  notifyMac: boolean;
}

export const DEFAULT_BATCH_SETTINGS: BatchSettings = {
  postsWanted: 3,
  factor: 3,
  templateIds: [],
  themeIds: [],
  melodyIds: [],
  minLengthS: 20,
  maxLengthS: 45,
  useClaude: true,
  notes: '',
  notifyMac: true,
};

export type BatchStatus = 'planning' | 'searching' | 'rendering' | 'done' | 'cancelled' | 'failed' | 'manual';

export interface BatchRow {
  id: string;
  createdAt: number;
  finishedAt: number | null;
  status: BatchStatus;
  settings: BatchSettings;
  warnings: string[];
  error: string | null;
  /** Concepts this batch should end up with. */
  target: number;
}

export interface ConceptRow {
  id: string;
  batchId: string;
  idx: number;
  concept: Concept;
}

export type RenderStatus = 'queued' | 'rendering' | 'ready' | 'failed' | 'cancelled' | 'deleted';
export type Decision = 'pending' | 'approved' | 'rejected' | 'rerolled';
export type RenderKind = 'batch' | 'manual' | 'export';

export interface RenderRow {
  id: string;
  batchId: string | null;
  conceptId: string | null;
  kind: RenderKind;
  recipe: Recipe;
  copy: SocialCopy | null;
  score: number | null;
  scoreParts: Record<string, number> | null;
  altSeeds: number[];
  status: RenderStatus;
  stage: string | null;
  progress: number;
  /** Relative to data/renders. */
  dir: string | null;
  qc: QcReport | null;
  durationS: number | null;
  rankScore: number | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  renderMs: number | null;
  decision: Decision;
  supersededBy: string | null;
  /** Learner's expected reward when the candidate was ranked (null before the model is ready). */
  prediction: { mean: number; sd: number; modelVersion: number } | null;
  /** Reject reasons chosen in Review (see REJECT_REASONS). */
  reasons: string[];
  note: string | null;
  /** Write the upload bundle as soon as the render (and its copy) is ready: Playground exports. */
  autoExport: boolean;
}

export interface ExportRow {
  id: string;
  renderId: string;
  /** Relative to data/exports. */
  dir: string;
  createdAt: number;
}

export type { Platform } from '@sim/planner/platforms';
import type { Platform } from '@sim/planner/platforms';

export interface PostRow {
  renderId: string;
  platform: Platform;
  url: string;
  postedAt: number;
  /** Platform's id for the post (YouTube video id), when known. */
  externalId?: string | null;
  /** When the platform says it went live (more accurate than postedAt). */
  publishedAt?: number | null;
  linkedBy?: 'paste' | 'auto';
  /** Numbers typed in by hand, e.g. YouTube Studio's "Stayed to watch" %. */
  manual?: Record<string, number>;
}

export const db = new DatabaseSync(join(DATA_DIR, 'sqlite.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const MIGRATIONS = [
  `CREATE TABLE batches (
     id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
     settings TEXT NOT NULL, warnings TEXT NOT NULL DEFAULT '[]', error TEXT, target INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE concepts (
     id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), idx INTEGER NOT NULL, concept TEXT NOT NULL);
   CREATE INDEX concepts_batch ON concepts(batch_id);
   CREATE TABLE renders (
     id TEXT PRIMARY KEY, batch_id TEXT REFERENCES batches(id), concept_id TEXT REFERENCES concepts(id),
     kind TEXT NOT NULL, recipe TEXT NOT NULL, copy TEXT, score REAL, score_parts TEXT, alt_seeds TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL, stage TEXT, progress REAL NOT NULL DEFAULT 0, dir TEXT, qc TEXT, duration_s REAL, rank_score REAL,
     error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, render_ms INTEGER,
     decision TEXT NOT NULL DEFAULT 'pending', superseded_by TEXT);
   CREATE INDEX renders_batch ON renders(batch_id);
   CREATE INDEX renders_status ON renders(status);
   CREATE TABLE exports (id TEXT PRIMARY KEY, render_id TEXT NOT NULL REFERENCES renders(id), dir TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE posts (render_id TEXT NOT NULL REFERENCES renders(id), platform TEXT NOT NULL, url TEXT NOT NULL, posted_at INTEGER NOT NULL,
     PRIMARY KEY (render_id, platform));
   CREATE TABLE arms (key TEXT PRIMARY KEY, alpha REAL NOT NULL, beta REAL NOT NULL, n INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // Phase 5: analytics. Snapshots hold raw metrics only, so rewards can be recomputed at any time.
  `ALTER TABLE posts ADD COLUMN external_id TEXT;
   ALTER TABLE posts ADD COLUMN published_at INTEGER;
   ALTER TABLE posts ADD COLUMN linked_by TEXT NOT NULL DEFAULT 'paste';
   ALTER TABLE posts ADD COLUMN manual TEXT NOT NULL DEFAULT '{}';
   CREATE UNIQUE INDEX posts_external ON posts(platform, external_id);
   CREATE TABLE metric_snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT, render_id TEXT NOT NULL REFERENCES renders(id), platform TEXT NOT NULL,
     fetched_at INTEGER NOT NULL, age_h REAL NOT NULL, source TEXT NOT NULL, metrics TEXT NOT NULL);
   CREATE INDEX snapshots_render ON metric_snapshots(render_id, platform, fetched_at);
   CREATE TABLE retention_curves (
     render_id TEXT NOT NULL REFERENCES renders(id), platform TEXT NOT NULL, fetched_at INTEGER NOT NULL, age_h REAL NOT NULL,
     points TEXT NOT NULL, PRIMARY KEY (render_id, platform));
   CREATE TABLE predictions (
     render_id TEXT PRIMARY KEY REFERENCES renders(id), created_at INTEGER NOT NULL, model_version INTEGER,
     mean REAL, sd REAL, experiment INTEGER NOT NULL DEFAULT 0, features TEXT NOT NULL);
   CREATE TABLE insights (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, n_posts INTEGER NOT NULL, kind TEXT NOT NULL, report TEXT NOT NULL);`,
  // What the learner expected of each candidate when it was ranked.
  `ALTER TABLE renders ADD COLUMN prediction TEXT;`,
  // Review feedback: why a candidate was rejected (reason ids) and an optional free-text note.
  `ALTER TABLE renders ADD COLUMN reasons TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE renders ADD COLUMN note TEXT;`,
  // Playground exports: bundle for upload once rendered.
  `ALTER TABLE renders ADD COLUMN auto_export INTEGER NOT NULL DEFAULT 0;`,
];

{
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
}

const json = <T>(s: unknown, fallback: T): T => (typeof s === 'string' ? (JSON.parse(s) as T) : fallback);

// ---- kv -----------------------------------------------------------------------------------

export function getKv<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setKv(key: string, value: unknown) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

// ---- batches ------------------------------------------------------------------------------

const toBatch = (r: any): BatchRow => ({
  id: r.id,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
  status: r.status,
  settings: json(r.settings, DEFAULT_BATCH_SETTINGS),
  warnings: json(r.warnings, []),
  error: r.error,
  target: r.target,
});

export function insertBatch(b: Pick<BatchRow, 'status' | 'settings' | 'target'>): BatchRow {
  const id = newId();
  db.prepare('INSERT INTO batches (id, created_at, status, settings, target) VALUES (?, ?, ?, ?, ?)').run(id, Date.now(), b.status, JSON.stringify(b.settings), b.target);
  return getBatch(id)!;
}

export function getBatch(id: string): BatchRow | undefined {
  const r = db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
  return r ? toBatch(r) : undefined;
}

export function listBatches(limit = 30): BatchRow[] {
  return db.prepare('SELECT * FROM batches ORDER BY created_at DESC LIMIT ?').all(limit).map(toBatch);
}

export function activeBatches(): BatchRow[] {
  return db.prepare("SELECT * FROM batches WHERE status IN ('planning','searching','rendering') ORDER BY created_at").all().map(toBatch);
}

export function updateBatch(id: string, patch: Partial<Pick<BatchRow, 'status' | 'finishedAt' | 'warnings' | 'error'>>) {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.status !== undefined) (cols.push('status = ?'), vals.push(patch.status));
  if (patch.finishedAt !== undefined) (cols.push('finished_at = ?'), vals.push(patch.finishedAt));
  if (patch.warnings !== undefined) (cols.push('warnings = ?'), vals.push(JSON.stringify(patch.warnings)));
  if (patch.error !== undefined) (cols.push('error = ?'), vals.push(patch.error));
  if (cols.length) db.prepare(`UPDATE batches SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
}

/** Today's batch that collects one-off videos sent from the Playground. */
export function manualBatchForToday(): BatchRow {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const r = db.prepare("SELECT * FROM batches WHERE status = 'manual' AND created_at >= ? ORDER BY created_at DESC LIMIT 1").get(start.getTime());
  return r ? toBatch(r) : insertBatch({ status: 'manual', settings: DEFAULT_BATCH_SETTINGS, target: 0 });
}

// ---- concepts -----------------------------------------------------------------------------

const toConcept = (r: any): ConceptRow => ({ id: r.id, batchId: r.batch_id, idx: r.idx, concept: json(r.concept, null as unknown as Concept) });

export function insertConcept(batchId: string, idx: number, concept: Concept): ConceptRow {
  const id = newId();
  db.prepare('INSERT INTO concepts (id, batch_id, idx, concept) VALUES (?, ?, ?, ?)').run(id, batchId, idx, JSON.stringify(concept));
  return { id, batchId, idx, concept };
}

export function updateConcept(id: string, concept: Concept) {
  db.prepare('UPDATE concepts SET concept = ? WHERE id = ?').run(JSON.stringify(concept), id);
}

export function getConcept(id: string): ConceptRow | undefined {
  const r = db.prepare('SELECT * FROM concepts WHERE id = ?').get(id);
  return r ? toConcept(r) : undefined;
}

export function conceptsForBatch(batchId: string): ConceptRow[] {
  return db.prepare('SELECT * FROM concepts WHERE batch_id = ? ORDER BY idx').all(batchId).map(toConcept);
}

// ---- renders ------------------------------------------------------------------------------

const toRender = (r: any): RenderRow => ({
  id: r.id,
  batchId: r.batch_id,
  conceptId: r.concept_id,
  kind: r.kind,
  recipe: json(r.recipe, null as unknown as Recipe),
  copy: json(r.copy, null),
  score: r.score,
  scoreParts: json(r.score_parts, null),
  altSeeds: json(r.alt_seeds, []),
  status: r.status,
  stage: r.stage,
  progress: r.progress,
  dir: r.dir,
  qc: json(r.qc, null),
  durationS: r.duration_s,
  rankScore: r.rank_score,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  renderMs: r.render_ms,
  decision: r.decision,
  supersededBy: r.superseded_by,
  prediction: json(r.prediction, null),
  reasons: json(r.reasons, []),
  note: r.note ?? null,
  autoExport: Boolean(r.auto_export),
});

export function insertRender(
  r: Pick<RenderRow, 'batchId' | 'conceptId' | 'kind' | 'recipe' | 'copy' | 'score' | 'scoreParts' | 'altSeeds' | 'rankScore'> & Partial<Pick<RenderRow, 'prediction' | 'decision' | 'autoExport'>>,
): RenderRow {
  const id = newId();
  db.prepare(
    `INSERT INTO renders (id, batch_id, concept_id, kind, recipe, copy, score, score_parts, alt_seeds, status, rank_score, created_at, prediction, decision, auto_export)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    r.batchId,
    r.conceptId,
    r.kind,
    JSON.stringify(r.recipe),
    r.copy ? JSON.stringify(r.copy) : null,
    r.score,
    r.scoreParts ? JSON.stringify(r.scoreParts) : null,
    JSON.stringify(r.altSeeds),
    r.rankScore,
    Date.now(),
    r.prediction ? JSON.stringify(r.prediction) : null,
    r.decision ?? 'pending',
    r.autoExport ? 1 : 0,
  );
  return getRender(id)!;
}

export function getRender(id: string): RenderRow | undefined {
  const r = db.prepare('SELECT * FROM renders WHERE id = ?').get(id);
  return r ? toRender(r) : undefined;
}

/** Changes whenever a decision, reason, reroll or new render could change what the taste model learns. */
export function tasteFingerprint(): string {
  const r = db
    .prepare("SELECT COUNT(*) AS n, group_concat(id || decision || reasons || coalesce(superseded_by, ''), ',') AS f FROM renders WHERE status IN ('ready', 'deleted')")
    .get() as { n: number; f: string | null };
  let h = 2166136261;
  const f = r.f ?? '';
  for (let i = 0; i < f.length; i++) h = Math.imul(h ^ f.charCodeAt(i), 16777619) >>> 0;
  return `${r.n}:${h}`;
}

/** Every render that can teach the taste model: reviewed batch candidates plus playground work. */
export function reviewableRenders(): RenderRow[] {
  return db.prepare("SELECT * FROM renders WHERE status IN ('ready', 'deleted') ORDER BY created_at").all().map(toRender);
}

export function rendersForBatch(batchId: string): RenderRow[] {
  return db.prepare('SELECT * FROM renders WHERE batch_id = ? ORDER BY created_at').all(batchId).map(toRender);
}

export function rendersForConcept(conceptId: string): RenderRow[] {
  return db.prepare('SELECT * FROM renders WHERE concept_id = ? ORDER BY created_at').all(conceptId).map(toRender);
}

/** Next render to work on: Playground exports first, then oldest. */
export function nextQueuedRender(): RenderRow | undefined {
  const r = db
    .prepare("SELECT * FROM renders WHERE status = 'queued' ORDER BY CASE WHEN auto_export = 1 OR kind = 'export' THEN 0 WHEN kind = 'manual' THEN 1 ELSE 2 END, created_at LIMIT 1")
    .get();
  return r ? toRender(r) : undefined;
}

const RENDER_COLS: Record<string, string> = {
  recipe: 'recipe', copy: 'copy', score: 'score', scoreParts: 'score_parts', altSeeds: 'alt_seeds', status: 'status', stage: 'stage',
  progress: 'progress', dir: 'dir', qc: 'qc', durationS: 'duration_s', rankScore: 'rank_score', error: 'error', startedAt: 'started_at',
  finishedAt: 'finished_at', renderMs: 'render_ms', decision: 'decision', supersededBy: 'superseded_by', prediction: 'prediction', reasons: 'reasons', note: 'note',
  autoExport: 'auto_export',
};
const JSON_COLS = new Set(['recipe', 'copy', 'scoreParts', 'altSeeds', 'qc', 'prediction', 'reasons']);

export function updateRender(id: string, patch: Partial<RenderRow>) {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = RENDER_COLS[k];
    if (!col) continue;
    cols.push(`${col} = ?`);
    vals.push(v === null || v === undefined ? null : JSON_COLS.has(k) ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : (v as string | number));
  }
  if (cols.length) db.prepare(`UPDATE renders SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
}

/** Rendered Playground exports whose upload bundle hasn't been written yet. */
export function pendingAutoExports(): RenderRow[] {
  return db.prepare("SELECT * FROM renders WHERE auto_export = 1 AND status = 'ready' AND id NOT IN (SELECT render_id FROM exports)").all().map(toRender);
}

/** Server restarted mid-render: put interrupted renders back in the queue. */
export function requeueInterrupted(): number {
  return Number(db.prepare("UPDATE renders SET status = 'queued', stage = NULL, progress = 0 WHERE status = 'rendering'").run().changes);
}

/** Melodies of the most recent batch renders (newest first), so new batches can avoid repeating them. */
export function recentMelodies(limit = 24): string[] {
  return db
    .prepare("SELECT recipe FROM renders WHERE kind = 'batch' AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((r: any) => json<{ melodyId?: string }>(r.recipe, {}).melodyId)
    .filter((m): m is string => Boolean(m));
}

/** Comment prompts used recently (newest first), so new batches vary them. */
export function recentNudges(limit = 40): string[] {
  return db
    .prepare("SELECT copy FROM renders WHERE copy IS NOT NULL AND kind = 'batch' ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((r: any) => json<{ nudge?: string } | null>(r.copy, null)?.nudge)
    .filter((n): n is string => Boolean(n));
}

/** Recent hooks across batches, so the planner avoids repeats. */
export function recentHooks(limit = 30): string[] {
  return db
    .prepare("SELECT copy FROM renders WHERE copy IS NOT NULL AND kind != 'export' ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((r: any) => json<SocialCopy | null>(r.copy, null)?.hook)
    .filter((h): h is string => Boolean(h));
}

/** Titles of recently exported videos (newest first): what the channel actually published. */
export function recentTitles(limit = 12): string[] {
  return db
    .prepare('SELECT r.copy FROM exports e JOIN renders r ON r.id = e.render_id WHERE r.copy IS NOT NULL ORDER BY e.created_at DESC LIMIT ?')
    .all(limit)
    .map((r: any) => json<SocialCopy | null>(r.copy, null)?.title)
    .filter((t): t is string => Boolean(t));
}

// ---- exports & posts -----------------------------------------------------------------------

export function insertExport(renderId: string, dir: string): ExportRow {
  const id = newId();
  const createdAt = Date.now();
  db.prepare('INSERT INTO exports (id, render_id, dir, created_at) VALUES (?, ?, ?, ?)').run(id, renderId, dir, createdAt);
  return { id, renderId, dir, createdAt };
}

export function exportForRender(renderId: string): ExportRow | undefined {
  const r = db.prepare('SELECT * FROM exports WHERE render_id = ? ORDER BY created_at DESC LIMIT 1').get(renderId) as any;
  return r ? { id: r.id, renderId: r.render_id, dir: r.dir, createdAt: r.created_at } : undefined;
}

export function getExport(id: string): ExportRow | undefined {
  const r = db.prepare('SELECT * FROM exports WHERE id = ?').get(id) as any;
  return r ? { id: r.id, renderId: r.render_id, dir: r.dir, createdAt: r.created_at } : undefined;
}

const toPost = (r: any): PostRow => ({
  renderId: r.render_id,
  platform: r.platform,
  url: r.url,
  postedAt: r.posted_at,
  externalId: r.external_id,
  publishedAt: r.published_at,
  linkedBy: r.linked_by,
  manual: json(r.manual, {}),
});

export function upsertPost(p: PostRow) {
  db.prepare(
    `INSERT INTO posts (render_id, platform, url, posted_at, external_id, published_at, linked_by) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(render_id, platform) DO UPDATE SET url = excluded.url, posted_at = excluded.posted_at,
       external_id = excluded.external_id, published_at = COALESCE(excluded.published_at, posts.published_at), linked_by = excluded.linked_by`,
  ).run(p.renderId, p.platform, p.url, p.postedAt, p.externalId ?? null, p.publishedAt ?? null, p.linkedBy ?? 'paste');
}

export function updatePostMeta(renderId: string, platform: Platform, patch: { publishedAt?: number; manual?: Record<string, number> }) {
  if (patch.publishedAt !== undefined) db.prepare('UPDATE posts SET published_at = ? WHERE render_id = ? AND platform = ?').run(patch.publishedAt, renderId, platform);
  if (patch.manual !== undefined) db.prepare('UPDATE posts SET manual = ? WHERE render_id = ? AND platform = ?').run(JSON.stringify(patch.manual), renderId, platform);
}

export function deletePost(renderId: string, platform: string) {
  db.prepare('DELETE FROM posts WHERE render_id = ? AND platform = ?').run(renderId, platform);
}

export function postsForRender(renderId: string): PostRow[] {
  return db.prepare('SELECT * FROM posts WHERE render_id = ?').all(renderId).map(toPost);
}

/** Posts of Shorts. Long-form ambient videos share the channel but are ignored by analytics entirely. */
export function allPosts(platform?: Platform): PostRow[] {
  const longForm = LONG_FORM_TEMPLATES.map((t) => t.id);
  const notLongForm = `p.render_id NOT IN (SELECT id FROM renders WHERE json_extract(recipe, '$.templateId') IN (${longForm.map(() => '?').join(',') || "''"}))`;
  const rows = platform
    ? db.prepare(`SELECT p.* FROM posts p WHERE p.platform = ? AND ${notLongForm} ORDER BY p.posted_at`).all(platform, ...longForm)
    : db.prepare(`SELECT p.* FROM posts p WHERE ${notLongForm} ORDER BY p.posted_at`).all(...longForm);
  return rows.map(toPost);
}

export function postByExternalId(platform: Platform, externalId: string): PostRow | undefined {
  const r = db.prepare('SELECT * FROM posts WHERE platform = ? AND external_id = ?').get(platform, externalId);
  return r ? toPost(r) : undefined;
}

// ---- analytics -----------------------------------------------------------------------------

export interface SnapshotRow {
  renderId: string;
  platform: Platform;
  fetchedAt: number;
  ageH: number;
  source: 'youtube' | 'manual' | 'csv';
  metrics: Record<string, number>;
}

export function insertSnapshot(s: SnapshotRow) {
  db.prepare('INSERT INTO metric_snapshots (render_id, platform, fetched_at, age_h, source, metrics) VALUES (?, ?, ?, ?, ?, ?)').run(
    s.renderId,
    s.platform,
    s.fetchedAt,
    s.ageH,
    s.source,
    JSON.stringify(s.metrics),
  );
}

export function snapshotsFor(renderId: string, platform: Platform): SnapshotRow[] {
  return db
    .prepare('SELECT * FROM metric_snapshots WHERE render_id = ? AND platform = ? ORDER BY fetched_at')
    .all(renderId, platform)
    .map((r: any) => ({ renderId: r.render_id, platform: r.platform, fetchedAt: r.fetched_at, ageH: r.age_h, source: r.source, metrics: json(r.metrics, {}) }));
}

export interface RetentionRow {
  renderId: string;
  platform: Platform;
  fetchedAt: number;
  ageH: number;
  /** elapsed ratio 0..1, audienceWatchRatio, relativeRetentionPerformance */
  points: { t: number; watch: number; relative: number | null }[];
}

export function upsertRetention(r: RetentionRow) {
  db.prepare(
    `INSERT INTO retention_curves (render_id, platform, fetched_at, age_h, points) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(render_id, platform) DO UPDATE SET fetched_at = excluded.fetched_at, age_h = excluded.age_h, points = excluded.points`,
  ).run(r.renderId, r.platform, r.fetchedAt, r.ageH, JSON.stringify(r.points));
}

export function retentionFor(renderId: string, platform: Platform): RetentionRow | undefined {
  const r = db.prepare('SELECT * FROM retention_curves WHERE render_id = ? AND platform = ?').get(renderId, platform) as any;
  return r ? { renderId: r.render_id, platform: r.platform, fetchedAt: r.fetched_at, ageH: r.age_h, points: json(r.points, []) } : undefined;
}

export interface PredictionRow {
  renderId: string;
  createdAt: number;
  modelVersion: number | null;
  mean: number | null;
  sd: number | null;
  experiment: boolean;
  features: PostFeatures;
}

/** Written once, at first export: what the model expected before any results existed. */
export function insertPredictionOnce(p: PredictionRow) {
  db.prepare('INSERT OR IGNORE INTO predictions (render_id, created_at, model_version, mean, sd, experiment, features) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    p.renderId,
    p.createdAt,
    p.modelVersion,
    p.mean,
    p.sd,
    p.experiment ? 1 : 0,
    JSON.stringify(p.features),
  );
}

const toPrediction = (r: any): PredictionRow => ({
  renderId: r.render_id,
  createdAt: r.created_at,
  modelVersion: r.model_version,
  mean: r.mean,
  sd: r.sd,
  experiment: Boolean(r.experiment),
  features: json(r.features, null as unknown as PostFeatures),
});

export function predictionFor(renderId: string): PredictionRow | undefined {
  const r = db.prepare('SELECT * FROM predictions WHERE render_id = ?').get(renderId);
  return r ? toPrediction(r) : undefined;
}

export function allPredictions(): PredictionRow[] {
  return db.prepare('SELECT * FROM predictions ORDER BY created_at').all().map(toPrediction);
}

