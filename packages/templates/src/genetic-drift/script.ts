import type { Rng } from '@sim/engine';
import { Script, estimateS, type BeatSpec, type Facts } from '../story';
import { coloursLeft, concat, firstRow, grow, milestones, type History } from './sim';
import type { DriftParams } from './params';
import { COLOURS, MUTANT, SKINS } from './params';

/** What the tick advances, and what the picture reads. */
export interface DriftSim {
  /** Generation on screen (an index into the history; both histories for two populations). */
  g: number;
  hist: History;
  /** The big population (small vs large). */
  big: History | null;
  /** Lucky mutant: first generation of each trial. */
  starts: number[];
  colours: { name: string; hex: string }[];
  /** Generation lineage lines are shown up to (the opening generations), then hidden. */
  showLinesTo: number;
  /** The answer is out (the picture shows it). */
  revealed: boolean;
  /** Mode-specific labels for the picture and copy. */
  answer: string;
  result: string;
}

/** The script, the sim and the run's headline facts. */
export interface Built {
  sim: DriftSim;
  script: Script<DriftSim>;
}

/** The answer comes out: the picture shows it, and the result goes in the log (for seed-search tallies). */
const reveal = (sim: DriftSim, emit: (e: { type: string; [k: string]: unknown }) => void) => {
  sim.revealed = true;
  emit({ type: 'drift:result', result: sim.result, answer: sim.answer });
};

/** How quickly the opening generations go by (one per beat, or so). */
const SLOW_TPS = 2.2;
/** Generations shown with their parent lines before the lines fade. */
const LINE_GENS = 8;

class Plan {
  /** Ticks scheduled so far, which is the generation on screen when they've run. */
  pos = 0;
  constructor(
    readonly s: Script<DriftSim>,
    public tps: number,
  ) {}

  say(beat: BeatSpec, facts: Facts, ticks: number | number[] = 0) {
    this.s.say(beat, { facts: () => facts, ticks });
    this.pos += Array.isArray(ticks) ? ticks.reduce((a, b) => a + b, 0) : ticks;
  }

  /** Run (elastic) until the next tick shows generation g. */
  upTo(g: number) {
    const n = g - 1 - this.pos;
    if (n > 0) {
      this.s.play(n, this.tps, { elastic: true });
      this.pos += n;
    }
  }

  /** Can a beat still be anchored on generation g (it hasn't been reached yet)? */
  ahead(g: number) {
    return g >= this.pos + 1;
  }

  slow(n: number, tps = SLOW_TPS) {
    if (n <= 0) return;
    this.s.play(n, tps);
    this.pos += n;
  }
}

/** Ticks per second for the fast stretches, so the whole run lands near the target. */
function fastTps(p: DriftParams, fastGens: number, beats: number): number {
  const fixed = beats * (estimateS(13) + 0.35) + 4;
  const budget = Math.max(6, p.targetS - fixed);
  return Math.max(4, Math.min(400, fastGens / budget));
}

const intro = (): BeatSpec => ({
  id: 'intro',
  about: 'A population of {n} {critters} appears, {k} colours in equal numbers. No colour has any advantage over another.',
  maxWords: 18,
  required: ['n', 'critters', 'k'],
  fallback: ['Here are {n} {critters} in {k} colours. None of them is better than the others.', 'Meet {n} {critters}, {k} colours, perfectly equal. No colour has any advantage.'],
});

const GUESS: BeatSpec = {
  id: 'guess',
  about: 'The viewer is asked to guess which colour will end up taking over the whole population.',
  maxWords: 9,
  fallback: ['So which colour takes over? Lock in your guess.', 'Guess which colour wins. Comment it now.'],
};

const RULE: BeatSpec = {
  id: 'rule',
  about: 'How each new generation is made.',
  maxWords: 20,
  parts: [
    { about: 'the next generation appears below: each new one copies a single parent, picked at random', maxWords: 9 },
    { about: 'another generation: lines show some parents were copied several times and others not at all', maxWords: 9 },
  ],
  fallback: ['Each generation, everyone copies one random parent. | Some get copied twice, some not at all.', 'Every new {critter} picks a parent at random. | Lucky ones leave more copies.'],
};

