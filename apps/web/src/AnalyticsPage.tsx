import { useCallback, useEffect, useState } from 'react';
import { api, coverUrl, youtubeConnectUrl, type AnalyticsSettings, type LearningStatus, type TasteStatus, type PostReward, type PostView, type PostsResponse, type RefreshResult, type Upload, type YouTubeStatus } from './api';

const MATURE_H = 7 * 24;

const fmtInt = (n: number | undefined) => (n === undefined ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString());
const fmtPct = (n: number | undefined) => (n === undefined ? '–' : `${Math.round(n)}%`);
const fmtAge = (h: number) => (h < 48 ? `${Math.max(0, Math.round(h))}h` : `${Math.round(h / 24)}d`);
const fmtWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Message from the OAuth redirect (#/analytics?youtube=...). */
function oauthMessage(): string | null {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const v = q.get('youtube');
  if (!v) return null;
  history.replaceState(null, '', '#/analytics');
  if (v === 'connected') return 'YouTube connected.';
  if (v === 'missing_scopes') return 'Both permissions are needed (YouTube and YouTube Analytics). Connect again and tick both.';
  if (v === 'access_denied') return 'Connection cancelled.';
  return `YouTube connection failed: ${v}`;
}

export function AnalyticsPage() {
  const [status, setStatus] = useState<YouTubeStatus | null>(null);
  const [learning, setLearning] = useState<LearningStatus | null>(null);
  const [taste, setTaste] = useState<TasteStatus | null>(null);
  const [data, setData] = useState<PostsResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(oauthMessage);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, d, l, t] = await Promise.all([api.youtubeStatus(), api.posts(), api.learning(), api.taste()]);
      setStatus(s);
      setData(d);
      setLearning(l);
      setTaste(t);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const r = await api.refreshStats();
      setMessage(summarize(r));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
      load();
    }
  };

  const posts = data?.posts ?? [];

  return (
    <main className="review">
      <aside className="panel left">
        <section>
          <h3>YouTube</h3>
          <Connection status={status} refreshing={refreshing} onRefresh={refresh} onChanged={load} />
        </section>
        <section>
          <h3>Learning</h3>
          {learning && <Learning status={learning} postCount={posts.length} onChanged={load} />}
        </section>
        {data && (data.uploads.suggestions.length > 0 || data.uploads.unlinked.length > 0) && (
          <section>
            <h3>Uploads to link</h3>
            <UnlinkedUploads uploads={data.uploads} onChanged={setData} onError={setError} />
          </section>
        )}
      </aside>
      <section className="review-main">
        {message && (
          <div className="notice">
            {message} <button className="link" onClick={() => setMessage(null)}>Dismiss</button>
          </div>
        )}
        {error && <div className="warnings">{error}</div>}
        {taste && <TastePanel taste={taste} />}
        <PostsTable posts={posts} connected={Boolean(status?.connected)} onChanged={load} />
      </section>
    </main>
  );
}

/**
 * What Review decisions have taught the taste model: per template, how often you approve it, why
 * you reject it, and which of its settings you like or dislike.
 */
