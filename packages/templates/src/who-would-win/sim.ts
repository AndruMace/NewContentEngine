/**
 * The fight, in 2D on the arena floor (metres; the view maps sim (x, y) to three.js (x, z)). Fighters
 * are circles that steer, turn, attack, take hits, get knocked back, stagger, dodge and die. Everything
 * here is deterministic (dm.* maths, the run's rng only); the animation state each fighter carries is
 * derived from its sim state, so the view can pose a model from a snapshot alone.
 */
import type { Rng } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { COOLDOWN_MUL, DAMAGE_MUL } from './balance';
import { strideFor, type CreatureDef, type MoveDef } from './roster';

/** Arena floor radius (inside the wall). */
export const ARENA_R = 10;
/** Breath attacks hit everyone in their cone this often. */
export const BREATH_TICK = 0.1;
const CRIT_CHANCE = 0.15;
const CRIT = 1.8;
/** A small fighter behind its target while another one keeps it busy does extra damage. */
const FLANK = 1.3;
const POISON_S = 4;
/** After a stagger, a fighter can't be staggered again for this long (no stun-locks). */
const STAGGER_GUARD_S = 2.5;
/** A blow staggers when it does this many times the target's poise (or crits past its poise). */
const STAGGER_AT = 1.4;
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
/** Gate angles in the arena wall (at the back, as the camera sees it). */
export const GATES = [-Math.PI / 2, -Math.PI / 2 + 0.9, -Math.PI / 2 - 0.9];

export type Emit = (e: { type: string; [k: string]: unknown }) => void;

export type FighterState = 'idle' | 'move' | 'attack' | 'stagger' | 'dodge' | 'dead' | 'grab' | 'held';

export interface Grab {
  kind: 'latch' | 'roll' | 'pin';
  target: number;
  t0: number;
  until: number;
  next: number;
  dps: number;
  /** Latch: which side of the target it rides (1 left, -1 right). */
  side: 1 | -1;
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
  /** When and from which direction (rad) it was last hit (for flinches). */
  lastHitT: number;
  lastHitDir: number;
  /** When it last started an attack (an ambusher creeps closer after waiting a while). */
  lastActT: number;
  /** The current charge will stop short. */
  bluffing: boolean;
  /** Footfalls so far (two per gait cycle), for footstep sounds. */
  steps: number;
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
  pending: { f: Fighter; o: Fighter; m: MoveDef }[];
  /** The last fighter to fall, and who felled it (the deciding blow once the fight is decided). */
  koWho: number;
  koBy: number;
}

/** What the audio needs of a fighter (the sound mapping only sees events). */
const voiceOf = (d: CreatureDef) => ({ call: d.voice?.call ?? '', cp: d.voice?.pitch ?? 0.5, feet: d.feet ?? 'paw', mass: d.mass });

const wrap = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

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
    lastActT: simT,
    bluffing: false,
    steps: 0,
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
  if (rng && state === 'idle') f.commitAt = simT + rng.range(0, 0.35);
}

/** Choose the clip for the fighter's state and advance clip time (crossfading on a change). */
/** Procedural creatures: feet (gait cycles from the distance walked), turn rate and crouch. */
function procTick(f: Fighter, dt: number) {
  const yaw = wrap(f.heading - f.prevHeading);
  f.prevHeading = f.heading;
  f.yawRate += (yaw / dt - f.yawRate) * (1 - dm.exp(-dt * 8));
  const s = Math.abs(f.spd);
  if (s > 0.15 && f.state !== 'grab' && f.state !== 'held' && f.state !== 'dead') f.gait += (dt * s) / strideFor(f.def.proc, s);
  f.crouch += (f.crouchWant - f.crouch) * (1 - dm.exp(-dt * 4));
}

function animate(f: Fighter, dt: number) {
  procTick(f, dt);
}

