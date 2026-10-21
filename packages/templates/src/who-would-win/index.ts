import { z } from 'zod';
import { FONT_FAMILY, type Ctx2D, type DramaScore, type Melody, type Rng, type SimEvent, type Template, type Theme } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { clamp01, gaussFit } from '../scoring';
import { MAX_SWARM_DEFAULT, hpScaleFor } from './balance';
import { CREATURES, CREATURE_IDS, DUELS, DUEL_IDS, HORDES, HORDE_IDS, creatureById, matchupId, statBars, type CreatureDef } from './roster';
import { ARENA_R, finisherIncoming, idleWorld, makeWorld, stepWorld, type Fighter, type FighterState, type Grab, type World } from './sim';
import { drawScene, projectToScreen } from './view3d';
import { BEAT_S, VS_S, VS_SLAM, VS_SLAM_Y, VS_STRIPS, vsSlide } from './vs';

export const whoWouldWinSchema = z.object({
  mode: z.enum(['duel', 'horde']).default('duel').meta({ title: 'Mode (one on one, or how many of a small kind it takes to beat a big one)' }),
  matchup: z.enum(['random', ...DUEL_IDS, ...HORDE_IDS, 'custom']).default('random').meta({ title: 'Matchup (curated; custom uses the two fighters below)' }),
  fighterA: z.enum(['random', ...CREATURE_IDS]).default('random').meta({ title: 'Fighter A (custom matchup; the big one in a horde)' }),
  fighterB: z.enum(['random', ...CREATURE_IDS]).default('random').meta({ title: 'Fighter B (custom matchup; the swarm in a horde)' }),
  maxSwarm: z.number().int().min(10).max(60).default(MAX_SWARM_DEFAULT).meta({ title: 'Horde: most the swarm can send', step: 1 }),
  fightLength: z.number().min(6).max(30).default(16).meta({ title: 'Typical fight length, s (video ≈ this + 12 s)', step: 1 }),
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

type Phase = 'vs' | 'count' | 'fight' | 'over';

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
  dodgeDir: 1 | -1;
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
  mode: 'duel' | 'horde';
  a: CreatureDef;
  b: CreatureDef;
  w: World;
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
  hits: { simT: number; sound: string; power: number; mass: number; x: number; y: number; h: number; crit: boolean }[];
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
  dodgeDir: f.dodgeDir,
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
};

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

function resolveFighters(p: WhoWouldWinParams, rng: Rng): [CreatureDef, CreatureDef] {
  const list: readonly (readonly [string, string])[] = p.mode === 'duel' ? DUELS : HORDES;
  const ids = p.mode === 'duel' ? DUEL_IDS : HORDE_IDS;
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

function endMatch(s: State, t: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  const { p, w } = s;
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
  if (p.replay && s.track.length) {
    s.replayAt = t + LIVE_TAIL_S;
    s.endAt = s.replayAt + REPLAY_S;
  } else s.endAt = t + (p.slowMotion ? 1.4 : 0.6);
  const champs = lastStanding(s, w.winner);
  const hpLeft = champs.length ? Math.max(...champs.map((f) => f.hp / f.maxHp)) : 0;
  const champ = champs[0]?.def;
  emit({ type: 'win', side: w.winner, mode: s.mode, sent: s.sent, hpLeft: Math.round(hpLeft * 1000) / 1000, a: s.a.id, b: s.b.id, max: p.maxSwarm, call: champ?.voice?.call ?? '', cp: champ?.voice?.pitch ?? 0.5, bells: p.music === 'background' ? 0 : 1 });
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

/** Duel: fighting-game bars facing each other. Horde: the big one's bar and the count. */
function drawPanel(ctx: Ctx2D, s: State, theme: Theme, fighters: FighterView[]) {
  if (s.phase === 'vs') return;
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
      const name = `${f.def.icon} ${nameOf(f.def).toUpperCase()}`;
      textOutlined(ctx, name, k === 0 ? x0 : x0 + barW, y + barH + 34, fitText(ctx, name, 40, barW), '#ffffff', k === 0 ? 'left' : 'right');
      textOutlined(ctx, `${Math.max(0, Math.ceil(f.hp / s.w.hpScale))} HP`, k === 0 ? x0 + barW - 14 : x0 + 14, y + barH / 2, 22, '#ffffff', k === 0 ? 'right' : 'left', 0.95);
    });
    textOutlined(ctx, 'VS', 540, y + barH / 2, 34, theme.accent);
  } else {
    const big = fighters[0];
    const barW = 860;
    const x0 = 540 - barW / 2;
    hpBar(ctx, x0, PANEL_Y, barW, 34, big.hp / big.maxHp, '#ff8a3b', big.flash, false);
    textOutlined(ctx, `${big.def.icon} ${nameOf(big.def).toUpperCase()}`, x0, PANEL_Y + 34 + 34, 38, '#ffffff', 'left');
    textOutlined(ctx, `${Math.max(0, Math.ceil(big.hp / s.w.hpScale))} HP`, x0 + barW - 14, PANEL_Y + 17, 22, '#ffffff', 'right');
    const sent = s.w.swarm?.sent ?? 0;
    const down = fighters.filter((f) => f.side === 1 && !f.alive).length;
    const label = `${s.b.icon} × ${sent}`;
    textOutlined(ctx, label, x0 + barW, PANEL_Y + 34 + 40, 58, theme.accent, 'right');
    textOutlined(ctx, `${s.b.plural.toUpperCase()} SENT · ${down} DOWN`, x0 + barW, PANEL_Y + 34 + 92, 24, '#ffffff', 'right');
  }
  ctx.restore();
}

