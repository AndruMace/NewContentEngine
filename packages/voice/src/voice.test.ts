import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { NarrationBeat, Recipe } from '@sim/engine';
import { numberForScreen, numberToWords } from './numbers';
import { spokenText } from './speech';
import { checkLine, fallbackLines, fillLine, wordCount } from './writer';
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

describe('spoken units', () => {
  it.each([
    ['It hits at 116 mph.', 'It hits at 116 miles per hour.'],
    ['It reaches 26,000 km/h.', 'It reaches 26,000 kilometers per hour.'],
    ['The surface reaches 1,220 °F.', 'The surface reaches 1,220 degrees Fahrenheit.'],
    ['Squeezed to 6,200 °C.', 'Squeezed to 6,200 degrees Celsius.'],
    ['At 38 miles, 62 km up, 300 m, 12 ft, 4.5 cm.', 'At 38 miles, 62 kilometers up, 300 meters, 12 feet, 4.5 centimeters.'],
    ['It weighs 1.5 t, or 180 kg.', 'It weighs 1.5 tonnes, or 180 kilograms.'],
    ['That is 853 g of TNT, or 3.6 MJ.', 'That is 853 grams of TNT, or 3.6 megajoules.'],
    ['It brakes at twelve g.', 'It brakes at twelve g.'],
    ['93% of it burned away; 1 km to go.', '93 percent of it burned away; 1 kilometer to go.'],
    ['twenty-five m/s, one hundred mph', 'twenty-five meters per second, one hundred miles per hour'],
    ['A team of 5 in a room, at 3 t.', 'A team of 5 in a room, at 3 tonnes.'],
  ])('%s', (written, spoken) => expect(spokenText(written)).toBe(spoken));

  it('the voice hears units in full while the caption keeps them short', () => {
    const b: NarrationBeat = { id: 'v', about: '', maxWords: 20, required: ['speed'], fallback: ['It hits at {speed}.'], facts: { speed: '116 mph' } };
    const out = fillLine(b, 'It hits at {speed}.');
    expect(out.text).toBe('It hits at 116 miles per hour.');
    expect(out.caption).toBe('It hits at 116 mph.');
  });
});

describe('line checks', () => {
  it('counts placeholders as the words they take to say', () => {
    expect(wordCount('{prev} is odd', beat.facts)).toBe(5);
    expect(wordCount('{prev} is odd')).toBe(3);
    // A fact with digits and a unit counts as it's said: "twenty-four thousand seven hundred kilometers per hour".
    expect(wordCount('It hits at {v}.', { v: '24,700 km/h' })).toBe(10);
    expect(wordCount('{x} the energy', { x: '3.8 times' })).toBe(6);
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
      text: 'Seven hundred three is odd, so triple it and add one: two thousand one hundred ten.',
      caption: '703 is odd, so triple it and add one: 2,110.',
    });
  });

  it('checks and fills a beat in parts sentence by sentence', () => {
    const rules: NarrationBeat = {
      id: 'rules',
      about: 'three rules switch on',
      facts: { n: 400 },
      required: ['n'],
      maxWords: 21,
      parts: [
        { about: 'separation on', maxWords: 9 },
        { about: 'alignment on', maxWords: 6 },
        { about: 'cohesion on', maxWords: 6 },
      ],
      fallback: ['Each of the {n} birds keeps its distance. | Then they line up. | Then they stay close.'],
    };
    expect(checkLine(rules, rules.fallback[0])).toBeNull();
    expect(checkLine(rules, 'Keep apart. | Line up.')).toMatch(/3 sentences/);
    expect(checkLine(rules, '{n} keep apart. | Line up and point the same way now please. | Close.')).toMatch(/sentence 2/);
    expect(checkLine(beat, '{prev} is odd. | {value}.')).toMatch(/one sentence/);
    const filled = fillLine(rules, rules.fallback[0]);
    expect(filled.parts).toEqual([
      { text: 'Each of the four hundred birds keeps its distance.', caption: 'Each of the 400 birds keeps its distance.' },
      { text: 'Then they line up.', caption: 'Then they line up.' },
      { text: 'Then they stay close.', caption: 'Then they stay close.' },
    ]);
    expect(filled.caption).toBe('Each of the 400 birds keeps its distance. Then they line up. Then they stay close.');
  });

  it('picks built-in lines per seed, only ones that fit', () => {
    expect(fallbackLines([beat], 5)).toEqual(fallbackLines([beat], 5));
    const tight = { ...beat, maxWords: 10 };
    for (let seed = 0; seed < 20; seed++) expect(fallbackLines([tight], seed).step1).toBe(beat.fallback[1]);
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
    const out = await prepareNarration(recipe, { provider: fake });
    const voice = out.voice!;
    expect(voice.lines.map((l) => l.beat)).toEqual(['intro', 'step1', 'repeat', 'reveal']);
    for (const l of voice.lines) {
      expect(l.text).not.toMatch(/\d/);
      expect(l.durationS).toBeGreaterThan(0.5);
    }
    expect(voice.lines[0].caption).toMatch(/703/);
    const again = await prepareNarration(out, { provider: fake });
    expect(again).toBe(out);
    const other = await prepareNarration({ ...out, seed: 3 }, { provider: fake });
    expect(other.voice!.factsHash).not.toBe(voice.factsHash);
  });

  it('voices a passage sentence by sentence into one clip, with each sentence\'s start', async () => {
    const { voicePassage, PART_GAP_S } = await import('./cache');
    const out = await voicePassage(fake, 'v', ['One two.', 'Three four five.']);
    expect(out.parts).toHaveLength(2);
    expect(out.parts[0].at).toBe(0);
    expect(out.parts[1].at).toBeCloseTo(out.parts[0].durationS + PART_GAP_S, 6);
    expect(out.durationS).toBeCloseTo(out.parts[1].at + out.parts[1].durationS, 2);
    expect((await voicePassage(fake, 'v', ['One two.', 'Three four five.'])).clip).toBe(out.clip);
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
