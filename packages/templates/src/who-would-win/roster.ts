/**
 * The fighters: everything the simulation needs (size, stats, moves and their timings) lives here, so
 * headless runs never build a model. Each move's `clip` names the motion its pose function draws
 * (proc/poses.ts) over `len` seconds; the view reads heights and species from the same table.
 *
 * Units: metres, seconds, kilograms. Damage and HP are in the same arbitrary points for everyone.
 */

/** What a blow does to a body: punctures (fangs, horns, tusks), cuts (claws, blades), blunt blows
 * (hooves, fists, clubs, a body slam), fire. Hides resist some and are weak to others. */
export type DamageType = 'pierce' | 'slash' | 'blunt' | 'fire';

/**
 * One special quality per fighter (shown on the VS card): each changes how it fights in one clear way.
 * The sim applies them (sim.ts, `trait ===` checks); TRAITS describes them.
 */
export type TraitId =
  | 'rampage'
  | 'hindKick'
  | 'healing'
  | 'antlerLock'
  | 'skittish'
  | 'stubborn'
  | 'woolly'
  | 'hamstring'
  | 'tireless'
  | 'sly'
  | 'riposte'
  | 'lastStand'
  | 'secondWind'
  | 'inferno'
  | 'paralysis'
  | 'pride'
  | 'unstoppable'
  | 'ambush'
  | 'ironGrip'
  | 'stealth'
  | 'juggernaut'
  | 'colossus'
  | 'berserk'
  | 'diveBomb'
  | 'regen'
  | 'shield';

export const TRAITS: Record<TraitId, { name: string; text: string }> = {
  rampage: { name: 'Rampage', text: 'charges harder and more often once hurt' },
  hindKick: { name: 'Hind kick', text: 'its kicks bowl foes over' },
  healing: { name: 'Healing light', text: 'its wounds slowly mend' },
  antlerLock: { name: 'Antler lock', text: 'wins shoving matches head to head' },
  skittish: { name: 'Skittish', text: 'reads blows and leaps clear' },
  stubborn: { name: 'Stubborn', text: 'hard to stagger, shove or knock down' },
  woolly: { name: 'Woolly', text: 'bites and claws sink into wool' },
  hamstring: { name: 'Hamstring', text: 'bites at the legs to cripple' },
  tireless: { name: 'Tireless', text: 'stays sharp to the very end' },
  sly: { name: 'Sly', text: 'darts in, bites, darts out' },
  riposte: { name: 'Riposte', text: 'strikes back the moment it dodges' },
  lastStand: { name: 'Last stand', text: 'fights hardest when nearly beaten' },
  secondWind: { name: 'Second wind', text: 'gets a second wind when nearly out' },
  inferno: { name: 'Inferno', text: 'its fire keeps burning' },
  paralysis: { name: 'Paralysing venom', text: 'poisoned foes slow down' },
  pride: { name: 'Pride', text: 'fiercer after it roars' },
  unstoppable: { name: 'Unstoppable', text: "can't be knocked off its feet" },
  ambush: { name: 'Ambush', text: 'its first strike always crits' },
  ironGrip: { name: 'Iron grip', text: 'its holds are hard to break' },
  stealth: { name: 'Stealth', text: 'its first pounce always crits' },
  juggernaut: { name: 'Juggernaut', text: 'its charge flattens anything smaller' },
  colossus: { name: 'Colossus', text: 'too big to knock down or pin' },
  berserk: { name: 'Berserk', text: 'faster and stronger when hurt' },
  diveBomb: { name: 'Dive bomber', text: 'swoops in talons first' },
  regen: { name: 'Regeneration', text: 'heals steadily, unless burned' },
  shield: { name: 'Shield', text: 'blocks blows from the front' },
};

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
  /** Edge-to-edge gap (body to body) across which its striking part can still touch the target. */
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
  /** What it does to a body (default: from the wound it leaves). */
  type?: DamageType;
  /** The wound it leaves (default from the sound: bites, claw rakes or sword cuts, bruises). */
  mark?: 'claw' | 'bite' | 'cut' | 'blunt' | 'gore';
  /** How much further it can lunge forward to its (first) hit (beyond a short step in): a lunge or a leap. */
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
  /** Struck from reared up: its striking part comes from this much higher (a bear's paws, an elephant's feet). */
  rise?: number;
  /** A finisher: its signature move, used once its fury is full (it always floors what it hits, unless
   * that can't be knocked down); `quake` knocks down everything else within that radius too. */
  finisher?: boolean;
  quake?: number;
  /** A roar: smaller enemies within the radius flinch (stagger) at the hit. No damage. */
  roar?: { radius: number };
  /** Only used on a target that is staggered or held. */
  needs?: 'targetDown';
  /** A charge that stops short this often (a bluff), sizing the target up instead. */
  bluff?: number;
}

/** A creature modelled and animated in code (proc/): its species and stride (m per gait cycle, walking / running). */
export const PROC_KINDS = ['lion', 'bear', 'croc', 'horse', 'unicorn', 'donkey', 'bull', 'stag', 'deer', 'alpaca', 'wolf', 'husky', 'fox', 'swordsman', 'king', 'brawler', 'dragon', 'spider', 'tiger', 'griffin', 'rhino', 'elephant', 'gorilla', 'minotaur', 'troll', 'viking'] as const;

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
  /** Shoving power (1 a fox .. 10 an elephant): wins body-to-body contests, holds or breaks grips,
   * sends foes flying. */
  strength: number;
  /** Its skin and what it shrugs off (a fraction of each kind of damage; negative: a weakness). */
  hide: { name: string; resist: Partial<Record<DamageType, number>> };
  trait: TraitId;
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
  voice?: { call: 'roar' | 'growl' | 'snarl' | 'hiss' | 'whinny' | 'bellow' | 'screech' | 'grunt' | 'trumpet'; pitch: number };
  /** What its footfalls sound like. */
  feet?: 'hoof' | 'paw' | 'foot';
  /** What it holds in its right hand (blades ring when they hit; a club thuds). */
  weapon?: 'sword' | 'axe' | 'club';
  /** Pound for pound: drawn and built this many times its usual size (see grownTo). */
  scale?: number;
  /** Horde: how well it holds out against a crowd (its HP when facing a horde, times this; default 1). A
   * dragon on the wing or an elephant shrugging off a pack lasts far longer than its duels suggest. */
  crowd?: number;
}


