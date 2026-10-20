import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Runner, getTheme, loopLengthOf, type Recipe } from '@sim/engine';
import { createBus, getMelody, playBeds, scheduleEvent, type SynthBus } from '@sim/audio';
import { getTemplate, loadedSounds, setAssetBase } from '@sim/templates';

setAssetBase('/ambient-assets/');

/** How long a setting must stay still before the preview rebuilds for it (ms). */
const SETTLE_MS = 250;

/** Split params into the template's live ones (applied in place) and the rest (rebuild). */
function split(params: Record<string, unknown>, live: string[]) {
  const liveP: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) (live.includes(k) ? liveP : rest)[k] = v;
  return { liveP, rest };
}

/**
 * Live preview of a long-form (ambient) recipe: plays from any point of the loop. Every frame depends
 * only on time, so seeking just fast-forwards the (trivial) sim to the new frame; the recorded beds
 * start at the matching point, and events are scheduled a little ahead from the audio clock.
 *
 * Settings the template marks live (LongFormSpec.liveParams: lamp brightness, rain intensity…) are
 * applied to the running scene in place. Any other change rebuilds it, once the control has been
 * still for SETTLE_MS (dragging a slider doesn't rebuild on every step); the old scene keeps playing
 * meanwhile.
 */
export function useAmbientPlayer(canvasRef: React.RefObject<HTMLCanvasElement | null>, recipe: Recipe, volume: number) {
  const template = getTemplate(recipe.templateId);
  const live = template.longForm?.liveParams ?? [];
  const params = (recipe.params ?? {}) as Record<string, unknown>;
  const { liveP, rest } = split(params, live);
  const loopS = loopLengthOf(template, recipe.loopS);
  const structKey = JSON.stringify({ t: recipe.templateId, s: recipe.seed, p: rest, loopS });
  const liveKey = JSON.stringify(liveP);

  // The recipe the scene was built for, caught up SETTLE_MS after the last structural change.
  const [settled, setSettled] = useState({ key: structKey, recipe });
  useEffect(() => {
    if (structKey === settled.key) return;
    const id = setTimeout(() => setSettled({ key: structKey, recipe }), SETTLE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);
  const key = settled.key;
  const built = settled.recipe;
  const builtTemplate = getTemplate(built.templateId);
  const builtLoopS = loopLengthOf(builtTemplate, built.loopS);

  const [ready, setReady] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);

  const runnerRef = useRef<Runner | null>(null);
  const audio = useRef<{ ctx: AudioContext; out: GainNode } | null>(null);
  const live_ = useRef<{ bus: SynthBus; stopBeds: () => void; origin: number; idx: number } | null>(null);
  const raf = useRef(0);
  const timeRef = useRef(0);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  // The latest live settings, merged over what the scene was built with.
  const liveRef = useRef(liveP);
  liveRef.current = liveP;
  const paramsNow = useCallback(() => builtTemplate.schema.parse({ ...(built.params ?? {}), ...liveRef.current }) as Record<string, unknown>, [builtTemplate, built]);

  const runnerAt = useCallback(
    (t: number) => {
      const frame = Math.max(0, Math.round(t * 30));
      let r = runnerRef.current;
      if (!r || r.frame > frame) {
        r = new Runner(builtTemplate, { seed: built.seed, params: built.params, theme: getTheme(built.themeId), melody: getMelody(built.melodyId), loopS: builtLoopS });
        runnerRef.current = r;
      }
      while (r.frame < frame && !r.done) r.advanceFrame();
      // Live settings: the scene reads them from its state's params every frame.
      (r.state as { p?: unknown }).p = paramsNow();
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
    if (live_.current) {
      live_.current.stopBeds();
      live_.current.bus.input.disconnect();
      live_.current = null;
    }
  }, []);

  // Load the template's textures, models and recordings, then show the first frame. After the
  // first load the previous picture stays up (with a small "updating" note) until this is ready.
  useEffect(() => {
    let cancelled = false;
    const wasPlaying = live_.current !== null;
    setUpdating(true);
    setError(null);
    (async () => {
      try {
        await builtTemplate.preload?.(builtTemplate.schema.parse(built.params));
        if (cancelled) return;
        stopAudio();
        runnerRef.current = null;
        timeRef.current = Math.min(timeRef.current, builtLoopS - 1);
        runnerAt(timeRef.current);
        draw();
        setTime(timeRef.current);
        setReady(true);
        setUpdating(false);
        if (wasPlaying) void start(timeRef.current);
        else setPlaying(false);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setUpdating(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => () => stopAudio(), [stopAudio]);

  useEffect(() => {
    const a = audio.current;
    if (a) a.out.gain.setTargetAtTime(volume, a.ctx.currentTime, 0.02);
  }, [volume]);

  const tick = useCallback(() => {
    const l = live_.current;
    const a = audio.current;
    if (!l || !a) return;
    const t = a.ctx.currentTime - l.origin;
    if (t >= builtLoopS) {
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
  }, [key, draw, runnerAt, stopAudio, builtLoopS]);

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
      const lf = builtTemplate.longForm!;
      const p = paramsNow();
      // A live change may want a recording the scene hasn't loaded yet (rain → snow): cached otherwise.
      await builtTemplate.preload?.(p);
      const at = ctx.currentTime + 0.08;
      const origin = at - from;
      // Sim time = context time + t0, as in the offline render (noise and beds line up the same way).
      const bus = createBus(ctx, { reverb: lf.reverb ?? 0, destination: out, samples: loadedSounds(), compress: false, loopS: builtLoopS, t0: -origin });
      const stopBeds = playBeds(bus, lf.beds?.(p) ?? [], at, builtLoopS - from + 1);
      const r = runnerAt(from);
      live_.current = { bus, stopBeds, origin, idx: r.audio.length };
      setPlaying(true);
      raf.current = requestAnimationFrame(tick);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, runnerAt, tick, builtLoopS],
  );

  // A live setting changed: the next frame reads it. Redraw now if paused; if playing, the beds'
  // levels follow once the control settles (restarting the sound on every slider step would stutter).
  useEffect(() => {
    const r = runnerRef.current;
    if (!r) return;
    (r.state as { p?: unknown }).p = paramsNow();
    if (!live_.current) {
      draw();
      return;
    }
    const id = setTimeout(() => {
      if (!live_.current || !audio.current) return;
      const t = audio.current.ctx.currentTime - live_.current.origin;
      stopAudio();
      void start(Math.max(0, Math.min(builtLoopS - 0.1, t)));
    }, SETTLE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  const play = useCallback(() => void start(timeRef.current), [start]);
  const pause = useCallback(() => {
    stopAudio();
    setPlaying(false);
  }, [stopAudio]);

  const seek = useCallback(
    (t: number) => {
      const was = live_.current !== null;
      stopAudio();
      timeRef.current = Math.max(0, Math.min(builtLoopS - 0.1, t));
      runnerAt(timeRef.current);
      draw();
      setTime(timeRef.current);
      if (was) void start(timeRef.current);
    },
    [stopAudio, runnerAt, draw, start, builtLoopS],
  );

  // While a rebuild is pending (a setting just changed) the scrub bar still covers the built loop.
  const pending = structKey !== key;
  return useMemo(
    () => ({ ready, updating: updating || pending, error, playing, time, loopS: builtLoopS, play, pause, seek }),
    [ready, updating, pending, error, playing, time, builtLoopS, play, pause, seek],
  );
}
