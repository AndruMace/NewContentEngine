import { z } from 'zod';
import type { AudioEventInput, DramaScore, InitCtx, NarrationBeat, NarrationSpec, SimEvent } from '@sim/engine';
import { newDirector, type Director, type Script } from './director';
import { NARRATORS } from '../math-curiosities/params';
import { gaussFit } from '../scoring';

/** Narration level against the music (the mix is loudness-normalised afterwards). */
export const VOICE_VEL = 1.5;

/**
 * Settings every narrated template has. Narration is off by default, so browsing a template or
 * changing its settings in the Playground never writes or voices lines (a paid TTS would charge for
 * each); off, the same script plays with its lines as captions paced for reading.
 */
export const storyParams = (defaultTargetS = 40) => ({
  narration: z.enum(['off', 'on']).default('off').meta({ title: 'Narration (voiceover)' }),
  narrator: z.enum(NARRATORS).default('af_heart').meta({ title: 'Narrator voice' }),
  captions: z.boolean().default(true).meta({ title: 'Captions' }),
  targetS: z.number().min(20).max(75).default(defaultTargetS).meta({ title: 'Target length (s)', step: 1 }),
});

export interface StoryParams {
  narration: 'on' | 'off';
  narrator: (typeof NARRATORS)[number];
  captions: boolean;
  targetS: number;
}

/** The narration spec: beats are read from the say events, which carry their definitions and facts. */
export function storyNarration<P extends StoryParams>(style: string): NarrationSpec<P> {
  return {
    enabled: (p) => p.narration === 'on',
    voice: (p) => p.narrator,
    style,
    beats: (_p, events) => sayEvents(events),
  };
}

export function sayEvents(events: SimEvent[]): NarrationBeat[] {
  return events
    .filter((e) => e.type === 'story:say')
    .map((e) => {
      const def = e.def as Omit<NarrationBeat, 'id' | 'facts'>;
      return { id: e.beat as string, ...def, facts: e.facts as NarrationBeat['facts'] };
    });
}

/** The voice for a say event (only voiced lines carry a clip). */
export function storyAudio(e: SimEvent): AudioEventInput[] | null {
  if (e.type !== 'story:say') return null;
  return typeof e.clip === 'string' ? [{ kind: 'voice', clip: e.clip, vel: VOICE_VEL }] : [];
}

/** How close to the target length a run landed (part of every narrated template's score). */
export function lengthFit(durationS: number, targetS: number): number {
  return gaussFit(durationS, targetS, Math.max(4, targetS * 0.2));
}

/** A score built from named parts with weights. */
export function weighted(parts: Record<string, [value: number, weight: number]>, notes: string[] = []): DramaScore {
  let sum = 0;
  let w = 0;
  const out: Record<string, number> = {};
  for (const [k, [v, wt]] of Object.entries(parts)) {
    out[k] = v;
    sum += v * wt;
    w += wt;
  }
  return { total: w ? sum / w : 0, parts: out, notes };
}

/**
 * The Director for a narrated template's run: voiced lines only when narration is on (a recipe can
 * still carry lines from when it was), estimates otherwise.
 */
export function storyDirector<S>(script: Script<S>, ctx: InitCtx<StoryParams>, substeps: number): Director<S> {
  return newDirector(script, { substeps, targetS: ctx.params.targetS, narration: ctx.params.narration === 'on' ? ctx.narration : {} });
}
