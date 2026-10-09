import { describe, expect, it } from 'vitest';
import { copyFeatures, ctaStyle } from './features';
import { normalizeTitle, parsePostUrl, titleSimilarity } from './urls';

describe('features', () => {
  it('classifies CTAs', () => {
    expect(ctaStyle('{winner} sort wins! Did you call it?')).toBe('guess');
    expect(ctaStyle('Were you right? Comment YES or NO')).toBe('guess');
    expect(ctaStyle('Did your side win? Comment your pick')).toBe('pick');
    expect(ctaStyle('{winner} wins! Who was your pick?')).toBe('pick');
    expect(ctaStyle('Name the color it made 👇')).toBe('opinion');
    expect(ctaStyle('Rate it out of 10')).toBe('rate');
    expect(ctaStyle('Follow for more')).toBe('other');
  });
  it('extracts hook features', () => {
    expect(copyFeatures({ hook: 'Can it escape all 30 rings? 🔥', cta: '' })).toMatchObject({ hookQuestion: true, hookDigit: true, hookEmoji: true });
  });
});

describe('parsePostUrl', () => {
  it('handles YouTube link shapes', () => {
    for (const u of ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?si=abc', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=3'])
      expect(parsePostUrl('youtube', u)).toBe('dQw4w9WgXcQ');
    expect(parsePostUrl('youtube', 'https://example.com/shorts/dQw4w9WgXcQ')).toBeNull();
    expect(parsePostUrl('youtube', 'not a url')).toBeNull();
  });
  it('handles TikTok and X', () => {
    expect(parsePostUrl('tiktok', 'https://www.tiktok.com/@me/video/7312345678901234567')).toBe('7312345678901234567');
    expect(parsePostUrl('x', 'https://x.com/me/status/1801234567890123456')).toBe('1801234567890123456');
  });
});

describe('title matching', () => {
  it('ignores hashtags, emoji and punctuation', () => {
    expect(normalizeTitle('Can it ESCAPE all 30 rings?! 🔥 #Shorts')).toBe('can it escape all 30 rings');
  });
  it('scores near-identical titles high and unrelated ones low', () => {
    expect(titleSimilarity('Can it escape all 30 rings?', 'Can it escape ALL 30 rings 😱 #shorts')).toBe(1);
    expect(titleSimilarity('Can it escape all 30 rings?', 'Can the ball escape 30 rings')).toBeGreaterThan(0.4);
    expect(titleSimilarity('Sand fills a heart jar', 'Marble race: 12 countries')).toBeLessThan(0.2);
  });
});
