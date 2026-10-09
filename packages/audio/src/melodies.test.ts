import { describe, expect, it } from 'vitest';
import { MELODIES } from './melodies';

describe('melody library', () => {
  it('only contains public-domain material with sane pitches', () => {
    for (const m of MELODIES) {
      expect(m.license).toBe('public-domain');
      expect(m.steps.length).toBeGreaterThan(16);
      for (const step of m.steps) for (const midi of step) expect(midi).toBeGreaterThanOrEqual(24), expect(midi).toBeLessThanOrEqual(108);
    }
  });

  it('has unique ids', () => {
    expect(new Set(MELODIES.map((m) => m.id)).size).toBe(MELODIES.length);
  });
});
