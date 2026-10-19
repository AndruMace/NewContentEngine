/**
 * YouTube connection: OAuth (desktop client, loopback redirect, PKCE), upload sync, and stats refresh.
 * Plain fetch against Google's REST endpoints; the refresh token lives in data/youtube-token.json.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTitle, titleSimilarity, youtubeShortUrl } from '@sim/analytics';
import { isLongForm } from '@sim/templates';
import {
  DATA_DIR,
  allPosts,
  db,
  getKv,
  getRender,
  insertSnapshot,
  postByExternalId,
  retentionFor,
  setKv,
  snapshotsFor,
  updatePostMeta,
  upsertPost,
  upsertRetention,
  type PostRow,
} from './db';

const TOKEN_FILE = join(DATA_DIR, 'youtube-token.json');
const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'];
const DATA_API = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports';
const HOUR = 3_600_000;
/** Uploads longer than this can't be Shorts from this tool (they're the long-form ambient videos). */
const LONG_UPLOAD_S = 10 * 60;
const DAY = 24 * HOUR;

interface StoredToken {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  channel?: { id: string; title: string; uploads: string; thumbnail?: string };
  /** Set when Google rejected the refresh token; the user must reconnect. */
  invalid?: boolean;
}

export class YouTubeAuthError extends Error {}

const clientId = () => process.env.GOOGLE_CLIENT_ID?.trim() ?? '';
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
export const youtubeConfigured = () => Boolean(clientId() && clientSecret());

function readToken(): StoredToken | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as StoredToken;
  } catch {
    return null;
  }
}

function writeToken(t: StoredToken) {
  writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
}

export interface YouTubeStatus {
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
  channel: StoredToken['channel'] | null;
  lastRefresh: RefreshResult | null;
}

export function youtubeStatus(): YouTubeStatus {
  const t = readToken();
  return {
    configured: youtubeConfigured(),
    connected: Boolean(t && !t.invalid),
    needsReconnect: Boolean(t?.invalid),
    channel: t?.channel ?? null,
    lastRefresh: getKv<RefreshResult | null>('youtube_last_refresh', null),
  };
}

// ---- OAuth ------------------------------------------------------------------------------------

const pending = new Map<string, { verifier: string; returnTo: string; redirectUri: string; at: number }>();
const b64url = (b: Buffer) => b.toString('base64url');

/** Google consent URL. `returnTo` is where the browser lands afterwards (the UI's origin). */
export function authUrl(redirectUri: string, returnTo: string): string {
  if (!youtubeConfigured()) throw new Error('Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env first (see docs/youtube-setup.md)');
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(k);
  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(48));
  pending.set(state, { verifier, returnTo, redirectUri, at: Date.now() });
  const q = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** Finish the OAuth dance. Returns where to send the browser. */
export async function handleCallback(query: { code?: string; state?: string; error?: string }): Promise<string> {
  const p = query.state ? pending.get(query.state) : undefined;
  if (!p) throw new Error('This sign-in link expired. Start again from the Analytics tab.');
  pending.delete(query.state!);
  if (query.error) return `${p.returnTo}#/analytics?youtube=${encodeURIComponent(query.error)}`;
  const tok = await tokenRequest({
    grant_type: 'authorization_code',
    code: query.code ?? '',
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  });
  const previous = readToken();
  const refreshToken = tok.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  const scopes = String(tok.scope ?? '').split(' ');
  if (!SCOPES.every((s) => scopes.includes(s))) return `${p.returnTo}#/analytics?youtube=missing_scopes`;
  const t: StoredToken = { refreshToken, accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in - 60) * 1000 };
  writeToken(t);
  t.channel = await fetchChannel();
  writeToken(t);
  return `${p.returnTo}#/analytics?youtube=connected`;
}

async function tokenRequest(params: Record<string, string>): Promise<any> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new YouTubeAuthError('YouTube access expired or was revoked. Reconnect on the Analytics tab.');
    throw new Error(`Google token error: ${data.error_description ?? data.error ?? res.status}`);
  }
  return data;
}

async function accessToken(): Promise<string> {
  const t = readToken();
  if (!t || t.invalid) throw new YouTubeAuthError('YouTube is not connected');
  if (t.accessToken && (t.expiresAt ?? 0) > Date.now()) return t.accessToken;
  try {
    const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
    t.accessToken = tok.access_token;
    t.expiresAt = Date.now() + (tok.expires_in - 60) * 1000;
    writeToken(t);
    return t.accessToken!;
  } catch (e) {
    if (e instanceof YouTubeAuthError) writeToken({ ...t, invalid: true, accessToken: undefined });
    throw e;
  }
}

