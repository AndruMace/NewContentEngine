import { describe, expect, it } from 'vitest';
import { Runner, getTheme, loopLengthOf } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { ALL_TEMPLATES, TEMPLATES, isLongForm } from '../index';
import { cabinStorm, type CabinState } from './index';

const run = (loopS: number, params: Record<string, unknown> = {}, seed = 1) =>
  new Runner(cabinStorm, { seed, params, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), visual: false, loopS }).runToEnd();

describe('cabin-storm (long-form)', () => {
  it('renders 1920×1080 at 30 fps and ends exactly at the loop length', () => {
    const r = run(120);
    expect([r.width, r.height, r.fps]).toEqual([1920, 1080, 30]);
    expect(r.frame).toBe(120 * 30);
    expect(r.timedOut).toBe(false);
  });

  it('keeps every cue inside the loop, with lightning spaced out across the wrap too', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = run(600, { lightningPerHour: 120 }, seed);
      const s = r.state as CabinState;
      for (const e of r.events) expect(e.t).toBeLessThan(600);
      const times = s.strikes.map((x) => x.t);
      expect(times.length).toBeGreaterThan(3);
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(12);
      expect(times[0] + 600 - times[times.length - 1]).toBeGreaterThanOrEqual(12);
      // Every strike gets its thunder, even when the delay runs past the end of the loop.
      expect(r.events.filter((e) => e.type === 'thunder').length).toBe(times.length);
      // At most two pulses per flash and 12 s between strikes: never more than 2 flashes a second.
      for (const st of s.strikes) expect(st.pulses.length).toBeLessThanOrEqual(2);
    }
  });

  it('has no lightning when it is turned off', () => {
    expect(run(300, { lightningPerHour: 0 }).events.some((e) => e.type === 'lightning')).toBe(false);
  });

  it('clamps loop lengths to 20–60 minutes unless a short test loop is allowed', () => {
    expect(loopLengthOf(cabinStorm)).toBe(1800);
    expect(loopLengthOf(cabinStorm, 600)).toBe(1200);
    expect(loopLengthOf(cabinStorm, 7200)).toBe(3600);
    expect(loopLengthOf(cabinStorm, 60, true)).toBe(60);
  });

  it('is kept out of the Shorts template list', () => {
    expect(TEMPLATES.some((t) => t.id === 'cabin-storm')).toBe(false);
    expect(ALL_TEMPLATES.some((t) => t.id === 'cabin-storm')).toBe(true);
    expect(isLongForm('cabin-storm')).toBe(true);
    expect(isLongForm('ring-escape')).toBe(false);
  });
});
