import { lighten, paletteAt, rgbToCss, type AudioEventInput, type Ctx2D, type NarrationBeat, type Theme } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { drawCommentPrompt } from '../../guess';
import { scaleNote } from '../../music';
import { gaussFit } from '../../scoring';
import type { MathParams } from '../params';
import { drawSpoken, fireSays, lineLength, newSpeech, sayAudio, speaking, spokenProgress, type BeatDef, type Speech } from '../speech';
import { OUTRO_DELAY_S, REVEAL_S, caption, clamp01, drawModeTitle, ev, evName, fireCues, flash, fmtInt, outlined, panel, popIn, smooth, type Cue, type ModeImpl } from '../shared';

/**
 * Collatz "hailstone" numbers: halve an even number, triple an odd one and add 1, and every start
 * anyone has tried falls to 1 eventually, after a flight that can climb thousands of times higher.
 * Integer arithmetic only (peaks stay far below 2^53 for starts under 100,000).
 */
export function collatzSequence(n: number): number[] {
  const out = [n];
  while (n !== 1) {
    n = n % 2 === 0 ? n / 2 : 3 * n + 1;
    out.push(n);
  }
  return out;
}

const stepsOf = (n: number) => collatzSequence(n).length - 1;

/** A race worth watching: both long, the loser 8–40% slower (decided late, but decided). */
const closeRace = (a: number, b: number) => {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return hi >= 50 && hi <= 250 && lo >= hi / 1.4 && lo <= hi / 1.08;
};

interface Lane {
  n: number;
  seq: number[];
  /** Steps taken so far. */
  k: number;
  peak: number;
  /** Peak shown before the latest one (the chart eases between them). */
  prevPeak: number;
  peakAt: number;
  /** Peak last announced with a bell. */
  rungPeak: number;
  doneAt: number;
}

interface StepCue extends Cue {
  k: number;
  /** One of the opening steps, shown slowly with the arithmetic spelled out. */
  narrate: boolean;
}

interface State {
  p: MathParams;
  lanes: Lane[];
  cues: StepCue[];
  cue: number;
  /** Steps of the longest lane. */
  total: number;
  lastStepT: number;
  lastOdd: boolean;
  /** Steps narrated one by one at the start. */
  narrate: number;
  /** "Keep going until it reaches 1": the narration ends and the run speeds up. */
  repeatAt: number;
  repeated: boolean;
  revealAt: number;
  started: boolean;
  revealed: boolean;
  speech: Speech;
  t: number;
}

/**
 * The opening teaches the game before it speeds up: the start number, then the first steps one at a
 * time with the sum written out (until both rules have been used), then "keep going until it
 * reaches 1" with the guess prompt.
 */
const NARRATE_FROM_S = 1.5;
const NARRATE_MAX = 4;
const PROMPT_S = 2.8;
const PROMPT_Y = 1565;
const CHART = { x: 90, y: 860, w: 910, h: 580 };

const M = 'collatz';

