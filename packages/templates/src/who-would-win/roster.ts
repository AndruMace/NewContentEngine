/**
 * The fighters: everything the simulation needs (size, stats, moves and their timings) lives here, so
 * headless runs never build a model. Each move's `clip` names the motion its pose function draws
 * (proc/poses.ts) over `len` seconds; the view reads heights and species from the same table.
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
  /**
   * Grapple on a hit: latch (ride the target, biting, while it fights on slowed), roll (clamp on and
   * death-roll: the target can't act) or pin (hold it down and maul). Ticks `dps` until `seconds` run
   * out, the grabber is shaken off (likelier the heavier the target), staggered or killed.
   */
  grab?: { kind: 'latch' | 'roll' | 'pin'; seconds: number; dps: number; chance?: number };
  /** Damage taken during the move is cut by this fraction, and it can't be staggered out of it. */
  armor?: number;
  /** A roar: smaller enemies within the radius flinch (stagger) at the hit. No damage. */
  roar?: { radius: number };
  /** Only used on a target that is staggered or held. */
  needs?: 'targetDown';
  /** A charge that stops short this often (a bluff), sizing the target up instead. */
  bluff?: number;
}

/** A creature modelled and animated in code (proc/): its species and stride (m per gait cycle, walking / running). */
export const PROC_KINDS = ['lion', 'bear', 'croc', 'horse', 'unicorn', 'donkey', 'bull', 'stag', 'deer', 'alpaca', 'wolf', 'husky', 'fox', 'swordsman', 'king', 'brawler', 'dragon', 'spider'] as const;

export interface ProcInfo {
  kind: (typeof PROC_KINDS)[number];
  stride: [number, number];
}

/** Metres per gait cycle at a speed (the sim's cadence and the view's foot placement both use it). */
export const strideFor = (p: ProcInfo, speed: number) => p.stride[0] + (p.stride[1] - p.stride[0]) * Math.max(0, Math.min(1, (speed - 1.5) / 6));

export interface CreatureDef {
  id: string;
  label: string;
  /** Plural for horde copy ("wolves"). */
  plural: string;
  icon: string;
  /** Height of the model's bounding box in the arena (metres): the view scales the mesh to it. */
  height: number;
  /** Collision circle (half the body's width). */
  radius: number;
  /**
   * Long bodies: how far the snout and the rump reach from the centre (default: the radius). Spacing
   * and reach are measured from the body's edge in each direction, so long animals meet snout to snout.
   */
  front?: number;
  back?: number;
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
  /** Sidestep out of an incoming attack: how long it takes, how often, how far. */
  dodge?: { len: number; chance: number; cooldown: number; distance: number };
  moves: MoveDef[];
  /** Its species, modelled and animated in code (proc/). */
  proc: ProcInfo;
  /**
   * How it fights: stalker (circles, crouches, then pounces), brute (straight in, rears up, roars
   * when crowded), ambusher (lies still facing its prey and strikes when it comes close). Default:
   * the standard approach / circle / strike.
   */
  ai?: 'stalker' | 'brute' | 'ambusher';
  /** Body colour for flashes and the VS card. */
  color: string;
  /** Its call (roar, whinny…) and how high it is (0 deep .. 1 high). */
  voice?: { call: 'roar' | 'growl' | 'snarl' | 'hiss' | 'whinny' | 'bellow' | 'screech' | 'grunt'; pitch: number };
  /** What its footfalls sound like. */
  feet?: 'hoof' | 'paw' | 'foot';
  /** Fighters with a blade ring when they hit. */
  weapon?: 'sword';
}


