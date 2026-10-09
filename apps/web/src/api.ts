/** Small typed client for the local server. Types mirror apps/server/src/views.ts. */
import type { Recipe } from '@sim/engine';

export interface SocialCopy {
  hook: string;
  cta: string;
  title: string;
  youtubeDescription: string;
  tiktokCaption: string;
  xPost: string;
  hashtags: string[];
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
  files: { final: string; cover: string; contact: string } | null;
  concept: { arm: { templateId: string; themeId: string; lengthBucket: string; hookStyle: string }; source: string; rationale: string | null; targetS: number } | null;
  platformText: { youtube: string; tiktok: string; x: string } | null;
  export: { id: string; dir: string; createdAt: number } | null;
  posts: { platform: 'youtube' | 'tiktok' | 'x'; url: string; postedAt: number }[];
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
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  status: () => call<{ claude: boolean; busy: boolean }>('GET', '/api/status'),
  settings: () => call<BatchSettings>('GET', '/api/batch-settings'),
  batches: () => call<Batch[]>('GET', '/api/batches'),
  startBatch: (settings: BatchSettings) => call<Batch>('POST', '/api/batches', { settings }),
  cancelBatch: (id: string) => call('POST', `/api/batches/${id}/cancel`),
  decide: (id: string, decision: 'approved' | 'rejected' | 'pending') => call<ReviewItem>('POST', `/api/review/${id}/decision`, { decision }),
  reroll: (id: string, kind: 'seed' | 'copy' | 'concept') => call<ReviewItem>('POST', `/api/review/${id}/reroll`, { kind }),
  editCopy: (id: string, patch: Partial<SocialCopy>) => call<ReviewItem>('PATCH', `/api/review/${id}/copy`, patch),
  exportBundle: (id: string) => call<ReviewItem>('POST', `/api/review/${id}/export`),
  setPost: (id: string, platform: string, url: string) => call<ReviewItem>('PUT', `/api/review/${id}/posts`, { platform, url }),
  addManual: (recipe: Recipe) => call<ReviewItem>('POST', '/api/manual', { recipe }),
  storage: () => call<{ rendersBytes: number; exportsBytes: number }>('GET', '/api/storage'),
  housekeeping: (days: number) => call<{ deleted: number; freedBytes: number }>('POST', '/api/housekeeping', { days }),
  reveal: (path: string, root: 'renders' | 'exports' = 'renders') => call('POST', '/api/reveal', { path, root }),
  library: () => call<LibraryEntry[]>('GET', '/api/library'),
  deleteRender: (path: string) => call('DELETE', `/api/library?path=${encodeURIComponent(path)}`),
};

export type RenderSource = 'batch' | 'playground-review' | 'playground-export' | 'cli';

export interface LibraryEntry {
  dir: string;
  source: RenderSource;
  createdAt: number;
  sizeBytes: number;
  durationS: number | null;
  recipe: Recipe | null;
  qcPass: boolean | null;
  hasCover: boolean;
  renderId: string | null;
  batchId: string | null;
  batchCreatedAt: number | null;
  decision: 'pending' | 'approved' | 'rejected' | 'rerolled' | null;
  hook: string | null;
}

export const SOURCE_INFO: Record<RenderSource, { label: string; group: 'batch' | 'playground' | 'cli'; help: string }> = {
  batch: { label: 'Batch', group: 'batch', help: 'Made by a batch run' },
  'playground-review': { label: 'Playground → Review', group: 'playground', help: 'Sent from the Playground with "Add to review queue"' },
  'playground-export': { label: 'Playground export', group: 'playground', help: 'Made with "Export MP4" in the Playground' },
  cli: { label: 'Command line', group: 'cli', help: 'Made with npm run render (not tracked in the review database)' },
};

export const exportFileUrl = (exportId: string, name: string) => `/api/exports/${exportId}/file?name=${encodeURIComponent(name)}`;

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