/** Voiceover beats: what each line covers and how many words it may use (see speech.ts). */
const BEAT: Record<string, BeatDef> = {
  intro: {
    about: 'The starting number appears; two simple rules are about to be applied to it again and again.',
    required: ['n'],
    maxWords: 11,
    fallback: ["Pick any number. Let's say {n}.", 'Start with any number, like {n}.', 'Here is a number: {n}.'],
  },
  introPair: {
    about: 'Two neighbouring numbers appear side by side; both will follow the same two rules in a race to reach 1.',
    required: ['n', 'm'],
    maxWords: 18,
    fallback: ['Two neighbours, {n} and {m}. Same two rules.', 'Meet {n} and {m}. They follow the same two rules.'],
  },
  odd: {
    about: 'The number {prev} is odd, so the odd rule applies: multiply by three and add one, giving {value}.',
    required: ['prev', 'value'],
    maxWords: 18,
    fallback: ['{prev} is odd, so triple it and add one: {value}.', 'Odd? Times three, plus one: {value}.'],
  },
  even: {
    about: 'The number {prev} is even, so the even rule applies: halve it, giving {value}.',
    required: ['prev', 'value'],
    maxWords: 16,
    fallback: ['{prev} is even, so cut it in half: {value}.', 'Even? Halve it. {value}.'],
  },
  repeat: {
    about: 'From here the rules repeat on their own, faster and faster, until the number reaches 1. Ask how many steps it will take.',
    required: [],
    maxWords: 12,
    fallback: ['Keep going until you hit one. How many steps will it take?', 'Repeat until it reaches one. Guess how many steps.'],
  },
  repeatPair: {
    about: 'From here both numbers keep following the rules, faster and faster. Ask which one reaches 1 first.',
    required: [],
    maxWords: 9,
    fallback: ['Keep going. Which one reaches one first?', 'Now let them race. Who hits one first?'],
  },
  reveal: {
    about: 'It reached 1 after {steps} steps, having climbed as high as {peak} on the way.',
    required: ['steps'],
    maxWords: 15,
    fallback: ['{steps} steps! And it climbed all the way to {peak} first.', 'That took {steps} steps, peaking at {peak}.', '{steps} steps to get back down to one!', 'It took {steps} steps. Did you guess close?'],
  },
  revealPair: {
    about: '{winner} reached 1 first, in {steps} steps, while {loser} took {loserSteps}.',
    required: ['winner'],
    maxWords: 16,
    fallback: ['{winner} wins, in {steps} steps. {loser} needed {loserSteps}.', "It's {winner}! {steps} steps against {loserSteps}.", '{winner} gets there first!'],
  },
};

interface PlannedBeat {
  id: string;
  def: BeatDef;
  facts: Record<string, number>;
}

/**
 * The run's voiceover: intro, the first narrated steps (single number only; long enough videos get
 * two), "keep going", and the reveal. Facts come from the start number alone.
 */
function planBeats(p: MathParams, n: number, narrate: number): PlannedBeat[] {
  const a = collatzSequence(n);
  if (p.compare) {
    const b = collatzSequence(n + 1);
    const [w, l] = a.length <= b.length ? [{ n, s: a }, { n: n + 1, s: b }] : [{ n: n + 1, s: b }, { n, s: a }];
    return [
      { id: 'intro', def: BEAT.introPair, facts: { n, m: n + 1 } },
      { id: 'repeat', def: BEAT.repeatPair, facts: {} },
      { id: 'reveal', def: BEAT.revealPair, facts: { winner: w.n, steps: w.s.length - 1, loser: l.n, loserSteps: l.s.length - 1 } },
    ];
  }
  const out: PlannedBeat[] = [{ id: 'intro', def: BEAT.intro, facts: { n } }];
  // A second narrated step only on longer videos: lines take time the fast run needs.
  const voicedSteps = Math.min(narrate, p.durationS >= 36 ? 2 : 1);
  for (let k = 1; k <= voicedSteps; k++) out.push({ id: `step${k}`, def: a[k - 1] % 2 ? BEAT.odd : BEAT.even, facts: { prev: a[k - 1], value: a[k] } });
  out.push({ id: 'repeat', def: BEAT.repeat, facts: {} });
  out.push({ id: 'reveal', def: BEAT.reveal, facts: { steps: a.length - 1, peak: Math.max(...a) } });
  return out;
}

/** Seed-picked start: a long flight that soars (or, racing, two neighbours that finish close together, so the race stays open). */
function pickStart(p: MathParams, rng: { int(a: number, b: number): number }): number {
  if (p.start > 0) return Math.max(2, p.start);
  for (let k = 0; k < 400; k++) {
    const n = rng.int(15, 9999);
    const a = stepsOf(n);
    if (!p.compare) {
      // Long enough to build suspense, and a real climb (a flight that only falls is no fun).
      if (a >= 60 && a <= 250 && Math.max(...collatzSequence(n)) >= 6 * n) return n;
      continue;
    }
    if (closeRace(a, stepsOf(n + 1))) return n;
  }
  if (!p.compare) return 27;
  for (let n = 100; ; n++) if (closeRace(stepsOf(n), stepsOf(n + 1))) return n;
}

