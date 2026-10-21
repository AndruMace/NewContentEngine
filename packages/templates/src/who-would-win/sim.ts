/**
 * The fight, in 2D on the arena floor (metres; the view maps sim (x, y) to three.js (x, z)). Fighters
 * are bodies that steer, turn, attack, take hits, get knocked back or knocked down, stagger, dodge and
 * die. Everything here is deterministic (dm.* maths, the run's rng only); the animation state each
 * fighter carries is derived from its sim state, so the view can pose a model from a snapshot alone.
 *
 * Blows connect physically: an attack commits to a lunge that closes the distance to the target and
 * lands only if the striking part (jaws, claws, horns, hooves, fists, blade) can reach the target's body
 * at the impact moment; a target that reads it slips away instead. Every blow lands on a part of the
 * body (head, body, a fore or hind limb, a wing) and leaves a wound there; wounds add up per part into
 * injuries that change how a fighter moves and fights (a limp, a daze, winded, a torn wing).
 */
import type { Rng } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { COOLDOWN_MUL, DAMAGE_MUL } from './balance';
import { strideFor, type CreatureDef, type DamageType, type MoveDef } from './roster';
import { anatomyOf, strikeParts } from './proc/anatomy';
import type { V3 } from './proc/builder';

/** Arena floor radius (inside the wall). */
export const ARENA_R = 10;
/** Breath attacks hit everyone in their cone this often. */
export const BREATH_TICK = 0.1;
const CRIT_CHANCE = 0.15;
const CRIT = 1.8;
/** A small fighter behind its target while another one keeps it busy does extra damage. */
const FLANK = 1.3;
const POISON_S = 4;
/** After a stagger or a knockdown, a fighter can't be staggered again for this long (no stun-locks). */
const STAGGER_GUARD_S = 2.5;
/** A blow staggers when it does this many times the target's poise (or crits past its poise). */
const STAGGER_AT = 1.4;
/** A blow this many times the target's poise knocks it off its feet. */
const KNOCKDOWN_AT = 2.4;
/** How long a knocked-down fighter is on the ground (the heavier the blow, the longer). */
const DOWN_S = 1.2;
/** Horde: at most this many of the swarm in the arena at once (the rest queue behind the gates). */
const MAX_ALIVE = 8;
/** Horde: most of the swarm fighting the big one at once (the rest circle and wait). */
const MAX_ENGAGED = 4;
/** Horde: the swarm's HP (each one alone is no match; together they are). */
const SWARM_HP = 0.7;
/** Grapples tick (damage, and a chance for the target to break free) this often. */
const GRAB_TICK = 0.25;
/** How long a stagger lasts. */
const PROC_STAGGER_S = 0.45;
/** Pawing the ground before a charge. */
const PREP_S = 0.7;
/** A clinch's struggle surges this often (and grinds both sides every other surge). */
const SURGE_S = 0.3;
/** A blow connects up to this far past the move's reach (the striking part stretching the last bit). */
const CONTACT = 0.12;
/** An attack lunges to leave this fraction of its reach between the bodies at the impact (before it knows
 * where its blow will land: then it lunges just far enough for its striking part to reach that spot). */
const CLOSE_TO = 0.3;
/** A target that reads a blow coming slips back this long before it lands, at this speed. */
const EVADE_LEAD_S = 0.24;
const EVADE_V = 3.4;
/** How high a fighter on the ground leaps to strike at a flier. */
export const LEAP = 0.6;
/** Most wounds kept per fighter (the first ones stay; injuries keep counting past it). */
const MAX_WOUNDS = 28;
/** Gate angles in the arena wall (at the back, as the camera sees it). */
export const GATES = [-Math.PI / 2, -Math.PI / 2 + 0.9, -Math.PI / 2 - 0.9];

export type Emit = (e: { type: string; [k: string]: unknown }) => void;

export type FighterState = 'idle' | 'move' | 'attack' | 'stagger' | 'dodge' | 'dead' | 'grab' | 'held' | 'down' | 'prep' | 'clinch';

/** How a fighter meets another head on: horns or tusks locked and pushing, or reared up wrestling. */
export type ClinchStyle = 'horns' | 'wrestle';
const CLINCH: Partial<Record<string, ClinchStyle>> = {
  bull: 'horns', stag: 'horns', unicorn: 'horns', rhino: 'horns', minotaur: 'horns', elephant: 'horns',
  bear: 'wrestle', lion: 'wrestle', tiger: 'wrestle', gorilla: 'wrestle', troll: 'wrestle',
  swordsman: 'wrestle', king: 'wrestle', brawler: 'wrestle', viking: 'wrestle',
};
export const clinchStyle = (d: CreatureDef): ClinchStyle | null => CLINCH[d.proc.kind] ?? null;
/** Animals that paw the ground before they charge. */
const PAWS_GROUND = new Set(['bull', 'rhino', 'minotaur', 'stag', 'unicorn', 'elephant']);

/** Locked head to head (both sides carry it): until when, who is winning (+ this one), the struggle's
 * current surges. */
export interface Clinch {
  with: number;
  t0: number;
  until: number;
  push: number;
  surge: number;
  next: number;
  style: ClinchStyle;
}

/** Where a blow lands: the head, the body, a fore limb (front leg, or a person's arm), a hind limb, a wing. */
export type Zone = 'head' | 'body' | 'fore' | 'hind' | 'wing';
/** Injury bookkeeping per part: limbs per side (L: the fighter's left, model +X). */
export type HurtKey = 'head' | 'body' | 'wing' | 'LF' | 'RF' | 'LH' | 'RH';
export type Hurt = Record<HurtKey, number>;
export type WoundKind = 'claw' | 'bite' | 'cut' | 'blunt' | 'gore' | 'burn';

/** Where on the body: the part, its side (1: the fighter's left), and a spot in that part (0..1 each). */
export interface Aim {
  zone: Zone;
  side: 1 | -1;
  u: number;
  v: number;
}

export interface Wound extends Aim {
  t: number;
  kind: WoundKind;
  /** Relative size (1: a blow of about the fighter's poise). */
  size: number;
  /** Who made it (its blow aims at this spot). */
  by: number;
}

export interface Grab {
  kind: 'latch' | 'roll' | 'pin';
  target: number;
  t0: number;
  until: number;
  next: number;
  dps: number;
  /** Latch: which side of the target it rides (1 left, -1 right). */
  side: 1 | -1;
  /** Where its jaws hold on. */
  aim: Aim;
  ticks: number;
}

export interface Fighter {
  idx: number;
  /** 0: the left / big fighter's side, 1: the right / swarm side. */
  side: 0 | 1;
  def: CreatureDef;
  x: number;
  y: number;
  heading: number;
  /** Own ground speed along the heading, and knockback velocity on top of it. */
  spd: number;
  kx: number;
  ky: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  state: FighterState;
  stateT: number;
  move: MoveDef | null;
  moveIdx: number;
  /** Next hit of the current move to resolve, and (breath) the next tick. */
  hitIdx: number;
  breathNext: number;
  /** Damage multiplier from a charge's speed. */
  chargeBonus: number;
  /** The move it is charging in to land (-1: not charging). */
  charging: number;
  /** The committed lunge of the current attack (m/s along the heading until the first hit). */
  lungeV: number;
  /** Where the current attack (or grapple) aims on its target. */
  aim: Aim | null;
  dodgeDir: 1 | -1;
  /** Sim time each move (and the dodge) can next be used. */
  ready: number[];
  dodgeReady: number;
  /** Sim time it can next be staggered. */
  staggerReady: number;
  /** It won't start an attack before this (a moment's hesitation: exchanges aren't clockwork). */
  commitAt: number;
  target: number;
  retargetAt: number;
  poisonUntil: number;
  poisonDps: number;
  poisonBy: number;
  /** Who hit it last (credited with the KO). */
  lastHitBy: number;
  /** Circling direction while waiting out cooldowns. */
  orbit: 1 | -1;
  /** Horde: one of the swarm close enough to fight (the rest wait their turn). */
  engaged: boolean;
  /** Visual: white flash on being hit (decays), and a burn glow from breath. */
  flash: number;
  burn: number;
  diedAt: number;
  dealt: number;
  /** Horde: the order it entered (1-based). */
  number: number;
  /** Procedural creatures: gait cycles walked (feet), turn rate (rad/s), crouch (0..1) and its target. */
  gait: number;
  yawRate: number;
  prevHeading: number;
  crouch: number;
  crouchWant: number;
  /** A grapple it holds, and who holds it (-1: nobody). */
  grab: Grab | null;
  heldBy: number;
  /** When, from which direction (rad, the way the blow pushed) and how hard (x poise) it was last hit. */
  lastHitT: number;
  lastHitDir: number;
  lastHitPow: number;
  /** When it last started an attack (an ambusher creeps closer after waiting a while). */
  lastActT: number;
  /** The current charge will stop short. */
  bluffing: boolean;
  /** Footfalls so far (two per gait cycle), for footstep sounds. */
  steps: number;
  /** Damage taken per part (fractions of its max HP), the wounds that show it, and injuries told. */
  hurt: Hurt;
  wounds: Wound[];
  told: number;
  /** Fire damage since its last scorch mark. */
  burnAcc: number;
  /** Flying height now (a dragon with a torn wing comes down). */
  hover: number;
  /** A blow it has read: it slips away from `evadeFrom` at evadeAt (0: none), and when it last did. */
  evadeAt: number;
  evadeFrom: number;
  evadeT: number;
  /** Its speed along its heading, knockback included (its feet step with it, backwards too). */
  stepV: number;
  /** Locked with another, and when it can lock again. */
  clinch: Clinch | null;
  clinchReady: number;
  /** Traits: a burn that keeps going, a roar's fire, a second wind used, its first blow, a dart back out,
   * a shield blow just blocked, trait moments already called. */
  burnUntil: number;
  prideUntil: number;
  windUsed: boolean;
  struck: boolean;
  retreatUntil: number;
  blockT: number;
  saidTrait: boolean;
  /** Knocked down: how long it stays down, and which way it fell (1: onto its left). */
  downLen: number;
  fallDir: 1 | -1;
}

export interface World {
  mode: 'duel' | 'horde';
  fighters: Fighter[];
  simT: number;
  /** Seconds since the fight started (sim time). */
  fightT: number;
  rng: Rng;
  /** Multiplies every fighter's HP (sets how long fights last). */
  hpScale: number;
  /** Past this many fight seconds, damage ramps up so every fight ends. */
  capS: number;
  /** Horde spawner. */
  swarm: { def: CreatureDef; total: number; sent: number; nextAt: number; gates: number[] } | null;
  /** Winning side once decided (-1 until then). */
  winner: number;
  /** Blows that land this step, applied together after everyone has moved (so trades are fair). */
  pending: { f: Fighter; o: Fighter; m: MoveDef; aim: Aim | null }[];
  /** The last fighter to fall, and who felled it (the deciding blow once the fight is decided). */
  koWho: number;
  koBy: number;
}

/** What the audio needs of a fighter (the sound mapping only sees events). */
const voiceOf = (d: CreatureDef) => ({ call: d.voice?.call ?? '', cp: d.voice?.pitch ?? 0.5, feet: d.feet ?? 'paw', mass: d.mass });

const wrap = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const r1 = (x: number) => Math.round(x * 10) / 10;

