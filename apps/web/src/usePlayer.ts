import { useCallback, useEffect, useRef, useState } from 'react';
import { parseParams, type Recipe, type Runner } from '@sim/engine';
import { createBus, scheduleEvent, type SynthBus } from '@sim/audio';
import { getTemplate, setAssetBase } from '@sim/templates';
import { makeRunner } from './recipe';

/** Decoded narration clips, by clip name (shared across previews: clips never change). */
const clipCache = new Map<string, Promise<AudioBuffer>>();
const decoder = new OfflineAudioContext(1, 1, 48000);

/** Fetch a clip, trying once more after a moment (the dev server restarts when its code changes). */
async function fetchClip(clip: string): Promise<AudioBuffer> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`/api/voice/${encodeURIComponent(clip)}`);
    if (r.ok) return decoder.decodeAudioData(await r.arrayBuffer());
    if (attempt >= 1) throw new Error(`Narration clip missing: ${clip} (${r.status})`);
    await new Promise((ok) => setTimeout(ok, 1500));
  }
}

/** The recipe's clips that loaded; one that didn't is reported and skipped (the preview still plays). */
async function loadClips(recipe: Recipe): Promise<Map<string, AudioBuffer>> {
  const clips = [...new Set((recipe.voice?.lines ?? []).map((l) => l.clip))];
  const out = new Map<string, AudioBuffer>();
  await Promise.all(
    clips.map(async (clip) => {
      let p = clipCache.get(clip);
      if (!p) {
        p = fetchClip(clip);
        clipCache.set(clip, p);
        p.catch(() => clipCache.delete(clip));
      }
      try {
        out.set(clip, await p);
      } catch (e) {
        console.warn((e as Error).message);
      }
    }),
  );
  return out;
}

// Templates that draw third-party models (assets/ambient) load them from the server.
setAssetBase('/ambient-assets/');

type Status = 'ready' | 'playing' | 'paused' | 'done';

/**
 * Plays a recipe in realtime. The sim is clocked from the AudioContext so that
 * audio and video stay in sync, exactly like the offline render.
 */
export function usePlayer(canvasRef: React.RefObject<HTMLCanvasElement | null>, recipe: Recipe, muted: boolean, volume: number) {
  const runnerRef = useRef<Runner | null>(null);
  /** `out` is the preview-only volume control; renders never go through it. */
  const audioRef = useRef<{ ctx: AudioContext; bus: SynthBus; reverb: number; out: GainNode } | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const rafRef = useRef(0);
  const clockRef = useRef({ origin: 0, audioIdx: 0 });
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const [status, setStatus] = useState<Status>('ready');
  const [time, setTime] = useState(0);
  const recipeKey = JSON.stringify(recipe);
  /** The recipe's narration clips (loaded with the runner; the bus plays them as 'voice' events). */
  const samplesRef = useRef<Map<string, AudioBuffer>>(new Map());

  const draw = useCallback(() => {
    if (canvasRef.current && runnerRef.current) runnerRef.current.draw(canvasRef.current);
  }, [canvasRef]);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (audioRef.current) {
      // Drop any notes (and narration) already scheduled ahead by rebuilding the bus.
      audioRef.current.bus.input.disconnect();
      audioRef.current.bus.voice.disconnect();
      const { ctx, reverb, out } = audioRef.current;
      audioRef.current = { ...audioRef.current, bus: createBus(ctx, { reverb, destination: out, samples: samplesRef.current, lenient: true }) };
    }
  }, []);

  useEffect(() => {
    stop();
    // No runner until the template's files (models) are loaded: play() waits for one.
    runnerRef.current = null;
    let cancelled = false;
    const template = getTemplate(recipe.templateId);
    void Promise.all([template.preload?.(parseParams(template, recipe.params)), loadClips(recipe)]).then(([, samples]) => {
      if (cancelled) return;
      samplesRef.current = samples;
      if (audioRef.current) {
        const { ctx, reverb, out, bus } = audioRef.current;
        bus.input.disconnect();
        bus.voice.disconnect();
        audioRef.current = { ...audioRef.current, bus: createBus(ctx, { reverb, destination: out, samples, lenient: true }) };
      }
      runnerRef.current = makeRunner(recipe);
      setStatus('ready');
      setTime(0);
      draw();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeKey]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  useEffect(() => {
    const a = audioRef.current;
    if (a) a.out.gain.setTargetAtTime(volume, a.ctx.currentTime, 0.02);
  }, [volume]);

  const tick = useCallback(() => {
    const runner = runnerRef.current;
    const audio = audioRef.current;
    if (!runner || !audio) return;
    const target = Math.floor((audio.ctx.currentTime - clockRef.current.origin) * runner.fps);
    // Spend at most ~10ms simulating per animation frame. If a heavy template can't keep up,
    // slide the clock (slight slow-motion) instead of piling up work and freezing the UI.
    const budgetEnd = performance.now() + 10;
    while (runner.frame < target && !runner.done && performance.now() < budgetEnd) runner.advanceFrame();
    if (target - runner.frame > 2) clockRef.current.origin += (target - runner.frame - 1) / runner.fps;
    const evs = runner.audio;
    for (let i = clockRef.current.audioIdx; i < evs.length; i++) {
      if (!mutedRef.current) scheduleEvent(audio.bus, evs[i], Math.max(audio.ctx.currentTime, clockRef.current.origin + evs[i].t));
    }
    clockRef.current.audioIdx = evs.length;
    draw();
    setTime(runner.t);
    if (runner.done) {
      setStatus('done');
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [draw]);

  const play = useCallback(async () => {
    if (!runnerRef.current) return;
    if (runnerRef.current.done) runnerRef.current = makeRunner(recipe);
    const reverb = runnerRef.current.theme.reverb;
    if (!audioRef.current || audioRef.current.reverb !== reverb) {
      const ctx = audioRef.current?.ctx ?? new AudioContext({ sampleRate: 48000 });
      let out = audioRef.current?.out;
      if (!out) {
        out = ctx.createGain();
        out.gain.value = volumeRef.current;
        out.connect(ctx.destination);
      }
      audioRef.current = { ctx, bus: createBus(ctx, { reverb, destination: out, samples: samplesRef.current, lenient: true }), reverb, out };
    }
    await audioRef.current.ctx.resume();
    clockRef.current = { origin: audioRef.current.ctx.currentTime + 0.06 - runnerRef.current.t, audioIdx: runnerRef.current.audio.length };
    setStatus('playing');
    rafRef.current = requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeKey, tick]);

  const pause = useCallback(() => {
    stop();
    setStatus('paused');
  }, [stop]);

  const restart = useCallback(() => {
    stop();
    runnerRef.current = makeRunner(recipe);
    setTime(0);
    draw();
    void play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeKey, play, stop, draw]);

  return { status, time, play, pause, restart };
}
