import type { z } from 'zod';
import type { Rng } from './rng';
import type { Theme } from './themes';
import type { Melody, MelodyCursor } from './melody';

export type Family = 'bounce' | 'race' | 'particles' | 'kinetic';

/** Something that happened in the sim. `t` is stamped by the Runner. */
export interface SimEvent {
  t: number;
  type: string;
  [key: string]: unknown;
}

export type VoiceId = 'marimba' | 'bell' | 'pluck' | 'glass' | 'softsine';
export type SfxId = 'shatter' | 'pop' | 'boom' | 'tick' | 'whoosh' | 'chime' | 'sand' | 'bubble' | 'clack' | 'clang' | 'grind' | 'rip' | 'knock' | 'clink' | 'ding' | 'ambience';

export type AudioEvent =
  | { t: number; kind: 'note'; midi: number; vel: number; voice?: VoiceId; dur?: number; pan?: number }
  | { t: number; kind: 'sfx'; name: SfxId; vel: number; pitch?: number; pan?: number }
  /** A recorded sound from assets/ambient (e.g. 'audio/thunder-close-1.opus'), at a playback rate. */
  | { t: number; kind: 'sample'; name: string; vel: number; rate?: number; pan?: number };

export type AudioEventInput =
  | Omit<Extract<AudioEvent, { kind: 'note' }>, 't'>
  | Omit<Extract<AudioEvent, { kind: 'sfx' }>, 't'>
  | Omit<Extract<AudioEvent, { kind: 'sample' }>, 't'>;

/**
 * A recording that plays continuously under a long-form video (rain, fire, a ship's room tone). Its
 * length must divide the loop length (beds are cut to 60, 120, 300 or 600 s: these divide every allowed
 * loop), so it sits at the same point at t = loopS as at t = 0.
 */
export interface AmbientBed {
  /** Path in assets/ambient. */
  sound: string;
  /** Linear gain. */
  gain: number;
  pan?: number;
  /** Slow swells in level: depth (0..1) and how many times each one rises and falls per loop. */
  swell?: { depth: number; cycles: number[] };
}

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface RenderCtx {
  ctx: Ctx2D;
  width: number;
  height: number;
  theme: Theme;
  /** Sim time in seconds at this frame. */
  t: number;
  frame: number;
}

export interface InitCtx<P> {
  params: P;
  /** Physics randomness. */
  rng: Rng;
  /** Visual-only randomness (particles, shake). Never affects physics. */
  fxRng: Rng;
  /** False during headless seed search: skip particles and other visual-only work. */
  visual: boolean;
  width: number;
  height: number;
  /** Long-form templates: the master loop's length. The final frame (t = loopS) must equal the first. */
  loopS: number;
  /** For templates whose sim state carries colours (e.g. mixing liquids). Never affects physics. */
  theme: Theme;
  /** The video's melody (already transposed), for templates whose run is built from it. */
  melody: Melody;
}

export interface StepCtx {
  dt: number;
  t: number;
  emit: (e: Omit<SimEvent, 't'>) => void;
}

export interface AudioMapCtx {
  melody: MelodyCursor;
  theme: Theme;
  /** Time of the last melody note emitted, for density limiting. */
  lastNoteT: number;
}

export interface DramaScore {
  /** 0..1 overall. */
  total: number;
  parts: Record<string, number>;
  notes?: string[];
}

export type OverlaySpec =
  /** y is the centre of the hook's last line; longer hooks grow upwards. */
  | { kind: 'hook'; text: string; from?: number; to?: number; y?: number; untilOutro?: boolean }
  | { kind: 'counter'; key: string; label?: string; y?: number; size?: number }
  | { kind: 'timer'; y?: number }
  | { kind: 'cta'; text: string; when: 'outro' | { from: number; to: number }; y?: number }
  | { kind: 'label'; text: string; y?: number }
  /** hud[key] must be LeaderboardRow[]; drawn as a compact ranked list. */
  | { kind: 'leaderboard'; key: string; title?: string; max?: number; x?: number; y?: number }
  /** A small comment-prompt pill (engagement cue), shown briefly after the hook. */
  | { kind: 'nudge'; text: string; from: number; to: number; y: number }
  /** A small heart drifting up toward the like button at the payoff (when the CTA appears). */
  | { kind: 'heart'; when: 'outro' | { at: number } };