const CHANCE: BeatSpec = {
  id: 'chance',
  about: 'A few more generations go by slowly; the colour shares start to wander. Nobody is choosing: it is pure chance.',
  maxWords: 9,
  fallback: ['Nobody is choosing. It is pure chance.', 'No skill, no fitness. Just luck.'],
};

function lostBeat(id: string): BeatSpec {
  return {
    id,
    about: 'The last {colour} one just died out, at generation {g}: that colour is gone for good.',
    maxWords: 12,
    required: ['colour', 'g'],
    fallback: ['And {colour} is gone, after {g} generations.', 'Generation {g}: the last {colour} one disappears.'],
  };
}

const TWO: BeatSpec = {
  id: 'two',
  about: 'Only two colours remain: {a} and {b}. Now it is a duel.',
  maxWords: 10,
  required: ['a', 'b'],
  fallback: ['Now it is {a} against {b}.', 'Just two colours left: {a} and {b}.'],
};

const WIN: BeatSpec = {
  id: 'win',
  about: 'Every single individual is now {winner}: that colour has taken over, at generation {g}.',
  maxWords: 12,
  required: ['winner', 'g'],
  fallback: ['{winner} takes over everything, at generation {g}.', 'Generation {g}: every single one is {winner}.'],
};

const LESSON: BeatSpec = {
  id: 'lesson',
  about: 'The lesson: no colour was better; random chance alone made one take over. Biologists call this genetic drift.',
  maxWords: 18,
  required: ['winner'],
  fallback: ['No colour was better. Luck alone did this. That is genetic drift.', 'Nothing was special about {winner}. Random chance did it all. Biologists call it genetic drift.'],
};

const nounOf = (p: DriftParams) => SKINS[p.skin];

function baseFacts(p: DriftParams, n: number, k: number): Facts {
  const noun = nounOf(p);
  return { n, k, critters: noun.plural, critter: noun.one };
}

function newSim(p: DriftParams, hist: History, colours: { name: string; hex: string }[]): DriftSim {
  return { g: 0, hist, big: null, starts: [0], colours, showLinesTo: LINE_GENS, revealed: false, answer: '', result: '' };
}

function coloursFor(p: DriftParams, k: number): { name: string; hex: string }[] {
  return COLOURS[p.palette].slice(0, k);
}

/** The opening every mode shares: what each generation is, shown slowly. */
function opening(plan: Plan, p: DriftParams, facts: Facts, guess: BeatSpec) {
  plan.say(guess, facts);
  plan.say(RULE, facts, [1, 1]);
  // Longer videos take a breath on the opening generations; shorter ones go straight on.
  if (p.targetS >= 50) plan.say(CHANCE, facts, 3);
  else plan.slow(2);
}

function race(p: DriftParams, rng: Rng): Built {
  const k = p.colours;
  const hist = grow(rng, { n: p.popSize, k, first: firstRow(p.popSize, k), maxGens: p.maxGenerations, parentsUpTo: p.popSize <= 64 ? p.maxGenerations : LINE_GENS });
  const m = milestones(hist);
  const sim = newSim(p, hist, coloursFor(p, k));
  const s = new Script<DriftSim>();
  const facts = baseFacts(p, p.popSize, k);
  const end = hist.counts.length - 1;
  const plan = new Plan(s, fastTps(p, end, 8));
  plan.say(intro(), facts);
  opening(plan, p, facts, GUESS);
  const name = (c: number) => sim.colours[c].name;
  const first = m.lost[0];
  if (first && plan.ahead(first.g) && first.g < end) {
    plan.upTo(first.g);
    plan.say(lostBeat('lost1'), { colour: name(first.c), g: first.g }, 1);
  }
  if (k >= 3 && m.twoLeftAt > 0 && m.twoLeftAt < end) {
    const left = hist.counts[m.twoLeftAt].map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
    const facts2 = { a: name(left[0]), b: name(left[1]) };
    if (plan.ahead(m.twoLeftAt)) {
      plan.upTo(m.twoLeftAt);
      plan.say(TWO, facts2, 1);
    } else if (m.twoLeftAt <= plan.pos) plan.say(TWO, facts2, 2);
  }
  finish(plan, p, sim, m, end, facts);
  return { sim, script: s };
}

