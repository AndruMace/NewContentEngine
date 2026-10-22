import { describe, expect, it } from 'vitest';
import { chooseArms, flatArmModel } from '@sim/planner';
import { Rng } from '@sim/engine';
import { maxFlashesPerSecond } from './ffmpeg';

describe('flash counting (photosensitivity QC)', () => {
  const fps = 30;
  const flat = (n: number, y = 20) => Array.from({ length: n }, () => y);

  it('counts sharp brightness rises, not slow changes', () => {
    const slow = Array.from({ length: 300 }, (_, i) => 20 + i * 0.5);
    expect(maxFlashesPerSecond(slow, fps)).toBe(0);
    const one = [...flat(30), 90, 70, 40, ...flat(30)];
    expect(maxFlashesPerSecond(one, fps)).toBe(1);
  });

  it('finds the busiest second', () => {
    const pulse = [90, 40, 20, 20, 20, 20];
    const four = [...flat(10), ...pulse, ...pulse, ...pulse, ...pulse, ...flat(60)];
    expect(maxFlashesPerSecond(four, fps)).toBe(4);
    const spread = [...flat(10), ...pulse, ...flat(40), ...pulse, ...flat(40), ...pulse, ...flat(10)];
    expect(maxFlashesPerSecond(spread, fps)).toBe(1);
  });
});

describe('long-form templates stay out of Shorts planning', () => {
  it('are never chosen for a batch, even when named', () => {
    const settings = { count: 6, templateIds: ['cabin-storm'], themeIds: [], minLengthS: 20, maxLengthS: 45 };
    const arms = chooseArms(settings, flatArmModel, new Rng(1));
    expect(arms.length).toBeGreaterThan(0);
    expect(arms.some((a) => a.arm.templateId === 'cabin-storm')).toBe(false);
  });
});
