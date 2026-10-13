/**
 * Taste model against a throwaway database: Review decisions (with reasons) and Playground exports
 * → labels → fit → settings choice and template ranking.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import type { Arm } from '@sim/planner';

process.env.SIM_DATA_DIR = mkdtempSync(join(tmpdir(), 'sim-taste-'));

let db: typeof import('./db');
let taste: typeof import('./taste');
const DAY = 86_400_000;

const arm = (templateId: string): Arm => ({ templateId, themeId: 'sunset', lengthBucket: 'medium', hookStyle: 'question' });

function addRender(batchId: string | null, kind: 'batch' | 'export', templateId: string, params: Record<string, unknown>, decision: 'approved' | 'rejected' | 'pending', reasons: string[] = [], seed = 1) {
  const r = db.insertRender({
    batchId,
    conceptId: null,
    kind,
    recipe: { templateId, themeId: 'sunset', melodyId: 'ode-to-joy', seed, params, targetS: 30 } as any,
    copy: null,
    score: 0.7,
    scoreParts: null,
    altSeeds: [],
    rankScore: 0.7,
  });
  db.updateRender(r.id, { status: 'ready', durationS: 30, decision, reasons });
  return r.id;
}

beforeAll(async () => {
  db = await import('./db');
  taste = await import('./taste');
  const b = db.insertBatch({ status: 'done', settings: {} as any, target: 20 });
  db.updateBatch(b.id, { finishedAt: Date.now() - 2 * DAY });
  // Batch polyrhythms with high roots and few voices: rejected for their sound.
  for (let i = 0; i < 6; i++) addRender(b.id, 'batch', 'polyrhythm', { style: 'piano', rootNote: 57 + (i % 3), count: 12 + (i % 2) * 2, pattern: 'primes', scale: 'pentatonic' }, 'rejected', ['sound'], i);
  // Hand-tuned polyrhythms from the Playground: low roots, many voices.
  for (let i = 0; i < 4; i++) addRender(null, 'export', 'polyrhythm', { style: 'piano', rootNote: 40 + i * 2, count: 28 + i, pattern: 'mirror', scale: 'major' }, 'pending', [], i);
  // Marble races: rejected at their defaults.
  for (let i = 0; i < 5; i++) addRender(b.id, 'batch', 'marble-race', {}, 'rejected', ['boring'], i);
  // Ring escapes: approved, and one rejected only because of a bug (not taste).
  for (let i = 0; i < 6; i++) addRender(b.id, 'batch', 'ring-escape', {}, 'approved', [], i);
  addRender(b.id, 'batch', 'ring-escape', {}, 'rejected', ['glitch'], 99);
  // Left undecided in a reviewed batch: a mild no.
  for (let i = 0; i < 2; i++) addRender(b.id, 'batch', 'sorting-race', {}, 'pending', [], i);
});

describe('taste model', () => {
  it('labels decisions, Playground exports and passed-over candidates', () => {
    const counts: Record<string, number> = {};
    for (const e of taste.examples()) counts[e.label] = (counts[e.label] ?? 0) + 1;
    expect(counts).toEqual({ rejected: 11, exported: 4, approved: 6, skipped: 2 });
    expect(taste.tasteModel().ready).toBe(true);
  });

  it('picks settings like the ones you liked, not the ones you rejected', () => {
    let good = 0;
    for (let i = 0; i < 12; i++) {
      const { params } = taste.chooseParams(arm('polyrhythm'), 30, { style: 'piano' }, new Rng(40 + i));
      if ((params.rootNote as number) < 50 && (params.count as number) > 20) good++;
      expect(params.loopSeconds).toBe(30); // length comes from the target, not taste
    }
    expect(good).toBeGreaterThanOrEqual(10);
  });

  it('judges a template by its best settings: rejected batch settings don\'t sink a template you made work', () => {
    const fit = (params: Record<string, unknown>) => taste.tastePredict({ arm: arm('polyrhythm'), params })!.chance;
    expect(fit({ style: 'piano', rootNote: 42, count: 30, pattern: 'mirror', scale: 'major' })).toBeGreaterThan(fit({ style: 'piano', rootNote: 58, count: 12, pattern: 'primes', scale: 'pentatonic' }) + 0.2);
    const model = taste.tasteArmPlanningModel()!;
    expect(model.mean(arm('polyrhythm'))).toBeGreaterThan(model.mean(arm('marble-race')));
  });

  it('reports per-template reasons and learned settings', () => {
    const s = taste.tasteStatus();
    const poly = s.templates.find((t) => t.id === 'polyrhythm')!;
    expect(poly.reasons).toEqual({ sound: 6 });
    expect(poly.settings.length).toBeGreaterThan(0);
  });
});