/** People stand on two legs: their fore limbs are arms. */
export const isBiped = (d: CreatureDef) => d.feet === 'foot';
/** How bad an injury to one part is (0 fine .. 1 crippled), from the damage it has taken. */
export const severity = (x: number) => clamp((x - 0.05) / 0.3, 0, 1);

export interface Condition {
  /** The worst leg, the next worst (both legs hurt is worse), arms (people), head, body, wing. */
  leg: number;
  leg2: number;
  arm: number;
  head: number;
  body: number;
  wing: number;
  /** Worn out: near the end of its HP. */
  spent: number;
  /** Sloppy (0..1): winded or worn out. It fights on at full pace but stops slipping blows, is easier to
   * stagger and knock down, and loses shoving matches and grips. */
  sloppy: number;
}

/** What its injuries add up to (sim and view both read it). */
export function condition(f: { hurt: Hurt; hp: number; maxHp: number; def: CreatureDef }): Condition {
  const c = conditionOf(f);
  c.sloppy = Math.max(c.body, c.spent);
  return c;
}

function conditionOf(f: { hurt: Hurt; hp: number; maxHp: number; def: CreatureDef }): Condition {
  const h = f.hurt;
  const legs = (isBiped(f.def) ? [h.LH, h.RH] : [h.LF, h.RF, h.LH, h.RH]).map(severity).sort((a, b) => b - a);
  return {
    leg: legs[0],
    leg2: legs[1],
    arm: isBiped(f.def) ? severity(Math.max(h.LF, h.RF)) : 0,
    // (Head and body take more: most blows land there.)
    head: severity(h.head * 0.7),
    body: severity(h.body * (f.def.trait === 'tireless' ? 0.35 : 0.75)),
    wing: severity(h.wing),
    spent: f.def.trait === 'tireless' ? 0 : clamp((0.35 - f.hp / f.maxHp) / 0.35, 0, 1),
    sloppy: 0,
  };
}

const zeroHurt = (): Hurt => ({ head: 0, body: 0, wing: 0, LF: 0, RF: 0, LH: 0, RH: 0 });
const keyOf = (a: { zone: Zone; side: 1 | -1 }): HurtKey => (a.zone === 'fore' ? (a.side > 0 ? 'LF' : 'RF') : a.zone === 'hind' ? (a.side > 0 ? 'LH' : 'RH') : a.zone);

function makeFighter(idx: number, side: 0 | 1, def: CreatureDef, x: number, y: number, heading: number, hpScale: number, rng: Rng, simT: number): Fighter {
  const hp = def.hp * hpScale;
  return {
    idx,
    side,
    def,
    x,
    y,
    heading,
    spd: 0,
    kx: 0,
    ky: 0,
    hp,
    maxHp: hp,
    alive: true,
    state: 'idle',
    stateT: simT,
    move: null,
    moveIdx: -1,
    hitIdx: 0,
    breathNext: 0,
    chargeBonus: 1,
    charging: -1,
    lungeV: 0,
    aim: null,
    dodgeDir: 1,
    ready: def.moves.map(() => simT + rng.range(0, 0.4)),
    dodgeReady: simT,
    staggerReady: simT,
    commitAt: simT,
    target: -1,
    retargetAt: 0,
    poisonUntil: 0,
    poisonDps: 0,
    poisonBy: -1,
    lastHitBy: -1,
    orbit: rng.chance(0.5) ? 1 : -1,
    engaged: true,
    flash: 0,
    burn: 0,
    diedAt: -1,
    dealt: 0,
    number: 0,
    gait: 0,
    yawRate: 0,
    prevHeading: heading,
    crouch: 0,
    crouchWant: 0,
    grab: null,
    heldBy: -1,
    lastHitT: -10,
    lastHitDir: 0,
    lastHitPow: 0,
    lastActT: simT,
    bluffing: false,
    steps: 0,
    hurt: zeroHurt(),
    wounds: [],
    told: 0,
    burnAcc: 0,
    hover: def.hover ?? 0,
    evadeAt: 0,
    evadeFrom: -1,
    evadeT: -10,
    downLen: 0,
    fallDir: 1,
    stepV: 0,
    clinch: null,
    clinchReady: simT + 1.5,
    burnUntil: 0,
    prideUntil: 0,
    windUsed: false,
    struck: false,
    retreatUntil: 0,
    blockT: -10,
    saidTrait: false,
  };
}

export function makeWorld(opts: { mode: 'duel' | 'horde'; a: CreatureDef; b: CreatureDef; hpScale: number; capS: number; maxSwarm: number; rng: Rng }): World {
  const { mode, a, b, hpScale, rng } = opts;
  const fighters: Fighter[] = [];
  if (mode === 'duel') {
    // Squared up across the arena (a little differently each time), and each sizes the other up for a
    // moment before committing, so no two fights open the same way.
    const d = 2.4 + ((a.front ?? a.radius) + (b.front ?? b.radius)) * 0.5;
    const off = rng.range(-1, 1);
    const fa = makeFighter(0, 0, a, -d + rng.range(-0.4, 0.4), off, rng.range(-0.25, 0.25), hpScale, rng, 0);
    const fb = makeFighter(1, 1, b, d + rng.range(-0.4, 0.4), -off, Math.PI + rng.range(-0.25, 0.25), hpScale, rng, 0);
    fa.commitAt = rng.range(0.2, 1.4);
    fb.commitAt = rng.range(0.2, 1.4);
    fighters.push(fa, fb);
  } else {
    // The big fighter starts in the middle, a little in front, facing the gates at the back.
    fighters.push(makeFighter(0, 0, a, 0, 1.5, -Math.PI / 2, hpScale, rng, 0));
  }
  const gates = mode === 'horde' ? GATES : [];
  return {
    mode,
    fighters,
    simT: 0,
    fightT: 0,
    rng,
    hpScale,
    capS: opts.capS,
    swarm: mode === 'horde' ? { def: b, total: opts.maxSwarm, sent: 0, nextAt: 0, gates } : null,
    pending: [],
    winner: -1,
    koBy: -1,
    koWho: -1,
  };
}

const enemiesOf = (w: World, f: Fighter) => w.fighters.filter((o) => o.alive && o.side !== f.side);

function setState(f: Fighter, state: FighterState, simT: number, rng?: Rng) {
  f.state = state;
  f.stateT = simT;
  if (rng && state === 'idle') {
    const c = condition(f);
    // Nearly beaten: nothing left to lose, no hesitation at all.
    f.commitAt = simT + rng.range(0, 0.35) * (c.spent > 0.6 ? 0.4 : 1);
  }
}

/** Procedural creatures: feet (gait cycles from the distance walked), turn rate and crouch. */
function procTick(f: Fighter, dt: number, simT: number) {
  const yaw = wrap(f.heading - f.prevHeading);
  f.prevHeading = f.heading;
  f.yawRate += (yaw / dt - f.yawRate) * (1 - dm.exp(-dt * 8));
  // Its feet step with whatever moves it along its heading, a shove back included (backwards then).
  f.stepV = f.state === 'dead' || f.state === 'down' || f.state === 'held' ? 0 : f.spd + f.kx * dm.cos(f.heading) + f.ky * dm.sin(f.heading);
  const s = Math.abs(f.stepV);
  if (s > 0.15 && f.state !== 'grab') f.gait += (dt * f.stepV) / strideFor(f.def.proc, s);
  f.crouch += (f.crouchWant - f.crouch) * (1 - dm.exp(-dt * 4));
  // A dragon swoops down to bite (and is within reach for a moment after), sags when rocked, flies lower
  // as a wing gives, and comes down when it tears (or when knocked out of the air).
  if (f.def.hover) {
    const c = condition(f);
    const m = f.state === 'attack' ? f.move : null;
    const swoop = m && !m.breath && f.stateT + m.hits[0].at * m.len + 0.5 > simT ? 0.15 : f.state === 'stagger' ? 0.35 : 1;
    const want = f.state === 'down' || c.wing >= 0.6 ? 0 : f.def.hover * Math.min(swoop, 1 - 0.35 * c.wing);
    f.hover += clamp(want - f.hover, -3.5 * dt, 0.7 * dt);
  }
}

/** Animate only (before the fight starts and after it ends): idle, death falls, knockback settling. */
export function idleWorld(w: World, dt: number) {
  w.simT += dt;
  for (const f of w.fighters) {
    if (f.alive && f.state !== 'dead') {
      if (f.grab) release(w, f, false, () => {});
      f.clinch = null;
      f.spd *= dm.exp(-dt * 6);
      if (f.state !== 'idle' && f.state !== 'move' && !(f.state === 'down' && w.simT - f.stateT < f.downLen)) setState(f, 'idle', w.simT);
    }
    settle(f, dt);
    procTick(f, dt, w.simT);
  }
}

function settle(f: Fighter, dt: number) {
  f.x += f.kx * dt;
  f.y += f.ky * dt;
  const k = dm.exp(-dt * 5);
  f.kx *= k;
  f.ky *= k;
  f.flash *= dm.exp(-dt * 12);
  f.burn *= dm.exp(-dt * 2);
}

function pickTarget(w: World, f: Fighter) {
  const foes = enemiesOf(w, f);
  if (!foes.length) {
    f.target = -1;
    return;
  }
  if (w.mode === 'horde' && f.side === 1) {
    f.target = foes[0].idx;
    return;
  }
  // The big fighter (or a duellist): the nearest engaged foe, favouring whoever is in front of it.
  let best = foes[0];
  let bestCost = Infinity;
  for (const o of foes) {
    if (w.mode === 'horde' && !o.engaged) continue;
    const dx = o.x - f.x;
    const dy = o.y - f.y;
    const cost = dm.hypot(dx, dy) + 1.5 * Math.abs(wrap(dm.atan2(dy, dx) - f.heading));
    if (cost < bestCost) {
      bestCost = cost;
      best = o;
    }
  }
  f.target = best.idx;
}

/** How far a fighter's body reaches from its centre towards a direction (world angle): long bodies are
 * longer ahead and behind than to the sides. Ahead it is a narrow head and neck: a little off its line,
 * another body can come alongside it (two animals meet chest to shoulder, heads past each other). */
export function extent(f: { def: CreatureDef; heading: number }, ang: number) {
  const d = f.def;
  const c = dm.cos(wrap(ang - f.heading));
  const ahead = Math.max(0, c) ** 2;
  return d.radius + ((d.front ?? d.radius) - d.radius) * ahead * ahead * ahead + ((d.back ?? d.radius) - d.radius) * Math.max(0, -c) * Math.max(0, -c);
}

/** Where `o` sits from `f`: edge-to-edge gap and angle off f's facing. */
export function relation(f: { def: CreatureDef; heading: number; x: number; y: number }, o: { def: CreatureDef; heading: number; x: number; y: number }) {
  const dx = o.x - f.x;
  const dy = o.y - f.y;
  const dist = dm.hypot(dx, dy);
  const ang = dm.atan2(dy, dx);
  return { dx, dy, dist, gap: dist - extent(f, ang) - extent(o, ang + Math.PI), rel: wrap(ang - f.heading), ang };
}

/** A point in a fighter's own frame (x its left, y up, z ahead; `fwd` further ahead) on the floor, and how high. */
function toWorld(f: Fighter, p: V3, fwd = 0) {
  const c = dm.cos(f.heading);
  const sn = dm.sin(f.heading);
  const z = p[2] + fwd;
  return { x: f.x + z * c + p[0] * sn, y: f.y + z * sn - p[0] * c, h: p[1] + f.hover };
}

