import { useState } from 'react';
import { findTemplate } from '@sim/templates';
import { SOURCE_INFO, api, formatBytes, previewVideoRef, type LibraryEntry } from './api';

type Group = 'all' | 'batch' | 'playground' | 'cli' | 'ambient';

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const length = (s: number) => (s >= 600 ? `${Math.floor(s / 3600)}:${String(Math.round((s % 3600) / 60)).padStart(2, '0')} h` : `${s.toFixed(1)}s`);

function templateName(id: string | undefined) {
  return id ? (findTemplate(id)?.name ?? id) : 'Unknown';
}

function LibraryCard({ e, onOpenBatch, onDeleted }: { e: LibraryEntry; onOpenBatch: (id: string) => void; onDeleted: () => void }) {
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = SOURCE_INFO[e.source];
  return (
    <article className="card lib-card">
      <div className="card-media lib-media" onClick={() => setPlaying(true)}>
        {playing ? (
          <video
            src={`/files/${e.dir}/final.mp4`}
            autoPlay
            controls
            playsInline
            ref={previewVideoRef}
          />
        ) : e.hasCover ? (
          <img src={`/files/${e.dir}/${e.cover ?? 'cover.jpg'}`} alt="" loading="lazy" />
        ) : (
          <div className="card-placeholder">▶</div>
        )}
      </div>
      <div className="card-body">
        <div className="card-head">
          <span className={`badge src src-${info.group}`} title={info.help}>
            {info.label}
          </span>
          {e.qcPass !== null && <span className={`badge ${e.qcPass ? 'ok-badge' : 'warn-badge'}`}>{e.qcPass ? 'QC ✓' : 'QC ✗'}</span>}
          {e.decision && e.decision !== 'pending' && <span className={`badge decision ${e.decision}`}>{e.decision}</span>}
        </div>
        <span className="tname">{templateName(e.recipe?.templateId)}</span>
        {e.hook && <p className="hook small-text">“{e.hook}”</p>}
        <p className="hint meta">
          {when(e.createdAt)}
          {e.durationS ? ` · ${length(e.durationS)}` : ''} · {formatBytes(e.sizeBytes)}
          {e.recipe ? (e.source === 'ambient' ? ` · seed ${e.recipe.seed}` : ` · ${e.recipe.themeId} · seed ${e.recipe.seed}`) : ''}
        </p>
        {e.batchId && e.source === 'batch' && <p className="hint meta">From the batch of {e.batchCreatedAt ? when(e.batchCreatedAt) : '—'}</p>}
        <div className="row wrap">
          <a className="button small" href={`/api/download?path=${encodeURIComponent(`${e.dir}/final.mp4`)}`}>
            Download
          </a>
          <button className="small" onClick={() => api.reveal(`${e.dir}/final.mp4`)}>
            Show in Finder
          </button>
          {e.batchId && (
            <button className="small" onClick={() => onOpenBatch(e.batchId!)}>
              {e.source === 'batch' ? 'Open batch' : 'Open in review'}
            </button>
          )}
          <button
            className="small danger"
            onClick={async () => {
              const exported = e.decision === 'approved' ? ' It is approved; any exported copy in data/exports is kept.' : '';
              if (!confirm(`Delete this render from disk?${exported}`)) return;
              try {
                await api.deleteRender(e.dir);
                onDeleted();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            Delete
          </button>
        </div>
        {error && <p className="warn">{error}</p>}
      </div>
    </article>
  );
}

/** Every render on disk, labelled by where it came from. */
export function LibraryView({ entries, onOpenBatch, onChanged }: { entries: LibraryEntry[]; onOpenBatch: (id: string) => void; onChanged: () => void }) {
  const [group, setGroup] = useState<Group>('all');
  const groups: { id: Group; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'batch', label: 'Batches' },
    { id: 'playground', label: 'Playground' },
    { id: 'cli', label: 'Command line' },
    { id: 'ambient', label: 'Long-form' },
  ];
  const inGroup = (e: LibraryEntry, g: Group) => g === 'all' || SOURCE_INFO[e.source].group === g;
  const shown = entries.filter((e) => inGroup(e, group));
  return (
    <>
      <header className="batch-head">
        <div>
          <h2>All renders</h2>
          <p className="hint">Every video in data/renders, labelled by where it was made. Click a thumbnail to play.</p>
        </div>
      </header>
      <div className="chips lib-filters">
        {groups.map((g) => {
          const items = entries.filter((e) => inGroup(e, g.id));
          const bytes = items.reduce((s, e) => s + e.sizeBytes, 0);
          return (
            <button key={g.id} className={`chip${group === g.id ? ' on' : ''}`} onClick={() => setGroup(g.id)}>
              {g.label} ({items.length}{items.length ? ` · ${formatBytes(bytes)}` : ''})
            </button>
          );
        })}
      </div>
      <p className="hint legend">
        <span className="badge src src-batch">Batch</span> made by a batch run ·{' '}
        <span className="badge src src-playground">Playground → Review</span> / <span className="badge src src-playground">Playground export</span> made by you in the Playground ·{' '}
        <span className="badge src src-cli">Command line</span> made with npm run render ·{' '}
        <span className="badge src src-ambient">Long-form</span> ambient videos from the Ambient tab (copy and progress live there)
      </p>
      {shown.length === 0 ? (
        <p className="hint">No renders here yet.</p>
      ) : (
        <div className="grid lib-grid">
          {shown.map((e) => (
            <LibraryCard key={e.dir} e={e} onOpenBatch={onOpenBatch} onDeleted={onChanged} />
          ))}
        </div>
      )}
    </>
  );
}
