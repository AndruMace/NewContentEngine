import { useEffect, useState } from 'react';
import { THEMES } from '@sim/engine';
import { MELODIES } from '@sim/audio';
import { TEMPLATES } from '@sim/templates';
import { api, type BatchSettings } from './api';

function Chips({ options, selected, onChange }: { options: { id: string; label: string }[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const all = selected.length === 0;
  // With "All" on, clicking a chip narrows to just that one; otherwise chips toggle.
  const toggle = (id: string) => {
    if (all) return onChange([id]);
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    onChange(next.length === 0 || next.length === options.length ? [] : next);
  };
  return (
    <div className="chips">
      <button className={`chip${all ? ' on' : ''}`} onClick={() => onChange([])}>
        All
      </button>
      {options.map((o) => (
        <button key={o.id} className={`chip${!all && selected.includes(o.id) ? ' on' : ''}`} onClick={() => toggle(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function BatchLauncher({ busy, claude, onStarted }: { busy: boolean; claude: boolean; onStarted: (id: string) => void }) {
  const [s, setS] = useState<BatchSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api.settings().then(setS).catch((e) => setError(e.message));
  }, []);

  if (!s) return <section>{error ? <p className="warn">{error}</p> : <p className="hint">Loading…</p>}</section>;
  const set = (patch: Partial<BatchSettings>) => setS({ ...s, ...patch });
  const total = Math.round(s.postsWanted * s.factor);

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
      const b = await api.startBatch(s);
      onStarted(b.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="launcher">
      <h3>New batch</h3>
      <div className="row two">
        <label className="param">
          <span>
            Posts wanted <b>{s.postsWanted}</b>
          </span>
          <input type="range" min={1} max={10} step={1} value={s.postsWanted} onChange={(e) => set({ postsWanted: Number(e.target.value) })} />
        </label>
        <label className="param">
          <span>
            Candidates per post <b>{s.factor}×</b>
          </span>
          <input type="range" min={1} max={5} step={0.5} value={s.factor} onChange={(e) => set({ factor: Number(e.target.value) })} />
        </label>
      </div>
      <p className="hint">
        {total} candidates · roughly {Math.max(1, Math.round((total * ((s.minLengthS + s.maxLengthS) / 2) * 1.2) / 60))} min on this Mac
      </p>
      <div className="row two">
        <label className="param">
          <span>
            Min length <b>{s.minLengthS}s</b>
          </span>
          <input type="range" min={12} max={60} step={1} value={s.minLengthS} onChange={(e) => set({ minLengthS: Math.min(Number(e.target.value), s.maxLengthS - 3) })} />
        </label>
        <label className="param">
          <span>
            Max length <b>{s.maxLengthS}s</b>
          </span>
          <input type="range" min={15} max={75} step={1} value={s.maxLengthS} onChange={(e) => set({ maxLengthS: Math.max(Number(e.target.value), s.minLengthS + 3) })} />
        </label>
      </div>
      <div className="param">
        <span>Templates</span>
        <Chips options={TEMPLATES.map((t) => ({ id: t.id, label: t.name }))} selected={s.templateIds} onChange={(templateIds) => set({ templateIds })} />
      </div>
      <div className="param">
        <span>Themes</span>
        <Chips options={THEMES.map((t) => ({ id: t.id, label: t.name }))} selected={s.themeIds} onChange={(themeIds) => set({ themeIds })} />
      </div>
      <details>
        <summary className="hint">Melodies ({s.melodyIds.length ? s.melodyIds.length : 'all'})</summary>
        <Chips options={MELODIES.map((m) => ({ id: m.id, label: m.title }))} selected={s.melodyIds} onChange={(melodyIds) => set({ melodyIds })} />
      </details>
      <label className="param-check" title={claude ? '' : 'Add ANTHROPIC_API_KEY to .env and restart npm run dev'}>
        <input type="checkbox" checked={s.useClaude && claude} disabled={!claude} onChange={(e) => set({ useClaude: e.target.checked })} />
        Claude writes concepts &amp; captions
      </label>
      {!claude && <p className="hint">No API key found, so batches use template copy. Add ANTHROPIC_API_KEY to .env to enable Claude.</p>}
      <label className="param">
        <span>Notes / trends for today</span>
        <textarea rows={2} value={s.notes} placeholder="e.g. lean into country races, it's World Cup week" onChange={(e) => set({ notes: e.target.value })} />
      </label>
      <label className="param-check">
        <input type="checkbox" checked={s.notifyMac} onChange={(e) => set({ notifyMac: e.target.checked })} />
        macOS notification when done
      </label>
      <button className="primary wide" disabled={busy || starting} onClick={start}>
        {busy ? 'A batch is running…' : starting ? 'Starting…' : `Start batch (${total})`}
      </button>
      {error && <p className="warn">{error}</p>}
    </section>
  );
}