/**
 * How far short of a spot on `o` the move's striking parts fall (0 or less: it reaches; the body leaning
 * and the limb or neck stretching), with `f` `ahead` metres further along its heading. A tail sweep has no
 * one striking part: it reaches whatever is within its reach behind.
 */
export function shortOf(f: Fighter, o: Fighter, m: MoveDef, k: number, aim: Aim, ahead = 0) {
  const parts = strikeParts(f.def, m, k);
  if (!parts.length) return relation(f, o).gap - m.reach;
  const an = anatomyOf(f.def);
  const sp = toWorld(o, anatomyOf(o.def).spot(aim));
  let best = Infinity;
  for (const part of parts) {
    const s = an.striker(part);
    const b = toWorld(f, s.at, ahead);
    // (Struck from reared up: from higher, and further in.)
    if (m.rise) b.h += m.rise;
    // (A flier dives at what is below it, the whole body coming down; on the ground, it leaps up at a flier.)
    let dh = sp.h - b.h;
    const leap = o.hover > 0.3 && f.hover < 0.3 ? LEAP : 0;
    if (f.hover > 0.3 && dh < 0) dh = Math.min(0, dh + 0.8);
    else if (leap && dh > 0) dh = Math.max(0, dh - leap);
    // (A head reaches down to anything, but only so far up.)
    const over = s.top !== undefined ? sp.h - (s.top + f.hover + (m.rise ?? 0) + leap) : 0;
    best = Math.min(best, Math.max(dm.hypot(dm.hypot(sp.x - b.x, sp.y - b.y), dh) - s.span, over));
  }
  return best;
}

/** Whether the move's striking parts could reach some part of `o` (its head, the near flank, a near
 * limb) after lunging `ahead`: the AI only starts blows that can land. */
function canReach(f: Fighter, o: Fighter, m: MoveDef, ahead: number) {
  if (!strikeParts(f.def, m, 0).length) return true;
  const side = sideOf(o, f);
  const rel = Math.abs(wrap(dm.atan2(f.y - o.y, f.x - o.x) - o.heading));
  const u = rel < 0.75 ? 0.85 : rel > 2.35 ? 0.15 : 0.5;
  for (const zone of ['head', 'body', 'fore', 'hind'] as Zone[])
    for (const lu of zone === 'fore' || zone === 'hind' ? [0.3, 0.85] : [0.5])
      if (shortOf(f, o, m, 0, { zone, side, u: zone === 'body' ? u : lu, v: 0.5 }, ahead) <= 0) return true;
  return false;
}

/** How far to lunge (along the heading, `dir` 1 forward or -1 back) for the striking part to reach `aim`
 * with a little to spare: no further than it has to, and no further than `can`. */
function lungeFor(f: Fighter, o: Fighter, m: MoveDef, aim: Aim, dir: number, can: number) {
  const want = -0.08;
  const s0 = shortOf(f, o, m, 0, aim, 0);
  if (s0 <= want) return Math.max(-0.2, (s0 - want) * 0.5);
  const s1 = shortOf(f, o, m, 0, aim, dir * can);
  // (Shortfall falls about linearly as it closes in.)
  const k = s0 - s1;
  return k > 1e-3 ? clamp(((s0 - want) / k) * can, 0, can) : can;
}

/** Which side of `o` the attacker `f` is on (1: o's left, model +X). */
const sideOf = (o: Fighter, f: Fighter): 1 | -1 => (wrap(dm.atan2(f.y - o.y, f.x - o.x) - o.heading) < 0 ? 1 : -1);

/** Moves made with a limb (a damaged limb hits weaker): claws, fists and blades in front, kicks behind. */
const limbOf = (m: MoveDef, hitIdx: number): 'fore' | 'hind' | null => {
  if (m.hits[hitIdx]?.back || m.clip === 'kick' || m.clip === 'stomp') return 'hind';
  if (['swipe', 'rear', 'slash', 'chop', 'club', 'bash', 'backhand', 'pummel', 'grapple'].includes(m.clip) || m.clip.startsWith('punch')) return 'fore';
  return null;
};

/** Moves that launch the whole body (a crippled leg can't). */
const launches = (m: MoveDef) => !!m.charge || (m.minRange !== undefined && (m.lunge ?? 0) > 2);

/**
 * Where on `o` a blow from `f` lands: the parts facing the attacker, within its reach (a small attacker
 * goes for the legs of a big one, a big one comes down on the head and back of a small one, a tail sweeps
 * the legs, hooves kick at whatever is behind), and a spot within that part.
 */
function pickAim(w: World, f: Fighter, o: Fighter, m: MoveDef, k = 0, ahead = 0): Aim {
  const rel = Math.abs(wrap(dm.atan2(f.y - o.y, f.x - o.x) - o.heading));
  const front = rel < 0.75;
  const rear = rel > 2.35;
  const wt: Record<Zone, number> = front ? { head: 2.5, fore: 3, body: 3.5, hind: 0, wing: 0 } : rear ? { head: 0, fore: 0.3, body: 3, hind: 4, wing: 0 } : { head: 1, fore: 2, body: 4, hind: 2, wing: 0 };
  const hr = (f.def.height + f.hover) / (o.def.height + o.hover);
  if (m.breath) Object.assign(wt, { head: 1.5, body: 3, fore: 1, hind: 1 });
  else if (m.clip === 'tail') Object.assign(wt, { head: 0.2, body: 1, fore: wt.fore + 2, hind: wt.hind + 2 });
  else if (hr < 0.65) {
    // Small against big: the legs (and the flanks), not the head out of reach.
    wt.head *= 0.15;
    wt.fore *= 1.7;
    wt.hind *= 1.7;
    wt.body *= 0.8;
  } else if (hr > 1.6) {
    wt.head *= 1.5;
    wt.body *= 1.4;
    wt.fore *= 0.5;
    wt.hind *= 0.5;
  }
  if (m.hits.some((h) => h.back)) wt.head *= 1.4;
  if (o.def.proc.kind === 'dragon') {
    wt.wing = front ? 0.5 : 2.5;
    // Flying: a grounded attacker reaches its dangling legs, belly and wings, not its head.
    if (o.hover > 0.4 && !f.def.hover) wt.head *= hr > 1 ? 0.6 : 0.15;
  }
  // (Parts it has: only a dragon has wings.)
  const has = (z: Zone) => z !== 'wing' || !!anatomyOf(o.def).spec.wings;
  // The likeliest parts first, but only a spot the striking part can actually reach from where it is
  // (snout to snout, that is the face); failing that, the nearest it found.
  const side = sideOf(o, f);
  const zones = Object.keys(wt) as Zone[];
  let best: Aim | null = null;
  let bestShort = Infinity;
  const tried = new Set<Zone>();
  for (let n = 0; n < zones.length; n++) {
    let total = 0;
    for (const z of zones) if (!tried.has(z) && has(z)) total += wt[z] || (n >= 3 ? 0.1 : 0);
    if (total <= 0) break;
    let pick = w.rng.next() * total;
    let zone: Zone = zones.find((z) => !tried.has(z) && has(z))!;
    for (const z of zones) {
      if (tried.has(z) || !has(z)) continue;
      if ((pick -= wt[z] || (n >= 3 ? 0.1 : 0)) < 0) {
        zone = z;
        break;
      }
    }
    tried.add(zone);
    for (let k2 = 0; k2 < 4; k2++) {
      // Along the body, the end facing the attacker (from the front: the neck and shoulders).
      const u0 = w.rng.next();
      const u = zone === 'body' ? (front ? 0.72 + 0.28 * u0 : rear ? 0.45 * u0 : 0.2 + 0.6 * u0) : u0;
      const aim: Aim = { zone, side, u, v: w.rng.next() };
      const sh = shortOf(f, o, m, k, aim, ahead);
      if (sh <= 0) return aim;
      if (sh < bestShort) {
        bestShort = sh;
        best = aim;
      }
    }
  }
  // The middle of each part, and a leg's upper and lower halves (what the AI checked it could reach).
  for (const zone of zones) {
    if (!has(zone)) continue;
    for (const lu of zone === 'fore' || zone === 'hind' ? [0.3, 0.85] : [0.5]) {
      const aim: Aim = { zone, side, u: zone === 'body' ? (front ? 0.85 : rear ? 0.15 : 0.5) : lu, v: 0.5 };
      const sh = shortOf(f, o, m, k, aim, ahead);
      if (sh < bestShort) {
        bestShort = sh;
        best = aim;
      }
    }
  }
  return best ?? { zone: 'body', side, u: 0.5, v: 0.5 };
}

const markOf = (f: Fighter, m: MoveDef): WoundKind => m.mark ?? (m.breath ? 'burn' : m.sound === 'bite' ? 'bite' : m.sound === 'slash' ? (f.def.weapon ? 'cut' : 'claw') : 'blunt');
/** What kind of damage a move does (fangs, horns and tusks pierce; claws and blades cut). */
export const typeOf = (d: CreatureDef, m: MoveDef): DamageType => {
  if (m.type) return m.type;
  if (m.breath) return 'fire';
  const k = m.mark ?? (m.sound === 'bite' ? 'bite' : m.sound === 'slash' ? (d.weapon ? 'cut' : 'claw') : 'blunt');
  return k === 'bite' || k === 'gore' ? 'pierce' : k === 'claw' || k === 'cut' ? 'slash' : 'blunt';
};

/** Damage multipliers from traits on the attacking side. */
function traitDamage(w: World, f: Fighter) {
  const t = f.def.trait;
  const hpf = f.hp / f.maxHp;
  let k = 1;
  if (t === 'lastStand' && hpf < 0.3) k *= 1.35;
  if (t === 'berserk' && hpf < 0.5) k *= 1.25;
  if (t === 'pride' && f.prideUntil > w.simT) k *= 1.3;
  return k;
}

/** Record a wound and the injury it adds to; tell (once) when a part gives. */
function wound(w: World, o: Fighter, aim: Aim, kind: WoundKind, dmg: number, by: number, emit: Emit) {
  const before = condition(o);
  o.hurt[keyOf(aim)] += dmg / o.maxHp;
  if (o.wounds.length < MAX_WOUNDS) o.wounds.push({ ...aim, t: w.simT, kind, size: clamp(dmg / (o.def.poise * DAMAGE_MUL), 0.45, 1.7), by });
  const after = condition(o);
  const tell = (bit: number, part: string, was: number, now: number) => {
    if (was < 0.5 && now >= 0.5 && !(o.told & bit)) {
      o.told |= bit;
      emit({ type: 'injury', who: o.idx, part, ...voiceOf(o.def), swarm: w.mode === 'horde' && o.side === 1 ? 1 : 0, x: r1(o.x) });
    }
  };
  tell(1, 'leg', before.leg, after.leg);
  tell(2, 'head', before.head, after.head);
  tell(4, 'body', before.body, after.body);
  tell(8, 'wing', before.wing, after.wing);
  tell(16, 'arm', before.arm, after.arm);
}

