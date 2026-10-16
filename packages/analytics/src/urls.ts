export type PlatformId = 'youtube' | 'tiktok' | 'instagram' | 'x';

/** The platform's id for a post URL, or null if the URL doesn't look like a post on that platform. */
export function parsePostUrl(platform: PlatformId, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|mobile)\./, '');
  if (platform === 'youtube') {
    const id =
      host === 'youtu.be'
        ? u.pathname.slice(1)
        : host === 'youtube.com' || host === 'music.youtube.com'
          ? (u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1] ?? u.searchParams.get('v'))
          : null;
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (platform === 'tiktok') return /tiktok\.com$/.test(host) ? (u.pathname.match(/\/video\/(\d+)/)?.[1] ?? null) : null;
  if (platform === 'instagram') return host === 'instagram.com' ? (u.pathname.match(/^\/(?:[^/]+\/)?(?:reels?|p)\/([A-Za-z0-9_-]+)/)?.[1] ?? null) : null;
  return host === 'x.com' || host === 'twitter.com' ? (u.pathname.match(/\/status\/(\d+)/)?.[1] ?? null) : null;
}

export const youtubeShortUrl = (id: string) => `https://www.youtube.com/shorts/${id}`;

/** Lowercase words of a title without hashtags, emoji and punctuation. */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/#\w+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleSimilarity(a: string, b: string): number {
  const A = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const B = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
