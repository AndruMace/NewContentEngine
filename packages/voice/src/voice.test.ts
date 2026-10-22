import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { NarrationBeat, Recipe } from '@sim/engine';
import { numberForScreen, numberToWords } from './numbers';
import { checkLine, claudeLines, fallbackLines, fillLine, wordCount, writeLines } from './writer';
import type { TtsProvider } from './provider';

const beat: NarrationBeat = {
  id: 'step1',
  about: '{prev} is odd',
  facts: { prev: 703, value: 2110 },
  required: ['prev', 'value'],
  maxWords: 18,
  fallback: ['{prev} is odd, so triple it and add one: {value}.', 'Odd? Times three, plus one: {value}.'],
};

describe('number words', () => {
  it('spells numbers the way a narrator says them', () => {
    expect(numberToWords(0)).toBe('zero');
    expect(numberToWords(13)).toBe('thirteen');
    expect(numberToWords(42)).toBe('forty-two');
    expect(numberToWords(703)).toBe('seven hundred three');
    expect(numberToWords(2110)).toBe('two thousand one hundred ten');
    expect(numberToWords(250504)).toBe('two hundred fifty thousand five hundred four');
    expect(numberToWords(1_000_000)).toBe('one million');
    expect(numberForScreen(250504)).toBe('250,504');
  });
});

describe('line checks', () => {
  it('counts placeholders as the words they take to say', () => {
    expect(wordCount('{prev} is odd', beat.facts)).toBe(5);
    expect(wordCount('{prev} is odd')).toBe(3);
  });

  it('rejects unknown or missing placeholders, digits, symbols and long lines', () => {
    expect(checkLine(beat, beat.fallback[0])).toBeNull();
    expect(checkLine(beat, '{prev} becomes {next}')).toMatch(/unknown placeholder/);
    expect(checkLine(beat, '{prev} is odd')).toMatch(/must use \{value\}/);
    expect(checkLine(beat, '{prev} times 3 plus 1 is {value}')).toMatch(/only as placeholders/);
    expect(checkLine(beat, '{prev} × three + one = {value}')).toMatch(/maths symbols/);
    expect(checkLine(beat, '{prev} is an odd number, so we multiply it by three and then add one, giving {value}')).toMatch(/words spoken/);
  });

  it('fills placeholders with words for the voice and digits for the screen', () => {
    expect(fillLine(beat, beat.fallback[0])).toEqual({
      text: 'seven hundred three is odd, so triple it and add one: two thousand one hundred ten.',
      caption: '703 is odd, so triple it and add one: 2,110.',
    });
  });

  it('picks built-in lines per seed, only ones that fit', () => {
    expect(fallbackLines([beat], 5)).toEqual(fallbackLines([beat], 5));
    const tight = { ...beat, maxWords: 10 };
    for (let seed = 0; seed < 20; seed++) expect(fallbackLines([tight], seed).step1).toBe(beat.fallback[1]);
  });
});

/** A stand-in client returning canned answers in turn (and recording the prompts). */
function mockClient(answers: (string | 'refusal')[]) {
  const prompts: string[] = [];
  const create = vi.fn(async (req: { messages: { content: string }[] }) => {
    prompts.push(req.messages[0].content);
    const a = answers.shift() ?? 'refusal';
    return a === 'refusal'
      ? { stop_reason: 'refusal', content: [] }
      : { stop_reason: 'end_turn', content: [{ type: 'text', text: a }] };
  });
  return { client: { messages: { create } } as never, prompts, create };
}

const answer = (lines: Record<string, string>) => JSON.stringify({ lines: Object.entries(lines).map(([b, line]) => ({ beat: b, line })) });

