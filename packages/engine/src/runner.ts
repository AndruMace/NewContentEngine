import { z } from 'zod';
import { Rng } from './rng';
import { MelodyCursor, transposeMelody, type Melody } from './melody';
import type { Theme } from './themes';
import type { AudioEvent, Copy, Ctx2D, DramaScore, OverlaySpec, SimEvent, Template, VideoFormat, VoiceTrack } from './types';
import { drawOverlays, fillCopy, newOverlayState, type OverlayState } from './overlays';
import { PostFx, fillBackground } from './postfx';

export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;
export const FPS = 60;
export const SHORTS_FORMAT: VideoFormat = { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, fps: FPS };

export const formatOf = (template: Template): VideoFormat => template.format ?? SHORTS_FORMAT;

/** Everything needed to reproduce a video exactly. */
export interface Recipe {
  templateId: string;
  seed: number;
  params: Record<string, unknown>;
  themeId: string;
  melodyId: string;
  copy?: Partial<Copy>;
  /** Target duration the seed was chosen for. */
  targetS?: number;
  /** Long-form: master loop length (defaults to the template's defaultLoopS). */
  loopS?: number;
  /** Long-form: final video length the loop is repeated to. */
  totalS?: number;
  /** Narration, written and voiced before rendering (see @sim/voice). Its line lengths time the sim. */
  voice?: VoiceTrack;
}

/** A long-form recipe's loop length, clamped to what the template allows (`allowShort` for quick test renders). */
export function loopLengthOf(template: Template, loopS?: number, allowShort = false): number {
  const lf = template.longForm;
  if (!lf) return 0;
  const s = loopS ?? lf.defaultLoopS;
  if (allowShort) return Math.min(lf.maxLoopS, Math.max(1, s));
  // Whole multiples of the step (beds' lengths must divide the loop), within the allowed range.
  const step = lf.loopStepS ?? 1;
  const lo = Math.ceil(lf.minLoopS / step) * step;
  const hi = Math.floor(lf.maxLoopS / step) * step;
  return Math.min(hi, Math.max(lo, Math.round(s / step) * step));
}

export interface RunnerOptions {
  seed: number;
  params?: unknown;
  theme: Theme;
  melody: Melody;
  copy?: Partial<Copy>;
  /** False for headless seed search (no particles etc). */
  visual?: boolean;
  maxSeconds?: number;
  transpose?: number;
  /** Long-form: master loop length (already validated, see loopLengthOf). */
  loopS?: number;
  /** Prepared narration: templates time their beats to its lines (estimates without it). */
  voice?: VoiceTrack;
}

/**
 * Validate params, falling back to the default for any that no longer fit the schema (e.g. a saved
 * recipe naming an option that has since been removed) instead of throwing.
 */
export function parseParams<P>(template: Template<P, any>, raw: object): P {
  const first = template.schema.safeParse(raw);
  if (first.success) return first.data;
  const bad = new Set(first.error.issues.map((i) => String(i.path[0])));
  const kept = Object.fromEntries(Object.entries(raw).filter(([k]) => !bad.has(k)));
  const second = template.schema.safeParse(kept);
  return second.success ? second.data : template.schema.parse({});
}

/**
 * Drives a template deterministically at a fixed timestep: physics substeps at
 * FPS * substeps Hz, frames at FPS. Collects sim events and the derived audio events.
 */
export class Runner<P = any, S = any> {
  readonly params: P;
  readonly substeps: number;
  readonly theme: Theme;
  readonly overlays: OverlaySpec[];
  readonly maxSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Long-form loop length (0 for Shorts). The run ends exactly at loopS. */
  readonly loopS: number;
  state: S;
  frame = 0;
  events: SimEvent[] = [];
  audio: AudioEvent[] = [];
  done = false;
  timedOut = false;

  private stepIndex = 0;
  private cursor: MelodyCursor;
  private lastNoteT = -1;
  private overlayState: OverlayState = newOverlayState();
  private postFx: PostFx | null = null;

  constructor(readonly template: Template<P, S>, opts: RunnerOptions) {
    this.params = parseParams(template, opts.params ?? {});
    this.substeps = template.substeps ?? 4;
    this.theme = opts.theme;
    ({ width: this.width, height: this.height, fps: this.fps } = formatOf(template));
    this.loopS = template.longForm ? (opts.loopS ?? loopLengthOf(template)) : 0;
    const own = typeof template.maxSeconds === 'function' ? template.maxSeconds(this.params) : template.maxSeconds;
    this.maxSeconds = this.loopS || Math.max(opts.maxSeconds ?? 90, own ?? 0);
    this.cursor = new MelodyCursor(opts.melody, opts.transpose ?? 0);
    const rng = new Rng(opts.seed);
    const fxRng = rng.fork(1);
    this.state = template.init({
      params: this.params,
      rng,
      fxRng,
      visual: opts.visual ?? true,
      width: this.width,
      height: this.height,
      loopS: this.loopS,
      theme: opts.theme,
      melody: transposeMelody(opts.melody, opts.transpose ?? 0),
      narration: Object.fromEntries((opts.voice?.lines ?? []).map((l) => [l.beat, l])),
    });
    // Field by field, so a field present but undefined (a cleared input) still falls back to the default.
    const copy: Copy = {
      hook: opts.copy?.hook ?? template.defaultCopy.hook,
      cta: opts.copy?.cta ?? template.defaultCopy.cta,
    };
    const values = this.params as Record<string, unknown>;
    this.overlays = template.overlays(this.params, {
      hook: fillCopy(copy.hook, values),
      cta: fillCopy(copy.cta, values),
    });
    const nudge = opts.copy?.nudge?.trim();
    if (nudge) this.overlays.push(...engagementCues(this.overlays, fillCopy(nudge, values), template.nudgeY));
  }