/** A rear hoof kick (the Quaternius animals' Attack_Kick is a buck: both hind legs out). */
const buck = (len: number, damage: number, knock: number, at = 0.6): MoveDef => ({
  name: 'Kick',
  clip: 'buck',
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
    voice: { call: 'bellow', pitch: 0.15 },
    feet: 'hoof',
    height: 1.75,
    radius: 0.5,
    front: 1.45,
    back: 1.0,
    mass: 900,
    hp: 560,
    armor: 0.15,
    walk: 1.6,
    run: 7.5,
    turn: 2.2,
    poise: 70,
    proc: { kind: 'bull', stride: [1.5, 3.5] },
    moves: [
      { name: 'Gore', clip: 'headbutt', len: 1, hits: [{ at: 0.35 }], reach: 1.2, arc: 0.7, damage: 62, knock: 7, cooldown: 1.4, sound: 'blunt', lunge: 0.6, weight: 2 },
      { name: 'Charge', clip: 'charge', len: 1, hits: [{ at: 0.35 }], reach: 1.2, arc: 0.6, damage: 70, knock: 10, cooldown: 5, sound: 'blunt', minRange: 3.5, charge: true, weight: 3 },
      buck(1, 50, 7),
    ],
    color: '#2b2b30',
  },
  {
    id: 'horse',
    label: 'Horse',
    plural: 'Horses',
    icon: '🐎',
    voice: { call: 'whinny', pitch: 0.35 },
    feet: 'hoof',
    height: 2.2,
    radius: 0.38,
    front: 1.6,
    back: 0.95,
    mass: 520,
    hp: 470,
    armor: 0.05,
    walk: 1.7,
    run: 9.5,
    turn: 2.6,
    poise: 45,
    proc: { kind: 'horse', stride: [1.6, 4.0] },
    moves: [
      { name: 'Bite', clip: 'bite', len: 1, hits: [{ at: 0.35 }], reach: 0.9, arc: 0.6, damage: 24, knock: 2, cooldown: 1.1, sound: 'bite', lunge: 0.3 },
      { ...buck(1, 70, 8), weight: 2.5 },
    ],
    color: '#7a4a2a',
  },
  {
    id: 'unicorn',
    label: 'Unicorn',
    plural: 'Unicorns',
    icon: '🦄',
    voice: { call: 'whinny', pitch: 0.7 },
    feet: 'hoof',
    height: 2.4,
    radius: 0.38,
    front: 1.6,
    back: 0.95,
    mass: 500,
    hp: 440,
    armor: 0.08,
    walk: 1.7,
    run: 10,
    turn: 2.8,
    poise: 45,
    proc: { kind: 'unicorn', stride: [1.6, 4.0] },
    moves: [
      { name: 'Horn', clip: 'headbutt', len: 1, hits: [{ at: 0.35 }], reach: 1.4, arc: 0.45, damage: 52, knock: 5, cooldown: 1.3, sound: 'slash', lunge: 0.5, weight: 2 },
      { name: 'Horn charge', clip: 'charge', len: 1, hits: [{ at: 0.35 }], reach: 1.4, arc: 0.4, damage: 58, knock: 8, cooldown: 5, sound: 'slash', minRange: 3.5, charge: true, weight: 3 },
      buck(1, 52, 7),
    ],
    color: '#e8e4f0',
  },
  {
    id: 'stag',
    label: 'Stag',
    plural: 'Stags',
    icon: '🦌',
    voice: { call: 'bellow', pitch: 0.55 },
    feet: 'hoof',
    height: 2.3,
    radius: 0.3,
    front: 1.3,
    back: 0.75,
    mass: 220,
    hp: 320,
    armor: 0.05,
    walk: 1.6,
    run: 10.5,
    turn: 3,
    poise: 30,
    proc: { kind: 'stag', stride: [1.5, 3.8] },
    moves: [
      { name: 'Antlers', clip: 'headbutt', len: 0.792, hits: [{ at: 0.35 }], reach: 1.3, arc: 0.7, damage: 46, knock: 5, cooldown: 1.1, sound: 'blunt', lunge: 0.5, weight: 2 },
      { name: 'Antler charge', clip: 'charge', len: 0.792, hits: [{ at: 0.35 }], reach: 1.3, arc: 0.6, damage: 44, knock: 7, cooldown: 4.5, sound: 'blunt', minRange: 3.5, charge: true, weight: 3 },
      buck(0.792, 30, 5),
    ],
    color: '#8a6440',
  },
  {
    id: 'deer',
    label: 'Deer',
    plural: 'Deer',
    icon: '🦌',
    voice: { call: 'whinny', pitch: 0.95 },
    feet: 'hoof',
    height: 1.5,
    radius: 0.24,
    front: 1.0,
    back: 0.6,
    mass: 70,
    hp: 145,
    armor: 0,
    walk: 1.5,
    run: 11,
    turn: 3.5,
    poise: 14,
    proc: { kind: 'deer', stride: [1.3, 3.5] },
    moves: [
      { name: 'Headbutt', clip: 'headbutt', len: 0.792, hits: [{ at: 0.35 }], reach: 0.9, arc: 0.7, damage: 14, knock: 2, cooldown: 1, sound: 'blunt', lunge: 0.3 },
      buck(0.792, 22, 4),
    ],
    color: '#a8703c',
  },
  {
    id: 'donkey',
    label: 'Donkey',
    plural: 'Donkeys',
    icon: '🫏',
    voice: { call: 'bellow', pitch: 0.85 },
    feet: 'hoof',
    height: 1.8,
    radius: 0.32,
    front: 1.35,
    back: 0.75,
    mass: 260,
    hp: 270,
    armor: 0.1,
    walk: 1.4,
    run: 7,
    turn: 2.8,
    poise: 32,
    proc: { kind: 'donkey', stride: [1.3, 3.2] },
    moves: [
      // The donkey's headbutt clip is a headbutt and then a buck, in one.
      { name: 'Headbutt and buck', clip: 'combo', len: 1.583, hits: [{ at: 0.15 }, { at: 0.75, back: true }], reach: 1, arc: 0.8, damage: 26, knock: 4, cooldown: 2.2, sound: 'hoof', weight: 1.5 },
      { ...buck(0.792, 48, 7, 0.55), weight: 2 },
    ],
    color: '#8d8d92',
  },
  {
    id: 'alpaca',
    label: 'Alpaca',
    plural: 'Alpacas',
    icon: '🦙',
    voice: { call: 'whinny', pitch: 1.0 },
    feet: 'paw',
    height: 1.75,
    radius: 0.32,
    front: 0.8,
    back: 0.6,
    mass: 70,
    hp: 150,
    armor: 0.05,
    walk: 1.4,
    run: 8.5,
    turn: 3,
    poise: 15,
    proc: { kind: 'alpaca', stride: [1.2, 3.0] },
    moves: [
      { name: 'Headbutt', clip: 'headbutt', len: 1, hits: [{ at: 0.35 }], reach: 0.9, arc: 0.7, damage: 13, knock: 2, cooldown: 1.1, sound: 'blunt', lunge: 0.3 },
      buck(1, 20, 4),
    ],
    color: '#8a6440',
  },
  {
    id: 'wolf',
    label: 'Wolf',
    plural: 'Wolves',
    icon: '🐺',
    voice: { call: 'snarl', pitch: 0.25 },
    feet: 'paw',
    height: 1.0,
    radius: 0.22,
    front: 0.95,
    back: 0.6,
    mass: 45,
    hp: 135,
    armor: 0,
    walk: 1.5,
    run: 11,
    turn: 4.5,
    poise: 14,
    proc: { kind: 'wolf', stride: [1.1, 2.8] },
    moves: [{ name: 'Bite', clip: 'bite', len: 1.333, hits: [{ at: 0.5 }], reach: 0.8, arc: 0.6, damage: 27, knock: 1, cooldown: 1.2, sound: 'bite', lunge: 0.9 }],
    color: '#8b8f96',
  },
  {
    id: 'husky',
    label: 'Husky',
    plural: 'Huskies',
    icon: '🐕',
    voice: { call: 'snarl', pitch: 0.55 },
    feet: 'paw',
    height: 1.0,
    radius: 0.2,
    front: 0.75,
    back: 0.5,
    mass: 25,
    hp: 90,
    armor: 0,
    walk: 1.5,
    run: 10,
    turn: 4.5,
    poise: 10,
    proc: { kind: 'husky', stride: [1.0, 2.5] },
    moves: [{ name: 'Bite', clip: 'bite', len: 1.167, hits: [{ at: 0.5 }], reach: 0.7, arc: 0.6, damage: 15, knock: 1, cooldown: 1.1, sound: 'bite', lunge: 0.7 }],
    color: '#4d5560',
  },
  {
    id: 'fox',
    label: 'Fox',
    plural: 'Foxes',
    icon: '🦊',
    voice: { call: 'snarl', pitch: 0.95 },
    feet: 'paw',
    height: 0.55,
    radius: 0.13,
    front: 0.5,
    back: 0.35,
    mass: 7,
    hp: 45,
    armor: 0,
    walk: 1.4,
    run: 11,
    turn: 5,
    poise: 6,
    proc: { kind: 'fox', stride: [0.7, 1.9] },
    moves: [{ name: 'Bite', clip: 'bite', len: 1.333, hits: [{ at: 0.5 }], reach: 0.6, arc: 0.6, damage: 9, knock: 0.5, cooldown: 1, sound: 'bite', lunge: 0.6 }],
    color: '#d0612a',
  },
  {
    id: 'swordsman',
    label: 'Swordsman',
    plural: 'Swordsmen',
    icon: '🗡️',
    voice: { call: 'grunt', pitch: 0.4 },
    feet: 'foot',
    weapon: 'sword',
    height: 1.9,
    radius: 0.35,
    mass: 80,
    hp: 200,
    armor: 0.15,
    walk: 1.4,
    run: 5.5,
    turn: 7,
    poise: 24,
    proc: { kind: 'swordsman', stride: [1.3, 2.6] },
    dodge: { len: 1, chance: 0.35, cooldown: 2.5, distance: 1.6 },
    moves: [
      { name: 'Slash', clip: 'slash', len: 1.292, hits: [{ at: 0.4 }], reach: 1.2, arc: 1.2, damage: 44, knock: 2.5, cooldown: 1.1, sound: 'slash', lunge: 0.4, weight: 3 },
      { name: 'Kick', clip: 'kick', len: 1.167, hits: [{ at: 0.5 }], reach: 0.8, arc: 0.6, damage: 14, knock: 4, cooldown: 2, sound: 'blunt' },
    ],
    color: '#5a3a28',
  },
  {
    id: 'king',
    label: 'King',
    plural: 'Kings',
    icon: '👑',
    voice: { call: 'grunt', pitch: 0.15 },
    feet: 'foot',
    weapon: 'sword',
    height: 1.95,
    radius: 0.36,
    mass: 90,
    hp: 200,
    armor: 0.25,
    walk: 1.3,
    run: 4.8,
    turn: 6,
    poise: 28,
    proc: { kind: 'king', stride: [1.3, 2.6] },
    dodge: { len: 0.792, chance: 0.2, cooldown: 3, distance: 1.3 },
    moves: [
      { name: 'Royal slash', clip: 'slash', len: 1, hits: [{ at: 0.4 }], reach: 1.2, arc: 1.2, damage: 42, knock: 2.5, cooldown: 1.1, sound: 'slash', lunge: 0.3, weight: 3 },
      { name: 'Punch', clip: 'punch_r', len: 0.833, hits: [{ at: 0.5 }], reach: 0.6, arc: 0.6, damage: 12, knock: 2, cooldown: 1.5, sound: 'blunt' },
    ],
    color: '#3c4a78',
  },
  {
    id: 'brawler',
    label: 'Brawler',
    plural: 'Brawlers',
    icon: '👊',
    voice: { call: 'grunt', pitch: 0.3 },
    feet: 'foot',
    height: 1.9,
    radius: 0.37,
    mass: 85,
    hp: 210,
    armor: 0.05,
    walk: 1.4,
    run: 6,
    turn: 7,
    poise: 22,
    proc: { kind: 'brawler', stride: [1.3, 2.6] },
    dodge: { len: 0.792, chance: 0.45, cooldown: 2, distance: 1.5 },
    moves: [
      { name: 'Jab', clip: 'punch_l', len: 0.833, hits: [{ at: 0.4 }], reach: 0.6, arc: 0.6, damage: 14, knock: 1.5, cooldown: 0.7, sound: 'blunt', weight: 2 },
      { name: 'Cross', clip: 'punch_r', len: 0.833, hits: [{ at: 0.5 }], reach: 0.6, arc: 0.6, damage: 18, knock: 2, cooldown: 1, sound: 'blunt', weight: 2 },
      { name: 'Kick', clip: 'kick', len: 0.917, hits: [{ at: 0.5 }], reach: 0.85, arc: 0.6, damage: 24, knock: 5, cooldown: 1.6, sound: 'blunt', weight: 1.5 },
    ],
    color: '#4a5a32',
  },
  {
    id: 'dragon',
    label: 'Dragon',
    plural: 'Dragons',
    icon: '🐉',
    voice: { call: 'roar', pitch: 0.0 },
    feet: 'paw',
    height: 2.1,
    radius: 0.7,
    front: 2.0,
    back: 1.0,
    hover: 0.9,
    mass: 1200,
    hp: 560,
    armor: 0.2,
    walk: 2,
    run: 6.5,
    turn: 2,
    poise: 110,
    proc: { kind: 'dragon', stride: [1.4, 3.0] },
    moves: [
      { name: 'Bite', clip: 'bite', len: 0.875, hits: [{ at: 0.3 }], reach: 1.3, arc: 0.7, damage: 70, knock: 7, cooldown: 1.6, sound: 'bite', lunge: 0.5, weight: 2 },
      { name: 'Fire breath', clip: 'breath', len: 1.667, hits: [{ at: 0.3 }], breath: { until: 0.75 }, reach: 5, arc: 0.4, damage: 5, knock: 0.6, cooldown: 4, sound: 'blunt', minRange: 0.5, weight: 3 },
    ],
    color: '#7a1a22',
  },
  {
    id: 'spider',
    label: 'Giant Spider',
    plural: 'Giant Spiders',
    icon: '🕷️',
    voice: { call: 'hiss', pitch: 0.8 },
    feet: 'paw',
    height: 1.1,
    radius: 0.9,
    front: 1.1,
    back: 1.15,
    mass: 160,
    hp: 335,
    armor: 0.25,
    walk: 1.8,
    run: 8,
    turn: 4,
    poise: 40,
    proc: { kind: 'spider', stride: [1.0, 2.0] },
    moves: [
      { name: 'Venom bite', clip: 'bite', len: 0.75, hits: [{ at: 0.55 }], reach: 0.8, arc: 0.7, damage: 26, knock: 2, cooldown: 1.2, sound: 'bite', lunge: 0.4, poison: 5, weight: 2 },
      { name: 'Leap', clip: 'leap', len: 0.708, hits: [{ at: 0.75 }], reach: 0.9, arc: 0.8, damage: 34, knock: 5, cooldown: 4, sound: 'blunt', lunge: 4, minRange: 2.2, weight: 3 },
    ],
    color: '#25252b',
  },
  {
    id: 'lion',
    label: 'Lion',
    plural: 'Lions',
    icon: '🦁',
    voice: { call: 'roar', pitch: 0.45 },
    feet: 'paw',
    height: 1.4,
    radius: 0.42,
    front: 1.35,
    back: 0.85,
    mass: 190,
    hp: 405,
    armor: 0.05,
    walk: 1.6,
    run: 12,
    turn: 4.5,
    poise: 30,
    proc: { kind: 'lion', stride: [1.1, 3.2] },
    ai: 'stalker',
    moves: [
      { name: 'Claw swipe', clip: 'swipe', len: 0.7, hits: [{ at: 0.45 }], reach: 0.95, arc: 0.9, damage: 32, knock: 3, cooldown: 1, sound: 'slash', weight: 2 },
      { name: 'Bite', clip: 'bite', len: 0.8, hits: [{ at: 0.5 }], reach: 0.8, arc: 0.6, damage: 42, knock: 1.5, cooldown: 1.4, sound: 'bite', lunge: 0.4, weight: 2 },
      { name: 'Pounce', clip: 'pounce', len: 1.1, hits: [{ at: 0.62 }], reach: 0.9, arc: 0.7, damage: 28, knock: 1, cooldown: 5, sound: 'bite', lunge: 4.2, minRange: 2.2, grab: { kind: 'latch', seconds: 2.6, dps: 22 }, weight: 4 },
      { name: 'Roar', clip: 'roar', len: 1.2, hits: [{ at: 0.35 }], reach: 4.5, arc: Math.PI, damage: 0, knock: 0, cooldown: 14, sound: 'blunt', roar: { radius: 4.5 }, weight: 1 },
    ],
    color: '#c49a5c',
  },
  {
    id: 'bear',
    label: 'Grizzly',
    plural: 'Grizzlies',
    icon: '🐻',
    voice: { call: 'roar', pitch: 0.15 },
    feet: 'paw',
    height: 1.45,
    radius: 0.55,
    front: 1.35,
    back: 0.9,
    mass: 360,
    hp: 470,
    armor: 0.2,
    walk: 1.5,
    run: 9.5,
    turn: 2.8,
    poise: 55,
    proc: { kind: 'bear', stride: [1.0, 2.8] },
    ai: 'brute',
    moves: [
      { name: 'Swipe', clip: 'swipe', len: 0.8, hits: [{ at: 0.5 }], reach: 1, arc: 1, damage: 36, knock: 5, cooldown: 1.3, sound: 'slash', weight: 2 },
      { name: 'Rear up', clip: 'rear', len: 1.7, hits: [{ at: 0.45 }, { at: 0.68 }], reach: 1.15, arc: 1.3, damage: 46, knock: 8, cooldown: 4.5, sound: 'blunt', armor: 0.5, weight: 3 },
      { name: 'Bite', clip: 'bite', len: 0.9, hits: [{ at: 0.55 }], reach: 0.8, arc: 0.6, damage: 30, knock: 2, cooldown: 1.6, sound: 'bite', lunge: 0.3, weight: 1.5 },
      { name: 'Charge', clip: 'charge', len: 0.8, hits: [{ at: 0.35 }], reach: 1.1, arc: 0.7, damage: 48, knock: 9, cooldown: 7, sound: 'blunt', minRange: 3.5, charge: true, bluff: 0.35, weight: 3 },
      { name: 'Maul', clip: 'maul', len: 1.3, hits: [{ at: 0.3 }], reach: 0.8, arc: 0.9, damage: 18, knock: 0, cooldown: 6, sound: 'bite', needs: 'targetDown', grab: { kind: 'pin', seconds: 1.4, dps: 22 }, weight: 5 },
      { name: 'Roar', clip: 'roar', len: 1.4, hits: [{ at: 0.4 }], reach: 4.5, arc: Math.PI, damage: 0, knock: 0, cooldown: 14, sound: 'blunt', roar: { radius: 4.5 }, weight: 1 },
    ],
    color: '#6b4a2c',
  },
  {
    id: 'croc',
    label: 'Crocodile',
    plural: 'Crocodiles',
    icon: '🐊',
    voice: { call: 'hiss', pitch: 0.3 },
    feet: 'paw',
    height: 0.6,
    radius: 0.42,
    front: 1.45,
    back: 0.85,
    mass: 450,
    hp: 440,
    armor: 0.3,
    walk: 1,
    run: 4.5,
    turn: 1.6,
    poise: 60,
    proc: { kind: 'croc', stride: [0.7, 0.9] },
    ai: 'ambusher',
    moves: [
      { name: 'Lunge bite', clip: 'lunge', len: 0.9, hits: [{ at: 0.4 }], reach: 1, arc: 0.45, damage: 50, knock: 2, cooldown: 2.2, sound: 'bite', lunge: 1.8, grab: { kind: 'roll', seconds: 1.6, dps: 16, chance: 0.4 }, weight: 3 },
      { name: 'Snap', clip: 'snap', len: 0.6, hits: [{ at: 0.45 }], reach: 0.85, arc: 0.5, damage: 28, knock: 1, cooldown: 1.2, sound: 'bite', lunge: 0.2, weight: 2 },
      { name: 'Tail whip', clip: 'tail', len: 0.9, hits: [{ at: 0.45, back: true }], reach: 1.7, arc: 1.4, damage: 30, knock: 7, cooldown: 2.5, sound: 'blunt', weight: 2 },
    ],
    color: '#4a5a2c',
  },
];

export const CREATURE_IDS = CREATURES.map((c) => c.id) as [string, ...string[]];

export const creatureById = (id: string): CreatureDef => {
  const c = CREATURES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown creature: ${id}`);
  return c;
};


/**
 * Curated fights, so `random` always gives a sensible one. Duels are ones the favourite wins about
 * 50-85% of the time (scripts/battle-matrix.ts); hordes are one big fighter against a stream of a
 * smaller kind (never people: a crowd of fighters that dodge and slash is too strong a swarm).
 */
export const DUELS = [
  ['bull', 'dragon'],
  ['unicorn', 'stag'],
  ['stag', 'horse'],
  ['stag', 'spider'],
  ['stag', 'king'],
  ['horse', 'king'],
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
  ['bear', 'lion'],
  ['croc', 'lion'],
  ['bear', 'croc'],
  ['bull', 'lion'],
  ['dragon', 'bear'],
  ['lion', 'horse'],
  ['lion', 'unicorn'],
  ['croc', 'unicorn'],
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
  ['bear', 'wolf'],
  ['bear', 'husky'],
  ['lion', 'husky'],
  ['croc', 'wolf'],
  ['croc', 'fox'],
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
