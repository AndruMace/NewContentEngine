import * as dm from '@sim/physics/math';
import type { Rng } from '@sim/engine';
import { Script, estimateS, type Act, type BeatSpec } from '../story';
import { diameterFor, figureHz, figures, noteName, patternOf, type Figure, type Pattern, type Plate } from './modes';
import type { Material } from './plate';
import type { ChladniParams } from './params';

/** Ticks a pattern takes to settle while the tone holds (one tick ≈ 1/60 s at nominal speed). */
export const SETTLE = 150;
/** Ticks a glide between two notes takes. */
const GLIDE = 90;
const TPS = 60;

/** A figure on this video's plate, with its real frequency. */
export interface Mode extends Figure {
  hz: number;
}

/** The tone over the run, in ticks: holds and exponential glides; silent between `on` stretches. */
export interface Key {
  tick: number;
  hz: number;
  on: boolean;
  /** Bowed at the edge (else the speaker under the centre). */
  bow: boolean;
}

export interface PlateSim {
  material: Material;
  /** Each plate's size and thickness, as the picture labels it ("24 cm × 2 mm steel"). */
  labels: Record<Plate, string>;
  modes: Mode[];
  /** Grids for each mode (built only when the video is drawn). */
  patterns: (Pattern | null)[];
  keys: Key[];
  tick: number;
  plate: Plate;
  /** Sand, in plate units (0..1); visual only. */
  sx: Float32Array;
  sy: Float32Array;
  noise: number;
  /** Mode set the sand to settle on, and the guessing state. */
  options: number[][];
  round: number;
  answers: number[];
  revealed: boolean[];
  answer: string;
  /** Grains of sand (0 for headless runs: the sand is picture-only). */
  grains: number;
}

export interface Built {
  sim: PlateSim;
  script: Script<PlateSim>;
}

export const LETTERS = ['A', 'B', 'C', 'D'];

/** This video's plate's figures (drivable by the chosen driver), with real frequencies. */
function modeList(plate: Plate, p: ChladniParams): Mode[] {
  return figures(plate, p.material, p.driver).map((f) => ({ ...f, hz: figureHz(f, p.material, p.size, p.thickness) }));
}

const labelOf = (p: ChladniParams, plate: Plate, sizeCm: number) => `${Math.round(sizeCm)} cm ${plate === 'square' ? 'square' : 'round'} · ${p.thickness} mm ${p.material}`;

/** The tone's frequency at a tick, and whether it's sounding. */
export function toneAt(keys: Key[], tick: number): { hz: number; on: boolean; bow: boolean } {
  let k = 0;
  while (k + 1 < keys.length && keys[k + 1].tick <= tick) k++;
  const a = keys[k];
  const b = keys[k + 1];
  if (!b || !a.on || !b.on || b.hz === a.hz) return { hz: a.hz, on: a.on, bow: a.bow };
  const u = (tick - a.tick) / Math.max(1, b.tick - a.tick);
  return { hz: a.hz * dm.pow(b.hz / a.hz, Math.max(0, Math.min(1, u))), on: true, bow: a.bow };
}

class Plan {
  pos = 0;
  readonly keys: Key[] = [{ tick: 0, hz: 220, on: false, bow: false }];
  constructor(readonly s: Script<PlateSim>) {}

  /** The tone from here on (a glide ends where the next key starts). */
  key(hz: number, on: boolean, bow = this.keys[this.keys.length - 1].bow) {
    const last = this.keys[this.keys.length - 1];
    if (last.tick === this.pos) {
      // Two keys on one tick: the tone would switch at once, so a silence before it would never be heard.
      if (last.on !== on) throw new Error('chladni: the tone switches on and off at the same tick');
      this.keys.pop();
    }
    this.keys.push({ tick: this.pos, hz, on, bow });
  }

  /** Start a figure's note, with whatever drives it. */
  sound(m: Mode) {
    this.key(m.hz, true, m.exciter === 'bow');
  }

  /**
   * A line. Without ticks it still lets time pass in the sim (the sand lies still while the plate is
   * silent), so the tone, keyed to ticks, starts exactly at the line that starts it, never earlier.
   */
  say(beat: BeatSpec, facts: Record<string, string | number>, ticks: number | number[] = Math.round(estimateS(beat.maxWords) * TPS), acts?: (Act<PlateSim> | null)[]) {
    this.s.say(beat, { facts: () => facts, ticks, acts });
    this.pos += Array.isArray(ticks) ? ticks.reduce((a, b) => a + b, 0) : ticks;
  }

  play(ticks: number, elastic = false) {
    this.s.play(ticks, TPS, { elastic });
    this.pos += ticks;
  }

