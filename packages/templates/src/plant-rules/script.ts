import type { Rng } from '@sim/engine';
import { Script, type Act, type BeatSpec, type Facts } from '../story';
import { FRACTALS, PLANTS, type PlantParams } from './params';
import { GARDEN, countDraws, presetById, rewrite, shapeOf, type Preset, type Shape } from './lsystem';

/** Ticks a round takes to grow in. */
export const GROW = 100;
/** Ticks the flowers take to open. */
export const BLOOM = 40;

/** One plant: its string and drawn shape after every round. */
export interface Growth {
  strings: string[];
  shapes: Shape[];
}

export interface PlantSim {
  preset: Preset;
  plants: Growth[];
  /** Round on screen, and how far it has grown in (0..GROW). */
  round: number;
  grow: number;
  /** First round with anything to draw. */
  firstRound: number;
  lastRound: number;
  angle: number;
  sweep: { from: number; to: number; ticks: number; done: number } | null;
  bloom: number;
  revealed: boolean;
  answer: string;
}

export interface Built {
  sim: PlantSim;
  script: Script<PlantSim>;
}

/** Rewrite a preset round by round, stopping before the drawing would pass the line budget. */
function growPlant(preset: Preset, rounds: number, maxSegments: number, rng: Rng | null): Growth {
  const strings = [preset.axiom];
  for (let r = 1; r <= rounds; r++) {
    const next = rewrite(strings[r - 1], preset.rules, rng);
    if (countDraws(next, preset.draws) > maxSegments || next.length > maxSegments * 8) break;
    strings.push(next);
  }
  return { strings, shapes: strings.map((s) => shapeOf(s, preset.draws)) };
}

const segs = (sim: PlantSim, round = sim.round) => sim.plants.reduce((a, p) => a + (p.shapes[Math.min(round, p.shapes.length - 1)]?.n ?? 0), 0);

const nextRound: Act<PlantSim> = (sim, emit) => {
  if (sim.round >= sim.lastRound) return;
  sim.round++;
  sim.grow = 0;
  emit({ type: 'plant:round', round: sim.round, segs: segs(sim) });
};

const bloom: Act<PlantSim> = (sim, emit) => {
  sim.revealed = true;
  emit({ type: 'plant:bloom', answer: sim.answer });
};

class Plan {
  constructor(
    readonly s: Script<PlantSim>,
    readonly sim: PlantSim,
    readonly p: PlantParams,
  ) {}

  /** Facts at a round (known up front: the strings are all rewritten before the video plays). */
  at(round: number): Facts {
    return { round, segs: segs(this.sim, round), symbols: this.sim.plants[0].strings[Math.min(round, this.sim.plants[0].strings.length - 1)].length };
  }
}

const tps = (p: PlantParams, rounds: number) => Math.max(40, Math.min(160, (GROW * rounds) / Math.max(4, p.targetS * 0.25)));

/** A round of growth with no line of its own (the elastic middle). */
function quietRound(plan: Plan, rate: number) {
  plan.s.act(nextRound);
  plan.s.play(GROW, rate, { elastic: true });
}

/** The opening of the rule-growing modes: the start shape, then the first rewrite (one sentence each). */
function firstRounds(plan: Plan, sim: PlantSim, swap: string) {
  const r0 = sim.firstRound;
  const one = segs(sim, r0) === 1;
  plan.s.act((s) => {
    s.round = r0;
    s.grow = 0;
  });
  plan.s.say(
    {
      id: 'start',
      about: 'The starting shape grows in, then the rule is applied for the first time.',
      maxWords: 18,
      parts: [
        { about: `the starting shape appears: ${one ? 'a single line' : '{segs} lines'}`, maxWords: 7 },
        { about: 'every line is swapped for the small branching pattern the rule describes', maxWords: 11 },
      ],
      fallback: one ? [`Start with a single line. | ${swap}`, `First, one line. | ${swap}`] : [`Start simple: just {segs} lines. | ${swap}`, `It starts as {segs} lines. | ${swap}`],
      ...(one ? {} : { required: ['segs'] }),
    },
    { facts: () => plan.at(r0), ticks: [GROW, GROW], acts: [null, nextRound] },
  );
}

