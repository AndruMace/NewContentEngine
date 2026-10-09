import { useEffect, useRef, useState } from 'react';
import { getTemplate } from '@sim/templates';
import { api, exportFileUrl, previewVolume, type ReviewItem, type SocialCopy } from './api';

const SOURCE_LABEL: Record<string, string> = { claude: 'Claude', fallback: 'Template copy', mock: 'Mock', manual: 'Manual' };
const STAGE_LABEL: Record<string, string> = { frames: 'Rendering frames', audio: 'Rendering audio', mastering: 'Mastering', qc: 'Quality checks' };

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="small"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'Copied!' : label}
    </button>
  );
}

function CopyEditor({ item, onSaved }: { item: ReviewItem; onSaved: (r: ReviewItem) => void }) {
  const [draft, setDraft] = useState<SocialCopy | null>(item.copy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(item.copy), [item.id, item.copy]);
  if (!draft || !item.copy) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(item.copy);
  const onScreen = draft.hook !== item.copy.hook || draft.cta !== item.copy.cta;
  const field = (key: keyof SocialCopy, label: string, rows = 1, max?: number) => (
    <label className="param" key={key}>
      <span>
        {label}
        {max && <b className={String(draft[key]).length > max ? 'warn' : ''}>{String(draft[key]).length}/{max}</b>}
      </span>
      {rows > 1 ? (
        <textarea rows={rows} value={draft[key] as string} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      ) : (
        <input value={draft[key] as string} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      )}
    </label>
  );
  return (
    <details className="copy-editor">
      <summary>Edit copy</summary>
      {field('hook', 'Hook (on screen)', 1, 60)}
      {field('cta', 'Call to action (on screen)', 1, 48)}
      {field('title', 'YouTube title', 1, 90)}
      {field('youtubeDescription', 'YouTube description', 2)}
      {field('tiktokCaption', 'TikTok caption', 3, 300)}
      {field('xPost', 'X post', 3, 270)}
      <label className="param">
        <span>Hashtags</span>
        <input value={draft.hashtags.join(' ')} onChange={(e) => setDraft({ ...draft, hashtags: e.target.value.split(/[\s,]+/).filter(Boolean) })} />
      </label>
      {dirty && (
        <div className="row">
          <button
            className="primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                onSaved(await api.editCopy(item.id, draft));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            {onScreen ? 'Save & re-render' : 'Save'}
          </button>
          <button onClick={() => setDraft(item.copy)}>Discard</button>
        </div>
      )}
      {onScreen && dirty && <p className="hint">Hook and CTA are drawn into the video, so changing them renders a new version.</p>}
      {error && <p className="warn">{error}</p>}
    </details>
  );
}