/** The run's end: a slow approach, the takeover, the lesson. */
function finish(plan: Plan, p: DriftParams, sim: DriftSim, m: ReturnType<typeof milestones>, end: number, facts: Facts, win: BeatSpec = WIN, lesson: BeatSpec = LESSON) {
  const s = plan.s;
  if (m.fixedAt > 0) {
    plan.upTo(Math.max(plan.pos + 1, m.fixedAt - 3));
    plan.slow(m.fixedAt - 1 - plan.pos, 3);
    s.act(reveal);
    s.mark('reveal');
    const winner = sim.colours[m.winner].name;
    plan.say(win, { ...facts, winner, g: m.fixedAt }, Math.max(0, m.fixedAt - plan.pos));
    sim.answer = `${winner.toUpperCase()} WINS`;
    sim.result = `${winner} took over`;
    plan.say(lesson, { ...facts, winner });
  } else {
    plan.upTo(end);
    plan.slow(end - plan.pos, 3);
    s.act(reveal);
    s.mark('reveal');
    const left = coloursLeft(sim.hist.counts[end]);
    plan.say(STILL, { ...facts, g: end, left });
    sim.answer = 'NO WINNER YET';
    sim.result = `${left} colours left`;
    plan.say(lesson, { ...facts, winner: 'none of them' });
  }
  s.mark('outro');
  s.hold(2.6);
}

const STILL: BeatSpec = {
  id: 'still',
  about: 'Time is up: after {g} generations no colour has won yet; {left} colours are still hanging on.',
  maxWords: 12,
  required: ['g', 'left'],
  fallback: ['After {g} generations, {left} colours are still hanging on.', 'Generation {g}, and still {left} colours left.'],
};

function selection(p: DriftParams, rng: Rng): Built {
  const k = 2;
  const fitness = [1 + p.advantage, 1];
  const hist = grow(rng, { n: p.popSize, k, first: firstRow(p.popSize, k), maxGens: p.maxGenerations, fitness, parentsUpTo: p.popSize <= 64 ? p.maxGenerations : LINE_GENS });
  const m = milestones(hist);
  const sim = newSim(p, hist, coloursFor(p, k));
  const fav = sim.colours[0].name;
  const other = sim.colours[1].name;
  const pct = Math.round(p.advantage * 100);
  const facts = { ...baseFacts(p, p.popSize, k), fav, other, pct };
  const s = new Script<DriftSim>();
  const end = hist.counts.length - 1;
  const plan = new Plan(s, fastTps(p, end, 7));
  plan.say(
    {
      id: 'intro',
      about: 'A population of {n} {critters}, half {fav} and half {other}. The {fav} ones are {pct} percent fitter: they leave more offspring on average.',
      maxWords: 20,
      required: ['n', 'critters', 'fav', 'pct'],
      fallback: ['Here are {n} {critters}, {fav} and {other}. The {fav} ones are {pct} percent fitter.', '{n} {critters}. Every {fav} one has {pct} percent more babies than the {other} ones.'],
    },
    facts,
  );
  opening(plan, p, facts, {
    id: 'guess',
    about: 'The viewer is asked whether the fitter colour, {fav}, will win.',
    maxWords: 10,
    required: ['fav'],
    fallback: ['So does {fav} win? Lock in your guess.', 'Will {fav} take over? Comment your guess.'],
  });
  const favWon = m.winner === 0;
  const win: BeatSpec = favWon
    ? { ...WIN, about: 'The fitter colour, {winner}, has taken over at generation {g}, as you might expect.' }
    : { ...WIN, about: 'Surprise: the less fit colour, {winner}, has taken over at generation {g}.', fallback: ['Surprise! {winner} takes over, at generation {g}.', 'Generation {g}: {winner} wins anyway.'] };
  const lesson: BeatSpec = favWon
    ? { id: 'lesson', about: 'The advantage held this time. But in small populations, luck often beats a real advantage.', maxWords: 18, fallback: ['This time the advantage held. In small populations, it often does not.', 'Fitness won today. But in small groups, luck can still beat it.'] }
    : { id: 'lesson', about: 'Being fitter was not enough: in a small population, random chance beat a real advantage. That is genetic drift.', maxWords: 18, fallback: ['Being fitter was not enough. In small populations, luck can beat a real advantage.', 'A real advantage, and it still lost. That is the power of genetic drift.'] };
  finish(plan, p, sim, m, end, facts, win, lesson);
  if (m.fixedAt > 0) sim.result = favWon ? 'fitter won' : 'underdog won';
  return { sim, script: s };
}