function makeLane(n: number): Lane {
  return { n, seq: collatzSequence(n), k: 0, peak: n, prevPeak: n, peakAt: -9, rungPeak: n, doneAt: -1 };
}

export const collatzMode: ModeImpl<State> = {
  copy: (p) =>
    p.compare
      ? { hook: 'Which number reaches 1 first?', cta: '{result}! Did you pick right? 🤯' }
      : { hook: 'How many steps until this number hits 1?', cta: 'It took {result}! How close was your guess? 🤯' },
  searchBudget: 60,
  glowScale: 0.6,

  init({ params: p, rng, narration }) {
    const n = pickStart(p, rng);
    const lanes = p.compare ? [makeLane(n), makeLane(n + 1)] : [makeLane(n)];
    const total = Math.max(...lanes.map((l) => l.seq.length - 1));
    const voiced = p.narration === 'on';
    // Narrate until both rules have shown up (at least two steps, at most four; two when voiced).
    const lead = lanes[0].seq;
    let narrate = 0;
    let odd = false;
    let even = false;
    while (narrate < Math.min(NARRATE_MAX, total)) {
      if (lead[narrate] % 2) odd = true;
      else even = true;
      narrate++;
      if (narrate >= 2 && odd && even) break;
    }
    if (voiced) narrate = Math.min(narrate, 2);
    // With a voiceover every beat waits for its line (estimated until the lines are voiced).
    const beats = voiced ? planBeats(p, n, narrate) : [];
    const len = (id: string) => {
      const b = beats.find((x) => x.id === id);
      return b ? lineLength(narration, id, b.def) : 0;
    };
    const speech = newSpeech(narration);
    const say = (t: number, beat: string) => beats.some((b) => b.id === beat) && speech.says.push({ t, beat });
    const revealAt = p.durationS - Math.max(REVEAL_S, len('reveal') + 1);
    say(revealAt + 0.25, 'reveal');
    const gap = Math.max(1.05, Math.min(1.6, (1.5 * p.durationS) / 32));
    const cues: StepCue[] = [];
    say(0.3, 'intro');
    let at = Math.max(NARRATE_FROM_S, voiced ? 0.3 + len('intro') + 0.3 : 0);
    for (let k = 1; k <= narrate; k++) {
      cues.push({ t: at, k, narrate: true });
      say(at, `step${k}`);
      at += Math.max(gap, len(`step${k}`) ? len(`step${k}`) + 0.35 : 0);
    }
    const repeatAt = at;
    say(repeatAt, 'repeat');
    // Then quicker and quicker, with a slow 8 → 4 → 2 → 1 at the end.
    const from = repeatAt + Math.max(0.7, len('repeat') - 0.6);
    const weights: number[] = [];
    for (let k = narrate + 1; k <= total; k++) weights.push(1 + 2 * dm.exp(-(k - narrate - 1) / 5) + (k > total - 3 ? 3 : 0));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const span = Math.max(1, revealAt - 0.5 - from);
    at = from;
    weights.forEach((w, i) => {
      cues.push({ t: at, k: narrate + 1 + i, narrate: false });
      at += (span * w) / sum;
    });
    speech.says.sort((x, y) => x.t - y.t);
    return { p, lanes, cues, cue: 0, total, lastStepT: -9, lastOdd: false, narrate, repeatAt, repeated: false, revealAt, started: false, revealed: false, speech, t: 0 };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    if (!s.started) {
      s.started = true;
      emit({ type: ev(M, 'start'), n: s.lanes[0].n, n2: s.lanes[1]?.n ?? 0 });
    }
    fireCues(s.cues, s, t, (c) => {
      s.lastStepT = t;
      s.lanes.forEach((lane, li) => {
        const steps = lane.seq.length - 1;
        if (c.k > steps) return;
        const prev = lane.seq[c.k - 1];
        const value = lane.seq[c.k];
        lane.k = c.k;
        if (li === 0 || s.lanes.length === 1) s.lastOdd = prev % 2 === 1;
        let ring = false;
        if (value > lane.peak) {
          lane.prevPeak = lane.peak;
          lane.peak = value;
          lane.peakAt = t;
          // A bell for real climbs only, not every step of a rise.
          if (value >= lane.rungPeak * 1.5) {
            lane.rungPeak = value;
            ring = true;
          }
        }
        emit({ type: ev(M, 'step'), lane: li, k: c.k, value, odd: prev % 2 === 1, peak: ring, dense: s.cues.length > 120, narrate: c.narrate });
        if (c.k === steps) {
          lane.doneAt = t;
          emit({ type: ev(M, 'finish'), lane: li, steps, peak: lane.peak, n: lane.n });
        }
      });
    });
    fireSays(s.speech, M, t, emit);
    if (!s.repeated && t >= s.repeatAt) {
      s.repeated = true;
      emit({ type: ev(M, 'repeat') });
    }
    if (!s.revealed && t >= s.revealAt) {
      s.revealed = true;
      emit({ type: ev(M, 'reveal'), result: resultOf(s) });
    }
  },

  isDone: (s) => s.t >= s.p.durationS,

  hud: (s) => ({
    result: resultOf(s),
    steps: s.lanes[0].k,
    peak: s.lanes[0].peak,
    start: s.lanes[0].n,
    outro: s.revealed && s.t >= s.revealAt + OUTRO_DELAY_S,
  }),

  render({ ctx, theme }, s) {
    const t = s.t;
    drawModeTitle(ctx, s.lanes.length > 1 ? 'Hailstone race' : 'Hailstone numbers');
    drawRules(ctx, theme, s);
    if (s.lanes.length === 1) drawSingle(ctx, theme, s);
    else drawPair(ctx, theme, s);
    drawChart(ctx, theme, s);
    const promptTo = s.repeatAt + PROMPT_S;
    if (t >= s.repeatAt && t < promptTo) drawCommentPrompt(ctx, theme, t - s.repeatAt, promptTo - t, { x: 540, y: PROMPT_Y }, s.lanes.length > 1 ? 'Which one wins? Comment!' : 'How many steps? Comment!');
  },

  audio(e) {
    switch (evName(e)) {
      case 'start':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.16 }];
      case 'say':
        return sayAudio(e.clip as string);
      case 'repeat':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.2 }, ...[57, 64, 69].map((midi) => ({ kind: 'note' as const, midi, vel: 0.2, voice: 'softsine' as const, dur: 1.6 }))];
      case 'step': {
        const value = e.value as number;
        const degree = Math.max(0, Math.min(26, Math.round((dm.log(value) / dm.log(2)) * 1.4)));
        const lane = e.lane as number;
        const out: AudioEventInput[] = [{ kind: 'note', midi: scaleNote('pentatonic', 45, degree), vel: e.narrate ? 0.55 : e.dense ? 0.32 : 0.45, voice: lane ? 'kalimba' : 'marimba', dur: e.narrate ? 0.8 : 0.45, pan: lane ? 0.3 : -0.1 }];
        if (e.narrate && !lane) out.push({ kind: 'sfx', name: 'tick', vel: 0.22, pitch: e.odd ? 1.1 : 0.85 });
        if (e.peak) out.push({ kind: 'note', midi: scaleNote('pentatonic', 69, degree % 10), vel: 0.22, voice: 'bell', dur: 1.2, pan: 0 });
        return out;
      }
      case 'finish':
        return [
          { kind: 'sfx', name: 'chime', vel: 0.32 },
          ...[60, 64, 67].map((midi) => ({ kind: 'note' as const, midi: midi + (e.lane ? 5 : 0), vel: 0.3, voice: 'bell' as const, dur: 1.4 })),
        ];
      case 'reveal':
        return [48, 55, 60, 64].map((midi, i) => ({ kind: 'note' as const, midi, vel: 0.22 + i * 0.02, voice: 'softsine' as const, dur: 3.2 }));
    }
    return [];
  },

  beats(p, events) {
    const start = events.find((e) => e.type === ev(M, 'start'));
    if (!start) return [];
    const narrate = events.filter((e) => e.type === ev(M, 'step') && e.narrate && e.lane === 0).length;
    return planBeats(p, start.n as number, narrate).map((b): NarrationBeat => ({ id: b.id, ...b.def, facts: b.facts }));
  },

  score(events, { durationS, targetS }) {
    const durFit = gaussFit(durationS, targetS, targetS * 0.3);
    const fin = events.filter((e) => e.type === ev(M, 'finish'));
    const steps = fin.map((e) => e.steps as number);
    const hi = Math.max(1, ...steps);
    const stepFit = gaussFit(hi, 130, 80);
    let interest: number;
    // Racing: the closer the finish, the longer the suspense.
    if (fin.length > 1) interest = gaussFit(Math.min(...steps) / hi, 0.85, 0.1);
    else {
      const f = fin[0];
      interest = f ? clamp01(dm.log((f.peak as number) / (f.n as number)) / dm.log(300)) : 0;
    }
    return {
      total: 0.35 * durFit + 0.4 * interest + 0.25 * stepFit,
      parts: { durFit, interest, stepFit },
      notes: fin.map((f) => `${f.n}: ${f.steps} steps, peak ${f.peak}`),
    };
  },
};

