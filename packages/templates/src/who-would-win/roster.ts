/**
 * The fighters: everything the simulation needs (size, stats, moves with their clips' timings) lives
 * here, so headless runs never load a model. The view reads the same table for clip names, heights and
 * props. Clip names and lengths are checked against the GLBs in who-would-win.test.ts.
 *
 * Units: metres, seconds, kilograms. Damage and HP are in the same arbitrary points for everyone.
 */

/** One moment a move can land: `at` is a fraction of the clip, `back` hits behind (hoof kicks). */
export interface MoveHit {
  at: number;
  back?: boolean;
}

export interface MoveDef {
  name: string;
  clip: string;
  /** Clip length in seconds (played at rate 1). */
  len: number;
  hits: MoveHit[];
  /** Edge-to-edge distance it reaches. */
  reach: number;
  /** Half-angle (radians) of the cone it hits in, around the facing (or behind it for `back`). */
  arc: number;
  damage: number;
  /** Knockback speed (m/s) given to a target of equal mass. */
  knock: number;
  /** Seconds before it can be used again (from the start of the move). */
  cooldown: number;
  /** How the hit sounds. */
  sound: 'bite' | 'blunt' | 'slash' | 'hoof';
  /** Distance moved forward from the start of the move to its (first) hit: a lunge or a leap. */
  lunge?: number;
  /** Only used from at least this far (edge to edge): leaps and charges. */
  minRange?: number;
  /** Charge: run up at full speed and land it with extra damage and knockback for the speed. */
  charge?: boolean;
  /** Breath: hits everyone in the cone every BREATH_TICK s from the first hit to `until` (fraction). */
  breath?: { until: number };
  /** Poison: damage per second for a few seconds after the hit. */
  poison?: number;
  /** Relative preference when several moves are possible. */
  weight?: number;
}

export interface CreatureDef {
  id: string;
  label: string;
  /** Plural for horde copy ("wolves"). */
  plural: string;
  icon: string;
  /** Model file (assets/ambient/models/creatures/<model>.glb). */
  model: string;
  /** Height of the model's bounding box in the arena (metres): the view scales the mesh to it. */
  height: number;
  /** Collision circle. */
  radius: number;
  /** Flies just above the floor (metres): the view lifts it, the sim ignores height. */
  hover?: number;
  mass: number;
  hp: number;
  /** Fraction of damage shrugged off. */
  armor: number;
  walk: number;
  run: number;
  /** Turn rate (rad/s). */
  turn: number;
  /** Damage in one hit that staggers it (interrupting its own attack before it lands). */
  poise: number;
  clips: {
    idle: string;
    walk: string;
    run: string;
    /** Hit reactions (one is picked per stagger); empty: flash and knockback only. */
    hit: string[];
    death: string;
    /** Clip lengths (s) for the looped and one-shot clips above. */
    lens: Record<string, number>;
  };
  /** Ground speed (m/s) the walk and run clips show at rate 1 (no foot sliding at that speed). */
  walkStride: number;
  runStride: number;
  /** Sidestep out of an incoming attack: the clips to strafe left / right with, and how often. */
  dodge?: { left: string; right: string; len: number; chance: number; cooldown: number; distance: number };
  moves: MoveDef[];
  /** Props the view adds: a sword in the right hand, a horn on the head. */
  props?: ('gold-sword' | 'horn')[];
  /** Body colour for flashes and the VS card. */
  color: string;
}

const HOOVES = {
  idle: 'Idle',
  walk: 'Walk',
  run: 'Gallop',
  hit: ['Idle_HitReact_Left', 'Idle_HitReact_Right'],
  death: 'Death',
};
const DOGS = { ...HOOVES };
const HUMANS = { idle: 'Idle_Sword', walk: 'Walk', run: 'Run', hit: ['HitRecieve', 'HitRecieve_2'], death: 'Death' };

/** A rear hoof kick (the Quaternius animals' Attack_Kick is a buck: both hind legs out). */
const buck = (len: number, damage: number, knock: number, at = 0.6): MoveDef => ({
  name: 'Kick',
  clip: 'Attack_Kick',
  len,
  hits: [{ at, back: true }],
  reach: 1.1,
  arc: 0.8,
  damage,
  knock,
  cooldown: 1.8,
  sound: 'hoof',
});

