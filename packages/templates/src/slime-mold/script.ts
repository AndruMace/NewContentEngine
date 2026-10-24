import * as dm from '@sim/physics/math';
import type { Rng } from '@sim/engine';
import { Script, estimateS, type Act, type BeatSpec, type Facts } from '../story';
import { N, addScents, coverage, dishWalls, mazeWalls, newMold, seedAgents, spanningTree, type Food, type Mold } from './sim';
import type { MoldParams } from './params';

/** Ticks per second at the nominal (time-lapse) speed. */
export const TPS = 80;

export interface MoldSim {
  mold: Mold;
  /** Revealed overlay: the maze's one path, or the shortest network over the food. */
  route: [number, number][][];
  showRoute: boolean;
  /** Largest coverage seen (foraging: how far it spread before pulling back). */
  peak: number;
  answer: string;
}

export interface Built {
  sim: MoldSim;
  script: Script<MoldSim>;
}

const found = (sim: MoldSim) => sim.mold.food.filter((f) => !f.start && f.reached >= 0).length;
const total = (sim: MoldSim) => sim.mold.food.filter((f) => !f.start).length;

/** A line with the mold growing on at about its usual pace while it's said. */
function sayGrowing(s: Script<MoldSim>, beat: BeatSpec, facts: (sim: MoldSim) => Facts = () => ({}), acts?: (Act<MoldSim> | null)[], speed = 1) {
  const parts = beat.parts?.map((p) => Math.round(estimateS(p.maxWords) * TPS * speed));
  s.say(beat, { facts, ticks: parts ?? Math.round(estimateS(beat.maxWords) * TPS * speed), acts });
}

function opts(p: MoldParams, respawn: number) {
  return { agents: p.agents, sensorAngle: p.sensorAngle, sensorDistance: p.sensorDistance, turn: p.turn, keep: p.keep, spread: p.spread, respawn };
}

const showRoute: Act<MoldSim> = (sim, emit) => {
  sim.showRoute = true;
  emit({ type: 'mold:route', found: found(sim) });
};

const INTRO: BeatSpec = {
  id: 'intro',
  about: 'A yellow slime mold sits in a petri dish: it is a single giant cell, with no brain and no nerves.',
  maxWords: 14,
  fallback: ['This yellow blob is a slime mold: one single cell, with no brain.', 'Meet a slime mold. One cell. No brain at all.'],
};

/** Oat flakes scattered over the dish, not too close to the middle or each other. */
function scatterFood(rng: Rng, n: number, minR: number): Food[] {
  const food: Food[] = [{ x: N / 2, y: N / 2, reached: 0, start: true, placed: true }];
  for (let tries = 0; food.length < n + 1 && tries < 2000; tries++) {
    const a = rng.next() * Math.PI * 2;
    const r = minR + rng.next() * (N * 0.42 - minR);
    const x = N / 2 + r * dm.cos(a);
    const y = N / 2 + r * dm.sin(a);
    if (food.every((f) => dm.hypot(f.x - x, f.y - y) > 34)) food.push({ x, y, reached: -1, start: false, placed: true });
  }
  return food;
}

/**
 * Cities around Tokyo, roughly where they sit (after the 2010 experiment's map, hand-placed, not
 * surveyed), on the dish: Tokyo at the start, the bay blocked off below it.
 */
const KANTO: [number, number][] = [
  [0.5, 0.5],
  [0.44, 0.62], [0.4, 0.69], [0.47, 0.56], [0.36, 0.52], [0.3, 0.46], [0.42, 0.4], [0.5, 0.33], [0.6, 0.38],
  [0.66, 0.46], [0.7, 0.55], [0.63, 0.62], [0.24, 0.6], [0.33, 0.33], [0.56, 0.24], [0.76, 0.36], [0.2, 0.42], [0.72, 0.68],
];

function tokyoDish(): { wall: Uint8Array; food: Food[] } {
  const wall = dishWalls();
  // Tokyo Bay: an oval below and right of the city.
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = (x / N - 0.55) / 0.09;
      const dy = (y / N - 0.72) / 0.12;
      if (dx * dx + dy * dy < 1) wall[y * N + x] = 1;
    }
  const food = KANTO.map(([x, y], k) => ({ x: x * N, y: y * N, reached: k === 0 ? 0 : -1, start: k === 0, placed: true }));
  return { wall, food };
}