function resultOf(s: State): string {
  const steps = s.lanes.map((l) => l.seq.length - 1);
  if (s.lanes.length === 1) return `${steps[0]} steps`;
  const w = steps[0] <= steps[1] ? 0 : 1;
  return `${s.lanes[w].n} won by ${Math.abs(steps[0] - steps[1])} steps`;
}

/** The two rules, the one just used lighting up. */
function drawRules(ctx: Ctx2D, theme: Theme, s: State) {
  const lit = flash(s.t - s.lastStepT, 5);
  const rules = [
    { text: 'EVEN  →  ÷ 2', on: !s.lastOdd, x: 290 },
    { text: 'ODD  →  × 3 + 1', on: s.lastOdd, x: 790 },
  ];
  for (const r of rules) {
    const k = r.on ? lit : 0;
    panel(ctx, r.x - 220, 392, 440, 72, 36, `rgba(0,0,0,${0.35 + 0.15 * k})`, r.on ? rgbToCss(paletteAt(theme.palette, r.on && s.lastOdd ? 0.1 : 0.55), 0.35 + 0.6 * k) : 'rgba(255,255,255,0.12)');
    caption(ctx, r.text, r.x, 429, 34, r.on ? `rgba(255,255,255,${0.7 + 0.3 * k})` : 'rgba(255,255,255,0.55)', 'center', 900);
  }
}

