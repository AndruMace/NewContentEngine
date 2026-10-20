/**
 * The fight, in 2D on the arena floor (metres; the view maps sim (x, y) to three.js (x, z)). Fighters
 * are circles that steer, turn, attack, take hits, get knocked back, stagger, dodge and die. Everything
 * here is deterministic (dm.* maths, the run's rng only); the animation state each fighter carries is
 * derived from its sim state, so the view can pose a model from a snapshot alone.
 */
import type { Rng } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { COOLDOWN_MUL, DAMAGE_MUL } from './balance';
import type { CreatureDef, MoveDef } from './roster';

/** Arena floor radius (inside the wall). */
export const ARENA_R = 10;
/** Breath attacks hit everyone in their cone this often. */
export const BREATH_TICK = 0.1;
/** Crossfade between clips (sim seconds). */
const FADE = 0.18;
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
/** Gate angles in the arena wall (at the back, as the camera sees it). */
export const GATES = [-Math.PI / 2, -Math.PI / 2 + 0.9, -Math.PI / 2 - 0.9];

export type Emit = (e: { type: string; [k: string]: unknown }) => void;

export interface AnimState {
  clip: string;
  /** Clip time (seconds). */
  t: number;
  rate: number;
  loop: boolean;
}

export type FighterState = 'idle' | 'move' | 'attack' | 'stagger' | 'dodge' | 'dead';

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
  anim: AnimState;
  prev: AnimState | null;
  /** 0..1 fade-in of `anim` over `prev`. */
  blend: number;
  animKey: string;
  /** Visual: white flash on being hit (decays), and a burn glow from breath. */
  flash: number;
  burn: number;
  diedAt: number;
  dealt: number;
  /** Horde: the order it entered (1-based). */
  number: number;
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
    anim: { clip: def.clips.idle, t: rng.range(0, def.clips.lens[def.clips.idle] ?? 1), rate: 1, loop: true },
    prev: null,
    blend: 1,
    animKey: 'idle',
    flash: 0,
    burn: 0,
    diedAt: -1,
    dealt: 0,
    number: 0,
  };
}

