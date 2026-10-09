import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Recipe } from '@sim/engine';
import { RENDERS_DIR } from '@sim/render';
import { db, getBatch, updateRender, type RenderRow } from './db';
import { dirSize } from './review';

/** Where a render on disk came from. */
export type RenderSource = 'batch' | 'playground-review' | 'playground-export' | 'cli';

export interface LibraryEntry {
  /** Folder relative to data/renders. */
  dir: string;
  source: RenderSource;
  createdAt: number;
  sizeBytes: number;
  durationS: number | null;
  recipe: Recipe | null;
  qcPass: boolean | null;
  hasCover: boolean;
  /** Set when the database knows this render. */
  renderId: string | null;
  batchId: string | null;
  batchCreatedAt: number | null;
  decision: RenderRow['decision'] | null;
  hook: string | null;
}

/** Every folder under data/renders that holds a finished video (final.mp4), up to 3 levels deep. */
async function findRenderDirs(root: string, depth = 0): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((e) => e.isFile() && e.name === 'final.mp4')) return [root];
  if (depth >= 3) return [];
  const out: string[] = [];
  for (const e of entries) if (e.isDirectory()) out.push(...(await findRenderDirs(join(root, e.name), depth + 1)));
  return out;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function scanLibrary(): Promise<LibraryEntry[]> {
  const tracked = new Map<string, any>();
  for (const r of db.prepare("SELECT id, batch_id, kind, decision, dir, copy, qc, duration_s FROM renders WHERE dir IS NOT NULL").all() as any[]) tracked.set(r.dir, r);
  const batchTimes = new Map<string, number>();
  const dirs = await findRenderDirs(RENDERS_DIR);
  const entries = await Promise.all(
    dirs.map(async (abs): Promise<LibraryEntry> => {
      const rel = relative(RENDERS_DIR, abs);
      const row = tracked.get(rel);
      const [recipe, result, st, size, hasCover] = await Promise.all([
        readJson<Recipe>(join(abs, 'recipe.json')),
        readJson<{ durationS?: number; qc?: { pass?: boolean } }>(join(abs, 'result.json')),
        stat(join(abs, 'final.mp4')),
        dirSize(abs),
        stat(join(abs, 'cover.jpg')).then(() => true, () => false),
      ]);
      let batchCreatedAt: number | null = null;
      if (row?.batch_id) {
        if (!batchTimes.has(row.batch_id)) batchTimes.set(row.batch_id, getBatch(row.batch_id)?.createdAt ?? 0);
        batchCreatedAt = batchTimes.get(row.batch_id)!;
      }
      const source: RenderSource = !row ? 'cli' : row.kind === 'batch' ? 'batch' : row.kind === 'manual' ? 'playground-review' : 'playground-export';
      const qc = row?.qc ? JSON.parse(row.qc) : result?.qc;
      return {
        dir: rel,
        source,
        createdAt: st.mtimeMs,
        sizeBytes: size,
        durationS: row?.duration_s ?? result?.durationS ?? null,
        recipe,
        qcPass: qc?.pass ?? null,
        hasCover,
        renderId: row?.id ?? null,
        batchId: row?.batch_id ?? null,
        batchCreatedAt,
        decision: row?.decision ?? null,
        hook: row?.copy ? JSON.parse(row.copy).hook : (recipe?.copy?.hook ?? null),
      };
    }),
  );
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

/** Delete a render folder from disk; if the database tracks it, mark it deleted there too. */
export async function deleteLibraryEntry(rel: string): Promise<boolean> {
  const abs = join(RENDERS_DIR, rel);
  if (!abs.startsWith(RENDERS_DIR + sep) || rel.includes('..')) return false;
  await rm(abs, { recursive: true, force: true });
  const row = db.prepare('SELECT id FROM renders WHERE dir = ?').get(rel) as { id: string } | undefined;
  if (row) updateRender(row.id, { status: 'deleted', dir: null });
  return true;
}
