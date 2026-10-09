import { z } from 'zod';
import { FONT_FAMILY, lighten, hexToRgb, rgbToCss, paletteAt, type Ctx2D, type DramaScore, type Rng, type SimEvent, type Template, type Theme } from '@sim/engine';
import { hypot, World, collideInsideCircle, type Body } from '@sim/physics';
import { clamp01, gaussFit } from '../scoring';
import {
  COLOR_TEAMS,
  COUNTRY_TEAMS,
  burst,
  drawShards,
  drawSparks,
  drawTeamBall,
  pickTeams,
  shatter,
  updateShards,
  updateSparks,
  type Shard,
  type Spark,
  type Team,
} from '../fx';
import * as dm from '@sim/physics/math';
import {
  WEAPONS,
  WEAPON_IDS,
  drawArrowShape,
  drawWeapon,
  localParts,
  localTips,
  makeWeapon,
  maxDamage,
  resetWeapon,
  rollDamage,
  toWorld,
  upgrade,
  weaponStat,
  type Part,
  type Weapon,
  type WeaponId,
} from './weapons';

export const ballBattleSchema = z.object({
  format: z.enum(['ffa', 'teams', 'giant', 'bracket']).default('ffa').meta({ title: 'Format' }),
  fighters: z.number().int().min(2).max(6).default(4).meta({ title: 'Fighters (not used by bracket)' }),
  weapons: z.enum(['mixed', 'sword', 'dagger', 'hammer', 'bow']).default('mixed').meta({ title: 'Weapons' }),
  teams: z.enum(['colors', 'countries']).default('colors').meta({ title: 'Teams' }),
  arenaRadius: z.number().min(320).max(480).default(400).meta({ title: 'Arena radius' }),
  ballRadius: z.number().min(36).max(80).default(58).meta({ title: 'Ball radius' }),
  speed: z.number().min(300).max(1200).default(700).meta({ title: 'Ball speed', step: 10 }),
  hp: z.number().int().min(40).max(300).default(100).meta({ title: 'Starting HP' }),
  damageScale: z.number().min(0.5).max(2).default(1).meta({ title: 'Damage multiplier', step: 0.05 }),
  growthScale: z.number().min(0).max(2).default(1).meta({ title: 'Weapon growth per hit', step: 0.05 }),
  spinScale: z.number().min(0.5).max(1.8).default(1).meta({ title: 'Weapon spin multiplier', step: 0.05 }),
  shrinkAfter: z.number().min(4).max(40).default(9).meta({ title: 'Arena starts shrinking after (s)', step: 0.5 }),
  shrinkSpeed: z.number().min(0).max(60).default(16).meta({ title: 'Arena shrink speed (px/s)' }),
  hitFreeze: z.number().min(0).max(0.15).default(0.06).meta({ title: 'Hit freeze (s)', step: 0.01 }),
  slowMotion: z.boolean().default(true).meta({ title: 'Slow-motion final blow' }),
  gravity: z.number().min(0).max(1500).default(0).meta({ title: 'Gravity', step: 50 }),
});

export type BallBattleParams = z.infer<typeof ballBattleSchema>;

interface Fighter {
  idx: number;
  body: Body;
  team: Team;
  /** Fighters on the same side don't hurt each other. */
  side: number;
  weapon: Weapon;
  hp: number;
  maxHp: number;
  angle: number;
  /** Still in the battle (not knocked out). */
  alive: boolean;
  /** In the arena right now (bracket: only the current match). */
  active: boolean;
  giant: boolean;
  speed: number;
  /** Extra speed after a heavy hit, decaying. */
  knock: number;
  koAt: number;
  flash: number;
  /** Bow: id of the last volley that levelled the bow up (one upgrade per volley). */
  lastVolleyUp: number;
  /** Weapon tip histories for swoosh trails (visual only). */
  tips: { x: number; y: number }[][];
}

interface Arrow {
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: number;
  side: number;
  volley: number;
  sc: number;
}

interface Stuck {
  x: number;
  y: number;
  angle: number;
  life: number;
  sc: number;
  color: string;
}

interface Wave {
  x: number;
  y: number;
  r: number;
  grow: number;
  life: number;
  maxLife: number;
  color: string;
}

type Phase = 'intro' | 'fight' | 'after' | 'over';

interface State {
  p: BallBattleParams;
  world: World;
  rng: Rng;
  fxRng: Rng;
  visual: boolean;
  cx: number;
  cy: number;
  /** Arena radius now, at the start of each fight, and the smallest it shrinks to. */
  R: number;
  R0: number;
  minR: number;
  fighters: Fighter[];
  sideCount: number;
  arrows: Arrow[];
  volleys: number;
  stuck: Stuck[];
  sparks: Spark[];
  shards: Shard[];
  waves: Wave[];
  /** Hit cooldowns per attacker→target, and clash cooldowns per pair (sim time). */
  cooldown: Map<string, number>;
  clashCd: Map<string, number>;
  /** Video time (what the viewer sees). */
  t: number;
  /** Sim time (pauses during hit freeze, slows in slow motion). */
  simT: number;
  fightT: number;
  phase: Phase;
  phaseUntil: number;
  freezeUntil: number;
  /** Time scale now and where it's heading; slow-motion hold after a final blow. */
  slow: number;
  slowTarget: number;
  slowHoldUntil: number;
  inThreat: boolean;
  threatStart: number;
  threatLastT: number;
  threatCooldownUntil: number;
  threatsThisFight: number;
  focusX: number;
  focusY: number;
  cam: { x: number; y: number; z: number };
  shrinking: boolean;
  shrinkAt: number;
  leaderSide: number;
  koPulseAt: number;
  winner: number;
  winnerSide: number;
  endAt: number | null;
  shake: number;
  /** Bracket only. */
  bracket: { match: number; pairs: [number, number][]; winners: number[] } | null;
}

const OUTRO_S = 2.6;
const COOLDOWN_S = 0.3;
const ARROW_SPEED = 1250;
const SLOW = 0.22;
const THREAT_GAP = 85;
/** Near-miss slow-motion moments per fight (each up to 1.2 s). More than this drags. */
const MAX_THREATS = 2;
const PANEL_TOP = 1920 * 0.155;
/** Bracket semi-finals are quick (harder hits); the final is a full-length fight. */
const SEMI_DAMAGE = 2.4;
const FINAL_DAMAGE = 1.4;
const INTRO_S = 1.1;
/** Two semi-finals and a final. */
const BRACKET_MATCHES = 3;

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const u = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  return { d: hypot(px - (ax + dx * u), py - (ay + dy * u)), x: ax + dx * u, y: ay + dy * u };
}

