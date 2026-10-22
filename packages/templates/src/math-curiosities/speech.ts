import { FONT_FAMILY, type AudioEventInput, type Ctx2D, type NarrationBeat, type NarrationLine, type StepCtx, type Theme } from '@sim/engine';
import type { ModeId } from './params';
import { clamp01, ev } from './shared';

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

/**
 * The spoken line as a caption, words lighting up as they're said (timed by their share of the
 * line's letters: no word timestamps from the voice). Wraps onto two lines; shrinks if it must.
 */
export function drawSpoken(ctx: Ctx2D, theme: Theme, caption: string, progress: number, x: number, y: number, o: { size: number; maxW: number; lit?: string }) {
  const words = caption.split(/\s+/).filter(Boolean);
  if (!words.length) return;
  let size = o.size;
  let rows: string[][] = [];
  for (; size >= o.size * 0.6; size -= 2) {
    ctx.font = `900 ${size}px ${FONT_FAMILY}`;
    rows = wrap(ctx, words, o.maxW);
    if (rows.length <= 2) break;
  }
  const total = caption.replace(/\s+/g, '').length;
  let seen = 0;
  const lineH = size * 1.22;
  ctx.save();
  ctx.font = `900 ${size}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, size / 8);
  ctx.strokeStyle = theme.textStroke;
  const space = ctx.measureText(' ').width;
  rows.forEach((row, r) => {
    const widths = row.map((w) => ctx.measureText(w).width);
    let cx = x - (widths.reduce((a, b) => a + b, 0) + space * (row.length - 1)) / 2;
    const cy = y + (r - (rows.length - 1) / 2) * lineH;
    row.forEach((w, i) => {
      const start = seen / total;
      seen += w.length;
      const on = clamp01((progress - start) / 0.04);
      ctx.strokeText(w, cx, cy);
      ctx.fillStyle = on >= 1 ? (o.lit ?? theme.accent) : `rgba(255,255,255,${0.45 + 0.5 * on})`;
      ctx.fillText(w, cx, cy);
      cx += widths[i] + space;
    });
  });
  ctx.restore();
}

function wrap(ctx: Ctx2D, words: string[], maxW: number): string[][] {
  const rows: string[][] = [[]];
  for (const w of words) {
    const row = rows[rows.length - 1];
    const next = [...row, w].join(' ');
    if (row.length && ctx.measureText(next).width > maxW) rows.push([w]);
    else row.push(w);
  }
  // Balance two rows, so the second isn't a single dangling word.
  if (rows.length === 2) {
    const all = [...rows[0], ...rows[1]];
    let best = rows;
    let bestDiff = Infinity;
    for (let k = 1; k < all.length; k++) {
      const a = all.slice(0, k);
      const b = all.slice(k);
      const wa = ctx.measureText(a.join(' ')).width;
      const wb = ctx.measureText(b.join(' ')).width;
      if (wa > maxW || wb > maxW) continue;
      if (Math.abs(wa - wb) < bestDiff) {
        bestDiff = Math.abs(wa - wb);
        best = [a, b];
      }
    }
    return best;
  }
  return rows;
}

/** Progress through a spoken line, 0..1 (speech starts a moment into the clip). */
export const spokenProgress = (since: number, durationS: number) => clamp01((since - 0.05) / Math.max(0.3, durationS - 0.15));
