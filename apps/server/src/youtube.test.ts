/**
 * YouTube connection end to end against a fake Google: OAuth callback, upload auto-linking,
 * stats snapshots, retention curves. Uses a throwaway data directory.
 */
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'sim-yt-'));
process.env.SIM_DATA_DIR = dir;
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

const DAY = 86_400_000;
const published = Date.now() - 8 * DAY;
const calls: string[] = [];
let failRefresh = false;

function fakeGoogle(url: string, init?: RequestInit): Response {
  calls.push(url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    const body = new URLSearchParams(String(init?.body));
    if (body.get('grant_type') === 'refresh_token' && failRefresh) return json({ error: 'invalid_grant' }, 400);
    return json({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly',
    });
  }
  if (url.includes('/channels?')) return json({ items: [{ id: 'UC1', snippet: { title: 'Test Channel', thumbnails: {} }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
  if (url.includes('/playlistItems?'))
    return json({
      items: [
        { contentDetails: { videoId: 'AAAAAAAAAAA', videoPublishedAt: new Date(published).toISOString() }, snippet: { title: 'Can it escape all 30 rings? #Shorts', thumbnails: {} } },
        { contentDetails: { videoId: 'BBBBBBBBBBB', videoPublishedAt: new Date(published).toISOString() }, snippet: { title: 'Totally unrelated vlog', thumbnails: {} } },
      ],
    });
  if (url.includes('/videos?'))
    return json({ items: [{ id: 'AAAAAAAAAAA', snippet: { publishedAt: new Date(published).toISOString() }, statistics: { viewCount: '1234', likeCount: '56', commentCount: '7' }, contentDetails: { duration: 'PT31S' } }] });
  if (url.includes('youtubeanalytics')) {
    const q = new URL(url).searchParams;
    if (q.get('dimensions') === 'video') {
      // Pretend engagedViews isn't supported, to exercise the fallback.
      if (q.get('metrics')!.includes('engagedViews')) return json({ error: { message: 'Unknown identifier (engagedViews)' } }, 400);
      const names = ['video', ...q.get('metrics')!.split(',')];
      return json({ columnHeaders: names.map((name) => ({ name })), rows: [['AAAAAAAAAAA', ...names.slice(1).map((_, i) => i + 10)]] });
    }
    if (q.get('dimensions') === 'elapsedVideoTimeRatio') return json({ rows: Array.from({ length: 100 }, (_, i) => [(i + 1) / 100, 1 - i / 150, 0.5]) });
    if (q.get('dimensions') === 'insightTrafficSourceType') return json({ rows: [['SHORTS', 900], ['YT_SEARCH', 100]] });
  }
  return json({ error: { message: `unexpected ${url}` } }, 404);
}

let yt: typeof import('./youtube');
let db: typeof import('./db');

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => fakeGoogle(String(url), init)));
  db = await import('./db');
  yt = await import('./youtube');
  // One exported video whose title matches the first upload.
  const recipe = { templateId: 'ring-escape', themeId: 'neon', melodyId: 'ode-to-joy', seed: 1, params: {}, targetS: 30 } as any;
  const copy = { hook: 'h', cta: 'c', title: 'Can it escape all 30 rings?', youtubeDescription: '', tiktokCaption: 't', xPost: 'x', hashtags: [] };
  const r = db.insertRender({ batchId: null, conceptId: null, kind: 'manual', recipe, copy, score: null, scoreParts: null, altSeeds: [], rankScore: null });
  db.db.prepare('INSERT INTO exports (id, render_id, dir, created_at) VALUES (?, ?, ?, ?)').run('ex1', r.id, 'x', published - DAY);
});

afterAll(() => vi.unstubAllGlobals());

describe('youtube', () => {
  it('connects through the OAuth callback and stores a private token', async () => {
    const url = new URL(yt.authUrl('http://127.0.0.1:5174/api/youtube/callback', 'http://localhost:5173'));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    const back = await yt.handleCallback({ code: 'c', state: url.searchParams.get('state')! });
    expect(back).toBe('http://localhost:5173#/analytics?youtube=connected');
    expect(yt.youtubeStatus()).toMatchObject({ connected: true, channel: { title: 'Test Channel' } });
    expect(statSync(join(dir, 'youtube-token.json')).mode & 0o777).toBe(0o600);
    await expect(yt.handleCallback({ code: 'c', state: url.searchParams.get('state')! })).rejects.toThrow(/expired/);
  });

  it('links matching uploads and snapshots their stats', async () => {
    const r = await yt.refreshYouTube();
    expect(r.errors).toEqual([]);
    expect(r.synced).toEqual({ autoLinked: 1, suggestions: 0, unlinked: 1 });
    expect(r.updated).toBe(1);
    expect(r.retention).toBe(1);
    const post = db.allPosts('youtube')[0];
    expect(post).toMatchObject({ externalId: 'AAAAAAAAAAA', linkedBy: 'auto', publishedAt: published });
    const snap = db.snapshotsFor(post.renderId, 'youtube')[0];
    expect(snap.metrics).toMatchObject({ views: 1234, likes: 56, comments: 7, durationS: 31, shortsFeedShare: 0.9 });
    expect(snap.metrics.averageViewPercentage).toBeTypeOf('number');
    expect(snap.metrics).toMatchObject({ aViews: 10, aLikes: 14, aComments: 15 });
    expect(snap.ageH).toBeGreaterThan(190);
    expect(db.retentionFor(post.renderId, 'youtube')!.points).toHaveLength(100);
    expect(yt.unlinkedUploads().unlinked.map((u) => u.videoId)).toEqual(['BBBBBBBBBBB']);
  });

  it('does not refetch a final retention curve', async () => {
    calls.length = 0;
    await yt.refreshYouTube();
    expect(calls.some((u) => u.includes('elapsedVideoTimeRatio'))).toBe(false);
  });

  it('asks for a reconnect when Google revokes access', async () => {
    const t = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'youtube-token.json'), 'utf8'));
    (await import('node:fs')).writeFileSync(join(dir, 'youtube-token.json'), JSON.stringify({ ...t, expiresAt: 0 }));
    failRefresh = true;
    await expect(yt.refreshYouTube()).rejects.toThrow(/Reconnect/);
    expect(yt.youtubeStatus()).toMatchObject({ connected: false, needsReconnect: true });
  });
});
