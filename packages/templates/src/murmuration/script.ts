import type { Rng } from '@sim/engine';
import { Script, estimateS, type Act, type BeatSpec, type Facts } from '../story';
import { addPredator, newFlock, order, startle, stepFlock, type Flock, type Rules } from './sim';
import type { FlockParams } from './params';

/** Ticks per second at real speed. */
export const TPS = 60;

export interface FlockSim {
  flock: Flock;
  /** Bird the picture follows (seven neighbours), or −1. */
  focus: number;
  /** Birds that swerved first (for the picture). */
  startled: number;
  revealed: boolean;
  answer: string;
  /** Rules shown as switched off (the guess hides which one until the reveal). */
  hidden: keyof Rules | null;
  fish: boolean;
}

export interface Built {
  sim: FlockSim;
  script: Script<FlockSim>;
}

const nouns = (fish: boolean) =>
  fish ? { animals: 'fish', animal: 'fish', group: 'school', predator: 'shark' } : { animals: 'starlings', animal: 'bird', group: 'murmuration', predator: 'falcon' };

/** A line with the flock flying on at about real speed while it's said. */
function sayFlying(s: Script<FlockSim>, beat: BeatSpec, facts: (sim: FlockSim) => Facts = () => ({}), acts?: (Act<FlockSim> | null)[], speed = 1) {
  const parts = beat.parts?.map((p) => Math.round(estimateS(p.maxWords) * TPS * speed));
  const ticks = parts ?? Math.round(estimateS(beat.maxWords) * TPS * speed);
  s.say(beat, { facts, ticks, acts });
}

const rule =
  (k: keyof Rules, on: boolean): Act<FlockSim> =>
  (sim, emit) => {
    sim.flock.rules[k] = on;
    emit({ type: 'flock:rule', rule: k, on });
  };

const percent = (sim: FlockSim) => Math.round(order(sim.flock) * 100);

function opts(p: FlockParams) {
  return { n: p.count, separation: p.separation, alignment: p.alignment, cohesion: p.cohesion, radius: p.radius, neighbours: p.neighbours, speed: p.speed, agility: p.agility };
}

/** Fly a flock with all its rules for a while before the video starts, so it opens as a flock. */
function prewarm(f: Flock, ticks: number) {
  f.rules = { separation: true, alignment: true, cohesion: true };
  for (let k = 0; k < ticks; k++) stepFlock(f);
}

const LESSON = (fish: boolean): BeatSpec => ({
  id: 'lesson',
  about: `The lesson: each ${fish ? 'fish' : 'bird'} reacts to only a handful of neighbours, about seven, and the shape of the whole ${fish ? 'school' : 'flock'} emerges from that, with no leader.`,
  maxWords: 18,
  fallback: [`Each one only watches about seven neighbours. The whole ${fish ? 'school' : 'flock'} emerges from that.`, 'No leader, no plan. Just neighbours watching neighbours.'],
});

