import { describe, expect, it } from 'vitest';
import { parsePostUrl } from './postUrl';

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
  it('handles Instagram reels and posts', () => {
    for (const u of ['https://www.instagram.com/reel/C8aBc-12_x/', 'https://instagram.com/reels/C8aBc-12_x/?igsh=abc', 'https://www.instagram.com/someone/reel/C8aBc-12_x/', 'https://www.instagram.com/p/C8aBc-12_x/'])
      expect(parsePostUrl('instagram', u)).toBe('C8aBc-12_x');
    expect(parsePostUrl('instagram', 'https://www.instagram.com/someone/')).toBeNull();
  });
});
