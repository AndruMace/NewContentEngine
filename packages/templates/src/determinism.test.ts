import { describe, expect, it } from 'vitest';
import { Runner, getTheme, hashString } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { TEMPLATES } from './index';

const theme = getTheme('neon-dark');
const melody = getMelody('ode-to-joy');

/** Lighter settings for the heavy sims so the suite stays fast; determinism doesn't depend on size. */
const TEST_PARAMS: Record<string, Record<string, unknown>> = {
  'liquid-mix': { particles: 300, pourSeconds: 6, settleSeconds: 2 },
  'sand-pour': { fillSeconds: 10, cellSize: 8 },
};

function logHash(templateId: string, seed: number, visual: boolean) {
  const template = TEMPLATES.find((t) => t.id === templateId)!;
  const r = new Runner(template, { seed, theme, melody, visual, params: TEST_PARAMS[templateId], maxSeconds: 90 }).runToEnd();
  return { hash: hashString(JSON.stringify(r.events)), runner: r };
}

describe.each(TEMPLATES.map((t) => t.id))('%s', (id) => {
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
    expect(logHash(id, 5, false).runner.audio.length).toBeGreaterThan(5);
  });
});