function startAttack(w: World, f: Fighter, i: number, emit: Emit) {
  const m = f.def.moves[i];
  const c = condition(f);
  f.move = m;
  f.moveIdx = i;
  f.hitIdx = 0;
  const firstHit = m.hits[0].at * m.len;
  f.breathNext = firstHit;
  f.chargeBonus = m.charge ? 1 + 0.6 * clamp(f.spd / f.def.run, 0, 1) + (f.def.trait === 'rampage' && f.hp < f.maxHp * 0.5 ? 0.35 : 0) : 1;
  f.ready[i] = w.simT + m.cooldown * COOLDOWN_MUL;
  f.lastActT = w.simT;
  // Commit to a lunge that closes in on the target, leaving the blow's own reach to land it (charges
  // come in at their running speed). Kicks behind back into it.
  const t = w.fighters[f.target];
  f.aim = null;
  f.lungeV = 0;
  if (t && t.alive && !m.roar) {
    const r = relation(f, t);
    const back = m.hits[0].back ? -1 : 1;
    const can = ((m.lunge ?? 0) + 0.3) * (1 - 0.4 * c.leg);
    let dist = clamp(r.gap - m.reach * CLOSE_TO, -0.25, m.breath ? 0 : can);
    if (!m.breath) {
      // Where it will strike, reachable after the lunge (only as far as the gap: bodies stop each other);
      // then just far enough in to land it there.
      const room = Math.min(can, Math.max(0, r.gap));
      f.aim = pickAim(w, f, t, m, 0, back * Math.min(dist, room));
      if (strikeParts(f.def, m, 0).length) dist = lungeFor(f, t, m, f.aim, back, room);
    }
    f.lungeV = (back * dist) / Math.max(0.12, firstHit);
    if (m.charge) f.lungeV = clamp(f.lungeV, f.spd * 0.5, f.spd * 1.1);
  }
  setState(f, 'attack', w.simT);
  emit({ type: 'swing', who: f.idx, move: m.name, sound: m.sound, ...voiceOf(f.def), big: (m.weight ?? 1) >= 3 || m.charge || m.grab ? 1 : 0, breath: m.breath ? 1 : 0, weapon: f.def.weapon ?? '', x: r1(f.x) });
  // Anyone it is swinging at may sidestep (if they are quick enough on their feet), or read it and
  // slip back out of reach just before it lands.
  for (const o of enemiesOf(w, f)) {
    if ((o.state !== 'idle' && o.state !== 'move') || m.breath || m.roar) continue;
    const r = relation(f, o);
    if (r.gap > m.reach + (m.lunge ?? 0) + 0.5 || Math.abs(m.hits[0].back ? wrap(r.rel + Math.PI) : r.rel) > m.arc + 0.3) continue;
    const oc = condition(o);
    const d = o.def.dodge;
    if (d && o.dodgeReady <= w.simT) {
      o.dodgeReady = w.simT + d.cooldown;
      if (w.rng.chance(d.chance * (1 - 0.7 * oc.leg) * (1 - 0.8 * oc.sloppy))) {
        o.dodgeDir = w.rng.chance(0.5) ? 1 : -1;
        setState(o, 'dodge', w.simT);
        emit({ type: 'dodge', who: o.idx, x: r1(o.x) });
        continue;
      }
    }
    const nimble = o.def.trait === 'skittish' ? 2 : o.def.trait === 'sly' ? 1.6 : 1;
    // (Dazed or sloppy, it doesn't see it coming.)
    if (o.evadeAt <= 0 && w.rng.chance(evasion(f.def, o.def) * nimble * (1 - 0.6 * oc.leg) * (1 - 0.5 * oc.head) * (1 - 0.8 * oc.sloppy))) {
      o.evadeAt = w.simT + Math.max(0.02, firstHit - EVADE_LEAD_S);
      o.evadeFrom = f.idx;
    }
  }
}

/** Decide what an idle or moving fighter does this step: attack, charge, approach, circle or wait. */
function think(w: World, f: Fighter, emit: Emit): { heading: number; speed: number } {
  const d = f.def;
  if (f.target < 0 || !w.fighters[f.target].alive || w.simT >= f.retargetAt) {
    pickTarget(w, f);
    f.retargetAt = w.simT + 0.5;
  }
  f.crouchWant = 0;
  if (f.target < 0) return { heading: f.heading, speed: 0 };
  const t = w.fighters[f.target];
  const r = relation(f, t);
  const me = condition(f);
  const them = condition(t);
  // Down: staggered, held, knocked over, crippled, or nearly finished.
  const downed = t.state === 'stagger' || t.state === 'held' || t.state === 'down' || t.hp < t.maxHp * 0.3 || them.leg >= 0.6;
  // It can tell when its foe is hurt or sloppy, and goes after it.
  const press = downed || them.leg >= 0.45 || them.head >= 0.45 || them.sloppy >= 0.5;
  const grabbable = t.hover < 0.3 && t.heldBy < 0 && !t.grab;

  // A sly one darts back out after its bite.
  if (f.retreatUntil > w.simT) return { heading: r.ang + Math.PI + f.orbit * 0.4, speed: d.run * 0.8 };

  // Horde members not yet engaged wait their turn, circling at a distance.
  if (w.mode === 'horde' && f.side === 1 && !f.engaged) {
    f.charging = -1;
    const ringR = t.def.radius + 3.2 + (f.idx % 3) * 0.6;
    const a = dm.atan2(f.y - t.y, f.x - t.x) + f.orbit * 0.35;
    const gx = t.x + dm.cos(a) * ringR - f.x;
    const gy = t.y + dm.sin(a) * ringR - f.y;
    return { heading: dm.atan2(gy, gx), speed: clamp(dm.hypot(gx, gy) * 1.2, 0, d.walk * 1.6) };
  }

  // A charge in progress: straight at the target until close enough to land it (or, a bluff, stop short).
  if (f.charging >= 0) {
    const m = d.moves[f.charging];
    if (f.bluffing && r.gap <= m.reach + 2.2) {
      f.charging = -1;
      f.bluffing = false;
      f.commitAt = w.simT + 0.8;
      emit({ type: 'bluff', who: f.idx, x: r1(f.x) });
      return { heading: r.ang, speed: 0 };
    }
    if (r.gap <= m.reach + f.spd * m.hits[0].at * m.len * 0.8) {
      const i = f.charging;
      f.charging = -1;
      startAttack(w, f, i, emit);
      return { heading: f.heading, speed: f.spd };
    }
    if (Math.abs(r.rel) > 1.2) f.charging = -1;
    else return { heading: r.ang, speed: d.run };
  }

  // A stalker crouches when its pounce is ready and the prey is in range, and leaps once coiled.
  if (d.ai === 'stalker' && me.leg < 0.7) {
    const pi = d.moves.findIndex((m) => m.grab?.kind === 'latch');
    const pm = d.moves[pi];
    if (pi >= 0 && f.ready[pi] <= w.simT && grabbable && r.gap >= pm.minRange! && r.gap <= pm.reach + pm.lunge! + 2) {
      f.crouchWant = 1;
      if (f.crouch >= 0.6 && r.gap <= pm.reach + pm.lunge! * (1 - 0.4 * me.leg) && Math.abs(r.rel) < 0.35 && f.commitAt <= w.simT) {
        startAttack(w, f, pi, emit);
        return { heading: f.heading, speed: 0 };
      }
      return { heading: r.ang, speed: r.gap > pm.reach + pm.lunge! ? d.walk * 0.6 : 0.2 };
    }
  }

  // Squared up close, head to head: horns lock, or the two rear up and grapple.
  if (
    w.mode === 'duel' &&
    clinchStyle(d) &&
    clinchStyle(t.def) &&
    f.clinchReady <= w.simT &&
    t.clinchReady <= w.simT &&
    (t.state === 'idle' || t.state === 'move') &&
    r.gap < (clinchStyle(d) === 'horns' && clinchStyle(t.def) === 'horns' ? 0.7 : 0.3) &&
    Math.abs(r.rel) < 0.7 &&
    Math.abs(relation(t, f).rel) < 0.8 &&
    f.hover < 0.3 &&
    t.hover < 0.3 &&
    w.rng.chance(0.025)
  ) {
    startClinch(w, f, t, emit);
    return { heading: f.heading, speed: 0 };
  }

  // Moves it could start right now, weighted by preference and damage.
  let total = 0;
  const options: { i: number; w: number }[] = [];
  const crowd = enemiesOf(w, f).filter((o) => relation(f, o).gap < 2.5).length;
  d.moves.forEach((m, i) => {
    if (f.ready[i] > w.simT || f.commitAt > w.simT) return;
    if (m.minRange !== undefined && r.gap < m.minRange) return;
    if (m.needs === 'targetDown' && !downed) return;
    if (m.grab && (!grabbable || (m.grab.kind === 'latch' && d.ai === 'stalker'))) return;
    if (launches(m) && me.leg >= 0.7) return;
    // Roars: when crowded, or to open a fight from a distance.
    if (m.roar) {
      if (crowd >= 2 || (w.fightT < 4 && r.gap > 2.5)) options.push({ i, w: (m.weight ?? 1) * 40 });
      return;
    }
    if (m.charge) {
      if (Math.abs(r.rel) < 0.5 && r.gap < ARENA_R) options.push({ i, w: (m.weight ?? 1) * m.damage * (d.trait === 'rampage' && f.hp < f.maxHp * 0.5 ? 2 : 1) });
      return;
    }
    const back = m.hits.every((h) => h.back);
    const off = back ? Math.abs(wrap(r.rel + Math.PI)) : Math.abs(r.rel);
    const can = ((m.lunge ?? 0) + 0.3) * (1 - 0.4 * me.leg);
    const reach = m.reach + can * (m.minRange !== undefined ? 1 : 0.6);
    // (Blows with a striking part go by what that part can reach; a breath or a tail sweep by its cone.)
    const facing = m.breath || !strikeParts(d, m, 0).length ? off <= m.arc * 0.75 : off <= m.arc + 0.4;
    if (r.gap <= reach && facing && (m.breath || canReach(f, t, m, (back ? -1 : 1) * Math.min(can, Math.max(0, r.gap))))) options.push({ i, w: (m.weight ?? 1) * m.damage * (m.breath ? 6 : m.hits.length) });
  });
  for (const o of options) total += o.w;
  if (options.length) {
    let pick = w.rng.next() * total;
    const chosen = options.find((o) => (pick -= o.w) < 0) ?? options[options.length - 1];
    if (d.moves[chosen.i].charge) {
      f.charging = chosen.i;
      f.bluffing = w.rng.chance(d.moves[chosen.i].bluff ?? 0);
      f.ready[chosen.i] = w.simT + d.moves[chosen.i].cooldown * COOLDOWN_MUL * (d.trait === 'rampage' && f.hp < f.maxHp * 0.5 ? 0.6 : 1);
      // From a distance, a bull (and its kind) paws the ground first.
      if (PAWS_GROUND.has(d.proc.kind) && r.gap > 4.5) {
        setState(f, 'prep', w.simT);
        emit({ type: 'prep', who: f.idx, ...voiceOf(d), x: r1(f.x) });
        return { heading: r.ang, speed: 0 };
      }
      emit({ type: 'charge', who: f.idx, ...voiceOf(d), x: r1(f.x) });
      return { heading: r.ang, speed: d.run };
    }
    startAttack(w, f, chosen.i, emit);
    return { heading: f.heading, speed: 0 };
  }

  // An ambusher lies still facing its prey, creeping only when it has waited a while.
  if (d.ai === 'ambusher') {
    // (The same reach the move options above allow.)
    const strike = Math.max(...d.moves.filter((m) => !m.hits.every((h) => h.back)).map((m) => m.reach + ((m.lunge ?? 0) + 0.3) * (m.minRange !== undefined ? 1 : 0.6)));
    if (w.simT - f.lastActT < 3.5 && !press) return { heading: r.ang, speed: r.gap > strike + 2.5 ? d.walk * 0.5 : 0 };
    // Out of patience (or the prey is hurt): go to it.
    return { heading: r.ang, speed: r.gap > strike * 0.7 ? d.walk : 0 };
  }

  const soon = (m: MoveDef, i: number) => f.ready[i] - w.simT < 0.35 && !m.charge && (m.minRange === undefined || r.gap >= m.minRange);
  const frontSoon = d.moves.some((m, i) => soon(m, i) && !m.hits.every((h) => h.back));
  const backSoon = d.moves.some((m, i) => soon(m, i) && m.hits.every((h) => h.back));
  const closest = Math.min(...d.moves.map((m) => m.reach + 0.3));
  // Kickers turn their back on anyone close once their front moves are spent.
  if (backSoon && !frontSoon && r.gap < 1.4) return { heading: r.ang + Math.PI, speed: d.walk * 0.4 };
  if (frontSoon || backSoon || press) {
    // Up to where a blow it has ready can land (pressing right in if its striking part can't reach yet).
    const can = (m: MoveDef) => Math.min(((m.lunge ?? 0) + 0.3) * (1 - 0.4 * me.leg), Math.max(0, r.gap)) * (m.hits[0].back ? -1 : 1);
    const inReach = r.gap <= 3 && d.moves.some((m, i) => soon(m, i) && !m.hits[0].back && !m.breath && canReach(f, t, m, can(m)));
    const speed = r.gap > 3 ? d.run : r.gap > closest * 0.7 ? Math.min(d.run, d.walk * 1.8) : inReach ? 0 : d.walk * 1.2;
    // Closing in, it angles for the shoulder rather than meeting it head on (necks, shoulders and
    // forelegs come within reach, and the two end up circling chest to chest).
    const veer = speed > 0 && r.gap < 2.5 && !d.weapon && w.mode === 'duel' ? f.orbit * 0.55 * dm.sin(Math.PI * clamp(r.gap / 2.5, 0, 1)) : 0;
    // Right under it (a flier above): back out to have it in front. Up against it with nothing in reach
    // (too low, too tall, head to head): work round it for an opening.
    if (!inReach && r.gap < -0.15) return { heading: r.ang + Math.PI + f.orbit * 0.5, speed: d.walk * 1.2 };
    if (!inReach && r.gap < 0.2 && (frontSoon || press)) return { heading: r.ang + f.orbit * 1.25, speed: d.walk * 1.1 };
    return { heading: r.ang + veer, speed };
  }
  // Waiting on cooldowns: circle the target (well back when it is losing), backing off if right on top of it.
  if (r.gap < closest * 0.6) return { heading: r.ang + f.orbit * 2.3, speed: d.walk };
  return { heading: r.ang + f.orbit * (r.gap > 3 ? 0.6 : 1.35), speed: r.gap > 4 ? d.run * 0.7 : d.walk * 1.1 };
}

