import { useEffect, useRef, useState } from 'react';
import type { Recipe } from '@sim/engine';
import { api } from './api';

export type VoiceState = 'idle' | 'busy' | 'failed';

/** What the lines depend on: a new seed, template or setting needs new lines. */
const factsKey = (r: Recipe) => JSON.stringify([r.templateId, r.seed, r.params]);

/**
 * Voiceover for templates that have one. Whenever narration is on and the preview has no lines for
 * its current settings, the template's hand-written lines are filled in and voiced on the server
 * automatically; the Playground holds Play until they're ready.
 */
export function NarrationPanel({ recipe, onVoice, onState }: { recipe: Recipe; onVoice: (voice: Recipe['voice']) => void; onState: (s: VoiceState) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const voice = recipe.voice;
  const key = factsKey(recipe);
  // The settings a request was made for: an answer for settings that have since changed is dropped.
  const current = useRef(key);
  current.current = key;

  const run = async (force: boolean) => {
    const asked = key;
    setBusy(true);
    setError(null);
    onState('busy');
    try {
      const res = await api.prepareNarration(recipe, force);
      if (current.current !== asked) return;
      onVoice(res.voice ?? undefined);
      onState('idle');
    } catch (e) {
      if (current.current !== asked) return;
      setError((e as Error).message);
      onState('failed');
    } finally {
      setBusy(false);
    }
  };

  // Voice automatically (after the settings settle for a moment).
  useEffect(() => {
    if (voice) {
      onState('idle');
      return;
    }
    const timer = setTimeout(() => void run(false), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, Boolean(voice)]);

  return (
    <section>
      <h3>Narration</h3>
      <div className="row">
        <span className="hint">{busy ? 'Voicing the lines…' : voice ? 'Voiced ✓' : error ? 'Not voiced' : 'Waiting…'}</span>
        <button disabled={busy} onClick={() => run(true)} title="Voice the lines again">
          {voice ? 'Re-voice' : 'Retry'}
        </button>
      </div>
      {error && <p className="hint error">{error} — the preview plays without a voice.</p>}
      {voice && (
        <>
          <p className="hint">
            Hand-written lines · {voice.provider} / {voice.voiceId}
          </p>
          <ol className="narration-lines">
            {voice.lines.map((l) => (
              <li key={l.beat}>
                <span className="hint">{l.durationS.toFixed(1)}s</span> {l.caption}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
