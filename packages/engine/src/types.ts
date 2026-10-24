import type { z } from 'zod';
import type { Rng } from './rng';
import type { Theme } from './themes';
import type { Melody, MelodyCursor } from './melody';

export type Family = 'bounce' | 'race' | 'particles' | 'kinetic';

/** How the template pickers group templates (display only; `family` is what the planner uses). */
export type TemplateCategory = 'battles' | 'races' | 'bounce' | 'machines' | 'brainy' | 'ambient';

/** Something that happened in the sim. `t` is stamped by the Runner. */
export interface SimEvent {
  t: number;
  type: string;
  [key: string]: unknown;
}

/** Every synth voice (instrument) a note can use. */
export const VOICES = ['marimba', 'bell', 'pluck', 'glass', 'softsine', 'kalimba', 'musicbox', 'handpan'] as const;
/** Voices for backing music (a bass line, a brassy lead): not offered as melody instruments. */
export const MUSIC_VOICES = ['bass', 'brass'] as const;
export type VoiceId = (typeof VOICES)[number] | (typeof MUSIC_VOICES)[number];
export type SfxId =
  | 'shatter' | 'pop' | 'boom' | 'tick' | 'whoosh' | 'chime' | 'sand' | 'bubble' | 'clack' | 'clang' | 'grind' | 'rip' | 'knock' | 'clink' | 'ding' | 'ambience'
  // Drums.
  | 'kick' | 'snare' | 'hat' | 'tom'
  // Combat: blows, movement, voices, crowd.
  | 'impact' | 'smack' | 'crunch' | 'slash' | 'swish' | 'whip' | 'hoof' | 'step' | 'bodyfall' | 'flame'
  | 'roar' | 'growl' | 'snarl' | 'hiss' | 'whinny' | 'bellow' | 'screech' | 'grunt' | 'trumpet'
  | 'chestbeat' | 'shield'
  | 'cheer' | 'gasp'
  // Falls from space: a sonic boom's double crack, a big explosion's thump and long rumble.
  | 'sonicboom' | 'blast';

export type AudioEvent =
  /** `bright` (0–1, default 1) scales the voice's overtones and filter: lower is darker and softer. */
  | { t: number; kind: 'note'; midi: number; vel: number; voice?: VoiceId; dur?: number; pan?: number; bright?: number }
  | { t: number; kind: 'sfx'; name: SfxId; vel: number; pitch?: number; pan?: number }
  /** A recorded sound from assets/ambient (e.g. 'audio/thunder-close-1.opus'), at a playback rate. */
  | { t: number; kind: 'sample'; name: string; vel: number; rate?: number; pan?: number }
  /** A narrated line (a clip in the voice cache): plays on its own path and ducks everything else. */
  | { t: number; kind: 'voice'; clip: string; vel: number }
  /**
   * A held tone at a frequency, gliding to `hzEnd` (exponentially) if given: flat sustain for `dur`
   * seconds with short fades, for sounds that are a pitch rather than a note (a vibrating plate).
   */
  | { t: number; kind: 'tone'; hz: number; hzEnd?: number; dur: number; vel: number; wave?: ToneWave; pan?: number };

/**
 * Timbres for held tones: a pure sine, a bowed string (filtered saw with vibrato), a glassy sine with a
 * soft octave, or a roar (rumbling noise, low-passed at hz, as of air tearing past).
 */
export type ToneWave = 'sine' | 'bowed' | 'glass' | 'roar';

export type AudioEventInput =
  | Omit<Extract<AudioEvent, { kind: 'note' }>, 't'>
  | Omit<Extract<AudioEvent, { kind: 'sfx' }>, 't'>
  | Omit<Extract<AudioEvent, { kind: 'sample' }>, 't'>
  | Omit<Extract<AudioEvent, { kind: 'voice' }>, 't'>
  | Omit<Extract<AudioEvent, { kind: 'tone' }>, 't'>;

/** One voiced line of a narration: what is said, the clip that says it and how long it runs. */
export interface NarrationLine {
  beat: string;
  /** What is spoken (numbers as words). */
  text: string;
  /** The same line for the screen (numbers as digits). */
  caption: string;
  /** File name in the voice cache (data/voice-cache). */
  clip: string;
  durationS: number;
  /**
   * For a beat written in parts (see NarrationBeat.parts): each sentence, where it starts in the clip
   * and how long it runs, so the picture can change exactly as each one begins.
   */
  parts?: NarrationLinePart[];
}

export interface NarrationLinePart {
  text: string;
  caption: string;
  /** Seconds into the line's clip. */
  at: number;
  durationS: number;
}