function threeRules(p: FlockParams, rng: Rng): Built {
  const fish = p.mode === 'school';
  const w = nouns(fish);
  const flock = newFlock(rng, opts(p), true);
  const sim: FlockSim = { flock, focus: -1, startled: -1, revealed: false, answer: '3 RULES', hidden: null, fish };
  const s = new Script<FlockSim>();
  sayFlying(s, { id: 'intro', about: '{n} {animals} fly around at random; right now each one ignores all the others.', maxWords: 14, required: ['n', 'animals'], fallback: ['These are {n} {animals}. Right now, each one ignores the others.', '{n} {animals}, all doing their own thing.'] }, () => ({ n: p.count, ...w }));
  if (p.guess) sayFlying(s, { id: 'guess', about: 'The viewer is asked whether three simple rules can turn this chaos into a {group}.', maxWords: 11, required: ['group'], fallback: ['Can three simple rules turn this into a {group}?', 'Three rules. Enough for a {group}? Guess.'] }, () => w);
  sayFlying(
    s,
    {
      id: 'rules',
      about: 'The three rules are switched on one at a time.',
      maxWords: 21,
      parts: [
        { about: 'rule one switches on: separation, do not crowd or bump into your neighbours', maxWords: 7 },
        { about: 'rule two switches on: alignment, fly the same way your neighbours fly', maxWords: 7 },
        { about: 'rule three switches on: cohesion, stay close to your neighbours', maxWords: 7 },
      ],
      fallback: ["Rule one: don't bump into your neighbours. | Rule two: fly the way they fly. | Rule three: stay close to them.", 'One: keep your distance. | Two: match their direction. | Three: stay near them.'],
    },
    () => ({}),
    [rule('separation', true), rule('alignment', true), rule('cohesion', true)],
    1.4,
  );
  s.play(360, TPS, { elastic: true });
  s.mark('reveal');
  s.act((sim) => (sim.revealed = true));
  sayFlying(s, { id: 'order', about: 'The {group} has formed: {order} percent of them now point the same way, and nobody is leading.', maxWords: 15, required: ['order'], fallback: ['Now {order} percent of them fly the same way. Nobody is in charge.', 'A {group}. {order} percent aligned, and no leader at all.'] }, (sim) => ({ order: percent(sim), ...w }));
  if (p.predators > 0) {
    sayFlying(
      s,
      { id: 'attack', about: 'A {predator} dives into the {group}.', maxWords: 8, required: ['predator'], fallback: ['Then a {predator} attacks.', 'Here comes a {predator}.'] },
      () => w,
      [
        (sim, emit) => {
          for (let k = 0; k < p.predators; k++) addPredator(sim.flock, sim.fish);
          emit({ type: 'flock:predator', n: p.predators });
        },
      ],
    );
    s.play(240, TPS, { elastic: true });
    sayFlying(s, { id: 'split', about: 'The {group} tears open around the {predator} to escape, then flows back together again.', maxWords: 13, fallback: ['It tears open around the {predator}, then closes up again.', 'The {group} splits, dodges, and finds itself again.'] }, () => w);
    s.play(240, TPS, { elastic: true });
  }
  sayFlying(s, LESSON(fish));
  s.mark('outro');
  s.play(150, TPS);
  return { sim, script: s };
}

const EFFECTS: Record<keyof Rules, { name: string; fallback: string[]; about: string }> = {
  separation: { name: 'separation', about: 'The answer: separation was switched off, so the birds crush together into tight clumps.', fallback: ['It was separation. Without it, they crush into tight clumps.', 'Separation. With nothing keeping them apart, they pile together.'] },
  alignment: { name: 'alignment', about: 'The answer: alignment was switched off, so they stay together but mill about like a swarm of gnats.', fallback: ['It was alignment. Without it, they swarm like gnats.', 'Alignment. They stay close, but nobody flies the same way.'] },
  cohesion: { name: 'cohesion', about: 'The answer: cohesion was switched off, so the flock slowly drifts apart into small bands.', fallback: ['It was cohesion. Without it, the flock drifts apart.', 'Cohesion. Nothing holds them together, so they spread out.'] },
};

function removeOne(p: FlockParams, rng: Rng): Built {
  const flock = newFlock(rng, opts(p), false);
  prewarm(flock, 420);
  const gone: keyof Rules = p.removed === 'random' ? rng.pick(['separation', 'alignment', 'cohesion'] as const) : p.removed;
  const sim: FlockSim = { flock, focus: -1, startled: -1, revealed: false, answer: EFFECTS[gone].name.toUpperCase(), hidden: null, fish: false };
  const s = new Script<FlockSim>();
  sayFlying(s, { id: 'intro', about: '{n} starlings flying by three rules: keep apart, fly the same way, stay close.', maxWords: 15, required: ['n'], fallback: ['{n} starlings, three rules: keep apart, fly together, stay close.', 'Three rules keep these {n} starlings together.'] }, () => ({ n: p.count }));
  sayFlying(s, { id: 'guess', about: 'One of the three rules is about to be secretly switched off; the viewer should watch and guess which.', maxWords: 12, fallback: ['Now one rule switches off. Watch, and guess which.', "We'll switch one off. Which one? Guess."] }, () => ({}), [(sim, emit) => {
    sim.hidden = gone;
    rule(gone, false)(sim, emit);
  }]);
  s.play(480, TPS, { elastic: true });
  if (p.guess) sayFlying(s, { id: 'tell', about: 'Something has clearly changed in how they fly; the viewer is asked to lock in a guess.', maxWords: 10, fallback: ['See the difference? Lock in your guess.', 'Something changed. Which rule is gone?'] });
  s.mark('reveal');
  s.act((sim) => (sim.revealed = true));
  sayFlying(s, { id: 'reveal', maxWords: 12, ...EFFECTS[gone] });
  sayFlying(s, { id: 'back', about: 'The missing rule is switched back on and the murmuration re-forms.', maxWords: 10, fallback: ['Switch it back on, and the murmuration returns.', 'Turn it back on: the flock comes back.'] }, () => ({}), [(sim, emit) => {
    sim.hidden = null;
    rule(gone, true)(sim, emit);
  }], 1.6);
  s.play(240, TPS, { elastic: true });
  sayFlying(s, LESSON(false));
  s.mark('outro');
  s.play(150, TPS);
  return { sim, script: s };
}