export const CREATURES: CreatureDef[] = [
  {
    id: 'bull',
    label: 'Bull',
    plural: 'Bulls',
    icon: '🐂',
    model: 'bull',
    height: 1.75,
    radius: 0.85,
    mass: 900,
    hp: 520,
    armor: 0.15,
    walk: 1.6,
    run: 7.5,
    turn: 2.2,
    poise: 70,
    clips: { ...HOOVES, lens: { Idle: 3.333, Walk: 1.167, Gallop: 0.583, Idle_HitReact_Left: 0.667, Idle_HitReact_Right: 0.667, Death: 1 } },
    walkStride: 1.6,
    runStride: 7.5,
    moves: [
      { name: 'Gore', clip: 'Attack_Headbutt', len: 1, hits: [{ at: 0.35 }], reach: 1.2, arc: 0.7, damage: 62, knock: 7, cooldown: 1.4, sound: 'blunt', lunge: 0.6, weight: 2 },
      { name: 'Charge', clip: 'Attack_Headbutt', len: 1, hits: [{ at: 0.35 }], reach: 1.2, arc: 0.6, damage: 70, knock: 10, cooldown: 5, sound: 'blunt', minRange: 3.5, charge: true, weight: 3 },
      buck(1, 50, 7),
    ],
    color: '#2b2b30',
  },
  {
    id: 'horse',
    label: 'Horse',
    plural: 'Horses',
    icon: '🐎',
    model: 'horse',
    height: 1.85,
    radius: 0.7,
    mass: 520,
    hp: 430,
    armor: 0.05,
    walk: 1.7,
    run: 9.5,
    turn: 2.6,
    poise: 45,
    clips: { ...HOOVES, lens: { Idle: 3.333, Walk: 1.167, Gallop: 0.583, Idle_HitReact_Left: 0.667, Idle_HitReact_Right: 0.667, Death: 1 } },
    walkStride: 1.7,
    runStride: 9,
    moves: [
      { name: 'Bite', clip: 'Attack_Headbutt', len: 1, hits: [{ at: 0.35 }], reach: 0.9, arc: 0.6, damage: 24, knock: 2, cooldown: 1.1, sound: 'bite', lunge: 0.3 },
      { ...buck(1, 64, 8), weight: 2.5 },
    ],
    color: '#7a4a2a',
  },
  {
    id: 'unicorn',
    label: 'Unicorn',
    plural: 'Unicorns',
    icon: '🦄',
    model: 'white-horse',
    height: 1.85,
    radius: 0.7,
    mass: 500,
    hp: 400,
    armor: 0.08,
    walk: 1.7,
    run: 10,
    turn: 2.8,
    poise: 45,
    clips: { ...HOOVES, lens: { Idle: 3.333, Walk: 1.167, Gallop: 0.583, Idle_HitReact_Left: 0.667, Idle_HitReact_Right: 0.667, Death: 1 } },
    walkStride: 1.7,
    runStride: 9,
    moves: [
      { name: 'Horn', clip: 'Attack_Headbutt', len: 1, hits: [{ at: 0.35 }], reach: 1.4, arc: 0.45, damage: 52, knock: 5, cooldown: 1.3, sound: 'slash', lunge: 0.5, weight: 2 },
      { name: 'Horn charge', clip: 'Attack_Headbutt', len: 1, hits: [{ at: 0.35 }], reach: 1.4, arc: 0.4, damage: 58, knock: 8, cooldown: 5, sound: 'slash', minRange: 3.5, charge: true, weight: 3 },
      buck(1, 52, 7),
    ],
    props: ['horn'],
    color: '#e8e4f0',
  },
  {
    id: 'stag',
    label: 'Stag',
    plural: 'Stags',
    icon: '🦌',
    model: 'stag',
    height: 2.05,
    radius: 0.6,
    mass: 220,
    hp: 270,
    armor: 0.05,
    walk: 1.6,
    run: 10.5,
    turn: 3,
    poise: 30,
    clips: { ...HOOVES, lens: { Idle: 3.333, Walk: 1.167, Gallop: 0.5, Idle_HitReact_Left: 0.458, Idle_HitReact_Right: 0.5, Death: 1.083 } },
    walkStride: 1.6,
    runStride: 9,
    moves: [
      { name: 'Antlers', clip: 'Attack_Headbutt', len: 0.792, hits: [{ at: 0.35 }], reach: 1.3, arc: 0.7, damage: 40, knock: 5, cooldown: 1.1, sound: 'blunt', lunge: 0.5, weight: 2 },
      { name: 'Antler charge', clip: 'Attack_Headbutt', len: 0.792, hits: [{ at: 0.35 }], reach: 1.3, arc: 0.6, damage: 44, knock: 7, cooldown: 4.5, sound: 'blunt', minRange: 3.5, charge: true, weight: 3 },
      buck(0.792, 30, 5),
    ],
    color: '#8a6440',
  },
  {
    id: 'deer',
    label: 'Deer',
    plural: 'Deer',
    icon: '🦌',
    model: 'deer',
    height: 1.4,
    radius: 0.45,
    mass: 70,
    hp: 120,
    armor: 0,
    walk: 1.5,
    run: 11,
    turn: 3.5,
    poise: 14,
    clips: { ...HOOVES, lens: { Idle: 3.333, Walk: 1.167, Gallop: 0.5, Idle_HitReact_Left: 0.458, Idle_HitReact_Right: 0.5, Death: 0.833 } },
    walkStride: 1.5,
    runStride: 9,
    moves: [
      { name: 'Headbutt', clip: 'Attack_Headbutt', len: 0.792, hits: [{ at: 0.35 }], reach: 0.9, arc: 0.7, damage: 14, knock: 2, cooldown: 1, sound: 'blunt', lunge: 0.3 },
      buck(0.792, 22, 4),
    ],
    color: '#a8703c',
  },
  {
    id: 'donkey',
    label: 'Donkey',
    plural: 'Donkeys',
    icon: '🫏',
    model: 'donkey',
    height: 1.5,
    radius: 0.55,
    mass: 260,
    hp: 270,
    armor: 0.1,
    walk: 1.4,
    run: 7,
    turn: 2.8,
    poise: 32,
    clips: { ...HOOVES, lens: { Idle: 3.333, Walk: 1.167, Gallop: 0.5, Idle_HitReact_Left: 0.458, Idle_HitReact_Right: 0.5, Death: 0.833 } },
    walkStride: 1.4,
    runStride: 8,
    moves: [
      // The donkey's headbutt clip is a headbutt and then a buck, in one.
      { name: 'Headbutt and buck', clip: 'Attack_Headbutt', len: 1.583, hits: [{ at: 0.15 }, { at: 0.75, back: true }], reach: 1, arc: 0.8, damage: 26, knock: 4, cooldown: 2.2, sound: 'hoof', weight: 1.5 },
      { ...buck(0.792, 48, 7, 0.55), weight: 2 },
    ],
    color: '#8d8d92',
  },
  {
    id: 'alpaca',
    label: 'Alpaca',
    plural: 'Alpacas',
    icon: '🦙',
    model: 'alpaca',
    height: 1.7,
    radius: 0.45,
    mass: 70,
    hp: 150,
    armor: 0.05,
    walk: 1.4,
    run: 8.5,
    turn: 3,
    poise: 15,
    clips: { ...HOOVES, lens: { Idle: 4.167, Walk: 1.458, Gallop: 0.667, Idle_HitReact_Left: 0.583, Idle_HitReact_Right: 0.667, Death: 1.042 } },
    walkStride: 1.2,
    runStride: 7,
    moves: [
      { name: 'Headbutt', clip: 'Attack_Headbutt', len: 1, hits: [{ at: 0.35 }], reach: 0.9, arc: 0.7, damage: 13, knock: 2, cooldown: 1.1, sound: 'blunt', lunge: 0.3 },
      buck(1, 20, 4),
    ],
    color: '#8a6440',
  },
  {
    id: 'wolf',
    label: 'Wolf',
    plural: 'Wolves',
    icon: '🐺',
    model: 'wolf',
    height: 0.95,
    radius: 0.42,
    mass: 45,
    hp: 135,
    armor: 0,
    walk: 1.5,
    run: 11,
    turn: 4.5,
    poise: 14,
    clips: { ...DOGS, lens: { Idle: 3.333, Walk: 1.042, Gallop: 0.542, Idle_HitReact_Left: 0.667, Idle_HitReact_Right: 0.667, Death: 1.042 } },
    walkStride: 1.5,
    runStride: 8,
    moves: [{ name: 'Bite', clip: 'Attack', len: 1.333, hits: [{ at: 0.5 }], reach: 0.8, arc: 0.6, damage: 27, knock: 1, cooldown: 1.2, sound: 'bite', lunge: 0.9 }],
    color: '#8b8f96',
  },
  {
    id: 'husky',
    label: 'Husky',
    plural: 'Huskies',
    icon: '🐕',
    model: 'husky',
    height: 0.85,
    radius: 0.38,
    mass: 25,
    hp: 90,
    armor: 0,
    walk: 1.5,
    run: 10,
    turn: 4.5,
    poise: 10,
    clips: { ...DOGS, lens: { Idle: 3.333, Walk: 1.042, Gallop: 0.542, Idle_HitReact_Left: 0.667, Idle_HitReact_Right: 0.667, Death: 1.042 } },
    walkStride: 1.4,
    runStride: 7.5,
    moves: [{ name: 'Bite', clip: 'Attack', len: 1.167, hits: [{ at: 0.5 }], reach: 0.7, arc: 0.6, damage: 15, knock: 1, cooldown: 1.1, sound: 'bite', lunge: 0.7 }],
    color: '#4d5560',
  },
  {
    id: 'fox',
    label: 'Fox',
    plural: 'Foxes',
    icon: '🦊',
    model: 'fox',
    height: 0.6,
    radius: 0.3,
    mass: 7,
    hp: 45,
    armor: 0,
    walk: 1.4,
    run: 11,
    turn: 5,
    poise: 6,
    clips: { ...DOGS, lens: { Idle: 3.333, Walk: 1.042, Gallop: 0.542, Idle_HitReact_Left: 0.667, Idle_HitReact_Right: 0.667, Death: 1.042 } },
    walkStride: 1.2,
    runStride: 7,
    moves: [{ name: 'Bite', clip: 'Attack', len: 1.333, hits: [{ at: 0.5 }], reach: 0.6, arc: 0.6, damage: 9, knock: 0.5, cooldown: 1, sound: 'bite', lunge: 0.6 }],
    color: '#d0612a',
  },
  {
    id: 'swordsman',
    label: 'Swordsman',
    plural: 'Swordsmen',
    icon: '🗡️',
    model: 'hooded-adventurer',
    height: 1.8,
    radius: 0.4,
    mass: 80,
    hp: 200,
    armor: 0.15,
    walk: 1.4,
    run: 5.5,
    turn: 7,
    poise: 24,
    clips: { ...HUMANS, lens: { Idle_Sword: 2.083, Walk: 1.667, Run: 1, HitRecieve: 0.708, HitRecieve_2: 0.708, Death: 1.333 } },
    walkStride: 1.2,
    runStride: 5.5,
    dodge: { left: 'Run_Left', right: 'Run_Right', len: 1, chance: 0.35, cooldown: 2.5, distance: 1.6 },
    moves: [
      { name: 'Slash', clip: 'Sword_Slash', len: 1.292, hits: [{ at: 0.4 }], reach: 1.2, arc: 1.2, damage: 44, knock: 2.5, cooldown: 1.1, sound: 'slash', lunge: 0.4, weight: 3 },
      { name: 'Kick', clip: 'Kick_Right', len: 1.167, hits: [{ at: 0.5 }], reach: 0.8, arc: 0.6, damage: 14, knock: 4, cooldown: 2, sound: 'blunt' },
    ],
    color: '#5a3a28',
  },
  {
    id: 'king',
    label: 'King',
    plural: 'Kings',
    icon: '👑',
    model: 'king',
    height: 1.85,
    radius: 0.4,
    mass: 90,
    hp: 230,
    armor: 0.25,
    walk: 1.3,
    run: 4.8,
    turn: 6,
    poise: 28,
    clips: { ...HUMANS, lens: { Idle_Sword: 1.667, Walk: 1.333, Run: 0.792, HitRecieve: 0.542, HitRecieve_2: 0.542, Death: 1.042 } },
    walkStride: 1.2,
    runStride: 5,
    dodge: { left: 'Run_Left', right: 'Run_Right', len: 0.792, chance: 0.2, cooldown: 3, distance: 1.3 },
    moves: [
      { name: 'Royal slash', clip: 'Sword_Slash', len: 1, hits: [{ at: 0.4 }], reach: 1.2, arc: 1.2, damage: 42, knock: 2.5, cooldown: 1.1, sound: 'slash', lunge: 0.3, weight: 3 },
      { name: 'Punch', clip: 'Punch_Right', len: 0.833, hits: [{ at: 0.5 }], reach: 0.6, arc: 0.6, damage: 12, knock: 2, cooldown: 1.5, sound: 'blunt' },
    ],
    props: ['gold-sword'],
    color: '#3c4a78',
  },
  {
    id: 'brawler',
    label: 'Brawler',
    plural: 'Brawlers',
    icon: '👊',
    model: 'adventurer',
    height: 1.8,
    radius: 0.4,
    mass: 85,
    hp: 210,
    armor: 0.05,
    walk: 1.4,
    run: 6,
    turn: 7,
    poise: 22,
    clips: { ...HUMANS, idle: 'Idle', lens: { Idle: 1.667, Walk: 1.333, Run: 0.792, HitRecieve: 0.542, HitRecieve_2: 0.542, Death: 1.042 } },
    walkStride: 1.2,
    runStride: 5.5,
    dodge: { left: 'Run_Left', right: 'Run_Right', len: 0.792, chance: 0.45, cooldown: 2, distance: 1.5 },
    moves: [
      { name: 'Jab', clip: 'Punch_Left', len: 0.833, hits: [{ at: 0.4 }], reach: 0.6, arc: 0.6, damage: 14, knock: 1.5, cooldown: 0.7, sound: 'blunt', weight: 2 },
      { name: 'Cross', clip: 'Punch_Right', len: 0.833, hits: [{ at: 0.5 }], reach: 0.6, arc: 0.6, damage: 18, knock: 2, cooldown: 1, sound: 'blunt', weight: 2 },
      { name: 'Kick', clip: 'Kick_Right', len: 0.917, hits: [{ at: 0.5 }], reach: 0.85, arc: 0.6, damage: 24, knock: 5, cooldown: 1.6, sound: 'blunt', weight: 1.5 },
    ],
    color: '#4a5a32',
  },
  {
    id: 'dragon',
    label: 'Dragon',
    plural: 'Dragons',
    icon: '🐉',
    model: 'dragon',
    height: 2.6,
    radius: 1.2,
    hover: 0.9,
    mass: 1200,
    hp: 560,
    armor: 0.2,
    walk: 2,
    run: 6.5,
    turn: 2,
    poise: 110,
    clips: {
      idle: 'Dragon_Flying',
      walk: 'Dragon_Flying',
      run: 'Dragon_Flying',
      hit: ['Dragon_Hit'],
      death: 'Dragon_Death',
      lens: { Dragon_Flying: 1.667, Dragon_Hit: 1.667, Dragon_Death: 1.208 },
    },
    walkStride: 0,
    runStride: 0,
    moves: [
      { name: 'Bite', clip: 'Dragon_Attack', len: 0.875, hits: [{ at: 0.3 }], reach: 1.3, arc: 0.7, damage: 70, knock: 7, cooldown: 1.6, sound: 'bite', lunge: 0.5, weight: 2 },
      { name: 'Fire breath', clip: 'Dragon_Attack2', len: 1.667, hits: [{ at: 0.3 }], breath: { until: 0.75 }, reach: 5, arc: 0.4, damage: 5, knock: 0.6, cooldown: 4, sound: 'blunt', minRange: 0.5, weight: 3 },
    ],
    color: '#7a1a22',
  },
  {
    id: 'spider',
    label: 'Giant Spider',
    plural: 'Giant Spiders',
    icon: '🕷️',
    model: 'spider',
    height: 1.1,
    radius: 0.95,
    mass: 160,
    hp: 300,
    armor: 0.25,
    walk: 1.8,
    run: 8,
    turn: 4,
    poise: 40,
    clips: { idle: 'Spider_Idle', walk: 'Spider_Walk', run: 'Spider_Walk', hit: [], death: 'Spider_Death', lens: { Spider_Idle: 4.167, Spider_Walk: 0.833, Spider_Death: 1.042 } },
    walkStride: 2.2,
    runStride: 2.2,
    moves: [
      { name: 'Venom bite', clip: 'Spider_Attack', len: 0.75, hits: [{ at: 0.55 }], reach: 0.8, arc: 0.7, damage: 26, knock: 2, cooldown: 1.2, sound: 'bite', lunge: 0.4, poison: 5, weight: 2 },
      { name: 'Leap', clip: 'Spider_Jump', len: 0.708, hits: [{ at: 0.75 }], reach: 0.9, arc: 0.8, damage: 34, knock: 5, cooldown: 4, sound: 'blunt', lunge: 4, minRange: 2.2, weight: 3 },
    ],
    color: '#25252b',
  },
];