function segSegDist(a: Part, b: Part) {
  return Math.min(
    pointSegDist(a.ax, a.ay, b.ax, b.ay, b.bx, b.by).d,
    pointSegDist(a.bx, a.by, b.ax, b.ay, b.bx, b.by).d,
    pointSegDist(b.ax, b.ay, a.ax, a.ay, a.bx, a.by).d,
    pointSegDist(b.bx, b.by, a.ax, a.ay, a.bx, a.by).d,
  );
}

/** Weapon parts in world space. */
function worldParts(f: Fighter): Part[] {
  const c = dm.cos(f.angle);
  const s = dm.sin(f.angle);
  return localParts(f.weapon, f.body.r).map((p) => {
    const a = toWorld(p.ax, p.ay, f.body.x, f.body.y, c, s);
    const b = toWorld(p.bx, p.by, f.body.x, f.body.y, c, s);
    return { ax: a.x, ay: a.y, bx: b.x, by: b.y, r: p.r, damage: p.damage };
  });
}

const wrapAngle = (a: number) => {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
};

function shuffled<T>(xs: T[], rng: Rng): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const fighting = (s: State) => s.phase === 'fight' && s.winner < 0;
const inArena = (s: State) => s.fighters.filter((f) => f.active && f.alive);

/** Health share of each side (0..1), counting knocked-out members as 0. */
function sideFractions(s: State): number[] {
  const hp = new Array<number>(s.sideCount).fill(0);
  const max = new Array<number>(s.sideCount).fill(0);
  for (const f of s.fighters) {
    if (s.bracket && !f.active) continue;
    max[f.side] += f.maxHp;
    if (f.alive) hp[f.side] += f.hp;
  }
  return hp.map((h, i) => (max[i] ? h / max[i] : 0));
}

function fighterLabel(f: Fighter, withWeapon = true) {
  return `${f.team.icon ? f.team.icon + ' ' : ''}${f.team.label}${withWeapon ? ` ${WEAPONS[f.weapon.id].emoji}` : ''}`;
}

function winnerLabel(s: State): string {
  if (s.winnerSide < 0) return '';
  if (s.p.format === 'teams') {
    const f = s.fighters.find((x) => x.side === s.winnerSide)!;
    return fighterLabel(f, false);
  }
  if (s.p.format === 'giant') return s.winnerSide === 0 ? `${fighterLabel(s.fighters[0], false)} giant` : 'The swarm';
  return s.winner >= 0 ? fighterLabel(s.fighters[s.winner]) : '';
}

function stillInText(s: State): string {
  if (s.p.format === 'teams' || s.p.format === 'giant') {
    const n = [0, 1].map((side) => s.fighters.filter((f) => f.side === side && f.alive).length);
    return `${n[0]} v ${n[1]}`;
  }
  return String(s.fighters.filter((f) => f.alive).length);
}

// ---- fight lifecycle ----------------------------------------------------------------------------

