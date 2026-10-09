import { useEffect, useRef, useState } from 'react';
import type { Recipe } from '@sim/engine';
import { renderCommand } from './recipe';

/** Mirrors JobView in apps/server/src/jobs.ts. */
interface Job {
  id: string;
  recipe: Recipe;
  status: 'queued' | 'searching' | 'frames' | 'audio' | 'mastering' | 'qc' | 'done' | 'error';
  progress: number;
  error?: string;
  result?: {
    durationS: number;
    score: { total: number };
    qc: { pass: boolean; problems: string[]; integratedLufs: number };
    timings: { totalMs: number };
    files: { final: string; cover: string; contact: string; dir: string };
  };
}

const STAGE_LABEL: Record<Job['status'], string> = {
  queued: 'Queued',
  searching: 'Searching seeds',
  frames: 'Rendering frames',
  audio: 'Rendering audio',
  mastering: 'Mastering',
  qc: 'Quality checks',
  done: 'Done',
  error: 'Failed',
};

// Overall progress: frames dominate, the other stages are short.
function overall(job: Job) {
  switch (job.status) {
    case 'frames':
      return 0.05 + job.progress * 0.6;
    case 'audio':
      return 0.68;
    case 'mastering':
      return 0.78;
    case 'qc':
      return 0.9;
    case 'done':
      return 1;
    default:
      return 0.02;
  }
}

export function ExportPanel({ recipe, volume }: { recipe: Recipe; volume: number }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const busy = job !== null && job.status !== 'done' && job.status !== 'error';

  useEffect(() => () => sourceRef.current?.close(), []);

  // Keep the exported-video preview at the same (preview-only) volume.
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  });

  const exportVideo = async () => {
    setError(null);
    try {
      const res = await fetch('/api/renders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipe }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const created: Job = await res.json();
      setJob(created);
      sourceRef.current?.close();
      const es = new EventSource(`/api/renders/${created.id}/stream`);
      sourceRef.current = es;
      es.onmessage = (e) => {
        const next: Job = JSON.parse(e.data);
        setJob(next);
        if (next.status === 'done' || next.status === 'error') es.close();
      };
    } catch (e) {
      setError(`Could not reach the render server (${(e as Error).message}). Start everything with "npm run dev".`);
    }
  };

  const reveal = (path: string) =>
    fetch('/api/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });

  const copyCommand = async () => {
    await navigator.clipboard.writeText(renderCommand(recipe));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const downloadRecipe = () => {
    const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${recipe.templateId}-${recipe.seed}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const r = job?.result;
  return (
    <>
      <section>
        <h3>Export</h3>
        <p className="hint">Renders exactly what you're previewing: 1080×1920 60fps MP4, audio mastered to -14 LUFS.</p>
        <button className="primary wide" disabled={busy} onClick={exportVideo}>
          {busy ? 'Exporting…' : 'Export MP4'}
        </button>
        {error && <p className="warn">{error}</p>}
        {job && (
          <div className="job">
            <div className="job-head">
              <span>{STAGE_LABEL[job.status]}</span>
              {job.status === 'frames' && <span>{Math.round(job.progress * 100)}%</span>}
            </div>
            {job.status !== 'error' && (
              <div className="progress">
                <div style={{ width: `${Math.round(overall(job) * 100)}%` }} />
              </div>
            )}
            {job.error && <pre className="cmd warn">{job.error}</pre>}
            {r && (
              <>
                <video ref={videoRef} className="result-video" src={`/files/${r.files.final}`} controls playsInline />
                <p className={r.qc.pass ? 'ok' : 'warn'}>
                  QC {r.qc.pass ? 'passed' : 'failed'} · {r.durationS.toFixed(1)}s · {r.qc.integratedLufs} LUFS · took{' '}
                  {(r.timings.totalMs / 1000).toFixed(0)}s
                </p>
                {!r.qc.pass && <p className="warn">{r.qc.problems.join('; ')}</p>}
                <div className="row">
                  <a className="button primary" href={`/api/download?path=${encodeURIComponent(r.files.final)}`}>
                    Download MP4
                  </a>
                  <a className="button" href={`/api/download?path=${encodeURIComponent(r.files.cover)}`}>
                    Cover
                  </a>
                  <button onClick={() => reveal(r.files.final)}>Show in Finder</button>
                </div>
                <p className="hint path">data/renders/{r.files.dir}</p>
              </>
            )}
          </div>
        )}
      </section>
      <section>
        <h3>CLI command</h3>
        <p className="hint">The same render from the terminal (for scripting or batch runs).</p>
        <div className="row">
          <button onClick={copyCommand}>{copied ? 'Copied!' : 'Copy command'}</button>
          <button onClick={downloadRecipe}>Recipe JSON</button>
        </div>
        <pre className="cmd">{renderCommand(recipe)}</pre>
      </section>
    </>
  );
}
