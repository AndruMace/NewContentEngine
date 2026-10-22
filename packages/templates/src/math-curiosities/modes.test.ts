import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme, hashString, paramsJsonSchema, searchBudgetOf, type VoiceTrack } from '@sim/engine';
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

describe('math curiosities: narration', () => {
  /** A voice track with given line lengths for every beat the template asks for. */
  function voiceFor(params: Record<string, unknown>, seconds: number): VoiceTrack {
    const p = mathCuriosities.schema.parse(params);
    const events = run(params).events;
    const beats = mathCuriosities.narration!.beats(p, events);
    return {
      provider: 'test',
      voiceId: 'v',
      factsHash: 'x',
      writer: 'fallback',
      lines: beats.map((b) => ({ beat: b.id, text: b.id, caption: `${b.id} line`, clip: `${b.id}.wav`, durationS: seconds })),
    };
  }
  const runVoiced = (params: Record<string, unknown>, voice?: VoiceTrack, seed = 4, visual = false) =>
    new Runner(mathCuriosities, { seed, theme, melody, visual, params, voice, maxSeconds: 90 }).runToEnd();

  it('leaves narrated modes unchanged with narration off, and only voices collatz and times-table', () => {
    for (const mode of TIMED) {
      expect(hash(run({ mode, narration: 'off' }))).toBe(hash(run({ mode })));
      expect(mathCuriosities.narration!.enabled(mathCuriosities.schema.parse({ mode, narration: 'on' }))).toBe(mode === 'collatz' || mode === 'times-table');
    }
  });

  it('lays out beats with this run’s facts', () => {
    const collatz = { mode: 'collatz', narration: 'on', start: 27 };
    const beats = mathCuriosities.narration!.beats(mathCuriosities.schema.parse(collatz), run(collatz).events);
    expect(beats.map((b) => b.id)).toEqual(['intro', 'step1', 'repeat', 'reveal']);
    expect(beats[0].facts).toEqual({ n: 27 });
    expect(beats[1].facts).toEqual({ prev: 27, value: 82 });
    expect(beats[3].facts).toEqual({ steps: 111, peak: 9232 });
    const long = { ...collatz, durationS: 40 };
    expect(mathCuriosities.narration!.beats(mathCuriosities.schema.parse(long), run(long).events).map((b) => b.id)).toContain('step2');
    const tt = { mode: 'times-table', narration: 'on' };
    const ttBeats = mathCuriosities.narration!.beats(mathCuriosities.schema.parse(tt), run(tt).events);
    expect(ttBeats.map((b) => b.id)).toEqual(['intro', 'demo0', 'demo1', 'wrap', 'fill', 'sweep', 'reveal']);
    expect(ttBeats.find((b) => b.id === 'wrap')!.facts).toEqual({ k: 130, product: 260, last: 199, landed: 60 });
  });

  it.each(['collatz', 'times-table'])('%s waits for every line, speaks it once, and still ends on time', (mode) => {
    const params = { mode, narration: 'on', durationS: 40 };
    for (const seconds of [1, 3.5]) {
      const voice = voiceFor(params, seconds);
      const r = runVoiced(params, voice);
      expect(r.timedOut).toBe(false);
      expect(Math.abs(r.durationS - 40)).toBeLessThan(0.05);
      const says = r.events.filter((e) => e.type === `${mode}:say`);
      expect(says.map((e) => e.beat)).toEqual(voice.lines.map((l) => l.beat));
      // Lines never overlap: each starts after the one before has finished.
      for (let i = 1; i < says.length; i++) expect(says[i].t).toBeGreaterThanOrEqual(says[i - 1].t + seconds - 1e-9);
      expect(r.audio.filter((a) => a.kind === 'voice')).toHaveLength(voice.lines.length);
      expect(hash(runVoiced(params, voice, 4, true))).toBe(hash(r));
    }
  });

  it('runs silently on estimated timing before the lines are voiced', () => {
    const r = runVoiced({ mode: 'collatz', narration: 'on' });
    expect(r.events.some((e) => e.type === 'collatz:say')).toBe(false);
    expect(r.timedOut).toBe(false);
  });
});
