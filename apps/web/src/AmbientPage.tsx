import { useEffect, useMemo, useRef, useState } from 'react';
import { loopLengthOf, paramsJsonSchema, parseParams, type Recipe } from '@sim/engine';
import { LONG_FORM_TEMPLATES, findTemplate, getTemplate } from '@sim/templates';
import { ParamControls } from './ParamControls';
import { useAmbientPlayer } from './useAmbientPlayer';
import { api, longFormApi, type LongFormJob, type LongFormState } from './api';

type LongRecipe = Recipe & { loopS: number; totalS: number };

const HOURS = [1, 2, 3, 4, 6, 8, 10, 12];

const STAGE_LABEL: Record<string, string> = {
  prepare: 'Preparing',
  frames: 'Rendering frames',
  audio: 'Rendering sound',
  joining: 'Joining',
  mastering: 'Mastering',
  qc: 'Checking',
};

const defaultRecipe = (templateId = LONG_FORM_TEMPLATES[0].id): LongRecipe => {
  const lf = getTemplate(templateId).longForm!;
  return { templateId, seed: 1, params: {}, themeId: 'neon-dark', melodyId: 'ode-to-joy', loopS: lf.defaultLoopS, totalS: 3 * 3600 };
};

function loadSaved(): LongRecipe {
  try {
    const raw = localStorage.getItem('ambient.recipe');
    const saved = raw ? (JSON.parse(raw) as LongRecipe) : null;
    const template = saved && findTemplate(saved.templateId);
    if (saved && template?.longForm) return { ...defaultRecipe(saved.templateId), ...saved, params: parseParams(template, saved.params ?? {}) as Record<string, unknown> };
  } catch {
    /* ignore */
  }
  return defaultRecipe();
}

const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const hoursLabel = (s: number) => (s % 3600 ? `${Math.round(s / 60)} min` : `${s / 3600} h`);
const mb = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

/** Rough render time: the loop's frames at ~45 fps, its audio, then joining, mastering and QC. */
const estimateMin = (loopS: number, totalS: number) => Math.round((loopS * 30) / 45 / 60 + loopS / 1200 + (loopS * 0.12 + totalS * 0.02) / 60);