function smallVsLarge(p: DriftParams, rng: Rng): Built {
  const k = p.colours;
  const small = grow(rng, { n: p.smallSize, k, first: firstRow(p.smallSize, k), maxGens: p.maxGenerations, parentsUpTo: p.maxGenerations });
  const ms = milestones(small);
  const smallEnd = small.counts.length - 1;
  const want = Math.min(p.maxGenerations, Math.max(smallEnd * 6, smallEnd + 60));
  const big = grow(rng, { n: p.popSize, k, first: firstRow(p.popSize, k), maxGens: want, parentsUpTo: LINE_GENS });
  const mb = milestones(big);
  const end = big.counts.length - 1;
  const sim = newSim(p, small, coloursFor(p, k));
  sim.big = big;
  const facts = { ...baseFacts(p, p.popSize, k), small: p.smallSize, large: p.popSize };
  const s = new Script<DriftSim>();
  const plan = new Plan(s, fastTps(p, end, 8));
  plan.say(
    {
      id: 'intro',
      about: 'Two populations side by side with the same {k} colours: a small one of {small} {critters} and a big one of {large}.',
      maxWords: 20,
      required: ['k', 'small', 'large'],
      fallback: ['Two populations, the same {k} colours. One has {small} {critters}, the other {large}.', 'Same {k} colours, two sizes: {small} {critters} here, {large} there.'],
    },
    facts,
  );
  opening(plan, p, facts, {
    id: 'guess',
    about: 'The viewer is asked which population will lose its variety, ending up all one colour, first.',
    maxWords: 10,
    fallback: ['Which one ends up all one colour first?', 'Which loses its colours first? Comment your guess.'],
  });
  if (ms.fixedAt > 0 && plan.ahead(ms.fixedAt)) {
    plan.upTo(ms.fixedAt);
    plan.say(
      {
        id: 'small',
        about: 'The small population is now entirely {winner}, after just {g} generations; the big one is still mixed.',
        maxWords: 13,
        required: ['winner', 'g'],
        fallback: ['The small one is all {winner} after just {g} generations.', 'Generation {g}: the small group is all {winner} already.'],
      },
      { winner: sim.colours[ms.winner].name, g: ms.fixedAt },
      1,
    );
  }
  plan.upTo(Math.max(plan.pos + 1, end - 2));
  plan.slow(end - plan.pos, 3);
  s.act(reveal);
  s.mark('reveal');
  const bigFixed = mb.fixedAt > 0 && mb.fixedAt === end;
  const ratio = ms.fixedAt > 0 ? Math.max(2, Math.round(end / ms.fixedAt)) : 0;
  if (bigFixed)
    plan.say(
      { id: 'big', about: 'The big population finally ends up one colour at generation {g}, {ratio} times longer than the small one.', maxWords: 13, required: ['g', 'ratio'], fallback: ['The big one took {g} generations, {ratio} times longer.', 'It took the big one {g} generations: {ratio} times as long.'] },
      { g: end, ratio },
    );
  else
    plan.say(
      { id: 'big', about: 'After {g} generations, the big population still has {left} colours.', maxWords: 13, required: ['g', 'left'], fallback: ['After {g} generations, the big one still has {left} colours.', 'Generation {g}, and the big one keeps {left} colours.'] },
      { g: end, left: coloursLeft(big.counts[end]) },
    );
  sim.answer = 'SMALL LOSES FIRST';
  sim.result = bigFixed ? 'big fixed too' : 'big still mixed';
  plan.say({ id: 'lesson', about: 'Small populations drift fast and lose variety; big ones hold on to it far longer.', maxWords: 16, fallback: ['Small populations drift fast. Big ones hold on to their variety much longer.', 'The smaller the group, the faster luck wipes out its variety.'] }, facts);
  s.mark('outro');
  s.hold(2.6);
  return { sim, script: s };
}