function rewriteMode(p: PlantParams, rng: Rng): Built {
  const id = p.preset === 'random' ? rng.pick(PLANTS) : p.preset;
  const preset = presetById(id);
  const growth = growPlant(preset, p.rounds || preset.rounds, p.maxSegments, null);
  const sim = newSim(preset, [growth], p.angle || preset.angle);
  const s = new Script<PlantSim>();
  const plan = new Plan(s, sim, p);
  const rate = tps(p, sim.lastRound);
  s.say(
    { id: 'intro', about: 'A {name} is about to grow from one tiny rewriting rule, shown at the top of the screen.', maxWords: 13, required: ['name'], fallback: ['This {name} grows from one tiny rule. Watch.', 'One small rule. That is all this {name} needs.'] },
    { facts: () => ({ name: preset.name }) },
  );
  if (p.guess) s.say({ id: 'guess', about: 'The viewer is asked to guess what the rule will look like after {rounds} rounds.', maxWords: 11, required: ['rounds'], fallback: ['What will it look like after {rounds} rounds? Guess now.', 'Guess what {rounds} rounds of this rule make.'] }, { facts: () => ({ rounds: sim.lastRound }) });
  firstRounds(plan, sim, 'Then swap every line for this little branch.');
  storyRounds(plan, sim, rate, {
    again: { about: 'The rule is applied again: every line becomes a small branch.', fallback: ['Do it again. Every line becomes a branch.', 'And again: each line turns into a branch.'] },
    count: { about: 'Round {round}: the plant now has {segs} lines.', fallback: ['Round {round}: already {segs} lines.', 'By round {round}, {segs} lines.'] },
    last: { about: 'The final round, {round}: {segs} lines in all, every one placed by the same rule.', fallback: ['Round {round}. {segs} lines, all from one rule.', 'Round {round}: {segs} lines, and still one rule.'] },
  });
  sim.answer = preset.name.toUpperCase();
  s.act(bloom);
  s.mark('reveal');
  s.say(
    {
      id: 'lesson',
      about: 'The history: in {year} the biologist Aristid Lindenmayer invented these rewriting rules to describe how real plants grow.',
      maxWords: 18,
      required: ['year'],
      fallback: ['In {year}, biologist Aristid Lindenmayer invented these rules to describe how plants grow.', 'A biologist, Aristid Lindenmayer, came up with these rules in {year}, to model real plants.'],
    },
    { facts: () => ({ year: '1968' }), ticks: BLOOM },
  );
  s.mark('outro');
  s.hold(2.6);
  return { sim, script: s };
}

/** The rounds after the first: two narrated, the middle ones quiet, the last one narrated. */
function storyRounds(plan: Plan, sim: PlantSim, rate: number, lines: Record<'again' | 'count' | 'last', { about: string; fallback: string[] }>) {
  const s = plan.s;
  let r = sim.firstRound + 1;
  const last = sim.lastRound;
  if (r < last) {
    const at = r + 1;
    s.say({ id: 'again', maxWords: 10, ...lines.again }, { facts: () => plan.at(at), ticks: GROW, acts: [nextRound] });
    r++;
  }
  if (r < last) {
    const at = r + 1;
    s.say({ id: 'count', maxWords: 10, required: ['round', 'segs'], ...lines.count }, { facts: () => plan.at(at), ticks: GROW, acts: [nextRound] });
    r++;
  }
  while (r < last - 1) {
    quietRound(plan, rate);
    r++;
  }
  if (r < last) {
    s.say({ id: 'last', maxWords: 12, required: ['round', 'segs'], ...lines.last }, { facts: () => plan.at(last), ticks: GROW, acts: [nextRound] });
    r++;
  }
}

function newSim(preset: Preset, plants: Growth[], angle: number): PlantSim {
  const firstRound = Math.max(0, plants[0].shapes.findIndex((sh) => sh.n > 0));
  const lastRound = Math.min(...plants.map((g) => g.shapes.length - 1));
  return { preset, plants, round: firstRound, grow: 0, firstRound, lastRound, angle, sweep: null, bloom: 0, revealed: false, answer: '' };
}