  /** Glide from the current note to the next figure's (played the way the next figure needs). */
  glide(m: Mode, elastic = true) {
    const from = this.keys[this.keys.length - 1];
    const bow = m.exciter === 'bow';
    this.key(from.hz, true, bow);
    this.play(GLIDE, elastic);
    this.key(m.hz, true, bow);
  }
}

const hzFacts = (m: Mode) => ({ hz: Math.round(m.hz), note: noteName(m.hz), how: m.exciter === 'bow' ? 'a violin bow on the edge' : 'the speaker under the centre' });

/** Fast random numbers for the grains (picture-only, but fixed so every render matches the preview). */
export const lcg = (s: number) => (Math.imul(s, 1664525) + 1013904223) >>> 0;

/** Spread the sand evenly over the plate. */
export function scatterSand(sim: PlateSim) {
  const n = sim.grains;
  if (sim.sx.length !== n) {
    sim.sx = new Float32Array(n);
    sim.sy = new Float32Array(n);
  }
  let r = sim.noise;
  for (let i = 0; i < n; i++) {
    let x: number;
    let y: number;
    do {
      r = lcg(r);
      x = r / 4294967296;
      r = lcg(r);
      y = r / 4294967296;
    } while (sim.plate === 'circle' && (x - 0.5) ** 2 + (y - 0.5) ** 2 > 0.24);
    sim.sx[i] = x;
    sim.sy[i] = y;
  }
  sim.noise = r;
}

/** A tap on the plate: the sand spreads out evenly again. */
const scatter: Act<PlateSim> = (sim, emit) => {
  scatterSand(sim);
  emit({ type: 'chladni:scatter' });
};

const HISTORY: BeatSpec = {
  id: 'lesson',
  about: 'The history: Ernst Chladni showed these sand patterns in {year}, and violin and guitar makers still use them to tune the wood of their instruments.',
  maxWords: 20,
  required: ['year'],
  fallback: ['Ernst Chladni first showed this in {year}. Violin makers still use it to tune their instruments.', 'These are Chladni figures, first shown in {year}. Guitar and violin makers still use them today.'],
};

/** The opening line: the plate, and what will make it ring (a speaker under it, or a bow). */
function introBeat(p: ChladniParams, first: Mode): [BeatSpec, Record<string, string | number>] {
  const facts = { size: p.size, metal: p.material, grains: p.sand === 'sand' ? 'sand' : 'salt' };
  return first.exciter === 'speaker'
    ? [{ id: 'intro', about: 'Sand is sprinkled on a {size} centimetre {metal} plate; a speaker under its centre is about to make it vibrate.', maxWords: 16, fallback: ['This is {grains} on a {metal} plate. A speaker under it is about to shake it.', 'Sand on a {metal} plate, and a speaker underneath. Watch what sound does.'] }, facts]
    : [{ id: 'intro', about: 'Sand is sprinkled on a {size} centimetre {metal} plate; a violin bow drawn across its edge is about to make it ring.', maxWords: 16, fallback: ['This is {grains} on a {metal} plate. A violin bow is about to make it ring.', 'Sand on a {metal} plate, and a violin bow at its edge. Watch.'] }, facts];
}

function risingPitch(p: ChladniParams, rng: Rng): Built {
  const all = modeList(p.plate, p);
  const picked: Mode[] = [];
  for (let k = 0; picked.length < p.patterns && p.startAt + k * p.spread < all.length; k++) picked.push(all[p.startAt + k * p.spread]);
  void rng;
  const sim = newSim(p, p.plate, picked);
  const s = new Script<PlateSim>();
  const plan = new Plan(s);
  plan.say(...introBeat(p, picked[0]));
  if (p.guess) plan.say({ id: 'guess', about: 'The viewer is asked to guess what the sand will do when the note plays.', maxWords: 9, fallback: ['What will the sand do? Guess now.', 'Guess what happens when it plays.'] }, {});
  const first = picked[0];
  plan.sound(first);
  plan.say(
    {
      id: 'first',
      about: 'The first note plays and the sand moves.',
      maxWords: 20,
      required: ['hz'],
      parts: [
        { about: 'a note of {hz} hertz starts, from {how}, and the plate shakes', maxWords: 8 },
        { about: 'the sand runs away from the shaking parts and gathers on the lines that stay still', maxWords: 12 },
      ],
      fallback: ['A note: {hz} hertz. The plate shakes. | The sand runs to the only places that stay still.', 'Play {hz} hertz. | The sand flees the shaking and piles up where the plate is still.'],
    },
    hzFacts(first),
    // The first figure is the simplest, with the furthest for the sand to go: it gets longer.
    [SETTLE / 2, SETTLE],
  );
  const lines: BeatSpec[] = [
    { id: 'next1', about: 'The note rises to {hz} hertz (played by {how}) and a new, more detailed pattern forms.', maxWords: 10, required: ['hz'], fallback: ['Higher: {hz} hertz. A new pattern.', 'Up to {hz} hertz, and it rearranges.'] },
    { id: 'next2', about: 'Now {hz} hertz (played by {how}): even more lines appear.', maxWords: 8, required: ['hz'], fallback: ['{hz} hertz. Even more lines.', 'Now {hz} hertz. More detail.'] },
  ];
  for (let i = 1; i < picked.length; i++) {
    plan.glide(picked[i]);
    const last = i === picked.length - 1;
    if (last) {
      s.mark('reveal');
      plan.say({ id: 'last', about: 'The highest note so far, {hz} hertz, makes the most complex pattern yet.', maxWords: 11, required: ['hz'], fallback: ['{hz} hertz: the most complex yet.', 'And {hz} hertz. The wildest one.'] }, hzFacts(picked[i]), SETTLE);
    } else if (i <= lines.length) plan.say(lines[i - 1], hzFacts(picked[i]), SETTLE);
    else plan.play(SETTLE, true);
  }
  plan.say(HISTORY, { year: '1787' }, 60);
  sim.answer = `${picked.length} PATTERNS`;
  plan.key(picked[picked.length - 1].hz, false);
  s.mark('outro');
  s.hold(2.6);
  sim.keys = plan.keys;
  return { sim, script: s };
}

