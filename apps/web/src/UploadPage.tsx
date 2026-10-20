import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import EmojiPicker, { EmojiStyle, Theme } from 'emoji-picker-react';
import { parseParams } from '@sim/engine';
import { findTemplate } from '@sim/templates';
import { PLATFORMS, PLATFORM_LABEL, uploadText, type Platform, type UploadField } from '@sim/planner/platforms';
import { api, exportFileUrl, previewVideoRef, type CopyTarget, type ReviewItem, type SocialCopy } from './api';
import { CopyButton, Posts } from './CandidateCard';

/** One editable piece of copy. Pinned comments are per platform; cover text is shared by TikTok and Instagram. */
type FieldKey = 'title' | 'youtubeDescription' | 'hashtags' | 'tiktokCaption' | 'instagramCaption' | 'xPost' | 'coverText' | `pinned.${Platform}`;

interface FieldSpec {
  key: FieldKey;
  label: string;
  /** Which of uploadText()'s fields holds the paste-ready text (null: copy the raw value). */
  copies: UploadField['id'] | null;
  rows?: number;
  max?: number;
  hint?: string;
}

const pinned = (p: Platform, label = 'Pinned comment'): FieldSpec => ({ key: `pinned.${p}`, label, copies: 'pinned', rows: 2, max: 150 });
const cover: FieldSpec = { key: 'coverText', label: 'Cover text', copies: 'cover', max: 40, hint: 'Same text for the TikTok and Instagram cover.' };

const FIELDS: Record<Platform, FieldSpec[]> = {
  youtube: [
    { key: 'title', label: 'Title', copies: 'title', max: 90 },
    { key: 'youtubeDescription', label: 'Description', copies: 'description', rows: 3, hint: 'Copy includes the hashtags and #Shorts.' },
    { key: 'hashtags', label: 'Hashtags', copies: null, hint: 'Also added to TikTok and Instagram captions that have none of their own.' },
    pinned('youtube'),
  ],
  tiktok: [{ key: 'tiktokCaption', label: 'Caption', copies: 'caption', rows: 4, max: 300 }, cover, pinned('tiktok')],
  instagram: [{ key: 'instagramCaption', label: 'Caption', copies: 'caption', rows: 4, max: 500 }, cover, pinned('instagram')],
  x: [{ key: 'xPost', label: 'Post', copies: 'post', rows: 4, max: 270 }, pinned('x', 'Reply to your post')],
};

const STAGE_LABEL: Record<string, string> = { frames: 'Rendering frames', audio: 'Rendering audio', mastering: 'Mastering', qc: 'Quality checks' };

/** On-screen text with {param} placeholders filled in (outcome ones like {winner} stay as they are). */
const fillParams = (s: string, params: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));

function valueOf(c: SocialCopy, k: FieldKey): string {
  if (k === 'hashtags') return c.hashtags.join(' ');
  if (k.startsWith('pinned.')) return c.pinnedComments?.[k.slice(7) as Platform] ?? '';
  return (c[k as keyof SocialCopy] as string | undefined) ?? '';
}

const ALL_KEYS: FieldKey[] = [...new Set(PLATFORMS.flatMap((p) => FIELDS[p].map((f) => f.key)))];
const valuesOf = (c: SocialCopy) => Object.fromEntries(ALL_KEYS.map((k) => [k, valueOf(c, k)])) as Record<FieldKey, string>;

/** Server patch for one field, built on the server's current copy. */
function patchFor(c: SocialCopy, k: FieldKey, v: string): Partial<SocialCopy> {
  if (k === 'hashtags') return { hashtags: v.split(/[\s,]+/).filter(Boolean) };
  if (k.startsWith('pinned.')) return { pinnedComments: { ...c.pinnedComments, [k.slice(7)]: v } };
  return { [k]: v };
}

/** Copy with the local edits applied, for the paste-ready text. */
function applyDraft(c: SocialCopy, d: Record<FieldKey, string>): SocialCopy {
  let out = { ...c };
  for (const k of ALL_KEYS) out = { ...out, ...patchFor(out, k, d[k]) };
  return out;
}

