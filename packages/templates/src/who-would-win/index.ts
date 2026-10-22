import { z } from 'zod';
import { FONT_FAMILY, type Ctx2D, type DramaScore, type Melody, type Rng, type SimEvent, type Template, type Theme } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { clamp01, gaussFit } from '../scoring';
import { MAX_SWARM_DEFAULT, hpScaleFor } from './balance';
import { CREATURES, CREATURE_IDS, DUELS, DUEL_IDS, HORDES, HORDE_IDS, TRAITS, creatureById, grownTo, hideText, matchupId, statBars, type CreatureDef } from './roster';
import { ARENA_R, condition, finisherIncoming, idleWorld, makeWorld, stepWorld, type Aim, type Clinch, type Fighter, type FighterState, type Grab, type Hurt, type World, type WorldMode, type Wound } from './sim';
import { drawScene, projectToScreen } from './view3d';
import { BEAT_S, VS_S, VS_SLAM, VS_SLAM_Y, VS_STRIPS, vsSlide } from './vs';

/** Fighters for the dropdowns, by name (after 'random'), and names for the matchups. */
const FIGHTER_CHOICES = ['random', ...[...CREATURE_IDS].sort((a, b) => creatureById(a).label.localeCompare(creatureById(b).label))] as [string, ...string[]];
const FIGHTER_NAMES = { random: 'Random', ...Object.fromEntries(CREATURE_IDS.map((id) => [id, creatureById(id).label])) };
const MATCHUP_NAMES = {
  random: 'Random',
  custom: 'Custom (the fighters below)',
  ...Object.fromEntries(DUELS.map(([a, b]) => [matchupId(a, b), `${creatureById(a).label} vs ${creatureById(b).label}`])),
  ...Object.fromEntries(HORDES.map(([a, b]) => [matchupId(a, b), `${creatureById(a).label} vs ${creatureById(b).plural}`])),
};

const MODES = ['duel', 'horde', 'team', 'tournament', 'gauntlet'] as const;
type Format = (typeof MODES)[number];
const MODE_NAMES: Record<Format, string> = {
  duel: 'Duel (one on one)',
  horde: 'Horde (how many does it take?)',
  team: 'Teams (two on two)',
  tournament: 'Tournament (4 fighters, 3 fights)',
  gauntlet: 'Gauntlet (one against a line of tougher foes)',
};
const fighter = (title: string, modes: Format[]) => z.enum(FIGHTER_CHOICES).default('random').meta({ title, optionLabels: FIGHTER_NAMES, modes });
const highlights = (title: string) => z.boolean().default(false).meta({ title: `Highlights only: ${title} (fast-forwards the quiet stretches)`, modes: ['tournament'] });

export const whoWouldWinSchema = z.object({
  mode: z.enum(MODES).default('duel').meta({ title: 'Mode', optionLabels: MODE_NAMES }),
  matchup: z.enum(['random', ...DUEL_IDS, ...HORDE_IDS, 'custom']).default('random').meta({ title: 'Matchup (curated; custom uses the two fighters below)', optionLabels: MATCHUP_NAMES, modes: ['duel', 'horde'] }),
  fighterA: fighter('Fighter A (custom matchup; the big one in a horde)', ['duel', 'horde']),
  fighterB: fighter('Fighter B (custom matchup; the swarm in a horde)', ['duel', 'horde']),
  team1a: fighter('Team 1: first fighter', ['team']),
  team1b: fighter('Team 1: second fighter', ['team']),
  team2a: fighter('Team 2: first fighter', ['team']),
  team2b: fighter('Team 2: second fighter', ['team']),
  entrant1: fighter('Fighter 1 (semi-final 1)', ['tournament']),
  entrant2: fighter('Fighter 2 (semi-final 1)', ['tournament']),
  entrant3: fighter('Fighter 3 (semi-final 2)', ['tournament']),
  entrant4: fighter('Fighter 4 (semi-final 2)', ['tournament']),
  highlightsSemi1: highlights('semi-final 1'),
  highlightsSemi2: highlights('semi-final 2'),
  highlightsFinal: highlights('the final'),
  challenger: fighter('The challenger', ['gauntlet']),
  gauntletSize: z.number().int().min(3).max(5).default(4).meta({ title: 'Opponents in a row (each tougher than the last)', step: 1, modes: ['gauntlet'] }),
  gauntletHighlights: z.boolean().default(false).meta({ title: 'Highlights only for all but the toughest opponent', modes: ['gauntlet'] }),
  poundForPound: z.boolean().default(false).meta({ title: "Pound for pound: the smaller fighter grows to the bigger one's weight", modes: ['duel', 'tournament', 'gauntlet'] }),
  maxSwarm: z.number().int().min(10).max(60).default(MAX_SWARM_DEFAULT).meta({ title: 'Horde: most the swarm can send', step: 1, modes: ['horde'] }),
  fightLength: z.number().min(6).max(30).default(16).meta({ title: 'Typical fight length, s (a single fight: video ≈ this + 12 s)', step: 1 }),
  hitFreeze: z.number().min(0).max(0.12).default(0.06).meta({ title: 'Hit freeze on big hits (s)', step: 0.01 }),
  slowMotion: z.boolean().default(true).meta({ title: 'Slow motion for the finishing blow' }),
  replay: z.boolean().default(true).meta({ title: 'Instant replay of the knockout' }),
  damageNumbers: z.boolean().default(true).meta({ title: 'Damage numbers' }),
  music: z.enum(['background', 'hits', 'off']).default('background').meta({ title: 'Music (background: the melody as a soundtrack at its own tempo; hits: a note on each blow)' }),
  drums: z.boolean().default(true).meta({ title: 'Battle drums and bass under the background music' }),
});

export type WhoWouldWinParams = z.infer<typeof whoWouldWinSchema>;

const COUNT_S = BEAT_S * 3;
const OUTRO_S = 2.6;
/** After the knockout: the live fall plays on for LIVE_TAIL_S, then the last REPLAY_PRE_S of sim
 * before it (and REPLAY_POST_S after) replays over REPLAY_S from a low angle. */
const LIVE_TAIL_S = 1.1;
export const REPLAY_S = 2.6;
const REPLAY_PRE_S = 1.3;
const REPLAY_POST_S = 0.7;
const SLOW = 0.25;
/** Between fights (tournament, gauntlet): the bracket or ladder, and how long after a knockout it comes. */
const CARD_S = 2.8;
const NEXT_S = 2.6;
/** Highlights: how fast the quiet stretches play, and how long a big moment plays at full speed. */
const HL_SPEED = 2.6;
const HL_HOLD_S = 1.4;

type Phase = 'card' | 'vs' | 'count' | 'fight' | 'over';

/** One fight on the card: its two sides (one fighter each, or a pair), what it's called, fast-forwarded or not. */
export interface Bout {
  left: CreatureDef[];
  right: CreatureDef[];
  title: string;
  highlights: boolean;
  /** Winning side, once fought (-1 before). */
  winner: number;
  hpLeft: number;
}

/** What the view needs of a fighter to pose it (live, or from a replay snapshot). */
export interface FighterView {
  idx: number;
  side: 0 | 1;
  def: CreatureDef;
  x: number;
  y: number;
  heading: number;
  alive: boolean;
  state: FighterState;
  stateT: number;
  moveIdx: number;
  hp: number;
  maxHp: number;
  flash: number;
  burn: number;
  diedAt: number;
  number: number;
  engaged: boolean;
  target: number;
  /** Procedural creatures: speed, gait cycles, turn rate, crouch, grapples, the last blow. */
  spd: number;
  gait: number;
  yawRate: number;
  crouch: number;
  grab: Grab | null;
  heldBy: number;
  lastHitT: number;
  lastHitDir: number;
  lastHitPow: number;
  dodgeDir: 1 | -1;
  /** Injuries: damage per part, the wounds (append-only, shared: those made after simT aren't shown yet),
   * where its current blow is going, a blow it slipped, knockdowns, flying height. */
  hurt: Hurt;
  wounds: Wound[];
  aim: Aim | null;
  evadeT: number;
  downLen: number;
  fallDir: 1 | -1;
  hover: number;
  /** Its speed along its heading, knockback included (its feet step with it); a clinch; a shield block. */
  stepV: number;
  clinch: Clinch | null;
  blockT: number;
  fury: number;
}

interface Snapshot {
  simT: number;
  fighters: FighterView[];
}

/** A damage number floating off a hit (visual only). */
export interface Popup {
  t: number;
  x: number;
  y: number;
  h: number;
  text: string;
  crit: boolean;
}

export interface State {
  p: WhoWouldWinParams;
  rng: Rng;
  fxRng: Rng;
  visual: boolean;
  /** The video's format, and the current fight's kind (a tournament or gauntlet is a run of duels). */
  format: Format;
  mode: WorldMode;
  /** The fights on the card, the one on now, and a count that changes with each one (the view rebuilds). */
  bouts: Bout[];
  bout: number;
  boutId: number;
  /** Tournament: the four fighters; gauntlet: the challenger then its opponents (as picked, before growing). */
  entrants: CreatureDef[];
  /** This fight's leads (left and right) and, in teams, their partners. */
  a: CreatureDef;
  b: CreatureDef;
  mates: CreatureDef[];
  w: World;
  /** When the next fight's card comes up (after a knockout that isn't the last). */
  nextAt: number | null;
  cardSaid: boolean;
  /** Highlights: steps owed (fractional), full speed until, fast-forwarding now. */
  hl: { acc: number; holdUntil: number; fast: boolean };
  /** Video time. */
  t: number;
  phase: Phase;
  phaseAt: number;
  vsStage: number;
  beats: number;
  freezeUntil: number;
  slow: number;
  slowTarget: number;
  slowHoldUntil: number;
  threatUntil: number;
  threatCooldownUntil: number;
  focusX: number;
  focusY: number;
  /** Camera target on the floor and how much of the arena it frames (metres across). */
  cam: { x: number; y: number; span: number };
  shake: number;
  popups: Popup[];
  /** The melody (transposed) and where the background music has got to. */
  melody: Melody;
  mus: { stepAt: number; idx: number; eighthAt: number; e8: number; root: number };
  /** Signature moments called out over the fighter ("DEATH ROLL!"), visual only. */
  callouts: { t: number; who: number; text: string; color: string }[];
  /** Recent hits (where they landed, for the impact flashes and the replay's sounds). */
  hits: { simT: number; sound: string; power: number; mass: number; x: number; y: number; h: number; crit: boolean; who: number; wound: number }[];
  /** Dust thrown up where something hits the ground (knockdowns, falls, landings). */
  dust: { simT: number; x: number; y: number; size: number }[];
  track: Snapshot[];
  winner: number;
  /** Horde: how many were sent when it was decided. */
  sent: number;
  /** The last to fall and who felled it (the replay frames these two). */
  koWho: number;
  koBy: number;
  finishAt: number;
  finishSimT: number;
  finishX: number;
  finishY: number;
  replayAt: number | null;
  endAt: number | null;
}

