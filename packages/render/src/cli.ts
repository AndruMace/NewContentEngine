/**
 * Render a video from the command line.
 *
 *   npm run render -- --template ring-escape --seed 42
 *   npm run render -- --template ring-escape --search 500 --target 30 --theme mono-gold --melody fur-elise
 *   npm run render -- --recipe path/to/recipe.json
 *   npm run render -- --recipe-json '{"templateId":"ring-escape",...}'
 *
 * Long-form (ambient) templates render a master loop and repeat it to the final length:
 *   npm run render -- --template cabin-storm --loop 30m --length 3h
 *   npm run render -- --template cabin-storm --loop 60s --length 3m --test   (quick test: loops under 20m)
 *   npm run render -- --recipe data/renders/<day>/<id>/recipe.json --out data/renders/<day>/<id>   (resume)
 *   npm run render -- --template cabin-storm --still 12,40.5 --out /tmp/stills   (single frames as PNG)
 */
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { join } from 'node:path';
import { loopLengthOf, type Recipe } from '@sim/engine';
import { getTemplate } from '@sim/templates';
import { RENDERS_DIR, ROOT, readRecipe, renderLongForm, renderLongFormStills, renderRecipe, searchSeeds } from './index';

/** "90s", "30m", "2.5h" or plain seconds. */
function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`Can't read the duration "${s}" (use e.g. 90s, 30m, 3h)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[(m[2] ?? 's') as 's' | 'm' | 'h'];
}

const hms = (s: number) => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m${s % 60 ? `${Math.round(s % 60)}s` : ''}`;

const { values: a } = parseArgs({
  options: {
    recipe: { type: 'string' },
    'recipe-json': { type: 'string' },
    template: { type: 'string', default: 'ring-escape' },
    seed: { type: 'string' },
    theme: { type: 'string', default: 'neon-dark' },
    melody: { type: 'string', default: 'ode-to-joy' },
    params: { type: 'string', default: '{}' },
    hook: { type: 'string' },
    cta: { type: 'string' },
    target: { type: 'string' },
    search: { type: 'string' },
    out: { type: 'string' },
    loop: { type: 'string' },
    length: { type: 'string' },
    test: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    still: { type: 'string' },
  },
});

async function longForm(recipe: Recipe) {
  if (a.loop) recipe.loopS = parseDuration(a.loop);
  if (a.length) recipe.totalS = parseDuration(a.length);
  const lf = getTemplate(recipe.templateId).longForm!;
  if (!a.test && recipe.loopS !== undefined && (recipe.loopS < lf.minLoopS || recipe.loopS > lf.maxLoopS))
    throw new Error(`Loop must be ${lf.minLoopS / 60}–${lf.maxLoopS / 60} minutes (add --test for a shorter test loop)`);
  if (!a.test && recipe.loopS !== undefined && lf.loopStepS && recipe.loopS % lf.loopStepS) {
    const snapped = loopLengthOf(getTemplate(recipe.templateId), recipe.loopS);
    console.log(`Loop rounded to ${snapped / 60} minutes (this template's loops are multiples of ${lf.loopStepS / 60} minutes)`);
    recipe.loopS = snapped;
  }
  if (a.test && lf.loopStepS && (recipe.loopS ?? 0) % lf.loopStepS)
    console.log(`Note: a ${recipe.loopS}s test loop isn't a multiple of ${lf.loopStepS}s, so the sound jumps at its join (QC will say so).`);
  const loopS = recipe.loopS ?? lf.defaultLoopS;
  recipe.totalS ??= loopS;
  const stamp = new Date().toISOString();
  const outDir = a.out ?? join(RENDERS_DIR, stamp.slice(0, 10), `${recipe.templateId}-${recipe.seed}-${stamp.slice(11, 19).replace(/:/g, '')}`);
  if (a.still) {
    const files = await renderLongFormStills(recipe, a.still.split(',').map(Number), { outDir, allowShortLoop: a.test });
    for (const f of files) console.log(relative(ROOT, f));
    return;
  }
  console.log(`Rendering ${recipe.templateId} seed ${recipe.seed}: ${hms(loopS)} loop → ${hms(recipe.totalS)}`);
  let last = '';
  const out = await renderLongForm(recipe, {
    outDir,
    allowShortLoop: a.test,
    keepIntermediates: a.keep,
    onStage: (stage) => process.stdout.write(`\n  ${stage}`),
    onProgress: (stage, done, total) => {
      const pct = `${Math.floor((done / total) * 10) * 10}%`;
      if (pct !== last) process.stdout.write(` ${pct}`);
      last = pct;
    },
  });
  process.stdout.write('\n');
  const t = out.timings;
  console.log(
    `Timings: frames ${(t.framesMs / 1000).toFixed(1)}s, audio ${(t.audioMs / 1000).toFixed(1)}s, ` +
      `join+master+QC ${(t.masterMs / 1000).toFixed(1)}s, total ${(t.totalMs / 1000).toFixed(1)}s` +
      (out.resumedSegments ? ` (resumed ${out.resumedSegments} finished segments)` : ''),
  );
  const q = out.qc;
  console.log(
    `QC ${q.pass ? 'PASS' : 'FAIL'}: ${q.width}x${q.height} ${q.fps}fps ${q.videoCodec}/${q.audioCodec} ${hms(q.durationS)} ` +
      `${q.integratedLufs} LUFS, peak ${q.truePeakDb} dBFS, ≤${q.maxFlashesPerSecond} flashes/s, ` +
      `join step ${out.seam.seamStep.toFixed(2)} (frame step ${out.seam.referenceStep.toFixed(2)})` +
      (q.problems.length ? ' — ' + q.problems.join('; ') : ''),
  );
  console.log(`Output: ${relative(ROOT, out.final)}`);
  if (!q.pass) process.exitCode = 2;
}