/** Chance a target reads a blow from `a` in time to slip it (the quicker and smaller, the likelier). */
export const evasion = (a: CreatureDef, b: CreatureDef) => clamp(0.1 + 0.035 * (b.turn - a.turn) + (b.mass < a.mass * 0.25 ? 0.1 : 0), 0.05, 0.4);

function applyHit(w: World, f: Fighter, o: Fighter, m: MoveDef, aimIn: Aim | null, emit: Emit) {
  const dmgMul = w.fightT > w.capS ? 1 + (w.fightT - w.capS) * 0.5 : 1;
  // (An ambusher's first blow and a stalker's first pounce always crit; a dive bomber's talons often do.)
  const sure = (f.def.trait === 'ambush' && !f.struck) || (f.def.trait === 'stealth' && m.clip === 'pounce' && !f.struck);
  const crit = !m.breath && (sure || w.rng.chance(CRIT_CHANCE * (f.def.trait === 'diveBomb' && m.clip === 'dive' ? 3 : 1)));
  if (!m.breath) f.struck = true;
  const fc = condition(f);
  const oc = condition(o);
  // Flanking: hitting from behind while one of its allies keeps the target's attention.
  const behind = Math.abs(wrap(dm.atan2(f.y - o.y, f.x - o.x) - o.heading)) > 2;
  const flank = w.mode === 'horde' && f.side === 1 && behind && o.target !== f.idx;
  // Bracing in an armoured move (a bear reared up) takes the edge off.
  const braced = o.state === 'attack' && o.move?.armor ? o.move.armor : 0;
  // A hurt limb hits weaker; a fighter nearly beaten fights like it has nothing to lose.
  const limb = limbOf(m, Math.max(0, f.hitIdx - 1));
  const limbMul = limb === 'fore' ? 1 - 0.3 * (isBiped(f.def) ? fc.arm : fc.leg) : limb === 'hind' ? 1 - 0.25 * fc.leg : 1;
  const desperate = fc.spent > 0.6 ? 1.15 : 1;
  // Its hide takes some kinds of blow better than others.
  const hide = 1 - (o.def.hide.resist[typeOf(f.def, m)] ?? 0);
  const dmg = m.damage * DAMAGE_MUL * w.rng.range(0.75, 1.25) * (crit ? CRIT : 1) * f.chargeBonus * (flank ? FLANK : 1) * (1 - o.def.armor) * (1 - braced) * dmgMul * limbMul * desperate * hide * traitDamage(w, f);
  o.hp -= dmg;
  o.lastHitBy = f.idx;
  o.lastHitT = w.simT;
  o.lastHitDir = dm.atan2(o.y - f.y, o.x - f.x);
  f.dealt += dmg;
  o.flash = Math.min(1, o.flash + (m.breath ? 0.25 : 1));
  if (m.breath) o.burn = 1;
  // Knockback by the mass ratio, away from the attacker; the attacker rebounds off a heavier body, and a
  // charge stops dead in it.
  const dx = o.x - f.x;
  const dy = o.y - f.y;
  const dl = Math.max(0.01, dm.hypot(dx, dy));
  // (Knocked back by the mass ratio and the attacker's strength; a stubborn or colossal body barely moves.)
  const k = m.knock * f.chargeBonus * ((2 * f.def.mass) / (f.def.mass + o.def.mass)) * (0.55 + 0.075 * f.def.strength) * (o.def.trait === 'stubborn' ? 0.6 : o.def.trait === 'colossus' ? 0.4 : 1);
  o.kx += (dx / dl) * k;
  o.ky += (dy / dl) * k;
  if (!m.breath) {
    const back = m.knock * 0.6 * (o.def.mass / (f.def.mass + o.def.mass));
    f.kx -= (dx / dl) * back;
    f.ky -= (dy / dl) * back;
    if (m.charge) f.spd *= 0.3;
  }
  if (m.poison) {
    o.poisonUntil = w.simT + POISON_S;
    o.poisonDps = m.poison;
    o.poisonBy = f.idx;
  }
  if (m.breath && f.def.trait === 'inferno') o.burnUntil = w.simT + 2.5;
  if (f.def.trait === 'sly' && !m.breath) f.retreatUntil = w.simT + 0.9;
  // (Sloppy or dazed, it is rocked more easily.)
  const poise = o.def.poise * DAMAGE_MUL * (1 - 0.45 * oc.sloppy) * (1 - 0.25 * oc.head) * (o.def.trait === 'stubborn' ? 1.6 : 1);
  const power = dmg / Math.max(1, poise);
  // Where it landed (the blow's own aim at its target; a cleave catches others wherever they face it).
  const aim: Aim = aimIn ?? pickAim(w, f, o, m, Math.max(0, f.hitIdx - 1));
  // A blow to a part already hurt makes it wince all the harder.
  o.lastHitPow = m.breath ? 0.1 : power * (1 + 0.8 * severity(o.hurt[keyOf(aim)]));
  // (A hamstringer's bites to the legs cripple faster.)
  if (f.def.trait === 'hamstring' && (aim.zone === 'fore' || aim.zone === 'hind')) o.hurt[keyOf(aim)] += (dmg / o.maxHp) * 0.6;
  if (m.breath) {
    o.burnAcc += dmg;
    o.hurt.body += (dmg / o.maxHp) * 0.5;
    o.hurt.head += (dmg / o.maxHp) * 0.2;
    if (o.def.hover) o.hurt.wing += (dmg / o.maxHp) * 0.3;
    if (o.burnAcc >= poise * 0.6) {
      o.burnAcc = 0;
      wound(w, o, aim, 'burn', poise * 0.6, f.idx, emit);
    }
  } else wound(w, o, aim, markOf(f, m), dmg, f.idx, emit);
  if (!m.breath)
    emit({ type: 'hit', a: f.idx, b: o.idx, move: m.name, sound: m.sound, dmg: Math.round(dmg), crit: crit ? 1 : 0, power: Math.round(power * 100) / 100, hp: Math.max(0, Math.round((o.hp / o.maxHp) * 1000) / 1000), mass: f.def.mass, weapon: f.def.weapon ?? '', vcall: o.def.voice?.call ?? '', vcp: o.def.voice?.pitch ?? 0.5, vmass: o.def.mass, zone: aim.zone, wound: o.wounds.length - 1, x: r1(o.x) });
  else emit({ type: 'burn', a: f.idx, b: o.idx, dmg: Math.round(dmg * 10) / 10, hp: Math.max(0, Math.round((o.hp / o.maxHp) * 1000) / 1000) });
  // Falling is settled once every blow of the step has landed (see stepWorld).
  if (o.hp <= 0) return;
  // Grapples: latch on, clamp and roll, or pin.
  if (m.grab && f.alive && f.state === 'attack' && f.move === m && o.heldBy < 0 && !o.grab && o.hover < 0.3 && !(o.def.trait === 'colossus' && m.grab.kind !== 'latch') && w.rng.chance(m.grab.chance ?? 1)) {
    startGrab(w, f, o, m.grab, aim, emit);
    return;
  }
  // Horn meets horn: two horned heads facing, the blow locks them together.
  if (
    w.mode === 'duel' &&
    (m.clip === 'headbutt' || m.clip === 'charge') &&
    clinchStyle(f.def) === 'horns' &&
    clinchStyle(o.def) === 'horns' &&
    (o.state === 'idle' || o.state === 'move' || o.state === 'attack') &&
    f.clinchReady <= w.simT &&
    o.clinchReady <= w.simT &&
    Math.abs(wrap(dm.atan2(f.y - o.y, f.x - o.x) - o.heading)) < 0.7 &&
    w.rng.chance(0.5)
  ) {
    f.kx = f.ky = o.kx = o.ky = 0;
    startClinch(w, f, o, emit);
    return;
  }
  if (m.breath || braced || o.staggerReady > w.simT || o.state === 'dodge' || o.state === 'held' || o.state === 'down') return;
  // Hard enough to take it off its feet (anything on the ground; a flier is only rocked)…
  const at = KNOCKDOWN_AT * (f.def.trait === 'hindKick' && m.hits[0].back ? 0.55 : 1) * (o.def.trait === 'stubborn' ? 1.6 : 1) * (1 - 0.35 * oc.sloppy);
  const bowled =
    power >= at || (m.charge && f.def.mass >= o.def.mass * 0.8 && power >= 1.1) || (f.def.mass >= o.def.mass * 4 && power >= 1) || (m.charge && f.def.trait === 'juggernaut' && o.def.mass < f.def.mass);
  const footed = o.def.trait === 'unstoppable' || o.def.trait === 'colossus';
  if (bowled && !footed && o.hover < 0.3 && (o.state !== 'attack' || o.hitIdx === 0)) {
    if (o.grab) release(w, o, false, emit);
    o.charging = -1;
    o.move = null;
    o.downLen = DOWN_S * clamp(0.8 + power * 0.12, 0.9, 1.5);
    o.fallDir = wrap(o.lastHitDir - o.heading) < 0 ? 1 : -1;
    o.staggerReady = w.simT + o.downLen + STAGGER_GUARD_S;
    setState(o, 'down', w.simT);
    emit({ type: 'knockdown', who: o.idx, by: f.idx, ...voiceOf(o.def), swarm: w.mode === 'horde' && o.side === 1 ? 1 : 0, x: r1(o.x) });
    return;
  }
  // …or to stagger it, cancelling its own attack if that hasn't landed yet.
  const stagger = (dmg >= poise * STAGGER_AT || (crit && dmg >= poise)) && (o.state !== 'attack' || o.hitIdx === 0);
  if (stagger) {
    if (o.grab) release(w, o, false, emit);
    o.charging = -1;
    o.staggerReady = w.simT + STAGGER_GUARD_S;
    setState(o, 'stagger', w.simT);
    emit({ type: 'stagger', who: o.idx, x: r1(o.x) });
  }
}