/** Colours present at generation a and gone by b. */
function lostIn(h: History, a: number, b: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < h.k; c++) if (h.counts[a][c] > 0 && h.counts[b][c] === 0) out.push(c);
  return out;
}

/** Bottleneck: the crash generation (after a stretch of normal life) and how it regrows. */
export const CRASH_AT = 24;

function bottleneck(p: DriftParams, rng: Rng): Built {
  const k = p.colours;
  const S = Math.min(p.bottleneckSize, p.popSize - 1);
  const sizeAt = (g: number) => (g < CRASH_AT ? p.popSize : g < CRASH_AT + 2 ? S : Math.min(p.popSize, S * 2 ** (g - CRASH_AT - 1)));
  const hist = grow(rng, { n: p.popSize, k, first: firstRow(p.popSize, k), maxGens: p.maxGenerations, sizeAt, stop: (c, g) => g > CRASH_AT + 2 && coloursLeft(c) <= 1, parentsUpTo: LINE_GENS });
  const m = milestones(hist);
  const end = hist.counts.length - 1;
  const sim = newSim(p, hist, coloursFor(p, k));
  const before = coloursLeft(hist.counts[CRASH_AT - 1]);
  const after = coloursLeft(hist.counts[Math.min(end, CRASH_AT + 1)]);
  let regrown = CRASH_AT + 2;
  while (regrown < end && hist.rows[regrown].length < p.popSize) regrown++;
  const facts = { ...baseFacts(p, p.popSize, k), survivors: S, lost: before - after, left: after };
  const s = new Script<DriftSim>();
  const plan = new Plan(s, fastTps(p, end, 9));
  plan.say(
    { id: 'intro', about: 'A big, healthy population: {n} {critters} in {k} colours.', maxWords: 14, required: ['n', 'critters', 'k'], fallback: ['Here are {n} {critters} in {k} colours, a big healthy population.', '{n} {critters}, {k} colours, all doing fine.'] },
    facts,
  );
  opening(plan, p, facts, { id: 'guess', about: 'The viewer is asked how many colours will survive what is coming.', maxWords: 10, fallback: ['Something is coming. How many colours survive it?', 'Guess how many colours make it through.'] });
  plan.upTo(CRASH_AT);
  plan.say(
    {
      id: 'crash',
      about: 'A disaster wipes out almost everyone.',
      maxWords: 10,
      required: ['survivors'],
      parts: [
        { about: 'the population suddenly crashes', maxWords: 4 },
        { about: 'only {survivors} individuals are left', maxWords: 6 },
      ],
      fallback: ['Then disaster strikes. | Only {survivors} survive.', 'Suddenly, a catastrophe. | Just {survivors} are left.'],
    },
    facts,
    [1, 1],
  );
  plan.say(
    facts.lost > 1
      ? { id: 'lost', about: '{lost} colours vanished in the crash; {left} are left.', maxWords: 10, required: ['lost'], fallback: ['{lost} colours vanished in an instant.', 'Just like that, {lost} colours are gone.'] }
      : facts.lost === 1
        ? { id: 'lost', about: 'One colour, {colour}, vanished in the crash.', maxWords: 10, required: ['colour'], fallback: ['Just like that, {colour} is gone.', '{colour} vanished in an instant.'] }
        : { id: 'lost', about: 'Every colour somehow made it through the crash.', maxWords: 10, fallback: ['Somehow, every colour made it through.', 'Every colour survived, just barely.'] },
    { ...facts, colour: lostIn(hist, CRASH_AT - 1, Math.min(end, CRASH_AT + 1)).map((c) => sim.colours[c].name).join(' and ') },
    Math.max(0, Math.min(end, regrown) - plan.pos),
  );
  plan.say(
    { id: 'founder', about: 'The population has regrown, but everyone now descends from those few {survivors} survivors.', maxWords: 12, required: ['survivors'], fallback: ['Everyone now descends from just {survivors} survivors.', 'A whole population, rebuilt from {survivors} lucky ones.'] },
    facts,
    Math.min(4, Math.max(0, end - plan.pos - 3)),
  );
  finish(plan, p, sim, m, end, facts, WIN, {
    id: 'lesson',
    about: 'That was a bottleneck: a few lucky survivors decided which colours, which genes, the whole population carries.',
    maxWords: 18,
    fallback: ['That is a bottleneck. A few lucky survivors decide a whole population\'s future.', 'A bottleneck: luck picks the survivors, and their genes are all that is left.'],
  });
  sim.result = `${facts.lost} lost in the crash`;
  return { sim, script: s };
}

