import { useEffect, useMemo, useRef, useState } from 'react';
import { THEMES, paramsJsonSchema, parseParams, type Recipe } from '@sim/engine';
import { MELODIES } from '@sim/audio';
import { TEMPLATES, findTemplate, getTemplate } from '@sim/templates';
import { ParamControls } from './ParamControls';
import { usePlayer } from './usePlayer';
import { useAnalysis } from './useAnalysis';
import { ExportPanel } from './ExportPanel';
import type { SearchResult } from './searchWorker';

const DEFAULT_RECIPE: Recipe = {
  templateId: TEMPLATES[0].id,
  seed: 1,
  params: {},
  themeId: 'neon-dark',
  melodyId: 'ode-to-joy',
  copy: {},
  targetS: 30,
};

function loadSaved(): Recipe {
  try {
    const raw = localStorage.getItem('playground.recipe');
    const saved = raw ? { ...DEFAULT_RECIPE, ...JSON.parse(raw) } : null;
    // A saved recipe for a removed template falls back to the default; removed options fall back to
    // their defaults so the form only shows values that still exist.
    const template = saved && findTemplate(saved.templateId);
    if (template) return { ...saved, params: parseParams(template, saved.params ?? {}) as Record<string, unknown> };
  } catch {
    /* ignore */
  }
  return DEFAULT_RECIPE;
}