/** Animate only (before the fight starts and after it ends): idle, death clips, knockback settling. */
export function idleWorld(w: World, dt: number) {
  w.simT += dt;
  for (const f of w.fighters) {
    if (f.alive && f.state !== 'dead') {
      if (f.grab) release(w, f, false, () => {});
      f.spd *= dm.exp(-dt * 6);
      if (f.state !== 'idle' && f.state !== 'move') setState(f, 'idle', w.simT);
    }
    settle(f, dt);
    animate(f, dt);
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
 * longer ahead and behind than to the sides. */
export function extent(f: Fighter, ang: number) {
  const d = f.def;
  const c = dm.cos(wrap(ang - f.heading));
  return d.radius + ((d.front ?? d.radius) - d.radius) * Math.max(0, c) * Math.max(0, c) + ((d.back ?? d.radius) - d.radius) * Math.max(0, -c) * Math.max(0, -c);
}

/** Where `o` sits from `f`: edge-to-edge gap and angle off f's facing. */
function relation(f: Fighter, o: Fighter) {
  const dx = o.x - f.x;
  const dy = o.y - f.y;
  const dist = dm.hypot(dx, dy);
  const ang = dm.atan2(dy, dx);
  return { dx, dy, dist, gap: dist - extent(f, ang) - extent(o, ang + Math.PI), rel: wrap(ang - f.heading), ang };
}

function startAttack(w: World, f: Fighter, i: number, emit: Emit) {
  const m = f.def.moves[i];
  f.move = m;
  f.moveIdx = i;
  f.hitIdx = 0;
  f.breathNext = m.hits[0].at * m.len;
  f.chargeBonus = m.charge ? 1 + 0.6 * clamp(f.spd / f.def.run, 0, 1) : 1;
  f.ready[i] = w.simT + m.cooldown * COOLDOWN_MUL;
  f.lastActT = w.simT;
  setState(f, 'attack', w.simT);
  emit({ type: 'swing', who: f.idx, move: m.name, sound: m.sound, ...voiceOf(f.def), big: (m.weight ?? 1) >= 3 || m.charge || m.grab ? 1 : 0, breath: m.breath ? 1 : 0, weapon: f.def.weapon ?? '', x: Math.round(f.x * 10) / 10 });
  // Anyone it is swinging at may sidestep (if they are quick enough on their feet).
  for (const o of enemiesOf(w, f)) {
    const d = o.def.dodge;
    if (!d || (o.state !== 'idle' && o.state !== 'move') || o.dodgeReady > w.simT) continue;
    const r = relation(f, o);
    if (r.gap > m.reach + (m.lunge ?? 0) + 0.5 || Math.abs(r.rel) > m.arc + 0.3) continue;
    o.dodgeReady = w.simT + d.cooldown;
    if (!w.rng.chance(d.chance)) continue;
    o.dodgeDir = w.rng.chance(0.5) ? 1 : -1;
    setState(o, 'dodge', w.simT);
    emit({ type: 'dodge', who: o.idx, x: Math.round(o.x * 10) / 10 });
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
  // Down: staggered, held, or nearly finished.
  const downed = t.state === 'stagger' || t.state === 'held' || t.hp < t.maxHp * 0.3;
  const grabbable = !t.def.hover && t.heldBy < 0 && !t.grab;

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
      emit({ type: 'bluff', who: f.idx, x: Math.round(f.x * 10) / 10 });
      return { heading: r.ang, speed: 0 };
    }
    if (r.gap <= m.reach + f.spd * m.hits[0].at * m.len * 0.6) {
      const i = f.charging;
      f.charging = -1;
      startAttack(w, f, i, emit);
      return { heading: f.heading, speed: f.spd };
    }
    if (Math.abs(r.rel) > 1.2) f.charging = -1;
    else return { heading: r.ang, speed: d.run };
  }

  // A stalker crouches when its pounce is ready and the prey is in range, and leaps once coiled.
  if (d.ai === 'stalker') {
    const pi = d.moves.findIndex((m) => m.grab?.kind === 'latch');
    const pm = d.moves[pi];
    if (pi >= 0 && f.ready[pi] <= w.simT && grabbable && r.gap >= pm.minRange! && r.gap <= pm.reach + pm.lunge! + 2) {
      f.crouchWant = 1;
      if (f.crouch >= 0.6 && r.gap <= pm.reach + pm.lunge! && Math.abs(r.rel) < 0.35 && f.commitAt <= w.simT) {
        startAttack(w, f, pi, emit);
        return { heading: f.heading, speed: 0 };
      }
      return { heading: r.ang, speed: r.gap > pm.reach + pm.lunge! ? d.walk * 0.6 : 0.2 };
    }
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
    // Roars: when crowded, or to open a fight from a distance.
    if (m.roar) {
      if (crowd >= 2 || (w.fightT < 4 && r.gap > 2.5)) options.push({ i, w: (m.weight ?? 1) * 40 });
      return;
    }
    if (m.charge) {
      if (Math.abs(r.rel) < 0.5 && r.gap < ARENA_R) options.push({ i, w: (m.weight ?? 1) * m.damage });
      return;
    }
    const back = m.hits.every((h) => h.back);
    const off = back ? Math.abs(wrap(r.rel + Math.PI)) : Math.abs(r.rel);
    const reach = m.reach + (m.lunge ?? 0) * (m.minRange !== undefined ? 1 : 0.5);
    if (r.gap <= reach && off <= m.arc * 0.75) options.push({ i, w: (m.weight ?? 1) * m.damage * (m.breath ? 6 : m.hits.length) });
  });
  for (const o of options) total += o.w;
  if (options.length) {
    let pick = w.rng.next() * total;
    const chosen = options.find((o) => (pick -= o.w) < 0) ?? options[options.length - 1];
    if (d.moves[chosen.i].charge) {
      f.charging = chosen.i;
      f.bluffing = w.rng.chance(d.moves[chosen.i].bluff ?? 0);
      f.ready[chosen.i] = w.simT + d.moves[chosen.i].cooldown * COOLDOWN_MUL;
      emit({ type: 'charge', who: f.idx, ...voiceOf(d), x: Math.round(f.x * 10) / 10 });
      return { heading: r.ang, speed: d.run };
    }
    startAttack(w, f, chosen.i, emit);
    return { heading: f.heading, speed: 0 };
  }

  // An ambusher lies still facing its prey, creeping only when it has waited a while.
  if (d.ai === 'ambusher') {
    // (The same reach the move options above allow.)
    const strike = Math.max(...d.moves.filter((m) => !m.hits.every((h) => h.back)).map((m) => m.reach + (m.lunge ?? 0) * (m.minRange !== undefined ? 1 : 0.5)));
    if (w.simT - f.lastActT < 3.5) return { heading: r.ang, speed: r.gap > strike + 2.5 ? d.walk * 0.5 : 0 };
    // Out of patience: go to it.
    return { heading: r.ang, speed: r.gap > strike ? d.walk : 0 };
  }

  const soon = (m: MoveDef, i: number) => f.ready[i] - w.simT < 0.35 && !m.charge && (m.minRange === undefined || r.gap >= m.minRange);
  const frontSoon = d.moves.some((m, i) => soon(m, i) && !m.hits.every((h) => h.back));
  const backSoon = d.moves.some((m, i) => soon(m, i) && m.hits.every((h) => h.back));
  const closest = Math.min(...d.moves.map((m) => m.reach));
  // Kickers turn their back on anyone close once their front moves are spent.
  if (backSoon && !frontSoon && r.gap < 1.6) return { heading: r.ang + Math.PI, speed: d.walk * 0.4 };
  if (frontSoon || backSoon) {
    const speed = r.gap > 3 ? d.run : r.gap > closest * 0.8 ? Math.min(d.run, d.walk * 1.8) : 0;
    return { heading: r.ang, speed };
  }
  // Waiting on cooldowns: circle the target, backing off if right on top of it.
  if (r.gap < closest * 0.6) return { heading: r.ang + f.orbit * 2.3, speed: d.walk };
  return { heading: r.ang + f.orbit * (r.gap > 3 ? 0.6 : 1.35), speed: r.gap > 4 ? d.run * 0.7 : d.walk * 1.1 };
}

