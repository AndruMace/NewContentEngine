import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner, getTheme, hashString, type Recipe } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from '@sim/templates';
import { clipPath, prepareNarration } from '@sim/voice';
import { RenderHarness } from './harness';
import { extractStills, master, qc, type QcReport } from './ffmpeg';

export { RenderHarness } from './harness';
export { searchSeeds, type SeedResult } from './search';
export type { QcReport, LongFormQcReport } from './ffmpeg';
export { renderLongForm, renderLongFormStills, LongFormCancelled, SEGMENT_S, type LongFormOutput, type LongFormStage } from './longform';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const RENDERS_DIR = join(ROOT, 'data/renders');

export type RenderStage = 'voice' | 'frames' | 'audio' | 'mastering' | 'qc';

export interface RenderOutput {
  /** The recipe as rendered: with its narration when it has one (store it, so re-renders sound the same). */
  recipe: Recipe;
  dir: string;
  final: string;
  cover: string;
  contact: string;
  qc: QcReport;
  codec: string;
  durationS: number;
  score: { total: number; parts: Record<string, number>; notes?: string[] };
  timings: { encodeMs: number; audioMs: number; masterMs: number; totalMs: number };
}

export function defaultOutDir(recipe: Recipe, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const stamp = date.toISOString().slice(11, 19).replace(/:/g, '');
  return join(RENDERS_DIR, day, `${recipe.templateId}-${recipe.seed}-${recipe.themeId}-${stamp}`);
}

/** Render a recipe end-to-end: frames + audio in Chrome, then mastering, stills and QC. */
export async function renderRecipe(
  recipe: Recipe,
  opts: {
    outDir?: string;
    harness?: RenderHarness;
    onProgress?: (frame: number, est: number) => void;
    /** ('voice' →) 'frames' → 'audio' → 'mastering' → 'qc' */
    onStage?: (stage: RenderStage) => void;
    /** Something worked, but not as asked (e.g. narration fell back to the built-in lines). */
    onWarning?: (message: string) => void;
    /** Keep video.mp4/audio.wav intermediates (final.mp4 + events.json can always regenerate them). */
    keepIntermediates?: boolean;
  } = {},
): Promise<RenderOutput> {
  const t0 = performance.now();
  const dir = opts.outDir ?? defaultOutDir(recipe);
  await mkdir(dir, { recursive: true });
  // Narrated templates: write and voice the lines first; their lengths time the sim.
  if (getTemplate(recipe.templateId).narration) {
    opts.onStage?.('voice');
    recipe = await prepareNarration(recipe, { onWarning: opts.onWarning });
    if (recipe.voice) {
      await mkdir(join(dir, 'voice'), { recursive: true });
      await Promise.all(recipe.voice.lines.map((l) => copyFile(clipPath(l.clip), join(dir, 'voice', l.clip))));
    }
  }
  await writeFile(join(dir, 'recipe.json'), JSON.stringify(recipe, null, 2));

  const harness = opts.harness ?? new RenderHarness();
  if (!opts.harness) await harness.start();
  let page;
  try {
    opts.onStage?.('frames');
    page = await harness.render(recipe, dir, {
      onProgress: opts.onProgress,
      onStage: (stage) => opts.onStage?.(stage as RenderStage),
    });
  } finally {
    if (!opts.harness) await harness.stop();
  }
  if (page.timedOut) throw new Error(`Sim did not finish within the time limit (seed ${recipe.seed}). Try another seed.`);

  const t1 = performance.now();
  opts.onStage?.('mastering');
  const final = await master(dir, page.codec);
  // Cover: hook text fully popped in, scene intact.
  await extractStills(dir, Math.min(0.7, page.durationS / 2), page.durationS);
  opts.onStage?.('qc');
  const report = await qc(final, page.durationS);
  // The browser must have simulated exactly what seed search (in Node) scored.
  const rendered = JSON.parse(await readFile(join(dir, 'events.json'), 'utf8')).events;
  const node = new Runner(getTemplate(recipe.templateId), {
    seed: recipe.seed,
    params: recipe.params,
    theme: getTheme(recipe.themeId),
    melody: getMelody(recipe.melodyId),
    visual: false,
    maxSeconds: 90,
    voice: recipe.voice,
  }).runToEnd();
  if (hashString(JSON.stringify(node.events)) !== hashString(JSON.stringify(rendered))) {
    report.problems.push('browser sim diverged from Node sim (seed search scored a different run)');
    report.pass = false;
  }
  const masterMs = performance.now() - t1;
  if (!opts.keepIntermediates) await Promise.all(['video.mp4', 'audio.wav'].map((f) => rm(join(dir, f), { force: true })));

  const out: RenderOutput = {
    recipe,
    dir,
    final,
    cover: join(dir, 'cover.jpg'),
    contact: join(dir, 'contact.jpg'),
    qc: report,
    codec: page.codec,
    durationS: page.durationS,
    score: page.score,
    timings: { encodeMs: page.encodeMs, audioMs: page.audioMs, masterMs, totalMs: performance.now() - t0 },
  };
  await writeFile(join(dir, 'result.json'), JSON.stringify(out, null, 2));
  return out;
}

export async function readRecipe(path: string): Promise<Recipe> {
  return JSON.parse(await readFile(path, 'utf8'));
}
