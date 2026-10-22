import type { Platform } from '@sim/planner/platforms';

/** The platform's id for a post URL, or null if the URL doesn't look like a post on that platform. */
export function parsePostUrl(platform: Platform, url: string): string | null {
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