function network(p: MoldParams, rng: Rng, tokyo: boolean): Built {
  const dish = tokyo ? tokyoDish() : { wall: dishWalls(), food: scatterFood(rng, p.food, 40) };
  const mold = newMold(opts(p, 0.0015), dish.wall, dish.food, rng);
  seedAgents(mold, N / 2, N / 2, 10);
  const tree = spanningTree(dish.food).map(([a, b]) => [
    [dish.food[a].x, dish.food[a].y],
    [dish.food[b].x, dish.food[b].y],
  ] as [number, number][]);
  const sim: MoldSim = { mold, route: tree, showRoute: false, peak: 0, answer: 'CONNECTED' };
  const s = new Script<MoldSim>();
  const n = dish.food.length - 1;
  // The opening lines barely move it: the search starts as the narration says so.
  sayGrowing(s, tokyo ? { ...INTRO, id: 'intro', about: 'A slime mold, a single cell with no brain, starts in the middle; oat flakes sit where the cities around Tokyo are.', fallback: ['A slime mold, one cell with no brain. The oat flakes sit where cities around Tokyo are.', 'One brainless cell, and oat flakes placed like the towns around Tokyo.'], maxWords: 18 } : INTRO, undefined, undefined, 0.03);
  if (p.guess) sayGrowing(s, { id: 'guess', about: 'The viewer is asked whether the slime mold can connect all {n} oat flakes efficiently.', maxWords: 11, required: ['n'], fallback: ['Can it connect all {n} oat flakes efficiently? Guess.', '{n} flakes of food. Can a brainless cell link them?'] }, () => ({ n }), undefined, 0.03);
  sayGrowing(
    s,
    {
      id: 'explore',
      about: 'The slime mold explores.',
      maxWords: 15,
      parts: [
        { about: 'it spreads out across the dish, searching', maxWords: 6 },
        { about: 'tubes grow thicker wherever it finds food', maxWords: 9 },
      ],
      fallback: ['It spreads out, searching. | Wherever it finds food, its tubes grow thicker.', 'First it explores. | Then the tubes that lead to food thicken.'],
    },
    () => ({}),
  );
  // The search is shown sped up (it's the slow part of a real slime mold's day, too).
  s.until((sim) => found(sim) >= Math.ceil(n / 2), { tps: TPS * 1.5, maxTicks: 1400, estTicks: 500 });
  sayGrowing(s, { id: 'half', about: '{found} of the {n} oat flakes have been found so far.', maxWords: 10, required: ['found', 'n'], fallback: ['{found} of the {n} flakes found.', 'Already {found} of {n}.'] }, (sim) => ({ found: found(sim), n: total(sim) }));
  s.until((sim) => found(sim) >= n, { tps: TPS * 2.2, maxTicks: 1300, estTicks: 700 });
  sayGrowing(s, { id: 'all', about: 'The slime mold has now reached {found} of the {n} oat flakes and links them with tubes.', maxWords: 11, required: ['found', 'n'], fallback: ['{found} of {n} flakes, all linked up.', 'Now it has reached {found} of the {n}.'] }, (sim) => ({ found: found(sim), n: total(sim) }));
  s.play(420, TPS, { elastic: true });
  s.mark('reveal');
  if (p.overlay)
    sayGrowing(
      s,
      { id: 'compare', about: 'A white overlay shows the shortest possible network linking all the food; the slime mold adds extra loops, so one broken tube does not cut anything off.', maxWords: 20, fallback: ['In white: the shortest possible network. The slime adds loops, so one broken tube cuts nothing off.', 'White is the shortest network. The slime keeps a few extra loops, as backup.'] },
      () => ({}),
      [showRoute],
    );
  else s.act(showRoute);
  sayGrowing(
    s,
    tokyo
      ? { id: 'lesson', about: 'The history: in {year} scientists in Japan did exactly this, and the slime mold grew a network much like the real railway around Tokyo.', maxWords: 18, required: ['year'], fallback: ['In {year}, scientists did exactly this. The slime grew a network much like Tokyo\'s real railways.', 'Japanese scientists tried this in {year}. The result looked like the Tokyo rail map.'] }
      : { id: 'lesson', about: 'The history: in {year} scientists placed oat flakes like the cities around Tokyo, and a slime mold grew a network much like the real railway.', maxWords: 20, required: ['year'], fallback: ['In {year}, scientists placed oats like the cities around Tokyo. The slime grew a network like the railway.', 'Scientists once laid oats out like Tokyo\'s cities, in {year}. The slime rebuilt the rail map.'] },
    () => ({ year: '2010' }),
  );
  s.mark('outro');
  s.play(140, TPS);
  return { sim, script: s };
}