function placeFighters(s: State, list: Fighter[]) {
  const { p, rng } = s;
  const n = list.length;
  list.forEach((f, k) => {
    let a: number;
    let dist: number;
    if (p.format === 'giant') {
      a = f.giant ? 0 : ((k - 1) / Math.max(1, n - 1)) * Math.PI * 2 + rng.range(-0.25, 0.25);
      dist = f.giant ? 0 : s.R0 - f.body.r - 20;
    } else if (p.format === 'teams') {
      const mates = list.filter((x) => x.side === f.side);
      const m = mates.indexOf(f);
      a = (f.side === 0 ? Math.PI : 0) + (m - (mates.length - 1) / 2) * 0.75 + rng.range(-0.15, 0.15);
      dist = (s.R0 - f.body.r) * 0.62;
    } else if (p.format === 'bracket') {
      a = k === 0 ? Math.PI : 0;
      dist = (s.R0 - f.body.r) * 0.42;
    } else {
      a = (k / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
      dist = (s.R0 - f.body.r) * 0.58;
    }
    const dir = rng.range(0, Math.PI * 2);
    f.body.x = s.cx + dm.cos(a) * dist;
    f.body.y = s.cy + dm.sin(a) * dist;
    f.body.vx = dm.cos(dir) * f.speed;
    f.body.vy = dm.sin(dir) * f.speed;
    f.body.alive = true;
    f.active = true;
    f.knock = 0;
    f.angle = rng.range(0, Math.PI * 2);
    f.tips = [];
  });
}

function startFight(s: State, t: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  s.phase = 'fight';
  s.fightT = 0;
  s.R = s.R0;
  s.shrinking = false;
  s.leaderSide = -1;
  s.threatsThisFight = 0;
  s.cooldown.clear();
  s.clashCd.clear();
  emit({ type: 'fightStart', weapons: inArena(s).map((f) => f.weapon.id), match: s.bracket?.match ?? 0 });
  void t;
}

function startMatch(s: State, t: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  const b = s.bracket!;
  const [i, j] = b.pairs[b.match];
  for (const f of s.fighters) {
    f.active = false;
    f.body.alive = false;
  }
  const pair = [s.fighters[i], s.fighters[j]];
  // Every match is a fresh fight: full health and level-1 weapons.
  for (const f of pair) {
    f.hp = f.maxHp;
    resetWeapon(f.weapon);
    // Quicker fights mean fewer level-ups, which would favour weapons that are strong from the
    // first swing (sword, hammer) over ones that scale (daggers, bow): grow faster to match.
    const k = b.match === BRACKET_MATCHES - 1 ? FINAL_DAMAGE : SEMI_DAMAGE;
    f.weapon.dmgScale = s.p.damageScale * k;
    f.weapon.growth = s.p.growthScale * k;
  }
  placeFighters(s, pair);
  s.arrows = [];
  s.R = s.R0;
  s.phase = 'intro';
  s.phaseUntil = t + INTRO_S;
  s.leaderSide = -1;
  emit({ type: 'matchStart', match: b.match, a: i, b: j });
}

function knockOut(s: State, def: Fighter, att: Fighter, t: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  const { p } = s;
  def.alive = false;
  def.active = false;
  def.body.alive = false;
  def.koAt = t;
  s.koPulseAt = t;
  s.freezeUntil = Math.max(s.freezeUntil, t + p.hitFreeze * 2.5);
  emit({ type: 'ko', who: def.idx, by: att.idx, x: def.body.x });
  if (s.visual) {
    shatter(s.shards, s.fxRng, def.body.x, def.body.y, def.body.r, def.team, def.giant ? 18 : 12, def.giant ? 700 : 560);
    burst(s.sparks, s.fxRng, def.body.x, def.body.y, 60, 1100, def.team.color, 9);
    s.waves.push({ x: def.body.x, y: def.body.y, r: def.body.r, grow: 900, life: 0.55, maxLife: 0.55, color: '#ffffff' });
    s.shake = 30;
  }

  // Is the fight (or match) over?
  const sidesLeft = [...new Set(inArena(s).map((f) => f.side))];
  if (sidesLeft.length > 1) return;
  const finalFight = !s.bracket || s.bracket.match === BRACKET_MATCHES - 1;
  if (p.slowMotion) {
    s.slowTarget = SLOW;
    s.slowHoldUntil = t + (finalFight ? 1.1 : 0.7);
    s.focusX = def.body.x;
    s.focusY = def.body.y;
  }
  s.inThreat = false;
  const winSide = sidesLeft[0] ?? att.side;
  const fr = sideFractions(s);
  if (s.bracket) {
    const b = s.bracket;
    const w = inArena(s)[0] ?? att;
    b.winners.push(w.idx);
    emit({ type: 'matchEnd', match: b.match, winner: w.idx, side: w.side, hp: w.hp, hpFrac: w.hp / w.maxHp });
    if (!finalFight) {
      s.phase = 'after';
      s.phaseUntil = t + 1.2;
      return;
    }
  }
  s.phase = 'over';
  s.winnerSide = winSide;
  const survivors = s.fighters.filter((f) => f.alive && f.side === winSide);
  s.winner = survivors[0]?.idx ?? att.idx;
  s.endAt = t + (p.slowMotion ? 0.55 : 0.1);
  emit({ type: 'win', who: s.winner, side: winSide, hp: s.fighters[s.winner].hp, hpFrac: fr[winSide] ?? 0 });
}

function applyHit(s: State, att: Fighter, def: Fighter, x: number, y: number, nx: number, ny: number, t: number, emit: (e: Omit<SimEvent, 't'>) => void, volley = -1) {
  const { p } = s;
  const dmg = rollDamage(att.weapon, s.rng);
  def.hp = Math.max(0, def.hp - dmg);
  def.flash = 1;
  const def0 = WEAPONS[att.weapon.id];
  def.body.vx = nx * def.speed;
  def.body.vy = ny * def.speed;
  def.knock = Math.max(def.knock, def0.knock * (att.giant ? 1.4 : 1));
  // Bows level up once per volley, so a big volley can't snowball on its own.
  if (att.weapon.id !== 'bow' || volley !== att.lastVolleyUp) {
    upgrade(att.weapon);
    att.lastVolleyUp = volley;
  }
  s.freezeUntil = Math.max(s.freezeUntil, t + p.hitFreeze * def0.freeze);
  const fr = sideFractions(s);
  emit({
    type: 'hit',
    attacker: att.idx,
    target: def.idx,
    weapon: att.weapon.id,
    dmg,
    hp: def.hp,
    x,
    y,
    fr: fr.map((v) => Math.round(v * 1000) / 1000),
  });
  if (s.visual) {
    burst(s.sparks, s.fxRng, x, y, att.weapon.id === 'hammer' ? 28 : 16, att.weapon.id === 'hammer' ? 900 : 650, def.team.color, 7);
    burst(s.sparks, s.fxRng, x, y, 6, 500, '#ffffff', 5);
    s.shake = Math.min(28, s.shake + 6 * def0.freeze);
    if (att.weapon.id === 'hammer') s.waves.push({ x, y, r: 10, grow: 520, life: 0.35, maxLife: 0.35, color: '#ffffff' });
  }
  // Lead changes between sides.
  const lead = fr.map((v, i) => i).sort((a, b) => fr[b] - fr[a] || a - b);
  if (lead.length > 1 && lead[0] !== s.leaderSide && fr[lead[0]] > fr[lead[1]]) {
    if (s.leaderSide >= 0) emit({ type: 'leadChange', to: lead[0] });
    s.leaderSide = lead[0];
  }
  if (def.hp <= 0) knockOut(s, def, att, t, emit);
}

/** A lethal blow is close: the target is the last of its side and one hit from death. */
function threatNear(s: State, parts: Map<number, Part[]>): { x: number; y: number } | null {
  const live = inArena(s);
  for (const def of live) {
    if (live.some((f) => f !== def && f.side === def.side)) continue;
    for (const att of live) {
      if (att.side === def.side || def.hp > maxDamage(att.weapon)) continue;
      for (const part of parts.get(att.idx) ?? []) {
        if (!part.damage) continue;
        const d = pointSegDist(def.body.x, def.body.y, part.ax, part.ay, part.bx, part.by).d - def.body.r - part.r;
        if (d < THREAT_GAP) return { x: (def.body.x + att.body.x) / 2, y: (def.body.y + att.body.y) / 2 };
      }
      for (const a of s.arrows) {
        if (a.owner !== att.idx) continue;
        const v = hypot(a.vx, a.vy) || 1;
        const rx = def.body.x - a.x;
        const ry = def.body.y - a.y;
        const along = (rx * a.vx + ry * a.vy) / v;
        const perp = Math.abs(rx * a.vy - ry * a.vx) / v;
        if (along > 0 && along < 300 && perp < def.body.r + 14) return { x: (def.body.x + a.x) / 2, y: (def.body.y + a.y) / 2 };
      }
    }
  }
  return null;
}

function simulate(s: State, sdt: number, t: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  const { p } = s;
  s.simT += sdt;
  if (s.phase === 'fight') s.fightT += sdt;
  s.world.step(sdt, (c) => {
    if (c.kind === 'body' && c.impulse > 50) emit({ type: 'bump', x: c.x });
  });

  // Shrinking arena.
  if (s.phase === 'fight' && p.shrinkSpeed > 0 && s.fightT > (s.bracket ? p.shrinkAfter * 0.8 : p.shrinkAfter) && s.R > s.minR) {
    if (!s.shrinking) {
      s.shrinking = true;
      s.shrinkAt = t;
      emit({ type: 'shrink' });
    }
    s.R = Math.max(s.minR, s.R - p.shrinkSpeed * sdt);
  }

  const live = inArena(s);
  for (const f of live) {
    const impact = collideInsideCircle(f.body, s.cx, s.cy, s.R, 1);
    if (impact > 30) {
      emit({ type: 'wall', speed: impact, x: f.body.x });
      if (s.visual) burst(s.sparks, s.fxRng, f.body.x, f.body.y, 4, 200, f.team.color, 4);
    }
    // Keep the fight energetic: hold speed (plus any knockback boost).
    const sp = hypot(f.body.vx, f.body.vy) || 1;
    const base = f.speed * (1 + f.knock);
    const want = p.gravity > 0 ? Math.max(sp, base * 0.6) : base;
    f.body.vx *= want / sp;
    f.body.vy *= want / sp;
    f.knock *= dm.exp(-2.5 * sdt);
    f.angle += f.weapon.spin * sdt;
  }

  // Bows: loose a volley when an enemy is in front and the string is drawn.
  if (fighting(s)) {
    for (const f of live) {
      const w = f.weapon;
      if (w.id !== 'bow') continue;
      w.cooldown = Math.max(0, w.cooldown - sdt);
      if (w.cooldown > 0) continue;
      const aimed = live.some((e) => e.side !== f.side && Math.abs(wrapAngle(dm.atan2(e.body.y - f.body.y, e.body.x - f.body.x) - f.angle)) < 0.3);
      if (!aimed) continue;
      const n = w.volley;
      s.volleys++;
      for (let k = 0; k < n; k++) {
        const a = f.angle + (k - (n - 1) / 2) * 0.09;
        const c = dm.cos(a);
        const sn = dm.sin(a);
        const r0 = f.body.r + 40 * w.scale;
        s.arrows.push({ x: f.body.x + c * r0, y: f.body.y + sn * r0, vx: c * ARROW_SPEED, vy: sn * ARROW_SPEED, owner: f.idx, side: f.side, volley: s.volleys, sc: w.scale });
      }
      w.cooldown = w.reload;
      emit({ type: 'shoot', who: f.idx, n, x: f.body.x });
    }
  }

  const parts = new Map<number, Part[]>();
  for (const f of live) parts.set(f.idx, worldParts(f));

  // Arrows: hit enemy balls, get parried by enemy weapons, stick in the wall.
  if (s.arrows.length) {
    const keep: Arrow[] = [];
    for (const a of s.arrows) {
      const x0 = a.x;
      const y0 = a.y;
      a.x += a.vx * sdt;
      a.y += a.vy * sdt;
      let gone = false;
      const owner = s.fighters[a.owner];
      for (const def of live) {
        if (def.side === a.side || !fighting(s)) continue;
        const hit = pointSegDist(def.body.x, def.body.y, x0, y0, a.x, a.y);
        if (hit.d < def.body.r) {
          const v = hypot(a.vx, a.vy) || 1;
          applyHit(s, owner, def, hit.x, hit.y, a.vx / v, a.vy / v, t, emit, a.volley);
          gone = true;
          break;
        }
        const seg: Part = { ax: x0, ay: y0, bx: a.x, by: a.y, r: 0, damage: false };
        if ((parts.get(def.idx) ?? []).some((q) => segSegDist(seg, q) < q.r + 2)) {
          emit({ type: 'parry', x: a.x });
          if (s.visual) burst(s.sparks, s.fxRng, a.x, a.y, 8, 400, '#ffffff', 4);
          gone = true;
          break;
        }
      }
      if (!gone && hypot(a.x - s.cx, a.y - s.cy) > s.R) {
        gone = true;
        if (s.visual) s.stuck.push({ x: a.x, y: a.y, angle: dm.atan2(a.vy, a.vx), life: 1.6, sc: a.sc, color: owner.team.color });
      }
      if (!gone) keep.push(a);
    }
    s.arrows = keep;
  }

  // Melee: blade against blade clashes, blade against ball hits.
  if (fighting(s)) {
    for (const att of live) {
      for (const def of live) {
        if (att === def || att.side === def.side || !att.alive || !def.alive || !fighting(s)) continue;
        const key = pairKey(att.idx, def.idx);
        const pa = parts.get(att.idx)!;
        const pd = parts.get(def.idx)!;
        // Clashes have their own timer, so the weapon that wins a clash can still land its hit.
        if (att.idx < def.idx && (s.clashCd.get(key) ?? -1) <= s.simT) {
          let clash: { x: number; y: number } | null = null;
          for (const a of pa) {
            for (const b of pd) {
              if (segSegDist(a, b) < a.r + b.r) {
                clash = { x: (a.bx + b.bx) / 2, y: (a.by + b.by) / 2 };
                break;
              }
            }
            if (clash) break;
          }
          if (clash) {
            const ca = WEAPONS[att.weapon.id].clash;
            const cd = WEAPONS[def.weapon.id].clash;
            // The stronger weapon powers through a clash; the weaker one is knocked into reverse.
            if (ca <= cd) att.weapon.spin = -att.weapon.spin;
            if (cd <= ca) def.weapon.spin = -def.weapon.spin;
            s.clashCd.set(key, s.simT + COOLDOWN_S);
            emit({ type: 'clash', x: clash.x, y: clash.y });
            if (s.visual) burst(s.sparks, s.fxRng, clash.x, clash.y, 14, 500, '#ffffff', 5);
            if (ca === cd) continue;
          }
        }
        const hitKey = `${att.idx}>${def.idx}`;
        if ((s.cooldown.get(hitKey) ?? -1) > s.simT) continue;
        for (const part of pa) {
          if (!part.damage) continue;
          const hit = pointSegDist(def.body.x, def.body.y, part.ax, part.ay, part.bx, part.by);
          if (hit.d < def.body.r + part.r) {
            s.cooldown.set(hitKey, s.simT + COOLDOWN_S);
            const d = hit.d || 1;
            applyHit(s, att, def, hit.x, hit.y, (def.body.x - hit.x) / d, (def.body.y - hit.y) / d, t, emit);
            break;
          }
        }
      }
    }
  }

  // Slow motion when a deciding blow is about to land (or not!).
  if (p.slowMotion && fighting(s)) {
    const near = s.threatsThisFight < MAX_THREATS || s.inThreat ? threatNear(s, parts) : null;
    if (near) {
      s.threatLastT = t;
      s.focusX = near.x;
      s.focusY = near.y;
      if (!s.inThreat && t >= s.threatCooldownUntil) {
        s.inThreat = true;
        s.threatStart = t;
        s.threatsThisFight++;
        s.slowTarget = 0.3;
        emit({ type: 'threat' });
      }
    }
    if (s.inThreat && (t - s.threatLastT > 0.2 || t - s.threatStart > 1.2)) {
      s.inThreat = false;
      s.slowTarget = 1;
      s.threatCooldownUntil = t + 1.6;
    }
  }
}

// ---- drawing helpers ------------------------------------------------------------------------------

function textOutlined(ctx: Ctx2D, text: string, x: number, y: number, size: number, color = '#ffffff', align: CanvasTextAlign = 'center', alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `900 ${Math.round(size)}px ${FONT_FAMILY}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, size * 0.2);
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** HP number: big, heavy black outline under white, readable on any team colour or flag. */
function drawHp(ctx: Ctx2D, label: string, x: number, y: number, r: number) {
  const size = Math.round(Math.min(r, 70) * (label.length >= 3 ? 0.78 : 0.95) * (r > 80 ? 1.4 : 1));
  textOutlined(ctx, label, x, y + size * 0.04, size);
}

function applyCamera(ctx: Ctx2D, s: State) {
  if (s.shake > 0.3) ctx.translate(dm.sin(s.t * 97) * s.shake, dm.cos(s.t * 71) * s.shake);
  ctx.translate(s.cx, s.cy);
  ctx.scale(s.cam.z, s.cam.z);
  ctx.translate(-s.cam.x, -s.cam.y);
}

const panelAlpha = (s: State) => (s.endAt === null || s.t < s.endAt ? 1 : Math.max(0, 1 - (s.t - s.endAt) / 0.3));

function drawRowsPanel(ctx: Ctx2D, s: State, theme: Theme) {
  const alpha = panelAlpha(s);
  if (alpha <= 0) return;
  const rows = s.p.format === 'teams' ? [...s.fighters].sort((a, b) => a.side - b.side || a.idx - b.idx) : s.fighters;
  const rowH = Math.min(50, 236 / rows.length);
  const x = 350;
  const w = 470;
  rows.forEach((f, k) => {
    const gap = s.p.format === 'teams' && k >= rows.length / 2 ? 10 : 0;
    const y = PANEL_TOP + k * rowH + gap;
    ctx.globalAlpha = (f.alive ? 1 : 0.32) * alpha;
    const label = `${f.team.icon ? f.team.icon + ' ' : ''}${f.team.label}${f.giant ? ' (giant)' : ''}`;
    ctx.font = `900 ${Math.round(rowH * 0.5)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.text;
    ctx.fillText(label, x - 14, y + rowH / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.roundRect(x, y + rowH * 0.2, w, rowH * 0.6, rowH * 0.3);
    ctx.fill();
    ctx.fillStyle = f.flash > 0.2 ? '#ffffff' : f.team.color;
    ctx.beginPath();
    ctx.roundRect(x, y + rowH * 0.2, Math.max(0.001, (w * f.hp) / f.maxHp), rowH * 0.6, rowH * 0.3);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.font = `800 ${Math.round(rowH * 0.46)}px ${FONT_FAMILY}`;
    ctx.fillStyle = theme.text;
    ctx.fillText(`${WEAPONS[f.weapon.id].emoji} ${weaponStat(f.weapon)}`, x + w + 14, y + rowH / 2);
  });
  ctx.globalAlpha = 1;
}

function drawBracketPanel(ctx: Ctx2D, s: State, theme: Theme) {
  const alpha = panelAlpha(s);
  if (alpha <= 0 || !s.bracket) return;
  const b = s.bracket;
  ctx.save();
  ctx.globalAlpha = alpha;
  const title = b.match === BRACKET_MATCHES - 1 ? 'FINAL' : `SEMI-FINAL ${b.match + 1}`;
  textOutlined(ctx, title, 540, PANEL_TOP + 8, 40, theme.accent);
  // Fighting-game health bars, facing each other.
  const [i, j] = b.pairs[b.match];
  const pair = [s.fighters[i], s.fighters[j]];
  const barW = 400;
  const barH = 30;
  const y = PANEL_TOP + 50;
  pair.forEach((f, k) => {
    const dir = k === 0 ? -1 : 1;
    const x0 = 540 + dir * 26;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.roundRect(k === 0 ? x0 - barW : x0, y, barW, barH, 15);
    ctx.fill();
    const fw = Math.max(0.001, (barW * f.hp) / f.maxHp);
    ctx.fillStyle = f.flash > 0.2 ? '#ffffff' : f.team.color;
    ctx.beginPath();
    ctx.roundRect(k === 0 ? x0 - fw : x0, y, fw, barH, 15);
    ctx.fill();
    textOutlined(ctx, fighterLabel(f), k === 0 ? x0 - barW : x0 + barW, y + barH + 26, 28, theme.text, k === 0 ? 'left' : 'right');
    textOutlined(ctx, weaponStat(f.weapon), k === 0 ? x0 - 6 : x0 + 6, y + barH + 26, 24, theme.accent, k === 0 ? 'right' : 'left');
  });
  textOutlined(ctx, 'VS', 540, y + barH / 2, 28, '#ffffff');
  // Bracket strip: every entrant, dimmed once knocked out.
  const entrants = s.fighters;
  const gapX = 200;
  entrants.forEach((f, k) => {
    const ex = 540 + (k - 1.5) * gapX;
    const ey = y + barH + 76;
    const isWinner = s.winnerSide >= 0 && s.winner === f.idx;
    textOutlined(ctx, `${f.team.icon ?? f.team.label.slice(0, 3)} ${WEAPONS[f.weapon.id].emoji}`, ex, ey, 30, isWinner ? theme.accent : theme.text, 'center', f.alive ? 1 : 0.28);
    if (!f.alive) {
      ctx.strokeStyle = 'rgba(255,80,80,0.85)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(ex - 44, ey);
      ctx.lineTo(ex + 44, ey);
      ctx.stroke();
    }
  });
  ctx.restore();
}

// ---- template ------------------------------------------------------------------------------------

export const ballBattle: Template<BallBattleParams, State> = {
  id: 'ball-battle',
  name: 'Ball Battle',
  family: 'race',
  description:
    'Balls armed with weapons fight in a round arena that starts shrinking partway through. Weapons: sword (blade gets longer with every hit), twin daggers (spin faster with every hit), hammer (slow, heavy knockback hits; head grows) and bow (fires arrows when facing an enemy; one more arrow per volley with every hit). Hits freeze the action for a split second, knocked-out balls shatter, and the deciding blow plays in slow motion. Formats: free-for-all, two teams (2v2 or 3v3), one giant ball against a swarm of small ones, or a 4-ball knockout bracket (two semi-finals then a final). Weapons can be mixed (different weapons fight each other) or all the same.',
  schema: ballBattleSchema,
  substeps: 4,
  defaultCopy: {
    hook: 'Sword, daggers, hammer or bow: who wins?',
    cta: '{winner} wins! Who did you pick?',
  },

  init({ params: p, rng, fxRng, visual, width, height }) {
    const world = new World();
    world.gravity = p.gravity;
    const cx = width / 2;
    const cy = height * 0.57;
    const n = p.format === 'bracket' ? 4 : p.format === 'teams' ? Math.max(4, Math.min(6, p.fighters - (p.fighters % 2))) : p.format === 'giant' ? Math.max(3, p.fighters) : p.fighters;
    const pool = p.teams === 'countries' ? COUNTRY_TEAMS : COLOR_TEAMS;
    const sideTeams = p.format === 'teams' ? pickTeams(pool, 2, rng) : pickTeams(pool, n, rng);
    const order = [shuffled(WEAPON_IDS, rng), shuffled(WEAPON_IDS, rng)];
    const weaponFor = (i: number, side: number, rank: number): WeaponId => {
      if (p.weapons !== 'mixed') return p.weapons;
      if (p.format === 'teams') return order[side][rank % 4];
      if (p.format === 'giant') return i === 0 ? order[0][0] : order[1][(i - 1) % 4];
      return order[0][i % 4];
    };
    const crowd = n >= 5 ? 0.88 : 1;
    const fighters: Fighter[] = Array.from({ length: n }, (_, i) => {
      const side = p.format === 'teams' ? i % 2 : p.format === 'giant' ? (i === 0 ? 0 : 1) : i;
      const rank = p.format === 'teams' ? Math.floor(i / 2) : 0;
      const giant = p.format === 'giant' && i === 0;
      const r = giant ? p.ballRadius * 2.1 : p.ballRadius * crowd;
      const weapon = makeWeapon(weaponFor(i, side, rank), {
        scale: giant ? 1.9 : crowd,
        dmgScale: p.damageScale * (giant ? 1.5 : 1),
        growth: p.growthScale,
        spinScale: p.spinScale,
        rng,
      });
      const maxHp = giant ? Math.round(p.hp * (n - 1) * 0.85) : p.hp;
      const body = world.addBody({ x: cx, y: cy, vx: 0, vy: 0, r, restitution: 1, friction: 0, invMass: giant ? 0.25 : 1 });
      body.alive = false;
      return {
        idx: i,
        body,
        team: p.format === 'teams' ? sideTeams[side] : sideTeams[i],
        side,
        weapon,
        hp: maxHp,
        maxHp,
        angle: 0,
        alive: true,
        active: false,
        giant,
        speed: giant ? p.speed * 0.7 : p.speed,
        knock: 0,
        koAt: -1,
        flash: 0,
        lastVolleyUp: -1,
        tips: [],
      };
    });
    const R0 = p.arenaRadius;
    const maxR = Math.max(...fighters.map((f) => f.body.r));
    const s: State = {
      p,
      world,
      rng,
      fxRng,
      visual,
      cx,
      cy,
      R: R0,
      R0,
      minR: Math.min(R0 * 0.85, Math.max(R0 * 0.42, maxR * 1.8 + 30)),
      fighters,
      sideCount: p.format === 'teams' || p.format === 'giant' ? 2 : n,
      arrows: [],
      volleys: 0,
      stuck: [],
      sparks: [],
      shards: [],
      waves: [],
      cooldown: new Map(),
      clashCd: new Map(),
      t: 0,
      simT: 0,
      fightT: 0,
      phase: 'intro',
      phaseUntil: 0,
      freezeUntil: 0,
      slow: 1,
      slowTarget: 1,
      slowHoldUntil: 0,
      inThreat: false,
      threatStart: 0,
      threatLastT: 0,
      threatCooldownUntil: 0,
      threatsThisFight: 0,
      focusX: cx,
      focusY: cy,
      cam: { x: cx, y: cy, z: 1 },
      shrinking: false,
      shrinkAt: -1,
      leaderSide: -1,
      koPulseAt: -10,
      winner: -1,
      winnerSide: -1,
      endAt: null,
      shake: 0,
      bracket: p.format === 'bracket' ? { match: 0, pairs: [[0, 1], [2, 3]], winners: [] } : null,
    };
    if (!s.bracket) placeFighters(s, fighters);
    return s;
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    // Phase changes run on video time.
    if (s.bracket) {
      const b = s.bracket;
      if (t === 0) startMatch(s, t, emit);
      if (s.phase === 'intro' && t >= s.phaseUntil) startFight(s, t, emit);
      if (s.phase === 'after' && t >= s.phaseUntil) {
        b.match++;
        if (b.match === 2) b.pairs.push([b.winners[0], b.winners[1]]);
        startMatch(s, t, emit);
      }
    } else if (t === 0) startFight(s, t, emit);

    // Time scale: frozen on impact, slowed for the deciding blow, paused during a bracket intro.
    if (s.slowHoldUntil > t) s.slowTarget = SLOW;
    else if (!s.inThreat) s.slowTarget = 1;
    s.slow += (s.slowTarget - s.slow) * (1 - dm.exp(-dt * 14));
    const scale = s.phase === 'intro' || t < s.freezeUntil ? 0 : s.slow;
    const sdt = dt * scale;
    if (sdt > 0) simulate(s, sdt, t, emit);

    // Camera eases towards the action in slow motion.
    const slowmo = s.slowTarget < 1 || s.slow < 0.9;
    const zoom = slowmo ? (s.fighters.some((f) => f.giant) ? 1.15 : 1.32) : 1;
    let fx = slowmo ? s.focusX : s.cx;
    let fy = slowmo ? s.focusY : s.cy;
    const lim = s.R0 * 0.45;
    const dx = fx - s.cx;
    const dy = fy - s.cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > lim) {
      fx = s.cx + (dx / d) * lim;
      fy = s.cy + (dy / d) * lim;
    }
    const k = 1 - dm.exp(-dt * 7);
    s.cam.x += (fx - s.cam.x) * k;
    s.cam.y += (fy - s.cam.y) * k;
    s.cam.z += (zoom - s.cam.z) * k;

    for (const f of s.fighters) f.flash *= dm.exp(-8 * sdt);
    s.shake *= dm.exp(-10 * dt);
    if (s.visual) {
      if (sdt > 0) {
        for (const f of inArena(s)) {
          const c = dm.cos(f.angle);
          const sn = dm.sin(f.angle);
          localTips(f.weapon, f.body.r).forEach((tp, i) => {
            const w = toWorld(tp.x, tp.y, f.body.x, f.body.y, c, sn);
            (f.tips[i] ??= []).push(w);
            if (f.tips[i].length > 12) f.tips[i].shift();
          });
        }
      }
      s.sparks = updateSparks(s.sparks, sdt, 600);
      s.shards = updateShards(s.shards, sdt, 900);
      for (const w of s.waves) {
        w.r += w.grow * sdt;
        w.life -= sdt;
      }
      if (s.waves.some((w) => w.life <= 0)) s.waves = s.waves.filter((w) => w.life > 0);
      for (const a of s.stuck) a.life -= dt;
      if (s.stuck.some((a) => a.life <= 0)) s.stuck = s.stuck.filter((a) => a.life > 0);
    }
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    return {
      winner: winnerLabel(s),
      alive: stillInText(s),
      outro: s.endAt !== null && s.t >= s.endAt,
    };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.6, y: 0.12 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.2 },
    ];
  },

  render({ ctx, theme }, s) {
    const { p } = s;
    // Live "still in" counter, large and faint behind the action; flares up on a knockout.
    const since = s.t - s.koPulseAt;
    const flare = since >= 0 && since < 1 ? 1 - since : 0;
    if (s.endAt === null || s.t < s.endAt) {
      ctx.save();
      ctx.globalAlpha = 0.14 + 0.5 * flare;
      ctx.fillStyle = theme.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const txt = stillInText(s);
      ctx.font = `900 ${Math.round((txt.length > 2 ? 190 : 280) * (1 + 0.15 * flare))}px ${FONT_FAMILY}`;
      ctx.fillText(txt, s.cx, s.cy + 20);
      ctx.globalAlpha = 0.22 + 0.4 * flare;
      ctx.font = `900 40px ${FONT_FAMILY}`;
      ctx.fillText('STILL IN', s.cx, s.cy - 135);
      ctx.restore();
    }

    ctx.save();
    applyCamera(ctx, s);
    // Danger zone outside the shrinking wall.
    if (s.R < s.R0 - 1) {
      ctx.fillStyle = 'rgba(255,40,60,0.07)';
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, s.R0 + 5, 0, Math.PI * 2);
      ctx.arc(s.cx, s.cy, s.R + 5, 0, Math.PI * 2, true);
      ctx.fill();
      ctx.setLineDash([14, 14]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,90,100,0.35)';
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, s.R0 + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const ring = paletteAt(theme.palette, 0.8);
    const warn = s.shrinking && s.R > s.minR ? 0.5 + 0.5 * dm.sin(s.t * 12) : 0;
    ctx.lineWidth = 10;
    ctx.strokeStyle = rgbToCss([ring[0] + (255 - ring[0]) * warn * 0.8, ring[1] * (1 - warn * 0.7), ring[2] * (1 - warn * 0.7)]);
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, s.R + 5, 0, Math.PI * 2);
    ctx.stroke();

    // Weapon swoosh trails (glow).
    ctx.lineCap = 'round';
    for (const f of inArena(s)) {
      const col = lighten(hexToRgb(f.team.color), 0.4);
      for (const tips of f.tips) {
        for (let k = 1; k < tips.length; k++) {
          ctx.strokeStyle = rgbToCss(col, (k / tips.length) * 0.4);
          ctx.lineWidth = 12 * f.weapon.scale * (k / tips.length);
          ctx.beginPath();
          ctx.moveTo(tips[k - 1].x, tips[k - 1].y);
          ctx.lineTo(tips[k].x, tips[k].y);
          ctx.stroke();
        }
      }
    }
    for (const w of s.waves) {
      ctx.globalAlpha = Math.max(0, w.life / w.maxLife);
      ctx.lineWidth = 8;
      ctx.strokeStyle = w.color;
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    drawSparks(ctx, s.sparks);
    ctx.restore();

    // "Arena shrinking" warning above the arena.
    if (s.shrinking && s.t - s.shrinkAt < 2) {
      const a = Math.min(1, (2 - (s.t - s.shrinkAt)) / 0.3) * (0.65 + 0.35 * dm.sin(s.t * 14));
      textOutlined(ctx, '⚠ ARENA SHRINKING ⚠', s.cx, s.cy - p.arenaRadius - 48, 40, '#ff5a64', 'center', a);
    }
  },

  // Weapons, arrows, balls and HUD are drawn after bloom so they stay crisp and readable.
  renderTop({ ctx, theme }, s) {
    ctx.save();
    applyCamera(ctx, s);
    for (const a of s.stuck) drawArrowShape(ctx, a.x, a.y, a.angle, a.sc, a.color, Math.min(1, a.life / 0.4));
    const live = inArena(s);
    for (const f of live) {
      ctx.save();
      ctx.translate(f.body.x, f.body.y);
      ctx.rotate(f.angle);
      drawWeapon(ctx, f.weapon, f.body.r, f.team.color);
      ctx.restore();
    }
    for (const a of s.arrows) drawArrowShape(ctx, a.x, a.y, dm.atan2(a.vy, a.vx), a.sc, s.fighters[a.owner].team.color);
    for (const f of live) {
      const b = f.body;
      drawTeamBall(ctx, b.x, b.y, b.r, f.team, FONT_FAMILY, { initial: false });
      if (f.flash > 0.02) {
        ctx.fillStyle = `rgba(255,255,255,${Math.min(0.75, f.flash * 0.8)})`;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
      drawHp(ctx, String(Math.ceil(f.hp)), b.x, b.y, b.r);
    }
    drawShards(ctx, s.shards, FONT_FAMILY);
    ctx.restore();

    if (s.bracket) drawBracketPanel(ctx, s, theme);
    else drawRowsPanel(ctx, s, theme);

    // Bracket match intro card.
    if (s.bracket && s.phase === 'intro') {
      const b = s.bracket;
      const left = s.phaseUntil - s.t;
      const pop = Math.min(1, (INTRO_S - left) / 0.2);
      const a = Math.min(1, left / 0.2);
      const [i, j] = b.pairs[b.match];
      textOutlined(ctx, b.match === 2 ? 'FINAL' : `SEMI-FINAL ${b.match + 1}`, s.cx, s.cy - 60, 76 * (0.7 + 0.3 * pop), theme.accent, 'center', a);
      textOutlined(ctx, `${fighterLabel(s.fighters[i])}  vs  ${fighterLabel(s.fighters[j])}`, s.cx, s.cy + 30, 44 * (0.7 + 0.3 * pop), '#ffffff', 'center', a);
    }
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, ((e.x as number) - 540) / 540)) : 0;
    const note = (vel: number) => melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? vel * 0.45 : vel, voice: theme.voice, pan }));
    const melodic = (gap: number, vel: number) => (e.t - lastNoteT >= gap ? note(vel) : []);
    switch (e.type) {
      case 'wall':
      case 'bump':
        return e.t - lastNoteT >= 0.09 ? note(0.5) : [{ kind: 'sfx', name: 'tick', vel: 0.15, pan }];
      case 'hit':
        switch (e.weapon as WeaponId) {
          case 'hammer':
            return [{ kind: 'sfx', name: 'boom', vel: 0.75, pitch: 1.2, pan }, { kind: 'sfx', name: 'pop', vel: 0.6, pitch: 0.7, pan }, ...melodic(0.05, 0.9)];
          case 'dagger':
            return [{ kind: 'sfx', name: 'tick', vel: 0.7, pitch: 1.3, pan }, { kind: 'sfx', name: 'pop', vel: 0.45, pitch: 1.4, pan }, ...melodic(0.06, 0.75)];
          case 'bow':
            return [{ kind: 'sfx', name: 'pop', vel: 0.6, pitch: 1.25, pan }, ...melodic(0.06, 0.75)];
          default:
            return [{ kind: 'sfx', name: 'pop', vel: 0.8, pan }, ...melodic(0.05, 0.85)];
        }
      case 'shoot':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.22, pitch: 1.7, pan }];
      case 'parry':
        return [{ kind: 'sfx', name: 'chime', vel: 0.35, pitch: 1.5, pan }];
      case 'clash':
        return [{ kind: 'sfx', name: 'chime', vel: 0.5, pitch: 0.8, pan }, { kind: 'sfx', name: 'tick', vel: 0.6, pan }];
      case 'shrink':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.6, pitch: 0.55 }];
      case 'threat':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.45, pitch: 0.45 }];
      case 'matchStart':
        return [{ kind: 'sfx', name: 'chime', vel: 0.6, pitch: 1 }, { kind: 'sfx', name: 'whoosh', vel: 0.4 }];
      case 'ko':
        return [
          { kind: 'sfx', name: 'shatter', vel: 0.85, pan },
          { kind: 'sfx', name: 'boom', vel: 0.6 },
        ];
      case 'win':
        return [
          { kind: 'sfx', name: 'boom', vel: 1 },
          { kind: 'sfx', name: 'whoosh', vel: 0.7 },
          ...melody.peek().flatMap((midi) => [
            { kind: 'note' as const, midi, vel: 0.8, voice: 'bell' as const, dur: 2.5 },
            { kind: 'note' as const, midi: midi + 12, vel: 0.5, voice: 'bell' as const, dur: 2.5 },
          ]),
        ];
    }
    return [];
  },

  /**
   * Smart seed search: prefer fights that run to length, end close (the winner barely survives),
   * include a comeback and lead changes, never stall, and let every weapon land hits.
   */
  score(events, { durationS, targetS, timedOut }): DramaScore {
    const durFit = gaussFit(durationS, targetS, targetS * 0.2);
    const win = events.find((e) => e.type === 'win');
    if (timedOut || !win) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no winner'] };
    // Split into fights (one, or three for a bracket) and score each.
    const starts = events.filter((e) => e.type === 'fightStart');
    const ends = events.filter((e) => e.type === 'matchEnd');
    const fights = starts.map((st, k) => {
      const end = ends[k] ?? win;
      const hits = events.filter((e) => e.type === 'hit' && e.t >= st.t && e.t <= end.t);
      const w = end.side as number;
      const last = hits.at(-1)?.fr as number[] | undefined;
      const close = clamp01(1 - (last ? (last[w] ?? 0) : 1));
      let deficit = 0;
      for (const h of hits) {
        const fr = h.fr as number[];
        const others = fr.filter((_, i) => i !== w);
        if (others.length) deficit = Math.max(deficit, Math.max(...others) - fr[w]);
      }
      const times = [st.t, ...hits.map((h) => h.t), end.t];
      let gap = 0;
      for (let i = 1; i < times.length; i++) gap = Math.max(gap, times[i] - times[i - 1]);
      const leads = events.filter((e) => e.type === 'leadChange' && e.t >= st.t && e.t <= end.t).length;
      const present = new Set(st.weapons as string[]);
      const landed = new Set(hits.map((h) => h.weapon as string));
      return {
        close,
        comeback: clamp01(deficit / 0.45),
        lead: clamp01(leads / 4),
        lull: 1 - clamp01((gap - 3.5) / 5),
        variety: present.size ? landed.size / present.size : 1,
        weight: k === starts.length - 1 ? 2 : 1,
      };
    });
    const avg = (key: keyof (typeof fights)[number]) => {
      const wsum = fights.reduce((a, f) => a + f.weight, 0) || 1;
      return fights.reduce((a, f) => a + (f[key] as number) * f.weight, 0) / wsum;
    };
    const closeFit = avg('close');
    const comebackFit = avg('comeback');
    const lcFit = avg('lead');
    const lullFit = avg('lull');
    const varietyFit = avg('variety');
    const drama = 0.3 * closeFit + 0.25 * comebackFit + 0.15 * lcFit + 0.15 * lullFit + 0.15 * varietyFit;
    const total = durFit * (0.2 + 0.8 * drama);
    const hits = events.filter((e) => e.type === 'hit').length;
    const kos = events.filter((e) => e.type === 'ko').length;
    return {
      total,
      parts: { durFit, closeFit, comebackFit, lcFit, lullFit, varietyFit },
      notes: [`${hits} hits, ${kos} knockouts`, `winner finished on ${win.hp} HP`, `${events.filter((e) => e.type === 'threat').length} slow-motion moments`],
    };
  },
};