export async function disconnect() {
  const t = readToken();
  if (t?.refreshToken) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refreshToken)}`, { method: 'POST' }).catch(() => {});
  rmSync(TOKEN_FILE, { force: true });
}

async function api(url: string): Promise<any> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const err = new Error(data.error?.message ?? `${res.status} ${res.statusText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}

async function fetchChannel(): Promise<StoredToken['channel']> {
  const data = await api(`${DATA_API}/channels?part=snippet,contentDetails&mine=true`);
  const c = data.items?.[0];
  if (!c) throw new Error('This Google account has no YouTube channel');
  return { id: c.id, title: c.snippet.title, uploads: c.contentDetails.relatedPlaylists.uploads, thumbnail: c.snippet.thumbnails?.default?.url };
}

// ---- Upload sync ------------------------------------------------------------------------------

export interface Upload {
  videoId: string;
  title: string;
  publishedAt: number;
  thumbnail: string | null;
}

export interface LinkSuggestion {
  upload: Upload;
  renderId: string;
  renderTitle: string;
  similarity: number;
}

export interface SyncResult {
  autoLinked: { upload: Upload; renderId: string }[];
  suggestions: LinkSuggestion[];
  unlinked: Upload[];
}

/** Exported videos that have no YouTube post yet. */
function linkableRenders(): { id: string; title: string; exportedAt: number }[] {
  return (
    db
      .prepare(
        `SELECT r.id, r.copy, json_extract(r.recipe, '$.templateId') AS template_id, MAX(e.created_at) AS exported_at FROM renders r JOIN exports e ON e.render_id = r.id
         WHERE r.id NOT IN (SELECT render_id FROM posts WHERE platform = 'youtube') GROUP BY r.id`,
      )
      .all() as { id: string; copy: string | null; template_id: string; exported_at: number }[]
  )
    // Long-form ambient videos are never linked: analytics ignores them.
    .filter((r) => !isLongForm(r.template_id))
    .map((r) => ({ id: r.id, title: r.copy ? (JSON.parse(r.copy).title ?? '') : '', exportedAt: r.exported_at }));
}

export function linkableRendersView() {
  return linkableRenders().sort((a, b) => b.exportedAt - a.exportedAt);
}

/** Read the channel's recent uploads and link the ones that match exported videos. */
export async function syncUploads(): Promise<SyncResult> {
  const t = readToken();
  if (!t?.channel) throw new YouTubeAuthError('YouTube is not connected');
  const data = await api(`${DATA_API}/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${t.channel.uploads}`);
  const uploads: Upload[] = (data.items ?? []).map((it: any) => ({
    videoId: it.contentDetails.videoId,
    title: it.snippet.title,
    publishedAt: Date.parse(it.contentDetails.videoPublishedAt ?? it.snippet.publishedAt),
    thumbnail: it.snippet.thumbnails?.medium?.url ?? it.snippet.thumbnails?.default?.url ?? null,
  }));
  const ignored = new Set(getKv<string[]>('youtube_ignored', []));
  // Long uploads on the same channel are the ambient videos (Shorts are at most 3 minutes): ignore them
  // for good so they never show up as unlinked uploads or reach analytics.
  const fresh = uploads.filter((u) => !ignored.has(u.videoId) && !postByExternalId('youtube', u.videoId));
  if (fresh.length) {
    const details = await api(`${DATA_API}/videos?part=contentDetails&id=${fresh.map((u) => u.videoId).join(',')}`);
    const long = (details.items ?? []).filter((v: any) => parseIsoDuration(v.contentDetails?.duration) > LONG_UPLOAD_S).map((v: any) => v.id as string);
    if (long.length) {
      for (const id of long) ignored.add(id);
      setKv('youtube_ignored', [...ignored]);
    }
  }
  const result: SyncResult = { autoLinked: [], suggestions: [], unlinked: [] };
  let candidates = linkableRenders();
  for (const u of uploads) {
    if (ignored.has(u.videoId) || postByExternalId('youtube', u.videoId)) continue;
    // Only videos exported before the upload went live can be the source.
    const eligible = candidates.filter((c) => c.exportedAt <= u.publishedAt + HOUR);
    const exact = eligible.filter((c) => normalizeTitle(c.title) === normalizeTitle(u.title));
    if (exact.length === 1) {
      linkUpload(u, exact[0].id, 'auto');
      result.autoLinked.push({ upload: u, renderId: exact[0].id });
      candidates = candidates.filter((c) => c.id !== exact[0].id);
      continue;
    }
    const best = eligible.map((c) => ({ c, s: titleSimilarity(c.title, u.title) })).sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.4) result.suggestions.push({ upload: u, renderId: best.c.id, renderTitle: best.c.title, similarity: best.s });
    else result.unlinked.push(u);
  }
  setKv('youtube_unlinked', { at: Date.now(), suggestions: result.suggestions, unlinked: result.unlinked });
  return result;
}