function luckyMutant(p: DriftParams, rng: Rng): Built {
  const n = p.popSize;
  const trials: History[] = [];
  let total = 0;
  let fixedTrial = -1;
  // Trials until the mutant takes over (the last one runs to its end even past the limit).
  for (let t = 0; t < 400 && total < p.maxGenerations; t++) {
    const first = new Uint8Array(n).fill(1);
    first[0] = 0;
    const h = grow(rng, { n, k: 2, first, maxGens: 20 * n, parentsUpTo: n <= 64 ? 20 * n : LINE_GENS });
    trials.push(h);
    total += h.rows.length;
    const last = h.counts[h.counts.length - 1];
    if (last[0] === n) {
      fixedTrial = t;
      break;
    }
  }
  const { h: hist, starts } = concat(trials);
  const sim = newSim(p, hist, [MUTANT.mutant, MUTANT.wild]);
  sim.starts = starts;
  sim.showLinesTo = LINE_GENS;
  const end = hist.counts.length - 1;
  const facts = { ...baseFacts(p, n, 2) };
  const s = new Script<DriftSim>();
  const plan = new Plan(s, fastTps(p, end, 9));
  plan.say(
    { id: 'intro', about: '{n} grey {critters}, and one golden mutant among them. Its gene is no better and no worse.', maxWords: 18, required: ['n', 'critters'], fallback: ['Here are {n} grey {critters}, and one golden mutant. It is no better and no worse.', '{n} {critters}. One of them is a golden mutant, but it has no advantage at all.'] },
    facts,
  );
  opening(plan, p, facts, { id: 'guess', about: 'The viewer is asked whether the single mutant will take over the population.', maxWords: 10, fallback: ['Will the mutant take over? Lock in your guess.', 'Can one mutant take over? Comment your guess.'] });
  const firstEnd = (starts[1] ?? hist.rows.length) - 1;
  if (fixedTrial !== 0 && plan.ahead(firstEnd)) {
    plan.upTo(firstEnd);
    plan.say({ id: 'lost1', about: 'The mutant gene has died out, after {g} generations.', maxWords: 10, required: ['g'], fallback: ['Gone, after just {g} generations.', 'And the mutant is lost, generation {g}.'] }, { g: firstEnd - starts[0] }, 1);
    plan.say({ id: 'again', about: 'So the experiment starts over with a fresh mutant, again and again.', maxWords: 8, fallback: ['So we try again. And again.', 'New mutant. Try again.'] }, facts, Math.min(6, Math.max(0, end - plan.pos - 4)));
  }
  if (fixedTrial >= 0) {
    const winStart = starts[fixedTrial];
    if (fixedTrial > 1 && plan.ahead(winStart)) {
      plan.upTo(winStart);
      plan.say({ id: 'try', about: 'Try number {tries} begins, with a new mutant.', maxWords: 7, required: ['tries'], fallback: ['Try number {tries}.', 'Here comes try {tries}.'] }, { tries: fixedTrial + 1 }, 2);
    }
    const win: BeatSpec = { id: 'win', about: 'This time the mutant gene has taken over the whole population, at generation {g} of this try.', maxWords: 12, required: ['g'], fallback: ['This time it takes over everything, at generation {g}!', 'It made it! Generation {g}, and every one is golden.'] };
    const m = { ...milestones(hist), winner: 0, fixedAt: end };
    const lesson: BeatSpec =
      fixedTrial === 0
        ? { id: 'lesson', about: 'The lesson: with {n} individuals, a brand new neutral mutant takes over only about one time in {n}, and this one did it on the very first try.', maxWords: 20, fallback: ['With {n} {critters}, a new mutant wins about one time in {n}. This one did it first time.', 'One chance in {n}, and it won on the very first try.'] }
        : {
            id: 'lesson',
            about: 'The lesson: with {n} individuals, a brand new neutral mutant takes over only about one time in {n}. This took {tries} tries.',
            maxWords: 20,
            required: ['tries'],
            fallback: ['With {n} {critters}, a new mutant wins about one time in {n}. This took {tries} tries.', 'One in {n}: that is the chance. Today it took {tries} tries.'],
          };
    finish(plan, p, sim, m, end, { ...facts, g: end - winStart }, win, lesson);
    // finish() gives the generation counted from the start: the mutant's story counts from its try.
    sim.answer = `TRY #${fixedTrial + 1}`;
    sim.result = 'took over';
    patchFacts(s, 'win', { g: end - winStart });
    patchFacts(s, 'lesson', { tries: fixedTrial + 1 });
  } else {
    plan.upTo(end);
    s.act(reveal);
    s.mark('reveal');
    plan.say({ id: 'never', about: 'After {tries} tries, the mutant never managed to take over.', maxWords: 10, required: ['tries'], fallback: ['After {tries} tries, it never took over.', '{tries} tries, and the mutant always vanished.'] }, { tries: trials.length }, Math.max(0, end - plan.pos));
    plan.say({ id: 'lesson', about: 'With {n} individuals, a new neutral mutant wins only about one time in {n}.', maxWords: 16, fallback: ['With {n} {critters}, a new mutant wins only about one time in {n}.', 'The odds were one in {n}. Most new genes simply vanish.'] }, facts);
    sim.answer = 'NEVER';
    sim.result = 'never took over';
    s.mark('outro');
    s.hold(2.6);
  }
  return { sim, script: s };
}

/** Add facts to a say already in the script (for facts known only once the script is laid out). */
function patchFacts(s: Script<DriftSim>, id: string, extra: Facts) {
  for (const d of s.dirs) {
    if (d.kind === 'say' && d.beat.id === id) {
      const f = d.facts;
      d.facts = (sim) => ({ ...f(sim), ...extra });
    }
  }
}

export function buildDrift(p: DriftParams, rng: Rng): Built {
  switch (p.mode) {
    case 'race':
      return race(p, rng);
    case 'drift-vs-selection':
      return selection(p, rng);
    case 'small-vs-large':
      return smallVsLarge(p, rng);
    case 'bottleneck':
      return bottleneck(p, rng);
    case 'lucky-mutant':
      return luckyMutant(p, rng);
  }
}