function startClinch(w: World, f: Fighter, t: Fighter, emit: Emit) {
  const until = w.simT + w.rng.range(1.3, 2.6);
  for (const [a, b] of [
    [f, t],
    [t, f],
  ] as const) {
    a.clinch = { with: b.idx, t0: w.simT, until, push: 0, surge: 0, next: w.simT + SURGE_S, style: clinchStyle(a.def)! };
    a.charging = -1;
    a.move = null;
    a.spd = 0;
    setState(a, 'clinch', w.simT);
  }
  emit({ type: 'clinch', a: f.idx, b: t.idx, horns: f.clinch!.style === 'horns' && t.clinch!.style === 'horns' ? 1 : 0, ...voiceOf(f.def), vcall: t.def.voice?.call ?? '', vcp: t.def.voice?.pitch ?? 0.5, x: r1(f.x) });
}

/** How hard it pushes right now. */
function clinchPower(f: Fighter) {
  const c = condition(f);
  const t = f.def.trait;
  return f.def.strength * (t === 'antlerLock' ? 1.6 : t === 'stubborn' ? 1.3 : 1) * (1 - 0.4 * c.sloppy) * (1 - 0.3 * c.leg) * (1 + 0.4 * f.clinch!.surge);
}

/** A grinding blow while locked: horns and heads crack together; wrestlers bite and claw at the neck. */
function grind(w: World, f: Fighter, o: Fighter, emit: Emit) {
  const horns = f.clinch!.style === 'horns';
  const type: DamageType = horns ? 'blunt' : 'pierce';
  const dmg = (1.5 + 0.6 * f.def.strength) * DAMAGE_MUL * 0.6 * (1 - o.def.armor) * (1 - (o.def.hide.resist[type] ?? 0)) * (w.fightT > w.capS ? 1 + (w.fightT - w.capS) * 0.5 : 1);
  o.hp -= dmg;
  o.lastHitBy = f.idx;
  o.lastHitT = w.simT;
  o.lastHitDir = dm.atan2(o.y - f.y, o.x - f.x);
  o.lastHitPow = 0.35;
  o.flash = Math.min(1, o.flash + 0.25);
  f.dealt += dmg;
  const side = sideOf(o, f);
  const aim: Aim = horns ? { zone: 'head', side, u: w.rng.range(0.5, 1), v: w.rng.range(0.4, 1) } : { zone: 'body', side, u: w.rng.range(0.8, 1), v: w.rng.range(0, 0.5) };
  if (w.rng.chance(0.5)) wound(w, o, aim, horns ? 'blunt' : w.rng.chance(0.5) ? 'bite' : 'claw', dmg * 2, f.idx, emit);
  else o.hurt[keyOf(aim)] += dmg / o.maxHp;
  emit({ type: 'grind', a: f.idx, b: o.idx, horns: horns ? 1 : 0, dmg: Math.round(dmg * 10) / 10, hp: Math.max(0, Math.round((o.hp / o.maxHp) * 1000) / 1000), x: r1(o.x) });
}

/**
 * Locked together (run by the lower-numbered of the pair): each pushes with its strength, in surges; the
 * pair grinds towards the weaker one, circling slowly, trading blows; until one gives and is shoved aside,
 * turned to show its flank, or thrown down.
 */
function runClinch(w: World, a: Fighter, dt: number, emit: Emit) {
  const c = a.clinch!;
  const b = w.fighters[c.with];
  if (!b.alive || b.clinch?.with !== a.idx) {
    a.clinch = null;
    setState(a, 'idle', w.simT, w.rng);
    return;
  }
  if (w.simT >= c.next) {
    c.next += SURGE_S;
    c.surge = w.rng.range(-1, 1);
    b.clinch!.surge = w.rng.range(-1, 1);
    if (Math.round((c.next - c.t0) / SURGE_S) % 2 === 0) {
      grind(w, a, b, emit);
      grind(w, b, a, emit);
    }
  }
  const net = clinchPower(a) - clinchPower(b);
  c.push += net * dt;
  b.clinch!.push = -c.push;
  const ang = dm.atan2(b.y - a.y, b.x - a.x) + a.orbit * 0.35 * dt;
  const v = clamp(net * 0.12, -0.9, 0.9);
  const mx = (a.x + b.x) / 2 + dm.cos(ang) * v * dt;
  const my = (a.y + b.y) / 2 + dm.sin(ang) * v * dt;
  const da = extent(a, ang) - 0.03;
  const db = extent(b, ang + Math.PI) - 0.03;
  const off = (da - db) / 2;
  a.x = mx - dm.cos(ang) * (da - off);
  a.y = my - dm.sin(ang) * (da - off);
  b.x = mx + dm.cos(ang) * (db + off);
  b.y = my + dm.sin(ang) * (db + off);
  a.heading = ang;
  b.heading = wrap(ang + Math.PI);
  a.spd = v;
  b.spd = -v;
  a.kx = a.ky = b.kx = b.ky = 0;
  if (w.simT < c.until && Math.abs(c.push) < 2.6) return;
  // One gives.
  const aWins = Math.abs(c.push) < 0.3 ? w.rng.chance(0.5 + 0.1 * Math.sign(c.push)) : c.push > 0;
  const win = aWins ? a : b;
  const lose = aWins ? b : a;
  for (const f of [a, b]) {
    f.clinch = null;
    f.spd = 0;
    f.clinchReady = w.simT + w.rng.range(4, 7);
  }
  // Shoved aside and turned (its flank to the winner), or thrown off its feet.
  lose.heading = wrap(lose.heading + (w.rng.chance(0.5) ? 1 : -1) * w.rng.range(0.9, 1.5));
  const away = dm.atan2(lose.y - win.y, lose.x - win.x);
  const kick = 2.4 + 0.35 * Math.max(0, win.def.strength - lose.def.strength);
  lose.kx += dm.cos(away) * kick;
  lose.ky += dm.sin(away) * kick;
  lose.lastHitDir = away;
  lose.lastHitT = w.simT;
  lose.lastHitPow = 1.2;
  const footed = lose.def.trait === 'unstoppable' || lose.def.trait === 'colossus';
  const thrown = !footed && (win.def.strength / lose.def.strength > 1.5 || (win.def.trait !== 'antlerLock' && clinchStyle(win.def) === 'wrestle' && w.rng.chance(0.3)));
  if (thrown) {
    lose.downLen = DOWN_S;
    lose.fallDir = wrap(away - lose.heading) < 0 ? 1 : -1;
    lose.staggerReady = w.simT + DOWN_S + STAGGER_GUARD_S;
    setState(lose, 'down', w.simT);
  } else {
    lose.staggerReady = w.simT + STAGGER_GUARD_S;
    setState(lose, 'stagger', w.simT);
  }
  // The winner goes straight for the opening.
  setState(win, 'idle', w.simT);
  win.commitAt = w.simT;
  win.ready = win.ready.map((t, i) => (win.def.moves[i].roar ? t : Math.min(t, w.simT + 0.1)));
  emit({ type: 'shove', a: win.idx, b: lose.idx, down: thrown ? 1 : 0, ...voiceOf(win.def), vcall: lose.def.voice?.call ?? '', vcp: lose.def.voice?.pitch ?? 0.5, mass: lose.def.mass, x: r1(lose.x) });
}

/** A trait coming into play: called out once. */
function sayTrait(f: Fighter, text: string, emit: Emit) {
  emit({ type: 'trait', who: f.idx, text, ...voiceOf(f.def), swarm: f.number > 0 ? 1 : 0, x: r1(f.x) });
}

function startGrab(w: World, f: Fighter, o: Fighter, g: NonNullable<MoveDef['grab']>, aim: Aim, emit: Emit) {
  const side = sideOf(o, f);
  // A latch bites into the shoulders it rides; a roll keeps what it clamped; a pin goes for the neck.
  const hold: Aim = g.kind === 'latch' ? { zone: 'body', side, u: 0.82, v: 0.08 } : g.kind === 'pin' ? { zone: 'body', side, u: 0.85, v: 0.25 } : aim;
  f.grab = { kind: g.kind, target: o.idx, t0: w.simT, until: w.simT + g.seconds, next: w.simT + GRAB_TICK, dps: g.dps, side, aim: hold, ticks: 0 };
  f.aim = hold;
  f.move = null;
  f.charging = -1;
  setState(f, 'grab', w.simT);
  o.heldBy = f.idx;
  o.charging = -1;
  if (g.kind !== 'latch') {
    if (o.grab) release(w, o, false, emit);
    o.move = null;
    setState(o, 'held', w.simT);
  }
  emit({ type: 'grab', a: f.idx, b: o.idx, kind: g.kind, ...voiceOf(f.def), vcall: o.def.voice?.call ?? '', vcp: o.def.voice?.pitch ?? 0.5, x: r1(o.x) });
}

/** Let go (or be thrown off). */
function release(w: World, f: Fighter, thrown: boolean, emit: Emit) {
  const g = f.grab;
  if (!g) return;
  const o = w.fighters[g.target];
  f.grab = null;
  f.aim = null;
  if (o.heldBy === f.idx) {
    o.heldBy = -1;
    if (o.alive && o.state === 'held') setState(o, 'idle', w.simT, w.rng);
  }
  if (!f.alive) return;
  if (thrown) {
    const a = dm.atan2(f.y - o.y, f.x - o.x);
    const k = 5 * Math.min(2, Math.sqrt(o.def.mass / f.def.mass));
    f.kx += dm.cos(a) * k;
    f.ky += dm.sin(a) * k;
    f.staggerReady = w.simT + STAGGER_GUARD_S;
    setState(f, 'stagger', w.simT);
    emit({ type: 'shakeOff', a: f.idx, b: o.idx, kind: g.kind, x: r1(f.x) });
  } else if (f.state === 'grab') setState(f, 'idle', w.simT, w.rng);
}

