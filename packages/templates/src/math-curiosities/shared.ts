import { FONT_FAMILY, type AudioEventInput, type AudioMapCtx, type Ctx2D, type DramaScore, type InitCtx, type LeaderboardRow, type RenderCtx, type SimEvent, type StepCtx, type Theme } from '@sim/engine';
import type { MathParams, ModeId } from './params';

export interface ScoreInfo {
  durationS: number;
  targetS: number;
  timedOut: boolean;
}

/** One mode of Math Curiosities: a template minus the parts the modes share (schema, ids, copy plumbing). */
export interface ModeImpl<S = any> {
  /** On-screen copy used when the video still has the template's default copy. */
  copy(p: MathParams): { hook: string; cta: string };
  searchBudget: number;
  glowScale: number;
  init(ctx: InitCtx<MathParams>): S;
  step(s: S, ctx: StepCtx): void;
  isDone(s: S): boolean;
  hud(s: S): Record<string, string | number | boolean | LeaderboardRow[]>;
  render(rc: RenderCtx, s: S): void;
  /** Only sees this mode's events (see `modeOfEvent`). */
  audio(e: SimEvent, m: AudioMapCtx): AudioEventInput[];
  score(events: SimEvent[], info: ScoreInfo): DramaScore;
}

/**
 * Event types of the newer modes carry their mode ("collatz:step"), so audio and scoring, which see
 * events without the state, can route them. The blocks keep their original unprefixed types (old
 * renders replay with identical event logs).
 */
export const ev = (mode: ModeId, name: string) => `${mode}:${name}`;

export function modeOfEvent(e: SimEvent): ModeId {
  const i = e.type.indexOf(':');
  return (i < 0 ? 'blocks' : e.type.slice(0, i)) as ModeId;
}

/** Strip the mode prefix: the name a mode switches on. */
export const evName = (e: SimEvent) => e.type.slice(e.type.indexOf(':') + 1);

/** Seconds the result stays up at the end (the CTA comes in OUTRO_DELAY_S after it). */
export const REVEAL_S = 4.2;
export const OUTRO_DELAY_S = 1.6;
/** Content stays below this line, clear of the hook and CTA. */
export const TOP_Y = 330;

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const smooth = (u: number) => {
  const x = clamp01(u);
  return x * x * (3 - 2 * x);
};
/** Overshooting pop-in, 0 → 1 (peaks at about 1.1). */
export const popIn = (u: number) => {
  const k = clamp01(u) - 1;
  return 1 + 2.7 * k * k * k + 1.7 * k * k;
};
/** 1 right after `since` = 0, fading out at `rate` per second. */
export const flash = (since: number, rate: number) => (since < 0 ? 0 : Math.exp(-since * rate));

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * Sim-time cues: a mode lays out its whole run up front (so the video lands on its length exactly)
 * and fires each cue when its time comes.
 */
export interface Cue {
  t: number;
  [key: string]: unknown;
}

/** Fire every cue due by `t` (in order); returns how many fired. */
export function fireCues<C extends Cue>(cues: C[], s: { cue: number }, t: number, fire: (c: C) => void): number {
  let n = 0;
  while (s.cue < cues.length && cues[s.cue].t <= t) {
    fire(cues[s.cue++]);
    n++;
  }
  return n;
}

/** Outlined text, the look every caption in the template uses. Shrinks to fit `maxW` (default: the frame, with margins). */
export function outlined(
  ctx: Ctx2D,
  theme: Theme,
  text: string,
  x: number,
  y: number,
  o: { size: number; weight?: number; fill?: string; align?: CanvasTextAlign; stroke?: number; alpha?: number; scale?: number; maxW?: number },
) {
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.translate(x, y);
  ctx.textAlign = o.align ?? 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${o.weight ?? 900} ${o.size}px ${FONT_FAMILY}`;
  const fit = Math.min(1, (o.maxW ?? 1000) / Math.max(1, ctx.measureText(text).width));
  const k = (o.scale ?? 1) * fit;
  if (k !== 1) ctx.scale(k, k);
  ctx.lineJoin = 'round';
  ctx.lineWidth = o.stroke ?? Math.max(4, o.size / 9);
  ctx.strokeStyle = theme.textStroke;
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = o.fill ?? theme.text;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** Plain (unoutlined) small caption. */
export function caption(ctx: Ctx2D, text: string, x: number, y: number, size: number, fill = 'rgba(255,255,255,0.6)', align: CanvasTextAlign = 'center', weight = 800) {
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/** The mode's name as a small spaced-out title at the top of the content area. */
export function drawModeTitle(ctx: Ctx2D, text: string, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  caption(ctx, text.toUpperCase(), 540, TOP_Y + 16, 30, 'rgba(255,255,255,0.55)');
  ctx.restore();
}

/** A rounded dark panel. */
export function panel(ctx: Ctx2D, x: number, y: number, w: number, h: number, r = 22, fill = 'rgba(0,0,0,0.35)', stroke = 'rgba(255,255,255,0.12)') {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/** Offscreen canvas that works in the browser and in the renderer. */
export function makeLayer(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
}