/** Fighters as the view sees them: live, or at replay time rt. */
export const viewOf = (f: Fighter | FighterView): FighterView => ({
  idx: f.idx,
  side: f.side,
  def: f.def,
  x: f.x,
  y: f.y,
  heading: f.heading,
  alive: f.alive,
  state: f.state,
  stateT: f.stateT,
  moveIdx: f.moveIdx,
  hp: f.hp,
  maxHp: f.maxHp,
  flash: f.flash,
  burn: f.burn,
  diedAt: f.diedAt,
  number: f.number,
  engaged: f.engaged,
  target: f.target,
  spd: f.spd,
  gait: f.gait,
  yawRate: f.yawRate,
  crouch: f.crouch,
  grab: f.grab ? { ...f.grab } : null,
  heldBy: f.heldBy,
  lastHitT: f.lastHitT,
  lastHitDir: f.lastHitDir,
  lastHitPow: f.lastHitPow,
  dodgeDir: f.dodgeDir,
  hurt: { ...f.hurt },
  wounds: f.wounds,
  aim: f.aim,
  evadeT: f.evadeT,
  downLen: f.downLen,
  fallDir: f.fallDir,
  hover: f.hover,
  stepV: f.stepV,
  clinch: f.clinch ? { ...f.clinch } : null,
  blockT: f.blockT,
  fury: f.fury,
});

const CALLOUTS: Record<string, { text: string; color: string }> = {
  'grab:latch': { text: 'LATCHED ON!', color: '#ffd23b' },
  'grab:roll': { text: 'DEATH ROLL!', color: '#ff5a64' },
  'grab:pin': { text: 'MAULED!', color: '#ff5a64' },
  'shakeOff:latch': { text: 'SHAKEN OFF!', color: '#ffffff' },
  'shakeOff:roll': { text: 'BROKE FREE!', color: '#ffffff' },
  'shakeOff:pin': { text: 'BROKE FREE!', color: '#ffffff' },
  bluff: { text: 'BLUFF!', color: '#ffffff' },
  roar: { text: 'ROAR!', color: '#ffb03b' },
  knockdown: { text: 'KNOCKED DOWN!', color: '#ffd23b' },
  'clinch:horns': { text: 'LOCKED HORNS!', color: '#ffd23b' },
  'clinch:grapple': { text: 'GRAPPLE!', color: '#ffd23b' },
  'shove:aside': { text: 'SHOVED ASIDE!', color: '#ffffff' },
  'shove:down': { text: 'THROWN DOWN!', color: '#ff5a64' },
  block: { text: 'BLOCKED!', color: '#9fd3ff' },
  'injury:leg': { text: 'LIMPING!', color: '#ff8a5a' },
  'injury:arm': { text: 'ARM HURT!', color: '#ff8a5a' },
  'injury:head': { text: 'DAZED!', color: '#ff8a5a' },
  'injury:body': { text: 'WINDED!', color: '#ff8a5a' },
  'injury:wing': { text: 'WING TORN!', color: '#ff5a64' },
};

/** What its injuries show as, under its name (worst first). */
function statusOf(f: FighterView): string[] {
  if (!f.alive) return [];
  const c = condition(f);
  const out: [number, string][] = [];
  if (c.wing >= 0.5) out.push([c.wing + 0.2, f.hover < 0.3 ? 'GROUNDED' : 'WING TORN']);
  if (c.leg >= 0.5) out.push([c.leg, 'LIMPING']);
  if (c.arm >= 0.5) out.push([c.arm, 'ARM HURT']);
  if (c.head >= 0.5) out.push([c.head, 'DAZED']);
  if (c.body >= 0.5 || c.spent >= 0.6) out.push([Math.max(c.body, c.spent), 'WINDED']);
  return out.sort((a, b) => b[0] - a[0]).slice(0, 2).map((x) => x[1]);
}

export const replaying = (s: State) => s.replayAt !== null && s.endAt !== null && s.t >= s.replayAt && s.t < s.endAt;
/** Replay sim time at video time t. */
const replayTime = (s: State, t: number) => s.finishSimT - REPLAY_PRE_S + ((t - s.replayAt!) / REPLAY_S) * (REPLAY_PRE_S + REPLAY_POST_S);

/** The fighters to draw now (from the replay track while replaying), and their sim time. */
export function fightersNow(s: State): { fighters: FighterView[]; simT: number } {
  if (!replaying(s) || !s.track.length) return { fighters: s.w.fighters.map(viewOf), simT: s.w.simT };
  const rt = replayTime(s, s.t);
  const tr = s.track;
  let lo = 0;
  let hi = tr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tr[mid].simT < rt) lo = mid + 1;
    else hi = mid;
  }
  return { fighters: tr[lo].fighters, simT: tr[lo].simT };
}

const nameOf = (c: CreatureDef) => c.label;
const lastStanding = (s: State, side: number) => s.w.fighters.filter((f) => f.side === side && f.alive);
/** A side's names: "Lion" or "Lion & Tiger". */
const sideName = (cs: CreatureDef[]) => cs.map(nameOf).join(' & ');
const sideIcons = (cs: CreatureDef[]) => cs.map((c) => c.icon).join('');
/** This fight's two sides. */
export const sidesOf = (s: State): CreatureDef[][] => (s.mode === 'team' ? [[s.a, s.mates[0]], [s.b, s.mates[1]]] : [[s.a], [s.b]]);
const multi = (s: State) => s.format === 'tournament' || s.format === 'gauntlet';

/** Fighters that hold their own one on one (the duel roster): random picks for teams, tournaments and gauntlets. */
const POOL = [...new Set(DUELS.flat())];
/** How tough a fighter is overall (0..1), for ordering a gauntlet and balancing random teams. */
export const ratingOf = (c: CreatureDef) => {
  const b = statBars(c);
  return 0.3 * b.size + 0.25 * b.power + 0.25 * b.toughness + 0.1 * b.strength + 0.1 * b.speed;
};

/** The chosen fighters, with every 'random' one filled in by a different fighter from the pool. */
function fillIn(rng: Rng, picks: string[]): CreatureDef[] {
  const used = new Set(picks.filter((x) => x !== 'random'));
  return picks.map((x) => {
    if (x !== 'random') return creatureById(x);
    const left = POOL.filter((id) => !used.has(id));
    const id = rng.pick(left.length ? left : POOL);
    used.add(id);
    return creatureById(id);
  });
}

/** The card: one fight (duel, horde, teams), a bracket of three, or a challenger's run of opponents. */
function makeCard(p: WhoWouldWinParams, rng: Rng): { bouts: Bout[]; entrants: CreatureDef[] } {
  const bout = (left: CreatureDef[], right: CreatureDef[], title = '', highlights = false): Bout => ({ left, right, title, highlights, winner: -1, hpLeft: 0 });
  if (p.mode === 'tournament') {
    const e = fillIn(rng, [p.entrant1, p.entrant2, p.entrant3, p.entrant4]);
    return {
      entrants: e,
      bouts: [bout([e[0]], [e[1]], 'SEMI-FINAL 1', p.highlightsSemi1), bout([e[2]], [e[3]], 'SEMI-FINAL 2', p.highlightsSemi2), bout([], [], 'THE FINAL', p.highlightsFinal)],
    };
  }
  if (p.mode === 'gauntlet') {
    const [ch] = fillIn(rng, [p.challenger]);
    // One opponent from each band of the roster (weakest band first), so each is tougher than the last.
    const rest = POOL.filter((id) => id !== ch.id)
      .map(creatureById)
      .sort((x, y) => ratingOf(x) - ratingOf(y) || x.id.localeCompare(y.id));
    const n = p.gauntletSize;
    const opps = Array.from({ length: n }, (_, i) => rest[Math.floor(((i + rng.range(0.15, 0.85)) / n) * rest.length)]);
    return { entrants: [ch, ...opps], bouts: opps.map((o, i) => bout([ch], [o], `FIGHT ${i + 1} OF ${n}`, p.gauntletHighlights && i < n - 1)) };
  }
  if (p.mode === 'team') {
    const picks = [p.team1a, p.team1b, p.team2a, p.team2b];
    let [a, c, b, d] = fillIn(rng, picks);
    // All four random: the closest-matched way of pairing them up.
    if (picks.every((x) => x === 'random')) {
      const all = [a, c, b, d];
      const splits: [number, number, number, number][] = [
        [0, 1, 2, 3],
        [0, 2, 1, 3],
        [0, 3, 1, 2],
      ];
      const gap = ([i, j, k, l]: number[]) => Math.abs(ratingOf(all[i]) + ratingOf(all[j]) - ratingOf(all[k]) - ratingOf(all[l]));
      const [i, j, k, l] = splits.reduce((x, y) => (gap(y) < gap(x) ? y : x));
      [a, c, b, d] = [all[i], all[j], all[k], all[l]];
    }
    return { entrants: [a, c, b, d], bouts: [bout([a, c], [b, d])] };
  }
  const [a, b] = resolveFighters(p, rng);
  return { entrants: [a, b], bouts: [bout([a], [b])] };
}

function resolveFighters(p: WhoWouldWinParams, rng: Rng): [CreatureDef, CreatureDef] {
  const horde = p.mode === 'horde';
  const list: readonly (readonly [string, string])[] = horde ? HORDES : DUELS;
  const ids = horde ? HORDE_IDS : DUEL_IDS;
  if (p.matchup === 'custom') {
    const a = p.fighterA === 'random' ? rng.pick(CREATURE_IDS) : p.fighterA;
    let b = p.fighterB === 'random' ? rng.pick(CREATURE_IDS) : p.fighterB;
    while (b === a && p.fighterB === 'random') b = rng.pick(CREATURE_IDS);
    return [creatureById(a), creatureById(b)];
  }
  const k = ids.indexOf(p.matchup);
  const [a, b] = k >= 0 ? list[k] : rng.pick(list);
  return [creatureById(a), creatureById(b)];
}

/**
 * Background music: the melody at its own tempo (held to a lively 96-144 bpm), looping, with a bass line
 * on the beat (the root of the latest chord in the tune) and a battle drum pattern, a tom fill every
 * fourth bar. Independent of the fight.
 */
function runMusic(s: State, t: number, dt: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  const m = s.melody;
  const bpm = Math.max(96, Math.min(144, m.bpm ?? 112));
  const beat = 60 / bpm;
  const unit = beat * (m.unit ?? 1);
  const mu = s.mus;
  while (mu.stepAt < t + dt) {
    const i = mu.idx % m.steps.length;
    const notes = m.steps[i];
    const dur = (m.beats?.[i] ?? 1) * unit;
    emit({ type: 'mnote', notes, dur: Math.round(dur * 0.92 * 1000) / 1000 });
    if (notes.length > 1) mu.root = Math.min(...notes);
    mu.stepAt += dur;
    mu.idx++;
  }
  while (mu.eighthAt < t + dt) {
    const inBar = mu.e8 % 8;
    const fill = Math.floor(mu.e8 / 8) % 4 === 3 && inBar >= 6;
    if (s.p.drums) {
      if (inBar % 2 === 0) emit({ type: 'mbass', midi: 36 + (((mu.root % 12) + 12) % 12), dur: Math.round(beat * 0.85 * 1000) / 1000 });
      emit({ type: 'mdrum', kick: inBar === 0 || inBar === 3 || inBar === 4 ? 1 : 0, snare: !fill && (inBar === 2 || inBar === 6) ? 1 : 0, hat: fill ? 0 : 1, open: inBar === 7 && !fill ? 1 : 0, tom: fill ? 1 : 0, tp: inBar === 6 ? 0.6 : 0.3 });
    }
    mu.e8++;
    mu.eighthAt += beat / 2;
  }
}