export function linkUpload(u: Pick<Upload, 'videoId' | 'publishedAt'>, renderId: string, linkedBy: 'paste' | 'auto') {
  const render = getRender(renderId);
  if (!render) throw new Error('Video not found');
  if (isLongForm(render.recipe.templateId)) throw new Error('Long-form ambient videos are not tracked in analytics');
  const other = postByExternalId('youtube', u.videoId);
  if (other && other.renderId !== renderId) throw new Error('That upload is already linked to another video');
  upsertPost({ renderId, platform: 'youtube', url: youtubeShortUrl(u.videoId), postedAt: u.publishedAt, externalId: u.videoId, publishedAt: u.publishedAt, linkedBy });
  dropFromUnlinked(u.videoId);
}

export function ignoreUpload(videoId: string) {
  setKv('youtube_ignored', [...new Set([...getKv<string[]>('youtube_ignored', []), videoId])]);
  dropFromUnlinked(videoId);
}

function dropFromUnlinked(videoId: string) {
  const u = getKv<{ at: number; suggestions: LinkSuggestion[]; unlinked: Upload[] } | null>('youtube_unlinked', null);
  if (!u) return;
  setKv('youtube_unlinked', { ...u, suggestions: u.suggestions.filter((s) => s.upload.videoId !== videoId), unlinked: u.unlinked.filter((x) => x.videoId !== videoId) });
}

export function unlinkedUploads() {
  return getKv<{ at: number; suggestions: LinkSuggestion[]; unlinked: Upload[] }>('youtube_unlinked', { at: 0, suggestions: [], unlinked: [] });
}

// ---- Stats refresh ----------------------------------------------------------------------------

export interface RefreshResult {
  at: number;
  synced: { autoLinked: number; suggestions: number; unlinked: number } | null;
  updated: number;
  retention: number;
  skipped: number;
  errors: string[];
}

/** Analytics metrics per video. engagedViews is dropped automatically if the API rejects it. */
const BASE_METRICS = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'];
let engagedViewsSupported = true;
const LIVE_COUNTS = new Set(['views', 'likes', 'comments']);

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parseIsoDuration = (s: string) => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(s ?? '');
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
};

/** Which posts to refresh: everything under 30 days old, weekly up to 90 days, then never. */
function dueForRefresh(p: PostRow, now: number): boolean {
  const age = now - (p.publishedAt ?? p.postedAt);
  if (age > 90 * DAY) return false;
  if (age <= 30 * DAY) return true;
  const last = snapshotsFor(p.renderId, 'youtube').at(-1);
  return !last || now - last.fetchedAt > 7 * DAY;
}

async function analyticsByVideo(ids: string[], startDate: string, endDate: string): Promise<Map<string, Record<string, number>>> {
  const run = async (metrics: string[]) =>
    api(
      `${ANALYTICS_API}?${new URLSearchParams({
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: metrics.join(','),
        dimensions: 'video',
        filters: `video==${ids.join(',')}`,
        sort: '-views',
        maxResults: '200',
      })}`,
    );
  let data;
  try {
    data = await run(engagedViewsSupported ? [...BASE_METRICS, 'engagedViews'] : BASE_METRICS);
  } catch (e) {
    if (!engagedViewsSupported || (e as { status?: number }).status !== 400) throw e;
    engagedViewsSupported = false;
    data = await run(BASE_METRICS);
  }
  const names: string[] = data.columnHeaders.map((h: any) => h.name);
  const out = new Map<string, Record<string, number>>();
  for (const row of data.rows ?? []) {
    const rec: Record<string, number> = {};
    // Counts that the Data API also reports live get an "a" prefix (aViews, aLikes, aComments): Analytics
    // lags about two days, so its counts are only for ratios against its own watch-time numbers.
    names.forEach((n, i) => i > 0 && (rec[LIVE_COUNTS.has(n) ? `a${n[0].toUpperCase()}${n.slice(1)}` : n] = Number(row[i])));
    out.set(String(row[0]), rec);
  }
  return out;
}

async function retentionCurve(videoId: string, startDate: string, endDate: string) {
  const data = await api(
    `${ANALYTICS_API}?${new URLSearchParams({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'audienceWatchRatio,relativeRetentionPerformance',
      dimensions: 'elapsedVideoTimeRatio',
      filters: `video==${videoId}`,
    })}`,
  );
  return (data.rows ?? []).map((r: number[]) => ({ t: Number(r[0]), watch: Number(r[1]), relative: r[2] === null || r[2] === undefined ? null : Number(r[2]) }));
}

