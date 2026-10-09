import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatBytes, type Batch, type Snapshot } from './api';
import { BatchLauncher } from './BatchLauncher';
import { CandidateCard } from './CandidateCard';

const ACTIVE = new Set(['planning', 'searching', 'rendering']);
const STATUS_LABEL: Record<string, string> = {
  planning: 'Planning concepts',
  searching: 'Searching seeds',
  rendering: 'Rendering',
  done: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
  manual: 'Manual adds',
};

function batchTitle(b: Batch) {
  const d = new Date(b.createdAt);
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return b.status === 'manual' ? `${day} · Manual` : `${day}, ${time}`;
}

function useBatchStream(id: string | null) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  useEffect(() => {
    setSnap(null);
    if (!id) return;
    const es = new EventSource(`/api/batches/${id}/stream`);
    es.onmessage = (e) => setSnap(JSON.parse(e.data));
    return () => es.close();
  }, [id]);
  return snap;
}

export function ReviewPage() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState({ claude: false, busy: false });
  const [storage, setStorage] = useState<{ rendersBytes: number; exportsBytes: number } | null>(null);
  const [days, setDays] = useState(7);
  const [cleanMsg, setCleanMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const snap = useBatchStream(selected);
  const prevStatus = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const [list, st] = await Promise.all([api.batches(), api.status()]);
    setBatches(list);
    setStatus(st);
    setSelected((cur) => cur ?? list.find((b) => b.status !== 'manual')?.id ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void refresh();
    api.storage().then(setStorage).catch(() => {});
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // Batch finished: browser notification + tab title until the tab is focused.
  useEffect(() => {
    const st = snap?.batch.status ?? null;
    if (prevStatus.current && ACTIVE.has(prevStatus.current) && st === 'done') {
      const ready = snap!.items.filter((i) => i.status === 'ready').length;
      document.title = `✓ ${ready} ready — Sim Studio`;
      if ('Notification' in window && Notification.permission === 'granted') new Notification('Sim Studio', { body: `Batch done: ${ready} videos ready to review` });
      const reset = () => {
        document.title = 'Sim Studio';
        window.removeEventListener('focus', reset);
      };
      window.addEventListener('focus', reset);
      void refresh();
      api.storage().then(setStorage).catch(() => {});
    }
    prevStatus.current = st;
  }, [snap, refresh]);

  const b = snap?.batch;
  const active = b && ACTIVE.has(b.status);
  const items = (snap?.items ?? []).filter((i) => filter === 'all' || i.decision === filter);
  const approved = snap?.items.filter((i) => i.decision === 'approved').length ?? 0;
  const done = (snap?.counts.ready ?? 0) + (snap?.counts.failed ?? 0);
  const total = Math.max(b?.target ?? 0, snap?.items.length ?? 0);

  return (
    <main className="review">
      <aside className="panel left">
        <BatchLauncher
          busy={status.busy}
          claude={status.claude}
          onStarted={(id) => {
            setSelected(id);
            void refresh();
          }}
        />
        <section>
          <h3>History</h3>
          <ul className="history">
            {batches.map((x) => (
              <li key={x.id} className={x.id === selected ? 'active' : ''} onClick={() => setSelected(x.id)}>
                <span>{batchTitle(x)}</span>
                <span className={`hint status-${x.status}`}>
                  {ACTIVE.has(x.status) ? STATUS_LABEL[x.status] : `${x.counts?.ready ?? 0} ready${x.approved ? ` · ${x.approved} ✓` : ''}`}
                </span>
              </li>
            ))}
            {!batches.length && <li className="hint">No batches yet. Start one above.</li>}
          </ul>
        </section>
        <section>
          <h3>Storage</h3>
          {storage && (
            <p className="hint">
              Renders {formatBytes(storage.rendersBytes)} · Exports {formatBytes(storage.exportsBytes)}
            </p>
          )}
          <div className="row">
            <label className="param-check">
              Older than
              <input type="number" min={0} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 56 }} />
              days
            </label>
            <button
              onClick={async () => {
                if (!confirm(`Delete renders older than ${days} days that aren't approved or exported (including Playground test exports)?`)) return;
                const r = await api.housekeeping(days);
                setCleanMsg(`Deleted ${r.deleted} render(s), freed ${formatBytes(r.freedBytes)}`);
                setStorage(await api.storage());
              }}
            >
              Clean up
            </button>
          </div>
          {cleanMsg && <p className="hint">{cleanMsg}</p>}
        </section>
      </aside>

      <section className="review-main">
        {!b ? (
          <div className="empty">
            <h2>Batches &amp; Review</h2>
            <p className="hint">Start a batch on the left. It plans concepts, finds the most dramatic run of each, renders them, and ranks them here for review.</p>
          </div>
        ) : (
          <>
            <header className="batch-head">
              <div>
                <h2>{batchTitle(b)}</h2>
                <p className="hint">
                  {STATUS_LABEL[b.status]}
                  {active && ` · ${done}/${total} rendered`}
                  {active && snap?.eta ? ` · about ${Math.max(1, Math.round(snap.eta / 60))} min left` : ''}
                  {!active && b.status !== 'manual' && ` · ${snap?.counts.ready ?? 0} ready · ${approved} approved`}
                </p>
                {active && (
                  <div className="progress big">
                    <div style={{ width: `${Math.round(((done + (b.status === 'planning' ? (snap!.planned / total) * 0.3 : 0)) / Math.max(1, total)) * 100)}%` }} />
                  </div>
                )}
              </div>
              <div className="row">
                <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
                  <option value="all">All</option>
                  <option value="pending">To review</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
                {active && (
                  <button className="danger" onClick={() => api.cancelBatch(b.id)}>
                    Cancel batch
                  </button>
                )}
              </div>
            </header>
            {b.warnings.length > 0 && (
              <ul className="warnings">
                {b.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {b.error && <p className="warn">{b.error}</p>}
            <div className="grid">
              {items.map((item) => (
                <CandidateCard key={item.id} item={item} rank={(snap?.items.indexOf(item) ?? 0) + 1} onChanged={() => void refresh()} />
              ))}
              {active &&
                Array.from({ length: Math.max(0, total - (snap?.items.length ?? 0)) }, (_, k) => (
                  <article key={`p${k}`} className="card ghost">
                    <div className="card-media">
                      <div className="card-placeholder">
                        <span>{b.status === 'planning' ? 'Planning…' : 'Searching seeds…'}</span>
                      </div>
                    </div>
                  </article>
                ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