/** Chance a blow from `a` misses `b` (b twists away or it glances off). */
export const evasion = (a: CreatureDef, b: CreatureDef) => clamp(0.08 + 0.03 * (b.turn - a.turn) + (b.mass < a.mass * 0.25 ? 0.1 : 0), 0.04, 0.35);

function applyHit(w: World, f: Fighter, o: Fighter, m: MoveDef, emit: Emit) {
  const dmgMul = w.fightT > w.capS ? 1 + (w.fightT - w.capS) * 0.5 : 1;
  const crit = !m.breath && w.rng.chance(CRIT_CHANCE);
  // Flanking: hitting from behind while one of its allies keeps the target's attention.
  const behind = Math.abs(wrap(dm.atan2(f.y - o.y, f.x - o.x) - o.heading)) > 2;
  const flank = w.mode === 'horde' && f.side === 1 && behind && o.target !== f.idx;
  // Bracing in an armoured move (a bear reared up) takes the edge off.
  const braced = o.state === 'attack' && o.move?.armor ? o.move.armor : 0;
  const dmg = m.damage * DAMAGE_MUL * w.rng.range(0.75, 1.25) * (crit ? CRIT : 1) * f.chargeBonus * (flank ? FLANK : 1) * (1 - o.def.armor) * (1 - braced) * dmgMul;
  o.hp -= dmg;
  o.lastHitBy = f.idx;
  o.lastHitT = w.simT;
  o.lastHitDir = dm.atan2(o.y - f.y, o.x - f.x);
  f.dealt += dmg;
  o.flash = Math.min(1, o.flash + (m.breath ? 0.25 : 1));
  if (m.breath) o.burn = 1;
  // Knockback by the mass ratio, away from the attacker.
  const dx = o.x - f.x;
  const dy = o.y - f.y;
  const dl = Math.max(0.01, dm.hypot(dx, dy));
  const k = m.knock * f.chargeBonus * ((2 * f.def.mass) / (f.def.mass + o.def.mass));
  o.kx += (dx / dl) * k;
  o.ky += (dy / dl) * k;
  if (m.poison) {
    o.poisonUntil = w.simT + POISON_S;
    o.poisonDps = m.poison;
    o.poisonBy = f.idx;
  }
  const power = dmg / Math.max(1, o.def.poise);
  if (!m.breath)
    emit({ type: 'hit', a: f.idx, b: o.idx, move: m.name, sound: m.sound, dmg: Math.round(dmg), crit: crit ? 1 : 0, power: Math.round(power * 100) / 100, hp: Math.max(0, Math.round((o.hp / o.maxHp) * 1000) / 1000), mass: f.def.mass, weapon: f.def.weapon ?? '', vcall: o.def.voice?.call ?? '', vcp: o.def.voice?.pitch ?? 0.5, vmass: o.def.mass, x: Math.round(o.x * 10) / 10 });
  else emit({ type: 'burn', a: f.idx, b: o.idx, dmg: Math.round(dmg * 10) / 10, hp: Math.max(0, Math.round((o.hp / o.maxHp) * 1000) / 1000) });
  // Falling is settled once every blow of the step has landed (see stepWorld).
  if (o.hp <= 0) return;
  // Grapples: latch on, clamp and roll, or pin.
  if (m.grab && f.alive && f.state === 'attack' && f.move === m && o.heldBy < 0 && !o.grab && !o.def.hover && w.rng.chance(m.grab.chance ?? 1)) {
    startGrab(w, f, o, m.grab, emit);
    return;
  }
  // A hard enough hit staggers it, cancelling its own attack if that hasn't landed yet.
  const poise = o.def.poise * DAMAGE_MUL;
  const stagger = !m.breath && !braced && (dmg >= poise * STAGGER_AT || (crit && dmg >= poise)) && o.staggerReady <= w.simT && (o.state !== 'attack' || o.hitIdx === 0) && o.state !== 'dodge' && o.state !== 'held';
  if (stagger) {
    if (o.grab) release(w, o, false, emit);
    o.charging = -1;
    o.staggerReady = w.simT + STAGGER_GUARD_S;
    setState(o, 'stagger', w.simT);
    emit({ type: 'stagger', who: o.idx, x: Math.round(o.x * 10) / 10 });
  }
}

