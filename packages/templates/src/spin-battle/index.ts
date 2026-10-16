import { z } from 'zod';
import { FONT_FAMILY, hexToRgb, lighten, rgbToCss, type Ctx2D, type DramaScore, type Rng, type SimEvent, type Template, type Theme } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { COLOR_TEAMS, COUNTRY_TEAMS, pickDistinctTeams } from '../fx';
import { clamp01, gaussFit } from '../scoring';
import { FALL_AT, HEAVY_HIT, K, escapeSpeed, inPocket, makeTop, stepTops, type Arena, type FinishKind, type Top } from './physics';
import { MATCHUPS, NAMED_TOPS, TOPS, TOP_TYPES, resolveMatchup } from './tops';
import { pickDesign } from './designs';
import { BEAT_S, DROP_S, VS_EXIT_S, VS_S, VS_SLAM, vsLayout } from './intro';
import { drawShowcase, drawView, screenOf } from './view3d';

export const spinBattleSchema = z.object({
  format: z.enum(['duel', 'points', 'ffa']).default('duel').meta({ title: 'Format (one duel, rounds to a points target, or a 3-4 top free-for-all)' }),
  players: z.enum(['3', '4']).default('4').meta({ title: 'Tops in a free-for-all' }),
  matchup: z.enum(MATCHUPS).default('random').meta({ title: 'Matchup (top types; duel and points)' }),
  identity: z.enum(['colors', 'countries', 'named']).default('colors').meta({ title: 'Tops (colours, country flags or named tops)' }),
  spins: z.enum(['random', 'right', 'opposite']).default('random').meta({ title: 'Spin directions (random per top, all right, or alternating)' }),
  targetPoints: z.number().int().min(2).max(5).default(3).meta({ title: 'Points to win (points format)' }),
  pockets: z.number().int().min(0).max(4).default(3).meta({ title: 'Rim pockets' }),
  bowlDepth: z.number().min(0.6).max(1.6).default(1).meta({ title: 'Bowl steepness', step: 0.05 }),
  launchPower: z.number().min(0.6).max(1.6).default(1).meta({ title: 'Launch power', step: 0.05 }),
  roundLength: z.number().min(8).max(45).default(15).meta({ title: 'Typical round length, s (points rounds run ~50% of this)', step: 1 }),
  hitPower: z.number().min(0.5).max(1.8).default(1).meta({ title: 'Clash power', step: 0.05 }),
  wallLaunch: z.number().min(3).max(7).default(5).meta({ title: 'Speed to fly over the wall', step: 0.1 }),
  hitFreeze: z.number().min(0).max(0.12).default(0.05).meta({ title: 'Hit freeze (s)', step: 0.01 }),
  slowMotion: z.boolean().default(true).meta({ title: 'Slow-motion finishes' }),
  replay: z.boolean().default(true).meta({ title: 'Instant replay of the finishing blow' }),
});

export type SpinBattleParams = z.infer<typeof spinBattleSchema>;

/** Round 1 opens on the VS card; every round has a launcher countdown, then the drop. */
type Phase = 'vs' | 'countdown' | 'drop' | 'fight' | 'after' | 'over';

interface Banner {
  kind: FinishKind | 'draw';
  points: number;
  winner: number;
  /** Free-for-all: the top that was just eliminated (-1 otherwise), and how many are left. */
  out: number;
  left: number;
  at: number;
}

export interface State {
  p: SpinBattleParams;
  rng: Rng;
  visual: boolean;
  tops: Top[];
  arena: Arena;
  contact: Map<string, number>;
  /** Video time and sim time (sim pauses on hit freeze and slows in slow motion). */
  t: number;
  simT: number;
  /** Sim seconds since this round's launch. */
  fightT: number;
  round: number;
  score: [number, number];
  /** The round has been decided (the survivor spins on, silently). */
  roundOver: boolean;
  /** Free-for-all: tops in the order they were eliminated. */
  eliminated: number[];
  phase: Phase;
  phaseAt: number;
  /** Countdown beats emitted this round (3, 2, 1, GO). */
  beats: number;
  /** Video time of this round's launch (ripcords pulled, tops drop) and landing (fight starts). */
  launchAt: number;
  landAt: number;
  /** Where each top is launched from this round (the launchers hang over these spots). */
  launchPos: { x: number; y: number }[];
  /** VS card sounds emitted so far (0: none, 1: entrance, 2: slam). */
  vsStage: number;
  /** Finishes collected during the current step. */
  pending: { top: Top; kind: FinishKind }[];
  banner: Banner | null;
  freezeUntil: number;
  slow: number;
  slowTarget: number;
  slowHoldUntil: number;
  inThreat: boolean;
  threatStart: number;
  threatLastT: number;
  threatCooldownUntil: number;
  threatsThisRound: number;
  leader: number;
  focusX: number;
  focusY: number;
  /** Camera target (stadium units) and zoom. */
  cam: { x: number; y: number; z: number };
  shake: number;
  /** Recent clashes: sparks, and the replay's sounds. `nx, ny` is the contact normal. */
  hits: Hit[];
  /** Visual only: recent top states by sim time, for the replay. */
  track: Snapshot[];
  winner: number;
  /** When the match was decided: video time, sim time, and where (the replay's focus). */
  finishAt: number;
  finishSimT: number;
  finishX: number;
  finishY: number;
  /** Video time the replay starts (null without one), and the replay sim time reached so far. */
  replayAt: number | null;
  replayRt: number;
  /** When the outro (CTA, crown) starts. */
  endAt: number | null;
}

export interface Hit {
  t: number;
  simT: number;
  x: number;
  y: number;
  nx: number;
  ny: number;
  power: number;
  opp: boolean;
}

type TopSnap = Pick<Top, 'x' | 'y' | 'omega' | 'status' | 'wobbling' | 'outKind' | 'outVx' | 'outVy' | 'outSimT' | 'spin' | 'tilt' | 'precess' | 'flash'>;
interface Snapshot {
  simT: number;
  tops: TopSnap[];
}

const OUTRO_S = 2.6;
/** Replay: the live finish plays on for LIVE_TAIL_S, then the last REPLAY_PRE_S of sim before the
 * deciding moment (and REPLAY_POST_S after) replays over REPLAY_S, from a low side camera. */
const LIVE_TAIL_S = 0.9;
const REPLAY_S = 2.6;
const REPLAY_PRE_S = 1.2;
const REPLAY_POST_S = 0.45;

const COUNT_S = BEAT_S * 3;
const AFTER_S = 1.2;
const SLOW = 0.22;
const MAX_THREATS = 2;
/** How long a round lasts at spin rate 1 (sim seconds, median). */
const BASE_ROUND_S = 15;
/** Points rounds run shorter so a whole match fits in a Short. */
const POINTS_ROUND = 0.5;
/** Soft cap on a round, as a multiple of its typical length (spin then drains faster). */
const SOFT_CAP = 1.7;
/** Points format: after this many rounds the leader wins (draws can otherwise drag on). */
const MAX_ROUNDS = 6;
const PANEL_TOP = 1920 * 0.155;
const POINTS: Record<FinishKind, number> = { spin: 1, pocket: 2, wall: 2 };
export const MAX_RPM = 9800;

