import { FONT_FAMILY, type AudioEventInput, type AudioMapCtx, type Ctx2D, type DramaScore, type InitCtx, type LeaderboardRow, type RenderCtx, type SimEvent, type StepCtx, type Theme } from '@sim/engine';
import type { AutomataParams, ModeId } from './params';

export interface ScoreInfo {
  durationS: number;
  targetS: number;
  timedOut: boolean;
}

/** One mode of 3D Automata: a template minus the parts the modes share (schema, ids, copy plumbing). */
export interface ModeImpl<S = any> {
  /** On-screen copy used when the video still has the template's default copy. */
  copy(p: AutomataParams): { hook: string; cta: string };
  searchBudget: number;
  init(ctx: InitCtx<AutomataParams>): S;
  step(s: S, ctx: StepCtx): void;
  isDone(s: S): boolean;
  hud(s: S): Record<string, string | number | boolean | LeaderboardRow[]>;
  render(rc: RenderCtx, s: S): void;
  renderTop(rc: RenderCtx, s: S): void;
  /** This run's rules in plain words, for the explainer at the bottom. */
  explain(s: S): string;
  /** Only sees this mode's events (see `modeOfEvent`). */
  audio(e: SimEvent, m: AudioMapCtx): AudioEventInput[];
  score(events: SimEvent[], info: ScoreInfo): DramaScore;
  outcome(events: SimEvent[]): string | null;
}

/** Event types carry their mode ("crystal:gen"), so audio and scoring, which see events without the state, can route them. */
export const ev = (mode: ModeId, name: string) => `${mode}:${name}`;

export const modeOfEvent = (e: SimEvent): ModeId => e.type.slice(0, e.type.indexOf(':')) as ModeId;

/** Strip the mode prefix: the name a mode switches on. */
export const evName = (e: SimEvent) => e.type.slice(e.type.indexOf(':') + 1);

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

/**
 * How well a run's length fits the target. Running short is penalised gently (short-lived runs play
 * at their own pace on purpose, not stretched to fill), running long more firmly.
 */
export const durationFit = (durationS: number, targetS: number) => Math.exp(-(((durationS - targetS) / (targetS * (durationS < targetS ? 0.55 : 0.2))) ** 2));

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

/** Pan for a position across the grid (-1..1 → -0.6..0.6). */
export const panOf = (x: unknown) => (typeof x === 'number' ? Math.max(-0.6, Math.min(0.6, x * 0.6)) : 0);

/** How loud a generation's notes are, from how much changed in it. */
export const velOf = (changes: number) => 0.22 + 0.4 * clamp01(Math.log10(changes + 1) / 3.5);

/** Outlined text, the look every caption in the template uses. Shrinks to fit `maxW`. */
export function outlined(ctx: Ctx2D, theme: Theme, text: string, x: number, y: number, o: { size: number; weight?: number; fill?: string; alpha?: number; maxW?: number }) {
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.translate(x, y);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${o.weight ?? 900} ${o.size}px ${FONT_FAMILY}`;
  const fit = Math.min(1, (o.maxW ?? 980) / Math.max(1, ctx.measureText(text).width));
  if (fit !== 1) ctx.scale(fit, fit);
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, o.size / 8);
  ctx.strokeStyle = theme.textStroke;
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = o.fill ?? theme.text;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/**
 * The generation counter and a second line (cell count, the result) low on the frame, and the run's
 * name (rule, pattern) as a small title once the hook has gone.
 */
export function drawCounter(ctx: Ctx2D, theme: Theme, o: { t: number; title: string; gen: number; line: string; flash?: number; y?: number; endAt?: number }) {
  const y = o.y ?? 1920 * 0.8;
  // In after the hook, out before the CTA takes its place.
  const titleIn = clamp01((o.t - 2.9) / 0.5) * (o.endAt === undefined ? 1 : 1 - clamp01((o.t - o.endAt) / 0.3));
  if (titleIn > 0) outlined(ctx, theme, o.title, 540, 1920 * 0.13, { size: 46, weight: 800, alpha: titleIn });
  const pop = 1 + 0.12 * (o.flash ?? 0);
  outlined(ctx, theme, `Generation ${fmtInt(o.gen)}`, 540, y, { size: Math.round(64 * pop) });
  if (o.line) outlined(ctx, theme, o.line, 540, y + 72, { size: 40, weight: 800, alpha: 0.9 });
}

/**
 * Generation times for a run of `total` generations over `spanS` seconds: a steady pace when that
 * is slow enough to follow, otherwise starting at `startRate` per second and speeding up
 * exponentially so the last generation lands at the end of the span.
 */
export function genSchedule(total: number, spanS: number, startRate: number): (gen: number) => number {
  if (total <= 0) return () => 0;
  if (total <= startRate * spanS * 1.15) return (g) => (g / total) * spanS;
  // gens(u) = total (e^{ku} − 1) / (e^k − 1); its starting rate total·k / ((e^k − 1)·span) = startRate.
  const rate0 = (k: number) => (total * k) / ((Math.exp(k) - 1) * spanS);
  let lo = 1e-4;
  let hi = 40;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (rate0(mid) > startRate) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  const ek = Math.exp(k) - 1;
  return (g) => (Math.log(1 + (g / total) * ek) / k) * spanS;
}

/** Bottom of the explainer panel: just above the band platforms cover with their own buttons and captions. */
const EXPLAIN_BOTTOM = 1920 * 0.79;
/** How far the 3D view is lifted when the explainer is on (pixels). */
export const EXPLAIN_LIFT = 170;

/** Split text into lines no wider than maxW at the current font. */
function wrap(ctx: Ctx2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The rules in a dark rounded panel at the bottom of the safe area. Returns the panel's top, so the
 * counter can sit above it.
 */
export function drawExplainer(ctx: Ctx2D, text: string, t: number): number {
  const size = 34;
  const lineH = 44;
  const padX = 34;
  const padY = 24;
  const w = 960;
  ctx.save();
  ctx.font = `700 ${size}px ${FONT_FAMILY}`;
  const lines = wrap(ctx, text, w - padX * 2);
  const h = lines.length * lineH + padY * 2;
  const top = EXPLAIN_BOTTOM - h;
  ctx.globalAlpha = clamp01((t - 0.2) / 0.5);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(540 - w / 2, top, w, h, 26);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, 540, top + padY + lineH * (i + 0.5)));
  ctx.restore();
  return top;
}