function sevenNeighbours(p: FlockParams, rng: Rng): Built {
  const flock = newFlock(rng, { ...opts(p), neighbours: p.neighbours || 7 }, false);
  prewarm(flock, 420);
  const sim: FlockSim = { flock, focus: 0, startled: -1, revealed: false, answer: 'ABOUT 7', hidden: null, fish: false };
  const s = new Script<FlockSim>();
  const k = p.neighbours || 7;
  sayFlying(s, { id: 'intro', about: 'One starling is highlighted, with lines to the {k} birds it watches; each of the {n} birds watches just {k} others.', maxWords: 14, required: ['k'], fallback: ['Each of these {n} starlings watches just {k} others.', 'See this bird? It only watches these {k}.'] }, () => ({ n: p.count, k }));
  sayFlying(s, { id: 'detail', about: 'It is always the {k} nearest, however near or far they are, not everyone in sight.', maxWords: 12, required: ['k'], fallback: ['Not everyone in sight. Always the nearest {k}, near or far.', 'Always {k}, however spread out they are.'] }, () => ({ k }));
  if (p.guess) sayFlying(s, { id: 'guess', about: 'The viewer is asked to guess how quickly one bird’s turn could spread through all {n} birds.', maxWords: 12, required: ['n'], fallback: ['So how fast can one turn spread through {n} birds?', 'One bird turns. How fast does the news spread?'] }, () => ({ n: p.count }));
  s.mark('reveal');
  sayFlying(
    s,
    {
      id: 'ripple',
      about: 'A turn spreads through the flock.',
      maxWords: 16,
      parts: [
        { about: 'one bird at the edge suddenly swerves', maxWords: 5 },
        { about: 'the turn ripples across the whole flock in a wave, neighbour to neighbour', maxWords: 11 },
      ],
      fallback: ['One bird swerves. | And the turn ripples through the whole flock.', 'A single bird turns. | Neighbour to neighbour, the whole flock follows.'],
    },
    () => ({}),
    [
      (sim, emit) => {
        sim.startled = startle(sim.flock);
        sim.revealed = true;
        emit({ type: 'flock:startle', bird: sim.startled });
      },
      null,
    ],
    0.8,
  );
  s.play(300, TPS, { elastic: true });
  sayFlying(s, { id: 'lesson', about: 'The science: researchers filmed real starlings over Rome and found each bird tracks about seven neighbours, which keeps the flock together however it stretches.', maxWords: 20, fallback: ['Scientists filmed real starlings over Rome and found exactly this: about seven neighbours each.', 'Real starlings over Rome were tracked bird by bird. Each one watched about seven others.'] });
  s.mark('outro');
  s.play(150, TPS);
  return { sim, script: s };
}

export function buildFlock(p: FlockParams, rng: Rng): Built {
  switch (p.mode) {
    case 'three-rules':
    case 'school':
      return threeRules(p, rng);
    case 'remove-one':
      return removeOne(p, rng);
    case 'seven-neighbours':
      return sevenNeighbours(p, rng);
  }
}
