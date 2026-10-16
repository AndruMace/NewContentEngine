/**
 * Upload platforms and the paste-ready text for each. No Node or SDK imports, so the web app can use
 * it too (`@sim/planner/platforms`): the export page and the .txt files show the same text.
 */
import type { SocialCopy } from './concept';

export const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'x'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<Platform, string> = { youtube: 'YouTube Shorts', tiktok: 'TikTok', instagram: 'Instagram Reels', x: 'X' };

/** One thing to paste into an upload form. `text` is exactly what gets copied. */
export interface UploadField {
  id: 'title' | 'description' | 'caption' | 'post' | 'cover' | 'pinned';
  label: string;
  text: string;
}

export interface PlatformUpload {
  fields: UploadField[];
  /** Every field in one block (also what the platform's .txt file holds). */
  all: string;
}

const withTags = (caption: string, tags: string) => (caption.includes('#') || !tags ? caption : `${caption} ${tags}`).trim();

/** Per-platform fields, in the order the upload forms ask for them. Empty fields are left out. */
export function uploadText(c: SocialCopy): Record<Platform, PlatformUpload> {
  const tags = c.hashtags.join(' ');
  const pinned = c.pinnedComments ?? {};
  const cover = c.coverText?.trim() ?? '';
  const build = (fields: UploadField[]): PlatformUpload => {
    const kept = fields.filter((f) => f.text.trim());
    return { fields: kept, all: kept.map((f, i) => (i === 0 || f.id === 'description' ? f.text : `${f.label}:\n${f.text}`)).join('\n\n') };
  };
  return {
    youtube: build([
      { id: 'title', label: 'Title', text: c.title },
      { id: 'description', label: 'Description', text: [c.youtubeDescription.trim(), `${tags} #Shorts`.trim()].filter(Boolean).join('\n\n') },
      { id: 'pinned', label: 'Pinned comment', text: pinned.youtube ?? '' },
    ]),
    tiktok: build([
      { id: 'caption', label: 'Caption', text: withTags(c.tiktokCaption, tags) },
      { id: 'cover', label: 'Cover text', text: cover },
      { id: 'pinned', label: 'Pinned comment', text: pinned.tiktok ?? '' },
    ]),
    instagram: build([
      { id: 'caption', label: 'Caption', text: withTags(c.instagramCaption ?? '', tags) },
      { id: 'cover', label: 'Cover text', text: cover },
      { id: 'pinned', label: 'Pinned comment', text: pinned.instagram ?? '' },
    ]),
    x: build([
      { id: 'post', label: 'Post', text: c.xPost },
      { id: 'pinned', label: 'Reply to your post', text: pinned.x ?? '' },
    ]),
  };
}
