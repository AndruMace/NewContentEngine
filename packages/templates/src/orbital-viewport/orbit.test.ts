import { describe, expect, it } from 'vitest';
import { Runner, getTheme, loopLengthOf } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { TEMPLATES, isLongForm } from '../index';
import { orbitalViewport, type OrbitState } from './index';

const run = (loopS: number, params: Record<string, unknown> = {}, seed = 1) =>
  new Runner(orbitalViewport, { seed, params, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), visual: false, loopS }).runToEnd();

describe('orbital-viewport (long-form)', () => {
  it('renders 1920×1080 at 30 fps and ends exactly at the loop length', () => {
    const r = run(600);
    expect([r.width, r.height, r.fps]).toEqual([1920, 1080, 30]);
    expect(r.frame).toBe(600 * 30);
  });

  it('spaces shooting stars out inside the loop, and keeps console blips clear of its end', () => {
    for (const seed of [1, 2, 3]) {
      const r = run(1800, { shootingStarsPerHour: 60 }, seed);
      const s = r.state as OrbitState;
      expect(s.meteors.length).toBeGreaterThan(10);
      for (let i = 1; i < s.meteors.length; i++) expect(s.meteors[i].t - s.meteors[i - 1].t).toBeGreaterThanOrEqual(20);
      expect(s.meteors[0].t + 1800 - s.meteors[s.meteors.length - 1].t).toBeGreaterThanOrEqual(20);
      for (const e of r.events) expect(e.t).toBeLessThan(1800);
      const chirps = r.audio.filter((a) => a.kind === 'note');
      expect(chirps.length).toBeGreaterThan(5);
      for (const c of chirps) expect(c.t).toBeLessThan(1800 - 1.5);
    }
  });

  it('has no shooting stars when they are turned off, and shooting stars make no sound', () => {
    const r = run(600, { shootingStarsPerHour: 0 });
    expect(r.events.some((e) => e.type === 'meteor')).toBe(false);
    const withStars = run(1800, { shootingStarsPerHour: 60 });
    const meteorTimes = new Set(withStars.events.filter((e) => e.type === 'meteor').map((e) => e.t));
    expect(withStars.audio.some((a) => meteorTimes.has(a.t) && a.kind === 'sample')).toBe(false);
  });

  it('loops in whole 10-minute steps, which the 2-minute room-tone bed divides', () => {
    expect(loopLengthOf(orbitalViewport, 25 * 60)).toBe(30 * 60);
    expect(loopLengthOf(orbitalViewport, 7200)).toBe(3600);
    const beds = orbitalViewport.longForm!.beds!(orbitalViewport.schema.parse({}));
    expect(beds.map((b) => b.sound)).toEqual(['audio/ship-roomtone-120.opus']);
    for (const L of [1200, 1800, 2400, 3000, 3600]) expect(L % 120).toBe(0);
  });

  it('is a long-form template, kept out of the Shorts list', () => {
    expect(isLongForm('orbital-viewport')).toBe(true);
    expect(TEMPLATES.some((t) => t.id === 'orbital-viewport')).toBe(false);
  });
});
