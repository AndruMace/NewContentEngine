/** Small typed client for the local server. Types mirror apps/server/src/views.ts. */
import type { Recipe } from '@sim/engine';
import type { Platform } from '@sim/planner/platforms';

export type { Platform };
export type CopyTarget = Platform | 'cover';

export interface SocialCopy {
  hook: string;
  cta: string;
  /** On-screen comment prompt; also adds the like heart. Absent for the comparison group. */
  nudge?: string;
  title: string;
  youtubeDescription: string;
  tiktokCaption: string;
  xPost: string;
  hashtags: string[];
  instagramCaption?: string;
  /** A first comment to pin per platform (on X, a reply to your own post). */
  pinnedComments?: Partial<Record<Platform, string>>;
  /** A few words for the TikTok / Instagram cover image. */
  coverText?: string;
  /** Emojis that fit this video, offered first in the emoji picker. */
  emojis?: string[];
}

export interface BatchSettings {
  postsWanted: number;
  factor: number;
  templateIds: string[];
  themeIds: string[];
  melodyIds: string[];
  minLengthS: number;
  maxLengthS: number;
  useClaude: boolean;
  notes: string;
  notifyMac: boolean;
}

export type BatchStatus = 'planning' | 'searching' | 'rendering' | 'done' | 'cancelled' | 'failed' | 'manual';

export interface Batch {
  id: string;
  createdAt: number;
  finishedAt: number | null;
  status: BatchStatus;
  settings: BatchSettings;
  warnings: string[];
  error: string | null;
  target: number;
  counts?: Record<string, number>;
  approved?: number;
}

export interface ReviewItem {
  id: string;
  batchId: string | null;
  kind: 'batch' | 'manual' | 'export';
  recipe: Recipe;
  copy: SocialCopy | null;
  score: number | null;
  status: 'queued' | 'rendering' | 'ready' | 'failed' | 'cancelled' | 'deleted';
  stage: string | null;
  progress: number;
  qc: { pass: boolean; problems: string[]; integratedLufs: number } | null;
  durationS: number | null;
  rankScore: number | null;
  error: string | null;
  createdAt: number;
  decision: 'pending' | 'approved' | 'rejected' | 'rerolled';
  /** Playground export: bundled for upload as soon as it's rendered. */
  autoExport: boolean;
  files: { final: string; cover: string; contact: string } | null;
  concept: {
    arm: { templateId: string; themeId: string; lengthBucket: string; hookStyle: string };
    source: string;
    rationale: string | null;
    targetS: number;
    experiment: { reason: string } | null;
    /** Where the taste model got the settings (e.g. "near a video you approved"). */
    paramsSource: string | null;
    /** Your notes for Claude (Playground exports). */
    notes: string | null;
  } | null;
  /** Fit to your taste (approval chance 0..1) once the taste model has enough reviews. */
  taste: { chance: number } | null;
  /** Why it was rejected (reason ids) and an optional note. */
  reasons: string[];
  note: string | null;
  /** Learner's expected reward (z units vs the channel's average); null before it has enough data. */
  prediction: { mean: number; sd: number; modelVersion: number } | null;
  platformText: Record<Platform, string> | null;
  /** Claude writing upload text in the background (null when nothing has run since the server started). */
  copyJob: { target: CopyTarget | 'all'; running: boolean; error: string | null } | null;
  export: { id: string; dir: string; createdAt: number } | null;
  posts: { platform: Platform; url: string; postedAt: number }[];
}

export interface Snapshot {
  batch: Batch;
  planned: number;
  items: ReviewItem[];
  counts: Record<string, number>;
  eta: number | null;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `${res.status} ${res.statusText}`), { status: res.status });
  return data as T;
}

// ---- long-form (ambient) videos: types mirror apps/server/src/longformJobs.ts ----------------

export interface LongFormCopy {
  title: string;
  description: string;
  tags: string[];
  thumbnailText: string;
}