const numberSize = (str: string, max: number, width: number) => Math.min(max, width / Math.max(1, str.length * 0.62));

function drawSingle(ctx: Ctx2D, theme: Theme, s: State) {
  const lane = s.lanes[0];
  const t = s.t;
  const value = lane.seq[lane.k];
  if (s.revealed) {
    const u = t - s.revealAt;
    outlined(ctx, theme, `${lane.seq.length - 1} STEPS`, 540, 590, { size: 130, fill: theme.accent, scale: popIn(u / 0.4) });
    if (!drawSaid(ctx, theme, s, 540, 705, 980)) caption(ctx, `${fmtInt(lane.n)} climbed to ${fmtInt(lane.peak)} before falling to 1`, 540, 700, 34, `rgba(255,255,255,${0.75 * clamp01((u - 0.3) / 0.3)})`);
    return;
  }
  const str = fmtInt(value);
  const hit = flash(t - s.lastStepT, 8);
  const col = lane.k === 0 ? paletteAt(theme.palette, 0.4) : paletteAt(theme.palette, s.lastOdd ? 0.1 : 0.55);
  outlined(ctx, theme, str, 540, 585, { size: numberSize(str, 150, 940), fill: rgbToCss(lighten(col, 0.2 + 0.4 * hit)), scale: 1 + 0.06 * hit });
  drawEquation(ctx, theme, s, lane, 540, 692, 980);
  caption(ctx, `STEP ${lane.k}`, 300, 772, 34, 'rgba(255,255,255,0.75)', 'center', 900);
  caption(ctx, `PEAK ${fmtInt(lane.peak)}`, 780, 772, 34, rgbToCss(lighten(paletteAt(theme.palette, 0.1), 0.25 * flash(t - lane.peakAt, 3))), 'center', 900);
}

