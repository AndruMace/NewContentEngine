/** Melody variety: candidates in a batch get different melodies (no learning involved). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { fallbackConcept } from '@sim/planner';

process.env.SIM_DATA_DIR = mkdtempSync(join(tmpdir(), 'sim-melody-'));

let db: typeof import('./db');
let batch: typeof import('./batch');

beforeAll(async () => {
  db = await import('./db');
  batch = await import('./batch');
});

describe('melody variety', () => {
  it('never repeats a melody within a batch until every melody is used', () => {
    const b = db.insertBatch({ status: 'planning', settings: { ...db.DEFAULT_BATCH_SETTINGS, melodyIds: [] } as any, target: 40 });
    const used: string[] = [];
    for (let i = 0; i < batch.ALL_MELODY_IDS.length; i++) {
      const concept = fallbackConcept({ templateId: i % 2 ? 'ring-escape' : 'marble-race', themeId: 'sunset', lengthBucket: 'medium', hookStyle: 'question' }, 30, new Rng(i));
      concept.melodyId = batch.chooseMelody(b.id, concept.templateId, new Rng(100 + i));
      db.insertConcept(b.id, i, concept);
      used.push(concept.melodyId);
    }
    expect(new Set(used).size).toBe(batch.ALL_MELODY_IDS.length);
  });

  it('honours the batch melody filter and skips templates that make their own notes', () => {
    const b = db.insertBatch({ status: 'planning', settings: { ...db.DEFAULT_BATCH_SETTINGS, melodyIds: ['ode-to-joy', 'fur-elise'] } as any, target: 4 });
    const own = fallbackConcept({ templateId: 'polyrhythm', themeId: 'sunset', lengthBucket: 'medium', hookStyle: 'question' }, 30, new Rng(1));
    own.melodyId = batch.chooseMelody(b.id, 'polyrhythm', new Rng(1));
    db.insertConcept(b.id, 0, own);
    const picks = [0, 1].map((i) => {
      const c = fallbackConcept({ templateId: 'ring-escape', themeId: 'sunset', lengthBucket: 'medium', hookStyle: 'question' }, 30, new Rng(i));
      c.melodyId = batch.chooseMelody(b.id, 'ring-escape', new Rng(10 + i));
      db.insertConcept(b.id, i + 1, c);
      return c.melodyId;
    });
    expect(picks.sort()).toEqual(['fur-elise', 'ode-to-joy']);
  });

  it('re-rolls just the melody: same run and copy, a melody not used elsewhere in the batch', async () => {
    const { ReviewActions } = await import('./review');
    const review = new ReviewActions({ notify() {} } as any, null as any, null as any);
    const b = db.insertBatch({ status: 'done', settings: { ...db.DEFAULT_BATCH_SETTINGS, melodyIds: [] } as any, target: 2 });
    const concept = fallbackConcept({ templateId: 'ring-escape', themeId: 'sunset', lengthBucket: 'medium', hookStyle: 'question' }, 30, new Rng(5));
    concept.melodyId = 'ode-to-joy';
    const c = db.insertConcept(b.id, 0, concept);
    const r = db.insertRender({ batchId: b.id, conceptId: c.id, kind: 'batch', recipe: batch.recipeFor(concept, 77), copy: concept.copy, score: 0.8, scoreParts: null, altSeeds: [], rankScore: 0.8 });
    const next = await review.rerollMelody(r.id);
    expect(next.recipe.melodyId).not.toBe('ode-to-joy');
    expect(next.recipe.seed).toBe(77);
    expect(next.recipe.params).toEqual(r.recipe.params);
    expect(db.getRender(r.id)!.supersededBy).toBe(next.id);
    await expect(review.rerollMelody(db.insertRender({ batchId: b.id, conceptId: null, kind: 'batch', recipe: { ...batch.recipeFor(concept, 1), templateId: 'polyrhythm' }, copy: null, score: null, scoreParts: null, altSeeds: [], rankScore: null }).id)).rejects.toThrow(/own notes/);
  });
});