export interface LongFormJob {
  id: string;
  createdAt: number;
  recipe: Recipe & { loopS: number; totalS: number };
  notes: string | null;
  status: 'queued' | 'rendering' | 'ready' | 'failed' | 'cancelled';
  stage: string | null;
  progress: number;
  dir: string | null;
  result: {
    qcPass: boolean;
    problems: string[];
    integratedLufs: number;
    truePeakDb: number;
    durationS: number;
    loopS: number;
    sizeBytes: number;
    timings: { framesMs: number; audioMs: number; masterMs: number; totalMs: number };
  } | null;
  error: string | null;
  copy: LongFormCopy | null;
  copyStatus: 'none' | 'writing' | 'ready' | 'failed';
  copyError: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface LongFormState {
  jobs: LongFormJob[];
  /** The long-form job rendering now. */
  current: string | null;
  /** A Shorts render in progress (long-form jobs wait for it). */
  shortsRendering: string | null;
}

export const longFormApi = {
  list: () => call<LongFormState>('GET', '/api/longform'),
  create: (recipe: Recipe, notes: string) => call<LongFormJob>('POST', '/api/longform', { recipe, notes }),
  cancel: (id: string) => call('POST', `/api/longform/${id}/cancel`),
  retry: (id: string) => call('POST', `/api/longform/${id}/retry`),
  editCopy: (id: string, patch: Partial<LongFormCopy>) => call<LongFormJob>('PATCH', `/api/longform/${id}/copy`, patch),
  regenerateCopy: (id: string, notes?: string) => call('POST', `/api/longform/${id}/copy/regenerate`, { notes }),
  remove: (id: string, files: boolean) => call('DELETE', `/api/longform/${id}${files ? '?files=1' : ''}`),
  /**
   * Live updates; returns a function that closes the stream. Renders run for half an hour or more,
   * so this reconnects if the server restarts (an error response closes an EventSource for good).
   */
  stream: (onState: (s: LongFormState) => void) => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const open = () => {
      es = new EventSource('/api/longform/stream');
      es.onmessage = (e) => onState(JSON.parse(e.data) as LongFormState);
      es.onerror = () => {
        if (closed || es?.readyState !== EventSource.CLOSED) return;
        timer = setTimeout(open, 3000);
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      es?.close();
    };
  },
};

export const api = {
  status: () => call<{ claude: boolean; busy: boolean }>('GET', '/api/status'),
  settings: () => call<BatchSettings>('GET', '/api/batch-settings'),
  batches: () => call<Batch[]>('GET', '/api/batches'),
  startBatch: (settings: BatchSettings) => call<Batch>('POST', '/api/batches', { settings }),
  cancelBatch: (id: string) => call('POST', `/api/batches/${id}/cancel`),
  decide: (id: string, decision: 'approved' | 'rejected' | 'pending', feedback: { reasons?: string[]; note?: string | null } = {}) =>
    call<ReviewItem>('POST', `/api/review/${id}/decision`, { decision, ...feedback }),
  reroll: (id: string, kind: 'seed' | 'copy' | 'concept' | 'melody') => call<ReviewItem>('POST', `/api/review/${id}/reroll`, { kind }),
  editCopy: (id: string, patch: Partial<SocialCopy>) => call<ReviewItem>('PATCH', `/api/review/${id}/copy`, patch),
  exportBundle: (id: string) => call<ReviewItem>('POST', `/api/review/${id}/export`),
  setPost: (id: string, platform: string, url: string) => call<ReviewItem>('PUT', `/api/review/${id}/posts`, { platform, url }),
  addManual: (recipe: Recipe) => call<ReviewItem>('POST', '/api/manual', { recipe }),
  prepareNarration: (recipe: Recipe, force = false) => call<{ voice: Recipe['voice'] | null; warnings: string[] }>('POST', '/api/narration/prepare', { recipe, force }),
  startUpload: (recipe: Recipe, notes: string) => call<ReviewItem>('POST', '/api/uploads', { recipe, notes }),
  item: (id: string) => call<ReviewItem>('GET', `/api/review/${id}`),
  regenerateCopy: (id: string, target: CopyTarget | 'all', notes: string) => call<ReviewItem>('POST', `/api/review/${id}/copy/regenerate`, { target, notes }),
  storage: () => call<{ rendersBytes: number; exportsBytes: number }>('GET', '/api/storage'),
  housekeeping: (days: number) => call<{ deleted: number; freedBytes: number }>('POST', '/api/housekeeping', { days }),
  reveal: (path: string, root: 'renders' | 'exports' = 'renders') => call('POST', '/api/reveal', { path, root }),
  library: () => call<LibraryEntry[]>('GET', '/api/library'),
  deleteRender: (path: string) => call('DELETE', `/api/library?path=${encodeURIComponent(path)}`),
  youtubeStatus: () => call<YouTubeStatus>('GET', '/api/youtube/status'),
  youtubeDisconnect: () => call<YouTubeStatus>('POST', '/api/youtube/disconnect'),
  refreshStats: () => call<RefreshResult>('POST', '/api/analytics/refresh'),
  posts: () => call<PostsResponse>('GET', '/api/analytics/posts'),
  post: (renderId: string) => call<PostDetail>('GET', `/api/analytics/posts/${renderId}`),
  setManual: (renderId: string, manual: Record<string, number | null>) => call<PostDetail>('PATCH', `/api/analytics/posts/${renderId}`, { manual }),
  linkUpload: (videoId: string, publishedAt: number, renderId: string) => call<PostsResponse>('POST', '/api/analytics/links', { videoId, publishedAt, renderId }),
  ignoreUpload: (videoId: string) => call<PostsResponse>('POST', '/api/analytics/ignore', { videoId }),
  linkable: () => call<{ id: string; title: string; exportedAt: number }[]>('GET', '/api/analytics/linkable'),
  learning: () => call<LearningStatus>('GET', '/api/analytics/learning'),
  taste: () => call<TasteStatus>('GET', '/api/analytics/taste'),
  analyticsSettings: () => call<AnalyticsSettings>('GET', '/api/analytics/settings'),
  setAnalyticsSettings: (body: { preset: string; weights?: RewardWeights }) => call<AnalyticsSettings>('PUT', '/api/analytics/settings', body),
};

export type RewardComponent = 'retention' | 'reach' | 'engagement' | 'followers';
export type RewardWeights = Record<RewardComponent, number>;

export interface AnalyticsSettings {
  preset: string;
  weights: RewardWeights;
  presets: Record<string, { label: string; weights: RewardWeights }>;
}

export interface TasteStatus {
  ready: boolean;
  readyAt: number;
  examples: number;
  liked: number;
  reasons: readonly { id: string; label: string }[];
  templates: {
    id: string;
    name: string;
    liked: number;
    rejected: number;
    skipped: number;
    reasons: Record<string, number>;
    /** What the model has learned about this template's settings (liked = up). */
    settings: { text: string; direction: 'up' | 'down'; strength: number; sure: boolean }[];
  }[];
}

export interface LearningStatus {
  ready: boolean;
  readyAt: number;
  matured: number;
  scored: number;
  modelVersion: number;
  fittedAt: number;
  noiseSd: number;
  calibration: { n: number; model: number; dramaBaseline: number };
  horizonDays: number;
  settings: { preset: string; weights: RewardWeights };
}

export interface PostReward {
  reward: number | null;
  weight: number;
  provisional: boolean;
  components: Partial<Record<RewardComponent, number>>;
  raw: { viewsAtHorizon?: number; apv?: number; expectedApv?: number; engagementRate?: number; subsPer1k?: number };
  reason?: string;
}

/** Full-page navigation: Google's consent screen, then back to #/analytics. */
export const youtubeConnectUrl = () => `/api/youtube/connect?returnTo=${encodeURIComponent(location.origin)}`;

export interface YouTubeStatus {
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
  channel: { id: string; title: string; thumbnail?: string } | null;
  lastRefresh: RefreshResult | null;
}

export interface RefreshResult {
  at: number;
  synced: { autoLinked: number; suggestions: number; unlinked: number } | null;
  updated: number;
  retention: number;
  skipped: number;
  errors: string[];
}

export interface Upload {
  videoId: string;
  title: string;
  publishedAt: number;
  thumbnail: string | null;
}

export interface PostView {
  renderId: string;
  batchId: string | null;
  platform: Platform;
  url: string;
  externalId: string | null;
  linkedBy: 'paste' | 'auto';
  publishedAt: number;
  ageH: number;
  title: string;
  hook: string;
  templateId: string;
  themeId: string;
  arm: { templateId: string; themeId: string; lengthBucket: string; hookStyle: string } | null;
  durationS: number | null;
  cover: { kind: 'render'; path: string } | { kind: 'export'; exportId: string } | null;
  experiment: boolean;
  manual: Record<string, number>;
  metrics: Record<string, number>;
  lastFetchedAt: number | null;
  snapshots: number;
  retention: { fetchedAt: number; ageH: number; points: number } | null;
  reward: PostReward | null;
  /** What the learner expected when it was exported (null if the model wasn't steering yet). */
  predicted: { mean: number; sd: number } | null;
}

export interface PostDetail extends PostView {
  history: { fetchedAt: number; ageH: number; metrics: Record<string, number> }[];
  curve: { t: number; watch: number; relative: number | null }[];
}

export interface PostsResponse {
  posts: PostView[];
  uploads: { at: number; suggestions: { upload: Upload; renderId: string; renderTitle: string; similarity: number }[]; unlinked: Upload[] };
}

export const coverUrl = (c: PostView['cover']) =>
  !c ? null : c.kind === 'render' ? `/files/${c.path}` : `/api/exports/${c.exportId}/file?name=cover.jpg&inline=1`;

export type RenderSource = 'batch' | 'playground-review' | 'playground-export' | 'cli' | 'ambient';

export interface LibraryEntry {
  dir: string;
  source: RenderSource;
  createdAt: number;
  sizeBytes: number;
  durationS: number | null;
  recipe: Recipe | null;
  qcPass: boolean | null;
  hasCover: boolean;
  cover: string | null;
  renderId: string | null;
  batchId: string | null;
  batchCreatedAt: number | null;
  decision: 'pending' | 'approved' | 'rejected' | 'rerolled' | null;
  hook: string | null;
}

export const SOURCE_INFO: Record<RenderSource, { label: string; group: 'batch' | 'playground' | 'cli' | 'ambient'; help: string }> = {
  batch: { label: 'Batch', group: 'batch', help: 'Made by a batch run' },
  'playground-review': { label: 'Playground → Review', group: 'playground', help: 'Sent from the Playground with "Add to review queue"' },
  'playground-export': { label: 'Playground export', group: 'playground', help: 'Made with "Export MP4" in the Playground' },
  cli: { label: 'Command line', group: 'cli', help: 'Made with npm run render (not tracked in the review database)' },
  ambient: { label: 'Long-form', group: 'ambient', help: 'A long-form ambient video (Ambient tab or npm run render); never in batches or analytics' },
};

export const exportFileUrl = (exportId: string, name: string) => `/api/exports/${exportId}/file?name=${encodeURIComponent(name)}`;

/** The upload page for one video (under Batches & Review). */
export const uploadPageHash = (renderId: string) => `#/review/upload/${renderId}`;

export function formatBytes(n: number) {
  return n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

/** Preview-only volume shared with the Playground slider. */
export function previewVolume(): number {
  try {
    const v = Number(localStorage.getItem('playground.volume'));
    return localStorage.getItem('playground.volume') !== null && v >= 0 && v <= 1 ? v : 0.8;
  } catch {
    return 0.8;
  }
}

const volumeReady = new WeakSet<HTMLVideoElement>();

/**
 * Ref callback for preview <video>s. Applies the shared preview volume once, when the element first
 * appears, and remembers changes made with the video's own controls as the new preview volume.
 * (Setting the volume on every render undid the viewer's changes whenever a page refreshed its data.)
 */
export function previewVideoRef(v: HTMLVideoElement | null) {
  if (!v || volumeReady.has(v)) return;
  volumeReady.add(v);
  v.volume = previewVolume();
  v.addEventListener('volumechange', () => {
    if (v.muted) return;
    try {
      localStorage.setItem('playground.volume', String(v.volume));
    } catch {
      /* ignore */
    }
  });
}