export function Playground() {
  const [recipe, setRecipe] = useState<Recipe>(loadSaved);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(() => {
    try {
      const v = Number(localStorage.getItem('playground.volume'));
      return localStorage.getItem('playground.volume') !== null && v >= 0 && v <= 1 ? v : 0.8;
    } catch {
      return 0.8;
    }
  });
  const [safeZones, setSafeZones] = useState(false);
  const [search, setSearch] = useState<{ progress: number; results: SearchResult[]; running: boolean }>({
    progress: 0,
    results: [],
    running: false,
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const template = getTemplate(recipe.templateId);
  const schema = useMemo(() => paramsJsonSchema(template) as { properties: Record<string, any> }, [template]);
  const changedParams = Object.entries(recipe.params).filter(([k, v]) => k in schema.properties && v !== schema.properties[k].default).length;
  const player = usePlayer(canvasRef, recipe, muted, volume);
  const searchBudget = template.searchBudget ?? 400;
  const update = (patch: Partial<Recipe>) => setRecipe((r) => ({ ...r, ...patch }));

  useEffect(() => {
    try {
      localStorage.setItem('playground.volume', String(volume));
    } catch {
      /* ignore */
    }
  }, [volume]);

  useEffect(() => {
    try {
      localStorage.setItem('playground.recipe', JSON.stringify(recipe));
    } catch {
      /* ignore */
    }
  }, [recipe]);

  // Headless pre-run of the current recipe (exact duration + drama score), in a worker so heavy
  // templates never block the UI.
  const { analysis: fresh, stale, pending } = useAnalysis(recipe);
  const analysis = fresh ?? stale;

  const runSearch = (count: number) => {
    const worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
    setSearch({ progress: 0, results: [], running: true });
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') setSearch((s) => ({ ...s, progress: e.data.done / e.data.count }));
      else {
        setSearch({ progress: 1, results: e.data.results, running: false });
        if (e.data.results[0]) update({ seed: e.data.results[0].seed });
        worker.terminate();
      }
    };
    worker.postMessage({ recipe, start: Math.floor(Math.random() * 1e6), count, targetS: recipe.targetS ?? 30 });
  };

  return (
    <main className="playground">
      <aside className="panel left">
        <section>
          <h3>Scene</h3>
          <label className="param">
            <span>Template</span>
            <select value={recipe.templateId} onChange={(e) => {
                // Custom copy is written for one template, so it goes back to the new template's defaults.
                update({ templateId: e.target.value, params: {}, copy: {} });
                setSearch({ progress: 0, results: [], running: false });
              }}>
              {TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">{template.description}</p>
          <label className="param">
            <span>Theme</span>
            <select value={recipe.themeId} onChange={(e) => update({ themeId: e.target.value })}>
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="param">
            <span>Melody</span>
            <select value={recipe.melodyId} disabled={template.ownMusic} onChange={(e) => update({ melodyId: e.target.value })}>
              {MELODIES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} — {m.composer}
                </option>
              ))}
              <option value="generated-1">Generated pentatonic</option>
            </select>
            {template.ownMusic && <span className="hint">This template generates its own notes.</span>}
          </label>
        </section>

        <section>
          <h3>Seed</h3>
          <div className="row">
            <input type="number" value={recipe.seed} onChange={(e) => update({ seed: Number(e.target.value) | 0 })} />
            <button onClick={() => update({ seed: Math.floor(Math.random() * 1e6) })}>Random</button>
          </div>
          <label className="param">
            <span>
              Target length <b>{recipe.targetS}s</b>
            </span>
            <input type="range" min={15} max={60} step={1} value={recipe.targetS ?? 30} onChange={(e) => update({ targetS: Number(e.target.value) })} />
          </label>
          <div className="row">
            <button className="primary" disabled={search.running} onClick={() => runSearch(searchBudget)}>
              {search.running ? `Searching ${Math.round(search.progress * 100)}%` : `Find best seed (${searchBudget})`}
            </button>
          </div>
          {search.results.length > 0 && (
            <ol className="results">
              {search.results.map((r) => (
                <li key={r.seed} className={r.seed === recipe.seed ? 'active' : ''} onClick={() => update({ seed: r.seed })}>
                  <span>#{r.seed}</span>
                  <span>{(r.total * 100).toFixed(0)}</span>
                  <span>{r.timedOut ? 'timeout' : `${r.durationS.toFixed(1)}s`}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h3>Copy</h3>
          <label className="param">
            <span>Hook</span>
            <input
              value={recipe.copy?.hook ?? ''}
              placeholder={template.defaultCopy.hook}
              onChange={(e) => update({ copy: { ...recipe.copy, hook: e.target.value || undefined } })}
            />
          </label>
          <label className="param">
            <span>Call to action</span>
            <input
              value={recipe.copy?.cta ?? ''}
              placeholder={template.defaultCopy.cta}
              onChange={(e) => update({ copy: { ...recipe.copy, cta: e.target.value || undefined } })}
            />
          </label>
        </section>

        <section>
          <h3 className="params-head">
            Parameters
            <button
              className="small reset-params"
              disabled={changedParams === 0}
              title={changedParams ? `Put ${changedParams === 1 ? 'the changed parameter' : `all ${changedParams} changed parameters`} back to the template's defaults` : 'All parameters are at their defaults'}
              onClick={() => update({ params: {} })}
            >
              ↺ Reset to defaults{changedParams ? ` (${changedParams})` : ''}
            </button>
          </h3>
          <ParamControls schema={schema} values={recipe.params} onChange={(params) => update({ params })} />
        </section>
      </aside>

      <section className="stage">
        <div className="phone">
          <canvas ref={canvasRef} width={1080} height={1920} />
          {safeZones && (
            <div className="safe">
              <div className="safe-top" />
              <div className="safe-right" />
              <div className="safe-bottom" />
            </div>
          )}
        </div>
        <div className="transport">
          {player.status === 'playing' ? (
            <button className="primary" onClick={player.pause}>Pause</button>
          ) : (
            <button className="primary" onClick={() => void player.play()}>
              {player.status === 'done' ? 'Replay' : 'Play'}
            </button>
          )}
          <button onClick={player.restart}>Restart</button>
          <button onClick={() => setMuted((m) => !m)}>{muted ? 'Unmute' : 'Mute'}</button>
          <label className="volume" title="Preview volume only; exported videos are unaffected">
            <span>Vol</span>
            <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
            <b>{Math.round(volume * 100)}%</b>
          </label>
          <label className="param-check">
            <input type="checkbox" checked={safeZones} onChange={(e) => setSafeZones(e.target.checked)} /> Safe zones
          </label>
          <span className="time">
            {player.time.toFixed(1)}s / {analysis ? `${analysis.durationS.toFixed(1)}s` : '…'}
          </span>
        </div>
      </section>

      <aside className="panel right">
        <section>
          <h3>Drama score {pending && <span className="hint">analyzing…</span>}</h3>
          <div className={`score${fresh ? '' : ' stale'}`}>{analysis ? (analysis.score.total * 100).toFixed(0) : '–'}</div>
          {analysis?.timedOut && <p className="warn">Timed out — never finishes. Adjust params.</p>}
          <table className="parts">
            <tbody>
              {Object.entries(analysis?.score.parts ?? {}).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>
                    <div className="bar" style={{ width: `${Math.round(v * 100)}%` }} />
                  </td>
                  <td>{v.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {analysis?.score.notes?.map((n) => (
            <p key={n} className="hint">
              {n}
            </p>
          ))}
        </section>
        <ExportPanel recipe={recipe} volume={muted ? 0 : volume} />
      </aside>
    </main>
  );
}
