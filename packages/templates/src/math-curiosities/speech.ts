import type { AudioEventInput, NarrationBeat, NarrationLine, StepCtx } from '@sim/engine';
import type { ModeId } from './params';
import { ev } from './shared';

/**
 * Narration for the modes that have it. A mode lays out its beats (what each line talks about and
 * how many words it may use); the lines are written and voiced before rendering (@sim/voice), and
 * their real lengths come back in `narration`, which stretches the beats to fit. Before that (seed
 * search, an unvoiced preview) lengths are estimated from the word budgets.
 */

/** Speaking pace for estimates (Kokoro reads at about this rate). */
export const WORDS_PER_S = 2.6;
/** Narration level against the music (the mix is loudness-normalised afterwards). */
export const VOICE_VEL = 1.5;

export const estimateS = (maxWords: number) => 0.35 + maxWords / WORDS_PER_S;

/** A beat as a mode defines it; facts are filled in per run. */
export type BeatDef = Omit<NarrationBeat, 'facts' | 'id'>;

/** How long a beat's line runs: measured when voiced, estimated otherwise. */
export const lineLength = (narration: Record<string, NarrationLine>, beat: string, def: BeatDef) => narration[beat]?.durationS ?? estimateS(def.maxWords);

export interface SayCue {
  t: number;
  beat: string;
}

export interface Speech {
  says: SayCue[];
  next: number;
  /** The line being spoken (or last spoken) and when it started. */
  current: { line: NarrationLine; at: number } | null;
  lines: Record<string, NarrationLine>;
}

export const newSpeech = (lines: Record<string, NarrationLine>): Speech => ({ says: [], next: 0, current: null, lines });

/** Start every line due by `t` (only voiced lines make a sound and a caption). */
export function fireSays(sp: Speech, mode: ModeId, t: number, emit: StepCtx['emit']) {
  while (sp.next < sp.says.length && sp.says[sp.next].t <= t) {
    const { beat } = sp.says[sp.next++];
    const line = sp.lines[beat];
    if (!line) continue;
    sp.current = { line, at: t };
    emit({ type: ev(mode, 'say'), beat, clip: line.clip });
  }
}

/** The line on screen now: from its start until a beat after it ends. */
export function speaking(sp: Speech, t: number): { line: NarrationLine; since: number } | null {
  const c = sp.current;
  if (!c) return null;
  const since = t - c.at;
  return since >= 0 && since < c.line.durationS + 0.6 ? { line: c.line, since } : null;
}

/** The sound for a say event. */
export const sayAudio = (clip: string): AudioEventInput[] => [{ kind: 'voice', clip, vel: VOICE_VEL }];

export { drawSpoken, spokenProgress } from '../story/caption';
