import { hashString, type NarrationLine, type NarrationPart, type StepCtx } from '@sim/engine';

/**
 * Narrated templates tell their story as a script, written in the sim's own ticks (a generation, a
 * rewrite, an agent update), never in seconds. The Director plays it back: a line takes as long as it
 * takes to say, and the sim covers a fixed number of ticks while it's said (or holds still). Changes
 * to the sim (a rule switched on, food dropped) happen at fixed ticks too.
 *
 * So the sim is in the same state at every tick however long the lines run: the facts a headless run
 * finds (on estimated lengths) are the facts the voiced run shows, each line starts exactly as its
 * moment is on screen, and voicing only changes the pacing. Free-running stretches marked elastic
 * speed up or slow down so the video lands near its target length; lines are never cut or squeezed.
 */

/** Speaking pace for estimates (Kokoro reads at about this rate). */
export const WORDS_PER_S = 2.8;
/**
 * A line's length before it's voiced (written lines run to about 85% of their word budget): also
 * how long a caption stays up with narration off.
 */
export const estimateS = (maxWords: number) => 0.3 + (0.85 * maxWords) / WORDS_PER_S;
/** Silence between the sentences of a passage (as @sim/voice joins them). */
export const PART_GAP_S = 0.12;
/** Elastic stretches play at between 0.4× and 2× their nominal length (2.5× fast to half speed). */
export const ELASTIC_RANGE: [number, number] = [0.4, 2];

export type Facts = Record<string, string | number>;
type Emit = StepCtx['emit'];
/** A change to the sim, made at a tick boundary. */
export type Act<S> = (sim: S, emit: Emit) => void;

/** A narrated moment: what the writer is told about it, and the built-in lines. */
export interface BeatSpec {
  /** Unique in the run (e.g. "iter3"). */
  id: string;
  about: string;
  maxWords: number;
  /** Placeholders the line must use. */
  required?: string[];
  /** Hand-written lines with {placeholders}; parts separated by " | ". */
  fallback: string[];
  /** A passage: one sentence per part, each starting as its moment does (see NarrationBeat.parts). */
  parts?: NarrationPart[];
}

export type Directive<S> =
  | { kind: 'say'; beat: BeatSpec; facts: (sim: S) => Facts; ticks: number[]; acts: (Act<S> | null)[]; pad: number }
  | { kind: 'play'; ticks: number; tps: number; elastic: boolean }
  | { kind: 'until'; until: (sim: S) => boolean; maxTicks: number; estTicks: number; tps: number }
  | { kind: 'act'; act: Act<S> }
  | { kind: 'hold'; s: number }
  | { kind: 'mark'; id: string };

/** Builds a script, directive by directive. */
export class Script<S> {
  readonly dirs: Directive<S>[] = [];

  /**
   * Narrate a beat. The sim advances `ticks` while it's said (one count per part for a passage; 0 =
   * hold still). `acts` run as each part starts (part 0 as the line starts), before its ticks.
   */
  say(beat: BeatSpec, o: { facts?: (sim: S) => Facts; ticks?: number | number[]; acts?: (Act<S> | null)[]; pad?: number } = {}): this {
    const n = beat.parts?.length ?? 1;
    const ticks = Array.isArray(o.ticks) ? o.ticks : splitTicks(o.ticks ?? 0, n);
    if (ticks.length !== n) throw new Error(`beat ${beat.id}: ${n} parts but ${ticks.length} tick counts`);
    this.dirs.push({ kind: 'say', beat, facts: o.facts ?? (() => ({})), ticks, acts: o.acts ?? [], pad: o.pad ?? 0.35 });
    return this;
  }

  /** Run `ticks` at `tps` ticks per second (elastic: stretched to fit the target length). */
  play(ticks: number, tps: number, o: { elastic?: boolean } = {}): this {
    if (ticks > 0) this.dirs.push({ kind: 'play', ticks, tps, elastic: o.elastic ?? false });
    return this;
  }

  /** Run at `tps` until `until` holds (checked after every tick) or `maxTicks`; `estTicks` is for budgeting. */
  until(until: (sim: S) => boolean, o: { tps: number; maxTicks: number; estTicks?: number }): this {
    this.dirs.push({ kind: 'until', until, tps: o.tps, maxTicks: o.maxTicks, estTicks: o.estTicks ?? o.maxTicks / 2 });
    return this;
  }

  act(act: Act<S>): this {
    this.dirs.push({ kind: 'act', act });
    return this;
  }

  /** Hold still for `s` seconds (a breath, a reveal). */
  hold(s: number): this {
    if (s > 0) this.dirs.push({ kind: 'hold', s });
    return this;
  }