const roundLive = (s: State) => s.phase === 'fight' && !s.roundOver;
const ffa = (s: State) => s.p.format === 'ffa';
const nameOf = (t: Top) => `${t.team.icon ? t.team.icon + ' ' : ''}${t.team.label}`;

function startRound(s: State, t: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  const { rng, p } = s;
  s.round++;
  s.phase = s.round === 1 ? 'vs' : 'countdown';
  s.phaseAt = t;
  s.landAt = -1;
  s.beats = 0;
  s.fightT = 0;
  s.banner = null;
  s.roundOver = false;
  s.threatsThisRound = 0;
  s.inThreat = false;
  s.leader = -1;
  s.contact.clear();
  const a0 = rng.range(0, Math.PI * 2);
  // Launch spots spread evenly round the bowl (opposite sides for a duel).
  const n = s.tops.length;
  s.tops.forEach((top, i) => {
    const a = a0 + (i * Math.PI * 2) / n + (i ? rng.range(-0.5, 0.5) * (2 / n) : 0);
    const d = rng.range(0.45, 0.62);
    const sp = K.launch * p.launchPower * rng.range(0.85, 1.15);
    // Launched roughly along the bowl (the way it curls: counter-clockwise for right spin), with a
    // little aim in or out.
    const aim = a + (top.dir * Math.PI) / 2 + rng.range(-0.45, 0.45);
    Object.assign(top, {
      x: dm.cos(a) * d,
      y: dm.sin(a) * d,
      vx: dm.cos(aim) * sp,
      vy: dm.sin(aim) * sp,
      // Launch strength varies: some rips are better than others.
      omega: rng.range(1 - 0.2 * s.arena.chaos, 1),
      status: 'spinning',
      wobbling: false,
      outAt: -1,
      outSimT: -1,
      outKind: null,
      spin: 0,
      tilt: 0,
      flash: 0,
    });
  });
  s.launchPos = s.tops.map((x) => ({ x: x.x, y: x.y }));
  emit({ type: 'roundStart', round: s.round });
}

function resolveRound(s: State, t: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  const { p } = s;
  const done = s.pending;
  s.pending = [];
  if (ffa(s)) {
    const alive = s.tops.filter((x) => x.status === 'spinning');
    for (const d of done) s.eliminated.push(d.top.idx);
    if (alive.length >= 2) {
      // Eliminations: a banner and a moment of slow motion, and the rest fight on.
      for (const d of done) emit({ type: 'elim', who: d.top.idx, kind: d.kind, left: alive.length, x: Math.round(d.top.x * 100) / 100 });
      const last = done[done.length - 1];
      s.banner = { kind: last.kind, points: 0, winner: -1, out: last.top.idx, left: alive.length, at: t };
      if (p.slowMotion) {
        s.slowHoldUntil = Math.max(s.slowHoldUntil, t + 0.55);
        s.focusX = last.top.x;
        s.focusY = last.top.y;
      }
      s.inThreat = false;
      return;
    }
    // The last one standing wins (if the last two went down together, the one with more spin).
    const champ = alive[0] ?? [...done].sort((a, b) => b.top.omega - a.top.omega || a.top.idx - b.top.idx)[0].top;
    const loser = done.find((d) => d.top !== champ) ?? done[0];
    finishMatch(s, t, emit, champ.idx, loser.top, loser.kind);
    return;
  }
  let winner: number;
  let kind: FinishKind | 'draw';
  if (done.length >= 2 || s.tops.every((x) => x.status !== 'spinning')) {
    // Both went down in the same instant.
    if (p.format === 'points') {
      winner = -1;
      kind = 'draw';
    } else {
      winner = s.tops[0].omega >= s.tops[1].omega ? 0 : 1;
      kind = done[0].kind;
    }
  } else {
    winner = 1 - done[0].top.idx;
    kind = done[0].kind;
  }
  const points = kind === 'draw' ? 0 : POINTS[kind];
  if (winner >= 0) s.score[winner] += points;
  s.banner = { kind, points, winner, out: -1, left: 1, at: t };
  s.roundOver = true;
  const loser = winner >= 0 ? s.tops[1 - winner] : done[0].top;
  if (p.slowMotion) {
    s.slowTarget = SLOW;
    s.focusX = loser.x;
    s.focusY = loser.y;
  }
  s.inThreat = false;
  const w = winner >= 0 ? s.tops[winner] : null;
  emit({ type: 'finish', kind, winner, loser: loser.idx, points, score: [...s.score], rpm: w ? Math.round(w.omega * 1000) / 1000 : 0, round: s.round, x: Math.round(loser.x * 100) / 100 });
  // Points: past the round cap the leader wins (a tie gets up to two sudden-death rounds).
  const capped = s.round >= MAX_ROUNDS && (s.score[0] !== s.score[1] || s.round >= MAX_ROUNDS + 2);
  const over = p.format === 'duel' || Math.max(...s.score) >= p.targetPoints || capped;
  if (over) {
    const champ = p.format === 'duel' || s.score[0] === s.score[1] ? Math.max(0, winner) : s.score[0] > s.score[1] ? 0 : 1;
    endMatch(s, t, emit, champ, loser, kind);
  } else {
    s.phase = 'after';
    s.phaseAt = t;
    s.slowHoldUntil = t + (p.slowMotion ? 0.7 : 0);
  }
}

/** Free-for-all: the last elimination decides it. */
function finishMatch(s: State, t: number, emit: (e: Omit<SimEvent, 't'>) => void, winner: number, loser: Top, kind: FinishKind) {
  s.banner = { kind, points: 0, winner, out: loser.idx, left: 1, at: t };
  s.roundOver = true;
  if (s.p.slowMotion) {
    s.slowTarget = SLOW;
    s.focusX = loser.x;
    s.focusY = loser.y;
  }
  s.inThreat = false;
  const w = s.tops[winner];
  emit({ type: 'finish', kind, winner, loser: loser.idx, points: 0, score: [0, 0], rpm: Math.round(w.omega * 1000) / 1000, round: s.round, x: Math.round(loser.x * 100) / 100 });
  endMatch(s, t, emit, winner, loser, kind);
}

/** The match is decided: slow motion, then the replay (if on) and the outro. */
function endMatch(s: State, t: number, emit: (e: Omit<SimEvent, 't'>) => void, winner: number, loser: Top, kind: FinishKind | 'draw') {
  const { p } = s;
  s.phase = 'over';
  s.winner = winner;
  s.slowHoldUntil = t + (p.slowMotion ? 1.1 : 0);
  s.finishAt = t;
  s.finishSimT = s.simT;
  // The replay looks between the winner and the last top it beat, at the deciding moment.
  const champ = s.tops[winner];
  s.finishX = (champ.x + loser.x) / 2;
  s.finishY = (champ.y + loser.y) / 2;
  if (p.replay) {
    s.replayAt = t + LIVE_TAIL_S;
    s.replayRt = s.simT - REPLAY_PRE_S;
    s.endAt = s.replayAt + REPLAY_S;
  } else s.endAt = t + (p.slowMotion ? 0.6 : 0.15);
  emit({ type: 'win', who: winner, kind, format: p.format, score: [...s.score], rpm: Math.round(champ.omega * 1000) / 1000, players: s.tops.length });
}