/**
 * The step just taken, as a sum: big and spelled out while the opening narrates ("703 is odd:
 * 703 × 3 + 1 = 2,110"), then small and quick once the run speeds up.
 */
function drawEquation(ctx: Ctx2D, theme: Theme, s: State, lane: Lane, x: number, y: number, maxW: number) {
  const t = s.t;
  const pair = s.lanes.length > 1;
  // While a line is being spoken it takes this slot (the single number's; a race's has its own).
  if (pair ? speaking(s.speech, t) : drawSaid(ctx, theme, s, x, y, maxW)) return;
  if (lane.k === 0) {
    if (!pair) outlined(ctx, theme, 'Start with any number…', x, y, { size: 44, alpha: clamp01((t - 0.3) / 0.3), maxW });
    return;
  }
  if (lane.k > lane.seq.length - 1) return;
  const prev = lane.seq[lane.k - 1];
  const value = lane.seq[lane.k];
  const odd = prev % 2 === 1;
  const sum = `${fmtInt(prev)} ${odd ? '× 3 + 1' : '÷ 2'} = ${fmtInt(value)}`;
  const col = rgbToCss(lighten(paletteAt(theme.palette, odd ? 0.1 : 0.55), 0.25));
  if (lane.k <= s.narrate) {
    const text = pair ? sum : `${fmtInt(prev)} is ${odd ? 'odd' : 'even'}:  ${sum}`;
    outlined(ctx, theme, text, x, y, { size: pair ? 34 : 44, fill: col, scale: popIn((t - s.lastStepT) / 0.3), maxW });
  } else caption(ctx, sum, x, y, pair ? 26 : 30, 'rgba(255,255,255,0.5)', 'center', 800);
}

function drawPair(ctx: Ctx2D, theme: Theme, s: State) {
  const t = s.t;
  s.lanes.forEach((lane, i) => {
    const x = i ? 790 : 290;
    const col = laneColor(theme, i);
    const done = lane.doneAt >= 0;
    const steps = lane.seq.length - 1;
    const other = s.lanes[1 - i].seq.length - 1;
    const won = steps <= other;
    caption(ctx, `START ${fmtInt(lane.n)}`, x, 520, 30, rgbToCss(col, 0.9), 'center', 900);
    if (s.revealed) {
      const u = t - s.revealAt - (won ? 0 : 0.25);
      outlined(ctx, theme, `${steps}`, x, 610, { size: 120, fill: won ? theme.accent : 'rgba(255,255,255,0.55)', scale: popIn(u / 0.4) });
      caption(ctx, won ? 'STEPS · WINNER' : 'STEPS', x, 700, 30, won ? theme.accent : 'rgba(255,255,255,0.5)', 'center', 900);
      return;
    }
    const str = fmtInt(lane.seq[lane.k]);
    const hit = done ? 0 : flash(t - s.lastStepT, 8);
    outlined(ctx, theme, str, x, 610, { size: numberSize(str, 110, 460), fill: rgbToCss(lighten(col, 0.15 + 0.4 * hit)), scale: 1 + 0.05 * hit });
    if (done) {
      const u = t - lane.doneAt;
      outlined(ctx, theme, 'REACHED 1!', x, 700, { size: 34, fill: theme.accent, scale: popIn(u / 0.35) });
    } else {
      caption(ctx, `STEP ${lane.k}`, x, 700, 32, 'rgba(255,255,255,0.75)', 'center', 900);
      drawEquation(ctx, theme, s, lane, x, 770, 470);
    }
  });
  if (drawSaid(ctx, theme, s, 540, 800, 980)) return;
  if (s.lanes[0].k === 0) outlined(ctx, theme, 'Two neighbours, the same two rules…', 540, 770, { size: 40, alpha: clamp01((t - 0.3) / 0.3) });
}

/** The line being spoken, as a caption; false when nothing is being said. */
function drawSaid(ctx: Ctx2D, theme: Theme, s: State, x: number, y: number, maxW: number): boolean {
  const said = speaking(s.speech, s.t);
  if (!said) return false;
  drawSpoken(ctx, theme, said.line.caption, spokenProgress(said.since, said.line.durationS), x, y, { size: 40, maxW });
  return true;
}