/** Hold on: ride or pin the target, maul it, and maybe get thrown off. */
function runGrab(w: World, f: Fighter, emit: Emit) {
  const g = f.grab!;
  const o = w.fighters[g.target];
  if (!o.alive || w.simT >= g.until) {
    release(w, f, false, emit);
    return;
  }
  if (g.kind === 'latch') {
    // Riding its side, facing in: on the shoulders of a big target.
    const ang = o.heading + g.side * -1.75;
    const dist = extent(o, ang) + (f.def.front ?? f.def.radius) * 0.45;
    f.x = o.x + dm.cos(ang) * dist;
    f.y = o.y + dm.sin(ang) * dist;
    f.heading = dm.atan2(o.y - f.y, o.x - f.x) + g.side * 0.35;
  } else {
    // Held in the jaws (or under the paws), just in front of the snout.
    const reach = (f.def.front ?? f.def.radius) * 0.95 + extent(o, f.heading + Math.PI) * 0.5;
    o.x = f.x + dm.cos(f.heading) * reach;
    o.y = f.y + dm.sin(f.heading) * reach;
    o.kx = o.ky = o.spd = 0;
  }
  f.spd = f.kx = f.ky = 0;
  const dmgMul = w.fightT > w.capS ? 1 + (w.fightT - w.capS) * 0.5 : 1;
  while (f.grab && w.simT >= g.next) {
    g.next += GRAB_TICK;
    g.ticks++;
    const dmg = g.dps * GRAB_TICK * DAMAGE_MUL * (1 - o.def.armor) * dmgMul;
    o.hp -= dmg;
    o.lastHitBy = f.idx;
    o.lastHitT = w.simT;
    o.lastHitDir = dm.atan2(o.y - f.y, o.x - f.x);
    o.lastHitPow = 0.3;
    o.flash = Math.min(1, o.flash + 0.3);
    f.dealt += dmg;
    // The grip tears at the same place; now and then a fresh mark beside it.
    const aim = g.ticks % 3 === 1 ? { ...g.aim, u: clamp(g.aim.u + w.rng.range(-0.12, 0.12), 0, 1), v: clamp(g.aim.v + w.rng.range(-0.15, 0.15), 0, 1) } : null;
    if (aim) wound(w, o, aim, g.kind === 'pin' ? 'claw' : 'bite', dmg * 3, f.idx, emit);
    else o.hurt[keyOf(g.aim)] += dmg / o.maxHp;
    emit({ type: 'maul', a: f.idx, b: o.idx, kind: g.kind, dmg: Math.round(dmg * 10) / 10, hp: Math.max(0, Math.round((o.hp / o.maxHp) * 1000) / 1000), x: r1(o.x) });
    if (o.hp <= 0) break;
    // The stronger the target (against the grabber), the sooner it throws it off; an iron grip holds.
    // (A sloppy one struggles feebly.)
    const ratio = (o.def.strength / f.def.strength) * 1.2 * (f.def.trait === 'ironGrip' ? 0.4 : 1) * (1 - 0.5 * condition(o).sloppy);
    const p = g.kind === 'latch' ? clamp(0.02 + 0.045 * ratio, 0.02, 0.4) : clamp(0.01 + 0.035 * ratio, 0.01, 0.3);
    if (w.rng.chance(p)) release(w, f, true, emit);
  }
}

function kill(w: World, o: Fighter, by: number, emit: Emit) {
  if (o.grab) release(w, o, false, emit);
  if (o.clinch) {
    const p = w.fighters[o.clinch.with];
    o.clinch = null;
    if (p.clinch) {
      p.clinch = null;
      if (p.alive) setState(p, 'idle', w.simT, w.rng);
    }
  }
  if (o.heldBy >= 0) release(w, w.fighters[o.heldBy], false, emit);
  o.alive = false;
  o.diedAt = w.simT;
  o.charging = -1;
  o.fallDir = wrap(o.lastHitDir - o.heading) < 0 ? 1 : -1;
  setState(o, 'dead', w.simT);
  w.koWho = o.idx;
  w.koBy = by;
  emit({ type: 'ko', who: o.idx, by, side: o.side, number: o.number, ...voiceOf(o.def), x: r1(o.x) });
}

/** Resolve the current move's hits and breath ticks that are due. */
function resolveAttack(w: World, f: Fighter, emit: Emit) {
  const m = f.move!;
  const el = w.simT - f.stateT;
  while (f.hitIdx < m.hits.length && el >= m.hits[f.hitIdx].at * m.len) {
    const h = m.hits[f.hitIdx++];
    if (m.breath) continue;
    if (m.roar) {
      // Smaller enemies nearby flinch (and a proud one is fired up).
      emit({ type: 'roar', who: f.idx, ...voiceOf(f.def), swarm: w.mode === 'horde' && f.side === 1 ? 1 : 0, x: r1(f.x) });
      if (f.def.trait === 'pride') f.prideUntil = w.simT + 6;
      for (const o of enemiesOf(w, f)) {
        if (relation(f, o).gap > m.roar.radius || o.def.mass >= f.def.mass * 0.75 || o.staggerReady > w.simT || o.state === 'held' || o.state === 'down') continue;
        if (o.grab) release(w, o, false, emit);
        o.charging = -1;
        o.staggerReady = w.simT + STAGGER_GUARD_S;
        setState(o, 'stagger', w.simT);
        emit({ type: 'flinch', who: o.idx, x: r1(o.x) });
      }
      continue;
    }
    // It lands on whoever its striking part can actually reach now (the target, or anyone else in the way).
    let landed = 0;
    const k = f.hitIdx - 1;
    const parts = strikeParts(f.def, m, k).length > 0;
    const foes = enemiesOf(w, f).sort((a, b) => (a.idx === f.target ? -1 : b.idx === f.target ? 1 : 0));
    for (const o of foes) {
      const r = relation(f, o);
      const off = h.back ? Math.abs(wrap(r.rel + Math.PI)) : Math.abs(r.rel);
      // (A striking part: the bodies within the blow's own reach, and the part able to reach the spot.)
      if (parts ? r.gap > m.reach + 0.4 || off > m.arc + 0.6 : r.gap > m.reach + CONTACT || off > m.arc) continue;
      const aim = parts ? (o.idx === f.target && f.aim ? { ...f.aim, side: sideOf(o, f) } : pickAim(w, f, o, m, k)) : null;
      if (aim && shortOf(f, o, m, k, aim) > CONTACT * 0.5) continue;
      if (o.state === 'dodge' && w.simT - o.stateT < o.def.dodge!.len * 0.7) {
        emit({ type: 'miss', a: f.idx, b: o.idx, dodged: 1 });
        continue;
      }
      // A shield takes blows from the front.
      if (o.def.trait === 'shield' && (o.state === 'idle' || o.state === 'move' || o.state === 'prep') && Math.abs(wrap(dm.atan2(f.y - o.y, f.x - o.x) - o.heading)) < 0.9 && w.rng.chance(0.45)) {
        o.blockT = w.simT;
        const ang = dm.atan2(o.y - f.y, o.x - f.x);
        const k = m.knock * 0.4 * ((2 * f.def.mass) / (f.def.mass + o.def.mass));
        o.kx += dm.cos(ang) * k;
        o.ky += dm.sin(ang) * k;
        emit({ type: 'block', a: f.idx, b: o.idx, mass: f.def.mass, x: r1(o.x) });
        landed++;
        continue;
      }
      w.pending.push({ f, o, m, aim });
      landed++;
      // The big ones cleave through a few at once; small fighters bite one thing.
      if (landed >= (f.def.mass > 300 ? 3 : 1)) break;
    }
    if (!landed) emit({ type: 'miss', a: f.idx, b: f.target, dodged: 0, x: r1(f.x) });
  }
  if (m.breath && el >= f.breathNext && el <= m.breath.until * m.len) {
    f.breathNext += BREATH_TICK;
    for (const o of enemiesOf(w, f)) {
      const r = relation(f, o);
      if (r.gap <= m.reach && Math.abs(r.rel) <= m.arc + dm.atan(o.def.radius / Math.max(0.5, r.dist))) w.pending.push({ f, o, m, aim: null });
    }
  }
  if (el >= m.len) {
    f.move = null;
    f.aim = null;
    setState(f, 'idle', w.simT, w.rng);
  }
}

/** Horde: let the next ones in, and decide who of the swarm is close enough to fight. */
function runSwarm(w: World, emit: Emit) {
  const sw = w.swarm!;
  const big = w.fighters[0];
  const alive = w.fighters.filter((f) => f.side === 1 && f.alive);
  if (sw.sent < sw.total && w.fightT >= sw.nextAt && alive.length < MAX_ALIVE && big.alive) {
    sw.sent++;
    const gate = sw.gates[(sw.sent - 1) % sw.gates.length];
    const r = ARENA_R - sw.def.radius - 0.3;
    const f = makeFighter(w.fighters.length, 1, sw.def, dm.cos(gate) * r, dm.sin(gate) * r, gate + Math.PI, w.hpScale * SWARM_HP, w.rng, w.simT);
    f.number = sw.sent;
    f.engaged = false;
    w.fighters.push(f);
    // The first few come in together, then one at a time, ever faster.
    const gap = sw.sent < 3 ? 0.35 : clamp(2 * dm.pow(0.93, sw.sent - 3), 0.55, 2);
    sw.nextAt = w.fightT + gap;
    emit({ type: 'spawn', who: f.idx, number: sw.sent, total: sw.total, ...voiceOf(sw.def), x: r1(f.x) });
  }
  // Slots round the big fighter: as many as fit shoulder to shoulder, up to six.
  const r0 = big.def.radius + sw.def.radius + 0.4;
  const slots = clamp(Math.floor((2 * Math.PI * r0) / (2 * sw.def.radius + 0.7)), 2, MAX_ENGAGED);
  const ranked = alive.map((f) => ({ f, d: dm.hypot(f.x - big.x, f.y - big.y) - (f.engaged ? 2 : 0) })).sort((p, q) => p.d - q.d || p.f.idx - q.f.idx);
  ranked.forEach((p, i) => {
    p.f.engaged = i < slots;
  });
}

function separate(w: World) {
  const live = w.fighters.filter((f) => f.alive);
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j];
      if (a.grab?.target === b.idx || b.grab?.target === a.idx) continue;
      // A flier passes over whatever is below it.
      if (Math.abs(a.hover - b.hover) > Math.min(a.def.height, b.def.height) * 0.8) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const far = Math.max(a.def.radius, a.def.front ?? 0, a.def.back ?? 0) + Math.max(b.def.radius, b.def.front ?? 0, b.def.back ?? 0);
      if (Math.abs(dx) > far || Math.abs(dy) > far) continue;
      const d = dm.hypot(dx, dy);
      const ang = dm.atan2(dy, dx);
      const min = extent(a, ang) + extent(b, ang + Math.PI);
      if (d >= min) continue;
      const nx = d > 1e-6 ? dx / d : 1;
      const ny = d > 1e-6 ? dy / d : 0;
      const push = min - d;
      const share = b.def.mass / (a.def.mass + b.def.mass);
      a.x -= nx * push * share;
      a.y -= ny * push * share;
      b.x += nx * push * (1 - share);
      b.y += ny * push * (1 - share);
    }
    const r = dm.hypot(a.x, a.y);
    const lim = ARENA_R - extent(a, dm.atan2(a.y, a.x));
    if (r > lim) {
      a.x *= lim / r;
      a.y *= lim / r;
      // Knocked into the wall: the knockback stops there.
      const out = (a.kx * a.x + a.ky * a.y) / lim;
      if (out > 0) {
        a.kx -= (out * a.x) / lim;
        a.ky -= (out * a.y) / lim;
      }
    }
  }
}