  /** Note the time this point is reached (for the picture: `markAt`). */
  mark(id: string): this {
    this.dirs.push({ kind: 'mark', id });
    return this;
  }
}

/** Split a tick count over parts as evenly as integers allow. */
function splitTicks(ticks: number, n: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(Math.floor((ticks * (k + 1)) / n) - Math.floor((ticks * k) / n));
  return out;
}

/** The line being said (or the caption shown), for the picture. */
export interface Saying {
  beat: BeatSpec;
  /** Video time it started. */
  at: number;
  durationS: number;
  caption: string;
  /** Each sentence's caption and where it starts and how long it runs, from the line's start. */
  parts: { caption: string; at: number; durationS: number }[];
  voiced: boolean;
}

export interface Director<S> {
  dirs: Directive<S>[];
  stepsPerS: number;
  targetS: number;
  lines: Record<string, NarrationLine>;
  /** Directive being played, and whether it has started. */
  i: number;
  started: boolean;
  /** Substeps into the current segment, and its length (timed segments). */
  segStep: number;
  segSteps: number;
  /** Ticks run in this segment. */
  segDone: number;
  /** For a say: substep each part starts at, and the acts already run. */
  partSteps: number[];
  partsStarted: number;
  /** Substeps and sim ticks so far. */
  step: number;
  ticks: number;
  /** Substep of the latest tick, and the gap (in substeps) since the one before: for animating between ticks. */
  lastTickStep: number;
  tickGap: number;
  done: boolean;
  /** Video time the script ended (Infinity until then). */
  doneAt: number;
  saying: Saying | null;
  /**
   * Called as each timed stretch starts (a play, a hold, each part of a line) with the ticks it will
   * cover and how long it lasts, so a template can schedule a sound for the whole stretch (a held
   * tone gliding with the sim). Not called for `until` stretches (their length isn't known).
   */
  onSpan: ((sim: S, emit: Emit, span: { from: number; to: number; seconds: number }) => void) | null;
  /** Every line said so far, in order. */
  said: Saying[];
  marks: Record<string, number>;
}

/** A Director of any sim, for helpers that only read its timing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDirector = Director<any>;

/** A Director for a script. `substeps` must be the template's (the Director counts substeps). */
export function newDirector<S>(script: Script<S>, o: { substeps: number; fps?: number; targetS: number; narration: Record<string, NarrationLine> }): Director<S> {
  return {
    dirs: script.dirs,
    stepsPerS: (o.fps ?? 60) * o.substeps,
    targetS: o.targetS,
    lines: o.narration,
    i: 0,
    started: false,
    segStep: 0,
    segSteps: 0,
    segDone: 0,
    partSteps: [],
    partsStarted: 0,
    step: 0,
    ticks: 0,
    lastTickStep: -1,
    tickGap: 0,
    done: false,
    doneAt: Infinity,
    saying: null,
    onSpan: null,
    said: [],
    marks: {},
  };
}

/** Video time now. */
export const timeOf = (d: AnyDirector) => d.step / d.stepsPerS;

/**
 * How far the picture is from the latest tick to the next one, 0..1 (1 once it has had as long as
 * the gap between the last two ticks, capped at `maxS`): animate the change a tick made with it.
 */
export function sinceTick(d: AnyDirector, maxS = 0.6): number {
  if (d.lastTickStep < 0) return 1;
  const gap = Math.min(d.tickGap || Infinity, maxS * d.stepsPerS);
  return Math.max(0, Math.min(1, (d.step - d.lastTickStep) / Math.max(1, gap)));
}

/** When a mark was reached (Infinity if not yet). */
export const markAt = (d: AnyDirector, id: string) => d.marks[id] ?? Infinity;

/** How long a beat runs: its voiced line, or the estimate. Each part's start and length too. */
export function beatTiming(d: AnyDirector, beat: BeatSpec): { durationS: number; parts: { at: number; durationS: number }[]; line?: NarrationLine } {
  const line = d.lines[beat.id];
  const n = beat.parts?.length ?? 1;
  if (line) {
    if (line.parts && line.parts.length === n) return { durationS: line.durationS, parts: line.parts.map((p) => ({ at: p.at, durationS: p.durationS })), line };
    // Voiced as one sentence: share it out by the parts' word budgets.
    return { durationS: line.durationS, parts: shareOut(line.durationS, beat), line };
  }
  if (!beat.parts) return { durationS: estimateS(beat.maxWords), parts: [{ at: 0, durationS: estimateS(beat.maxWords) }] };
  const parts: { at: number; durationS: number }[] = [];
  let at = 0;
  for (const p of beat.parts) {
    const len = estimateS(p.maxWords);
    parts.push({ at, durationS: len });
    at += len + PART_GAP_S;
  }
  return { durationS: at - PART_GAP_S, parts };
}