/** Set up fight i of the card: its world (fresh HP), the view rebuilt, its card or VS screen first. */
function startBout(s: State, i: number, t: number) {
  const { p } = s;
  const bt = s.bouts[i];
  let [a, b] = [bt.left[0], bt.right[0]];
  // Pound for pound: the smaller one grows to the bigger one's weight.
  if (p.poundForPound && s.mode === 'duel') {
    const m = Math.max(a.mass, b.mass);
    [a, b] = [grownTo(a, m), grownTo(b, m)];
  }
  s.bout = i;
  s.boutId++;
  s.a = a;
  s.b = b;
  s.mates = s.mode === 'team' ? [bt.left[1], bt.right[1]] : [];
  s.w = makeWorld({ mode: s.mode, a, b, mates: s.mode === 'team' ? [bt.left[1], bt.right[1]] : undefined, hpScale: hpScaleFor(p.fightLength), capS: p.fightLength * 2, maxSwarm: p.maxSwarm, rng: s.rng });
  s.phase = multi(s) ? 'card' : 'vs';
  s.phaseAt = t;
  s.cardSaid = false;
  s.vsStage = 0;
  s.beats = 0;
  s.freezeUntil = 0;
  s.slow = 1;
  s.slowTarget = 1;
  s.slowHoldUntil = 0;
  s.threatUntil = 0;
  s.threatCooldownUntil = 0;
  s.hl = { acc: 0, holdUntil: 0, fast: false };
  s.popups = [];
  s.callouts = [];
  s.hits = [];
  s.dust = [];
  s.track = [];
  s.winner = -1;
  s.koWho = -1;
  s.koBy = -1;
  s.nextAt = null;
  s.replayAt = null;
}

/** Is this fight the card's last (a tournament's final; a gauntlet's last opponent, or the challenger's loss)? */
function lastBout(s: State, winner: number) {
  if (s.format === 'tournament') return s.bout === 2;
  if (s.format === 'gauntlet') return winner !== 0 || s.bout === s.bouts.length - 1;
  return true;
}

/** On to the next fight: a tournament's final is the two semi-final winners. */
function nextBout(s: State, t: number) {
  if (s.format === 'tournament' && s.bout === 1) {
    const [s1, s2] = s.bouts;
    s.bouts[2].left = [s1.winner === 0 ? s1.left[0] : s1.right[0]];
    s.bouts[2].right = [s2.winner === 0 ? s2.left[0] : s2.right[0]];
  }
  startBout(s, s.bout + 1, t);
}

/** The champion of the card (the winning side's lead), and in a gauntlet how many the challenger beat. */
function cardResult(s: State) {
  const bt = s.bouts[s.bout];
  const champ = bt.winner === 0 ? bt.left : bt.right;
  const beaten = s.bouts.filter((x) => x.winner === 0).length;
  return { champ, beaten };
}

function endMatch(s: State, t: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  const { p, w } = s;
  const bt = s.bouts[s.bout];
  const champs = lastStanding(s, w.winner);
  const hpLeft = champs.length ? Math.max(...champs.map((f) => f.hp / f.maxHp)) : 0;
  bt.winner = w.winner;
  bt.hpLeft = hpLeft;
  const last = lastBout(s, w.winner);
  s.phase = 'over';
  s.phaseAt = t;
  s.winner = w.winner;
  s.sent = w.swarm?.sent ?? 0;
  s.koWho = w.koWho;
  s.koBy = w.koBy;
  s.finishAt = t;
  s.finishSimT = w.simT;
  const who = w.fighters[w.koWho];
  const by = w.fighters[w.koBy];
  s.finishX = who ? (by ? (who.x + by.x) / 2 : who.x) : 0;
  s.finishY = who ? (by ? (who.y + by.y) / 2 : who.y) : 0;
  s.focusX = s.finishX;
  s.focusY = s.finishY;
  s.slowHoldUntil = t + (p.slowMotion ? 1.1 : 0);
  const champ = champs[0]?.def;
  const voice = { call: champ?.voice?.call ?? '', cp: champ?.voice?.pitch ?? 0.5 };
  const hp = Math.round(hpLeft * 1000) / 1000;
  if (!last) {
    // Not the last fight: the knockout, the winner moving on, then the next card.
    s.nextAt = t + NEXT_S + (p.slowMotion ? 0.4 : 0);
    emit({ type: 'bout', side: w.winner, hpLeft: hp, a: s.a.id, b: s.b.id, n: s.bout, ...voice });
    return;
  }
  if (p.replay && s.track.length) {
    s.replayAt = t + LIVE_TAIL_S;
    s.endAt = s.replayAt + REPLAY_S;
  } else s.endAt = t + (p.slowMotion ? 1.4 : 0.6);
  const { champ: top, beaten } = cardResult(s);
  emit({
    type: 'win',
    side: w.winner,
    mode: s.mode,
    format: s.format,
    sent: s.sent,
    hpLeft: hp,
    a: s.a.id,
    b: s.b.id,
    // (Teams: everyone on each side; a tournament or gauntlet: the champion, how many it beat of how many.)
    left: sidesOf(s)[0].map((c) => c.id).join('+'),
    right: sidesOf(s)[1].map((c) => c.id).join('+'),
    champ: top.map((c) => c.id).join('+'),
    beaten,
    total: s.bouts.length,
    max: p.maxSwarm,
    ...voice,
    bells: p.music === 'background' ? 0 : 1,
  });
}

