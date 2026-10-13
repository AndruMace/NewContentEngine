import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from './index';

describe('engagement cues', () => {
  const run = (templateId: string, nudge?: string) =>
    new Runner(getTemplate(templateId), { seed: 1, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), copy: nudge ? { nudge } : {}, visual: false });

  it('adds the comment prompt after the hook and a heart at the payoff, only when asked', () => {
    const plain = run('ring-escape');
    expect(plain.overlays.some((o) => o.kind === 'nudge' || o.kind === 'heart')).toBe(false);
    const cued = run('ring-escape', 'Guess the bounce count 👇');
    const hook = cued.overlays.find((o) => o.kind === 'hook') as { to: number; y: number };
    const nudge = cued.overlays.find((o) => o.kind === 'nudge') as { from: number; to: number; y: number; text: string };
    expect(nudge.text).toBe('Guess the bounce count 👇');
    expect(nudge.from).toBeGreaterThan(hook.to);
    expect(nudge.y).toBe(Math.min(hook.y, 0.125));
    expect(cued.overlays.some((o) => o.kind === 'heart')).toBe(true);
  });

  it('keeps the prompt clear of a hook that stays up (Fourier) and times the heart to a scheduled CTA (Polyrhythm)', () => {
    const fourier = run('fourier-drawing', 'Know it yet? 👇');
    expect((fourier.overlays.find((o) => o.kind === 'nudge') as { y: number }).y).toBe(getTemplate('fourier-drawing').nudgeY);
    const poly = run('polyrhythm', 'Rate this rhythm 👇');
    expect((poly.overlays.find((o) => o.kind === 'heart') as { when: unknown }).when).toHaveProperty('at');
  });

  it('does not change the simulation', () => {
    const a = run('ring-escape').runToEnd();
    const b = run('ring-escape', 'Guess the bounce count 👇').runToEnd();
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
  });
});
