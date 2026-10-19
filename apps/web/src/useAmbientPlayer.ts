import { useCallback, useEffect, useRef, useState } from 'react';
import { Runner, getTheme, loopLengthOf, type Recipe } from '@sim/engine';
import { createBus, getMelody, playBeds, scheduleEvent, type SynthBus } from '@sim/audio';
import { getTemplate, loadedSounds, setAssetBase } from '@sim/templates';

setAssetBase('/ambient-assets/');

/**
 * Live preview of a long-form (ambient) recipe: plays from any point of the loop. Every frame depends
 * only on time, so seeking just fast-forwards the (trivial) sim to the new frame; the recorded beds
 * start at the matching point, and events are scheduled a little ahead from the audio clock.
 */
export function useAmbientPlayer(canvasRef: React.RefObject<HTMLCanvasElement | null>, recipe: Recipe, volume: number) {
  const template = getTemplate(recipe.templateId);
  const loopS = loopLengthOf(template, recipe.loopS);
  const key = JSON.stringify({ t: recipe.templateId, s: recipe.seed, p: recipe.params, loopS });

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);

  const runnerRef = useRef<Runner | null>(null);
  const audio = useRef<{ ctx: AudioContext; out: GainNode } | null>(null);
  const live = useRef<{ bus: SynthBus; stopBeds: () => void; origin: number; idx: number } | null>(null);
  const raf = useRef(0);
  const timeRef = useRef(0);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const runnerAt = useCallback(
    (t: number) => {
      const frame = Math.max(0, Math.round(t * 30));
      let r = runnerRef.current;
      if (!r || r.frame > frame) {
        r = new Runner(template, { seed: recipe.seed, params: recipe.params, theme: getTheme(recipe.themeId), melody: getMelody(recipe.melodyId), loopS });
        runnerRef.current = r;
      }
      while (r.frame < frame && !r.done) r.advanceFrame();
      return r;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const draw = useCallback(() => {
    if (canvasRef.current && runnerRef.current) runnerRef.current.draw(canvasRef.current);
  }, [canvasRef]);

  const stopAudio = useCallback(() => {
    cancelAnimationFrame(raf.current);
    if (live.current) {
      live.current.stopBeds();
      live.current.bus.input.disconnect();
      live.current = null;
    }
  }, []);

  // Load the template's textures, models and recordings, then show the first frame.
  useEffect(() => {
    let cancelled = false;
    stopAudio();
    setPlaying(false);
    setReady(false);
    setError(null);
    runnerRef.current = null;
    (async () => {
      try {
        await template.preload?.(template.schema.parse(recipe.params));
        if (cancelled) return;
        runnerAt(timeRef.current = Math.min(timeRef.current, loopS - 1));
        draw();
        setTime(timeRef.current);
        setReady(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      stopAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const a = audio.current;
    if (a) a.out.gain.setTargetAtTime(volume, a.ctx.currentTime, 0.02);
  }, [volume]);

  const tick = useCallback(() => {
    const l = live.current;
    const a = audio.current;
    if (!l || !a) return;
    const t = a.ctx.currentTime - l.origin;
    if (t >= loopS) {
      // The loop's end flows into its start: play on from the top.
      timeRef.current = 0;
      stopAudio();
      void start(0);
      return;
    }
    const r = runnerAt(t);
    const evs = r.audio;
    for (; l.idx < evs.length; l.idx++) scheduleEvent(l.bus, evs[l.idx], Math.max(a.ctx.currentTime, l.origin + evs[l.idx].t));
    draw();
    timeRef.current = t;
    setTime(t);
    raf.current = requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, draw, runnerAt, stopAudio, loopS]);

  const start = useCallback(
    async (from: number) => {
      if (!audio.current) {
        const ctx = new AudioContext({ sampleRate: 48000 });
        const out = ctx.createGain();
        out.gain.value = volumeRef.current;
        out.connect(ctx.destination);
        audio.current = { ctx, out };
      }
      const { ctx, out } = audio.current;
      await ctx.resume();
      const lf = template.longForm!;
      const at = ctx.currentTime + 0.08;
      const origin = at - from;
      // Sim time = context time + t0, as in the offline render (noise and beds line up the same way).
      const bus = createBus(ctx, { reverb: lf.reverb ?? 0, destination: out, samples: loadedSounds(), compress: false, loopS, t0: -origin });
      const params = template.schema.parse(recipe.params);
      const stopBeds = playBeds(bus, lf.beds?.(params) ?? [], at, loopS - from + 1);
      const r = runnerAt(from);
      live.current = { bus, stopBeds, origin, idx: r.audio.length };
      setPlaying(true);
      raf.current = requestAnimationFrame(tick);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, runnerAt, tick, loopS],
  );

  const play = useCallback(() => void start(timeRef.current), [start]);
  const pause = useCallback(() => {
    stopAudio();
    setPlaying(false);
  }, [stopAudio]);

  const seek = useCallback(
    (t: number) => {
      const was = live.current !== null;
      stopAudio();
      timeRef.current = Math.max(0, Math.min(loopS - 0.1, t));
      runnerAt(timeRef.current);
      draw();
      setTime(timeRef.current);
      if (was) void start(timeRef.current);
    },
    [stopAudio, runnerAt, draw, start, loopS],
  );

  return { ready, error, playing, time, loopS, play, pause, seek };
}