/** A rear hoof kick (the Quaternius animals' Attack_Kick is a buck: both hind legs out). */
const buck = (len: number, damage: number, knock: number, at = 0.6): MoveDef => ({
  name: 'Kick',
  clip: 'buck',
  len,
  hits: [{ at, back: true }],
  reach: 0.55,
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
    hp: 511,
    armor: 0.15,
    walk: 1.6,
    run: 7.5,
    turn: 2.2,
    poise: 70,
    strength: 9,
    hide: { name: 'Thick hide', resist: { blunt: 0.25 } },
    trait: 'rampage',
    proc: { kind: 'bull', stride: [1.5, 3.5] },
    moves: [
      { name: 'Gore', clip: 'headbutt', len: 1, hits: [{ at: 0.35 }], reach: 0.75, mark: 'gore', arc: 0.7, damage: 41, knock: 7, cooldown: 1.4, sound: 'blunt', lunge: 0.6, weight: 2 },
      { name: 'Charge', clip: 'charge', len: 1, hits: [{ at: 0.35 }], reach: 0.75, mark: 'gore', arc: 0.6, damage: 47.4, knock: 10, cooldown: 5, sound: 'blunt', minRange: 3.5, charge: true, weight: 3 },
      buck(1, 32.8, 7),
      { name: 'Stampede', clip: 'charge', len: 1, hits: [{ at: 0.35 }], reach: 0.8, mark: 'gore', arc: 0.6, damage: 103.9, knock: 15, cooldown: 1, sound: 'blunt', minRange: 2.5, charge: true, finisher: true },
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
    hp: 452,
    armor: 0.05,
    walk: 1.7,
    run: 9.5,
    turn: 2.6,
    poise: 45,
    strength: 6,
    hide: { name: 'Short coat', resist: {} },
    trait: 'hindKick',
    proc: { kind: 'horse', stride: [1.6, 4.0] },
    moves: [
      { name: 'Bite', clip: 'bite', len: 1, hits: [{ at: 0.35 }], reach: 0.5, arc: 0.6, damage: 25, knock: 2, cooldown: 2, sound: 'bite', lunge: 0.3, weight: 0.7 },
      // (Rears and strikes down with its front hooves.)
      { name: 'Hoof strike', clip: 'stomp', len: 1.1, hits: [{ at: 0.55 }], reach: 0.6, arc: 0.8, damage: 46.2, knock: 6, cooldown: 2, sound: 'hoof', rise: 0.5, weight: 2 },
      { ...buck(1, 50, 8), weight: 2.5 },
      { name: 'Rearing Hooves', clip: 'stomp', len: 1.2, hits: [{ at: 0.55 }], reach: 0.6, arc: 0.8, damage: 123, knock: 10, cooldown: 1, sound: 'hoof', rise: 0.5, finisher: true },
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
    hp: 429,
    armor: 0.08,
    walk: 1.7,
    run: 10,
    turn: 2.8,
    poise: 45,
    strength: 6,
    hide: { name: 'Shimmering coat', resist: { fire: 0.4, slash: 0.1 } },
    trait: 'healing',
    proc: { kind: 'unicorn', stride: [1.6, 4.0] },
    moves: [
      { name: 'Horn', clip: 'headbutt', len: 1, hits: [{ at: 0.35 }], reach: 0.8, mark: 'gore', arc: 0.45, damage: 39, knock: 5, cooldown: 1.3, sound: 'slash', lunge: 0.5, weight: 2 },
      { name: 'Horn charge', clip: 'charge', len: 1, hits: [{ at: 0.35 }], reach: 0.8, mark: 'gore', arc: 0.4, damage: 42.9, knock: 8, cooldown: 5, sound: 'slash', minRange: 3.5, charge: true, weight: 3 },
      buck(1, 39, 7),
      { name: 'Radiant Lance', clip: 'charge', len: 1, hits: [{ at: 0.35 }], reach: 0.85, mark: 'gore', arc: 0.5, damage: 94.6, knock: 12, cooldown: 1, sound: 'slash', minRange: 2.5, charge: true, finisher: true },
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
    hp: 318,
    armor: 0.05,
    walk: 1.6,
    run: 10.5,
    turn: 3,
    poise: 30,
    strength: 5,
    hide: { name: 'Coarse coat', resist: { pierce: 0.1 } },
    trait: 'antlerLock',
    proc: { kind: 'stag', stride: [1.5, 3.8] },
    moves: [
      { name: 'Antlers', clip: 'headbutt', len: 0.792, hits: [{ at: 0.35 }], reach: 0.7, mark: 'gore', arc: 0.7, damage: 43.7, knock: 5, cooldown: 1.1, sound: 'blunt', lunge: 0.5, weight: 2 },
      { name: 'Antler charge', clip: 'charge', len: 0.792, hits: [{ at: 0.35 }], reach: 0.7, mark: 'gore', arc: 0.6, damage: 41.7, knock: 7, cooldown: 4.5, sound: 'blunt', minRange: 3.5, charge: true, weight: 3 },
      buck(0.792, 28.8, 5),
      { name: 'Antler Toss', clip: 'toss', len: 1, hits: [{ at: 0.45 }], reach: 0.75, mark: 'gore', arc: 0.7, damage: 96.3, knock: 13, cooldown: 1, sound: 'blunt', lunge: 0.5, finisher: true },
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
    strength: 2.5,
    hide: { name: 'Thin coat', resist: { slash: -0.15 } },
    trait: 'skittish',
    proc: { kind: 'deer', stride: [1.3, 3.5] },
    moves: [
      { name: 'Headbutt', clip: 'headbutt', len: 0.792, hits: [{ at: 0.35 }], reach: 0.45, arc: 0.7, damage: 13, knock: 2, cooldown: 1, sound: 'blunt', lunge: 0.3 },
      buck(0.792, 20, 4),
      { name: 'Desperate Kick', clip: 'buck', len: 0.8, hits: [{ at: 0.6, back: true }], reach: 0.55, arc: 0.9, damage: 44, knock: 9, cooldown: 1, sound: 'hoof', finisher: true },
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
    hp: 250,
    armor: 0.1,
    walk: 1.4,
    run: 7,
    turn: 2.8,
    poise: 32,
    strength: 5,
    hide: { name: 'Tough hide', resist: { blunt: 0.15, pierce: 0.1 } },
    trait: 'stubborn',
    proc: { kind: 'donkey', stride: [1.3, 3.2] },
    moves: [
      // The donkey's headbutt clip is a headbutt and then a buck, in one.
      { name: 'Headbutt and buck', clip: 'combo', len: 1.583, hits: [{ at: 0.15 }, { at: 0.75, back: true }], reach: 0.55, arc: 0.8, damage: 29.6, knock: 4, cooldown: 2.2, sound: 'hoof', weight: 1.5 },
      { ...buck(0.792, 48.2, 7, 0.55), weight: 2 },
      { name: 'Mule Kick', clip: 'buck', len: 0.8, hits: [{ at: 0.55, back: true }], reach: 0.6, arc: 0.9, damage: 106.6, knock: 12, cooldown: 1, sound: 'hoof', finisher: true },
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
    hp: 147,
    armor: 0.05,
    walk: 1.4,
    run: 8.5,
    turn: 3,
    poise: 15,
    strength: 3,
    hide: { name: 'Thick wool', resist: { pierce: 0.3, slash: 0.25, fire: -0.3 } },
    trait: 'woolly',
    proc: { kind: 'alpaca', stride: [1.2, 3.0] },
    moves: [
      { name: 'Headbutt', clip: 'headbutt', len: 1, hits: [{ at: 0.35 }], reach: 0.45, arc: 0.7, damage: 12.7, knock: 2, cooldown: 1.1, sound: 'blunt', lunge: 0.3 },
      buck(1, 18.6, 4),
      { name: 'Stomping Fury', clip: 'stomp', len: 1.1, hits: [{ at: 0.55 }], reach: 0.5, arc: 0.8, damage: 41.2, knock: 6, cooldown: 1, sound: 'hoof', rise: 0.4, finisher: true },
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
    hp: 137,
    armor: 0,
    walk: 1.5,
    run: 11,
    turn: 4.5,
    poise: 14,
    strength: 3,
    hide: { name: 'Dense fur', resist: { slash: 0.1 } },
    trait: 'hamstring',
    proc: { kind: 'wolf', stride: [1.1, 2.8] },
    moves: [
      { name: 'Bite', clip: 'bite', len: 1.333, hits: [{ at: 0.5 }], reach: 0.45, arc: 0.6, damage: 32.5, knock: 1, cooldown: 1.2, sound: 'bite', lunge: 0.9 },
      { name: 'Throat Lock', clip: 'bite', len: 1, hits: [{ at: 0.45 }], reach: 0.45, arc: 0.6, damage: 45.6, knock: 1, cooldown: 1, sound: 'bite', lunge: 1, grab: { kind: 'pin', seconds: 2, dps: 30.4 }, finisher: true },
    ],
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
    strength: 2,
    hide: { name: 'Double coat', resist: { slash: 0.15, pierce: 0.1 } },
    trait: 'tireless',
    proc: { kind: 'husky', stride: [1.0, 2.5] },
    moves: [
      { name: 'Bite', clip: 'bite', len: 1.167, hits: [{ at: 0.5 }], reach: 0.4, arc: 0.6, damage: 16, knock: 1, cooldown: 1.1, sound: 'bite', lunge: 0.7 },
      { name: 'Frenzy', clip: 'frenzy', len: 1.2, hits: [{ at: 0.3 }, { at: 0.55 }, { at: 0.8 }], reach: 0.4, arc: 0.7, damage: 14, knock: 2, cooldown: 1, sound: 'bite', lunge: 0.6, finisher: true },
    ],
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
    strength: 1,
    hide: { name: 'Light fur', resist: {} },
    trait: 'sly',
    proc: { kind: 'fox', stride: [0.7, 1.9] },
    moves: [
      { name: 'Bite', clip: 'bite', len: 1.333, hits: [{ at: 0.5 }], reach: 0.3, arc: 0.6, damage: 10, knock: 0.5, cooldown: 1, sound: 'bite', lunge: 0.6 },
      { name: 'Fox Frenzy', clip: 'frenzy', len: 1.1, hits: [{ at: 0.3 }, { at: 0.55 }, { at: 0.8 }], reach: 0.3, arc: 0.7, damage: 9, knock: 1, cooldown: 1, sound: 'bite', lunge: 0.5, finisher: true },
    ],
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
    hp: 184,
    armor: 0.15,
    walk: 1.4,
    run: 5.5,
    turn: 7,
    poise: 24,
    strength: 3,
    hide: { name: 'Leather jerkin', resist: { slash: 0.15 } },
    trait: 'riposte',
    proc: { kind: 'swordsman', stride: [1.3, 2.6] },
    dodge: { len: 1, chance: 0.35, cooldown: 2.5, distance: 1.6 },
    moves: [
      { name: 'Slash', clip: 'slash', len: 1.292, hits: [{ at: 0.4 }], reach: 0.95, arc: 1.2, damage: 71.6, knock: 2.5, cooldown: 1.1, sound: 'slash', lunge: 0.4, weight: 3 },
      { name: 'Kick', clip: 'kick', len: 1.167, hits: [{ at: 0.5 }], reach: 0.45, arc: 0.6, damage: 22, knock: 4, cooldown: 2, sound: 'blunt' },
      { name: 'Whirlwind', clip: 'whirl', len: 1.2, hits: [{ at: 0.35 }, { at: 0.7 }], reach: 0.9, arc: Math.PI, damage: 86.3, knock: 6, cooldown: 1, sound: 'slash', lunge: 0.4, finisher: true },
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
    hp: 194,
    armor: 0.1,
    walk: 1.3,
    run: 4.8,
    turn: 6,
    poise: 28,
    strength: 3,
    hide: { name: 'Royal mail', resist: { slash: 0.35, pierce: 0.15, blunt: -0.1 } },
    trait: 'lastStand',
    proc: { kind: 'king', stride: [1.3, 2.6] },
    dodge: { len: 0.792, chance: 0.2, cooldown: 3, distance: 1.3 },
    moves: [
      { name: 'Royal slash', clip: 'slash', len: 1, hits: [{ at: 0.4 }], reach: 0.9, arc: 1.2, damage: 62, knock: 2.5, cooldown: 1.1, sound: 'slash', lunge: 0.3, weight: 3 },
      { name: 'Punch', clip: 'punch_r', len: 0.833, hits: [{ at: 0.5 }], reach: 0.35, arc: 0.6, damage: 17.4, knock: 2, cooldown: 1.5, sound: 'blunt' },
      { name: 'Royal Decree', clip: 'chop', len: 1.2, hits: [{ at: 0.45 }], reach: 0.95, arc: 1.0, damage: 136.5, knock: 9, cooldown: 1, sound: 'slash', lunge: 0.4, finisher: true },
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
    hp: 180,
    armor: 0.05,
    walk: 1.4,
    run: 6,
    turn: 7,
    poise: 22,
    strength: 3.5,
    hide: { name: 'Bare skin', resist: { blunt: 0.1, slash: -0.2 } },
    trait: 'secondWind',
    proc: { kind: 'brawler', stride: [1.3, 2.6] },
    dodge: { len: 0.792, chance: 0.45, cooldown: 2, distance: 1.5 },
    moves: [
      { name: 'Jab', clip: 'punch_l', len: 0.833, hits: [{ at: 0.4 }], reach: 0.35, arc: 0.6, damage: 22.2, knock: 1.5, cooldown: 0.7, sound: 'blunt', weight: 2 },
      { name: 'Cross', clip: 'punch_r', len: 0.833, hits: [{ at: 0.5 }], reach: 0.35, arc: 0.6, damage: 29.9, knock: 2, cooldown: 1, sound: 'blunt', weight: 2 },
      { name: 'Kick', clip: 'kick', len: 0.917, hits: [{ at: 0.5 }], reach: 0.5, arc: 0.6, damage: 39.4, knock: 5, cooldown: 1.6, sound: 'blunt', weight: 1.5 },
      { name: 'Haymaker', clip: 'punch_r', len: 1.2, hits: [{ at: 0.62 }], reach: 0.4, arc: 0.6, damage: 86.4, knock: 11, cooldown: 1, sound: 'blunt', lunge: 0.3, finisher: true },
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
    hp: 510,
    crowd: 1.35,
    armor: 0.1,
    walk: 2,
    run: 6.5,
    turn: 2,
    poise: 110,
    strength: 9,
    hide: { name: 'Dragon scales', resist: { slash: 0.3, pierce: 0.2, fire: 0.9 } },
    trait: 'inferno',
    proc: { kind: 'dragon', stride: [1.4, 3.0] },
    moves: [
      { name: 'Bite', clip: 'bite', len: 0.875, hits: [{ at: 0.3 }], reach: 0.6, arc: 0.7, damage: 50.5, knock: 7, cooldown: 1.6, sound: 'bite', lunge: 0.5, weight: 2 },
      { name: 'Fire breath', clip: 'breath', len: 1.667, hits: [{ at: 0.3 }], breath: { until: 0.75 }, reach: 5, arc: 0.55, damage: 5.7, knock: 0.6, cooldown: 4, sound: 'blunt', minRange: 0.5, weight: 3 },
      { name: 'Firestorm', clip: 'breath', len: 2, hits: [{ at: 0.25 }], breath: { until: 0.85 }, reach: 6, arc: 0.9, damage: 10.1, knock: 1, cooldown: 1, sound: 'blunt', minRange: 0.3, finisher: true },
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
    radius: 0.75,
    front: 0.75,
    back: 1.15,
    mass: 160,
    hp: 370,
    armor: 0.12,
    walk: 1.8,
    run: 8,
    turn: 4,
    poise: 40,
    strength: 3.5,
    hide: { name: 'Chitin', resist: { slash: 0.3, blunt: -0.2 } },
    trait: 'paralysis',
    proc: { kind: 'spider', stride: [1.0, 2.0] },
    moves: [
      { name: 'Venom bite', clip: 'bite', len: 0.75, hits: [{ at: 0.55 }], reach: 0.35, arc: 0.7, damage: 37.8, knock: 2, cooldown: 1.2, sound: 'bite', lunge: 0.4, poison: 5, weight: 2 },
      { name: 'Leap', clip: 'leap', len: 0.708, hits: [{ at: 0.75 }], reach: 0.4, arc: 0.8, damage: 46.8, knock: 5, cooldown: 4, sound: 'blunt', lunge: 4, minRange: 2.2, weight: 3 },
      { name: 'Venom Leap', clip: 'leap', len: 0.8, hits: [{ at: 0.75 }], reach: 0.4, arc: 0.8, damage: 102.6, knock: 6, cooldown: 1, sound: 'bite', lunge: 4.5, minRange: 1.8, poison: 14, finisher: true },
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
    hp: 421,
    armor: 0.05,
    walk: 1.6,
    run: 12,
    turn: 4.5,
    poise: 30,
    strength: 6,
    hide: { name: 'Mane', resist: { pierce: 0.15 } },
    trait: 'pride',
    proc: { kind: 'lion', stride: [1.1, 3.2] },
    ai: 'stalker',
    moves: [
      { name: 'Claw swipe', clip: 'swipe', len: 0.7, hits: [{ at: 0.45 }], reach: 0.3, arc: 0.9, damage: 41.6, knock: 3, cooldown: 1, sound: 'slash', weight: 2 },
      { name: 'Bite', clip: 'bite', len: 0.8, hits: [{ at: 0.5 }], reach: 0.4, arc: 0.6, damage: 56.1, knock: 1.5, cooldown: 1.4, sound: 'bite', lunge: 0.4, weight: 2 },
      { name: 'Pounce', clip: 'pounce', len: 1.1, hits: [{ at: 0.62 }], reach: 0.45, arc: 0.7, damage: 37.4, knock: 1, cooldown: 5, sound: 'bite', lunge: 4.2, minRange: 2.2, grab: { kind: 'latch', seconds: 2.6, dps: 22.9 }, weight: 4 },
      { name: 'Roar', clip: 'roar', len: 1.2, hits: [{ at: 0.35 }], reach: 4.5, arc: Math.PI, damage: 0, knock: 0, cooldown: 14, sound: 'blunt', roar: { radius: 4.5 }, weight: 1 },
      { name: 'Mauling Leap', clip: 'pounce', len: 1.1, hits: [{ at: 0.62 }], reach: 0.45, arc: 0.7, damage: 79, knock: 2, cooldown: 1, sound: 'bite', lunge: 4.8, minRange: 1.8, grab: { kind: 'latch', seconds: 3, dps: 31.1 }, finisher: true },
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
    hp: 519,
    armor: 0.1,
    walk: 1.5,
    run: 9.5,
    turn: 2.8,
    poise: 55,
    strength: 8,
    hide: { name: 'Fat and fur', resist: { blunt: 0.3, slash: 0.15 } },
    trait: 'unstoppable',
    proc: { kind: 'bear', stride: [1.0, 2.8] },
    ai: 'brute',
    moves: [
      { name: 'Swipe', clip: 'swipe', len: 0.8, hits: [{ at: 0.5 }], reach: 0.35, arc: 1, damage: 58.5, knock: 5, cooldown: 1.3, sound: 'slash', weight: 2 },
      { name: 'Rear up', clip: 'rear', len: 1.7, hits: [{ at: 0.45 }, { at: 0.68 }], reach: 0.4, rise: 0.55, arc: 1.3, damage: 74, knock: 8, cooldown: 4.5, sound: 'blunt', armor: 0.5, weight: 3 },
      { name: 'Bite', clip: 'bite', len: 0.9, hits: [{ at: 0.55 }], reach: 0.4, arc: 0.6, damage: 48.6, knock: 2, cooldown: 1.6, sound: 'bite', lunge: 0.3, weight: 1.5 },
      { name: 'Charge', clip: 'charge', len: 0.8, hits: [{ at: 0.35 }], reach: 0.5, arc: 0.7, damage: 76.2, knock: 9, cooldown: 7, sound: 'blunt', minRange: 3.5, charge: true, bluff: 0.35, weight: 3 },
      { name: 'Maul', clip: 'maul', len: 1.3, hits: [{ at: 0.3 }], reach: 0.4, arc: 0.9, damage: 28.7, knock: 0, cooldown: 6, sound: 'bite', needs: 'targetDown', grab: { kind: 'pin', seconds: 1.4, dps: 24.3 }, weight: 5 },
      { name: 'Roar', clip: 'roar', len: 1.4, hits: [{ at: 0.4 }], reach: 4.5, arc: Math.PI, damage: 0, knock: 0, cooldown: 14, sound: 'blunt', roar: { radius: 4.5 }, weight: 1 },
      { name: 'Grizzly Crush', clip: 'rear', len: 1.7, hits: [{ at: 0.45 }, { at: 0.68 }], reach: 0.45, rise: 0.55, arc: 1.3, damage: 167.8, knock: 10, cooldown: 1, sound: 'blunt', armor: 0.5, quake: 2, finisher: true },
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
    // (Its long, low snout: others can stand over it.)
    front: 1.1,
    back: 0.85,
    mass: 450,
    hp: 409,
    armor: 0.12,
    walk: 1,
    run: 4.5,
    turn: 1.6,
    poise: 60,
    strength: 6.5,
    hide: { name: 'Armoured scutes', resist: { slash: 0.4, pierce: 0.25, blunt: 0.1 } },
    trait: 'ambush',
    proc: { kind: 'croc', stride: [0.7, 0.9] },
    ai: 'ambusher',
    moves: [
      { name: 'Lunge bite', clip: 'lunge', len: 0.9, hits: [{ at: 0.4 }], reach: 0.35, arc: 0.45, damage: 49.5, knock: 2, cooldown: 2.2, sound: 'bite', lunge: 1.8, grab: { kind: 'roll', seconds: 1.6, dps: 16, chance: 0.4 }, weight: 3 },
      { name: 'Snap', clip: 'snap', len: 0.6, hits: [{ at: 0.45 }], reach: 0.3, arc: 0.5, damage: 27.9, knock: 1, cooldown: 1.2, sound: 'bite', lunge: 0.2, weight: 2 },
      { name: 'Tail whip', clip: 'tail', len: 0.9, hits: [{ at: 0.45, back: true }], reach: 1.5, arc: 1.4, damage: 30.6, knock: 7, cooldown: 2.5, sound: 'blunt', weight: 2 },
      { name: 'Death Roll', clip: 'lunge', len: 0.9, hits: [{ at: 0.4 }], reach: 0.4, arc: 0.5, damage: 69.3, knock: 1, cooldown: 1, sound: 'bite', lunge: 2.2, grab: { kind: 'roll', seconds: 2.4, dps: 30 }, finisher: true },
    ],
    color: '#4a5a2c',
  },

  {
    id: 'tiger',
    label: 'Tiger',
    plural: 'Tigers',
    icon: '🐅',
    voice: { call: 'roar', pitch: 0.35 },
    feet: 'paw',
    height: 1.5,
    radius: 0.45,
    front: 1.45,
    back: 0.92,
    mass: 230,
    hp: 446,
    armor: 0.05,
    walk: 1.6,
    run: 12,
    turn: 4.5,
    poise: 32,
    strength: 6.5,
    hide: { name: 'Sleek coat', resist: {} },
    trait: 'stealth',
    proc: { kind: 'tiger', stride: [1.2, 3.4] },
    ai: 'stalker',
    moves: [
      { name: 'Claw swipe', clip: 'swipe', len: 0.7, hits: [{ at: 0.45 }], reach: 0.3, arc: 0.9, damage: 45.6, knock: 3.5, cooldown: 1, sound: 'slash', weight: 2 },
      { name: 'Throat bite', clip: 'bite', len: 0.8, hits: [{ at: 0.5 }], reach: 0.4, arc: 0.6, damage: 58, knock: 1.5, cooldown: 1.6, sound: 'bite', lunge: 0.4, grab: { kind: 'pin', seconds: 1.4, dps: 20.7, chance: 0.3 }, weight: 2 },
      { name: 'Pounce', clip: 'pounce', len: 1.1, hits: [{ at: 0.62 }], reach: 0.45, arc: 0.7, damage: 42.5, knock: 1, cooldown: 5, sound: 'bite', lunge: 4.6, minRange: 2.2, grab: { kind: 'latch', seconds: 2.6, dps: 24.9 }, weight: 4 },
      { name: 'Roar', clip: 'roar', len: 1.2, hits: [{ at: 0.35 }], reach: 4.5, arc: Math.PI, damage: 0, knock: 0, cooldown: 14, sound: 'blunt', roar: { radius: 4.5 }, weight: 1 },
      { name: 'Killing Pounce', clip: 'pounce', len: 1.1, hits: [{ at: 0.62 }], reach: 0.45, arc: 0.7, damage: 80.8, knock: 2, cooldown: 1, sound: 'bite', lunge: 5, minRange: 1.8, grab: { kind: 'latch', seconds: 3, dps: 33.2 }, finisher: true },
    ],
    color: '#d8782c',
  },
  {
    id: 'griffin',
    label: 'Griffin',
    plural: 'Griffins',
    icon: '🦅',
    voice: { call: 'screech', pitch: 0.55 },
    feet: 'paw',
    height: 1.5,
    radius: 0.5,
    front: 1.4,
    back: 1.0,
    hover: 0.8,
    mass: 300,
    hp: 477,
    armor: 0.05,
    walk: 1.8,
    run: 9,
    turn: 3.2,
    poise: 45,
    strength: 6,
    hide: { name: 'Feathers', resist: { slash: 0.1, fire: -0.3 } },
    trait: 'diveBomb',
    proc: { kind: 'griffin', stride: [1.2, 3.0] },
    moves: [
      { name: 'Beak strike', clip: 'bite', len: 0.8, hits: [{ at: 0.32 }], reach: 0.55, arc: 0.7, damage: 49.8, knock: 3, cooldown: 1.3, sound: 'bite', lunge: 0.4, weight: 2 },
      { name: 'Talon rake', clip: 'swipe', len: 0.7, hits: [{ at: 0.45 }], reach: 0.35, arc: 0.9, damage: 45.2, knock: 4, cooldown: 1.2, sound: 'slash', weight: 2 },
      { name: 'Talon dive', clip: 'dive', len: 1, hits: [{ at: 0.6 }], reach: 0.45, arc: 0.8, damage: 70.6, knock: 7, cooldown: 4.5, sound: 'slash', lunge: 3.6, minRange: 2.5, weight: 4 },
      { name: 'Sky Dive', clip: 'dive', len: 1, hits: [{ at: 0.6 }], reach: 0.45, arc: 0.8, damage: 155.3, knock: 10, cooldown: 1, sound: 'slash', lunge: 4.5, minRange: 2, finisher: true },
    ],
    color: '#c49a5c',
  },
  {
    id: 'rhino',
    label: 'Rhino',
    plural: 'Rhinos',
    icon: '🦏',
    voice: { call: 'grunt', pitch: 0.05 },
    feet: 'hoof',
    height: 1.87,
    radius: 0.6,
    front: 1.75,
    back: 1.15,
    mass: 2000,
    hp: 443,
    crowd: 1.2,
    armor: 0.08,
    walk: 1.4,
    run: 8,
    turn: 1.7,
    poise: 110,
    strength: 9.5,
    hide: { name: 'Armour-plated hide', resist: { slash: 0.45, pierce: 0.3, blunt: 0.15 } },
    trait: 'juggernaut',
    proc: { kind: 'rhino', stride: [1.3, 3.0] },
    moves: [
      { name: 'Horn jab', clip: 'headbutt', len: 0.9, hits: [{ at: 0.38 }], reach: 0.8, mark: 'gore', arc: 0.6, damage: 35, knock: 8, cooldown: 1.4, sound: 'blunt', lunge: 0.5, weight: 2 },
      { name: 'Horn toss', clip: 'toss', len: 1.1, hits: [{ at: 0.45 }], reach: 0.8, mark: 'gore', arc: 0.6, damage: 29.5, knock: 11, cooldown: 2.6, sound: 'blunt', lunge: 0.4, weight: 1.5 },
      { name: 'Charge', clip: 'charge', len: 1, hits: [{ at: 0.35 }], reach: 0.8, mark: 'gore', arc: 0.6, damage: 44.3, knock: 12, cooldown: 5, sound: 'blunt', minRange: 3.5, charge: true, weight: 3 },
      { name: 'Juggernaut', clip: 'charge', len: 1, hits: [{ at: 0.35 }], reach: 0.85, mark: 'gore', arc: 0.7, damage: 97.7, knock: 16, cooldown: 1, sound: 'blunt', minRange: 2.5, charge: true, quake: 1.6, finisher: true },
    ],
    color: '#7d776e',
  },
  {
    id: 'elephant',
    label: 'Elephant',
    plural: 'Elephants',
    icon: '🐘',
    voice: { call: 'trumpet', pitch: 0.4 },
    feet: 'hoof',
    height: 3.4,
    radius: 0.85,
    front: 2.1,
    back: 1.45,
    mass: 5000,
    hp: 700,
    crowd: 1.3,
    armor: 0.08,
    walk: 1.4,
    run: 6,
    turn: 1.3,
    poise: 200,
    strength: 10,
    hide: { name: 'Wrinkled hide', resist: { slash: 0.25, pierce: 0.15, blunt: 0.2 } },
    trait: 'colossus',
    proc: { kind: 'elephant', stride: [1.6, 2.8] },
    moves: [
      { name: 'Tusk gore', clip: 'headbutt', len: 1.1, hits: [{ at: 0.4 }], reach: 0.9, mark: 'gore', arc: 0.6, damage: 47.8, knock: 9, cooldown: 1.7, sound: 'blunt', lunge: 0.5, weight: 2 },
      { name: 'Trunk swat', clip: 'swat', len: 1, hits: [{ at: 0.42 }], reach: 1.1, arc: 1.2, damage: 31.3, knock: 12, cooldown: 1.8, sound: 'blunt', weight: 2 },
      // (Anything small enough to be under its feet gets trampled: its tusks and trunk don't reach that low.)
      { name: 'Trample', clip: 'stomp', len: 1.2, hits: [{ at: 0.55 }], reach: 0.7, arc: 0.9, damage: 58, knock: 5, cooldown: 1.6, sound: 'blunt', rise: 0.5, weight: 3 },
      { name: 'Stomp', clip: 'stomp', len: 1.3, hits: [{ at: 0.55 }], reach: 0.6, arc: 0.8, damage: 72.7, knock: 2, cooldown: 3, sound: 'blunt', rise: 0.5, needs: 'targetDown', weight: 5 },
      { name: 'Trumpet', clip: 'roar', len: 1.4, hits: [{ at: 0.4 }], reach: 5, arc: Math.PI, damage: 0, knock: 0, cooldown: 14, sound: 'blunt', roar: { radius: 5 }, weight: 1 },
      { name: 'Earthquake', clip: 'stomp', len: 1.4, hits: [{ at: 0.6 }], reach: 0.7, arc: 1, damage: 160.1, knock: 6, cooldown: 1, sound: 'blunt', rise: 0.6, quake: 4, finisher: true },
    ],
    color: '#8a8580',
  },
  {
    id: 'gorilla',
    label: 'Gorilla',
    plural: 'Gorillas',
    icon: '🦍',
    voice: { call: 'roar', pitch: 0.3 },
    feet: 'foot',
    height: 1.75,
    radius: 0.42,
    front: 0.6,
    back: 0.45,
    mass: 180,
    hp: 366,
    armor: 0.05,
    walk: 1.4,
    run: 6.5,
    turn: 4.5,
    poise: 34,
    strength: 8,
    hide: { name: 'Muscle', resist: { blunt: 0.2 } },
    trait: 'ironGrip',
    proc: { kind: 'gorilla', stride: [1.1, 2.4] },
    ai: 'brute',
    moves: [
      { name: 'Pummel', clip: 'pummel', len: 0.9, hits: [{ at: 0.5 }], reach: 0.4, arc: 0.8, damage: 62.2, knock: 6, cooldown: 1.3, sound: 'blunt', rise: 0.3, weight: 3 },
      { name: 'Bite', clip: 'bite', len: 0.8, hits: [{ at: 0.5 }], reach: 0.35, arc: 0.6, damage: 48, knock: 1, cooldown: 1.5, sound: 'bite', lunge: 0.3, weight: 1 },
      { name: 'Grab and pound', clip: 'grapple', len: 0.9, hits: [{ at: 0.45 }], reach: 0.4, arc: 0.7, damage: 28.4, knock: 0, cooldown: 6, sound: 'blunt', grab: { kind: 'pin', seconds: 1.8, dps: 24.5, chance: 0.6 }, weight: 2.5 },
      { name: 'Chest beat', clip: 'beat', len: 1.4, hits: [{ at: 0.45 }], reach: 4.5, arc: Math.PI, damage: 0, knock: 0, cooldown: 14, sound: 'blunt', roar: { radius: 4.5 }, weight: 1 },
      { name: 'Silverback Slam', clip: 'pummel', len: 1.1, hits: [{ at: 0.55 }], reach: 0.45, arc: 0.9, damage: 136.4, knock: 9, cooldown: 1, sound: 'blunt', rise: 0.35, quake: 2.5, finisher: true },
    ],
    color: '#2a2726',
  },
  {
    id: 'minotaur',
    label: 'Minotaur',
    plural: 'Minotaurs',
    icon: '🐃',
    voice: { call: 'bellow', pitch: 0.2 },
    feet: 'hoof',
    weapon: 'axe',
    height: 2.3,
    radius: 0.45,
    front: 0.6,
    back: 0.45,
    mass: 320,
    hp: 529,
    armor: 0.1,
    walk: 1.5,
    run: 7,
    turn: 4,
    poise: 50,
    strength: 7.5,
    hide: { name: 'Bull hide', resist: { blunt: 0.1 } },
    trait: 'berserk',
    proc: { kind: 'minotaur', stride: [1.6, 3.1] },
    moves: [
      { name: 'Axe chop', clip: 'chop', len: 1.2, hits: [{ at: 0.45 }], reach: 1.0, arc: 1.0, damage: 67.7, knock: 4, cooldown: 1.5, sound: 'slash', lunge: 0.4, weight: 3 },
      { name: 'Horn charge', clip: 'charge', len: 1, hits: [{ at: 0.35 }], reach: 0.6, mark: 'gore', arc: 0.6, damage: 62.8, knock: 10, cooldown: 5, sound: 'blunt', minRange: 3.5, charge: true, weight: 3 },
      { name: 'Kick', clip: 'kick', len: 1, hits: [{ at: 0.5 }], reach: 0.5, arc: 0.6, damage: 28.3, knock: 6, cooldown: 2, sound: 'blunt', weight: 1 },
      { name: 'Labyrinth Rush', clip: 'charge', len: 1, hits: [{ at: 0.35 }], reach: 0.65, mark: 'gore', arc: 0.6, damage: 148.9, knock: 14, cooldown: 1, sound: 'blunt', minRange: 2.5, charge: true, finisher: true },
    ],
    color: '#6a4430',
  },
  {
    id: 'troll',
    label: 'Troll',
    plural: 'Trolls',
    icon: '👹',
    voice: { call: 'roar', pitch: 0.0 },
    feet: 'foot',
    weapon: 'club',
    height: 2.55,
    radius: 0.5,
    front: 0.62,
    back: 0.5,
    mass: 450,
    hp: 418,
    crowd: 1.25,
    armor: 0.05,
    walk: 1.2,
    run: 4.5,
    turn: 3,
    poise: 70,
    strength: 7.5,
    hide: { name: 'Stone skin', resist: { blunt: 0.3, slash: 0.2, fire: -0.4 } },
    trait: 'regen',
    proc: { kind: 'troll', stride: [1.7, 2.7] },
    ai: 'brute',
    moves: [
      { name: 'Club smash', clip: 'club', len: 1.4, hits: [{ at: 0.48 }], reach: 1.1, arc: 1.0, damage: 46.3, knock: 10, cooldown: 1.9, sound: 'blunt', lunge: 0.3, weight: 3 },
      { name: 'Backhand', clip: 'backhand', len: 0.9, hits: [{ at: 0.45 }], reach: 0.55, arc: 1.1, damage: 20.3, knock: 8, cooldown: 1.4, sound: 'blunt', weight: 2 },
      { name: 'Stomp', clip: 'stomp', len: 1.1, hits: [{ at: 0.55 }], reach: 0.5, arc: 0.8, damage: 40.7, knock: 2, cooldown: 3, sound: 'blunt', needs: 'targetDown', weight: 4 },
      { name: 'Earthshaker', clip: 'club', len: 1.5, hits: [{ at: 0.5 }], reach: 1.1, arc: 1.1, damage: 101.7, knock: 10, cooldown: 1, sound: 'blunt', lunge: 0.3, quake: 3, finisher: true },
    ],
    color: '#6f7a5c',
  },
  {
    id: 'viking',
    label: 'Viking',
    plural: 'Vikings',
    icon: '🛡️',
    voice: { call: 'grunt', pitch: 0.3 },
    feet: 'foot',
    weapon: 'axe',
    height: 1.96,
    radius: 0.38,
    mass: 95,
    hp: 206,
    armor: 0.08,
    walk: 1.4,
    run: 5.5,
    turn: 6.5,
    poise: 30,
    strength: 3.5,
    hide: { name: 'Chain mail', resist: { slash: 0.3, pierce: 0.1 } },
    trait: 'shield',
    proc: { kind: 'viking', stride: [1.3, 2.6] },
    moves: [
      { name: 'Axe chop', clip: 'chop', len: 1.1, hits: [{ at: 0.45 }], reach: 0.85, arc: 1.0, damage: 72.5, knock: 3, cooldown: 1.3, sound: 'slash', lunge: 0.4, weight: 3 },
      { name: 'Shield bash', clip: 'bash', len: 0.8, hits: [{ at: 0.45 }], reach: 0.45, arc: 0.7, damage: 25.5, knock: 7, cooldown: 2, sound: 'blunt', lunge: 0.4, weight: 1.5 },
      { name: 'Kick', clip: 'kick', len: 1, hits: [{ at: 0.5 }], reach: 0.45, arc: 0.6, damage: 22.5, knock: 4, cooldown: 2, sound: 'blunt', weight: 0.7 },
      { name: 'Shield Breaker', clip: 'chop', len: 1.2, hits: [{ at: 0.45 }], reach: 0.9, arc: 1.0, damage: 159.6, knock: 9, cooldown: 1, sound: 'slash', lunge: 0.4, finisher: true },
    ],
    color: '#a83a2a',
  },
];

export const CREATURE_IDS = CREATURES.map((c) => c.id) as [string, ...string[]];

export const creatureById = (id: string): CreatureDef => {
  const c = CREATURES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown creature: ${id}`);
  return c;
};

/**
 * Pound for pound: the same creature grown (or shrunk) to weigh `mass`. Lengths go with the cube root of
 * the weight; HP, damage, poise and strength go as they do across the roster (fitted against weight:
 * HP ~ mass^0.41, damage ~ mass^0.25, poise ~ mass^0.55, strength ~ mass^0.38), so it keeps its own
 * strengths and weaknesses for its new size. Speed, hide and armour stay its own.
 */
export function grownTo(c: CreatureDef, mass: number): CreatureDef {
  const r = mass / c.mass;
  if (Math.abs(r - 1) < 0.01) return c;
  const k = Math.cbrt(r);
  const dmg = r ** 0.25;
  const len = (x: number | undefined) => (x === undefined ? undefined : x * k);
  return {
    ...c,
    height: c.height * k,
    radius: c.radius * k,
    front: len(c.front),
    back: len(c.back),
    hover: len(c.hover),
    mass,
    hp: c.hp * r ** 0.41,
    poise: c.poise * r ** 0.55,
    strength: c.strength * r ** 0.38,
    dodge: c.dodge ? { ...c.dodge, distance: c.dodge.distance * k } : undefined,
    proc: { ...c.proc, stride: [c.proc.stride[0] * k, c.proc.stride[1] * k] },
    moves: c.moves.map((m) => ({
      ...m,
      reach: m.reach * k,
      damage: m.damage * dmg,
      lunge: len(m.lunge),
      minRange: len(m.minRange),
      poison: m.poison === undefined ? undefined : m.poison * dmg,
      grab: m.grab ? { ...m.grab, dps: m.grab.dps * dmg } : undefined,
      rise: len(m.rise),
      quake: len(m.quake),
      roar: m.roar ? { radius: m.roar.radius * k } : undefined,
    })),
    scale: (c.scale ?? 1) * k,
  };
}


/**
 * Curated fights, so `random` always gives a sensible one. In a duel the one that ought to win usually
 * does (DUEL_FAVOURITES; scripts/battle-matrix.ts checks it); hordes are one big fighter against a stream
 * of a smaller kind (never people: a crowd of fighters that dodge and slash is too strong a swarm).
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
  ['tiger', 'lion'],
  ['tiger', 'bear'],
  ['gorilla', 'tiger'],
  ['gorilla', 'bear'],
  ['gorilla', 'minotaur'],
  ['rhino', 'elephant'],
  ['rhino', 'bull'],
  ['minotaur', 'bull'],
  ['minotaur', 'viking'],
  ['troll', 'minotaur'],
  ['troll', 'viking'],
  ['troll', 'bear'],
  ['griffin', 'dragon'],
  ['griffin', 'lion'],
  ['viking', 'swordsman'],
  ['viking', 'king'],
] as const;

/**
 * Who ought to win each curated duel (null: a toss-up). The favourite should win about 70-90% of the time
 * (the dragon, the strongest one on one, nearer 90%); a toss-up 35-65%. Never shown to the planner: the
 * fight decides it.
 */
export const DUEL_FAVOURITES: Record<string, string | null> = {
  'bull-vs-dragon': 'dragon',
  'unicorn-vs-stag': 'unicorn',
  'stag-vs-horse': null,
  'stag-vs-spider': 'spider',
  'stag-vs-king': null,
  'horse-vs-king': null,
  'horse-vs-donkey': 'horse',
  'horse-vs-swordsman': null,
  'king-vs-spider': 'spider',
  'king-vs-brawler': 'king',
  'swordsman-vs-spider': 'spider',
  'swordsman-vs-donkey': 'swordsman',
  'swordsman-vs-brawler': 'swordsman',
  'donkey-vs-brawler': 'donkey',
  'wolf-vs-deer': 'wolf',
  'wolf-vs-alpaca': 'wolf',
  'bear-vs-lion': 'bear',
  'croc-vs-lion': null,
  'bear-vs-croc': null,
  'bull-vs-lion': null,
  'dragon-vs-bear': 'dragon',
  'lion-vs-horse': 'lion',
  'lion-vs-unicorn': 'lion',
  'croc-vs-unicorn': 'croc',
  'tiger-vs-lion': null,
  'tiger-vs-bear': 'bear',
  'gorilla-vs-tiger': 'tiger',
  'gorilla-vs-bear': 'bear',
  'gorilla-vs-minotaur': 'minotaur',
  'rhino-vs-elephant': 'elephant',
  'rhino-vs-bull': 'rhino',
  'minotaur-vs-bull': 'minotaur',
  'minotaur-vs-viking': 'minotaur',
  'troll-vs-minotaur': null,
  'troll-vs-viking': 'troll',
  'troll-vs-bear': null,
  'griffin-vs-dragon': 'dragon',
  'griffin-vs-lion': 'griffin',
  'viking-vs-swordsman': 'viking',
  'viking-vs-king': null,
};

export const HORDES = [
  ['bull', 'wolf'],
  ['bull', 'fox'],
  ['dragon', 'wolf'],
  ['dragon', 'husky'],
  ['dragon', 'alpaca'],
  ['dragon', 'lion'],
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
  ['elephant', 'lion'],
  ['elephant', 'wolf'],
  ['rhino', 'husky'],
  ['troll', 'wolf'],
  ['minotaur', 'fox'],
  ['viking', 'fox'],
  ['gorilla', 'husky'],
  ['tiger', 'husky'],
  ['griffin', 'husky'],
] as const;

export const matchupId = (a: string, b: string) => `${a}-vs-${b}`;
export const DUEL_IDS = DUELS.map(([a, b]) => matchupId(a, b));
export const HORDE_IDS = HORDES.map(([a, b]) => matchupId(a, b));

/** Its hide in a few words: what it is, what it shrugs off, what gets through. */
export function hideText(c: CreatureDef) {
  const words: Record<DamageType, string> = { pierce: 'bites', slash: 'claws', blunt: 'blows', fire: 'fire' };
  const r = Object.entries(c.hide.resist) as [DamageType, number][];
  const good = r.filter(([, v]) => v >= 0.15).sort((a, b) => b[1] - a[1]).map(([k]) => words[k]);
  const bad = r.filter(([, v]) => v <= -0.1).map(([k]) => words[k]);
  return [c.hide.name, good.length ? `resists ${good.slice(0, 2).join(' & ')}` : '', bad.length ? `weak to ${bad.join(' & ')}` : ''].filter(Boolean).join(' · ');
}

/** Stat bars for the VS card (0..1): size, power, speed, strength, toughness. */
export function statBars(c: CreatureDef): { size: number; power: number; speed: number; strength: number; toughness: number } {
  const bestHit = Math.max(...c.moves.map((m) => m.damage * (m.breath ? 6 : m.hits.length)));
  const span = (x: number, lo: number, hi: number) => Math.max(0.06, Math.min(1, (Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))));
  return {
    size: span(c.mass, 5, 1300),
    power: span(bestHit, 8, 80),
    speed: Math.max(0.06, Math.min(1, c.run / 11.5)),
    strength: Math.max(0.06, Math.min(1, c.strength / 10)),
    toughness: span(c.hp / (1 - c.armor), 40, 1300),
  };
}