function guessPattern(p: ChladniParams, rng: Rng): Built {
  const all = modeList(p.plate, p);
  const used = new Set<number>();
  const options: number[][] = [];
  const answers: number[] = [];
  const modes: Mode[] = [];
  // As many rounds as the plate has figures for (a speaker alone drives only a few).
  const rounds = Math.max(1, Math.min(p.rounds, Math.floor(all.length / p.options)));
  for (let r = 0; r < rounds; r++) {
    // Each round a little harder: patterns from further along the list, close in complexity.
    const base = Math.max(0, Math.min(all.length - p.options * 2, p.startAt + r * 4 + rng.int(0, 2)));
    const pool: number[] = [];
    for (let k = base; pool.length < p.options && k < all.length; k += 1 + rng.int(0, 1)) if (!used.has(k)) pool.push(k);
    const ids = pool.map((k) => {
      used.add(k);
      modes.push(all[k]);
      return modes.length - 1;
    });
    // Shuffle the letters.
    for (let i = ids.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    options.push(ids);
    answers.push(rng.int(0, ids.length - 1));
  }
  const sim = newSim(p, p.plate, modes);
  sim.options = options;
  sim.answers = answers;
  sim.revealed = options.map(() => false);
  const s = new Script<PlateSim>();
  const plan = new Plan(s);
  plan.say({ id: 'intro', about: 'Sand on a vibrating plate: every note makes its own pattern in it.', maxWords: 12, fallback: ['Every note makes its own pattern in this sand.', 'Sand on a plate. Each note draws something different.'] }, {});
  options.forEach((ids, r) => {
    const correct = modes[ids[answers[r]]];
    if (r > 0) {
      s.act((sim) => (sim.round = r));
      s.act(scatter);
    }
    plan.say(
      { id: `ask${r + 1}`, about: `Round ${r + 1}: {count} patterns are shown, lettered. Which one will the next note make?`, maxWords: 11, required: ['count'], fallback: r === 0 ? ['Here are {count} patterns. Which one will this note make?', '{count} patterns. Which will this note draw?'] : ['Next note. Which of these {count} this time?', 'Now these {count}. Which one?'] },
      { count: ids.length },
    );
    if (p.guess && r === 0) plan.say({ id: 'guess', about: 'The viewer is asked to comment their guess before the sand settles.', maxWords: 7, fallback: ['Comment your guess, then listen.', 'Lock in a letter. Listen.'] }, {});
    plan.sound(correct);
    plan.say({ id: `play${r + 1}`, about: 'The note plays, {hz} hertz, and the sand starts to move.', maxWords: 8, required: ['hz'], fallback: ['{hz} hertz. Here it comes.', 'Listen: {hz} hertz.'] }, hzFacts(correct), SETTLE);
    // Long enough for even a fine pattern to settle before the answer.
    plan.play(SETTLE * 1.5, true);
    if (r === options.length - 1) s.mark('reveal');
    plan.say({ id: `reveal${r + 1}`, about: 'The sand has settled: it is pattern {letter}.', maxWords: 8, required: ['letter'], fallback: ['It is pattern {letter}!', 'Pattern {letter}. Did you get it?'] }, { letter: LETTERS[answers[r]] }, 30, [(sim) => (sim.revealed[r] = true)]);
    plan.key(correct.hz, false);
  });
  plan.say(HISTORY, { year: '1787' });
  sim.answer = answers.map((a) => LETTERS[a]).join(' ');
  s.mark('outro');
  s.hold(2.6);
  sim.keys = plan.keys;
  return { sim, script: s };
}

function plateShapes(p: ChladniParams): Built {
  const squares = modeList('square', p);
  const sq = squares[Math.min(squares.length - 1, p.startAt + 2)];
  // A round plate of the same metal and thickness that rings at the very same note, played the same
  // way if it can be: its size is whatever puts one of its figures on that note (the one needing a
  // plate closest in size to the square).
  const rounds = figures('circle', p.material, p.driver).filter((f) => p.driver !== 'auto' || (f.exciter === 'speaker') === (sq.exciter === 'speaker'));
  const round = rounds.reduce((best, f) => (Math.abs(diameterFor(f, p.material, sq.hz, p.thickness) - p.size) < Math.abs(diameterFor(best, p.material, sq.hz, p.thickness) - p.size) ? f : best));
  const diameter = diameterFor(round, p.material, sq.hz, p.thickness);
  const modes: Mode[] = [sq, { ...round, hz: sq.hz }];
  const sim = newSim(p, 'square', modes);
  sim.labels.circle = labelOf(p, 'circle', diameter);
  const s = new Script<PlateSim>();
  const plan = new Plan(s);
  plan.say({ id: 'intro', about: 'One note, two plates of different shapes. Will the sand make the same pattern?', maxWords: 13, fallback: ['One note, two different plates. Same pattern?', 'Same note, square plate, then round. Watch.'] }, {});
  if (p.guess) plan.say({ id: 'guess', about: 'The viewer is asked whether the round plate will show the same pattern as the square one.', maxWords: 9, fallback: ['Same pattern on both? Guess now.', 'Will the round one match? Guess.'] }, {});
  plan.sound(sq);
  plan.say({ id: 'square', about: 'On the square plate, a note of {hz} hertz makes this pattern.', maxWords: 11, required: ['hz'], fallback: ['On a square plate, {hz} hertz makes this.', 'Square plate, {hz} hertz.'] }, hzFacts(sq), SETTLE);
  // Time to look (stretched or cut to fit the length), still sounding.
  plan.play(SETTLE, true);
  plan.key(sq.hz, false);
  s.act((sim, emit) => {
    sim.plate = 'circle';
    sim.round = 1;
    scatter(sim, emit);
  });
  plan.say({ id: 'swap', about: 'The plate is swapped for a round one, {diameter} centimetres across, that rings at the same note; the sand is spread out again.', maxWords: 11, fallback: ['Now a round plate. Same note.', 'Swap in a round plate. Same note.'] }, { diameter: Math.round(diameter) });
  plan.sound(modes[1]);
  s.mark('reveal');
  plan.say({ id: 'round', about: 'The same note makes a completely different pattern on the round plate: rings and spokes.', maxWords: 11, fallback: ['A completely different pattern. Rings and spokes.', 'Totally different: circles and spokes.'] }, {}, SETTLE);
  plan.play(SETTLE, true);
  plan.say({ id: 'lesson', about: 'The lesson: the pattern depends on the shape as much as the note, which is why every violin body sounds slightly different.', maxWords: 18, fallback: ['The shape matters as much as the note. That is why no two violins sound the same.', 'Change the shape, change the pattern. Every violin body rings in its own way.'] }, {}, 60);
  plan.key(sq.hz, false);
  sim.answer = 'DIFFERENT';
  s.mark('outro');
  s.hold(2.6);
  sim.keys = plan.keys;
  return { sim, script: s };
}

function newSim(p: ChladniParams, plate: Plate, modes: Mode[]): PlateSim {
  return { material: p.material, labels: { square: labelOf(p, 'square', p.size), circle: labelOf(p, 'circle', p.size) }, modes, patterns: modes.map(() => null), keys: [], tick: 0, plate, sx: new Float32Array(0), sy: new Float32Array(0), noise: 0x1234567, options: [], round: 0, answers: [], revealed: [], answer: '', grains: 0 };
}

/** Build the grids (only for videos that are drawn: the sand is picture-only). */
export function buildPatterns(sim: PlateSim) {
  sim.patterns = sim.modes.map((m) => patternOf(m, sim.material));
}

export function buildChladni(p: ChladniParams, rng: Rng): Built {
  switch (p.mode) {
    case 'rising-pitch':
      return risingPitch(p, rng);
    case 'guess-the-pattern':
      return guessPattern(p, rng);
    case 'plate-shapes':
      return plateShapes(p);
  }
}