function maze(p: MoldParams, rng: Rng): Built {
  const mz = mazeWalls(rng, p.mazeSize);
  const food: Food[] = [
    { x: mz.entrance[0], y: mz.entrance[1], reached: 0, start: true, placed: false },
    { x: mz.exit[0], y: mz.exit[1], reached: 0, start: false, placed: false },
  ];
  const mold = newMold(opts(p, 0), mz.wall, food, rng);
  addScents(mold);
  seedAgents(mold, 0, 0, Infinity);
  const sim: MoldSim = { mold, route: [mz.path], showRoute: false, peak: 0, answer: 'SOLVED' };
  const s = new Script<MoldSim>();
  sayGrowing(s, { id: 'intro', about: 'A slime mold, a single cell with no brain, has spread into every corridor of a maze.', maxWords: 14, fallback: ['A slime mold has filled every corridor of this maze. One cell, no brain.', 'One brainless cell, spread through an entire maze.'] });
  if (p.guess) sayGrowing(s, { id: 'guess', about: 'The viewer is asked whether the slime mold can find the shortest way through the maze.', maxWords: 10, fallback: ['Can it find the shortest way through? Guess.', 'Can it solve the maze? Lock in your guess.'] });
  sayGrowing(
    s,
    {
      id: 'food',
      about: 'Food is placed at both ends of the maze.',
      maxWords: 10,
      parts: [
        { about: 'an oat flake is placed at the entrance', maxWords: 5 },
        { about: 'and another at the exit', maxWords: 5 },
      ],
      fallback: ['Food at the entrance, | and food at the exit.', 'Put an oat flake here, | and another one there.'],
    },
    () => ({}),
    [
      (sim, emit) => {
        sim.mold.food[0].placed = true;
        emit({ type: 'mold:food', k: 0 });
      },
      (sim, emit) => {
        sim.mold.food[1].placed = true;
        emit({ type: 'mold:food', k: 1 });
      },
    ],
  );
  s.play(1100, TPS, { elastic: true });
  sayGrowing(s, { id: 'prune', about: 'The dead ends dry up; only the tube between the two food sources survives.', maxWords: 12, fallback: ['The dead ends dry up. Only the path between the food survives.', 'Everything that leads nowhere fades away.'] });
  s.play(240, TPS, { elastic: true });
  s.mark('reveal');
  sayGrowing(s, { id: 'route', about: 'A white line shows the shortest path through the maze: the slime mold found it.', maxWords: 10, fallback: ['The shortest path, in white. It found it.', 'There is the shortest route. Solved, without a brain.'] }, () => ({}), [showRoute]);
  sayGrowing(s, { id: 'lesson', about: 'The history: scientists in Japan first showed a slime mold solving a maze in {year}; since then it has been used to model road and rail networks.', maxWords: 18, required: ['year'], fallback: ['Scientists first showed this in {year}. Since then, slime molds have helped model road networks.', 'This was first done in {year}. Now slime molds help design transport networks.'] }, () => ({ year: '2000' }));
  s.mark('outro');
  s.play(140, TPS);
  return { sim, script: s };
}

function foraging(p: MoldParams, rng: Rng): Built {
  const food = scatterFood(rng, p.food, 30);
  const mold = newMold(opts(p, 0.0015), dishWalls(), food, rng);
  seedAgents(mold, N / 2, N / 2, 10);
  const sim: MoldSim = { mold, route: [], showRoute: false, peak: 0, answer: 'PRUNED' };
  const n = food.length - 1;
  const s = new Script<MoldSim>();
  sayGrowing(s, INTRO, undefined, undefined, 0.03);
  if (p.guess) sayGrowing(s, { id: 'guess', about: 'The viewer is asked to guess where the slime mold will grow.', maxWords: 8, fallback: ['Where will it grow? Guess now.', 'Guess which way it goes.'] }, undefined, undefined, 0.03);
  sayGrowing(s, { id: 'explore', about: 'It spreads out in every direction at once, searching for food.', maxWords: 10, fallback: ['It spreads in every direction at once, searching.', 'No map, no plan: it just spreads out.'] });
  s.until((sim) => found(sim) >= Math.ceil(n * 0.6), { tps: TPS * 1.5, maxTicks: 1500, estTicks: 600 });
  sayGrowing(s, { id: 'found', about: 'It has found {found} of the {n} oat flakes; it covers {cover} percent of the dish.', maxWords: 13, required: ['found'], fallback: ['It has found {found} flakes, covering {cover} percent of the dish.', '{found} flakes found so far.'] }, (sim) => ({ found: found(sim), n: total(sim), cover: Math.round(coverage(sim.mold) * 100) }));
  s.play(700, TPS, { elastic: true });
  sayGrowing(s, { id: 'prune', about: 'Now it pulls back from the empty places, keeping only the tubes that lead to food; it covers {cover} percent now, down from {peak}.', maxWords: 18, required: ['cover', 'peak'], fallback: ['Then it pulls back from empty places. From {peak} percent of the dish down to {cover}.', 'It retreats from where there is nothing: {peak} percent down to {cover}.'] }, (sim) => ({ cover: Math.round(coverage(sim.mold) * 100), peak: Math.round(sim.peak * 100) }));
  s.mark('reveal');
  s.act(showRoute);
  sayGrowing(s, { id: 'lesson', about: 'The lesson: with no brain and no nerves, it still solves a problem, explore then keep only what pays off, that engineers find hard.', maxWords: 16, fallback: ['No brain, no nerves. Yet it solves a problem engineers find hard.', 'Explore everything, keep only what works. No brain needed.'] });
  s.mark('outro');
  s.play(140, TPS);
  return { sim, script: s };
}

export function buildMold(p: MoldParams, rng: Rng): Built {
  switch (p.mode) {
    case 'network':
      return network(p, rng, false);
    case 'tokyo':
      return network(p, rng, true);
    case 'maze':
      return maze(p, rng);
    case 'foraging':
      return foraging(p, rng);
  }
}

export { coverage };
