import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme, hashString, paramsJsonSchema, searchBudgetOf } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { MODES, mathCuriosities } from './index';
import { collatzSequence } from './modes/collatz';
import { shapeName } from './modes/times-table';
import { GOLDEN } from './modes/phyllotaxis';
import { CHAOS } from './modes/chaos-game';
import { playGame } from './modes/monty-hall';
import { fillRoom, monthDay } from './modes/birthday';
import { canonicalTemplateId, findTemplate, getTemplate } from '../index';

const theme = getTheme('neon-dark');
const melody = getMelody('ode-to-joy');
const run = (params: Record<string, unknown>, seed = 4, visual = false) => new Runner(mathCuriosities, { seed, theme, melody, visual, params, maxSeconds: 90 }).runToEnd();
const hash = (r: Runner) => hashString(JSON.stringify(r.events));
const TIMED = MODES.filter((m) => m !== 'blocks');

describe.each(TIMED)('math curiosities: %s', (mode) => {
  it('is deterministic, and visual-only work does not change it', () => {
    expect(hash(run({ mode }, 42))).toBe(hash(run({ mode }, 42)));
    expect(hash(run({ mode }, 7, true))).toBe(hash(run({ mode }, 7, false)));
  });

  it('lands on its length and makes sound', () => {
    for (const durationS of [20, 32, 60]) {
      const r = run({ mode, durationS });
      expect(r.timedOut).toBe(false);
      expect(Math.abs(r.durationS - durationS)).toBeLessThan(durationS * 0.15);
      expect(r.audio.length).toBeGreaterThan(5);
      expect(r.events.some((e) => e.type === `${mode}:reveal`)).toBe(true);
      expect(r.score(durationS).total).toBeGreaterThan(0);
    }
  });

  it('routes its own events (all carry the mode)', () => {
    expect(run({ mode }).events.every((e) => e.type.startsWith(`${mode}:`))).toBe(true);
  });

  it('exposes a result for the CTA and its own default copy', () => {
    const r = run({ mode });
    expect(String(mathCuriosities.hud(r.state).result)).not.toBe('');
    const hook = r.overlays.find((o) => o.kind === 'hook') as { text: string };
    expect(hook.text).not.toBe(mathCuriosities.defaultCopy.hook);
    // Copy written for the video is kept as is.
    const own = new Runner(mathCuriosities, { seed: 1, theme, melody, visual: false, params: { mode }, copy: { hook: 'My hook' } });
    expect((own.overlays.find((o) => o.kind === 'hook') as { text: string }).text).toBe('My hook');
  });
});

describe('math curiosities: the maths', () => {
  it('collatz: 27 takes 111 steps and peaks at 9232', () => {
    const seq = collatzSequence(27);
    expect(seq.length - 1).toBe(111);
    expect(Math.max(...seq)).toBe(9232);
    const r = run({ mode: 'collatz', start: 27 });
    expect(r.events.find((e) => e.type === 'collatz:finish')).toMatchObject({ steps: 111, peak: 9232 });
  });

  it('collatz: a race finishes both numbers and names the winner', () => {
    const r = run({ mode: 'collatz', start: 26, compare: true });
    expect(r.events.filter((e) => e.type === 'collatz:finish').map((e) => e.steps)).toEqual([10, 111]);
    expect(mathCuriosities.hud(r.state).result).toBe('26 won by 101 steps');
  });

  it('times table: lines go from k to m·k (mod n), and the named shapes', () => {
    expect(shapeName(2, 200)).toBe('Cardioid');
    expect(shapeName(3, 200)).toBe('Nephroid');
    expect(shapeName(5, 200)).toBe('4 cusps');
    expect(shapeName(199, 200)).toBe('Mirror lines');
    const r = run({ mode: 'times-table', maxMultiplier: 6, durationS: 30 });
    expect(r.events.filter((e) => e.type === 'times-table:stop').map((e) => e.m)).toEqual([2, 3, 4, 5, 6]);
  });

  it('phyllotaxis: ends on the golden angle', () => {
    expect(GOLDEN * 360).toBeCloseTo(137.5078, 3);
    const r = run({ mode: 'phyllotaxis' });
    expect((r.state as any).inner.a).toBeCloseTo(GOLDEN, 12);
    expect(r.events.filter((e) => e.type === 'phyllotaxis:spirals').map((e) => e.count)).toEqual([21, 34]);
  });

  it('chaos game: every rule keeps its dots inside the shape', () => {
    for (const rule of Object.keys(CHAOS)) {
      const r = run({ mode: 'chaos-game', rule, dots: 20000 });
      const s = (r.state as any).inner;
      expect(s.count).toBe(20000);
      const xs: number[] = s.tx;
      const ys: number[] = s.ty;
      expect(s.minX).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-6);
      expect(s.maxX).toBeLessThanOrEqual(Math.max(...xs) + 1e-6);
      expect(s.minY).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-6);
      expect(s.maxY).toBeLessThanOrEqual(Math.max(...ys) + 1e-6);
    }
  });

  it('monty hall: staying wins 1/n of the time, switching (n−1)/n', () => {
    for (const n of [3, 5, 10]) {
      const rng = new Rng(9);
      let stay = 0;
      let swap = 0;
      const N = 20000;
      for (let i = 0; i < N; i++) {
        const g = playGame(n, rng);
        expect(g.opened).toHaveLength(n - 2);
        expect(g.opened).not.toContain(g.car);
        expect(g.other).not.toBe(g.pick);
        if (g.pick === g.car) stay++;
        if (g.other === g.car) swap++;
      }
      expect(stay / N).toBeCloseTo(1 / n, 1);
      expect(Math.abs(swap / N - (n - 1) / n)).toBeLessThan(0.02);
    }
  });

  it('birthday: no shared day before the match, and months map right', () => {
    const rng = new Rng(3);
    for (let k = 0; k < 200; k++) {
      const room = fillRoom(rng);
      expect(room.length).toBeGreaterThanOrEqual(2);
      const before = room.slice(0, -1);
      expect(new Set(before).size).toBe(before.length);
      expect(before).toContain(room[room.length - 1]);
    }
    expect(monthDay(0)).toEqual([0, 0]);
    expect(monthDay(31)).toEqual([1, 0]);
    expect(monthDay(364)).toEqual([11, 30]);
  });
});

describe('math curiosities: settings and the rename', () => {
  it('replaces Colliding Blocks under its old id', () => {
    expect(canonicalTemplateId('colliding-blocks')).toBe('math-curiosities');
    expect(getTemplate('colliding-blocks')).toBe(mathCuriosities);
    expect(findTemplate('colliding-blocks')).toBe(mathCuriosities);
  });

  it('tags mode-only settings and sizes the seed search per mode', () => {
    const props = paramsJsonSchema(mathCuriosities).properties as Record<string, any>;
    expect(props.digits.modes).toEqual(['blocks']);
    expect(props.dots.modes).toEqual(['chaos-game']);
    expect(props.mode.modes).toBeUndefined();
    expect(searchBudgetOf(mathCuriosities, {})).toBe(4);
    expect(searchBudgetOf(mathCuriosities, { mode: 'monty-hall' })).toBe(60);
  });
});