function startGrab(w: World, f: Fighter, o: Fighter, g: NonNullable<MoveDef['grab']>, emit: Emit) {
  f.grab = { kind: g.kind, target: o.idx, t0: w.simT, until: w.simT + g.seconds, next: w.simT + GRAB_TICK, dps: g.dps, side: w.rng.chance(0.5) ? 1 : -1 };
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
  emit({ type: 'grab', a: f.idx, b: o.idx, kind: g.kind, ...voiceOf(f.def), vcall: o.def.voice?.call ?? '', vcp: o.def.voice?.pitch ?? 0.5, x: Math.round(o.x * 10) / 10 });
}

/** Let go (or be thrown off). */
function release(w: World, f: Fighter, thrown: boolean, emit: Emit) {
  const g = f.grab;
  if (!g) return;
  const o = w.fighters[g.target];
  f.grab = null;
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
    emit({ type: 'shakeOff', a: f.idx, b: o.idx, kind: g.kind, x: Math.round(f.x * 10) / 10 });
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
    const ang = o.heading + g.side * 2.1;
    const dist = o.def.radius * 0.9 + (f.def.front ?? f.def.radius) * 0.55;
    f.x = o.x + dm.cos(ang) * dist;
    f.y = o.y + dm.sin(ang) * dist;
    f.heading = dm.atan2(o.y - f.y, o.x - f.x);
  } else {
    // Held in the jaws (or under the paws), just in front of the snout.
    const reach = (f.def.front ?? f.def.radius) * 0.85 + extent(o, f.heading + Math.PI) * 0.6;
    o.x = f.x + dm.cos(f.heading) * reach;
    o.y = f.y + dm.sin(f.heading) * reach;
    o.kx = o.ky = o.spd = 0;
  }
  f.spd = f.kx = f.ky = 0;
  const dmgMul = w.fightT > w.capS ? 1 + (w.fightT - w.capS) * 0.5 : 1;
  while (f.grab && w.simT >= g.next) {
    g.next += GRAB_TICK;
    const dmg = g.dps * GRAB_TICK * DAMAGE_MUL * (1 - o.def.armor) * dmgMul;
    o.hp -= dmg;
    o.lastHitBy = f.idx;
    o.lastHitT = w.simT;
    o.lastHitDir = dm.atan2(o.y - f.y, o.x - f.x);
    o.flash = Math.min(1, o.flash + 0.3);
    f.dealt += dmg;
    emit({ type: 'maul', a: f.idx, b: o.idx, kind: g.kind, dmg: Math.round(dmg * 10) / 10, hp: Math.max(0, Math.round((o.hp / o.maxHp) * 1000) / 1000), x: Math.round(o.x * 10) / 10 });
    if (o.hp <= 0) break;
    // The heavier the target, the sooner it throws the grabber off.
    const ratio = o.def.mass / f.def.mass;
    const p = g.kind === 'latch' ? clamp(0.02 + 0.03 * ratio, 0.02, 0.4) : clamp(0.01 + 0.025 * ratio, 0.01, 0.3);
    if (w.rng.chance(p)) release(w, f, true, emit);
  }
}

