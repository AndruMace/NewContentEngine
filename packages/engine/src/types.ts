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
export type SfxId = 'shatter' | 'pop' | 'boom' | 'tick' | 'whoosh' | 'chime' | 'sand' | 'bubble' | 'clack' | 'clang' | 'grind' | 'rip' | 'knock' | 'clink' | 'ding';

export type AudioEvent =
  | { t: number; kind: 'note'; midi: number; vel: number; voice?: VoiceId; dur?: number; pan?: number }
  | { t: number; kind: 'sfx'; name: SfxId; vel: number; pitch?: number; pan?: number };

export type AudioEventInput =
  | Omit<Extract<AudioEvent, { kind: 'note' }>, 't'>
  | Omit<Extract<AudioEvent, { kind: 'sfx' }>, 't'>;

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

export interface Template<P = any, S = any> {
  id: string;
  name: string;
  family: Family;
  description: string;
  schema: z.ZodType<P>;
  /** Physics substeps per 60fps frame (default 4 = 240 Hz). */
  substeps?: number;
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