export function makeWorld(opts: { mode: 'duel' | 'horde'; a: CreatureDef; b: CreatureDef; hpScale: number; capS: number; maxSwarm: number; rng: Rng }): World {
  const { mode, a, b, hpScale, rng } = opts;
  const fighters: Fighter[] = [];
  if (mode === 'duel') {
    const d = 2.4 + (a.radius + b.radius) * 0.5;
    fighters.push(makeFighter(0, 0, a, -d, 0, 0, hpScale, rng, 0));
    fighters.push(makeFighter(1, 1, b, d, 0, Math.PI, hpScale, rng, 0));
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
function animate(f: Fighter, dt: number, simT: number) {
  const d = f.def;
  const el = simT - f.stateT;
  let clip: string;
  let rate = 1;
  let loop = true;
  let key: string = f.state;
  let t: number | null = null;
  switch (f.state) {
    case 'attack':
      clip = f.move!.clip;
      loop = false;
      t = el;
      key = `attack@${f.stateT}`;
      break;
    case 'stagger':
      clip = d.clips.hit.length ? d.clips.hit[Math.floor(f.stateT * 7.3) % d.clips.hit.length] : d.clips.idle;
      loop = !d.clips.hit.length;
      t = d.clips.hit.length ? el : null;
      key = `stagger@${f.stateT}`;
      break;
    case 'dodge':
      clip = f.dodgeDir > 0 ? d.dodge!.left : d.dodge!.right;
      rate = 1.3;
      key = `dodge@${f.stateT}`;
      break;
    case 'dead':
      clip = d.clips.death;
      loop = false;
      t = Math.min(el, d.clips.lens[d.clips.death] - 0.001);
      break;
    default: {
      const s = Math.abs(f.spd);
      if (s < 0.25) clip = d.clips.idle;
      else if (s <= d.walk * 1.4 || d.clips.run === d.clips.walk) {
        clip = d.clips.walk;
        rate = d.walkStride ? clamp(s / d.walkStride, 0.5, 2) : 1 + s / Math.max(1, d.run);
      } else {
        clip = d.clips.run;
        rate = d.runStride ? clamp(s / d.runStride, 0.6, 1.6) : 1.4;
      }
      // Locomotion clips swap without restarting the cycle's crossfade every step.
      key = clip;
    }
  }
  if (key !== f.animKey) {
    f.prev = { ...f.anim };
    f.blend = 0;
    f.animKey = key;
    f.anim = { clip, t: t ?? 0, rate, loop };
  } else {
    f.anim.clip = clip;
    f.anim.rate = rate;
    f.anim.loop = loop;
    f.anim.t = t ?? f.anim.t + dt * rate;
  }
  if (f.prev) {
    f.prev.t += dt * f.prev.rate;
    f.blend = Math.min(1, f.blend + dt / FADE);
    if (f.blend >= 1) f.prev = null;
  }
}

/** Animate only (before the fight starts and after it ends): idle, death clips, knockback settling. */
export function idleWorld(w: World, dt: number) {
  w.simT += dt;
  for (const f of w.fighters) {
    if (f.alive && f.state !== 'dead') {
      f.spd *= dm.exp(-dt * 6);
      if (f.state !== 'idle' && f.state !== 'move') setState(f, 'idle', w.simT);
    }
    settle(f, dt);
    animate(f, dt, w.simT);
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

/** Where `o` sits from `f`: edge gap and angle off f's facing. */
function relation(f: Fighter, o: Fighter) {
  const dx = o.x - f.x;
  const dy = o.y - f.y;
  const dist = dm.hypot(dx, dy);
  return { dx, dy, dist, gap: dist - f.def.radius - o.def.radius, rel: wrap(dm.atan2(dy, dx) - f.heading), ang: dm.atan2(dy, dx) };
}

function startAttack(w: World, f: Fighter, i: number, emit: Emit) {
  const m = f.def.moves[i];
  f.move = m;
  f.moveIdx = i;
  f.hitIdx = 0;
  f.breathNext = m.hits[0].at * m.len;
  f.chargeBonus = m.charge ? 1 + 0.6 * clamp(f.spd / f.def.run, 0, 1) : 1;
  f.ready[i] = w.simT + m.cooldown * COOLDOWN_MUL;
  setState(f, 'attack', w.simT);
  emit({ type: 'swing', who: f.idx, move: m.name, sound: m.sound, mass: f.def.mass, breath: m.breath ? 1 : 0, x: Math.round(f.x * 10) / 10 });
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
  if (f.target < 0) return { heading: f.heading, speed: 0 };
  const t = w.fighters[f.target];
  const r = relation(f, t);

  // Horde members not yet engaged wait their turn, circling at a distance.
  if (w.mode === 'horde' && f.side === 1 && !f.engaged) {
    f.charging = -1;
    const ringR = t.def.radius + 3.2 + (f.idx % 3) * 0.6;
    const a = dm.atan2(f.y - t.y, f.x - t.x) + f.orbit * 0.35;
    const gx = t.x + dm.cos(a) * ringR - f.x;
    const gy = t.y + dm.sin(a) * ringR - f.y;
    return { heading: dm.atan2(gy, gx), speed: clamp(dm.hypot(gx, gy) * 1.2, 0, d.walk * 1.6) };
  }

  // A charge in progress: straight at the target until close enough to land it.
  if (f.charging >= 0) {
    const m = d.moves[f.charging];
    if (r.gap <= m.reach + f.spd * m.hits[0].at * m.len * 0.6) {
      const i = f.charging;
      f.charging = -1;
      startAttack(w, f, i, emit);
      return { heading: f.heading, speed: f.spd };
    }
    if (Math.abs(r.rel) > 1.2) f.charging = -1;
    else return { heading: r.ang, speed: d.run };
  }

  // Moves it could start right now, weighted by preference and damage.
  let total = 0;
  const options: { i: number; w: number }[] = [];
  d.moves.forEach((m, i) => {
    if (f.ready[i] > w.simT || f.commitAt > w.simT) return;
    if (m.minRange !== undefined && r.gap < m.minRange) return;
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
      f.ready[chosen.i] = w.simT + d.moves[chosen.i].cooldown * COOLDOWN_MUL;
      emit({ type: 'charge', who: f.idx, x: Math.round(f.x * 10) / 10 });
      return { heading: r.ang, speed: d.run };
    }
    startAttack(w, f, chosen.i, emit);
    return { heading: f.heading, speed: 0 };
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
  const dmg = m.damage * DAMAGE_MUL * w.rng.range(0.75, 1.25) * (crit ? CRIT : 1) * f.chargeBonus * (flank ? FLANK : 1) * (1 - o.def.armor) * dmgMul;
  o.hp -= dmg;
  o.lastHitBy = f.idx;
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
    emit({ type: 'hit', a: f.idx, b: o.idx, move: m.name, sound: m.sound, dmg: Math.round(dmg), crit: crit ? 1 : 0, power: Math.round(power * 100) / 100, hp: Math.max(0, Math.round((o.hp / o.maxHp) * 1000) / 1000), mass: f.def.mass, x: Math.round(o.x * 10) / 10 });
  else emit({ type: 'burn', a: f.idx, b: o.idx, dmg: Math.round(dmg * 10) / 10, hp: Math.max(0, Math.round((o.hp / o.maxHp) * 1000) / 1000) });
  // Falling is settled once every blow of the step has landed (see stepWorld).
  if (o.hp <= 0) return;
  // A hard enough hit staggers it, cancelling its own attack if that hasn't landed yet.
  const poise = o.def.poise * DAMAGE_MUL;
  const stagger = !m.breath && (dmg >= poise * STAGGER_AT || (crit && dmg >= poise)) && o.staggerReady <= w.simT && (o.state !== 'attack' || o.hitIdx === 0) && o.state !== 'dodge';
  if (stagger) {
    o.charging = -1;
    o.staggerReady = w.simT + STAGGER_GUARD_S;
    setState(o, 'stagger', w.simT);
    emit({ type: 'stagger', who: o.idx, x: Math.round(o.x * 10) / 10 });
  }
}

function kill(w: World, o: Fighter, by: number, emit: Emit) {
  o.alive = false;
  o.diedAt = w.simT;
  o.charging = -1;
  setState(o, 'dead', w.simT);
  w.koWho = o.idx;
  w.koBy = by;
  emit({ type: 'ko', who: o.idx, by, side: o.side, number: o.number, x: Math.round(o.x * 10) / 10 });
}

/** Resolve the current move's hits and breath ticks that are due. */
function resolveAttack(w: World, f: Fighter, emit: Emit) {
  const m = f.move!;
  const el = w.simT - f.stateT;
  while (f.hitIdx < m.hits.length && el >= m.hits[f.hitIdx].at * m.len) {
    const h = m.hits[f.hitIdx++];
    if (m.breath) continue;
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
    emit({ type: 'spawn', who: f.idx, number: sw.sent, total: sw.total, x: Math.round(f.x * 10) / 10 });
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
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const min = a.def.radius + b.def.radius;
      if (Math.abs(dx) > min || Math.abs(dy) > min) continue;
      const d = dm.hypot(dx, dy);
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
    const lim = ARENA_R - a.def.radius;
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
  w.simT += dt;
  w.fightT += dt;
  if (w.swarm) runSwarm(w, emit);
  for (const f of w.fighters) {
    if (!f.alive) {
      settle(f, dt);
      animate(f, dt, w.simT);
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
        if (w.simT - f.stateT >= (d.clips.hit.length ? d.clips.lens[d.clips.hit[0]] * 0.85 : 0.4)) setState(f, 'idle', w.simT, w.rng);
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
    if (f.alive) animate(f, dt, w.simT);
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