function TastePanel({ taste }: { taste: TasteStatus }) {
  const label = (id: string) => taste.reasons.find((r) => r.id === id)?.label ?? id;
  const rows = taste.templates.filter((t) => t.liked + t.rejected + t.skipped > 0);
  return (
    <div className="taste-panel">
      <h3>Your taste</h3>
      <p className="hint">
        Learned from {taste.examples} review decisions ({taste.liked} liked, including Playground exports). Unpicked videos in a reviewed batch count as a mild no after a day.{' '}
        {taste.ready ? (
          <b className="ok">Steering batch settings, templates and ranking until YouTube results take over.</b>
        ) : (
          `Needs ${Math.max(0, taste.readyAt - taste.examples)} more decisions before it steers batches.`
        )}
      </p>
      <table className="taste-table">
        <thead>
          <tr>
            <th>Template</th>
            <th>Liked / no</th>
            <th>Why rejected</th>
            <th>What it's learned about the settings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const no = t.rejected + t.skipped;
            const reasons = Object.entries(t.reasons).sort((a, b) => b[1] - a[1]);
            return (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <div className="taste-bar" title={`${t.liked} liked · ${t.rejected} rejected/re-rolled · ${t.skipped} passed over`}>
                    <div className="yes" style={{ flex: t.liked }} />
                    <div className="no" style={{ flex: t.rejected }} />
                    <div className="skip" style={{ flex: t.skipped }} />
                  </div>
                  <span className="hint small-text">
                    {t.liked} / {no}
                  </span>
                </td>
                <td className="small-text">{reasons.length ? reasons.map(([id, n]) => `${label(id)} ×${n}`).join(', ') : <span className="hint">—</span>}</td>
                <td className="small-text">
                  {t.settings.length ? (
                    t.settings.map((x) => (
                      <div key={x.text} className={`${x.direction === 'up' ? 'pos' : 'neg'} ${x.sure ? '' : 'leaning'}`} title={x.sure ? 'Fairly sure' : 'Leaning this way, not sure yet'}>
                        {x.direction === 'up' ? '▲' : '▼'} {x.text}
                        {!x.sure && <span className="hint"> (leaning)</span>}
                      </div>
                    ))
                  ) : (
                    <span className="hint">not sure yet</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Learning({ status, postCount, onChanged }: { status: LearningStatus; postCount: number; onChanged: () => void }) {
  const [settings, setSettings] = useState<AnalyticsSettings | null>(null);
  useEffect(() => {
    api.analyticsSettings().then(setSettings).catch(() => {});
  }, []);
  const left = Math.max(0, status.readyAt - status.matured);
  const cal = status.calibration;
  return (
    <div className="learning">
      <p className="hint">
        {postCount} linked post{postCount === 1 ? '' : 's'} · {status.matured} with a full {status.horizonDays} days of data.
      </p>
      {status.ready ? (
        <p>
          <b className="ok">Steering batches.</b> <span className="hint">Fitted on {status.scored} posts; about a fifth of each batch is experiments.</span>
        </p>
      ) : (
        <>
          <div className="progress" title={`${status.matured} / ${status.readyAt}`}>
            <div style={{ width: `${(Math.min(status.matured, status.readyAt) / status.readyAt) * 100}%` }} />
          </div>
          <p className="hint">
            {left} more mature post{left === 1 ? '' : 's'} until YouTube results start steering batches. Until then, your Review decisions do (see Your taste).
          </p>
        </>
      )}
      {cal.n >= 5 && Number.isFinite(cal.model) && (
        <p className="hint" title="Rank agreement (Spearman) between what was predicted at export and what happened, over the last 20 mature posts. 1 = perfect order, 0 = no better than chance.">
          Prediction accuracy (last {cal.n}): <b>{cal.model.toFixed(2)}</b>
          {Number.isFinite(cal.dramaBaseline) ? ` vs ${cal.dramaBaseline.toFixed(2)} for drama score alone` : ''}
        </p>
      )}
      {settings && (
        <label className="param">
          <span>Success means</span>
          <select
            value={settings.preset}
            onChange={async (e) => {
              setSettings(await api.setAnalyticsSettings({ preset: e.target.value }));
              onChanged();
            }}
          >
            {Object.entries(settings.presets).map(([id, p]) => (
              <option key={id} value={id}>
                {p.label} ({weightsText(p.weights)})
              </option>
            ))}
            {settings.preset === 'custom' && <option value="custom">Custom ({weightsText(settings.weights)})</option>}
          </select>
        </label>
      )}
    </div>
  );
}

const weightsText = (w: Record<string, number>) => `retention ${pct(w.retention)} · reach ${pct(w.reach)} · engagement ${pct(w.engagement)} · followers ${pct(w.followers)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

function summarize(r: RefreshResult): string {
  const parts = [`Updated ${r.updated} post${r.updated === 1 ? '' : 's'}`];
  if (r.synced?.autoLinked) parts.push(`linked ${r.synced.autoLinked} new upload${r.synced.autoLinked === 1 ? '' : 's'}`);
  if (r.retention) parts.push(`${r.retention} retention curve${r.retention === 1 ? '' : 's'}`);
  if (r.errors.length) parts.push(`${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}: ${r.errors[0]}`);
  return parts.join(' · ') + '.';
}

function Connection({ status, refreshing, onRefresh, onChanged }: { status: YouTubeStatus | null; refreshing: boolean; onRefresh: () => void; onChanged: () => void }) {
  if (!status) return <p className="hint">Loading…</p>;
  if (!status.configured)
    return (
      <div className="hint">
        <p>
          Not set up yet. Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code>, then restart the server.
        </p>
        <p>
          Step-by-step: <code>docs/youtube-setup.md</code>
        </p>
      </div>
    );
  if (status.needsReconnect || !status.connected)
    return (
      <div>
        {status.needsReconnect && <p className="warn">YouTube access expired or was revoked.</p>}
        <a className="button primary" href={youtubeConnectUrl()}>
          {status.needsReconnect ? 'Reconnect YouTube' : 'Connect YouTube'}
        </a>
        <p className="hint">Read-only access to your channel's videos and analytics.</p>
      </div>
    );
  const last = status.lastRefresh;
  return (
    <div className="yt-connected">
      <div className="yt-channel">
        {status.channel?.thumbnail && <img src={status.channel.thumbnail} alt="" />}
        <b>{status.channel?.title ?? 'Connected'}</b>
      </div>
      <button className="primary" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? 'Refreshing…' : 'Refresh stats'}
      </button>
      <p className="hint">
        {last ? `Last refreshed ${fmtWhen(last.at)}.` : 'Never refreshed.'} Stats also refresh when you start a batch. Watch-time numbers lag about two days behind views.
      </p>
      <button
        className="link"
        onClick={async () => {
          if (!confirm('Disconnect YouTube? Stats already collected are kept.')) return;
          await api.youtubeDisconnect();
          onChanged();
        }}
      >
        Disconnect
      </button>
    </div>
  );
}

function UnlinkedUploads({ uploads, onChanged, onError }: { uploads: PostsResponse['uploads']; onChanged: (d: PostsResponse) => void; onError: (e: string) => void }) {
  const [linkable, setLinkable] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    api.linkable().then(setLinkable).catch(() => {});
  }, [uploads]);
  const act = (p: Promise<PostsResponse>) => p.then(onChanged).catch((e) => onError((e as Error).message));
  return (
    <div className="uploads">
      <p className="hint">Uploads that didn't match an exported video's title exactly.</p>
      {uploads.suggestions.map((s) => (
        <div key={s.upload.videoId} className="upload">
          <UploadHead u={s.upload} />
          <div className="hint">Looks like: “{s.renderTitle}”</div>
          <div className="row">
            <button className="primary" onClick={() => act(api.linkUpload(s.upload.videoId, s.upload.publishedAt, s.renderId))}>
              Link
            </button>
            <ManualLink upload={s.upload} linkable={linkable} onLink={(id) => act(api.linkUpload(s.upload.videoId, s.upload.publishedAt, id))} />
            <button onClick={() => act(api.ignoreUpload(s.upload.videoId))}>Ignore</button>
          </div>
        </div>
      ))}
      {uploads.unlinked.map((u) => (
        <div key={u.videoId} className="upload">
          <UploadHead u={u} />
          <div className="row">
            <ManualLink upload={u} linkable={linkable} onLink={(id) => act(api.linkUpload(u.videoId, u.publishedAt, id))} />
            <button onClick={() => act(api.ignoreUpload(u.videoId))} title="Not made with Sim Studio, or not worth tracking">
              Ignore
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function UploadHead({ u }: { u: Upload }) {
  return (
    <div className="upload-head">
      {u.thumbnail && <img src={u.thumbnail} alt="" />}
      <div>
        <a href={`https://www.youtube.com/shorts/${u.videoId}`} target="_blank" rel="noreferrer">
          {u.title}
        </a>
        <div className="hint">{fmtWhen(u.publishedAt)}</div>
      </div>
    </div>
  );
}

function ManualLink({ upload, linkable, onLink }: { upload: Upload; linkable: { id: string; title: string }[]; onLink: (renderId: string) => void }) {
  if (!linkable.length) return null;
  return (
    <select value="" onChange={(e) => e.target.value && onLink(e.target.value)} aria-label={`Link ${upload.title} to an exported video`}>
      <option value="">Link to…</option>
      {linkable.map((r) => (
        <option key={r.id} value={r.id}>
          {r.title || r.id}
        </option>
      ))}
    </select>
  );
}

function PostsTable({ posts, connected, onChanged }: { posts: PostView[]; connected: boolean; onChanged: () => void }) {
  if (!posts.length)
    return (
      <div className="empty">
        <h2>No posts yet</h2>
        <p className="hint">
          Export approved videos from Batches &amp; Review and upload them to YouTube with the exported title. {connected ? 'Refresh stats' : 'Once YouTube is connected, Refresh stats'} links them
          automatically. You can also paste a video's link under “Posted” on its review card.
        </p>
      </div>
    );
  return (
    <div className="table-wrap">
      <table className="posts-table">
        <thead>
          <tr>
            <th />
            <th>Video</th>
            <th>Age</th>
            <th title="How this post did vs your channel, in typical post-to-post swings (0 = average). Final at 7 days; younger posts are marked early.">Score</th>
            <th title="What the learner expected when it was exported">Predicted</th>
            <th title="Live view count">Views</th>
            <th title="Average percentage viewed (can exceed 100% when people rewatch)">Avg % viewed</th>
            <th title="Average view duration">Avg watched</th>
            <th>Likes</th>
            <th>Comments</th>
            <th>Shares</th>
            <th title="Subscribers gained minus lost">Subs</th>
            <th title="From YouTube Studio → Analytics → this Short: 'Stayed to watch'. Optional, not available through the API.">Stayed %</th>
            <th title="Audience retention curve">Curve</th>
          </tr>
        </thead>
        <tbody>
          {posts.map((p) => (
            <PostRow key={p.renderId} p={p} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const fmtZ = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;
const COMPONENT_LABEL = { retention: 'Retention', reach: 'Reach', engagement: 'Engagement', followers: 'Followers' } as const;

function RewardCell({ r }: { r: PostReward | null }) {
  if (!r || r.reward === null) return <span className="hint">{r?.reason ?? '–'}</span>;
  const tip = (Object.keys(COMPONENT_LABEL) as (keyof typeof COMPONENT_LABEL)[])
    .filter((k) => r.components[k] !== undefined)
    .map((k) => `${COMPONENT_LABEL[k]} ${fmtZ(r.components[k]!)}`)
    .join('\n');
  return (
    <span className={`reward ${r.reward >= 0 ? 'pos' : 'neg'}${r.provisional ? ' early' : ''}`} title={`${tip}${r.provisional ? '\nEarly: not 7 days old yet, so it counts for less' : ''}`}>
      {fmtZ(r.reward)}
      {r.provisional && <small> early</small>}
    </span>
  );
}

function PostRow({ p, onChanged }: { p: PostView; onChanged: () => void }) {
  const m = p.metrics;
  const cover = coverUrl(p.cover);
  const [stayed, setStayed] = useState(p.manual.stayedPct?.toString() ?? '');
  useEffect(() => setStayed(p.manual.stayedPct?.toString() ?? ''), [p.manual.stayedPct]);
  const saveStayed = async () => {
    const v = stayed.trim() === '' ? null : Number(stayed);
    if (v === (p.manual.stayedPct ?? null)) return;
    await api.setManual(p.renderId, { stayedPct: v });
    onChanged();
  };
  const subs = m.subscribersGained !== undefined ? m.subscribersGained - (m.subscribersLost ?? 0) : undefined;
  return (
    <tr className={p.ageH < MATURE_H ? 'young' : ''}>
      <td className="thumb">{cover && <img src={cover} alt="" />}</td>
      <td className="title">
        <a href={p.url} target="_blank" rel="noreferrer">
          {p.title || p.hook || p.renderId}
        </a>
        <div className="hint">
          {p.templateId}
          {p.arm ? ` · ${p.arm.themeId} · ${p.arm.hookStyle}` : ''}
          {p.experiment ? ' · experiment' : ''}
          {p.snapshots === 0 ? ' · waiting for first refresh' : ''}
        </div>
      </td>
      <td title={fmtWhen(p.publishedAt)}>{fmtAge(p.ageH)}</td>
      <td>
        <RewardCell r={p.reward} />
      </td>
      <td>{p.predicted ? fmtZ(p.predicted.mean) : <span className="hint">–</span>}</td>
      <td>{fmtInt(m.views)}</td>
      <td>{fmtPct(m.averageViewPercentage)}</td>
      <td>{m.averageViewDuration === undefined ? '–' : `${Math.round(m.averageViewDuration)}s`}</td>
      <td>{fmtInt(m.likes)}</td>
      <td>{fmtInt(m.comments)}</td>
      <td>{fmtInt(m.shares)}</td>
      <td>{subs === undefined ? '–' : subs}</td>
      <td>
        <input className="stayed" inputMode="decimal" value={stayed} placeholder="–" onChange={(e) => setStayed(e.target.value)} onBlur={saveStayed} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </td>
      <td>{p.retention ? (p.retention.ageH >= MATURE_H ? '✓' : '◐') : p.ageH < 72 ? <span className="hint">at 3d</span> : '–'}</td>
    </tr>
  );
}