function sweepMode(p: PlantParams, rng: Rng): Built {
  const id = p.preset === 'random' ? rng.pick(PLANTS) : p.preset;
  const preset = presetById(id);
  const growth = growPlant(preset, p.rounds || Math.max(3, preset.rounds - 1), p.maxSegments, null);
  const from = Math.round(p.sweepFrom);
  const to = Math.round(Math.max(p.sweepFrom + 5, p.sweepTo));
  const sim = newSim(preset, [growth], from);
  const s = new Script<PlantSim>();
  const SWEEP = 600;
  s.act((sim) => {
    sim.round = sim.lastRound;
    sim.grow = 0;
  });
  s.say(
    { id: 'intro', about: 'One rule, grown {rounds} rounds, appears on screen as a {name}.', maxWords: 12, required: ['rounds'], fallback: ['Here is one rule, grown {rounds} rounds.', 'One rule, {rounds} rounds of growth.'] },
    { facts: () => ({ rounds: sim.lastRound, name: preset.name }), ticks: GROW },
  );
  s.say(
    { id: 'change', about: 'Now only one number will change: the angle each branch turns by, currently {a} degrees.', maxWords: 14, required: ['a'], fallback: ['Now we change just one number: the angle. It is {a} degrees.', 'Only one thing changes now: the branch angle, {a} degrees.'] },
    { facts: () => ({ a: from }) },
  );
  if (p.guess) s.say({ id: 'guess', about: 'The viewer is asked to guess which angle will look most like a real plant.', maxWords: 10, fallback: ['Which angle looks most real? Guess now.', 'Guess the angle that looks most alive.'] });
  s.act((sim) => (sim.sweep = { from, to, ticks: SWEEP, done: 0 }));
  const angleAt = (k: number) => Math.round(from + ((to - from) * k) / SWEEP);
  s.play(SWEEP / 2, 60, { elastic: true });
  s.say({ id: 'mid', about: 'At {a} degrees, the same rule draws a noticeably different plant.', maxWords: 10, required: ['a'], fallback: ['At {a} degrees, a different plant.', '{a} degrees, and it changes shape.'] }, { facts: () => ({ a: angleAt(SWEEP / 2) }), ticks: 60 });
  s.play(SWEEP / 2 - 60, 60, { elastic: true });
  sim.answer = `${from}° → ${to}°`;
  s.act(bloom);
  s.mark('reveal');
  s.say({ id: 'end', about: 'At {a} degrees the rule makes a completely different species of plant.', maxWords: 11, required: ['a'], fallback: ['{a} degrees: a whole new species.', 'And at {a} degrees, a new plant entirely.'] }, { facts: () => ({ a: to }), ticks: BLOOM });
  s.say({ id: 'lesson', about: 'The lesson: change one number in a growth rule and the whole plant changes; small genetic tweaks reshape real plants the same way.', maxWords: 18, fallback: ['One number, a whole new plant. Small genetic tweaks reshape real plants the same way.', 'Tiny changes to a growth rule, and you get a different plant. Genes work like that too.'] });
  s.mark('outro');
  s.hold(2.6);
  return { sim, script: s };
}

function gardenMode(p: PlantParams, rng: Rng): Built {
  const preset = GARDEN;
  const rounds = p.rounds || preset.rounds;
  const plants: Growth[] = [];
  const budget = Math.floor(p.maxSegments / p.plants);
  for (let k = 0; k < p.plants; k++) plants.push(growPlant(preset, rounds, budget, rng));
  const sim = newSim(preset, plants, p.angle || preset.angle);
  const s = new Script<PlantSim>();
  const plan = new Plan(s, sim, p);
  const rate = tps(p, sim.lastRound);
  s.say({ id: 'intro', about: '{plants} seedlings sit side by side; they all follow exactly the same growth rules.', maxWords: 12, required: ['plants'], fallback: ['These {plants} plants all follow the same rules.', '{plants} seedlings. Exactly the same rules for each.'] }, { facts: () => ({ plants: p.plants }) });
  if (p.guess) s.say({ id: 'guess', about: 'The viewer is asked whether the plants will all come out looking the same.', maxWords: 10, fallback: ['Will they all look the same? Guess now.', 'Same rules. Same plants? Guess.'] });
  s.act((s) => {
    s.round = s.firstRound;
    s.grow = 0;
  });
  s.say(
    {
      id: 'rule',
      about: 'How the rules work.',
      maxWords: 20,
      parts: [
        { about: 'every line is replaced by a small branch', maxWords: 8 },
        { about: 'but each branch picks one of three shapes at random, like rolling a dice', maxWords: 12 },
      ],
      fallback: ['Every line becomes a branch. | But each one rolls a dice to pick its shape.', 'Each round, lines turn into branches. | Which branch? A random pick, every time.'],
    },
    { ticks: [GROW, GROW], acts: [null, nextRound] },
  );
  let r = sim.firstRound + 1;
  while (r < sim.lastRound - 1) {
    quietRound(plan, rate);
    r++;
  }
  if (r < sim.lastRound) {
    s.say({ id: 'last', about: 'Round {round}: the plants are clearly different from each other.', maxWords: 10, required: ['round'], fallback: ['Round {round}, and look how different they are.', 'By round {round}, no two are alike.'] }, { facts: () => plan.at(sim.lastRound), ticks: GROW, acts: [nextRound] });
  }
  sim.answer = 'ALL UNIQUE';
  s.act(bloom);
  s.mark('reveal');
  s.say({ id: 'lesson', about: 'The lesson: simple rules plus a little chance give endless variety, which is why no two real trees are the same.', maxWords: 18, fallback: ['Simple rules plus a little chance: endless variety. That is why no two trees match.', 'Add a dash of chance to simple rules, and every plant comes out unique.'] }, { ticks: BLOOM });
  s.mark('outro');
  s.hold(2.6);
  return { sim, script: s };
}