/** A video's narration, made before it renders (see @sim/voice). */
export interface VoiceTrack {
  provider: string;
  voiceId: string;
  /** Hash of the beats' facts: a different seed or settings means the lines must be rewritten. */
  factsHash: string;
  /** Who wrote the lines. */
  writer: 'claude' | 'fallback';
  lines: NarrationLine[];
}

/**
 * A moment the narration speaks to. Lines are written with {placeholders} for every number, filled
 * in afterwards (spelled out), so whoever writes them can't get a fact wrong.
 */
export interface NarrationBeat {
  id: string;
  /** What the moment shows, for the writer. */
  about: string;
  /** Placeholder values, e.g. { n: 703, value: 2110 }. Numbers are spoken as words. */
  facts: Record<string, string | number>;
  /** Placeholders the line must use. */
  required: string[];
  maxWords: number;
  /**
   * Hand-written lines (with placeholders), for when no model writes them. A beat in parts has one
   * sentence per part, separated by " | ".
   */
  fallback: string[];
  /**
   * Set when the beat is a short passage of sentences, each spoken as something on screen happens
   * (a rule switched on, a branch sprouting): one sentence per part, in order. Each is voiced on its
   * own, so its start is known exactly. maxWords is then the passage's total.
   */
  parts?: NarrationPart[];
}

export interface NarrationPart {
  /** What happens on screen as this sentence starts. */
  about: string;
  maxWords: number;
}

/** A template that can be narrated. */
export interface NarrationSpec<P> {
  enabled(params: P): boolean;
  /** Voice id for the provider (e.g. Kokoro's 'af_heart'). */
  voice(params: P): string;
  /** Tone and audience for the writer. */
  style: string;
  /**
   * This run's beats, from the event log of a headless run (facts are seed-dependent; timing isn't
   * needed, so a run with estimated line lengths gives the same facts as the final one).
   */
  beats(params: P, events: SimEvent[]): NarrationBeat[];
}

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
  /** Narrated lines by beat id, when the video has a prepared voice (empty otherwise: estimate). */
  narration: Record<string, NarrationLine>;
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
 * exactly like t = 0. They are kept out of batches and the planner.
 */
export interface LongFormSpec {
  /** Allowed master-loop lengths in seconds. */
  minLoopS: number;
  maxLoopS: number;
  defaultLoopS: number;
  /**
   * Loop lengths are rounded to whole multiples of this (seconds): every bed's length must divide
   * the loop, or it jumps at the loop's join. Default 1.
   */
  loopStepS?: number;
  /** A representative moment for the thumbnail (e.g. mid lightning flash). */
  thumbnailAt?: (state: any) => number;
  /** Recordings that play throughout (see AmbientBed). */
  beds?: (params: any) => AmbientBed[];
  /** Reverb on the synthesized sounds (recordings already carry their room). Default 0. */
  reverb?: number;
  /**
   * Settings the scene only reads while drawing each frame (and for its beds' levels), never when
   * building the scene or laying out its timetable. The live preview applies changes to these in
   * place, without rebuilding anything. The rest rebuild the preview (after a short pause).
   */
  liveParams?: string[];
  /** What the video shows and sounds like, in plain words, for Claude's YouTube copy. */
  describe?: (params: any) => string;
  /** YouTube copy without Claude. `length` reads like "3 Hours". */
  fallbackCopy?: (params: any, length: string) => LongFormCopyText;
}

/** YouTube copy for a long-form video. */
export interface LongFormCopyText {
  title: string;
  description: string;
  tags: string[];
  /** Two to five words to set on the thumbnail. */
  thumbnailText: string;
}

export interface Template<P = any, S = any> {
  id: string;
  name: string;
  family: Family;
  category: TemplateCategory;
  description: string;
  schema: z.ZodType<P>;
  /** Runs that can take longer than the usual 90 s limit (e.g. several fights in a row): the longest run. */
  maxSeconds?: number | ((params: P) => number);
  /** Physics substeps per frame (default 4 = 240 Hz at 60 fps). */
  substeps?: number;
  /** Defaults to 1080×1920 at 60 fps. */
  format?: VideoFormat;
  /** Set for long-form ambient templates (see LongFormSpec). */
  longForm?: LongFormSpec;
  /** Seeds worth simulating in a seed search (heavy sims use fewer). Default 400. A function when it depends on the settings. */
  searchBudget?: number | ((params: P) => number);
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
  /** Set when the template can be narrated (lines written and voiced before rendering). */
  narration?: NarrationSpec<P>;
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
  /**
   * How a run came out in a few words ("Grizzly wins", "took 12 wolves"), or null. The Playground's
   * seed search tallies it over every seed it tries, to show how often each result comes up.
   */
  outcome?(events: SimEvent[]): string | null;
}