/** VS card text: both fighters' names and stat bars, the VS slam. The models stand in the strips (view). */
function drawVs(ctx: Ctx2D, s: State, theme: Theme) {
  const sl = vsSlide(s.phase, s.t - s.phaseAt);
  if (!sl.showing) return;
  const blocks: { c: CreatureDef; title: string }[] =
    s.mode === 'duel'
      ? [
          { c: s.a, title: nameOf(s.a).toUpperCase() },
          { c: s.b, title: nameOf(s.b).toUpperCase() },
        ]
      : [
          { c: s.a, title: `1 ${nameOf(s.a).toUpperCase()}` },
          { c: s.b, title: `? ${s.b.plural.toUpperCase()}` },
        ];
  const since = s.phase === 'vs' ? s.t - s.phaseAt : VS_S;
  blocks.forEach((bl, k) => {
    const st = VS_STRIPS[k];
    const col = st.textX;
    const right = st.align === 'right';
    ctx.save();
    ctx.translate(sl.o[k].x, sl.o[k].y);
    const title = `${bl.c.icon} ${bl.title}`;
    textOutlined(ctx, title, col, st.titleY, fitText(ctx, title, 64, 480), '#ffffff', st.align);
    const bars = statBars(bl.c);
    const rows: [string, number][] = [
      ['SIZE', bars.size],
      ['POWER', bars.power],
      ['SPEED', bars.speed],
      ['TOUGHNESS', bars.toughness],
    ];
    rows.forEach(([label, v], i) => {
      const y = st.titleY + 70 + i * 52;
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
    ctx.restore();
  });
  if (sl.slam < 0) return;
  const a = 1 - sl.exit;
  const pop = clamp01(sl.slam / 0.12);
  textOutlined(ctx, 'VS', 540, VS_SLAM_Y, 210 * (1 + 1.4 * (1 - pop) ** 2), theme.accent, 'center', a * Math.min(1, sl.slam / 0.05));
  if (sl.slam > 0.25) textOutlined(ctx, s.mode === 'duel' ? 'WHO WINS? 👇' : 'HOW MANY? 👇', 540, VS_SLAM_Y + 125, 40, '#ffffff', 'center', a * clamp01((sl.slam - 0.25) / 0.2));
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
  textOutlined(ctx, s.mode === 'duel' ? 'THE KNOCKOUT BLOW' : 'THE DECIDING MOMENT', 112, PANEL_Y + 50, 26, theme.accent, 'left');
  ctx.restore();
}

function winnerText(s: State): { big: string; small: string } {
  if (s.mode === 'duel') {
    const w = s.winner === 0 ? s.a : s.b;
    return { big: `${w.icon} ${nameOf(w).toUpperCase()} WINS!`, small: 'K.O.' };
  }
  if (s.winner === 1) return { big: `IT TOOK ${s.sent}!`, small: `${s.sent} ${s.b.plural.toUpperCase()} vs 1 ${nameOf(s.a).toUpperCase()}` };
  return { big: `${s.a.icon} ${nameOf(s.a).toUpperCase()} SURVIVES!`, small: `EVEN ${s.sent} ${s.b.plural.toUpperCase()} WEREN'T ENOUGH` };
}

export const whoWouldWin: Template<WhoWouldWinParams, State> = {
  id: 'who-would-win',
  name: 'Who Would Win',
  family: 'race',
  description:
    'Rendered in 3D low-poly: real animals, mythical creatures and fighters battle in a colosseum. Two modes. Duel: one on one (e.g. Bull vs Dragon, Horse vs King, Wolf vs Deer), each fighter with an HP bar, from a VS card with stat bars (size, power, speed, toughness) to a knockout, an instant replay of the knockout blow and the winner. Horde: "how many X does it take to beat a Y?": one big fighter (e.g. a Bull) against a stream of a smaller kind (e.g. Wolves) let in through the gates one after another, a few fighting at a time while the rest circle and wait; the counter shows how many were sent, and the answer is how many it took (or the big one survives them all). Fighters are a Bull, Horse, Unicorn, Stag, Deer, Donkey, Alpaca, Wolf, Husky, Fox, Swordsman, King, Brawler, Dragon (flies low, bites and breathes fire), Giant Spider (venom bite, leaps), and three with signature moves and their own fighting styles: a Lion (stalks and crouches, pounces and latches onto the back of its prey until shaken off), a Grizzly (rears up for a double swipe, bluff-charges, roars to make smaller foes flinch, pins and mauls a downed foe) and a Crocodile (lies still and ambushes, lunges and clamps on in a death roll that spins both over, whips its tail at anything behind it); these moments are called out on screen ("DEATH ROLL!", "LATCHED ON!"). Each has its own moves (gores, charges, bucking kicks, bites, sword slashes, punches) with hit freezes, knockbacks, staggers, sidesteps and damage numbers; outcomes are decided by the fight itself (favourites usually but not always win). No blood: knockouts, not deaths. Length: fightLength sets how long a typical fight lasts; the video runs about fightLength + 12 s.',
  schema: whoWouldWinSchema,
  substeps: 2,
  glowScale: 0.12,
  searchBudget: 300,
  lengthParam: { param: 'fightLength', offsetS: 12 },
  defaultCopy: {
    hook: '{hookText}',
    cta: '{ctaText}',
  },
  nudges: ['Who wins? 👇', 'Pick a side 👇', 'Call it before the bell 👇', 'Guess the number 👇', 'Who are you backing? 👇', 'Lock in your pick 👇'],

  init({ params: p, rng, fxRng, visual, melody }) {
    const [a, b] = resolveFighters(p, rng);
    const w = makeWorld({ mode: p.mode, a, b, hpScale: hpScaleFor(p.fightLength), capS: p.fightLength * 2, maxSwarm: p.maxSwarm, rng });
    return {
      p,
      rng,
      fxRng,
      visual,
      mode: p.mode,
      a,
      b,
      w,
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
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    const { p, w } = s;
    // The arena's room tone: a bed re-struck every 4 s (each one overlaps the next).
    if (t === 0 || Math.floor((t + dt) / 4) > Math.floor(t / 4)) emit({ type: 'crowd' });
    if (p.music === 'background') runMusic(s, t, dt, emit);
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
    if (sdt > 0) {
      if (live) {
        stepWorld(w, sdt, (e) => {
          // Old-style music: a melody note on each blow.
          if (p.music === 'hits') e.mm = 1;
          emit(e);
          const call = CALLOUTS[e.type === 'grab' || e.type === 'shakeOff' ? `${e.type}:${e.kind}` : e.type];
          if (call && s.visual) {
            s.callouts.push({ t, who: (e.a ?? e.who) as number, text: call.text, color: call.color });
            if (s.callouts.length > 6) s.callouts.shift();
          }
          // A grapple taking hold: a beat of slow motion on it.
          if (e.type === 'grab' && p.slowMotion && t >= s.threatCooldownUntil) {
            const o = w.fighters[e.b as number];
            s.threatUntil = t + 0.55;
            s.threatCooldownUntil = t + 2;
            s.focusX = o.x;
            s.focusY = o.y;
          }
          if (e.type === 'hit') {
            const power = e.power as number;
            if (power > 1.2 || e.crit) s.freezeUntil = Math.max(s.freezeUntil, t + p.hitFreeze * Math.min(1.5, 0.5 + power / 3));
            const o = w.fighters[e.b as number];
            s.hits.push({ simT: w.simT, sound: e.sound as string, power, mass: e.mass as number, x: o.x, y: o.y, h: o.def.height * 0.6 + (o.def.hover ?? 0), crit: e.crit === 1 });
            if (s.hits.length > 40) s.hits.shift();
            if (s.visual) {
              s.shake = Math.min(30, s.shake + Math.min(18, power * 6) * ((e.mass as number) > 300 ? 1.4 : 0.8));
              if (p.damageNumbers) {
                s.popups.push({ t, x: o.x, y: o.y, h: o.def.height * (o.def.hover ? 1.4 : 1.1), text: `${Math.max(1, Math.round((e.dmg as number) / w.hpScale))}`, crit: e.crit === 1 });
                if (s.popups.length > 24) s.popups.shift();
              }
            }
          }
        });
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
    const standing = w.fighters.filter((f) => f.alive || f.side === 0 || s.mode === 'duel' || w.simT - f.diedAt < 1.5);
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
    const k = 1 - dm.exp(-dt * (s.phase === 'count' ? 3 : 4));
    s.cam.x += (cx - s.cam.x) * k;
    s.cam.y += (cy - s.cam.y) * k;
    s.cam.span += (span - s.cam.span) * k;

    if (s.visual) {
      s.shake *= dm.exp(-9 * dt);
      if (s.popups.length && s.t - s.popups[0].t > 1.2) s.popups = s.popups.filter((q) => s.t - q.t <= 1.2);
      if (s.callouts.length && s.t - s.callouts[0].t > 1.4) s.callouts = s.callouts.filter((q) => s.t - q.t <= 1.4);
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
    const win = s.winner >= 0 ? winnerText(s) : null;
    return {
      a: nameOf(s.a),
      b: nameOf(s.b),
      big: nameOf(s.a),
      swarm: s.b.plural,
      winner: s.winner < 0 ? '' : s.mode === 'duel' ? nameOf(s.winner === 0 ? s.a : s.b) : s.winner === 1 ? s.b.plural : nameOf(s.a),
      count: s.sent,
      hookText: s.mode === 'duel' ? `${s.a.icon} ${nameOf(s.a)} vs ${nameOf(s.b)} ${s.b.icon}` : `How many ${s.b.plural} to beat a ${nameOf(s.a)}?`,
      ctaText: win ? (s.mode === 'duel' ? 'Did you call it? 👇' : 'Did you guess right? 👇') : '',
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
    // Horde: small HP bars over the swarm.
    if (s.mode === 'horde' && !rep && s.phase !== 'vs') {
      for (const f of fighters) {
        if (f.side !== 1 || !f.alive) continue;
        const q = projectToScreen(s, f.x, f.y, f.def.height + (f.def.hover ?? 0) + 0.25);
        if (!q) continue;
        hpBar(ctx, q.x - 36, q.y - 6, 72, 10, f.hp / f.maxHp, '#ffb03b', f.flash, false);
      }
    }
    if (s.phase === 'vs' || s.phase === 'count') drawVs(ctx, s, theme);
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
    // Signature moments, called out big over whoever made them.
    if (!rep) {
      for (const c of s.callouts) {
        const f = fighters.find((x) => x.idx === c.who);
        if (!f) continue;
        const pt = projectToScreen(s, f.x, f.y, f.def.height + (f.def.hover ?? 0) + 0.6);
        if (!pt) continue;
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
      const win = winnerText(s);
      const age = s.t - s.finishAt;
      if (!rep && (s.replayAt === null || s.t < s.replayAt)) {
        const pop = Math.min(1, age / 0.15);
        textOutlined(ctx, s.mode === 'duel' ? 'K.O.!' : s.winner === 1 ? 'DOWN!' : 'SURVIVED!', 540, cy - 40, 150 * (0.7 + 0.3 * pop), '#ff5a64', 'center', clamp01((LIVE_TAIL_S + 0.2 - age) / 0.25));
      }
      if (s.endAt !== null && s.t >= s.endAt) {
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
      case 'vsSlam':
        return [sfx('impact', 0.7, 0.05), sfx('clang', 0.3, 0.2), sfx('cheer', 0.35)].map((x) => ({ ...x, pan: 0 }));
      case 'count':
        return [{ kind: 'sfx', name: 'tom', vel: 0.7, pitch: 0.25 + (3 - (e.n as number)) * 0.15 }];
      case 'fight':
        return [{ kind: 'sfx', name: 'kick', vel: 0.6 }, { kind: 'sfx', name: 'clang', vel: 0.4, pitch: 0.4 }, { kind: 'sfx', name: 'cheer', vel: 0.55 }];
      case 'swing': {
        if (e.breath) return [sfx('flame', 0.8), ...call(e.call, e.cp, 0.55)];
        const sword = e.weapon === 'sword';
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
        else if (sound === 'slash') out.push(...(e.weapon === 'sword' ? [sfx('slash', 0.4, 0.7), sfx('clang', 0.3 + 0.2 * v, 0.75)] : [sfx('slash', 0.5 + 0.2 * v, 0.4)]));
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
        return [...call(e.call || 'roar', e.cp, 0.9), sfx('cheer', 0.2)];
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

  /**
   * Duel: prefer fights that run to length, stay busy, end close (the winner nearly beaten too), with
   * a comeback or lead changes. Horde: the big one should take plenty down before it falls, and the
   * answer shouldn't be trivially small.
   */
  score(events, { durationS, targetS, timedOut }): DramaScore {
    const durFit = gaussFit(durationS, targetS, targetS * 0.2);
    const win = events.find((e) => e.type === 'win');
    if (timedOut || !win) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no winner'] };
    const fightAt = events.find((e) => e.type === 'fight')?.t ?? 0;
    const hits = events.filter((e) => e.type === 'hit');
    // Longest stretch without a landed blow.
    let lull = 0;
    const times = [fightAt, ...hits.map((h) => h.t), win.t];
    for (let i = 1; i < times.length; i++) lull = Math.max(lull, times[i] - times[i - 1]);
    const lullFit = 1 - clamp01((lull - 2.5) / 4);
    const fightS = Math.max(1, win.t - fightAt);
    const hitFit = gaussFit(hits.length / fightS, 0.9, 0.6);
    const crits = hits.filter((h) => h.crit).length;
    if (win.mode === 'duel') {
      const close = clamp01(1 - (win.hpLeft as number) / 0.6);
      // HP lead over time: who was ahead after each hit (fractions of their own max).
      const hp = [1, 1];
      let comeback = 0;
      let leadChanges = 0;
      let lead = 0;
      const winner = win.side as number;
      for (const h of hits) {
        hp[(h.b as number) === 0 ? 0 : 1] = h.hp as number;
        comeback = Math.max(comeback, clamp01((hp[1 - winner] - hp[winner]) / 0.35));
        const now = hp[0] > hp[1] + 0.05 ? 1 : hp[1] > hp[0] + 0.05 ? -1 : lead;
        if (now !== lead && lead !== 0) leadChanges++;
        lead = now;
      }
      const swings = clamp01(leadChanges / 2);
      // Signature moments (grapples, shake-offs, roars) make a fight.
      const moments = clamp01(events.filter((e) => e.type === 'grab' || e.type === 'shakeOff' || e.type === 'bluff').length / 2);
      const drama = 0.27 * close + 0.18 * comeback + 0.1 * swings + 0.13 * lullFit + 0.13 * hitFit + 0.09 * clamp01(crits / 2) + 0.1 * moments;
      return {
        total: durFit * (0.2 + 0.8 * drama),
        parts: { durFit, close, comeback, swings, lullFit, hitFit },
        notes: [`${win.a} vs ${win.b}: ${winner === 0 ? win.a : win.b} wins with ${Math.round((win.hpLeft as number) * 100)}% HP`, `${hits.length} hits, ${crits} crits, ${leadChanges} lead changes`],
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