function EmojiButton({ suggested, onPick }: { suggested: string[]; onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="emoji-wrap" ref={ref}>
      {/* preventDefault keeps the text field's caret where it was. */}
      <button className="small" title="Insert emoji" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)}>
        😀
      </button>
      {open && (
        <div className="emoji-pop">
          {suggested.length > 0 && (
            <div className="emoji-suggested">
              <span className="hint">Fits this video</span>
              <div>
                {suggested.map((e) => (
                  <button key={e} className="emoji-chip" onMouseDown={(ev) => ev.preventDefault()} onClick={() => onPick(e)}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
          <EmojiPicker onEmojiClick={(d) => onPick(d.emoji)} theme={Theme.DARK} emojiStyle={EmojiStyle.NATIVE} lazyLoadEmojis width={340} height={380} previewConfig={{ showPreview: false }} />
        </div>
      )}
    </div>
  );
}

function CopyField({
  spec,
  value,
  copyText,
  disabled,
  suggested,
  onChange,
  onCommit,
  extra,
}: {
  spec: FieldSpec;
  value: string;
  copyText: string;
  disabled: boolean;
  suggested: string[];
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
  extra?: ReactNode;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const insert = (emoji: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + emoji + value.slice(end);
    onChange(next);
    onCommit(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };
  const props = { ref, value, disabled, onChange: (e: ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => onChange(e.target.value), onBlur: () => onCommit(value) };
  return (
    <div className="upload-field">
      <div className="field-head">
        <span>{spec.label}</span>
        {spec.max && <b className={value.length > spec.max ? 'warn' : ''}>{value.length}/{spec.max}</b>}
        <span className="spacer" />
        {extra}
        <EmojiButton suggested={suggested} onPick={insert} />
        <CopyButton text={copyText} />
      </div>
      {spec.rows ? <textarea rows={spec.rows} {...props} /> : <input {...props} />}
      {spec.hint && <p className="hint small-text">{spec.hint}</p>}
    </div>
  );
}

export function UploadPage({ id }: { id: string }) {
  const [item, setItem] = useState<ReviewItem | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<FieldKey, string> | null>(null);
  const server = useRef<Record<FieldKey, string> | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(0);

  useEffect(() => {
    setItem(null);
    setDraft(null);
    server.current = null;
    setNotes(null);
    // Reconnect if the server restarts (an error response closes an EventSource for good), unless
    // the item itself is gone.
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const stop = () => {
      closed = true;
      clearTimeout(timer);
      es?.close();
    };
    const open = () => {
      es = new EventSource(`/api/review/${id}/stream`);
      es.onmessage = (e) => setItem(JSON.parse(e.data));
      es.onerror = () => {
        api.item(id).catch((err: Error & { status?: number }) => {
          if (closed || err.status !== 404) return;
          setMissing(err.message);
          stop();
        });
        if (closed || es?.readyState !== EventSource.CLOSED) return;
        timer = setTimeout(open, 3000);
      };
    };
    open();
    return stop;
  }, [id]);

  // New copy from the server (Claude finished, or a save came back): take it for every field you
  // haven't changed locally since the last server version.
  const copyJson = JSON.stringify(item?.copy ?? null);
  useEffect(() => {
    if (!item?.copy) return;
    const next = valuesOf(item.copy);
    const prev = server.current;
    setDraft((d) => (d && prev ? (Object.fromEntries(ALL_KEYS.map((k) => [k, d[k] === prev[k] ? next[k] : d[k]])) as Record<FieldKey, string>) : next));
    server.current = next;
  }, [copyJson]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (item && notes === null) setNotes(item.concept?.notes ?? '');
  }, [item, notes]);

  if (missing) {
    return (
      <main className="upload">
        <a href="#/review">← Batches &amp; Review</a>
        <p className="warn">Couldn't load this video ({missing}).</p>
      </main>
    );
  }
  if (!item || !draft) {
    return (
      <main className="upload">
        <p className="hint">Loading…</p>
      </main>
    );
  }

  const template = findTemplate(item.recipe.templateId);
  const copy = item.copy!;
  const job = item.copyJob;
  const writing = (t: CopyTarget) => !!job?.running && (job.target === 'all' || job.target === t);
  const text = uploadText(applyDraft(copy, draft));
  const suggested = copy.emojis ?? [];
  const ready = item.status === 'ready' && item.files;
  const params = template ? (parseParams(template, item.recipe.params) as Record<string, unknown>) : item.recipe.params;

  const commit = async (k: FieldKey, v: string) => {
    if (!server.current || v === server.current[k]) return;
    setSaving((n) => n + 1);
    setError(null);
    try {
      const next = await api.editCopy(item.id, patchFor(copy, k, v));
      // Show the saved (normalized) value for this field, keep other local edits.
      const saved = valuesOf(next.copy!);
      server.current = saved;
      setDraft((d) => (d ? { ...d, [k]: saved[k] } : d));
      setItem(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving((n) => n - 1);
    }
  };

  const regenerate = async (target: CopyTarget | 'all') => {
    setError(null);
    try {
      setItem(await api.regenerateCopy(item.id, target, notes ?? ''));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const field = (p: Platform, spec: FieldSpec) => {
    const isCover = spec.key === 'coverText';
    const target: CopyTarget = isCover ? 'cover' : p;
    const copyText = spec.copies ? (text[p].fields.find((f) => f.id === spec.copies)?.text ?? '') : draft[spec.key];
    return (
      <CopyField
        key={spec.key}
        spec={spec}
        value={draft[spec.key]}
        copyText={copyText}
        disabled={writing(target)}
        suggested={suggested}
        onChange={(v) => setDraft((d) => (d ? { ...d, [spec.key]: v } : d))}
        onCommit={(v) => void commit(spec.key, v)}
        extra={
          isCover ? (
            <button className="small" disabled={!!job?.running} title="New cover text from Claude" onClick={() => regenerate('cover')}>
              {writing('cover') ? 'Writing…' : '↻'}
            </button>
          ) : undefined
        }
      />
    );
  };

  const needsAll = (job?.error && job.target === 'all') || copy.instagramCaption === undefined;

  return (
    <main className="upload">
      <div className="upload-inner">
        <div className="upload-top">
          <a href="#/review">← Batches &amp; Review</a>
          <h2>
            {template?.name ?? item.recipe.templateId}{' '}
            <span className="hint">
              · {item.export ? 'ready to upload' : item.status === 'failed' ? 'render failed' : ready ? 'bundling' : 'rendering'}
            </span>
          </h2>
          {saving > 0 && <span className="hint">Saving…</span>}
        </div>

        <div className="upload-media">
          <div className="upload-video">
            {ready ? (
              <video ref={previewVideoRef} src={`/files/${item.files!.final}`} poster={`/files/${item.files!.cover}`} controls playsInline />
            ) : (
              <div className="card-placeholder">
                {item.status === 'queued' && <span>Queued</span>}
                {item.status === 'rendering' && (
                  <>
                    <span>{STAGE_LABEL[item.stage ?? 'frames'] ?? 'Rendering'}</span>
                    <div className="progress">
                      <div style={{ width: `${Math.round((item.stage === 'frames' ? item.progress * 0.7 : 0.85) * 100)}%` }} />
                    </div>
                  </>
                )}
                {item.status === 'failed' && <span className="warn">Render failed{item.error ? `: ${item.error.slice(0, 160)}` : ''}</span>}
                {item.status === 'cancelled' && <span>Cancelled</span>}
              </div>
            )}
          </div>

          <div className="upload-side">
            <p className="small-text">
              On screen: <b>“{fillParams(copy.hook, params)}”</b> → <b>“{fillParams(copy.cta, params)}”</b>
            </p>
            {item.qc && (
              <p className={`small-text ${item.qc.pass ? 'ok' : 'warn'}`}>
                QC {item.qc.pass ? 'passed' : `failed: ${item.qc.problems.join('; ')}`}
                {item.durationS ? ` · ${item.durationS.toFixed(1)}s` : ''}
              </p>
            )}
            {item.export ? (
              <div className="row wrap">
                <a className="button primary" href={exportFileUrl(item.export.id, 'video.mp4')}>
                  Download MP4
                </a>
                <a className="button" href={exportFileUrl(item.export.id, 'cover.jpg')}>
                  Cover
                </a>
                <a className="button" href={exportFileUrl(item.export.id, 'bundle.zip')}>
                  Bundle .zip
                </a>
                <button onClick={() => api.reveal(item.export!.dir, 'exports')}>Show in Finder</button>
              </div>
            ) : (
              <p className="hint">{ready ? 'Writing the upload bundle…' : 'Downloads appear here once the video is rendered.'}</p>
            )}

            {job?.running && (
              <p className="writing">
                Claude is writing {job.target === 'all' ? 'the text for every platform' : job.target === 'cover' ? 'the cover text' : `the ${PLATFORM_LABEL[job.target]} text`}…
              </p>
            )}
            {job?.error && <p className="warn small-text">{job.error}</p>}
            {needsAll && !job?.running && (
              <button onClick={() => regenerate('all')}>{copy.instagramCaption === undefined ? 'Write the missing platforms with Claude' : 'Try Claude again'}</button>
            )}

            <label className="param">
              <span>Notes for Claude</span>
              <textarea rows={2} value={notes ?? ''} placeholder="Used when you regenerate, e.g. mention it's the rematch" onChange={(e) => setNotes(e.target.value)} />
            </label>

            <Posts item={item} onSaved={setItem} open />
          </div>
        </div>

        {error && <p className="warn">{error}</p>}

        <div className="platform-grid">
          {PLATFORMS.map((p) => (
            <section key={p} className={`platform-card${writing(p) ? ' busy' : ''}`}>
              <div className="platform-head">
                <h3>{PLATFORM_LABEL[p]}</h3>
                <span className="spacer" />
                <button className="small" disabled={!!job?.running} onClick={() => regenerate(p)}>
                  {writing(p) ? 'Writing…' : 'Regenerate'}
                </button>
                <CopyButton text={text[p].all} label="Copy all" />
              </div>
              {FIELDS[p].map((spec) => field(p, spec))}
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