const laneColor = (theme: Theme, i: number) => paletteAt(theme.palette, i ? 0.62 : 0.12);

const compact = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)));

/** The flights so far, on axes that grow to fit (the height eases up when a new peak lands). */
function drawChart(ctx: Ctx2D, theme: Theme, s: State) {
  const { x, y, w, h } = CHART;
  panel(ctx, x - 20, y - 20, w + 40, h + 40, 26, 'rgba(0,0,0,0.3)');
  const t = s.t;
  let yMax = 1;
  for (const lane of s.lanes) {
    const eased = lane.prevPeak + (lane.peak - lane.prevPeak) * smooth((t - lane.peakAt) / 0.35);
    yMax = Math.max(yMax, eased * 1.1);
  }
  const k = Math.max(...s.lanes.map((l) => l.k));
  const xMax = Math.max(10, k + 2);
  const px = (i: number) => x + (i / xMax) * w;
  const py = (v: number) => y + h - (v / yMax) * h;

  // Gridlines at round values.
  const stepV = niceStep(yMax / 4);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  for (let v = stepV; v < yMax; v += stepV) {
    ctx.beginPath();
    ctx.moveTo(x, py(v));
    ctx.lineTo(x + w, py(v));
    ctx.stroke();
    caption(ctx, compact(v), x + 8, py(v) - 16, 22, 'rgba(255,255,255,0.35)', 'left', 700);
  }

  // Clipped to the panel: a new peak overshoots the top until the scale has eased up to it.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 20, y - 20, w + 40, h + 40);
  ctx.clip();
  s.lanes.forEach((lane, li) => {
    const col = laneColor(theme, li);
    const n = Math.min(lane.k, lane.seq.length - 1);
    if (s.lanes.length === 1) {
      const grad = ctx.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, rgbToCss(col, 0.28));
      grad.addColorStop(1, rgbToCss(col, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(px(0), y + h);
      for (let i = 0; i <= n; i++) ctx.lineTo(px(i), py(lane.seq[i]));
      ctx.lineTo(px(n), y + h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = rgbToCss(lighten(col, 0.15));
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      if (i === 0) ctx.moveTo(px(i), py(lane.seq[i]));
      else ctx.lineTo(px(i), py(lane.seq[i]));
    }
    ctx.stroke();
    // Peak marker.
    const pi = lane.seq.indexOf(lane.peak);
    if (pi > 0 && pi <= n) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(px(pi), py(lane.peak), 8, 0, Math.PI * 2);
      ctx.fill();
      const label = fmtInt(lane.peak);
      caption(ctx, label, Math.min(x + w - 60, Math.max(x + 60, px(pi))), py(lane.peak) - 26, 26, 'rgba(255,255,255,0.85)', 'center', 900);
    }
    // The current number.
    const hit = lane.doneAt >= 0 ? 0 : flash(t - s.lastStepT, 8);
    ctx.fillStyle = rgbToCss(lighten(col, 0.4));
    ctx.beginPath();
    ctx.arc(px(n), py(lane.seq[n]), 10 + 6 * hit, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
  caption(ctx, 'steps →', x + w - 6, y + h - 18, 24, 'rgba(255,255,255,0.35)', 'right', 700);
  // The opening explains the chart, then hands over to the run.
  if (t < s.repeatAt) {
    caption(ctx, 'every new number lands here', x + w / 2, y + h / 2, 30, `rgba(255,255,255,${0.45 * clamp01((t - 0.6) / 0.4)})`, 'center', 800);
  } else {
    const u = t - s.repeatAt;
    const alpha = clamp01(u / 0.25) * clamp01((2.4 - u) / 0.5);
    if (alpha > 0) outlined(ctx, theme, 'Keep going until it reaches 1', x + w / 2, y + h * 0.42, { size: 52, fill: theme.accent, alpha, scale: popIn(u / 0.35), maxW: w - 40 });
  }
}

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
}