describe('Claude line writer', () => {
  const intro: NarrationBeat = { id: 'intro', about: 'start', facts: { n: 703 }, required: ['n'], maxWords: 10, fallback: ['Start with {n}.'] };

  it('retries with the problem spelled out, keeping lines that already passed', async () => {
    const m = mockClient([answer({ intro: "Let's take {n}.", step1: '{prev} goes to {next}' }), answer({ intro: 'ignored', step1: '{prev} is odd, so: {value}.' })]);
    const out = await claudeLines(m.client, [intro, beat], 'style');
    expect(out.missing).toEqual([]);
    expect(out.lines).toEqual({ intro: "Let's take {n}.", step1: '{prev} is odd, so: {value}.' });
    expect(m.prompts[1]).toMatch(/unknown placeholder \{next\}/);
  });

  it('falls back beat by beat when Claude never gets one right, and entirely on refusal', async () => {
    const bad = answer({ intro: 'Take {n}.', step1: 'no numbers here at all' });
    const partial = await writeLines([intro, beat], { style: 's', seed: 1, useClaude: true, client: mockClient([bad, bad, bad]).client });
    expect(partial.writer).toBe('claude');
    expect(partial.lines.intro).toBe('Take {n}.');
    expect(beat.fallback).toContain(partial.lines.step1);
    expect(partial.warning).toMatch(/step1/);
    const refused = await writeLines([intro, beat], { style: 's', seed: 1, useClaude: true, client: mockClient(['refusal']).client });
    expect(refused.writer).toBe('fallback');
  });

  it('uses the built-in lines without asking Claude when told not to', async () => {
    const m = mockClient([]);
    const out = await writeLines([intro, beat], { style: 's', seed: 1, useClaude: false, client: m.client });
    expect(out.writer).toBe('fallback');
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe('prepareNarration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-cache-'));
  vi.stubEnv('SIM_VOICE_CACHE', dir);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A provider that "speaks" 0.06 s of tone per character, so lengths are predictable. */
  const fake: TtsProvider = {
    id: 'fake',
    voices: ['v'],
    synthesize: async (text) => {
      const sr = 24000;
      const samples = new Float32Array(Math.round(text.length * 0.06 * sr)).map((_, i) => 0.3 * Math.sin(i / 8));
      return { samples, sampleRate: sr };
    },
  };
  const recipe: Recipe = { templateId: 'math-curiosities', seed: 2, params: { mode: 'collatz', narration: 'on' }, themeId: 'neon-dark', melodyId: 'ode-to-joy' };

  it('writes, voices and times every beat, and reuses them for the same facts', async () => {
    const { prepareNarration } = await import('./prepare');
    const out = await prepareNarration(recipe, { useClaude: false, provider: fake });
    const voice = out.voice!;
    expect(voice.lines.map((l) => l.beat)).toEqual(['intro', 'step1', 'repeat', 'reveal']);
    for (const l of voice.lines) {
      expect(l.text).not.toMatch(/\d/);
      expect(l.durationS).toBeGreaterThan(0.5);
    }
    expect(voice.lines[0].caption).toMatch(/703/);
    const again = await prepareNarration(out, { useClaude: false, provider: fake });
    expect(again).toBe(out);
    const other = await prepareNarration({ ...out, seed: 3 }, { useClaude: false, provider: fake });
    expect(other.voice!.factsHash).not.toBe(voice.factsHash);
  });

  it('leaves recipes without narration alone', async () => {
    const { prepareNarration } = await import('./prepare');
    const off = { ...recipe, params: { mode: 'collatz' } };
    expect(await prepareNarration(off, { provider: fake })).toBe(off);
  });
});

describe('pruneVoiceCache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-prune-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps referenced and recent clips, deletes old unreferenced ones', async () => {
    vi.stubEnv('SIM_VOICE_CACHE', dir);
    vi.resetModules();
    const { pruneVoiceCache } = await import('./cache');
    const old = new Date(Date.now() - 30 * 86_400_000);
    const write = (name: string, bytes: number, mtime?: Date) => {
      writeFileSync(join(dir, name), Buffer.alloc(bytes));
      if (mtime) utimesSync(join(dir, name), mtime, mtime);
    };
    write('kept-old.wav', 100, old);
    write('stale.wav', 250, old);
    write('fresh.wav', 400);
    write('notes.txt', 50, old);
    const out = await pruneVoiceCache(new Set(['kept-old.wav']), Date.now() - 7 * 86_400_000);
    expect(out).toEqual({ deleted: 1, freedBytes: 250 });
    expect(readdirSync(dir).sort()).toEqual(['fresh.wav', 'kept-old.wav', 'notes.txt']);
    vi.unstubAllEnvs();
  });

  it('copes with a cache that was never made', async () => {
    vi.stubEnv('SIM_VOICE_CACHE', join(dir, 'missing'));
    vi.resetModules();
    const { pruneVoiceCache } = await import('./cache');
    expect(await pruneVoiceCache(new Set(), Date.now())).toEqual({ deleted: 0, freedBytes: 0 });
    vi.unstubAllEnvs();
  });
});
