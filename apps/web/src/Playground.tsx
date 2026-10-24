import { useEffect, useMemo, useRef, useState } from 'react';
import { THEMES, paramsJsonSchema, parseParams, searchBudgetOf, type Recipe } from '@sim/engine';
import { MELODIES } from '@sim/audio';
import { TEMPLATES, findTemplate, getTemplate } from '@sim/templates';
import { ParamControls } from './ParamControls';
import { TemplatePicker } from './TemplatePicker';
import { NarrationPanel, type VoiceState } from './NarrationPanel';
import { usePlayer } from './usePlayer';
import { useAnalysis } from './useAnalysis';
import { ExportPanel } from './ExportPanel';
import type { SearchMessage, SearchResult } from './searchWorker';
import { QUIET } from './api';

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
    if (template) return { ...saved, templateId: template.id, params: parseParams(template, saved.params ?? {}) as Record<string, unknown> };
  } catch {
    /* ignore */
  }
  return DEFAULT_RECIPE;
}

export function Playground() {
  const [recipe, setRecipe] = useState<Recipe>(loadSaved);
  const [muted, setMuted] = useState(QUIET);
  const [volume, setVolume] = useState(() => {
    try {
      const v = Number(localStorage.getItem('playground.volume'));
      return localStorage.getItem('playground.volume') !== null && v >= 0 && v <= 1 ? v : 0.8;
    } catch {
      return 0.8;
    }
  });
  const [safeZones, setSafeZones] = useState(false);
  const [search, setSearch] = useState<{ progress: number; results: SearchResult[]; running: boolean; tally?: { label: string; n: number }[]; runs?: number; medianS?: number }>({
    progress: 0,
    results: [],
    running: false,
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const template = getTemplate(recipe.templateId);
  const schema = useMemo(() => paramsJsonSchema(template) as { properties: Record<string, any> }, [template]);
  const changedParams = Object.entries(recipe.params).filter(([k, v]) => k in schema.properties && v !== schema.properties[k].default).length;
  const player = usePlayer(canvasRef, recipe, muted, volume);
  const searchBudget = searchBudgetOf(template, recipe.params);
  // A new seed, template or setting means new facts to narrate: the old lines no longer fit.
  const update = (patch: Partial<Recipe>) =>
    setRecipe((r) => ({ ...r, ...patch, ...(('seed' in patch || 'params' in patch || 'templateId' in patch) && !('voice' in patch) ? { voice: undefined } : {}) }));
  const narrated = Boolean(template.narration?.enabled(parseParams(template, recipe.params)));
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  // Narrated previews wait for their lines (unless voicing failed: then they play silently).
  const awaitingVoice = narrated && !recipe.voice && voiceState !== 'failed';

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

  // Seed search, spread over parallel workers (one per spare core): each simulates its share of the
  // seeds and reports after every one.
  const searchWorkers = useRef<Worker[]>([]);
  const stopSearch = () => {
    for (const w of searchWorkers.current) w.terminate();
    searchWorkers.current = [];
  };
  useEffect(() => stopSearch, []);

  const runSearch = (count: number) => {
    stopSearch();
    const n = Math.max(1, Math.min(count, (navigator.hardwareConcurrency || 4) - 1, 8));
    const start = Math.floor(Math.random() * 1e6);
    const results: SearchResult[] = [];
    let done = 0;
    let finished = 0;
    setSearch({ progress: 0, results: [], running: true });
    const finish = () => {
      if (++finished < n) return;
      searchWorkers.current = [];
      // How every run came out (not just the best ones): how often each result comes up.
      const counts = new Map<string, number>();
      for (const r of results) if (r.outcome) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
      const tally = [...counts].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
      const lens = results.map((r) => r.durationS).sort((a, b) => a - b);
      results.sort((a, b) => b.total - a.total || a.seed - b.seed);
      const top = results.slice(0, 12);
      setSearch({ progress: 1, results: top, running: false, tally: tally.length ? tally : undefined, runs: results.length, medianS: lens[lens.length >> 1] });
      if (top[0]) update({ seed: top[0].seed });
    };
    for (let k = 0; k < n; k++) {
      const from = Math.floor((count * k) / n);
      const to = Math.floor((count * (k + 1)) / n);
      const worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
      searchWorkers.current.push(worker);
      worker.onmessage = (e: MessageEvent<SearchMessage>) => {
        if (e.data.type === 'seed') {
          done++;
          setSearch((s) => ({ ...s, progress: done / count }));
        } else {
          results.push(...e.data.results);
          worker.terminate();
          finish();
        }
      };
      // A worker that fails still counts as finished (the search completes with the others' seeds).
      worker.onerror = () => {
        worker.terminate();
        finish();
      };
      worker.postMessage({ recipe, start: start + from, count: to - from, targetS: recipe.targetS ?? 30 });
    }
  };

  return (
    <main className="playground">
      <aside className="panel left">
        <section>
          <h3>Scene</h3>
          <div className="param">
            <span>Template</span>
            <TemplatePicker
              templates={TEMPLATES}
              value={recipe.templateId}
              onChange={(templateId) => {
                // Custom copy is written for one template, so it goes back to the new template's defaults.
                update({ templateId, params: {}, copy: {} });
                stopSearch();
                setSearch({ progress: 0, results: [], running: false });
              }}
            />
          </div>
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
          {search.tally && (
            <div className="tally">
              <span className="hint">
                Across {search.runs} runs (median {search.medianS?.toFixed(0)}s):
              </span>
              {search.tally.slice(0, 8).map((t) => (
                <div key={t.label} className="tally-row">
                  <span>{t.label}</span>
                  <span className="tally-bar" style={{ width: `${(t.n / search.runs!) * 100}%` }} />
                  <b>{Math.round((t.n / search.runs!) * 100)}%</b>
                </div>
              ))}
            </div>
          )}
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
          <label className="param">
            <span>Comment prompt (adds the like heart)</span>
            <input
              value={recipe.copy?.nudge ?? ''}
              placeholder={template.nudges?.[0] ?? 'None'}
              onChange={(e) => update({ copy: { ...recipe.copy, nudge: e.target.value || undefined } })}
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
        {narrated && <NarrationPanel recipe={recipe} onVoice={(voice) => update({ voice })} onState={setVoiceState} />}
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
            <button className="primary" disabled={awaitingVoice} onClick={() => void player.play()}>
              {awaitingVoice ? 'Voicing…' : player.status === 'done' ? 'Replay' : 'Play'}
            </button>
          )}
          <button disabled={awaitingVoice} onClick={player.restart}>
            Restart
          </button>
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
        <ExportPanel recipe={recipe} />
      </aside>
    </main>
  );
}
