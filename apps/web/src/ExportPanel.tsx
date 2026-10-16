import { useState } from 'react';
import type { Recipe } from '@sim/engine';
import { renderCommand } from './recipe';
import { api, uploadPageHash } from './api';

export function ExportPanel({ recipe }: { recipe: Recipe }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Renders on the server and opens the upload page, where Claude's text appears while it renders.
  const exportVideo = async () => {
    setError(null);
    setBusy(true);
    try {
      const item = await api.startUpload(recipe, notes);
      setNotes('');
      location.hash = uploadPageHash(item.id);
    } catch (e) {
      setError(`Could not reach the render server (${(e as Error).message}). Start everything with "npm run dev".`);
    } finally {
      setBusy(false);
    }
  };

  const [queued, setQueued] = useState(false);
  const addToQueue = async () => {
    setError(null);
    try {
      await api.addManual(recipe);
      setQueued(true);
      setTimeout(() => setQueued(false), 2500);
    } catch (e) {
      setError(`Could not add to the review queue (${(e as Error).message}).`);
    }
  };

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

  return (
    <>
      <section>
        <h3>Export</h3>
        <p className="hint">
          Renders exactly what you're previewing (1080×1920 60fps, -14 LUFS), and Claude writes the title, captions and tags for YouTube, TikTok,
          Instagram and X. Opens the upload page under Batches &amp; Review.
        </p>
        <label className="param">
          <span>Notes for Claude (optional)</span>
          <textarea rows={2} value={notes} placeholder="e.g. part 2 of the Japan vs Brazil series" onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button className="primary wide" disabled={busy} onClick={exportVideo}>
          {busy ? 'Starting…' : 'Export for upload'}
        </button>
        <button className="wide" style={{ marginTop: 8 }} onClick={addToQueue}>
          {queued ? 'Added — see Batches & Review' : 'Add to review queue'}
        </button>
        {error && <p className="warn">{error}</p>}
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