export const CREATURE_IDS = CREATURES.map((c) => c.id) as [string, ...string[]];

export const creatureById = (id: string): CreatureDef => {
  const c = CREATURES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown creature: ${id}`);
  return c;
};

/** Model files the roster uses (each loaded once), plus prop models. */
export const MODEL_FILES = [...new Set([...CREATURES.map((c) => c.model), ...CREATURES.flatMap((c) => (c.props ?? []).filter((p) => p !== 'horn')) as string[]])];

/**
 * Curated fights, so `random` always gives a sensible one. Duels are ones the favourite wins about
 * 50-85% of the time (scripts/battle-matrix.ts); hordes are one big fighter against a stream of a
 * smaller kind (never people: a crowd of fighters that dodge and slash is too strong a swarm).
 */
export const DUELS = [
  ['bull', 'dragon'],
  ['bull', 'unicorn'],
  ['unicorn', 'stag'],
  ['stag', 'horse'],
  ['stag', 'spider'],
  ['stag', 'king'],
  ['horse', 'king'],
  ['horse', 'spider'],
  ['horse', 'donkey'],
  ['horse', 'swordsman'],
  ['king', 'spider'],
  ['king', 'brawler'],
  ['swordsman', 'spider'],
  ['swordsman', 'donkey'],
  ['swordsman', 'brawler'],
  ['donkey', 'brawler'],
  ['wolf', 'deer'],
  ['wolf', 'alpaca'],
] as const;

export const HORDES = [
  ['bull', 'wolf'],
  ['bull', 'fox'],
  ['dragon', 'wolf'],
  ['dragon', 'husky'],
  ['dragon', 'alpaca'],
  ['horse', 'husky'],
  ['donkey', 'fox'],
  ['spider', 'fox'],
  ['unicorn', 'wolf'],
  ['swordsman', 'fox'],
  ['king', 'husky'],
  ['stag', 'fox'],
] as const;

export const matchupId = (a: string, b: string) => `${a}-vs-${b}`;
export const DUEL_IDS = DUELS.map(([a, b]) => matchupId(a, b));
export const HORDE_IDS = HORDES.map(([a, b]) => matchupId(a, b));

/** Stat bars for the VS card (0..1): size, power, speed, toughness. */
export function statBars(c: CreatureDef): { size: number; power: number; speed: number; toughness: number } {
  const bestHit = Math.max(...c.moves.map((m) => m.damage * (m.breath ? 6 : m.hits.length)));
  const span = (x: number, lo: number, hi: number) => Math.max(0.06, Math.min(1, (Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))));
  return {
    size: span(c.mass, 5, 1300),
    power: span(bestHit, 8, 80),
    speed: Math.max(0.06, Math.min(1, c.run / 11.5)),
    toughness: span(c.hp / (1 - c.armor), 40, 1300),
  };
}