function shareOut(total: number, beat: BeatSpec) {
  const words = beat.parts?.map((p) => p.maxWords) ?? [beat.maxWords];
  const sum = words.reduce((a, b) => a + b, 0);
  let at = 0;
  return words.map((w) => {
    const len = (total * w) / sum;
    const part = { at, durationS: len };
    at += len;
    return part;
  });
}

/** Seconds a directive takes, as far as can be known before it plays (elastic ones nominal). */
function nominalS(d: AnyDirector, dir: Directive<any>): number {
  switch (dir.kind) {
    case 'say':
      return beatTiming(d, dir.beat).durationS + dir.pad;
    case 'play':
      return dir.ticks / dir.tps;
    case 'until':
      return dir.estTicks / dir.tps;
    case 'hold':
      return dir.s;
    default:
      return 0;
  }
}

/** How long the elastic stretch starting now should run, so the script ends near its target. */
function elasticSteps(d: AnyDirector, dir: Extract<Directive<any>, { kind: 'play' }>): number {
  let fixed = 0;
  let elastic = 0;
  for (let k = d.i; k < d.dirs.length; k++) {
    const x = d.dirs[k];
    if (x.kind === 'play' && x.elastic) elastic += x.ticks / x.tps;
    else fixed += nominalS(d, x);
  }
  const budget = d.targetS - timeOf(d) - fixed;
  const factor = Math.max(ELASTIC_RANGE[0], Math.min(ELASTIC_RANGE[1], budget / Math.max(1e-6, elastic)));
  return Math.max(1, Math.round((dir.ticks / dir.tps) * factor * d.stepsPerS));
}

/** Fill a line's placeholders for the screen (digits with separators), capitalising its first letter. */
export function fillCaption(line: string, facts: Facts): string {
  const filled = line.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = facts[k];
    return typeof v === 'number' ? Math.round(v).toLocaleString('en-US') : v === undefined ? `{${k}}` : String(v);
  });
  return filled.charAt(0).toUpperCase() + filled.slice(1);
}

/** The built-in line a caption shows before (or without) a voice: the same pick every run. */
function fallbackCaption(beat: BeatSpec, facts: Facts): string[] {
  const pick = beat.fallback[parseInt(hashString(beat.id), 16) % beat.fallback.length] ?? '';
  return pick.split('|').map((p) => fillCaption(p.trim(), facts));
}

function startSay(d: Director<any>, dir: Extract<Directive<any>, { kind: 'say' }>, sim: unknown, emit: Emit) {
  const facts = dir.facts(sim);
  const timing = beatTiming(d, dir.beat);
  const total = timing.durationS + dir.pad;
  d.segSteps = Math.max(1, Math.round(total * d.stepsPerS));
  d.partSteps = timing.parts.map((p) => Math.min(d.segSteps - 1, Math.round(p.at * d.stepsPerS)));
  d.partsStarted = 0;
  const { about, maxWords, required, fallback, parts } = dir.beat;
  emit({ type: 'story:say', beat: dir.beat.id, def: { about, maxWords, required: required ?? [], fallback, ...(parts ? { parts } : {}) }, facts, ...(timing.line ? { clip: timing.line.clip } : {}) });
  const captions = timing.line ? (timing.line.parts?.map((p) => p.caption) ?? [timing.line.caption]) : fallbackCaption(dir.beat, facts);
  const partCaps = timing.parts.map((p, k) => ({ caption: captions[k] ?? '', at: p.at, durationS: p.durationS }));
  // A line voiced whole for a beat in parts: one caption over the whole line.
  if (captions.length !== timing.parts.length) partCaps.splice(0, partCaps.length, { caption: captions.join(' '), at: 0, durationS: timing.durationS });
  d.saying = { beat: dir.beat, at: timeOf(d), durationS: timing.durationS, caption: captions.join(' '), parts: partCaps, voiced: Boolean(timing.line) };
  d.said.push(d.saying);
}

/**
 * Play one substep of the script: run due directives that take no time, then advance the current
 * segment by a substep, calling `tick` for every sim tick due. Call once per template step.
 */
