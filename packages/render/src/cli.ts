/**
 * Render a video from the command line.
 *
 *   npm run render -- --template ring-escape --seed 42
 *   npm run render -- --template ring-escape --search 500 --target 30 --theme mono-gold --melody fur-elise
 *   npm run render -- --recipe path/to/recipe.json
 *   npm run render -- --recipe-json '{"templateId":"ring-escape",...}'
 */
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import type { Recipe } from '@sim/engine';
import { ROOT, readRecipe, renderRecipe, searchSeeds } from './index';

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
  },
});

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
