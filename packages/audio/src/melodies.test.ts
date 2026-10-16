import { describe, expect, it } from 'vitest';
import { hashString } from '@sim/engine';
import { MELODIES } from './melodies';

describe('melody library', () => {
  it('only contains public-domain material with sane pitches', () => {
    for (const m of MELODIES) {
      expect(m.license).toBe('public-domain');
      expect(m.steps.length).toBeGreaterThan(16);
      for (const step of m.steps) for (const midi of step) expect(midi).toBeGreaterThanOrEqual(24), expect(midi).toBeLessThanOrEqual(108);
    }
  });

  it('is timed: a positive length per step, phrases and a sane tempo', () => {
    for (const m of MELODIES) {
      expect(m.beats, m.id).toHaveLength(m.steps.length);
      for (const b of m.beats!) expect(b, m.id).toBeGreaterThan(0);
      expect(m.phrases![0], m.id).toBe(0);
      for (let i = 1; i < m.phrases!.length; i++) expect(m.phrases![i], m.id).toBeGreaterThan(m.phrases![i - 1]);
      expect(m.phrases!.at(-1)!, m.id).toBeLessThan(m.steps.length);
      expect(m.bpm, m.id).toBeGreaterThanOrEqual(40);
      expect(m.bpm, m.id).toBeLessThanOrEqual(200);
    }
  });

  it('kept the same pitches when timing was added (other templates only play the pitches)', () => {
    const before: Record<string, string> = {
      'ode-to-joy': 'f19f4e05',
      'fur-elise': 'f18dc477',
      'mountain-king': 'be5ab437',
      twinkle: 'fe85c167',
      entertainer: 'd9f2cc03',
      greensleeves: '92d895c2',
      'turkish-march': '67d0c289',
      'jingle-bells': 'f657d60a',
      'canon-in-d': 'a16abd1d',
      toccata: '4d4071d1',
      'brahms-lullaby': '4bc71f2c',
      'frere-jacques': '556554cb',
      'morning-mood': '83672faa',
      saints: '07fd338c',
      'amazing-grace': '8a106774',
    };
    for (const m of MELODIES) if (before[m.id]) expect(hashString(JSON.stringify(m.steps)), m.id).toBe(before[m.id]);
  });

  it('has unique ids', () => {
    expect(new Set(MELODIES.map((m) => m.id)).size).toBe(MELODIES.length);
  });
});
