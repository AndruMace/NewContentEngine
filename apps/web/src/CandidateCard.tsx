import { useEffect, useState } from 'react';
import { THEMES } from '@sim/engine';
import { MELODIES } from '@sim/audio';
import { findTemplate } from '@sim/templates';
import { api, exportFileUrl, previewVideoRef, type ReviewItem, type SocialCopy } from './api';

const SOURCE_LABEL: Record<string, string> = { claude: 'Claude', fallback: 'Template defaults', mock: 'Mock (dry run)', manual: 'You (Playground)' };
const HOOK_STYLE_LABEL: Record<string, string> = { question: 'Question', challenge: 'Challenge', 'pick-a-side': 'Pick a side', curiosity: 'Curiosity' };
const PLATFORM_LABEL = { youtube: 'YouTube', tiktok: 'TikTok', x: 'X' } as const;
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

const fmtSigned = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;

export function CandidateCard({ item, rank, onChanged }: { item: ReviewItem; rank: number; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const template = findTemplate(item.recipe.templateId);
  const ready = item.status === 'ready' && item.files;

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
          <video ref={previewVideoRef} src={`/files/${item.files!.final}`} poster={`/files/${item.files!.cover}`} preload="none" controls playsInline />
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
          <span className="tname">{template?.name ?? `${item.recipe.templateId} (removed)`}</span>
          {item.score !== null && <span className="badge score-badge">drama {Math.round(item.score * 100)}</span>}
          {item.qc && <span className={`badge ${item.qc.pass ? 'ok-badge' : 'warn-badge'}`} title={item.qc.problems.join('; ')}>{item.qc.pass ? 'QC ✓' : 'QC ✗'}</span>}
          {item.concept?.experiment && (
            <span className="badge exp-badge" title={`${item.concept.experiment.reason}. Experiments test choices the channel has little data on, so approving some of them keeps the learning honest.`}>
              Experiment
            </span>
          )}
          {item.decision !== 'pending' && <span className={`badge decision ${item.decision}`}>{item.decision}</span>}
        </div>
        {(item.prediction || item.concept?.experiment) && (
          <p className="prediction">
            {item.prediction && (
              <span title="What the learner expects from this video, in typical post-to-post swings relative to your channel's average. ± is its uncertainty.">
                Predicted <b className={item.prediction.mean >= 0 ? 'pos' : 'neg'}>{fmtSigned(item.prediction.mean)}</b> ± {item.prediction.sd.toFixed(1)} vs your average
              </span>
            )}
            {item.concept?.experiment && <span className="hint"> {item.prediction ? '· ' : ''}{item.concept.experiment.reason}</span>}
          </p>
        )}
        <p className="hook">“{item.copy?.hook ?? item.recipe.copy?.hook ?? template?.defaultCopy.hook}”</p>
        {item.copy && (
          <div className="post-preview" title="What gets published">
            <p className="post-title">{item.copy.title}</p>
            {item.copy.youtubeDescription && <p className="hint post-desc">{item.copy.youtubeDescription.split('\n')[0]}</p>}
            {item.copy.hashtags.length > 0 && (
              <div className="tags">
                {item.copy.hashtags.map((h) => (
                  <span key={h} className="tag">
                    {h}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
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

        {item.platformText && (
          <details className="captions-box">
            <summary>Captions</summary>
            {(['youtube', 'tiktok', 'x'] as const).map((p) => (
              <div key={p} className="caption-full">
                <div className="caption-full-head">
                  <span>{PLATFORM_LABEL[p]}</span>
                  <CopyButton text={item.platformText![p]} />
                </div>
                <pre>{item.platformText![p]}</pre>
              </div>
            ))}
          </details>
        )}

        <details className="planner-details">
          <summary>Planner details (internal, not published)</summary>
          <dl>
            <dt>Theme</dt>
            <dd>{THEMES.find((t) => t.id === item.recipe.themeId)?.name ?? item.recipe.themeId}</dd>
            <dt>Music</dt>
            <dd>{template?.ownMusic ? 'Generated by the template' : (MELODIES.find((m) => m.id === item.recipe.melodyId)?.title ?? item.recipe.melodyId)}</dd>
            <dt>Length</dt>
            <dd>{item.durationS ? `${item.durationS.toFixed(1)}s` : item.recipe.targetS ? `~${item.recipe.targetS}s target` : '—'}</dd>
            <dt>Seed</dt>
            <dd>{item.recipe.seed}</dd>
            {item.concept && (
              <>
                <dt>Copy written by</dt>
                <dd>{SOURCE_LABEL[item.concept.source] ?? item.concept.source}</dd>
                <dt>Hook strategy</dt>
                <dd>{HOOK_STYLE_LABEL[item.concept.arm.hookStyle] ?? item.concept.arm.hookStyle}</dd>
              </>
            )}
            {item.concept?.rationale && (
              <>
                <dt>Planner's note</dt>
                <dd>{item.concept.rationale}</dd>
              </>
            )}
          </dl>
        </details>

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