export interface LeaderboardRow {
  label: string;
  color: string;
  /** Eliminated / finished rows are drawn dimmed and struck through. */
  out?: boolean;
  /** Optional emoji/icon drawn before the label. */
  icon?: string;
  /** Places just gained (positive) or lost (negative): drawn as a green or red arrow by the rank. */
  move?: number;
  /** A short note at the row's end, e.g. the gap to the leader ("+0.6s"). */
  note?: string;
}

export interface Copy {
  hook: string;
  cta: string;
  /**
   * Engagement cues: a short comment prompt shown just after the hook (e.g. "Lock in your guess 👇").
   * When present, a small heart also drifts toward the like button at the payoff.
   */
  nudge?: string;
}

/** Output size and frame rate. Shorts use the default 1080×1920 at 60 fps. */
export interface VideoFormat {
  width: number;
  height: number;
  fps: number;
}

/**
 * Long-form (ambient) templates render a seamless master loop that is repeated to the final length.
 * Every frame must depend only on t (so segments can start anywhere) and t = loopS must look and sound
 * exactly like t = 0. They are kept out of batches, the planner and analytics.
 */
export interface LongFormSpec {
  /** Allowed master-loop lengths in seconds. */
  minLoopS: number;
  maxLoopS: number;
  defaultLoopS: number;
  /** A representative moment for the thumbnail (e.g. mid lightning flash). */
  thumbnailAt?: (state: any) => number;
  /** Recordings that play throughout (see AmbientBed). */
  beds?: (params: any) => AmbientBed[];
  /** Reverb on the synthesized sounds (recordings already carry their room). Default 0. */
  reverb?: number;
}

export interface Template<P = any, S = any> {
  id: string;
  name: string;
  family: Family;
  description: string;
  schema: z.ZodType<P>;
  /** Physics substeps per frame (default 4 = 240 Hz at 60 fps). */
  substeps?: number;
  /** Defaults to 1080×1920 at 60 fps. */
  format?: VideoFormat;
  /** Set for long-form ambient templates (see LongFormSpec). */
  longForm?: LongFormSpec;
  /** Seeds worth simulating in a seed search (heavy sims use fewer). Default 400. */
  searchBudget?: number;
  /** Template ignores the melody setting (e.g. uses its own scale). */
  ownMusic?: boolean;
  /** The melody shapes the run itself (not just its sound), so changing it changes the video. */
  melodyDriven?: boolean;
  /**
   * Multiplier on the theme's bloom (solid fills like sand/liquid blow out at full glow). A function
   * when it depends on the settings, e.g. a template with both flat and lit 3D styles.
   */
  glowScale?: number | ((params: P) => number);
  /** The final state equals the first frame: renders drop the last frame so the video loops cleanly. */
  seamlessLoop?: boolean;
  /** Where the comment-prompt nudge sits (fraction of height); defaults to the hook's spot once the hook is gone. */
  nudgeY?: number;
  /** Comment prompts that fit this template (the planner picks one per video, varying them). */
  nudges?: string[];
  /** The param that sets the video's length (video ≈ value + offsetS), so planners set it from the target length. */
  lengthParam?: { param: string; offsetS: number };
  /** Copy with {paramName} / {hud:key} placeholders. */
  defaultCopy: Copy;
  /**
   * Load files the template draws or plays (textures, models, recordings) before the first frame.
   * Browser only; never called for headless runs, so it can't affect the simulation.
   */
  preload?(params: P): Promise<void>;
  init(ctx: InitCtx<P>): S;
  step(s: S, ctx: StepCtx): void;
  isDone(s: S): boolean;
  /** Values exposed to overlays (counters) and the outro flag. */
  hud(s: S): Record<string, string | number | boolean | LeaderboardRow[]>;
  overlays(params: P, copy: Copy): OverlaySpec[];
  render(rc: RenderCtx, s: S): void;
  /** Optional layer drawn after bloom/post-processing (crisp, unglowed), before overlays. */
  renderTop?(rc: RenderCtx, s: S): void;
  audio(e: SimEvent, m: AudioMapCtx): AudioEventInput[];
  score(events: SimEvent[], info: { durationS: number; targetS: number; timedOut: boolean }): DramaScore;
}