function Posts({ item, onSaved }: { item: ReviewItem; onSaved: (r: ReviewItem) => void }) {
  const urls = Object.fromEntries(item.posts.map((p) => [p.platform, p.url]));
  const [vals, setVals] = useState<Record<string, string>>(urls);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setVals(Object.fromEntries(item.posts.map((p) => [p.platform, p.url]))), [item.posts]);
  return (
    <details className="posts" open={item.posts.length > 0}>
      <summary>Posted ({item.posts.length}/3)</summary>
      {(['youtube', 'tiktok', 'x'] as const).map((platform) => (
        <label className="param" key={platform}>
          <span>{platform === 'x' ? 'X' : platform === 'youtube' ? 'YouTube' : 'TikTok'} URL</span>
          <input
            value={vals[platform] ?? ''}
            placeholder="Paste the post URL after uploading"
            onChange={(e) => setVals({ ...vals, [platform]: e.target.value })}
            onBlur={async () => {
              if ((vals[platform] ?? '') === (urls[platform] ?? '')) return;
              setError(null);
              try {
                onSaved(await api.setPost(item.id, platform, vals[platform] ?? ''));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        </label>
      ))}
      {error && <p className="warn">{error}</p>}
    </details>
  );
}

export function CandidateCard({ item, rank, onChanged }: { item: ReviewItem; rank: number; onChanged: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const template = getTemplate(item.recipe.templateId);
  const ready = item.status === 'ready' && item.files;

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = previewVolume();
  });

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`card decision-${item.decision}`}>
      <div className="card-media">
        {ready ? (
          <video ref={videoRef} src={`/files/${item.files!.final}`} poster={`/files/${item.files!.cover}`} preload="none" controls playsInline />
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
            {item.status === 'failed' && <span className="warn">Render failed</span>}
            {item.status === 'cancelled' && <span>Cancelled</span>}
          </div>
        )}
      </div>
      <div className="card-body">
        <div className="card-head">
          <span className="rank">#{rank}</span>
          <span className="tname">{template.name}</span>
          {item.score !== null && <span className="badge score-badge">drama {Math.round(item.score * 100)}</span>}
          {item.qc && <span className={`badge ${item.qc.pass ? 'ok-badge' : 'warn-badge'}`} title={item.qc.problems.join('; ')}>{item.qc.pass ? 'QC ✓' : 'QC ✗'}</span>}
          {item.decision !== 'pending' && <span className={`badge decision ${item.decision}`}>{item.decision}</span>}
        </div>
        <p className="hook">“{item.copy?.hook ?? item.recipe.copy?.hook ?? template.defaultCopy.hook}”</p>
        <p className="hint meta">
          {item.recipe.themeId} · {item.recipe.melodyId}
          {item.durationS ? ` · ${item.durationS.toFixed(1)}s` : item.recipe.targetS ? ` · ~${item.recipe.targetS}s` : ''}
          {item.concept ? ` · ${SOURCE_LABEL[item.concept.source] ?? item.concept.source} · ${item.concept.arm.hookStyle}` : ''}
        </p>
        {item.concept?.rationale && <p className="hint rationale">{item.concept.rationale}</p>}
        {item.status === 'failed' && item.error && <p className="warn small-text">{item.error.slice(0, 200)}</p>}
        {item.qc && !item.qc.pass && <p className="warn small-text">{item.qc.problems.join('; ')}</p>}

        <div className="row wrap">
          <button className={item.decision === 'approved' ? 'primary' : ''} disabled={!ready || !!busy} onClick={() => act('approve', () => api.decide(item.id, item.decision === 'approved' ? 'pending' : 'approved'))}>
            {item.decision === 'approved' ? '✓ Approved' : 'Approve'}
          </button>
          <button className={item.decision === 'rejected' ? 'danger' : ''} disabled={!!busy || item.status === 'queued' || item.status === 'rendering'} onClick={() => act('reject', () => api.decide(item.id, item.decision === 'rejected' ? 'pending' : 'rejected'))}>
            {item.decision === 'rejected' ? '✗ Rejected' : 'Reject'}
          </button>
          <select
            value=""
            disabled={!!busy || item.status === 'queued' || item.status === 'rendering'}
            onChange={(e) => {
              const kind = e.target.value as 'seed' | 'copy' | 'concept';
              if (kind) void act('reroll', () => api.reroll(item.id, kind));
            }}
          >
            <option value="">{busy === 'reroll' ? 'Re-rolling…' : 'Re-roll…'}</option>
            <option value="seed">Different run (same idea)</option>
            <option value="copy">New copy (same run)</option>
            <option value="concept">New concept</option>
          </select>
        </div>

        {ready && (
          <div className="export-box">
            {item.export ? (
              <>
                <div className="row wrap">
                  <a className="button primary" href={exportFileUrl(item.export.id, 'video.mp4')}>
                    Download MP4
                  </a>
                  <a className="button" href={exportFileUrl(item.export.id, 'bundle.zip')}>
                    Bundle .zip
                  </a>
                  <a className="button" href={exportFileUrl(item.export.id, 'cover.jpg')}>
                    Cover
                  </a>
                  <button onClick={() => api.reveal(item.export!.dir, 'exports')}>Show in Finder</button>
                </div>
                {item.platformText && (
                  <div className="captions">
                    {(['youtube', 'tiktok', 'x'] as const).map((p) => (
                      <div key={p} className="caption-row">
                        <span>{p === 'x' ? 'X' : p === 'youtube' ? 'YouTube' : 'TikTok'}</span>
                        <code title={item.platformText![p]}>{item.platformText![p].split('\n')[0]}</code>
                        <CopyButton text={item.platformText![p]} />
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <button className="wide" disabled={!!busy} onClick={() => act('export', () => api.exportBundle(item.id))}>
                {busy === 'export' ? 'Exporting…' : 'Export for upload (approves it)'}
              </button>
            )}
          </div>
        )}

        <CopyEditor item={item} onSaved={onChanged} />
        {item.export && <Posts item={item} onSaved={onChanged} />}
        {error && <p className="warn">{error}</p>}
      </div>
    </article>
  );
}