  get t(): number {
    return this.frame / this.fps;
  }

  get durationS(): number {
    return this.frame / this.fps;
  }

  /** Advance one video frame. Returns the sim events that happened during it. */
  advanceFrame(): SimEvent[] {
    if (this.done) return [];
    const dt = 1 / (this.fps * this.substeps);
    const frameEvents: SimEvent[] = [];
    for (let k = 0; k < this.substeps; k++) {
      const t = this.stepIndex * dt;
      const emit = (e: Omit<SimEvent, 't'>) => {
        const ev = { ...e, t } as SimEvent;
        frameEvents.push(ev);
        this.events.push(ev);
        for (const a of this.template.audio(ev, { melody: this.cursor, theme: this.theme, lastNoteT: this.lastNoteT })) {
          if (a.kind === 'note' && a.vel > 0) this.lastNoteT = t;
          this.audio.push({ ...a, t } as AudioEvent);
        }
      };
      this.template.step(this.state, { dt, t, emit });
      this.stepIndex++;
    }
    this.frame++;
    if (this.loopS) {
      // A loop always ends exactly at loopS: frame loopS·fps is the first frame again, so it isn't rendered.
      if (this.frame >= Math.round(this.loopS * this.fps)) this.done = true;
    } else if (this.template.isDone(this.state)) this.done = true;
    else if (this.t >= this.maxSeconds) {
      this.done = true;
      this.timedOut = true;
    }
    return frameEvents;
  }

  runToEnd(): this {
    while (!this.done) this.advanceFrame();
    return this;
  }

  score(targetS: number): DramaScore {
    return this.template.score(this.events, { durationS: this.durationS, targetS, timedOut: this.timedOut });
  }

  /** Render the current state (scene + post fx + overlays) into a canvas of the template's size. */
  draw(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const ctx = canvas.getContext('2d') as Ctx2D;
    const W = this.width;
    const H = this.height;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    fillBackground(ctx, W, H, this.theme);
    this.template.render({ ctx, width: W, height: H, theme: this.theme, t: this.t, frame: this.frame }, this.state);
    ctx.restore();
    // Long-form scenes do their own grading: no theme bloom, vignette, scanlines or overlays.
    if (this.loopS) return;
    this.postFx ??= new PostFx(W, H);
    const g = this.template.glowScale;
    const glowScale = typeof g === 'function' ? g(this.params) : (g ?? 1);
    this.postFx.apply(ctx, canvas, glowScale === 1 ? this.theme : { ...this.theme, glow: this.theme.glow * glowScale });
    if (this.template.renderTop) {
      ctx.save();
      this.template.renderTop({ ctx, width: W, height: H, theme: this.theme, t: this.t, frame: this.frame }, this.state);
      ctx.restore();
    }
    const hud = { ...(this.params as Record<string, unknown>), ...this.template.hud(this.state) };
    drawOverlays(ctx, W, H, this.overlays, this.overlayState, this.t, hud, this.theme);
  }
}

/**
 * Engagement cues added to any template's overlays: the comment prompt right after the hook fades
 * (in the hook's spot, or `nudgeY` when the hook stays up), and a heart at the payoff, when the CTA
 * appears. Visual only: no events change.
 */
function engagementCues(specs: OverlaySpec[], nudge: string, nudgeY?: number): OverlaySpec[] {
  const hook = specs.find((s): s is Extract<OverlaySpec, { kind: 'hook' }> => s.kind === 'hook');
  const hookEnd = hook?.to ?? 2.2;
  const persistent = hookEnd > 8;
  const from = persistent ? 3.2 : hookEnd + 0.45;
  // In the hook's spot, but no lower than the usual hook line (counters often sit just below it).
  const cues: OverlaySpec[] = [{ kind: 'nudge', text: nudge, from, to: from + 2.8, y: nudgeY ?? (persistent ? 0.25 : Math.min(hook?.y ?? 0.12, 0.125)) }];
  const cta = specs.find((s): s is Extract<OverlaySpec, { kind: 'cta' }> => s.kind === 'cta');
  cues.push({ kind: 'heart', when: !cta || cta.when === 'outro' ? 'outro' : { at: cta.when.from } });
  return cues;
}

/** Seeds worth trying in a seed search for these params (raw params are parsed first). */
export function searchBudgetOf(template: Template, params: Record<string, unknown> | undefined, fallback = 400): number {
  const b = template.searchBudget;
  return typeof b === 'function' ? b(parseParams(template, params ?? {})) : (b ?? fallback);
}

/** JSON Schema of a template's params, for UI controls and LLM tool schemas. */
export function paramsJsonSchema(template: Template): Record<string, any> {
  return z.toJSONSchema(template.schema, { io: 'input' }) as Record<string, any>;
}
