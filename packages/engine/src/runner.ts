import { z } from 'zod';
import { Rng } from './rng';
import { MelodyCursor, type Melody } from './melody';
import type { Theme } from './themes';
import type { AudioEvent, Copy, Ctx2D, DramaScore, OverlaySpec, SimEvent, Template } from './types';
import { drawOverlays, fillCopy, newOverlayState, type OverlayState } from './overlays';
import { PostFx, fillBackground } from './postfx';

export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;
export const FPS = 60;

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
    this.maxSeconds = opts.maxSeconds ?? 90;
    this.cursor = new MelodyCursor(opts.melody, opts.transpose ?? 0);
    const rng = new Rng(opts.seed);
    const fxRng = rng.fork(1);
    this.state = template.init({
      params: this.params,
      rng,
      fxRng,
      visual: opts.visual ?? true,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      theme: opts.theme,
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
  }

  get t(): number {
    return this.frame / FPS;
  }

  get durationS(): number {
    return this.frame / FPS;
  }

  /** Advance one video frame. Returns the sim events that happened during it. */
  advanceFrame(): SimEvent[] {
    if (this.done) return [];
    const dt = 1 / (FPS * this.substeps);
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
    if (this.template.isDone(this.state)) this.done = true;
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

  /** Render the current state (scene + post fx + overlays) into a 1080x1920 canvas. */
  draw(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const ctx = canvas.getContext('2d') as Ctx2D;
    const W = VIDEO_WIDTH;
    const H = VIDEO_HEIGHT;
    this.postFx ??= new PostFx(W, H);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    fillBackground(ctx, W, H, this.theme);
    this.template.render({ ctx, width: W, height: H, theme: this.theme, t: this.t, frame: this.frame }, this.state);
    ctx.restore();
    const glowScale = this.template.glowScale ?? 1;
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

/** JSON Schema of a template's params, for UI controls and LLM tool schemas. */
export function paramsJsonSchema(template: Template): Record<string, any> {
  return z.toJSONSchema(template.schema, { io: 'input' }) as Record<string, any>;
}