async function shortsFeedShare(videoId: string, startDate: string, endDate: string): Promise<number | null> {
  const data = await api(
    `${ANALYTICS_API}?${new URLSearchParams({ ids: 'channel==MINE', startDate, endDate, metrics: 'views', dimensions: 'insightTrafficSourceType', filters: `video==${videoId}` })}`,
  );
  const rows: [string, number][] = data.rows ?? [];
  const total = rows.reduce((s, r) => s + Number(r[1]), 0);
  const shorts = rows.filter((r) => r[0] === 'SHORTS').reduce((s, r) => s + Number(r[1]), 0);
  return total > 0 ? shorts / total : null;
}

/**
 * Sync uploads, then snapshot stats for every due YouTube post. Live counts come from the Data API;
 * watch-time metrics and retention come from the Analytics API (which lags about two days).
 */
export async function refreshYouTube(opts: { deadline?: number } = {}): Promise<RefreshResult> {
  const now = Date.now();
  const result: RefreshResult = { at: now, synced: null, updated: 0, retention: 0, skipped: 0, errors: [] };
  const overDeadline = () => opts.deadline !== undefined && Date.now() > opts.deadline;
  try {
    const s = await syncUploads();
    result.synced = { autoLinked: s.autoLinked.length, suggestions: s.suggestions.length, unlinked: s.unlinked.length };
  } catch (e) {
    if (e instanceof YouTubeAuthError) throw e;
    result.errors.push(`Upload sync: ${(e as Error).message}`);
  }
  const posts = allPosts('youtube').filter((p) => p.externalId && dueForRefresh(p, now));
  for (let i = 0; i < posts.length; i += 50) {
    if (overDeadline()) {
      result.skipped += posts.length - i;
      break;
    }
    const chunk = posts.slice(i, i + 50);
    const ids = chunk.map((p) => p.externalId!);
    let live: Map<string, any>;
    try {
      const data = await api(`${DATA_API}/videos?part=snippet,statistics,contentDetails&id=${ids.join(',')}`);
      live = new Map((data.items ?? []).map((v: any) => [v.id, v]));
    } catch (e) {
      result.errors.push(`Video stats: ${(e as Error).message}`);
      continue;
    }
    const earliest = Math.min(...chunk.map((p) => p.publishedAt ?? p.postedAt));
    let analytics = new Map<string, Record<string, number>>();
    try {
      analytics = await analyticsByVideo(ids, ymd(earliest - DAY), ymd(now));
    } catch (e) {
      result.errors.push(`Analytics: ${(e as Error).message}`);
    }
    for (const p of chunk) {
      const v = live.get(p.externalId!);
      if (!v) {
        result.errors.push(`Video ${p.externalId} not found (deleted or private?)`);
        continue;
      }
      const publishedAt = Date.parse(v.snippet.publishedAt);
      if (publishedAt && publishedAt !== p.publishedAt) updatePostMeta(p.renderId, 'youtube', { publishedAt });
      const ageH = (now - (publishedAt || p.postedAt)) / HOUR;
      const extra: Record<string, number> = {};
      // Retention: first at 3 days (when Analytics has data), final after 7 days.
      const curve = retentionFor(p.renderId, 'youtube');
      const wantCurve = ageH >= 72 && (!curve || (curve.ageH < 168 && ageH >= 168));
      if (wantCurve && !overDeadline()) {
        try {
          const points = await retentionCurve(p.externalId!, ymd(publishedAt - DAY), ymd(now));
          if (points.length) {
            upsertRetention({ renderId: p.renderId, platform: 'youtube', fetchedAt: now, ageH, points });
            result.retention++;
          }
          const share = await shortsFeedShare(p.externalId!, ymd(publishedAt - DAY), ymd(now));
          if (share !== null) extra.shortsFeedShare = share;
        } catch (e) {
          result.errors.push(`Retention for ${p.externalId}: ${(e as Error).message}`);
        }
      }
      insertSnapshot({
        renderId: p.renderId,
        platform: 'youtube',
        fetchedAt: now,
        ageH,
        source: 'youtube',
        metrics: {
          views: Number(v.statistics.viewCount ?? 0),
          likes: Number(v.statistics.likeCount ?? 0),
          comments: Number(v.statistics.commentCount ?? 0),
          durationS: parseIsoDuration(v.contentDetails.duration),
          ...(analytics.get(p.externalId!) ?? {}),
          ...extra,
        },
      });
      result.updated++;
    }
  }
  setKv('youtube_last_refresh', result);
  return result;
}