function kill(w: World, o: Fighter, by: number, emit: Emit) {
  if (o.grab) release(w, o, false, emit);
  if (o.heldBy >= 0) release(w, w.fighters[o.heldBy], false, emit);
  o.alive = false;
  o.diedAt = w.simT;
  o.charging = -1;
  setState(o, 'dead', w.simT);
  w.koWho = o.idx;
  w.koBy = by;
  emit({ type: 'ko', who: o.idx, by, side: o.side, number: o.number, ...voiceOf(o.def), x: Math.round(o.x * 10) / 10 });
}

/** Resolve the current move's hits and breath ticks that are due. */
function resolveAttack(w: World, f: Fighter, emit: Emit) {
  const m = f.move!;
  const el = w.simT - f.stateT;
  while (f.hitIdx < m.hits.length && el >= m.hits[f.hitIdx].at * m.len) {
    const h = m.hits[f.hitIdx++];
    if (m.breath) continue;
    if (m.roar) {
      // Smaller enemies nearby flinch.
      emit({ type: 'roar', who: f.idx, ...voiceOf(f.def), x: Math.round(f.x * 10) / 10 });
      for (const o of enemiesOf(w, f)) {
        if (relation(f, o).gap > m.roar.radius || o.def.mass >= f.def.mass * 0.75 || o.staggerReady > w.simT || o.state === 'held') continue;
        if (o.grab) release(w, o, false, emit);
        o.charging = -1;
        o.staggerReady = w.simT + STAGGER_GUARD_S;
        setState(o, 'stagger', w.simT);
        emit({ type: 'flinch', who: o.idx, x: Math.round(o.x * 10) / 10 });
      }
      continue;
    }
    let landed = 0;
    for (const o of enemiesOf(w, f)) {
      const r = relation(f, o);
      const off = h.back ? Math.abs(wrap(r.rel + Math.PI)) : Math.abs(r.rel);
      if (r.gap > m.reach + 0.25 || off > m.arc) continue;
      if (o.state === 'dodge' && w.simT - o.stateT < o.def.dodge!.len * 0.7) {
        emit({ type: 'miss', a: f.idx, b: o.idx, dodged: 1 });
        continue;
      }
      // Nimble targets slip some blows from slower, bigger attackers.
      if (w.rng.chance(evasion(f.def, o.def))) {
        emit({ type: 'miss', a: f.idx, b: o.idx, dodged: 0 });
        continue;
      }
      w.pending.push({ f, o, m });
      landed++;
      // The big ones cleave through a few at once; small fighters bite one thing.
      if (landed >= (f.def.mass > 300 ? 3 : 1)) break;
    }
    if (!landed) emit({ type: 'miss', a: f.idx, b: f.target, dodged: 0 });
  }
  if (m.breath && el >= f.breathNext && el <= m.breath.until * m.len) {
    f.breathNext += BREATH_TICK;
    for (const o of enemiesOf(w, f)) {
      const r = relation(f, o);
      if (r.gap <= m.reach && Math.abs(r.rel) <= m.arc + dm.atan(o.def.radius / Math.max(0.5, r.dist))) w.pending.push({ f, o, m });
    }
  }
  if (el >= m.len) {
    f.move = null;
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
    emit({ type: 'spawn', who: f.idx, number: sw.sent, total: sw.total, ...voiceOf(sw.def), x: Math.round(f.x * 10) / 10 });
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
      animate(f, dt);
      continue;
    }
    const d = f.def;
    // Poison ticks (it can finish someone off).
    if (f.poisonUntil > w.simT) {
      f.hp -= f.poisonDps * dt * (w.fightT > w.capS ? 1 + (w.fightT - w.capS) * 0.5 : 1);
      if (f.hp <= 0) kill(w, f, f.poisonBy, emit);
    }
    if (!f.alive) continue;
    let heading = f.heading;
    let speed = 0;
    let turn = d.turn;
    switch (f.state) {
      case 'idle':
      case 'move': {
        const plan = think(w, f, emit);
        heading = plan.heading;
        speed = plan.speed;
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
        turn = d.turn * 0.45;
        // Lunge (or leap) forward up to the first hit; a charge carries its run-up speed into it.
        speed = el < firstHit ? (m.lunge ?? 0) / Math.max(0.05, firstHit) + (m.charge ? f.spd * 0.7 : 0) : 0;
        break;
      }
      case 'stagger':
        speed = 0;
        if (w.simT - f.stateT >= PROC_STAGGER_S) setState(f, 'idle', w.simT, w.rng);
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
        if (w.simT - f.stateT >= dd.len * 0.7) setState(f, 'idle', w.simT, w.rng);
        break;
      }
    }
    // Carrying a lion on its back: slowed, turning stiffly.
    if (f.heldBy >= 0) {
      speed *= 0.5;
      turn *= 0.6;
    }
    const dh = clamp(wrap(heading - f.heading), -turn * dt, turn * dt);
    f.heading = wrap(f.heading + dh);
    // Big turns slow you down (no full-speed hairpins).
    const target = speed * (0.35 + 0.65 * Math.max(0, dm.cos(wrap(heading - f.heading))));
    const accel = f.state === 'attack' ? 30 : target > f.spd ? 4 : 7;
    f.spd += (target - f.spd) * (1 - dm.exp(-dt * accel));
    f.x += dm.cos(f.heading) * f.spd * dt;
    f.y += dm.sin(f.heading) * f.spd * dt;
    if (f.state === 'attack') resolveAttack(w, f, emit);
  }
  // Everything that landed this step lands together: two blows trading in the same instant both count.
  for (const { f, o, m } of w.pending) if (o.alive) applyHit(w, f, o, m, emit);
  w.pending.length = 0;
  const falling = w.fighters.filter((f) => f.alive && f.hp <= 0);
  if (falling.length) {
    // A double knockout would leave nobody: the one with the most left in it (least overkill) hangs on.
    const standing = (side: number) => w.fighters.some((f) => f.alive && f.hp > 0 && f.side === side) || (side === 1 && w.swarm !== null && w.swarm.sent < w.swarm.total);
    if (!standing(0) && !standing(1)) falling.reduce((a, b) => (b.hp > a.hp ? b : a)).hp = 1;
    for (const f of falling) if (f.hp <= 0) kill(w, f, f.lastHitBy, emit);
  }
  for (const f of w.fighters) {
    if (f.alive) settle(f, dt);
    if (f.alive) animate(f, dt);
    // Footfalls of anything running (walking is quiet), the heavy ones loudest.
    const fall = Math.floor(f.gait * 2);
    if (fall > f.steps) {
      f.steps = fall;
      if (f.alive && Math.abs(f.spd) > f.def.walk * 1.8 && f.def.mass > 40) emit({ type: 'step', who: f.idx, feet: f.def.feet ?? 'paw', mass: f.def.mass, x: Math.round(f.x * 10) / 10 });
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
    if (!t || !t.alive) continue;
    const lastOfSide = !w.fighters.some((o) => o !== t && o.alive && o.side === t.side) && !(t.side === 1 && w.swarm && w.swarm.sent < w.swarm.total);
    if (!lastOfSide) continue;
    const r = relation(f, t);
    if (r.gap > f.move!.reach + (f.move!.lunge ?? 0) + 0.3) continue;
    if (t.hp <= f.move!.damage * f.chargeBonus * 0.9 * (1 - t.def.armor)) return t;
  }
  return null;
}
