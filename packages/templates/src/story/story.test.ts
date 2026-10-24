import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Runner, getTheme, type NarrationLine, type Template, type VoiceTrack } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { Script, newDirector, runDirector, sayEvents, storyAudio, storyNarration, storyParams, type BeatSpec, type Director } from '.';

/** A toy sim: a counter, with a switch the script flips. */
interface Sim {
  n: number;
  on: boolean;
  flippedAt: number;
}
interface State {
  sim: Sim;
  dir: Director<Sim>;
}

const intro: BeatSpec = { id: 'intro', about: 'start', maxWords: 8, fallback: ['We start at {n}.'], required: ['n'] };
const rules: BeatSpec = {
  id: 'rules',
  about: 'two things happen',
  maxWords: 12,
  parts: [
    { about: 'first', maxWords: 6 },
    { about: 'switch on', maxWords: 6 },
  ],
  fallback: ['First this. | Then the switch.'],
};
const end: BeatSpec = { id: 'end', about: 'the end', maxWords: 6, fallback: ['It reached {n}.'], required: ['n'] };

const schema = z.object({ ...storyParams() });
const toy: Template<z.infer<typeof schema>, State> = {
  id: 'toy-story',
  name: 'Toy',
  family: 'kinetic',
  category: 'brainy',
  description: 'test',
  schema,
  substeps: 2,
  defaultCopy: { hook: '', cta: '' },
  narration: storyNarration('plain'),
  init(ctx) {
    const s = new Script<Sim>()
      .say(intro, { facts: (sim) => ({ n: sim.n }) })
      .play(900, 60, { elastic: true })
      .say(rules, {
        ticks: [10, 20],
        acts: [
          null,
          (sim) => {
            sim.on = true;
            sim.flippedAt = sim.n;
          },
        ],
      })
      .until((sim) => sim.n >= 1200, { tps: 90, maxTicks: 2000, estTicks: 250 })
      .say(end, { facts: (sim) => ({ n: sim.n }) })
      .hold(1.5);
    return { sim: { n: 0, on: false, flippedAt: -1 }, dir: newDirector(s, { substeps: 2, targetS: ctx.params.targetS, narration: ctx.narration }) };
  },
  step(s, { emit }) {
    runDirector(s.dir, s.sim, emit, (sim) => {
      sim.n++;
    });
  },
  isDone: (s) => s.dir.done,
  hud: () => ({}),
  overlays: () => [],
  render() {},
  audio: (e) => storyAudio(e) ?? [{ kind: 'sfx', name: 'tick', vel: 0.1 }],
  score: () => ({ total: 1, parts: {} }),
};

/** Fake voicing: every line `len` seconds long (passages split evenly). */
function voice(lens: Record<string, number>): VoiceTrack {
  const line = (beat: string, len: number, parts?: number): NarrationLine => ({
    beat,
    text: beat,
    caption: beat,
    clip: `${beat}.wav`,
    durationS: len,
    ...(parts ? { parts: Array.from({ length: parts }, (_, k) => ({ text: `p${k}`, caption: `p${k}`, at: (k * len) / parts, durationS: len / parts - 0.12 })) } : {}),
  });
  return { provider: 'fake', voiceId: 'v', factsHash: 'x', writer: 'fallback', lines: [line('intro', lens.intro), line('rules', lens.rules, 2), line('end', lens.end)] };
}

const run = (params: Record<string, unknown>, v?: VoiceTrack) =>
  new Runner(toy, { seed: 1, params, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), visual: false, voice: v }).runToEnd();

describe('story director', () => {
  it('keeps every act and fact at the same tick however long the lines run', () => {
    const short = run({}, voice({ intro: 1, rules: 1.5, end: 1 }));
    const long = run({}, voice({ intro: 4, rules: 6, end: 4 }));
    const silent = run({ narration: 'off' });
    for (const r of [short, long, silent]) expect(r.state.sim.flippedAt).toBe(900 + 10);
    expect(sayEvents(short.events)).toEqual(sayEvents(long.events));
    expect(sayEvents(short.events)).toEqual(sayEvents(silent.events));
    expect(sayEvents(short.events).map((b) => b.facts.n)).toEqual([0, undefined, 1200]);
  });

  it('never overlaps lines, and plays every one in full', () => {
    const r = run({}, voice({ intro: 3, rules: 5, end: 3 }));
    const says = r.audio.filter((a) => a.kind === 'voice');
    expect(says).toHaveLength(3);
    const len: Record<string, number> = { 'intro.wav': 3, 'rules.wav': 5, 'end.wav': 3 };
    for (let k = 1; k < says.length; k++) {
      const prev = says[k - 1];
      if (prev.kind === 'voice') expect(says[k].t).toBeGreaterThanOrEqual(prev.t + len[prev.clip]);
    }
    expect(r.durationS).toBeGreaterThan(says[2].t + 3);
  });

  it('stretches the elastic part to land near the target, and runs long rather than cut a line', () => {
    for (const targetS of [22, 34]) {
      const r = run({ targetS }, voice({ intro: 1.5, rules: 2, end: 1.5 }));
      expect(Math.abs(r.durationS - targetS) / targetS).toBeLessThan(0.15);
    }
    const crowded = run({ targetS: 20 }, voice({ intro: 8, rules: 10, end: 8 }));
    expect(crowded.durationS).toBeGreaterThan(26);
    expect(crowded.timedOut).toBe(false);
  });

  it('gives the writer every beat with its parts, and only voiced lines make a sound', () => {
    const beats = storyNarration('s').beats({} as never, run({}).events);
    expect(beats.map((b) => b.id)).toEqual(['intro', 'rules', 'end']);
    expect(beats[1].parts).toHaveLength(2);
    expect(run({}).audio.some((a) => a.kind === 'voice')).toBe(false);
  });
});