async function main() {
  let recipe: Recipe = a.recipe
    ? await readRecipe(a.recipe)
    : a['recipe-json']
      ? JSON.parse(a['recipe-json'])
      : {
          templateId: a.template!,
          seed: Number(a.seed ?? 1),
          params: JSON.parse(a.params!),
          themeId: a.theme!,
          melodyId: a.melody!,
          copy: { ...(a.hook ? { hook: a.hook } : {}), ...(a.cta ? { cta: a.cta } : {}) },
        };
  if (a.target) recipe.targetS = Number(a.target);
  if (getTemplate(recipe.templateId).longForm) return longForm(recipe);

  if (a.search) {
    const targetS = recipe.targetS ?? 30;
    const t0 = performance.now();
    const results = searchSeeds(recipe, { count: Number(a.search), targetS, start: Number(a.seed ?? 0) });
    const best = results[0];
    console.log(
      `Searched ${a.search} seeds in ${((performance.now() - t0) / 1000).toFixed(1)}s → best #${best.seed} ` +
        `score ${(best.total * 100).toFixed(0)}, ${best.durationS.toFixed(1)}s (target ${targetS}s)`,
    );
    recipe = { ...recipe, seed: best.seed, targetS };
  }

  console.log(`Rendering ${recipe.templateId} seed ${recipe.seed} [${recipe.themeId}, ${recipe.melodyId}]`);
  let last = 0;
  const out = await renderRecipe(recipe, {
    outDir: a.out,
    onProgress: (f, est) => {
      const pct = Math.floor((f / est) * 100);
      if (pct >= last + 10) {
        last = pct - (pct % 10);
        process.stdout.write(`  ${last}%`);
      }
    },
  });
  process.stdout.write('\n');
  const t = out.timings;
  console.log(`Codec ${out.codec} · ${out.durationS.toFixed(2)}s · drama ${(out.score.total * 100).toFixed(0)}`);
  console.log(
    `Timings: frames ${(t.encodeMs / 1000).toFixed(1)}s, audio ${(t.audioMs / 1000).toFixed(1)}s, ` +
      `master+QC ${(t.masterMs / 1000).toFixed(1)}s, total ${(t.totalMs / 1000).toFixed(1)}s`,
  );
  const q = out.qc;
  console.log(
    `QC ${q.pass ? 'PASS' : 'FAIL'}: ${q.width}x${q.height} ${q.fps}fps ${q.videoCodec}/${q.audioCodec} ` +
      `${q.integratedLufs} LUFS, peak ${q.truePeakDb} dBFS${q.problems.length ? ' — ' + q.problems.join('; ') : ''}`,
  );
  console.log(`Output: ${relative(ROOT, out.final)}`);
  if (!q.pass) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