function textOutlined(ctx: Ctx2D, text: string, x: number, y: number, size: number, color = '#ffffff', align: CanvasTextAlign = 'center', alpha = 1) {
  if (alpha <= 0) return;
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

function fitText(ctx: Ctx2D, text: string, size: number, maxW: number) {
  ctx.font = `900 ${Math.round(size)}px ${FONT_FAMILY}`;
  const w = ctx.measureText(text).width;
  return w > maxW ? size * (maxW / w) : size;
}

const PANEL_Y = 1920 * 0.16;

/** HP bar with a lagging "recent damage" tail. */
function hpBar(ctx: Ctx2D, x: number, y: number, w: number, h: number, frac: number, color: string, flash: number, alignRight: boolean) {
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(x - 4, y - 4, w + 8, h + 8, (h + 8) / 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  const fw = Math.max(0.001, w * clamp01(frac));
  ctx.fillStyle = flash > 0.35 ? '#ffffff' : frac < 0.25 ? '#ff4d5a' : color;
  ctx.beginPath();
  ctx.roundRect(alignRight ? x + w - fw : x, y, fw, h, h / 2);
  ctx.fill();
}

/** The fury meter under an HP bar: fills orange, and flickers when full (the finisher is coming). */
function furyBar(ctx: Ctx2D, x: number, y: number, w: number, fury: number, alignRight: boolean, t: number) {
  if (fury <= 0.001) return;
  const h = 9;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  const fw = Math.max(0.001, w * clamp01(fury));
  const full = fury >= 1;
  ctx.fillStyle = full ? (Math.floor(t * 8) % 2 ? '#ffd23b' : '#ff7a1a') : '#ff9a2e';
  ctx.beginPath();
  ctx.roundRect(alignRight ? x + w - fw : x, y, fw, h, h / 2);
  ctx.fill();
}

/** Duel: fighting-game bars facing each other. Horde: the big one's bar and the count. */
function drawPanel(ctx: Ctx2D, s: State, theme: Theme, fighters: FighterView[]) {
  if (s.phase === 'vs' || s.phase === 'card') return;
  const hideAt = s.replayAt ?? s.endAt;
  const alpha = hideAt !== null && s.t >= hideAt ? 1 - (s.t - hideAt) / 0.25 : s.phase === 'count' ? (s.t - s.phaseAt) / 0.3 : 1;
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  if (s.mode === 'duel') {
    const barW = 420;
    const barH = 34;
    const y = PANEL_Y;
    fighters.slice(0, 2).forEach((f, k) => {
      const x0 = k === 0 ? 540 - 30 - barW : 540 + 30;
      hpBar(ctx, x0, y, barW, barH, f.hp / f.maxHp, k === 0 ? '#4fc3ff' : '#ffb03b', f.flash, k === 0);
      furyBar(ctx, x0, y + barH + 8, barW, f.fury, k === 0, s.t);
      const name = `${f.def.icon} ${nameOf(f.def).toUpperCase()}`;
      textOutlined(ctx, name, k === 0 ? x0 : x0 + barW, y + barH + 34, fitText(ctx, name, 40, barW), '#ffffff', k === 0 ? 'left' : 'right');
      const st = statusOf(f).join(' · ');
      if (st) textOutlined(ctx, st, k === 0 ? x0 : x0 + barW, y + barH + 78, fitText(ctx, st, 28, barW), '#ff8a5a', k === 0 ? 'left' : 'right');
      textOutlined(ctx, `${Math.max(0, Math.ceil(f.hp / s.w.hpScale))} HP`, k === 0 ? x0 + barW - 14 : x0 + 14, y + barH / 2, 22, '#ffffff', k === 0 ? 'right' : 'left', 0.95);
    });
    textOutlined(ctx, 'VS', 540, y + barH / 2, 34, theme.accent);
  } else if (s.mode === 'team') {
    // Two slimmer bars a side, partners stacked.
    const barW = 420;
    const barH = 24;
    for (const f of fighters) {
      const k = f.side;
      const row = f.idx % 2;
      const x0 = k === 0 ? 540 - 30 - barW : 540 + 30;
      const y = PANEL_Y - 40 + row * 92;
      const right = k === 0;
      ctx.save();
      if (!f.alive) ctx.globalAlpha *= 0.45;
      hpBar(ctx, x0, y, barW, barH, f.hp / f.maxHp, k === 0 ? '#4fc3ff' : '#ffb03b', f.flash, right);
      furyBar(ctx, x0, y + barH + 6, barW, f.fury, right, s.t);
      const st = statusOf(f)[0];
      const name = `${f.def.icon} ${nameOf(f.def).toUpperCase()}${!f.alive ? ' · OUT' : st ? ` · ${st}` : ''}`;
      textOutlined(ctx, name, k === 0 ? x0 : x0 + barW, y + barH + 32, fitText(ctx, name, 30, barW), !f.alive ? '#ff5a64' : st ? '#ffd0b0' : '#ffffff', k === 0 ? 'left' : 'right');
      ctx.restore();
    }
    textOutlined(ctx, 'VS', 540, PANEL_Y + 6, 34, theme.accent);
  } else {
    const big = fighters[0];
    const barW = 860;
    const x0 = 540 - barW / 2;
    hpBar(ctx, x0, PANEL_Y, barW, 34, big.hp / big.maxHp, '#ff8a3b', big.flash, false);
    furyBar(ctx, x0, PANEL_Y + 42, barW, big.fury, false, s.t);
    textOutlined(ctx, `${big.def.icon} ${nameOf(big.def).toUpperCase()}`, x0, PANEL_Y + 34 + 34, 38, '#ffffff', 'left');
    const st = statusOf(big).join(' · ');
    if (st) textOutlined(ctx, st, x0, PANEL_Y + 34 + 78, 28, '#ff8a5a', 'left');
    textOutlined(ctx, `${Math.max(0, Math.ceil(big.hp / s.w.hpScale))} HP`, x0 + barW - 14, PANEL_Y + 17, 22, '#ffffff', 'right');
    const sent = s.w.swarm?.sent ?? 0;
    const down = fighters.filter((f) => f.side === 1 && !f.alive).length;
    const label = `${s.b.icon} × ${sent}`;
    textOutlined(ctx, label, x0 + barW, PANEL_Y + 34 + 40, 58, theme.accent, 'right');
    textOutlined(ctx, `${s.b.plural.toUpperCase()} SENT · ${down} DOWN`, x0 + barW, PANEL_Y + 34 + 92, 24, '#ffffff', 'right');
  }
  ctx.restore();
}

/** Over a fight on a card: which fight it is, and a fast-forward badge for highlights. */
function drawBoutTag(ctx: Ctx2D, s: State, theme: Theme) {
  const bt = s.bouts[s.bout];
  if (!bt.title && !bt.highlights) return;
  if (s.phase !== 'fight' && s.phase !== 'count' && !(s.phase === 'over' && s.replayAt === null)) return;
  const y = PANEL_Y - (s.mode === 'team' ? 110 : 70);
  const parts = [bt.title, bt.highlights ? (s.hl.fast ? '⏩ HIGHLIGHTS' : '▶ HIGHLIGHTS') : ''].filter(Boolean).join('  ·  ');
  ctx.save();
  ctx.font = `900 30px ${FONT_FAMILY}`;
  const w = ctx.measureText(parts).width + 44;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(540 - w / 2, y - 26, w, 52, 26);
  ctx.fill();
  ctx.restore();
  textOutlined(ctx, parts, 540, y, 30, s.hl.fast ? theme.accent : '#ffffff');
}

/** A name box on the bracket or ladder: out (dimmed, struck through), won (gold), or still to fight. */
function nameBox(ctx: Ctx2D, x: number, y: number, w: number, h: number, c: CreatureDef | null, opts: { color: string; out?: boolean; won?: boolean; live?: boolean; t: number; note?: string }) {
  ctx.save();
  if (opts.out) ctx.globalAlpha *= 0.4;
  ctx.fillStyle = opts.won ? 'rgba(255,210,59,0.2)' : 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.roundRect(x, y - h / 2, w, h, 18);
  ctx.fill();
  ctx.lineWidth = opts.live ? 6 + 3 * Math.abs(Math.sin(opts.t * 5)) : 4;
  ctx.strokeStyle = opts.won ? '#ffd23b' : opts.live ? '#ffffff' : opts.color;
  ctx.stroke();
  const label = c ? `${c.icon} ${nameOf(c).toUpperCase()}` : '?';
  textOutlined(ctx, label, x + w / 2, y + (opts.note ? -12 : 0), fitText(ctx, label, 46, w - 36), c ? '#ffffff' : 'rgba(255,255,255,0.6)');
  if (opts.note) textOutlined(ctx, opts.note, x + w / 2, y + 30, 22, 'rgba(255,255,255,0.8)');
  if (opts.out) {
    ctx.strokeStyle = '#ff5a64';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(x + 24, y);
    ctx.lineTo(x + w - 24, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Between fights: the tournament bracket or the gauntlet's ladder, the fight coming up pulsing. */
function drawCard(ctx: Ctx2D, s: State, theme: Theme) {
  const since = s.t - s.phaseAt;
  const a = clamp01(Math.min(since / 0.25, (CARD_S - since) / 0.25));
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = 'rgba(8,8,16,0.78)';
  ctx.fillRect(0, 0, 1080, 1920);
  const slide = (k: number) => 60 * (1 - clamp01((since - 0.1 * k) / 0.3)) ** 2;
  if (s.format === 'tournament') {
    textOutlined(ctx, '🏆 TOURNAMENT', 540, 380, 88, theme.accent);
    textOutlined(ctx, s.bout === 0 ? '4 FIGHTERS · 1 CHAMPION' : s.bout === 1 ? 'NEXT UP: SEMI-FINAL 2' : 'THE FINAL', 540, 470, 40, '#ffffff');
    const rows = [640, 900, 1220];
    s.bouts.forEach((bt, i) => {
      const y = rows[i] + slide(i);
      const live = i === s.bout;
      const done = bt.winner >= 0;
      textOutlined(ctx, bt.title + (bt.highlights ? '  ·  ⏩ HIGHLIGHTS' : ''), 540, y - 100, 30, live ? theme.accent : 'rgba(255,255,255,0.85)');
      [bt.left[0] ?? null, bt.right[0] ?? null].forEach((c, k) => {
        nameBox(ctx, k === 0 ? 50 : 590, y, 440, 116, c, { color: k === 0 ? '#4fc3ff' : '#ffb03b', out: done && bt.winner !== k, won: done && bt.winner === k, live, t: s.t });
      });
      textOutlined(ctx, 'VS', 540, y, 40, theme.accent);
    });
    textOutlined(ctx, '▼', 540, 1065 + slide(2), 44, 'rgba(255,255,255,0.6)');
    const fin = s.bouts[2];
    const champ = fin.winner >= 0 ? (fin.winner === 0 ? fin.left[0] : fin.right[0]) : null;
    textOutlined(ctx, `🏆 ${champ ? nameOf(champ).toUpperCase() : '?'}`, 540, 1430 + slide(3), 64, '#ffd23b');
  } else {
    const [ch] = s.entrants;
    textOutlined(ctx, '⚔️ THE GAUNTLET', 540, 360, 84, theme.accent);
    const sub = `${ch.icon} ${nameOf(ch).toUpperCase()} vs ${s.bouts.length} IN A ROW`;
    textOutlined(ctx, sub, 540, 450, fitText(ctx, sub, 44, 980), '#ffffff');
    const n = s.bouts.length;
    const gap = Math.min(170, 820 / n);
    s.bouts.forEach((bt, i) => {
      const y = 600 + i * gap + slide(i);
      const live = i === s.bout;
      const done = bt.winner >= 0;
      textOutlined(ctx, `FIGHT ${i + 1}`, 110, y, 28, live ? theme.accent : 'rgba(255,255,255,0.8)', 'left');
      const stars = '★'.repeat(i + 1) + '☆'.repeat(n - 1 - i);
      nameBox(ctx, 290, y, 600, Math.min(124, gap - 30), bt.right[0], { color: '#ffb03b', out: done && bt.winner === 0, won: done && bt.winner === 1, live, t: s.t, note: stars });
      const mark = done ? (bt.winner === 0 ? '✓' : '✗') : live ? '▶' : '';
      if (mark) textOutlined(ctx, mark, 960, y, 56, bt.winner === 0 ? '#6aff8a' : bt.winner === 1 ? '#ff5a64' : '#ffffff');
    });
    textOutlined(ctx, 'FULL HEALTH EACH FIGHT · ONE LOSS ENDS IT', 540, 600 + n * gap + 10, 28, 'rgba(255,255,255,0.8)');
  }
  ctx.restore();
}

/** VS card text: both fighters' names and stat bars, the VS slam. The models stand in the strips (view). */
function drawVs(ctx: Ctx2D, s: State, theme: Theme) {
  const sl = vsSlide(s.phase, s.t - s.phaseAt);
  if (!sl.showing) return;
  const blocks: { cs: CreatureDef[]; title: string }[] =
    s.mode === 'horde'
      ? [
          { cs: [s.a], title: `${s.a.icon} 1 ${nameOf(s.a).toUpperCase()}` },
          { cs: [s.b], title: `${s.b.icon} ? ${s.b.plural.toUpperCase()}` },
        ]
      : sidesOf(s).map((cs) => ({ cs, title: cs.map((c) => `${c.icon} ${nameOf(c).toUpperCase()}`).join(' & ') }));
  const since = s.phase === 'vs' ? s.t - s.phaseAt : VS_S;
  blocks.forEach((bl, k) => {
    const st = VS_STRIPS[k];
    const col = st.textX;
    const right = st.align === 'right';
    ctx.save();
    ctx.translate(sl.o[k].x, sl.o[k].y);
    const title = bl.title;
    textOutlined(ctx, title, col, st.titleY, fitText(ctx, title, 64, 480), '#ffffff', st.align);
    // Pound for pound: how much it grew.
    const grown = bl.cs[0].scale ?? 1;
    if (grown > 1.01) {
      const g = `📏 GROWN TO ${Math.round(bl.cs[0].mass)} KG (×${grown.toFixed(1)} SIZE)`;
      textOutlined(ctx, g, col, st.titleY - 58, fitText(ctx, g, 28, 480), '#ffd23b', st.align);
    }
    // (A pair: their bars averaged.)
    const each = bl.cs.map(statBars);
    const avg = (k: keyof (typeof each)[number]) => each.reduce((x, b) => x + b[k], 0) / each.length;
    const bars = { size: avg('size'), power: avg('power'), speed: avg('speed'), strength: avg('strength'), toughness: avg('toughness') };
    const rows: [string, number][] = [
      ['SIZE', bars.size],
      ['POWER', bars.power],
      ['SPEED', bars.speed],
      ['STRENGTH', bars.strength],
      ['TOUGHNESS', bars.toughness],
    ];
    rows.forEach(([label, v], i) => {
      const y = st.titleY + 66 + i * 46;
      textOutlined(ctx, label, col, y - 18, 20, 'rgba(255,255,255,0.9)', st.align);
      const bw = 440;
      const bx = right ? col - bw : col;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.roundRect(bx, y - 4, bw, 20, 10);
      ctx.fill();
      const grow = clamp01((since - 0.35 - i * 0.08) / 0.4);
      const fw = Math.max(0.001, bw * v * grow);
      ctx.fillStyle = st.color;
      ctx.beginPath();
      ctx.roundRect(right ? bx + bw - fw : bx, y - 4, fw, 20, 10);
      ctx.fill();
    });
    // Its hide and its trait, in a line each.
    const lineY = st.titleY + 66 + rows.length * 46 + 6;
    const appear = clamp01((since - 0.75) / 0.3);
    if (bl.cs.length === 1) {
      const c = bl.cs[0];
      const hide = `🛡 ${hideText(c)}`;
      const trait = `★ ${TRAITS[c.trait].name}: ${TRAITS[c.trait].text}`;
      textOutlined(ctx, hide, col, lineY, fitText(ctx, hide, 24, 470), 'rgba(255,255,255,0.92)', st.align, appear);
      textOutlined(ctx, trait, col, lineY + 34, fitText(ctx, trait, 24, 470), '#b6ff6a', st.align, appear);
    } else
      bl.cs.forEach((c, i) => {
        const trait = `★ ${nameOf(c)}: ${TRAITS[c.trait].name}`;
        textOutlined(ctx, trait, col, lineY + i * 34, fitText(ctx, trait, 24, 470), '#b6ff6a', st.align, appear);
      });
    ctx.restore();
  });
  if (sl.slam < 0) return;
  const a = 1 - sl.exit;
  const pop = clamp01(sl.slam / 0.12);
  textOutlined(ctx, 'VS', 540, VS_SLAM_Y, 210 * (1 + 1.4 * (1 - pop) ** 2), theme.accent, 'center', a * Math.min(1, sl.slam / 0.05));
  const ask = s.bouts[s.bout].title ? `${s.bouts[s.bout].title} 👇` : s.mode === 'horde' ? 'HOW MANY? 👇' : 'WHO WINS? 👇';
  if (sl.slam > 0.25) textOutlined(ctx, ask, 540, VS_SLAM_Y + 125, 40, '#ffffff', 'center', a * clamp01((sl.slam - 0.25) / 0.2));
  const flash = 0.45 * Math.exp(-sl.slam * 9);
  if (flash > 0.01) {
    ctx.fillStyle = `rgba(255,255,255,${flash.toFixed(3)})`;
    ctx.fillRect(0, 0, 1080, 1920);
  }
}

function drawReplayChrome(ctx: Ctx2D, s: State, theme: Theme) {
  const u = (s.t - s.replayAt!) / REPLAY_S;
  const inOut = Math.min(1, u / 0.06, (1 - u) / 0.06);
  const bar = 150 * inOut;
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(0, 0, 1080, bar + 150);
  ctx.fillRect(0, 1920 - bar - 110, 1080, bar + 110);
  ctx.save();
  ctx.globalAlpha = inOut;
  if (Math.floor((s.t - s.replayAt!) * 2.5) % 2 === 0) {
    ctx.fillStyle = '#ff3b3b';
    ctx.beginPath();
    ctx.arc(80, PANEL_Y, 16, 0, Math.PI * 2);
    ctx.fill();
  }
  textOutlined(ctx, 'REPLAY', 112, PANEL_Y, 48, '#ffffff', 'left');
  textOutlined(ctx, s.mode === 'horde' ? 'THE DECIDING MOMENT' : s.format === 'tournament' ? 'THE WINNING BLOW' : 'THE KNOCKOUT BLOW', 112, PANEL_Y + 50, 26, theme.accent, 'left');
  ctx.restore();
}

function winnerText(s: State): { big: string; small: string } {
  const sides = sidesOf(s);
  const won = sides[s.winner] ?? sides[0];
  const lost = sides[1 - s.winner] ?? sides[1];
  if (s.format === 'tournament') return { big: `🏆 ${nameOf(won[0]).toUpperCase()} IS CHAMPION!`, small: `BEAT THE ${nameOf(lost[0]).toUpperCase()} IN THE FINAL` };
  if (s.format === 'gauntlet') {
    const { beaten } = cardResult(s);
    const ch = s.entrants[0];
    if (s.winner === 0) return { big: `${ch.icon} ${nameOf(ch).toUpperCase()} BEAT THEM ALL!`, small: `UNDEFEATED · ${beaten} FOR ${s.bouts.length}` };
    return { big: `${s.b.icon} ${nameOf(s.b).toUpperCase()} ENDS THE RUN!`, small: `THE ${nameOf(ch).toUpperCase()} BEAT ${beaten} OF ${s.bouts.length}` };
  }
  if (s.mode === 'team') return { big: `${sideIcons(won)} ${sideName(won).toUpperCase()} WIN!`, small: 'TEAM K.O.' };
  if (s.mode === 'duel') {
    const w = s.winner === 0 ? s.a : s.b;
    return { big: `${w.icon} ${nameOf(w).toUpperCase()} WINS!`, small: s.p.poundForPound ? 'POUND FOR POUND' : 'K.O.' };
  }
  if (s.winner === 1) return { big: `IT TOOK ${s.sent}!`, small: `${s.sent} ${s.b.plural.toUpperCase()} vs 1 ${nameOf(s.a).toUpperCase()}` };
  return { big: `${s.a.icon} ${nameOf(s.a).toUpperCase()} SURVIVES!`, small: `EVEN ${s.sent} ${s.b.plural.toUpperCase()} WEREN'T ENOUGH` };
}

/** After a fight that isn't the last: who goes through. */
function boutText(s: State): { big: string; small: string } {
  const w = s.winner === 0 ? s.a : s.b;
  if (s.format === 'tournament') return { big: `${w.icon} ${nameOf(w).toUpperCase()} ADVANCES!`, small: s.bout === 0 ? 'THROUGH TO THE FINAL' : 'THE FINAL IS SET' };
  const { beaten } = cardResult(s);
  return { big: `${w.icon} ${nameOf(w).toUpperCase()} MOVES ON!`, small: `${beaten} DOWN · ${s.bouts.length - beaten} TO GO` };
}

export const whoWouldWin: Template<WhoWouldWinParams, State> = {
  id: 'who-would-win',
  name: 'Who Would Win',
  family: 'race',
  category: 'battles',
  description:
    '3D low-poly creature battles in a colosseum. Duel: one on one, from a VS card (stats, hide, trait) to a knockout and its replay. Horde: how many of a smaller kind it takes to beat a big one (how many wolves to beat a bull?). Teams: two on two. Tournament: four fighters, two semi-finals and a final (any fight can play as fast-forwarded highlights). Gauntlet: one challenger against a line of ever tougher opponents, full health each fight, until it loses. Pound for pound: the smaller fighter grows to the bigger one\'s weight. 26 fighters: real animals (lion, tiger, grizzly, gorilla, crocodile, rhino, elephant, bull, horse, wolf and more), mythical creatures (dragon, griffin, unicorn, minotaur, troll, giant spider) and human fighters (swordsman, king, brawler, viking). Blows physically land and leave stylized wounds (no blood); injuries change the fight (limping, dazed, winded, a torn wing grounds a flier); fighters lock horns, grapple and get knocked down. The fight decides the winner: favourites usually win, not always. fightLength sets the typical fight length (video ≈ fightLength + 12 s).',
  schema: whoWouldWinSchema,
  substeps: 2,
  glowScale: 0.12,
  searchBudget: (p) => (p.mode === 'tournament' || p.mode === 'gauntlet' ? 60 : 300),
  maxSeconds: (p) => (p.mode === 'tournament' ? 300 : p.mode === 'gauntlet' ? 80 * p.gauntletSize : 90),
  lengthParam: { param: 'fightLength', offsetS: 12 },
  defaultCopy: {
    hook: '{hookText}',
    cta: '{ctaText}',
  },
  nudges: ['Who wins? 👇', 'Pick a side 👇', 'Call it before the bell 👇', 'Guess the number 👇', 'Who are you backing? 👇', 'Lock in your pick 👇'],

  init({ params: p, rng, fxRng, visual, melody }) {
    const { bouts, entrants } = makeCard(p, rng);
    const s: State = {
      p,
      rng,
      fxRng,
      visual,
      format: p.mode,
      mode: p.mode === 'horde' || p.mode === 'team' ? p.mode : 'duel',
      bouts,
      bout: 0,
      boutId: 0,
      entrants,
      a: bouts[0].left[0],
      b: bouts[0].right[0],
      mates: [],
      w: null as unknown as World,
      nextAt: null,
      cardSaid: false,
      hl: { acc: 0, holdUntil: 0, fast: false },
      t: 0,
      phase: 'vs',
      phaseAt: 0,
      vsStage: 0,
      beats: 0,
      freezeUntil: 0,
      slow: 1,
      slowTarget: 1,
      slowHoldUntil: 0,
      threatUntil: 0,
      threatCooldownUntil: 0,
      focusX: 0,
      focusY: 0,
      cam: { x: 0, y: 0, span: 9 },
      shake: 0,
      popups: [],
      callouts: [],
      melody,
      mus: { stepAt: 0, idx: 0, eighthAt: 0, e8: 0, root: Math.min(...melody.steps[0]) },
      hits: [],
      dust: [],
      track: [],
      winner: -1,
      sent: 0,
      koWho: -1,
      koBy: -1,
      finishAt: -1,
      finishSimT: -1,
      finishX: 0,
      finishY: 0,
      replayAt: null,
      endAt: null,
    };
    startBout(s, 0, 0);
    return s;
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    const { p } = s;
    // The arena's room tone: a bed re-struck every 4 s (each one overlaps the next).
    if (t === 0 || Math.floor((t + dt) / 4) > Math.floor(t / 4)) emit({ type: 'crowd' });
    if (p.music === 'background') runMusic(s, t, dt, emit);
    // A knockout that isn't the last: on to the next fight's card.
    if (s.nextAt !== null && t >= s.nextAt) nextBout(s, t);
    const w = s.w;
    if (s.phase === 'card') {
      if (!s.cardSaid) {
        s.cardSaid = true;
        emit({ type: 'card', n: s.bout });
      }
      if (t - s.phaseAt >= CARD_S) {
        s.phase = 'vs';
        s.phaseAt = t;
      }
    }
    if (s.phase === 'vs') {
      if (s.vsStage === 0) {
        s.vsStage = 1;
        emit({ type: 'vs' });
      }
      if (s.vsStage === 1 && t - s.phaseAt >= VS_SLAM) {
        s.vsStage = 2;
        emit({ type: 'vsSlam' });
        if (s.visual) s.shake = 20;
      }
      if (t - s.phaseAt >= VS_S) {
        s.phase = 'count';
        s.phaseAt = t;
      }
    }
    if (s.phase === 'count') {
      const due = Math.min(3, Math.floor((t - s.phaseAt) / BEAT_S) + 1);
      while (s.beats < due) {
        s.beats++;
        emit({ type: 'count', n: 4 - s.beats });
      }
      if (t - s.phaseAt >= COUNT_S) {
        s.phase = 'fight';
        s.phaseAt = t;
        emit({ type: 'fight' });
        if (s.visual) s.shake = 12;
      }
    }

    // Instant replay: the hits' sounds again as the replay reaches them.
    if (s.replayAt !== null && s.endAt !== null && t >= s.replayAt && t < s.endAt) {
      const rt0 = replayTime(s, t);
      const rt1 = replayTime(s, t + dt);
      if (t - s.replayAt < dt) emit({ type: 'replay' });
      for (const h of s.hits) if (h.simT > rt0 && h.simT <= rt1) emit({ type: 'replayHit', sound: h.sound, power: h.power, mass: h.mass, x: Math.round(h.x * 10) / 10 });
      if (s.finishSimT > rt0 && s.finishSimT <= rt1) emit({ type: 'replayKo', x: Math.round(s.finishX * 10) / 10 });
    }

    // Time scale: frozen on big hits, slowed for a finishing blow and the knockout.
    if (s.slowHoldUntil > t || s.threatUntil > t) s.slowTarget = SLOW;
    else s.slowTarget = 1;
    s.slow += (s.slowTarget - s.slow) * (1 - dm.exp(-dt * 12));
    const live = s.phase === 'fight';
    const scale = t < s.freezeUntil ? 0 : s.phase === 'over' ? s.slow : live ? s.slow : 1;
    const sdt = dt * scale;
    // Highlights: the quiet stretches fast-forward (whole sim steps, the same as playing it in full until
    // slow motion lands at a different moment); big moments, slow motion and the closing stretch (someone
    // nearly beaten) play at full speed.
    let reps = 1;
    if (live && s.bouts[s.bout].highlights) {
      const close = w.fighters.some((f) => f.alive && f.hp < f.maxHp * 0.3);
      s.hl.fast = !close && t >= s.hl.holdUntil && s.slowTarget === 1 && s.slow > 0.95;
      s.hl.acc += s.hl.fast ? HL_SPEED : 1;
      reps = Math.floor(s.hl.acc);
      s.hl.acc -= reps;
    } else s.hl.fast = false;
    if (sdt > 0) {
      if (live) {
        const onEvent: Parameters<typeof stepWorld>[2] = (e) => {
          // (Footfalls are dropped while fast-forwarding: too many at once.)
          if (s.hl.fast && e.type === 'step') return;
          // Old-style music: a melody note on each blow.
          if (p.music === 'hits') e.mm = 1;
          emit(e);
          if (
            (e.type === 'hit' && ((e.power as number) > 1.2 || e.crit)) ||
            ['knockdown', 'grab', 'finisher', 'clinch', 'ko', 'fury', 'injury'].includes(e.type) ||
            (e.type === 'shove' && e.down)
          )
            s.hl.holdUntil = t + HL_HOLD_S;
          // Teams: one of a pair down (the other fights on).
          if (e.type === 'ko' && s.mode === 'team' && s.visual && w.fighters.some((o) => o.side === e.side && o.alive)) {
            s.callouts.push({ t, who: e.who as number, text: 'OUT!', color: '#ff5a64' });
            if (s.callouts.length > 6) s.callouts.shift();
          }
          const key =
            e.type === 'grab' || e.type === 'shakeOff'
              ? `${e.type}:${e.kind}`
              : e.type === 'injury'
                ? `injury:${e.part}`
                : e.type === 'clinch'
                  ? `clinch:${e.horns ? 'horns' : 'grapple'}`
                  : e.type === 'shove'
                    ? `shove:${e.down ? 'down' : 'aside'}`
                    : e.type;
          const call =
            e.type === 'trait' ? { text: e.text as string, color: '#b6ff6a' } : e.type === 'finisher' ? { text: `${(e.name as string).toUpperCase()}!`, color: '#ff9a2e' } : e.type === 'fury' ? { text: 'FURY!', color: '#ff9a2e' } : CALLOUTS[key];
          // (The swarm's injuries and falls aren't called out: there are too many of them.)
          if (call && s.visual && !e.swarm) {
            s.callouts.push({ t, who: (e.type === 'shove' || e.type === 'block' ? e.b : (e.a ?? e.who)) as number, text: call.text, color: call.color });
            if (s.callouts.length > 6) s.callouts.shift();
          }
          // A finisher coming: slow motion on it, on its target.
          if (e.type === 'finisher' && p.slowMotion) {
            const o = w.fighters[e.target as number];
            s.threatUntil = t + 0.9;
            s.threatCooldownUntil = t + 2;
            if (o) {
              s.focusX = (o.x + w.fighters[e.who as number].x) / 2;
              s.focusY = (o.y + w.fighters[e.who as number].y) / 2;
            }
          }
          if (e.type === 'quake' && s.visual) {
            s.dust.push({ simT: w.simT, x: e.x as number, y: e.y as number, size: (e.radius as number) * 1.2 });
            s.shake = Math.min(34, s.shake + 22);
          }
          // A grapple taking hold: a beat of slow motion on it.
          if (e.type === 'grab' && p.slowMotion && t >= s.threatCooldownUntil) {
            const o = w.fighters[e.b as number];
            s.threatUntil = t + 0.55;
            s.threatCooldownUntil = t + 2;
            s.focusX = o.x;
            s.focusY = o.y;
          }
          if ((e.type === 'knockdown' || e.type === 'ko' || (e.type === 'shove' && e.down)) && s.visual) {
            const o = w.fighters[(e.type === 'shove' ? e.b : e.who) as number];
            if (o) {
              s.dust.push({ simT: w.simT + (e.type === 'ko' ? 0.35 : 0.2), x: o.x, y: o.y, size: Math.sqrt(o.def.height * (o.def.front ?? o.def.radius)) * 1.6 });
              if (s.dust.length > 16) s.dust.shift();
            }
          }
          if (e.type === 'hit') {
            const power = e.power as number;
            if (power > 1.2 || e.crit) s.freezeUntil = Math.max(s.freezeUntil, t + p.hitFreeze * Math.min(1.5, 0.5 + power / 3));
            const o = w.fighters[e.b as number];
            s.hits.push({ simT: w.simT, sound: e.sound as string, power, mass: e.mass as number, x: o.x, y: o.y, h: o.def.height * 0.6 + o.hover, crit: e.crit === 1, who: o.idx, wound: e.wound as number });
            if (s.hits.length > 40) s.hits.shift();
            if (s.visual) {
              s.shake = Math.min(30, s.shake + Math.min(18, power * 6) * ((e.mass as number) > 300 ? 1.4 : 0.8));
              if (p.damageNumbers) {
                s.popups.push({ t, x: o.x, y: o.y, h: o.def.height * 1.1 + o.hover * 0.6, text: `${Math.max(1, Math.round((e.dmg as number) / w.hpScale))}`, crit: e.crit === 1 });
                if (s.popups.length > 24) s.popups.shift();
              }
            }
          }
        };
        for (let r = 0; r < reps && w.winner < 0; r++) stepWorld(w, sdt, onEvent);
        if (w.winner >= 0) endMatch(s, t, emit);
        else if (p.slowMotion && t >= s.threatCooldownUntil) {
          const doomed = finisherIncoming(w);
          if (doomed) {
            s.threatUntil = t + 0.9;
            s.threatCooldownUntil = t + 3;
            s.focusX = doomed.x;
            s.focusY = doomed.y;
            emit({ type: 'threat' });
          }
        }
      } else idleWorld(w, sdt);
    }

    // Camera: frame everyone standing, closer in slow motion. In a horde the fallen of the swarm drop
    // out of the shot (the big one stays in it); a duel keeps both in it to the end.
    const standing = w.fighters.filter((f) => f.alive || f.side === 0 || s.mode !== 'horde' || w.simT - f.diedAt < 1.5);
    const pool = standing.length ? standing : w.fighters;
    let cx = 0;
    let cy = 0;
    let wsum = 0;
    for (const f of pool) {
      // In a horde the big one anchors the shot.
      const k = s.mode === 'horde' && f.side === 0 ? 3 : 1;
      cx += f.x * k;
      cy += f.y * k;
      wsum += k;
    }
    cx /= wsum;
    cy /= wsum;
    let span = 0;
    for (const f of pool) span = Math.max(span, dm.hypot(f.x - cx, f.y - cy) + f.def.radius + 1.2);
    span = Math.max(4, Math.min(ARENA_R * 2.2, span * 1.75));
    const slowmo = s.slowTarget < 1 || s.slow < 0.9;
    if (slowmo) {
      cx = 0.4 * cx + 0.6 * s.focusX;
      cy = 0.4 * cy + 0.6 * s.focusY;
      span *= 0.7;
    }
    if (s.phase === 'vs') span = 6.5;
    if (s.phase === 'card') span = Math.max(span, 9);
    const k = 1 - dm.exp(-dt * (s.phase === 'count' ? 3 : 4));
    s.cam.x += (cx - s.cam.x) * k;
    s.cam.y += (cy - s.cam.y) * k;
    s.cam.span += (span - s.cam.span) * k;

    if (s.visual) {
      s.shake *= dm.exp(-9 * dt);
      if (s.popups.length && s.t - s.popups[0].t > 1.2) s.popups = s.popups.filter((q) => s.t - q.t <= 1.2);
      if (s.callouts.length && s.t - s.callouts[0].t > 1.4) s.callouts = s.callouts.filter((q) => s.t - q.t <= 1.4);
      if (s.dust.length && w.simT - s.dust[0].simT > 4) s.dust = s.dust.filter((q) => w.simT - q.simT <= 4);
      // Recent history for the replay (only while the fight can still be decided, then just past it).
      const record = sdt > 0 && p.replay && (live || (s.phase === 'over' && w.simT < s.finishSimT + REPLAY_POST_S + 0.1));
      if (record) {
        s.track.push({ simT: w.simT, fighters: w.fighters.map(viewOf) });
        if (s.track[0].simT < w.simT - 4) s.track.splice(0, s.track.findIndex((x) => x.simT >= w.simT - 3));
      }
    } else if (p.replay && sdt > 0 && live) {
      // Headless runs keep a one-entry track so the replay timing (and its sounds) match a visual run.
      s.track = [{ simT: w.simT, fighters: [] }];
    }
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    const done = s.endAt !== null;
    const win = done && s.winner >= 0 ? winnerText(s) : null;
    const sides = sidesOf(s);
    const winner = !done || s.winner < 0 ? '' : s.mode === 'horde' ? (s.winner === 1 ? s.b.plural : nameOf(s.a)) : sideName(sides[s.winner]);
    const [e0, e1, e2, e3] = s.entrants;
    const hook =
      s.format === 'tournament'
        ? `🏆 ${[e0, e1, e2, e3].map((c) => c.icon).join(' ')}: who wins it all?`
        : s.format === 'gauntlet'
          ? `Can a ${nameOf(e0)} beat ${s.bouts.length} in a row?`
          : s.mode === 'team'
            ? `${sideName(sides[0])} vs ${sideName(sides[1])}`
            : s.mode === 'duel'
              ? `${s.p.poundForPound ? 'Pound for pound: ' : ''}${s.a.icon} ${nameOf(s.a)} vs ${nameOf(s.b)} ${s.b.icon}`
              : `How many ${s.b.plural} to beat a ${nameOf(s.a)}?`;
    return {
      a: nameOf(s.a),
      b: nameOf(s.b),
      big: nameOf(s.a),
      swarm: s.b.plural,
      winner,
      count: s.sent,
      beaten: cardResult(s).beaten,
      hookText: hook,
      ctaText: win ? (s.mode === 'horde' ? 'Did you guess right? 👇' : 'Did you call it? 👇') : '',
      outro: s.endAt !== null && s.t >= s.endAt,
    };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.6, y: 0.1 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.24 },
    ];
  },

  render({ ctx, theme }, s) {
    ctx.save();
    if (s.shake > 0.3 && !replaying(s)) ctx.translate(dm.sin(s.t * 97) * s.shake, dm.cos(s.t * 71) * s.shake);
    drawScene(ctx, s, theme);
    ctx.restore();
  },

  renderTop({ ctx, theme }, s) {
    const { fighters } = fightersNow(s);
    const rep = replaying(s);
    if (!rep) drawPanel(ctx, s, theme, fighters);
    if (!rep) drawBoutTag(ctx, s, theme);
    // Teams: a marker over each fighter in its side's colour.
    if (s.mode === 'team' && !rep && (s.phase === 'fight' || s.phase === 'count' || s.phase === 'over')) {
      for (const f of fighters) {
        if (!f.alive) continue;
        const q = projectToScreen(s, f.x, f.y, f.def.height + f.hover + 0.3);
        if (!q) continue;
        ctx.fillStyle = f.side === 0 ? '#4fc3ff' : '#ffb03b';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(q.x - 20, q.y - 26);
        ctx.lineTo(q.x + 20, q.y - 26);
        ctx.lineTo(q.x, q.y);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
      }
    }
    // Horde: small HP bars over the swarm.
    if (s.mode === 'horde' && !rep && s.phase !== 'vs') {
      for (const f of fighters) {
        if (f.side !== 1 || !f.alive) continue;
        const q = projectToScreen(s, f.x, f.y, f.def.height + f.hover + 0.25);
        if (!q) continue;
        hpBar(ctx, q.x - 36, q.y - 6, 72, 10, f.hp / f.maxHp, '#ffb03b', f.flash, false);
      }
    }
    if (s.phase === 'vs' || s.phase === 'count') drawVs(ctx, s, theme);
    if (s.phase === 'card') drawCard(ctx, s, theme);
    // Countdown 3, 2, 1, FIGHT!
    const cy = 1920 * 0.5;
    if (s.phase === 'count' || (s.phase === 'fight' && s.t - s.phaseAt < 0.6)) {
      const since = s.t - s.phaseAt;
      const beat = s.phase === 'count' ? Math.min(2, Math.floor(since / BEAT_S)) : 3;
      const local = s.phase === 'count' ? since - beat * BEAT_S : since;
      const pop = Math.min(1, local / 0.12);
      const fade = s.phase === 'count' ? 1 : Math.max(0, 1 - local / 0.6);
      textOutlined(ctx, beat < 3 ? String(3 - beat) : 'FIGHT!', 540, cy, (beat < 3 ? 200 : 180) * (0.6 + 0.4 * pop), beat < 3 ? '#ffffff' : theme.accent, 'center', fade);
    }
    // Signature moments, called out big over whoever made them (several at once stack up).
    if (!rep) {
      const stack = new Map<number, number>();
      for (const c of s.callouts) {
        const f = fighters.find((x) => x.idx === c.who);
        if (!f) continue;
        const k = stack.get(c.who) ?? 0;
        stack.set(c.who, k + 1);
        const pt = projectToScreen(s, f.x, f.y, f.def.height + f.hover + 0.6);
        if (!pt) continue;
        pt.y -= k * 82;
        const age = s.t - c.t;
        const pop = Math.min(1, age / 0.12);
        const size = fitText(ctx, c.text, 70, 640);
        // Kept whole on screen (measured at full size).
        const half = ctx.measureText(c.text).width / 2 + 40;
        textOutlined(ctx, c.text, Math.max(half, Math.min(1080 - half, pt.x)), pt.y - 40 - 30 * Math.min(1, age / 1.4), size * (0.7 + 0.3 * pop), c.color, 'center', clamp01((1.4 - age) / 0.3));
      }
    }
    // Damage numbers float up off each hit.
    if (s.p.damageNumbers && !rep) {
      for (const q of s.popups) {
        const age = s.t - q.t;
        const pt = projectToScreen(s, q.x, q.y, q.h);
        if (!pt) continue;
        const rise = 90 * Math.min(1, age / 0.6);
        textOutlined(ctx, q.crit ? `${q.text}!` : q.text, pt.x, pt.y - rise, q.crit ? 64 : 46, q.crit ? '#ffd23b' : '#ffffff', 'center', clamp01((1.2 - age) / 0.4) * clamp01(age / 0.05));
      }
    }
    if (rep) drawReplayChrome(ctx, s, theme);
    // Knockout banner, then the winner in the outro.
    if (s.phase === 'over') {
      const age = s.t - s.finishAt;
      if (!rep && (s.replayAt === null || s.t < s.replayAt)) {
        const pop = Math.min(1, age / 0.15);
        textOutlined(ctx, s.mode !== 'horde' ? 'K.O.!' : s.winner === 1 ? 'DOWN!' : 'SURVIVED!', 540, cy - 40, 150 * (0.7 + 0.3 * pop), '#ff5a64', 'center', clamp01((LIVE_TAIL_S + 0.2 - age) / 0.25));
      }
      // Not the last fight: who goes through.
      if (s.nextAt !== null && age > LIVE_TAIL_S) {
        const bt = boutText(s);
        const o = age - LIVE_TAIL_S;
        const pop = Math.min(1, o / 0.15);
        const fade = clamp01((s.nextAt - s.t) / 0.25);
        textOutlined(ctx, bt.big, 540, cy + 40, fitText(ctx, bt.big, 88, 1000) * (0.75 + 0.25 * pop), theme.accent, 'center', clamp01(o / 0.1) * fade);
        textOutlined(ctx, bt.small, 540, cy + 135, fitText(ctx, bt.small, 40, 980), '#ffffff', 'center', clamp01((o - 0.15) / 0.2) * fade);
      }
      const win = s.endAt !== null ? winnerText(s) : null;
      if (win && s.endAt !== null && s.t >= s.endAt) {
        const o = s.t - s.endAt;
        const pop = Math.min(1, o / 0.15);
        textOutlined(ctx, win.big, 540, cy + 120, fitText(ctx, win.big, 96, 1000) * (0.75 + 0.25 * pop), theme.accent, 'center', clamp01(o / 0.1));
        textOutlined(ctx, win.small, 540, cy + 220, fitText(ctx, win.small, 44, 980), '#ffffff', 'center', clamp01((o - 0.15) / 0.2));
      }
    }
  },

  audio(e, { melody, theme, lastNoteT }) {
    type Out = ReturnType<Template['audio']>;
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, (e.x as number) / ARENA_R)) : 0;
    // Old-style music: melody notes on blows (only when the music setting asks for it).
    const note = (vel: number): Out => (e.mm ? melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? vel * 0.45 : vel, voice: theme.voice, pan })) : []);
    // Size → pitch: the heavier, the deeper (0 huge .. 1 tiny).
    const deep = (mass: number) => 1 - clamp01(Math.log(Math.max(5, mass) / 5) / Math.log(260));
    const sfx = (name: string, vel: number, pitch?: number): Out[number] => ({ kind: 'sfx', name: name as never, vel, pitch, pan });
    const call = (name: unknown, pitch: unknown, vel: number): Out => (name ? [sfx(name as string, vel, pitch as number)] : []);
    // A repeatable coin flip per event (calls aren't on every swing).
    const chance = (k: number) => {
      const x = Math.sin((e.t as number) * 12.9898 + ((e.who ?? e.a ?? 0) as number) * 78.233) * 43758.5453;
      return x - Math.floor(x) < k;
    };
    const mass = (e.mass as number) ?? 100;
    switch (e.type) {
      case 'mnote':
        return (e.notes as number[]).map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? 0.13 : 0.3, voice: 'brass' as const, dur: e.dur as number }));
      case 'mbass':
        return [{ kind: 'note', midi: e.midi as number, vel: 0.42, voice: 'bass', dur: e.dur as number }];
      case 'mdrum':
        return [
          ...(e.kick ? [sfx('kick', 0.55)] : []),
          ...(e.snare ? [sfx('snare', 0.38)] : []),
          ...(e.hat ? [sfx('hat', e.open ? 0.16 : 0.12, e.open ? 1 : 0)] : []),
          ...(e.tom ? [sfx('tom', 0.5, e.tp as number)] : []),
        ].map((x) => ({ ...x, pan: 0 }));
      case 'vs':
        return [sfx('swish', 0.55, 0.15), sfx('whoosh', 0.35, 1)].map((x, i) => ({ ...x, pan: i ? 0.5 : -0.5 }));
      case 'card':
        return [sfx('whoosh', 0.5, 0.4), sfx('tom', 0.6, 0.3), sfx('cheer', 0.3)].map((x) => ({ ...x, pan: 0 }));
      case 'bout':
        return [sfx('cheer', 0.7), sfx('tom', 0.5, 0.25), ...call(e.call, e.cp, 0.5)].map((x) => ({ ...x, pan: 0 }));
      case 'vsSlam':
        return [sfx('impact', 0.7, 0.05), sfx('clang', 0.3, 0.2), sfx('cheer', 0.35)].map((x) => ({ ...x, pan: 0 }));
      case 'count':
        return [{ kind: 'sfx', name: 'tom', vel: 0.7, pitch: 0.25 + (3 - (e.n as number)) * 0.15 }];
      case 'fight':
        return [{ kind: 'sfx', name: 'kick', vel: 0.6 }, { kind: 'sfx', name: 'clang', vel: 0.4, pitch: 0.4 }, { kind: 'sfx', name: 'cheer', vel: 0.55 }];
      case 'swing': {
        if (e.breath) return [sfx('flame', 0.8), ...call(e.call, e.cp, 0.55)];
        if (e.weapon === 'club') return [sfx('whoosh', 0.45, 0.15), ...(e.big || chance(0.3) ? call(e.call, e.cp, 0.5) : [])];
        const sword = e.weapon === 'sword' || e.weapon === 'axe';
        return [sfx('swish', sword ? 0.5 : 0.3 + 0.2 * (1 - deep(mass)), sword ? 0.8 : deep(mass)), ...(e.big || chance(0.3) ? call(e.call, e.cp, e.big ? 0.6 : 0.4) : [])];
      }
      case 'charge':
        return [...call(e.call, e.cp, 0.65), sfx(e.feet === 'hoof' ? 'hoof' : 'step', 0.4, deep(mass))];
      case 'step':
        return e.feet === 'hoof' ? [sfx('hoof', 0.12 + 0.18 * (1 - deep(mass)), deep(mass))] : [sfx('step', 0.15 + 0.25 * (1 - deep(mass)), e.feet === 'foot' ? 0.7 : deep(mass))];
      case 'dodge':
        return [sfx('swish', 0.4, 0.9), sfx('step', 0.25, 0.7)];
      case 'miss':
        return e.dodged ? [sfx('swish', 0.3, 0.95)] : [];
      case 'hit': {
        const v = clamp01((e.power as number) / 2.5);
        const sound = e.sound as string;
        const out: Out = [sfx('impact', 0.3 + 0.45 * v * (1 - deep(mass) * 0.5), deep(mass) * 0.8)];
        if (sound === 'bite') out.push(sfx('crunch', 0.45 + 0.3 * v, deep(mass)));
        else if (sound === 'slash') out.push(...(e.weapon === 'sword' || e.weapon === 'axe' ? [sfx('slash', 0.4, e.weapon === 'axe' ? 0.45 : 0.7), sfx('clang', 0.3 + 0.2 * v, e.weapon === 'axe' ? 0.5 : 0.75)] : [sfx('slash', 0.5 + 0.2 * v, 0.4)]));
        else if (e.clip === 'bash') out.push(sfx('shield', 0.6 + 0.2 * v, 0.4));
        else if (e.clip === 'club' || e.clip === 'stomp' || e.clip === 'pummel') out.push(sfx('boom', 0.35 + 0.25 * v, 0.1), sfx('smack', 0.35, 0.3));
        else if (sound === 'hoof') out.push(sfx('hoof', 0.45, 0.2), sfx('smack', 0.35, 0.4));
        else out.push(sfx('smack', 0.35 + 0.2 * v, 0.4));
        if (e.crit) out.push(sfx('impact', 0.45, 0.05), sfx('gasp', 0.4));
        // The one hit cries out now and then (always on a big blow).
        if ((e.power as number) > 1.5 || chance(0.25)) out.push(...call(e.vcall, Math.min(1, (e.vcp as number) + 0.15), 0.35));
        return [...out, ...(e.t - lastNoteT >= 0.08 ? note(0.45 + 0.35 * v) : [])];
      }
      case 'burn':
        return [];
      case 'spawn':
        return [sfx('step', 0.3, 0.6), ...(chance(0.5) ? call(e.call, e.cp, 0.3) : [])];
      case 'ko':
        return e.side === 1 && e.number
          ? [sfx('bodyfall', 0.45, deep(mass)), ...call(e.call, Math.min(1, (e.cp as number) + 0.25), 0.3), ...(e.mm ? [{ kind: 'note' as const, midi: 60 + Math.min(24, e.number as number), vel: 0.45, voice: 'bell' as const, dur: 0.8 }] : [])]
          : [sfx('bodyfall', 0.9, deep(mass)), sfx('impact', 0.55, 0.05), ...call(e.call, e.cp, 0.45), sfx('gasp', 0.5)];
      case 'crowd':
        return [{ kind: 'sfx', name: 'ambience', vel: 0.55, pitch: 0.4 }];
      case 'roar':
        // (A gorilla drums its chest as it roars.)
        return [...(e.clip === 'beat' ? [sfx('chestbeat', 0.85, 0.4)] : []), ...call(e.call || 'roar', e.cp, 0.9), sfx('cheer', 0.2)];
      case 'grab':
        return [sfx('crunch', 0.7, 0.2), sfx('impact', 0.55, 0.15), ...call(e.call, e.cp, 0.6), ...call(e.vcall, Math.min(1, (e.vcp as number) + 0.15), 0.35), sfx('gasp', 0.45)];
      case 'maul': {
        if (e.kind === 'roll') return [sfx('swish', 0.3, 0.15), sfx('step', 0.35, 0.3), ...note(0.35)];
        const beat = Math.floor((e.t as number) * 4) % 3;
        return [beat === 0 ? sfx('crunch', 0.35, 0.3) : sfx('smack', 0.3, 0.3), ...(beat === 2 ? [sfx('growl', 0.35, 0.3)] : []), ...note(0.4)];
      }
      case 'shakeOff':
        return [sfx('swish', 0.5, 0.3), sfx('impact', 0.4, 0.3), sfx('bodyfall', 0.35, 0.5), sfx('cheer', 0.35)];
      case 'bluff':
        return [sfx('step', 0.45, 0.2), sfx('step', 0.4, 0.25), ...call(e.call, e.cp, 0.6)];
      case 'flinch':
        return [];
      case 'evade':
        return [sfx('swish', 0.25, 0.85)];
      case 'prep':
        return [sfx('step', 0.35, 0.2), sfx('hoof', 0.25, 0.25), ...call(e.call, Math.max(0, (e.cp as number) - 0.1), 0.35)];
      case 'clinch':
        return [sfx(e.horns ? 'knock' : 'impact', e.horns ? 0.9 : 0.5, 0.1), sfx('smack', 0.5, 0.2), ...call(e.call, e.cp, 0.5), ...call(e.vcall, e.vcp, 0.35), sfx('cheer', 0.3)];
      case 'grind':
        return e.horns ? [sfx('smack', 0.22, 0.25)] : [sfx(chance(0.5) ? 'crunch' : 'growl', 0.22, 0.3)];
      case 'shove':
        return [sfx('impact', 0.5, 0.15), sfx('swish', 0.4, 0.3), ...(e.down ? [sfx('bodyfall', 0.7, deep(mass))] : []), ...call(e.call, e.cp, 0.45), sfx('cheer', 0.4)];
      case 'block':
        return [sfx('shield', 0.75, 0.5), sfx('impact', 0.3, 0.3)];
      case 'trait':
        return [...call(e.call, e.cp, 0.55), sfx('cheer', 0.35)];
      case 'fury':
        return [sfx('whoosh', 0.35, 0.2), ...call(e.call, e.cp, 0.45)];
      case 'finisher':
        return [sfx('whoosh', 0.6, 0.1), sfx('boom', 0.35, 0.2), ...call(e.call, e.cp, 0.85), sfx('gasp', 0.45), sfx('cheer', 0.3)];
      case 'quake':
        return [sfx('boom', 0.9, 0.05), sfx('impact', 0.6, 0.05), sfx('sand', 0.5, 0.3)];
      case 'knockdown':
        return [sfx('bodyfall', e.swarm ? 0.4 : 0.75, deep(mass)), sfx('impact', 0.4, 0.1), ...call(e.call, Math.min(1, (e.cp as number) + 0.2), 0.4), ...(e.swarm ? [] : [sfx('gasp', 0.4)])];
      case 'injury':
        // A yelp (higher than its usual call), and the crowd feels it.
        return [...call(e.call, Math.min(1, (e.cp as number) + 0.3), e.swarm ? 0.25 : 0.5), ...(e.swarm ? [] : [sfx('gasp', 0.35)])];
      case 'threat':
        return [sfx('gasp', 0.3)];
      case 'win':
        return [
          { kind: 'sfx', name: 'cheer', vel: 0.85 },
          { kind: 'sfx', name: 'tom', vel: 0.6, pitch: 0.2 },
          ...call(e.call, e.cp, 0.55),
          ...(e.bells
            ? melody.peek().flatMap((midi) => [
                { kind: 'note' as const, midi, vel: 0.8, voice: 'bell' as const, dur: 2.5 },
                { kind: 'note' as const, midi: midi + 12, vel: 0.5, voice: 'bell' as const, dur: 2.5 },
              ])
            : []),
        ];
      case 'replay':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.6, pitch: 0.5 }, { kind: 'sfx', name: 'tick', vel: 0.6, pitch: 0.8 }];
      case 'replayHit':
        return [sfx('impact', 0.5 + 0.3 * clamp01((e.power as number) / 2.5), 0.1), ...((e.power as number) > 1.2 ? [sfx('crunch', 0.3, 0.2)] : [])];
      case 'replayKo':
        return [sfx('bodyfall', 0.9, 0.1), sfx('impact', 0.6, 0.05)];
    }
    return [];
  },

  /** Who won (a duel), or how many it took (a horde): tallied over a seed search in the Playground. */
  outcome(events) {
    const win = events.find((e) => e.type === 'win');
    if (!win) return null;
    const a = creatureById(win.a as string);
    const b = creatureById(win.b as string);
    const names = (ids: unknown) => String(ids).split('+').map((id) => creatureById(id).label).join(' & ');
    if (win.format === 'tournament') return `${names(win.champ)} champion`;
    if (win.format === 'gauntlet') return win.side === 0 ? `${names(win.left)} beats all ${win.total}` : `beat ${win.beaten} of ${win.total}`;
    if (win.mode === 'team') return `${names(win.side === 0 ? win.left : win.right)} win`;
    if (win.mode === 'duel') return `${(win.side === 0 ? a : b).label} wins`;
    if (win.side === 0) return `${a.label} survives ${win.sent}`;
    // (Bands of three, so the spread reads at a glance.)
    const lo = Math.floor(((win.sent as number) - 1) / 3) * 3 + 1;
    return `took ${lo}–${lo + 2} ${b.plural.toLowerCase()}`;
  },

  /**
   * Duel: prefer fights that run to length, stay busy, end close (the winner nearly beaten too), with
   * a comeback or lead changes. Horde: the big one should take plenty down before it falls, and the
   * answer shouldn't be trivially small.
   */
  score(events, { durationS, targetS, timedOut }): DramaScore {
    // Length matters less than the fight: anything from a bit under the target to about twice it (or 45 s)
    // is as good, so big fights can run long.
    const lo = targetS * 0.75;
    const hi = Math.max(targetS * 1.9, 45);
    const win = events.find((e) => e.type === 'win');
    // (A tournament or gauntlet runs as long as its fights do.)
    const several = win?.format === 'tournament' || win?.format === 'gauntlet';
    const durFit = several ? 1 : durationS < lo ? gaussFit(durationS, lo, targetS * 0.2) : durationS > hi ? gaussFit(durationS, hi, targetS * 0.25) : 1;
    if (timedOut || !win) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no winner'] };
    // The last fight on the card (the only one, unless it's a tournament or gauntlet).
    const fightAt = events.filter((e) => e.type === 'fight').at(-1)?.t ?? 0;
    const hits = events.filter((e) => e.type === 'hit' && e.t >= fightAt);
    // Longest stretch without a landed blow.
    let lull = 0;
    const times = [fightAt, ...hits.map((h) => h.t), win.t];
    for (let i = 1; i < times.length; i++) lull = Math.max(lull, times[i] - times[i - 1]);
    const lullFit = 1 - clamp01((lull - 2.5) / 4);
    const fightS = Math.max(1, win.t - fightAt);
    const hitFit = gaussFit(hits.length / fightS, 0.9, 0.6);
    const crits = hits.filter((h) => h.crit).length;
    if (win.mode !== 'horde') {
      const close = clamp01(1 - (win.hpLeft as number) / 0.6);
      // HP lead over time: who was ahead after each hit (fractions of their own max; a pair's averaged).
      const hp = [1, 1];
      const each = new Map<number, number>();
      const per = win.mode === 'team' ? 2 : 1;
      let comeback = 0;
      let leadChanges = 0;
      let lead = 0;
      const winner = win.side as number;
      for (const h of hits) {
        const side = (h.bs as number) ?? ((h.b as number) === 0 ? 0 : 1);
        each.set(h.b as number, h.hp as number);
        const mine = [...each].filter(([idx]) => (per === 1 ? (idx === 0 ? 0 : 1) : idx < 2 ? 0 : 1) === side);
        hp[side] = (mine.reduce((x, [, v]) => x + v, 0) + (per - mine.length)) / per;
        comeback = Math.max(comeback, clamp01((hp[1 - winner] - hp[winner]) / 0.35));
        const now = hp[0] > hp[1] + 0.05 ? 1 : hp[1] > hp[0] + 0.05 ? -1 : lead;
        if (now !== lead && lead !== 0) leadChanges++;
        lead = now;
      }
      const swings = clamp01(leadChanges / 2);
      // Signature moments (grapples, shake-offs, roars) make a fight.
      const moments = clamp01(events.filter((e) => ['grab', 'shakeOff', 'bluff', 'knockdown', 'injury', 'shove', 'trait', 'block', 'finisher'].includes(e.type)).length / 3);
      let drama = 0.27 * close + 0.18 * comeback + 0.1 * swings + 0.13 * lullFit + 0.13 * hitFit + 0.09 * clamp01(crits / 2) + 0.1 * moments;
      // A gauntlet is better the further the challenger gets (and best decided at the very end).
      const run = win.format === 'gauntlet' ? clamp01((win.beaten as number) / Math.max(1, (win.total as number) - 1)) : 0;
      if (win.format === 'gauntlet') drama = 0.6 * drama + 0.4 * run;
      return {
        total: durFit * (0.2 + 0.8 * drama),
        parts: { durFit, close, comeback, swings, lullFit, hitFit, ...(win.format === 'gauntlet' ? { run } : {}) },
        notes: [`${win.left} vs ${win.right}: ${winner === 0 ? win.left : win.right} wins with ${Math.round((win.hpLeft as number) * 100)}% HP`, `${hits.length} hits, ${crits} crits, ${leadChanges} lead changes`],
      };
    }
    const kos = events.filter((e) => e.type === 'ko' && e.side === 1).length;
    const sent = win.sent as number;
    const max = win.max as number;
    // The big one should drop a good few before going down (or barely survive the lot).
    const fightBack = clamp01(kos / 5);
    const answer = win.side === 1 ? clamp01((sent - 3) / 6) * (1 - clamp01((sent - 0.85 * max) / (0.15 * max))) : clamp01(1 - (win.hpLeft as number) / 0.5);
    const drama = 0.3 * fightBack + 0.3 * answer + 0.2 * lullFit + 0.2 * hitFit;
    return {
      total: durFit * (0.2 + 0.8 * drama),
      parts: { durFit, fightBack, answer, lullFit, hitFit },
      notes: [`${win.side === 1 ? `took ${sent} ${win.b}` : `${win.a} survived ${sent}`}`, `${kos} of the swarm down`, `${hits.length} hits`],
    };
  },
};

export { CREATURES };