const FRACTAL_LESSONS: Record<(typeof FRACTALS)[number], { about: string; fallback: string[] }> = {
  dragon: { about: 'A fact about the dragon curve: folding a strip of paper in half again and again makes the same shape.', fallback: ['Fold a strip of paper in half, again and again, and you get this same dragon.', 'Keep folding a paper strip in half and unfold it: the same dragon appears.'] },
  koch: { about: 'A fact about the Koch snowflake: its edge gets longer every round, forever, yet it encloses a finite area.', fallback: ['Its edge grows longer every round, forever, around a space that never grows much.', 'An infinitely long edge, wrapped around a finite area.'] },
  sierpinski: { about: 'A fact about the Sierpinski triangle: triangles inside triangles forever, all drawn as one continuous line.', fallback: ['Triangles inside triangles, forever, and all of it one single line.', 'One line, folding into triangles within triangles.'] },
  hilbert: { about: 'A fact about the Hilbert curve: one line that eventually passes through every point of the square without ever crossing itself.', fallback: ['One line that visits every point of the square, never crossing itself.', 'Keep going forever and this single line fills the whole square.'] },
};

function fractalMode(p: PlantParams, rng: Rng): Built {
  const id = p.fractal === 'random' ? rng.pick(FRACTALS) : p.fractal;
  const preset = presetById(id);
  const growth = growPlant(preset, p.rounds || preset.rounds, p.maxSegments, null);
  const sim = newSim(preset, [growth], preset.angle);
  const s = new Script<PlantSim>();
  const plan = new Plan(s, sim, p);
  const rate = tps(p, sim.lastRound);
  s.say({ id: 'intro', about: 'This rewriting rule does not grow a plant; something else is coming.', maxWords: 10, fallback: ['This rule does not grow a plant. Watch.', 'No plant this time. Just a rule. Watch.'] });
  if (p.guess) s.say({ id: 'guess', about: 'The viewer is asked to guess what shape the rule will make.', maxWords: 9, fallback: ['What shape will it make? Guess now.', 'Guess the shape before it appears.'] });
  firstRounds(plan, sim, "Now swap every line for the rule's pattern.");
  storyRounds(plan, sim, rate, {
    again: { about: 'The rule is applied again; the shape gets more detailed.', fallback: ['And again. More detail every time.', 'Do it again, and the pattern repeats inside itself.'] },
    count: { about: 'Round {round}: {segs} lines now.', fallback: ['Round {round}: {segs} lines.', 'By round {round}, {segs} lines.'] },
    last: { about: 'Round {round}: the shape is revealed as the {name}.', fallback: ['Round {round}: the {name}.', 'After {round} rounds: the {name}.'] },
  });
  patchName(s, preset.name);
  sim.answer = preset.name.toUpperCase();
  s.act(bloom);
  s.mark('reveal');
  s.say({ id: 'lesson', maxWords: 16, ...FRACTAL_LESSONS[id as (typeof FRACTALS)[number]] }, { ticks: BLOOM });
  s.mark('outro');
  s.hold(2.6);
  return { sim, script: s };
}

/** The last round's line names the fractal. */
function patchName(s: Script<PlantSim>, name: string) {
  for (const d of s.dirs) {
    if (d.kind === 'say' && d.beat.id === 'last') {
      const f = d.facts;
      d.facts = (sim) => ({ ...f(sim), name });
      d.beat = { ...d.beat, required: ['round', 'name'] };
    }
  }
}

export function buildPlant(p: PlantParams, rng: Rng): Built {
  switch (p.mode) {
    case 'rewrite':
      return rewriteMode(p, rng);
    case 'angle-sweep':
      return sweepMode(p, rng);
    case 'garden':
      return gardenMode(p, rng);
    case 'fractals':
      return fractalMode(p, rng);
  }
}