export function AmbientPage() {
  const [recipe, setRecipe] = useState<LongRecipe>(loadSaved);
  const [notes, setNotes] = useState('');
  const [volume, setVolume] = useState(0.8);
  const [state, setState] = useState<LongFormState>({ jobs: [], current: null, shortsRendering: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const template = getTemplate(recipe.templateId);
  const lf = template.longForm!;
  const schema = useMemo(() => paramsJsonSchema(template) as { properties: Record<string, any> }, [template]);
  const player = useAmbientPlayer(canvasRef, recipe, volume);
  const update = (patch: Partial<LongRecipe>) => setRecipe((r) => ({ ...r, ...patch }));

  useEffect(() => {
    try {
      localStorage.setItem('ambient.recipe', JSON.stringify(recipe));
    } catch {
      /* ignore */
    }
  }, [recipe]);

  useEffect(() => longFormApi.stream(setState), []);

  const step = lf.loopStepS ?? 600;
  const loops: number[] = [];
  for (let s = Math.ceil(lf.minLoopS / step) * step; s <= lf.maxLoopS; s += step) loops.push(s);
  const loopS = loopLengthOf(template, recipe.loopS);

  const render = async () => {
    setError(null);
    setBusy(true);
    try {
      const job = await longFormApi.create({ ...recipe, loopS }, notes);
      setNotes('');
      setOpen(job.id);
    } catch (e) {
      setError(`Could not start the render (${(e as Error).message}). Is the server running ("npm run dev")?`);
    } finally {
      setBusy(false);
    }
  };

  const cmd = `npm run render -- --template ${recipe.templateId} --seed ${recipe.seed} --loop ${loopS / 60}m --length ${recipe.totalS / 3600}h --params '${JSON.stringify(recipe.params)}'`;

  return (
    <main className="playground ambient">
      <aside className="panel left">
        <section>
          <h3>Scene</h3>
          <label className="param">
            <span>Template</span>
            <select value={recipe.templateId} onChange={(e) => setRecipe(defaultRecipe(e.target.value))}>
              {LONG_FORM_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">{template.description}</p>
          <label className="param">
            <span>Seed (the weather, the sky, the planet)</span>
            <div className="row">
              <input type="number" value={recipe.seed} onChange={(e) => update({ seed: Number(e.target.value) | 0 })} />
              <button onClick={() => update({ seed: Math.floor(Math.random() * 1e6) })}>Random</button>
            </div>
          </label>
        </section>

        <section>
          <h3>Length</h3>
          <div className="row two">
            <label className="param">
              <span>Loop</span>
              <select value={loopS} onChange={(e) => update({ loopS: Number(e.target.value), totalS: Math.max(recipe.totalS, Number(e.target.value)) })}>
                {loops.map((s) => (
                  <option key={s} value={s}>
                    {s / 60} min
                  </option>
                ))}
              </select>
            </label>
            <label className="param">
              <span>Final video</span>
              <select value={recipe.totalS} onChange={(e) => update({ totalS: Number(e.target.value) })}>
                {HOURS.filter((h) => h * 3600 >= loopS).map((h) => (
                  <option key={h} value={h * 3600}>
                    {h} hour{h === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="hint">
            A {loopS / 60}-minute master loop repeated {Math.ceil(recipe.totalS / loopS)} times. Longer loops repeat less often but take longer to render.
          </p>
        </section>

        <section>
          <h3 className="params-head">
            Settings
            <button className="small reset-params" onClick={() => update({ params: {} })}>
              ↺ Reset
            </button>
          </h3>
          <ParamControls schema={schema} values={recipe.params} onChange={(params) => update({ params })} />
        </section>

        <section>
          <h3>Render</h3>
          <label className="param">
            <span>Notes for Claude (optional)</span>
            <textarea rows={2} value={notes} placeholder="e.g. for a winter playlist" onChange={(e) => setNotes(e.target.value)} />
          </label>
          <button className="primary wide" disabled={busy} onClick={render}>
            {busy ? 'Starting…' : `Render ${hoursLabel(recipe.totalS)} video`}
          </button>
          <p className="hint">
            About {estimateMin(loopS, recipe.totalS)} min to render (it waits for any Shorts in the queue), about {mb(recipe.totalS * 1.03e6 + loopS * 1.2e6)} on disk (the video plus its master loop). Claude writes the YouTube title,
            description and tags while it renders.
          </p>
          {error && <p className="warn">{error}</p>}
          <details>
            <summary className="hint">CLI command</summary>
            <pre className="cmd">{cmd}</pre>
          </details>
        </section>
      </aside>

      <section className="stage">
        <div className="widescreen">
          <canvas ref={canvasRef} width={1920} height={1080} />
          {!player.ready && <div className="loading">{player.error ? `Couldn't load the scene (${player.error}). Is the server running? Reload the page to try again.` : 'Loading the scene…'}</div>}
        </div>
        <div className="transport wide-transport">
          {player.playing ? (
            <button className="primary" onClick={player.pause}>
              Pause
            </button>
          ) : (
            <button className="primary" disabled={!player.ready} onClick={player.play}>
              Play
            </button>
          )}
          <input className="scrub" type="range" min={0} max={player.loopS} step={1} value={Math.floor(player.time)} disabled={!player.ready} onChange={(e) => player.seek(Number(e.target.value))} />
          <span className="time">
            {clock(player.time)} / {clock(player.loopS)}
          </span>
          <label className="volume" title="Preview volume only; renders are unaffected">
            <span>Vol</span>
            <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
          </label>
        </div>
        <p className="hint">The preview plays the master loop; the scrub bar covers all of it (the video repeats it to the final length).</p>
      </section>

      <aside className="panel right ambient-jobs">
        <section>
          <h3>Renders</h3>
          {state.jobs.length === 0 && <p className="hint">Nothing rendered yet.</p>}
          {state.jobs.map((j) => (
            <JobCard key={j.id} job={j} open={open === j.id} onToggle={() => setOpen(open === j.id ? null : j.id)} waitingForShorts={j.status === 'queued' && !!state.shortsRendering} />
          ))}
        </section>
      </aside>
    </main>
  );
}

function JobCard({ job, open, onToggle, waitingForShorts }: { job: LongFormJob; open: boolean; onToggle: () => void; waitingForShorts: boolean }) {
  const name = findTemplate(job.recipe.templateId)?.name ?? job.recipe.templateId;
  const files = job.dir ? `/files/${job.dir}` : null;
  // Time left from the progress seen since this page started watching (a resumed job's start time
  // would count the pause).
  const seen = useRef<{ at: number; progress: number } | null>(null);
  if (job.status !== 'rendering') seen.current = null;
  else if (!seen.current) seen.current = { at: Date.now(), progress: job.progress };
  const gained = seen.current ? job.progress - seen.current.progress : 0;
  const eta = seen.current && gained > 0.01 ? ((Date.now() - seen.current.at) / 1000 / gained) * (1 - job.progress) : null;
  return (
    <div className={`job ${job.status}`}>
      <div className="job-head" onClick={onToggle}>
        {job.status === 'ready' && files ? <img className="job-thumb" src={`${files}/thumbnail.jpg`} alt="" /> : <div className="job-thumb placeholder" />}
        <div className="job-sum">
          <b>{job.copy?.title ?? name}</b>
          <span className="hint small-text">
            {name} · {job.recipe.loopS / 60} min loop → {hoursLabel(job.recipe.totalS)} · {new Date(job.createdAt).toLocaleString()}
          </span>
          <span className="small-text">
            {job.status === 'queued' && (waitingForShorts ? 'Queued (waiting for Shorts)' : 'Queued')}
            {job.status === 'rendering' &&
              (job.stage === 'cancelling'
                ? 'Stopping after this segment (kept for resuming)…'
                : `${STAGE_LABEL[job.stage ?? ''] ?? 'Rendering'} · ${Math.round(job.progress * 100)}%${eta ? ` · ~${Math.ceil(eta / 60)} min left` : ''}`)}
            {job.status === 'ready' && (job.result?.qcPass ? '✓ Ready, QC passed' : `Ready, QC: ${job.result?.problems.join('; ')}`)}
            {job.status === 'failed' && <span className="warn">Failed: {job.error}</span>}
            {job.status === 'cancelled' && 'Cancelled (finished parts are kept: retry resumes)'}
          </span>
          {job.status === 'rendering' && (
            <div className="progress">
              <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
          )}
        </div>
      </div>
      {open && <JobDetail job={job} files={files} />}
    </div>
  );
}

function JobDetail({ job, files }: { job: LongFormJob; files: string | null }) {
  const [draft, setDraft] = useState(job.copy);
  // Tags are edited as text and split on save (re-joining on every keystroke would eat the spaces).
  const [tagsText, setTagsText] = useState(job.copy?.tags.join(', ') ?? '');
  const [notes, setNotes] = useState(job.notes ?? '');
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Follow the server's copy (Claude writing it) unless it's being edited.
  const editing = useRef(false);
  useEffect(() => {
    if (editing.current) return;
    setDraft(job.copy);
    setTagsText(job.copy?.tags.join(', ') ?? '');
  }, [job.copy]);

  const copy = async (label: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };
  const save = async () => {
    if (!draft) return;
    await longFormApi.editCopy(job.id, { ...draft, tags: tagsText.split(',') });
    editing.current = false;
  };
  const edit = (patch: Partial<NonNullable<typeof draft>>) => {
    editing.current = true;
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const remove = async () => {
    if (!confirm(deleteFiles ? 'Delete this render and its video files? This cannot be undone.' : 'Remove this render from the list? (The files stay in data/renders.)')) return;
    await longFormApi.remove(job.id, deleteFiles);
  };

  return (
    <div className="job-detail">
      <div className="row wrap">
        {(job.status === 'queued' || (job.status === 'rendering' && job.stage !== 'cancelling')) && <button onClick={() => longFormApi.cancel(job.id)}>Cancel</button>}
        {(job.status === 'cancelled' || job.status === 'failed') && <button onClick={() => longFormApi.retry(job.id)}>Retry</button>}
        {job.status === 'ready' && files && (
          <>
            <a className="button" href={`${files}/final.mp4`} target="_blank" rel="noreferrer">
              Play video
            </a>
            <a className="button" href={`${files}/thumbnail.jpg`} download>
              Thumbnail
            </a>
          </>
        )}
        {job.dir && <button onClick={() => api.reveal(job.dir!)}>Show in Finder</button>}
      </div>
      {job.result && (
        <p className="hint small-text">
          {mb(job.result.sizeBytes)} · {job.result.integratedLufs} LUFS · peak {job.result.truePeakDb} dBFS · last run took {Math.round(job.result.timings.totalMs / 60000)} min
        </p>
      )}

      <h4>
        YouTube copy {job.copyStatus === 'writing' && <span className="hint">Claude is writing…</span>}
      </h4>
      {job.copyError && <p className="hint small-text">{job.copyError}</p>}
      {draft && (
        <>
          <label className="param">
            <span>
              Title <button className="small" onClick={() => copy('title', draft.title)}>{copied === 'title' ? 'Copied' : 'Copy'}</button>
            </span>
            <input value={draft.title} maxLength={100} onChange={(e) => edit({ title: e.target.value })} onBlur={save} />
          </label>
          <label className="param">
            <span>
              Description <button className="small" onClick={() => copy('description', draft.description)}>{copied === 'description' ? 'Copied' : 'Copy'}</button>
            </span>
            <textarea rows={7} value={draft.description} onChange={(e) => edit({ description: e.target.value })} onBlur={save} />
          </label>
          <label className="param">
            <span>
              Tags <button className="small" onClick={() => copy('tags', tagsText)}>{copied === 'tags' ? 'Copied' : 'Copy'}</button>
            </span>
            <textarea
              rows={2}
              value={tagsText}
              onChange={(e) => {
                editing.current = true;
                setTagsText(e.target.value);
              }}
              onBlur={save}
            />
          </label>
          <label className="param">
            <span>
              Thumbnail text <button className="small" onClick={() => copy('thumb', draft.thumbnailText)}>{copied === 'thumb' ? 'Copied' : 'Copy'}</button>
            </span>
            <input value={draft.thumbnailText} onChange={(e) => edit({ thumbnailText: e.target.value })} onBlur={save} />
          </label>
        </>
      )}
      <label className="param">
        <span>Notes for Claude</span>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <button className="wide" disabled={job.copyStatus === 'writing'} onClick={() => longFormApi.regenerateCopy(job.id, notes)}>
        Rewrite with Claude
      </button>

      {job.status !== 'rendering' && (
        <div className="row delete-row">
          <label className="param-check">
            <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} /> also delete its files
          </label>
          <button className="danger" onClick={remove}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
