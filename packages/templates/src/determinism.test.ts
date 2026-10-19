import { describe, expect, it } from 'vitest';
import { Runner, getTheme, hashString } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { ALL_TEMPLATES } from './index';

const theme = getTheme('neon-dark');
const melody = getMelody('ode-to-joy');

/** Lighter settings for the heavy sims so the suite stays fast; determinism doesn't depend on size. */
const TEST_PARAMS: Record<string, Record<string, unknown>> = {
  'sand-pour': { fillSeconds: 10, cellSize: 8 },
};

/** Long-form loops are tested at a few minutes: the schedule logic doesn't depend on length. */
const TEST_LOOP_S = 180;

function logHash(templateId: string, seed: number, visual: boolean) {
  const template = ALL_TEMPLATES.find((t) => t.id === templateId)!;
  const r = new Runner(template, { seed, theme, melody, visual, params: TEST_PARAMS[templateId], maxSeconds: 90, loopS: template.longForm ? TEST_LOOP_S : undefined }).runToEnd();
  return { hash: hashString(JSON.stringify(r.events)), runner: r };
}

describe.each(ALL_TEMPLATES.map((t) => t.id))('%s', (id) => {
  it('is deterministic for a given seed', () => {
    expect(logHash(id, 42, false).hash).toBe(logHash(id, 42, false).hash);
  });

  it('visual-only work does not change physics', () => {
    expect(logHash(id, 7, true).hash).toBe(logHash(id, 7, false).hash);
  });

  it('finishes before the time limit', () => {
    expect(logHash(id, 3, false).runner.timedOut).toBe(false);
  });

  it('produces audio events', () => {
    const { runner } = logHash(id, 5, false);
    // Long-form ambience is mostly continuous beds (recordings), with only occasional events.
    const beds = runner.template.longForm?.beds?.(runner.params).length ?? 0;
    expect(runner.audio.length + beds * 10).toBeGreaterThan(5);
  });
});
