import { useCallback, useEffect, useRef, useState } from 'react';
import { FPS, type Recipe, type Runner } from '@sim/engine';
import { createBus, scheduleEvent, type SynthBus } from '@sim/audio';
import { makeRunner } from './recipe';

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

  const draw = useCallback(() => {
    if (canvasRef.current && runnerRef.current) runnerRef.current.draw(canvasRef.current);
  }, [canvasRef]);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (audioRef.current) {
      // Drop any notes already scheduled ahead by rebuilding the bus.
      audioRef.current.bus.input.disconnect();
      const { ctx, reverb, out } = audioRef.current;
      audioRef.current = { ...audioRef.current, bus: createBus(ctx, { reverb, destination: out }) };
    }
  }, []);

  useEffect(() => {
    stop();
    runnerRef.current = makeRunner(recipe);
    setStatus('ready');
    setTime(0);
    draw();
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
    const target = Math.floor((audio.ctx.currentTime - clockRef.current.origin) * FPS);
    let n = 0;
    while (runner.frame < target && !runner.done && n++ < 8) runner.advanceFrame();
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
      audioRef.current = { ctx, bus: createBus(ctx, { reverb, destination: out }), reverb, out };
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