/** One live fight step (sim time dt). */
export function stepWorld(w: World, dt: number, emit: Emit) {
  // The opening hesitations (commitAt) count from the bell, not from the start of the intro.
  if (w.fightT === 0) for (const f of w.fighters) f.commitAt += w.simT;
  w.simT += dt;
  w.fightT += dt;
  if (w.swarm) runSwarm(w, emit);
  for (const f of w.fighters) {
    if (!f.alive) {
      settle(f, dt);
      procTick(f, dt, w.simT);
      continue;
    }
    const d = f.def;
    // Poison ticks (it can finish someone off).
    if (f.poisonUntil > w.simT) {
      f.hp -= f.poisonDps * dt * (w.fightT > w.capS ? 1 + (w.fightT - w.capS) * 0.5 : 1);
      if (f.hp <= 0) kill(w, f, f.poisonBy, emit);
    }
    // Traits that run on their own: mending, regenerating (not while burnt), a fire that keeps burning.
    if (d.trait === 'healing' || d.trait === 'regen') {
      const burnt = f.burnUntil > w.simT || f.burn > 0.3;
      if (!(d.trait === 'regen' && burnt)) {
        const rate = d.trait === 'regen' ? 0.007 : 0.003;
        f.hp = Math.min(f.maxHp, f.hp + f.maxHp * rate * dt);
        for (const k of Object.keys(f.hurt) as HurtKey[]) f.hurt[k] = Math.max(0, f.hurt[k] - dt * rate);
      }
    }
    if (f.burnUntil > w.simT) {
      f.hp -= 1.6 * DAMAGE_MUL * dt * (1 - (d.hide.resist.fire ?? 0));
      f.burn = Math.max(f.burn, 0.6);
      if (f.hp <= 0) kill(w, f, f.lastHitBy, emit);
    }
    if (!f.alive) continue;
    // It read a blow coming: a quick hop back (and aside) out of reach.
    if (f.evadeAt > 0 && w.simT >= f.evadeAt) {
      f.evadeAt = 0;
      const a = w.fighters[f.evadeFrom];
      if (a && (f.state === 'idle' || f.state === 'move')) {
        const ang = dm.atan2(f.y - a.y, f.x - a.x) + w.rng.range(-0.6, 0.6);
        f.kx += dm.cos(ang) * EVADE_V;
        f.ky += dm.sin(ang) * EVADE_V;
        f.evadeT = w.simT;
        f.lastHitDir = ang;
        emit({ type: 'evade', who: f.idx, x: r1(f.x) });
      }
    }
    const c = condition(f);
    let heading = f.heading;
    let speed = 0;
    // (Paralysing venom slows it; a berserker hurt speeds up.)
    const venom = f.poisonUntil > w.simT && w.fighters[f.poisonBy]?.def.trait === 'paralysis' ? 0.6 : 1;
    const rage = d.trait === 'berserk' && f.hp < f.maxHp * 0.5 ? 1.25 : 1;
    let turn = d.turn * (1 - 0.2 * c.leg) * (1 - 0.3 * c.head) * venom;
    switch (f.state) {
      case 'idle':
      case 'move': {
        const plan = think(w, f, emit);
        heading = plan.heading;
        // Injuries and exhaustion slow it down.
        // (A bad leg slows it; nothing else does: winded or worn out, it fights on at full pace.)
        speed = plan.speed * (1 - 0.35 * c.leg - 0.15 * c.leg2) * venom * rage;
        const next = speed > 0.2 ? 'move' : 'idle';
        // (Unless it just started an attack.)
        if ((f.state === 'idle' || f.state === 'move') && f.state !== next) setState(f, next, w.simT);
        break;
      }
      case 'attack': {
        const m = f.move!;
        const el = w.simT - f.stateT;
        const firstHit = m.hits[0].at * m.len;
        // Track the target until the blow lands (slowly: big swings can be read and dodged).
        const t = w.fighters[f.target];
        if (t && t.alive && el < firstHit && !m.hits[0].back) heading = relation(f, t).ang;
        turn *= 0.45;
        // The target turned or moved and the spot it was going for is out of reach: it goes for another.
        if (t && t.alive && f.aim && el < firstHit && Math.floor(el * 30) !== Math.floor((el - dt) * 30)) {
          const left = Math.sign(f.lungeV) * Math.min(Math.abs(f.lungeV) * (firstHit - el), Math.max(0, relation(f, t).gap));
          const aim = { ...f.aim, side: sideOf(t, f) };
          if (shortOf(f, t, m, 0, aim, left) > 0) f.aim = pickAim(w, f, t, m, 0, left);
        }
        // The committed lunge (or leap, or charge) up to the first hit.
        speed = el < firstHit ? f.lungeV : 0;
        break;
      }
      case 'stagger':
        speed = 0;
        if (w.simT - f.stateT >= PROC_STAGGER_S) setState(f, 'idle', w.simT, w.rng);
        break;
      case 'down':
        speed = 0;
        turn = 0;
        if (w.simT - f.stateT >= f.downLen) setState(f, 'idle', w.simT, w.rng);
        break;
      case 'prep': {
        // Pawing the ground, head down, facing its target: then the charge.
        const t = w.fighters[f.target];
        if (t && t.alive) heading = relation(f, t).ang;
        speed = 0;
        if (w.simT - f.stateT >= PREP_S) {
          setState(f, 'move', w.simT);
          emit({ type: 'charge', who: f.idx, ...voiceOf(d), x: r1(f.x) });
        }
        break;
      }
      case 'clinch':
        if (f.clinch && f.idx < f.clinch.with) runClinch(w, f, dt, emit);
        else if (!f.clinch) setState(f, 'idle', w.simT, w.rng);
        heading = f.heading;
        break;
      case 'grab':
        runGrab(w, f, emit);
        heading = f.heading;
        break;
      case 'held':
        break;
      case 'dodge': {
        const dd = d.dodge!;
        // Sidestep: moves sideways without turning.
        const s = (dd.distance / (dd.len * 0.7)) * f.dodgeDir;
        f.x += dm.cos(f.heading + Math.PI / 2) * s * dt;
        f.y += dm.sin(f.heading + Math.PI / 2) * s * dt;
        if (w.simT - f.stateT >= dd.len * 0.7) {
          setState(f, 'idle', w.simT, w.rng);
          // A riposte: straight back at it.
          if (d.trait === 'riposte') {
            f.commitAt = w.simT;
            f.ready = f.ready.map((t) => Math.min(t, w.simT));
            sayTrait(f, 'RIPOSTE!', emit);
          }
        }
        break;
      }
    }
    // Carrying a lion on its back: slowed, turning stiffly.
    if (f.heldBy >= 0) {
      speed *= 0.5;
      turn *= 0.6;
    }
    // (Locked in a clinch, the struggle moves it.)
    if (f.state !== 'clinch') {
      const dh = clamp(wrap(heading - f.heading), -turn * dt, turn * dt);
      f.heading = wrap(f.heading + dh);
      // Big turns slow you down (no full-speed hairpins).
      const target = speed * (0.35 + 0.65 * Math.max(0, dm.cos(wrap(heading - f.heading))));
      const accel = f.state === 'attack' ? 30 : f.state === 'down' ? 10 : target > f.spd ? 4 : 7;
      f.spd += (target - f.spd) * (1 - dm.exp(-dt * accel));
      f.x += dm.cos(f.heading) * f.spd * dt;
      f.y += dm.sin(f.heading) * f.spd * dt;
    }
    if (f.state === 'attack') resolveAttack(w, f, emit);
  }
  // Everything that landed this step lands together: two blows trading in the same instant both count.
  for (const { f, o, m, aim } of w.pending) if (o.alive) applyHit(w, f, o, m, aim, emit);
  w.pending.length = 0;
  const falling = w.fighters.filter((f) => f.alive && f.hp <= 0);
  if (falling.length) {
    // A double knockout would leave nobody: the one with the most left in it (least overkill) hangs on.
    const standing = (side: number) => w.fighters.some((f) => f.alive && f.hp > 0 && f.side === side) || (side === 1 && w.swarm !== null && w.swarm.sent < w.swarm.total);
    if (!standing(0) && !standing(1)) falling.reduce((a, b) => (b.hp > a.hp ? b : a)).hp = 1;
    for (const f of falling) if (f.hp <= 0) kill(w, f, f.lastHitBy, emit);
  }
  for (const f of w.fighters) {
    if (!f.alive) continue;
    const t = f.def.trait;
    if (t === 'secondWind' && !f.windUsed && f.hp < f.maxHp * 0.2) {
      f.windUsed = true;
      f.hp += f.maxHp * 0.25;
      f.hurt.body = 0;
      f.hurt.head *= 0.5;
      sayTrait(f, 'SECOND WIND!', emit);
    }
    if (!f.saidTrait && ((t === 'lastStand' && f.hp < f.maxHp * 0.3) || (t === 'berserk' && f.hp < f.maxHp * 0.5) || (t === 'rampage' && f.hp < f.maxHp * 0.5))) {
      f.saidTrait = true;
      sayTrait(f, t === 'lastStand' ? 'LAST STAND!' : t === 'berserk' ? 'BERSERK!' : 'RAMPAGE!', emit);
    }
  }
  for (const f of w.fighters) {
    if (f.alive) settle(f, dt);
    if (f.alive) procTick(f, dt, w.simT);
    // Footfalls of anything running (walking is quiet), the heavy ones loudest.
    const fall = Math.floor(f.gait * 2);
    if (fall > f.steps) {
      f.steps = fall;
      if (f.alive && Math.abs(f.spd) > f.def.walk * 1.8 && f.def.mass > 40 && f.hover < 0.3) emit({ type: 'step', who: f.idx, feet: f.def.feet ?? 'paw', mass: f.def.mass, x: r1(f.x) });
    }
  }
  separate(w);
  decide(w, emit);
}

function decide(w: World, emit: Emit) {
  if (w.winner >= 0) return;
  const alive0 = w.fighters.some((f) => f.side === 0 && f.alive);
  const alive1 = w.fighters.some((f) => f.side === 1 && f.alive);
  const sw = w.swarm;
  if (alive0 && (alive1 || (sw !== null && sw.sent < sw.total))) return;
  w.winner = alive0 ? 0 : 1;
  emit({ type: 'decided', winner: w.winner, sent: sw?.sent ?? 0, by: w.koBy, who: w.koWho });
}

/** A finishing blow is coming: someone is winding up a move that would KO its target. */
export function finisherIncoming(w: World): Fighter | null {
  for (const f of w.fighters) {
    if (!f.alive || f.state !== 'attack' || f.hitIdx > 0 || f.move!.breath) continue;
    const t = w.fighters[f.target];
    if (!t || !t.alive || t.evadeAt > 0) continue;
    const lastOfSide = !w.fighters.some((o) => o !== t && o.alive && o.side === t.side) && !(t.side === 1 && w.swarm && w.swarm.sent < w.swarm.total);
    if (!lastOfSide) continue;
    const r = relation(f, t);
    if (r.gap > f.move!.reach + (f.move!.lunge ?? 0) + 0.3) continue;
    if (t.hp <= f.move!.damage * f.chargeBonus * 0.9 * (1 - t.def.armor)) return t;
  }
  return null;
}