export function runDirector<S>(d: Director<S>, sim: S, emit: Emit, tick: (sim: S, emit: Emit) => void) {
  const run = (n: number) => {
    if (n > 0 && d.lastTickStep !== d.step) {
      d.tickGap = d.lastTickStep < 0 ? 0 : d.step - d.lastTickStep;
      d.lastTickStep = d.step;
    }
    for (let k = 0; k < n; k++) {
      tick(sim, emit);
      d.ticks++;
      d.segDone++;
    }
  };
  while (!d.done) {
    const dir = d.dirs[d.i];
    if (!dir) {
      d.done = true;
      d.doneAt = timeOf(d);
      break;
    }
    if (!d.started) {
      d.started = true;
      d.segStep = 0;
      d.segDone = 0;
      if (dir.kind === 'act') {
        dir.act(sim, emit);
        emit({ type: 'story:act', i: d.i });
        next(d);
        continue;
      }
      if (dir.kind === 'mark') {
        d.marks[dir.id] = timeOf(d);
        next(d);
        continue;
      }
      if (dir.kind === 'say') startSay(d, dir, sim, emit);
      else if (dir.kind === 'play') d.segSteps = dir.elastic ? elasticSteps(d, dir) : Math.max(1, Math.round((dir.ticks / dir.tps) * d.stepsPerS));
      else if (dir.kind === 'hold') d.segSteps = Math.max(1, Math.round(dir.s * d.stepsPerS));
      if (dir.kind === 'play' || dir.kind === 'hold') d.onSpan?.(sim, emit, { from: d.ticks, to: d.ticks + (dir.kind === 'play' ? dir.ticks : 0), seconds: d.segSteps / d.stepsPerS });
    }
    const j = d.segStep++;
    if (dir.kind === 'say') {
      const n = dir.ticks.length;
      // Start every part due by this substep (finishing the ticks of the parts before it first).
      while (d.partsStarted < n && d.partSteps[d.partsStarted] <= j) {
        const k = d.partsStarted;
        run(sumTo(dir.ticks, k) - d.segDone);
        dir.acts[k]?.(sim, emit);
        const end = k + 1 < n ? d.partSteps[k + 1] : d.segSteps;
        d.onSpan?.(sim, emit, { from: d.ticks, to: d.ticks + dir.ticks[k], seconds: (end - d.partSteps[k]) / d.stepsPerS });
        d.partsStarted++;
      }
      const k = d.partsStarted - 1;
      const from = d.partSteps[k];
      const to = k + 1 < n ? d.partSteps[k + 1] : d.segSteps;
      // Rounded up: a part's first tick lands as it starts, so the change it shows comes with the words.
      const due = sumTo(dir.ticks, k) + Math.ceil((dir.ticks[k] * (j + 1 - from)) / Math.max(1, to - from));
      run(Math.min(due, sumTo(dir.ticks, n)) - d.segDone);
      if (d.segStep >= d.segSteps) {
        run(sumTo(dir.ticks, n) - d.segDone);
        next(d);
      }
    } else if (dir.kind === 'play') {
      run(Math.floor((dir.ticks * d.segStep) / d.segSteps) - d.segDone);
      if (d.segStep >= d.segSteps) next(d);
    } else if (dir.kind === 'hold') {
      if (d.segStep >= d.segSteps) next(d);
    } else if (dir.kind === 'until') {
      const due = Math.min(dir.maxTicks, Math.floor((dir.tps * d.segStep) / d.stepsPerS));
      let met = false;
      while (d.segDone < due && !met) {
        run(1);
        met = dir.until(sim);
      }
      if (met || d.segDone >= dir.maxTicks) next(d);
    }
    break;
  }
  d.step++;
}

const sumTo = (xs: number[], k: number) => {
  let s = 0;
  for (let i = 0; i < k; i++) s += xs[i];
  return s;
};

function next(d: AnyDirector) {
  d.i++;
  d.started = false;
}

/** The line on screen now: from its start until a beat after it ends. */
export function saying(d: AnyDirector, t = timeOf(d)): { line: Saying; since: number } | null {
  const s = d.saying;
  if (!s) return null;
  const since = t - s.at;
  return since >= 0 && since < s.durationS + 0.5 ? { line: s, since } : null;
}

/** Which part of the current line is being said (−1 before it starts) and how far through it, 0..1. */
export function partProgress(s: Saying, since: number): { part: number; u: number } {
  let part = -1;
  for (let k = 0; k < s.parts.length; k++) if (since >= s.parts[k].at) part = k;
  if (part < 0) return { part, u: 0 };
  const p = s.parts[part];
  return { part, u: Math.max(0, Math.min(1, (since - p.at - 0.05) / Math.max(0.3, p.durationS - 0.15))) };
}