/** A finish is close: a top is flying at the rim fast enough to leave, or is about to topple. */
function threatNear(s: State): { x: number; y: number } | null {
  for (const top of s.tops) {
    if (top.status !== 'spinning') continue;
    const r = Math.sqrt(top.x * top.x + top.y * top.y);
    if (r > 0.55) {
      const vr = (top.vx * top.x + top.vy * top.y) / r;
      // Where it would reach the rim, roughly.
      const k = (1 - r) / Math.max(0.3, Math.sqrt(top.vx * top.vx + top.vy * top.vy));
      const hx = top.x + top.vx * k;
      const hy = top.y + top.vy * k;
      if (vr > 0.8 * escapeSpeed(s.arena, top, hx, hy) && (vr > 2 || inPocket(s.arena, hx, hy, 0.15))) return { x: top.x, y: top.y };
    }
    if (top.omega < FALL_AT + 0.04 && s.tops.some((o) => o !== top && o.status === 'spinning' && o.omega > top.omega + 0.03)) return { x: top.x, y: top.y };
  }
  return null;
}

function simulate(s: State, sdt: number, t: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  const { p } = s;
  s.simT += sdt;
  const live = roundLive(s);
  if (s.phase === 'fight') s.fightT += sdt;
  const wrapped = (e: Record<string, unknown> & { type: string }) => {
    // After a round is decided the survivor keeps spinning, silently.
    if (!live) return;
    if (e.type === 'clash') {
      const power = e.power as number;
      if (power > 2.2) s.freezeUntil = Math.max(s.freezeUntil, t + p.hitFreeze * Math.min(1.6, power / 3));
      // Kept with or without visuals: the replay replays their sounds.
      s.hits.push({ t, simT: s.simT, x: e.x as number, y: e.y as number, nx: e.nx as number, ny: e.ny as number, power, opp: e.opp === true });
      if (s.hits.length > 16) s.hits.shift();
      if (s.visual) s.shake = Math.min(power > HEAVY_HIT ? 34 : 26, s.shake + power * (power > HEAVY_HIT ? 5 : 3));
    }
    emit(e);
  };
  stepTops(s.tops, s.arena, sdt, s.contact, {
    emit: wrapped,
    live,
    fightT: s.fightT,
    softCap: SOFT_CAP * BASE_ROUND_S / s.arena.spin,
    simT: s.simT,
    rng: s.rng,
    finish: (top, kind) => {
      top.outAt = t;
      top.outSimT = s.simT;
      s.pending.push({ top, kind });
    },
  });
  if (s.pending.length) {
    resolveRound(s, t, emit);
    return;
  }
  if (!live) return;

  // RPM lead changes (with a little hysteresis).
  const ranked = s.tops.filter((x) => x.status === 'spinning').sort((a, b) => b.omega - a.omega || a.idx - b.idx);
  const lead = ranked.length > 1 && ranked[0].omega > ranked[1].omega + 0.04 ? ranked[0].idx : s.leader;
  if (lead !== s.leader) {
    if (s.leader >= 0) emit({ type: 'leadChange', to: lead });
    s.leader = lead;
  }

  // Slow motion when a finish is close (or nearly happens).
  if (p.slowMotion) {
    const near = s.threatsThisRound < MAX_THREATS || s.inThreat ? threatNear(s) : null;
    if (near) {
      s.threatLastT = t;
      s.focusX = near.x;
      s.focusY = near.y;
      if (!s.inThreat && t >= s.threatCooldownUntil) {
        s.inThreat = true;
        s.threatStart = t;
        s.threatsThisRound++;
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

/** The HUD fades out for the replay (or the outro). */
const panelAlpha = (s: State) => {
  if (s.phase === 'vs') return 0;
  if (vsExiting(s)) return vsSlide(s).exit;
  const hideAt = s.replayAt ?? s.endAt;
  return hideAt === null || s.t < hideAt ? 1 : Math.max(0, 1 - (s.t - hideAt) / 0.25);
};
const replaying = (s: State) => s.replayAt !== null && s.endAt !== null && s.t >= s.replayAt && s.t < s.endAt;
/** Replay sim time at video time t. */
const replayTime = (s: State, t: number) => s.finishSimT - REPLAY_PRE_S + ((t - s.replayAt!) / REPLAY_S) * (REPLAY_PRE_S + REPLAY_POST_S);

/** Top states at sim time rt (the nearest recorded step), for drawing the replay. */
function replayView(s: State, rt: number): State {
  const tr = s.track;
  let lo = 0;
  let hi = tr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tr[mid].simT < rt) lo = mid + 1;
    else hi = mid;
  }
  const snap = tr[lo];
  return {
    ...s,
    t: rt,
    phase: 'fight',
    launchAt: -100,
    landAt: -100,
    endAt: null,
    // Exit animations and sparks run on sim time in the replay, so they play slowed down too.
    tops: s.tops.map((top, i) => ({ ...top, ...snap.tops[i], outAt: snap.tops[i].outSimT })),
    hits: s.hits.map((h) => ({ ...h, t: h.simT })),
  };
}

const ORDINAL = ['1ST', '2ND', '3RD', '4TH'];

/** Free-for-all HUD: one spin bar per top, stacked; eliminated tops greyed out with their place. */
function drawRows(ctx: Ctx2D, s: State, theme: Theme) {
  textOutlined(ctx, 'FREE FOR ALL  ·  LAST TOP SPINNING', 540, PANEL_TOP + 8, 34, theme.accent);
  const rowH = 46;
  const barX = 360;
  const barW = 470;
  const prelaunch = s.phase === 'countdown' || s.phase === 'drop' || s.phase === 'vs';
  s.tops.forEach((top, k) => {
    const y = PANEL_TOP + 40 + k * rowH;
    const outAt = s.eliminated.indexOf(top.idx);
    const out = outAt >= 0;
    ctx.save();
    ctx.globalAlpha *= out ? 0.4 : 1;
    const st = TOPS[top.type];
    const name = `${nameOf(top)} ${st.emoji}`;
    textOutlined(ctx, name, barX - 14, y + rowH / 2, fitText(ctx, name, 28, 300), theme.text, 'right');
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.roundRect(barX, y + rowH * 0.2, barW, rowH * 0.6, rowH * 0.3);
    ctx.fill();
    const frac = out ? 0 : prelaunch ? 1 : top.omega;
    ctx.fillStyle = top.flash > 0.3 ? '#ffffff' : top.wobbling && !out ? (Math.floor(s.t * 8) % 2 ? '#ff5a64' : top.team.color) : top.team.color;
    ctx.beginPath();
    ctx.roundRect(barX, y + rowH * 0.2, Math.max(0.001, barW * frac), rowH * 0.6, rowH * 0.3);
    ctx.fill();
    const tag = out ? `OUT · ${ORDINAL[s.tops.length - 1 - outAt]}` : `${(Math.round((frac * MAX_RPM) / 10) * 10).toLocaleString('en-US')} RPM`;
    textOutlined(ctx, tag, barX + barW + 12, y + rowH / 2, 20, out ? '#ff5a64' : '#ffffff', 'left');
    ctx.restore();
  });
}

function drawPanel(ctx: Ctx2D, s: State, theme: Theme) {
  const alpha = panelAlpha(s);
  if (alpha <= 0) return;
  const { p } = s;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (ffa(s)) {
    drawRows(ctx, s, theme);
    ctx.restore();
    return;
  }
  const title = p.format === 'points' ? `ROUND ${s.round}  ·  FIRST TO ${p.targetPoints}` : 'LAST TOP SPINNING WINS';
  textOutlined(ctx, title, 540, PANEL_TOP + 8, 36, theme.accent);
  // Fighting-game spin bars, facing each other.
  const barW = 400;
  const barH = 30;
  const y = PANEL_TOP + 50;
  s.tops.forEach((top, k) => {
    const dir = k === 0 ? -1 : 1;
    const x0 = 540 + dir * 26;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.roundRect(k === 0 ? x0 - barW : x0, y, barW, barH, 15);
    ctx.fill();
    const prelaunch = s.phase === 'countdown' || s.phase === 'drop' || s.phase === 'vs';
    const spinning = top.status === 'spinning' || prelaunch;
    const frac = spinning ? (prelaunch ? 1 : top.omega) : 0;
    const fw = Math.max(0.001, barW * frac);
    ctx.fillStyle = top.flash > 0.3 ? '#ffffff' : top.wobbling && spinning ? (Math.floor(s.t * 8) % 2 ? '#ff5a64' : top.team.color) : top.team.color;
    ctx.beginPath();
    ctx.roundRect(k === 0 ? x0 - fw : x0, y, fw, barH, 15);
    ctx.fill();
    const rpm = Math.round((frac * MAX_RPM) / 10) * 10;
    textOutlined(ctx, `${rpm.toLocaleString('en-US')} RPM`, k === 0 ? x0 - 12 : x0 + 12, y + barH / 2, 20, '#ffffff', k === 0 ? 'right' : 'left', 0.9);
    const st = TOPS[top.type];
    textOutlined(ctx, nameOf(top), k === 0 ? x0 - barW : x0 + barW, y + barH + 28, 30, theme.text, k === 0 ? 'left' : 'right');
    const spinTag = top.dir > 0 ? 'R-SPIN ↻' : 'L-SPIN ↺';
    textOutlined(ctx, `${st.emoji} ${st.label.toUpperCase()} · ${spinTag}`, k === 0 ? x0 - barW : x0 + barW, y + barH + 66, 24, theme.accent, k === 0 ? 'left' : 'right');
    if (p.format === 'points') {
      // Score pips toward the target, next to the centre.
      for (let i = 0; i < p.targetPoints; i++) {
        const px = x0 + dir * (14 + i * 30);
        const py = y + barH + 30;
        ctx.beginPath();
        ctx.arc(px, py, 10, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.fillStyle = i < s.score[k] ? theme.accent : 'rgba(255,255,255,0.18)';
        ctx.fill();
        ctx.stroke();
      }
    }
  });
  textOutlined(ctx, 'VS', 540, y + barH / 2, 28, '#ffffff');
  ctx.restore();
}

// ---- VS card ------------------------------------------------------------------------------------

const easeOut = (x: number) => 1 - (1 - x) ** 3;
const easeIn = (x: number) => x * x * x;
const vsExiting = (s: State) => s.round === 1 && s.phase === 'countdown' && s.t - s.phaseAt < VS_EXIT_S;
const vsShowing = (s: State) => s.phase === 'vs' || vsExiting(s);

export interface VsSlide {
  /** Pixel offset of each contender's strip. */
  o: { x: number; y: number }[];
  /** 0 → 1 as the strips split apart. */
  exit: number;
  /** Seconds since VS slammed down (negative before). */
  slam: number;
}

/**
 * Strips slide in from alternate sides, staggered. On the way out, a duel's two halves split up and
 * down; a free-for-all's strips fly out sideways.
 */
export function vsSlide(s: State): VsSlide {
  const n = s.tops.length;
  const inT = s.phase === 'vs' ? s.t - s.phaseAt : VS_S;
  const exit = s.phase === 'vs' ? 0 : easeIn(clamp01((s.t - s.phaseAt) / VS_EXIT_S));
  const o = s.tops.map((_, k) => {
    const side = k % 2 === 0 ? -1 : 1;
    const e = easeOut(clamp01((inT - k * (n > 2 ? 0.07 : 0.1)) / 0.25));
    return n > 2 ? { x: side * ((1 - e) * 1100 + exit * 1150), y: 0 } : { x: side * (1 - e) * 1100, y: side * exit * 1150 };
  });
  return { o, exit, slam: inT - VS_SLAM };
}

function vsStripPath(ctx: Ctx2D, st: ReturnType<typeof vsLayout>['strips'][number]) {
  ctx.beginPath();
  ctx.moveTo(-40, st.topL + 3);
  ctx.lineTo(1120, st.topR + 3);
  ctx.lineTo(1120, st.bottomR - 3);
  ctx.lineTo(-40, st.bottomL - 3);
  ctx.closePath();
}

/** The coloured strips (drawn under the 3D tops). */
function drawVsBackground(ctx: Ctx2D, s: State, sl: VsSlide) {
  const layout = vsLayout(s.tops.length);
  s.tops.forEach((top, k) => {
    const o = sl.o[k];
    const col = hexToRgb(top.team.color);
    const strip = layout.strips[k];
    const c = strip.top;
    ctx.save();
    ctx.translate(o.x, o.y);
    vsStripPath(ctx, strip);
    ctx.fillStyle = '#0b0b14';
    ctx.fill();
    ctx.clip();
    const g = ctx.createRadialGradient(c.x, c.y, 40, c.x, c.y, 760);
    g.addColorStop(0, rgbToCss(col, 0.85));
    g.addColorStop(0.55, rgbToCss(col, 0.35));
    g.addColorStop(1, rgbToCss(col, 0.08));
    ctx.fillStyle = g;
    ctx.fillRect(-40, -40, 1160, 2000);
    // Speed stripes racing across each half (in opposite directions).
    ctx.strokeStyle = rgbToCss(lighten(col, 0.6), 0.09);
    ctx.lineWidth = 26;
    const drift = ((s.t * 900) % 240) * (k % 2 === 0 ? 1 : -1);
    for (let i = -6; i < 12; i++) {
      const x = i * 240 + drift;
      ctx.beginPath();
      ctx.moveTo(x, 2000);
      ctx.lineTo(x + 700, -40);
      ctx.stroke();
    }
    ctx.restore();
  });
  // Bright slashes between the strips.
  if (sl.exit < 1) {
    ctx.save();
    ctx.globalAlpha = 1 - sl.exit;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 8;
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 24;
    for (const st of layout.strips.slice(1)) {
      ctx.beginPath();
      ctx.moveTo(-40, st.topL + 1.6);
      ctx.lineTo(1120, st.topR - 1.6);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function fitText(ctx: Ctx2D, text: string, size: number, maxW: number) {
  ctx.font = `900 ${Math.round(size)}px ${FONT_FAMILY}`;
  const w = ctx.measureText(text).width;
  return w > maxW ? size * (maxW / w) : size;
}

/** Names, types and the VS slam (drawn crisp, after bloom). */
function drawVsText(ctx: Ctx2D, s: State, theme: Theme, sl: VsSlide) {
  const layout = vsLayout(s.tops.length);
  s.tops.forEach((top, k) => {
    const strip = layout.strips[k];
    const z = strip.scale;
    const st = TOPS[top.type];
    const light = rgbToCss(lighten(hexToRgb(top.team.color), 0.55));
    const x = strip.textX;
    const y0 = strip.top.y - 95 * z;
    const maxW = 470;
    ctx.save();
    ctx.translate(sl.o[k].x, sl.o[k].y);
    const name = nameOf(top);
    textOutlined(ctx, name, x, y0, fitText(ctx, name, 66 * z, maxW), '#ffffff', strip.align);
    const kind = `${st.emoji} ${st.label.toUpperCase()} · ${top.design.name.toUpperCase()}`;
    textOutlined(ctx, kind, x, y0 + 74 * z, fitText(ctx, kind, 46 * z, maxW), light, strip.align);
    textOutlined(ctx, st.tagline, x, y0 + 130 * z, 32 * z, 'rgba(255,255,255,0.92)', strip.align);
    textOutlined(ctx, top.dir > 0 ? 'RIGHT SPIN ↻' : 'LEFT SPIN ↺', x, y0 + 180 * z, 28 * z, theme.accent, strip.align);
    ctx.restore();
  });
  if (sl.slam < 0) return;
  // VS (or FREE FOR ALL) slams down onto a split, with a flash.
  const pop = clamp01(sl.slam / 0.12);
  const a = 1 - sl.exit;
  const many = s.tops.length > 2;
  const big = many ? 'FREE FOR ALL' : 'VS';
  const size = (many ? fitText(ctx, big, 130, 980) : 210) * (1 + 1.4 * (1 - pop) ** 2);
  textOutlined(ctx, big, 540, layout.slamY, size, theme.accent, 'center', a * Math.min(1, sl.slam / 0.05));
  // With 3-4 strips there's no room under the slam: the prompt goes in the free space at the bottom.
  if (sl.slam > 0.2) textOutlined(ctx, many ? 'PICK YOUR TOP 👇' : 'PICK A SIDE', 540, many ? 1770 : layout.slamY + 125, many ? 46 : 38, '#ffffff', 'center', a * clamp01((sl.slam - 0.2) / 0.2));
  const flash = 0.5 * Math.exp(-sl.slam * 9);
  if (flash > 0.01) {
    ctx.fillStyle = `rgba(255,255,255,${flash.toFixed(3)})`;
    ctx.fillRect(0, 0, 1080, 1920);
  }
}

/** Replay chrome: letterbox bars, a blinking REPLAY tag, and the finish call when it lands. */
function drawReplayChrome(ctx: Ctx2D, s: State, theme: Theme) {
  const u = (s.t - s.replayAt!) / REPLAY_S;
  const inOut = Math.min(1, u / 0.06, (1 - u) / 0.06);
  const bar = 170 * inOut;
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(0, 0, 1080, bar + 160);
  ctx.fillRect(0, 1920 - bar - 120, 1080, bar + 120);
  const blink = Math.floor((s.t - s.replayAt!) * 2.5) % 2 === 0;
  ctx.save();
  ctx.globalAlpha = inOut;
  if (blink) {
    ctx.fillStyle = '#ff3b3b';
    ctx.beginPath();
    ctx.arc(80, PANEL_TOP + 8, 16, 0, Math.PI * 2);
    ctx.fill();
  }
  textOutlined(ctx, 'REPLAY', 112, PANEL_TOP + 8, 48, '#ffffff', 'left');
  textOutlined(ctx, 'THE DECIDING MOMENT', 112, PANEL_TOP + 58, 26, theme.accent, 'left');
  ctx.restore();
  const rt = replayTime(s, s.t);
  if (rt >= s.finishSimT && s.banner) {
    const age = (s.t - s.replayAt!) - (REPLAY_PRE_S / (REPLAY_PRE_S + REPLAY_POST_S)) * REPLAY_S;
    const pop = Math.min(1, age / 0.12);
    textOutlined(ctx, FINISH_TEXT[s.banner.kind], 540, 1920 * 0.3, 96 * (0.7 + 0.3 * pop), s.banner.kind === 'spin' ? '#ffffff' : '#ff5a64', 'center', inOut);
  }
}

const FINISH_TEXT: Record<FinishKind | 'draw', string> = { spin: 'SPIN FINISH!', pocket: 'OVER FINISH!', wall: 'OVER FINISH!', draw: 'DRAW!' };

// ---- template ------------------------------------------------------------------------------------

export const spinBattle: Template<SpinBattleParams, State> = {
  id: 'spin-battle',
  name: 'Spin Top Battle',
  family: 'race',
  description:
    'Rendered in 3D: two battle tops are launched into a bowl stadium after a 3-2-1 countdown and clash with sparks until one loses. A top loses by a spin finish (it runs out of spin, wobbles and topples) or an over finish (knocked out through a pocket in the rim or launched over the wall). Each top is a type: Attack (races around the rim, hits hardest, but burns its own spin), Defense (heavy, hard to knock out), Stamina (sits in the middle and outspins everything) or Balance (a bit of everything), in one of three contour designs per type (e.g. Tri-Blade, Sickle and Starburst attack rings); the contours really collide, so hooked blades catch and smooth rims glance off. Types change how a fight looks, but any type can win. Formats: a single duel, a points match (spin finish 1 point, over finish 2, first to the target wins), or a free-for-all (ffa) with 3 or 4 tops (players) of random types, eliminated one at a time until one is left spinning; in a free-for-all the matchup setting doesn\'t apply. Tops are colours, countries with their flag on top, or named tops (e.g. Ember Lynx, Frost Mammoth). Tops spin right (clockwise) or left: same-direction tops slam apart on contact, while opposite-direction tops curl round the bowl in opposite directions, meet head-on and swing round each other (with spins "random", which top spins which way is picked after you write). The deciding blow plays again as an instant replay from a low side angle. Live spin bars show each top\'s RPM. Length: roundLength sets how long a round typically lasts; a duel video runs about roundLength + 10 s, a points match about 3-4 rounds of (0.5 × roundLength + 3) s plus 8 s. It opens on a VS card showing both contenders (name, type, spin direction) for viewers to pick a side, then the tops hang in launchers for a 3-2-1 and drop in when the ripcords are pulled. Never use the word "Beyblade" (a trademark): call them spinning tops or battle tops.',
  schema: spinBattleSchema,
  substeps: 4,
  glowScale: 0.4,
  defaultCopy: {
    hook: 'Which battle top keeps spinning?',
    cta: '{winner} wins! Did you call it?',
  },
  nudges: ['Pick your top 👇', 'Who keeps spinning? Call it 👇', 'Attack or stamina? 👇', 'Lock in your pick 👇', 'Which one goes flying? 👇', 'Comment your champion 👇'],

  init({ params: p, rng, visual }) {
    const n = p.format === 'ffa' ? Number(p.players) : 2;
    const pool = p.identity === 'countries' ? COUNTRY_TEAMS : p.identity === 'named' ? NAMED_TOPS : COLOR_TEAMS;
    const teams = pickDistinctTeams(pool, n, rng, n > 2 ? 110 : 140);
    // Free-for-all: every top's type is random (two of a kind can meet).
    const types = n > 2 ? Array.from({ length: n }, () => rng.pick(TOP_TYPES)) : resolveMatchup(p.matchup, rng);
    const first: 1 | -1 = rng.chance(0.5) ? 1 : -1;
    const dirs: (1 | -1)[] = Array.from({ length: n }, (_, i): 1 | -1 => {
      if (p.spins === 'right') return 1;
      if (p.spins === 'opposite') return i % 2 === 0 ? first : (-first as 1 | -1);
      return i === 0 ? first : rng.chance(0.5) ? 1 : -1;
    });
    const tops = types.map((type, i) => makeTop(i, type, teams[i], dirs[i], pickDesign(type, rng)));
    // Opposite-spin tuning applies when most of a top's opponents spin the other way.
    for (const top of tops) top.vsOpposite = 2 * dirs.filter((d) => d !== top.dir).length > n - 1;
    const pockets: number[] = [];
    const p0 = rng.range(0, Math.PI * 2);
    for (let k = 0; k < p.pockets; k++) pockets.push(p0 + (k / p.pockets) * Math.PI * 2);
    return {
      p,
      rng,
      visual,
      tops,
      arena: { G: K.bowl * p.bowlDepth, pockets, wallLaunch: p.wallLaunch, hold: p.format === 'points' ? K.pointsHold : 1, points: p.format === 'points', ffa: p.format === 'ffa' ? (Number(p.players) - 2) / 2 : 0, chaos: p.format === 'points' ? K.pointsChaos : 1, hitPower: p.hitPower, spin: BASE_ROUND_S / (p.roundLength * (p.format === 'points' ? POINTS_ROUND : 1)) },
      contact: new Map(),
      t: 0,
      simT: 0,
      fightT: 0,
      round: 0,
      score: [0, 0],
      roundOver: false,
      eliminated: [],
      phase: 'countdown',
      phaseAt: 0,
      beats: 0,
      launchAt: 0,
      landAt: -1,
      launchPos: [],
      vsStage: 0,
      pending: [],
      banner: null,
      freezeUntil: 0,
      slow: 1,
      slowTarget: 1,
      slowHoldUntil: 0,
      inThreat: false,
      threatStart: 0,
      threatLastT: 0,
      threatCooldownUntil: 0,
      threatsThisRound: 0,
      leader: -1,
      focusX: 0,
      focusY: 0,
      cam: { x: 0, y: 0, z: 1 },
      shake: 0,
      hits: [],
      track: [],
      winner: -1,
      finishAt: -1,
      finishSimT: -1,
      finishX: 0,
      finishY: 0,
      replayAt: null,
      replayRt: 0,
      endAt: null,
    };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    if (t === 0) startRound(s, t, emit);
    if (s.phase === 'vs') {
      if (s.vsStage === 0) {
        s.vsStage = 1;
        emit({ type: 'vs' });
      }
      if (s.vsStage === 1 && t - s.phaseAt >= VS_SLAM) {
        s.vsStage = 2;
        emit({ type: 'vsSlam' });
        if (s.visual) s.shake = 22;
      }
      if (t - s.phaseAt >= VS_S) {
        s.phase = 'countdown';
        s.phaseAt = t;
      }
    }
    if (s.phase === 'countdown') {
      const due = Math.floor((t - s.phaseAt) / BEAT_S) + 1;
      while (s.beats < Math.min(due, 4)) {
        s.beats++;
        if (s.beats < 4) emit({ type: 'count', n: 4 - s.beats });
      }
      if (t - s.phaseAt >= COUNT_S) {
        // GO: ripcords out, tops fall.
        s.phase = 'drop';
        s.launchAt = t;
        emit({ type: 'launch', round: s.round });
      }
    }
    if (s.phase === 'drop' && t - s.launchAt >= DROP_S) {
      s.phase = 'fight';
      s.landAt = t;
      if (s.visual) s.shake = Math.max(s.shake, 14);
      emit({ type: 'land', round: s.round });
    }
    if (s.phase === 'after' && t - s.phaseAt >= AFTER_S) startRound(s, t, emit);

    // Instant replay: re-play the sounds of the clashes (and the finish) as the replay reaches them.
    if (s.replayAt !== null && t >= s.replayAt && s.endAt !== null && t < s.endAt) {
      if (s.replayRt === s.finishSimT - REPLAY_PRE_S) emit({ type: 'replay' });
      const rt = replayTime(s, t + dt);
      for (const h of s.hits) if (h.simT > s.replayRt && h.simT <= rt) emit({ type: 'replayClash', power: h.power, opp: h.opp, x: h.x });
      if (s.finishSimT > s.replayRt && s.finishSimT <= rt) emit({ type: 'replayFinish', kind: s.banner?.kind ?? 'spin', x: Math.round(s.finishX * 100) / 100 });
      s.replayRt = rt;
    }

    // Time scale: paused for the countdown, frozen on big hits, slowed around finishes.
    if (s.slowHoldUntil > t) s.slowTarget = SLOW;
    else if (!s.inThreat) s.slowTarget = 1;
    s.slow += (s.slowTarget - s.slow) * (1 - dm.exp(-dt * 14));
    const scale = s.phase === 'vs' || s.phase === 'countdown' || s.phase === 'drop' || t < s.freezeUntil ? 0 : s.slow;
    const sdt = dt * scale;
    if (sdt > 0) simulate(s, sdt, t, emit);

    // Camera eases towards the action in slow motion.
    const slowmo = s.slowTarget < 1 || s.slow < 0.9;
    const zoom = slowmo ? 1.35 : 1;
    let fx = slowmo ? s.focusX : 0;
    let fy = slowmo ? s.focusY : 0;
    const d = Math.sqrt(fx * fx + fy * fy);
    if (d > 0.45) {
      fx *= 0.45 / d;
      fy *= 0.45 / d;
    }
    const k = 1 - dm.exp(-dt * 7);
    s.cam.x += (fx - s.cam.x) * k;
    s.cam.y += (fy - s.cam.y) * k;
    s.cam.z += (zoom - s.cam.z) * k;

    if (s.visual) {
      s.shake *= dm.exp(-10 * dt);
      for (const top of s.tops) {
        top.flash *= dm.exp(-9 * sdt);
        if (top.status === 'out') continue;
        const w = top.status === 'spinning' ? top.omega : 0;
        const target = top.wobbling && top.status === 'spinning' ? 0.06 + 0.4 * clamp01((0.24 - top.omega) / 0.24) : 0.03;
        top.tilt += (target - top.tilt) * (1 - dm.exp(-sdt * 4));
        top.precess += (4 + 14 * (1 - w)) * sdt;
      }
      // Recent history for the replay (only needed while a match can still be decided).
      if (sdt > 0 && s.p.replay && s.replayAt === null) {
        s.track.push({ simT: s.simT, tops: s.tops.map((x) => ({ x: x.x, y: x.y, omega: x.omega, status: x.status, wobbling: x.wobbling, outKind: x.outKind, outVx: x.outVx, outVy: x.outVy, outSimT: x.outSimT, spin: x.spin, tilt: x.tilt, precess: x.precess, flash: x.flash })) });
        // Keep about 3 s of sim time (slow motion records many more steps per sim second).
        if (s.track[0].simT < s.simT - 4) s.track.splice(0, s.track.findIndex((x) => x.simT >= s.simT - 3));
      } else if (sdt > 0 && s.replayAt !== null && s.track.length && s.track[s.track.length - 1].simT < s.finishSimT + REPLAY_POST_S) {
        // Keep recording just past the finish so the replay shows the knockout play out.
        s.track.push({ simT: s.simT, tops: s.tops.map((x) => ({ x: x.x, y: x.y, omega: x.omega, status: x.status, wobbling: x.wobbling, outKind: x.outKind, outVx: x.outVx, outVy: x.outVy, outSimT: x.outSimT, spin: x.spin, tilt: x.tilt, precess: x.precess, flash: x.flash })) });
      }
    }
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    return {
      winner: s.winner >= 0 ? nameOf(s.tops[s.winner]) : '',
      score: s.p.format === 'points' ? `${s.score[0]}–${s.score[1]}` : '',
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
    ctx.save();
    if (vsShowing(s)) {
      if (s.shake > 0.3) ctx.translate(dm.sin(s.t * 97) * s.shake, dm.cos(s.t * 71) * s.shake);
      const sl = vsSlide(s);
      // While the halves split apart, the stadium (launchers coming down) shows behind them.
      if (s.phase !== 'vs') drawView(ctx, s, theme);
      drawVsBackground(ctx, s, sl);
      drawShowcase(ctx, s, theme, sl);
    } else if (replaying(s) && s.track.length) {
      const u = (s.t - s.replayAt!) / REPLAY_S;
      const rv = replayView(s, replayTime(s, s.t));
      // Follow the tops (those still on the floor), leaning towards where it was decided.
      const on = rv.tops.filter((x) => x.status !== 'out');
      const mx = on.length ? on.reduce((a, x) => a + x.x, 0) / on.length : s.finishX;
      const my = on.length ? on.reduce((a, x) => a + x.y, 0) / on.length : s.finishY;
      drawView(ctx, s, theme, rv, { x: 0.6 * mx + 0.4 * s.finishX, y: 0.6 * my + 0.4 * s.finishY, angle: 0.3 + 0.4 * u });
    } else {
      if (s.shake > 0.3) ctx.translate(dm.sin(s.t * 97) * s.shake, dm.cos(s.t * 71) * s.shake);
      drawView(ctx, s, theme);
    }
    ctx.restore();
  },

  renderTop({ ctx, theme }, s) {
    drawPanel(ctx, s, theme);
    if (vsShowing(s)) drawVsText(ctx, s, theme, vsSlide(s));
    const cy = 1920 * 0.47;
    // Countdown: 3, 2, 1, GO!
    const since = s.t - s.phaseAt;
    if (s.phase === 'countdown' || s.phase === 'drop' || (s.phase === 'fight' && s.t - s.launchAt < 0.5 && !s.roundOver)) {
      const beat = s.phase === 'countdown' ? Math.min(2, Math.floor(since / BEAT_S)) : 3;
      const local = s.phase === 'countdown' ? since - beat * BEAT_S : s.t - s.launchAt;
      const pop = Math.min(1, local / 0.12);
      const fade = s.phase === 'countdown' ? 1 : Math.max(0, 1 - local / 0.5);
      const text = beat < 3 ? String(3 - beat) : 'GO!';
      textOutlined(ctx, text, 540, cy, (beat < 3 ? 190 : 170) * (0.6 + 0.4 * pop), beat < 3 ? '#ffffff' : theme.accent, 'center', fade);
    }
    if (replaying(s)) {
      drawReplayChrome(ctx, s, theme);
      return;
    }
    // Finish banner.
    if (s.banner && (s.endAt === null || s.t < (s.replayAt ?? s.endAt + 0.2))) {
      const b = s.banner;
      const age = s.t - b.at;
      const pop = Math.min(1, age / 0.15);
      const a = Math.min(1, Math.max(0, ((ffa(s) && b.winner < 0 ? 1.1 : AFTER_S + 0.2) - age) / 0.25));
      textOutlined(ctx, FINISH_TEXT[b.kind], 540, cy - 30, 104 * (0.7 + 0.3 * pop), b.kind === 'spin' ? '#ffffff' : '#ff5a64', 'center', a);
      if (ffa(s) && b.winner < 0) textOutlined(ctx, `${nameOf(s.tops[b.out])} is out · ${b.left} left`, 540, cy + 60, 46, theme.accent, 'center', a * pop);
      else if (ffa(s)) textOutlined(ctx, `${nameOf(s.tops[b.winner])} is the last top spinning!`, 540, cy + 60, fitText(ctx, `${nameOf(s.tops[b.winner])} is the last top spinning!`, 46, 1000), theme.accent, 'center', a * pop);
      else if (b.winner >= 0) textOutlined(ctx, `+${b.points}  ${nameOf(s.tops[b.winner])}`, 540, cy + 60, 52, theme.accent, 'center', a * pop);
    }
    // Crown over the champion in the outro.
    if (s.endAt !== null && s.t >= s.endAt && s.winner >= 0) {
      const top = s.tops[s.winner];
      const pos = screenOf(s, theme, top.x, top.y);
      const bob = Math.sin((s.t - s.endAt) * 6) * 6;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `72px ${FONT_FAMILY}`;
      ctx.fillText('👑', pos.x, pos.y - 110 + bob);
      ctx.restore();
    }
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, (e.x as number) * 0.7)) : 0;
    const note = (vel: number) => melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? vel * 0.45 : vel, voice: theme.voice, pan }));
    switch (e.type) {
      case 'count':
        return [{ kind: 'sfx', name: 'tick', vel: 0.8, pitch: 0.5 }, { kind: 'note', midi: 72, vel: 0.35, voice: 'bell', dur: 0.4 }];
      case 'vs':
        return [
          { kind: 'sfx', name: 'whoosh', vel: 0.55, pitch: 1.1, pan: -0.5 },
          { kind: 'sfx', name: 'whoosh', vel: 0.55, pitch: 1.3, pan: 0.5 },
        ];
      case 'vsSlam':
        return [
          { kind: 'sfx', name: 'boom', vel: 0.9 },
          { kind: 'sfx', name: 'clang', vel: 0.6, pitch: 0.2 },
          { kind: 'sfx', name: 'chime', vel: 0.45, pitch: 0.5 },
        ];
      case 'launch':
        // Every ripcord yanked out (two at most: more just sounds like noise).
        return [
          { kind: 'sfx', name: 'rip', vel: 0.85, pitch: 0.45, pan: -0.4 },
          { kind: 'sfx', name: 'rip', vel: 0.85, pitch: 0.6, pan: 0.4 },
          { kind: 'note', midi: 84, vel: 0.5, voice: 'bell', dur: 0.8 },
        ];
      case 'elim':
        return e.kind === 'spin'
          ? [{ kind: 'sfx', name: 'clack', vel: 0.75, pitch: 0.15, pan }, { kind: 'sfx', name: 'boom', vel: 0.4 }, { kind: 'note', midi: 60 + 3 * (e.left as number), vel: 0.45, voice: 'bell', dur: 1 }]
          : [{ kind: 'sfx', name: 'boom', vel: 0.8, pan }, { kind: 'sfx', name: 'clang', vel: 0.7, pitch: 0.15, pan }, { kind: 'note', midi: 60 + 3 * (e.left as number), vel: 0.45, voice: 'bell', dur: 1 }];
      case 'land':
        return [
          { kind: 'sfx', name: 'boom', vel: 0.75 },
          { kind: 'sfx', name: 'clang', vel: 0.5, pitch: 0.6 },
          ...note(0.6),
        ];
      case 'clash': {
        const v = clamp01((e.power as number) / 5);
        const heavy = (e.power as number) > HEAVY_HIT;
        return [
          // Opposite spins meet with a scrape more than a crash.
          e.opp ? { kind: 'sfx', name: 'grind', vel: 0.5 + 0.4 * v, pitch: 0.3 + 0.5 * v, pan } : { kind: 'sfx', name: 'clang', vel: 0.45 + 0.55 * v, pitch: 0.25 + 0.6 * v, pan },
          ...(e.opp ? [{ kind: 'sfx' as const, name: 'clang' as const, vel: 0.3 + 0.3 * v, pitch: 0.15 + 0.4 * v, pan }] : []),
          ...(heavy ? [{ kind: 'sfx' as const, name: 'boom' as const, vel: 0.35 + 0.35 * v, pan }, { kind: 'sfx' as const, name: 'shatter' as const, vel: 0.25 * v, pitch: 0.8, pan }] : []),
          ...(e.t - lastNoteT >= 0.07 ? note(0.55 + 0.35 * v) : []),
        ];
      }
      case 'replay':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.6, pitch: 0.5 }, { kind: 'sfx', name: 'tick', vel: 0.6, pitch: 0.8 }];
      case 'replayClash': {
        // Slowed-down hits: deeper and heavier than live.
        const v = clamp01((e.power as number) / 5);
        return [
          { kind: 'sfx', name: e.opp ? 'grind' : 'clang', vel: 0.4 + 0.4 * v, pitch: 0.05 + 0.3 * v, pan },
          ...((e.power as number) > HEAVY_HIT ? [{ kind: 'sfx' as const, name: 'boom' as const, vel: 0.5 * v, pan }] : []),
        ];
      }
      case 'replayFinish':
        return [{ kind: 'sfx', name: 'boom', vel: 0.85, pan }, { kind: 'sfx', name: e.kind === 'spin' ? 'clack' : 'clang', vel: 0.7, pitch: 0.05, pan }];
      case 'grind':
        return [{ kind: 'sfx', name: 'grind', vel: 0.35, pitch: 0.5, pan }];
      case 'wall':
        return e.t - lastNoteT >= 0.12 ? note(0.4) : [{ kind: 'sfx', name: 'tick', vel: 0.2, pan }];
      case 'wobble':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.35, pitch: 0.4, pan }];
      case 'threat':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.45, pitch: 0.45 }];
      case 'finish':
        return e.kind === 'spin'
          ? [{ kind: 'sfx', name: 'clack', vel: 0.8, pitch: 0.1, pan }, { kind: 'sfx', name: 'boom', vel: 0.45 }]
          : [{ kind: 'sfx', name: 'boom', vel: 0.9, pan }, { kind: 'sfx', name: 'clang', vel: 0.8, pitch: 0.1, pan }, { kind: 'sfx', name: 'whoosh', vel: 0.5 }];
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
   * Prefer fights that run to length, stay busy, end close (the winner barely spinning, or a 3-2
   * match), include a comeback, and (points) mix spin and over finishes.
   */
  score(events, { durationS, targetS, timedOut }): DramaScore {
    const durFit = gaussFit(durationS, targetS, targetS * 0.2);
    const win = events.find((e) => e.type === 'win');
    if (timedOut || !win) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no winner'] };
    const who = win.who as number;
    const finishes = events.filter((e) => e.type === 'finish');
    const clashes = events.filter((e) => e.type === 'clash');
    const points = win.format === 'points';
    let close: number;
    let comeback = 0;
    if (points) {
      const sc = win.score as number[];
      close = clamp01(sc[1 - who] / Math.max(1, sc[who] - 1));
      for (const f of finishes) {
        const s2 = f.score as number[];
        comeback = Math.max(comeback, clamp01((s2[1 - who] - s2[who]) / 2));
      }
    } else {
      const rpm = win.rpm as number;
      // Spin finish: the winner was nearly done too. Over finish: late and from behind is best.
      const tail = events.some((e) => e.type === 'replay') ? LIVE_TAIL_S + REPLAY_S : 0.6;
      close = win.kind === 'spin' ? clamp01(1 - rpm / 0.45) : clamp01(win.t / Math.max(1, durationS - OUTRO_S - tail) - 0.2);
    }
    for (const c of clashes) {
      // The winner was behind on spin in one of its own clashes.
      const w = c.w as number[];
      const i = c.a === who ? 0 : c.b === who ? 1 : -1;
      if (i >= 0) comeback = Math.max(comeback, clamp01((w[1 - i] - w[i]) / 0.3));
    }
    // Longest stretch with nothing happening, within rounds.
    let lull = 0;
    const launches = events.filter((e) => e.type === 'launch').map((e) => e.t);
    for (const l of launches) {
      const end = finishes.find((f) => f.t >= l)?.t ?? win.t;
      const times = [l, ...clashes.filter((c) => c.t >= l && c.t <= end).map((c) => c.t), end];
      for (let i = 1; i < times.length; i++) lull = Math.max(lull, times[i] - times[i - 1]);
    }
    const lullFit = 1 - clamp01((lull - 3) / 5);
    const clashFit = 1 - dm.exp(-clashes.length / (6 * launches.length));
    const kinds = new Set(finishes.map((f) => (f.kind === 'spin' ? 'spin' : f.kind === 'draw' ? 'draw' : 'over')));
    // Points: a mix of finishes. Free-for-all: eliminations spread through the fight, not bunched.
    let variety = points ? (kinds.has('spin') && kinds.has('over') ? 1 : 0.4) : 1;
    if (win.format === 'ffa') {
      const land = events.find((e) => e.type === 'land')?.t ?? 0;
      const outs = [...events.filter((e) => e.type === 'elim').map((e) => e.t), win.t];
      const gaps = outs.map((x, i) => x - (i ? outs[i - 1] : land));
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      variety = 1 - clamp01((Math.min(...gaps) / Math.max(mean, 0.1) < 0.25 ? 0.6 : 0) + (gaps[0] / Math.max(win.t - land, 1) < 0.1 ? 0.4 : 0));
    }
    const drama = 0.3 * close + 0.2 * comeback + 0.15 * lullFit + 0.2 * clashFit + 0.15 * variety;
    return {
      total: durFit * (0.2 + 0.8 * drama),
      parts: { durFit, close, comeback, lullFit, clashFit, variety },
      notes: [`${clashes.length} clashes`, `${[...events.filter((e) => e.type === 'elim'), ...finishes].map((f) => f.kind).join(', ')}`, `${events.filter((e) => e.type === 'threat').length} slow-motion moments`],
    };
  },
};
