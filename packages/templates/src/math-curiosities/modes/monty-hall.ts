import { FONT_FAMILY, lighten, paletteAt, rgbToCss, type Ctx2D, type NarrationBeat, type RGB, type Theme } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { drawCommentPrompt } from '../../guess';
import { scaleNote } from '../../music';
import { gaussFit } from '../../scoring';
import type { MathParams } from '../params';
import { drawSpoken, fireSays, lineLength, newSpeech, sayAudio, speaking, spokenProgress, type BeatDef, type Speech } from '../speech';
import { OUTRO_DELAY_S, REVEAL_S, caption, clamp01, drawModeTitle, ev, evName, fireCues, fmtInt, outlined, panel, popIn, smooth, type Cue, type ModeImpl } from '../shared';

/**
 * The Monty Hall problem: a car behind one of n doors, goats behind the rest. You pick a door, the
 * host (who knows) opens every other door but one, all goats. Staying wins only if your first pick was
 * right (1/n); switching wins otherwise ((n − 1)/n). One game played slowly, then hundreds per strategy.
 */

interface Game {
  car: number;
  pick: number;
  /** The door the host leaves shut besides yours. */
  other: number;
  /** Opened by the host, in order. */
  opened: number[];
}

export function playGame(n: number, rng: { int(a: number, b: number): number }): Game {
  const car = rng.int(0, n - 1);
  const pick = rng.int(0, n - 1);
  let other = car;
  if (pick === car) {
    other = rng.int(0, n - 2);
    if (other >= pick) other++;
  }
  const opened: number[] = [];
  for (let d = 0; d < n; d++) if (d !== pick && d !== other) opened.push(d);
  return { car, pick, other, opened };
}

type Act1Kind = 'pick' | 'open' | 'ask' | 'answer' | 'race';

interface Act1Cue extends Cue {
  kind: Act1Kind;
  door?: number;
}

interface State {
  p: MathParams;
  n: number;
  game: Game;
  /** Results per strategy, played up front: 1 = won the car. */
  stay: Uint8Array;
  swap: Uint8Array;
  /** Switching's wins over all its games (the answer, known up front). */
  swapTotal: number;
  cues: Act1Cue[];
  cue: number;
  picked: boolean;
  pickedAt: number;
  openAt: number[];
  askAt: number;
  answerAt: number;
  raceAt: number;
  raceTo: number;
  played: number;
  stayWins: number;
  swapWins: number;
  lastBatchT: number;
  batchStay: number;
  batchSwap: number;
  revealAt: number;
  started: boolean;
  revealed: boolean;
  speech: Speech;
  t: number;
}

const M = 'monty-hall';
const COLS = [290, 790];
/** Where a spoken line goes: under the game's headline, and under the race's chart. */
const SAY_Y = { game: 575, race: 1590 };

/** Voiceover beats (see speech.ts). Doors are numbered from 1, as on screen. */
const BEAT: Record<string, BeatDef> = {
  pick: {
    about: 'A game show: a car is behind one of {doors} doors, goats behind the others. You pick door {door}.',
    required: ['doors', 'door'],
    maxWords: 13,
    fallback: ['There’s a car behind one of these {doors} doors. You pick door {door}.', 'A car hides behind one of {doors} doors, goats behind the rest. You take door {door}.'],
  },
  openOne: {
    about: 'The host, who knows where the car is, opens one of the other doors to show a goat.',
    required: [],
    maxWords: 11,
    fallback: ['The host, who knows where the car is, opens a goat door.', 'Now the host opens another door, and shows you a goat.'],
  },
  openMany: {
    about: 'The host, who knows where the car is, opens {opened} of the other doors, all goats, leaving one shut.',
    required: ['opened'],
    maxWords: 11,
    fallback: ['The host opens {opened} of the other doors. Every one’s a goat.', 'Knowing where the car is, the host opens {opened} goat doors.'],
  },
  ask: {
    about: 'The choice: stay with door {door}, or switch to door {other}? Ask the viewer to decide. Do not hint at the answer.',
    required: ['other'],
    maxWords: 9,
    fallback: ['Stay with door {door}, or switch to door {other}?', 'So, do you switch to door {other}, or stay?'],
  },
  answerSwitch: {
    about: 'Both doors open: switching would have won, the car was behind door {car}. Only this one game, so no verdict yet.',
    required: ['car'],
    maxWords: 10,
    fallback: ['Switching wins! The car was behind door {car}.', 'This time it was door {car}, so switching wins.'],
  },
  answerStay: {
    about: 'Both doors open: staying would have won, the car was behind door {car}, the first pick. Only this one game, so no verdict yet.',
    required: ['car'],
    maxWords: 10,
    fallback: ['Staying wins this time. The car was behind door {car}.', 'It’s door {car}! Your first pick was right, this time.'],
  },
  race: {
    about: 'One game proves nothing, so now {games} games are played always staying and {games} always switching, side by side.',
    required: ['games'],
    maxWords: 10,
    fallback: ['One game proves nothing. Let’s play {games} each way.', 'Now let’s play {games} games of each.'],
  },
  reveal: {
    about: 'After all the games, switching won {pct} percent of the time and staying only {stayPct} percent. Switching is better.',
    required: ['pct'],
    maxWords: 13,
    fallback: ['Switching wins {pct} percent of the time, and staying only {stayPct} percent.', 'Switch, and you win {pct} percent of the time. Stay, and it’s only {stayPct}.'],
  },
};

interface PlannedBeat {
  id: string;
  def: BeatDef;
  facts: Record<string, number>;
}

/** This run's voiceover (facts from the slow game and the race's totals). */
function planBeats(p: MathParams, n: number, g: Game, stayWins: number, swapWins: number, played: number): PlannedBeat[] {
  const car = g.car + 1;
  return [
    { id: 'pick', def: BEAT.pick, facts: { doors: n, door: g.pick + 1 } },
    n === 3 ? { id: 'open', def: BEAT.openOne, facts: {} } : { id: 'open', def: BEAT.openMany, facts: { opened: n - 2 } },
    { id: 'ask', def: BEAT.ask, facts: { door: g.pick + 1, other: g.other + 1 } },
    { id: 'answer', def: g.other === g.car ? BEAT.answerSwitch : BEAT.answerStay, facts: { car } },
    { id: 'race', def: BEAT.race, facts: { games: p.games } },
    { id: 'reveal', def: BEAT.reveal, facts: { pct: Math.round((100 * swapWins) / Math.max(1, played)), stayPct: Math.round((100 * stayWins) / Math.max(1, played)) } },
  ];
}

export const montyHallMode: ModeImpl<State> = {
  copy: () => ({ hook: 'Switch doors or stay? Most people get this wrong', cta: '{result} of the time! Would you have switched? 🚪' }),
  searchBudget: 60,
  glowScale: 0.5,

  init({ params: p, rng, narration }) {
    const n = p.doors;
    const game = playGame(n, rng);
    const stay = new Uint8Array(p.games);
    const swap = new Uint8Array(p.games);
    for (let i = 0; i < p.games; i++) {
      const a = playGame(n, rng);
      stay[i] = a.pick === a.car ? 1 : 0;
      const b = playGame(n, rng);
      swap[i] = b.other === b.car ? 1 : 0;
    }
    let swapTotal = 0;
    let stayTotal = 0;
    for (let i = 0; i < p.games; i++) {
      swapTotal += swap[i];
      stayTotal += stay[i];
    }
    const voiced = p.narration === 'on';
    // With a voiceover each beat waits for its line (estimated until the lines are voiced).
    const beats = voiced ? planBeats(p, n, game, stayTotal, swapTotal, p.games) : [];
    const said = (id: string) => {
      const b = beats.find((x) => x.id === id);
      return b ? lineLength(narration, id, b.def) : 0;
    };
    const speech = newSpeech(narration);
    const say = (t: number, beat: string) => beats.some((b) => b.id === beat) && speech.says.push({ t, beat });
    const revealAt = p.durationS - Math.max(REVEAL_S, said('reveal') + 1);
    say(revealAt + 0.25, 'reveal');
    // Act 1 (one slow game) takes about 40% of the video, the race the rest.
    const len = Math.max(7, Math.min(13, revealAt * 0.42));
    // The door is highlighted as the line names it (near its end).
    say(0.3, 'pick');
    const cues: Act1Cue[] = [{ t: Math.max(len * 0.1, voiced ? 0.3 + 0.6 * said('pick') : 0), kind: 'pick', door: game.pick }];
    const openFrom = Math.max(len * 0.22, voiced ? 0.3 + said('pick') + 0.25 : 0);
    say(openFrom, 'open');
    const opened = Math.max(1, game.opened.length);
    game.opened.forEach((door, i) => cues.push({ t: voiced ? openFrom + (0.6 * said('open') * i) / opened : len * (0.22 + (0.2 * i) / opened), kind: 'open', door }));
    const askAt = Math.max(len * 0.45, voiced ? openFrom + said('open') + 0.25 : 0);
    // A moment to decide (the comment prompt is up) before the doors open.
    const answerAt = Math.max(len * 0.78, voiced ? askAt + said('ask') + 1.2 : 0);
    const raceAt = Math.max(len, voiced ? answerAt + said('answer') + 0.3 : 0);
    say(askAt, 'ask');
    say(answerAt, 'answer');
    say(raceAt + 0.3, 'race');
    cues.push({ t: askAt, kind: 'ask' }, { t: answerAt, kind: 'answer' }, { t: raceAt, kind: 'race' });
    return {
      p, n, game, stay, swap, swapTotal, cues, cue: 0, picked: false, pickedAt: -9, openAt: new Array(n).fill(-1), askAt: -9, answerAt: -9,
      raceAt, raceTo: Math.max(revealAt - 0.4, raceAt + 1), played: 0, stayWins: 0, swapWins: 0, lastBatchT: -9, batchStay: 0, batchSwap: 0,
      revealAt, started: false, revealed: false, speech: { ...speech, says: speech.says.sort((a, b) => a.t - b.t) }, t: 0,
    };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    if (!s.started) {
      s.started = true;
      emit({ type: ev(M, 'start'), doors: s.n });
    }
    fireSays(s.speech, M, t, emit);
    fireCues(s.cues, s, t, (c) => {
      if (c.kind === 'pick') {
        s.picked = true;
        s.pickedAt = t;
        emit({ type: ev(M, 'pick'), door: c.door });
      } else if (c.kind === 'open') {
        s.openAt[c.door!] = t;
        emit({ type: ev(M, 'open'), door: c.door });
      } else if (c.kind === 'ask') {
        s.askAt = t;
        emit({ type: ev(M, 'ask') });
      } else if (c.kind === 'answer') {
        s.answerAt = t;
        emit({ type: ev(M, 'answer'), switchWins: s.game.other === s.game.car });
      } else emit({ type: ev(M, 'race'), games: s.p.games });
    });

    if (t >= s.raceAt && s.played < s.p.games) {
      // Slow at first (each game readable), hundreds a second by the end.
      // (A voiceover that overran its estimate can push the race past the reveal: it finishes there.)
      const u = t >= s.revealAt ? 1 : clamp01((t - s.raceAt) / (s.raceTo - s.raceAt));
      const want = u >= 1 ? s.p.games : Math.min(s.p.games, Math.floor((s.p.games * (dm.exp(4 * u) - 1)) / (dm.exp(4) - 1)) + (u > 0 ? 1 : 0));
      while (s.played < want) {
        s.stayWins += s.stay[s.played];
        s.swapWins += s.swap[s.played];
        s.batchStay += s.stay[s.played];
        s.batchSwap += s.swap[s.played];
        s.played++;
      }
      if ((s.batchStay || s.batchSwap || s.played === s.p.games) && t - s.lastBatchT >= 1 / 30 - 1e-9) {
        emit({ type: ev(M, 'games'), played: s.played, stayWins: s.stayWins, swapWins: s.swapWins, newStay: s.batchStay, newSwap: s.batchSwap });
        s.lastBatchT = t;
        s.batchStay = s.batchSwap = 0;
      }
    }
    if (!s.revealed && t >= s.revealAt) {
      s.revealed = true;
      emit({ type: ev(M, 'reveal'), stayWins: s.stayWins, swapWins: s.swapWins, played: s.played, doors: s.n });
    }
  },

  isDone: (s) => s.t >= s.p.durationS,

  hud: (s) => ({
    result: `Switching won ${Math.round((100 * s.swapTotal) / s.p.games)}%`,
    stayWins: s.stayWins,
    switchWins: s.swapWins,
    outro: s.revealed && s.t >= s.revealAt + OUTRO_DELAY_S,
  }),

  render({ ctx, theme }, s) {
    const t = s.t;
    drawModeTitle(ctx, 'The Monty Hall problem');
    // The game fades out, then the race fades in (their headlines share a line).
    const out = smooth((t - s.raceAt) / 0.3);
    const inn = smooth((t - s.raceAt - 0.25) / 0.35);
    if (out < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - out;
      drawAct1(ctx, theme, s);
      ctx.restore();
    }
    if (inn > 0) {
      ctx.save();
      ctx.globalAlpha = inn;
      drawRace(ctx, theme, s);
      ctx.restore();
    }
    // The line being spoken, as a caption: under the game's headline, then under the race's chart.
    const sp = speaking(s.speech, t);
    if (sp) drawSpoken(ctx, theme, sp.line.caption, spokenProgress(sp.since, sp.line.durationS), 540, t < s.raceAt ? SAY_Y.game : SAY_Y.race, { size: 38, maxW: 980 });
  },

  audio(e) {
    switch (evName(e)) {
      case 'start':
      case 'race':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.16 }];
      case 'say':
        return sayAudio(e.clip as string);
      case 'pick':
        return [{ kind: 'sfx', name: 'knock', vel: 0.36 }, { kind: 'note', midi: 67, vel: 0.3, voice: 'marimba', dur: 0.5 }];
      case 'open':
        return [{ kind: 'sfx', name: 'knock', vel: 0.24, pitch: 0.8 }, { kind: 'note', midi: 50, vel: 0.3, voice: 'pluck', dur: 0.4 }];
      case 'ask':
        return [{ kind: 'note', midi: 71, vel: 0.24, voice: 'bell', dur: 1.2 }];
      case 'answer':
        return e.switchWins
          ? [{ kind: 'sfx', name: 'ding', vel: 0.3 }, ...[60, 64, 67].map((midi) => ({ kind: 'note' as const, midi, vel: 0.26, voice: 'bell' as const, dur: 1.4 }))]
          : [{ kind: 'sfx', name: 'pop', vel: 0.3 }, ...[57, 60, 64].map((midi) => ({ kind: 'note' as const, midi, vel: 0.24, voice: 'bell' as const, dur: 1.4 }))];
      case 'games': {
        const played = Math.max(1, e.played as number);
        const out = [];
        if ((e.newStay as number) > 0) out.push({ kind: 'note' as const, midi: scaleNote('pentatonic', 55, Math.round(((e.stayWins as number) / played) * 12)), vel: 0.2, voice: 'marimba' as const, dur: 0.3, pan: -0.45 });
        if ((e.newSwap as number) > 0) out.push({ kind: 'note' as const, midi: scaleNote('pentatonic', 60, Math.round(((e.swapWins as number) / played) * 12)), vel: 0.22, voice: 'kalimba' as const, dur: 0.3, pan: 0.45 });
        return out;
      }
      case 'reveal':
        return [{ kind: 'sfx', name: 'chime', vel: 0.32 }, ...[48, 55, 60, 64].map((midi, i) => ({ kind: 'note' as const, midi, vel: 0.22 + i * 0.02, voice: 'softsine' as const, dur: 3.2 }))];
    }
    return [];
  },

  beats(p, events) {
    const n = p.doors;
    const pick = events.find((e) => e.type === ev(M, 'pick'))?.door as number;
    const opened = events.filter((e) => e.type === ev(M, 'open')).map((e) => e.door as number);
    let other = 0;
    while (other === pick || opened.includes(other)) other++;
    const switchWins = Boolean(events.find((e) => e.type === ev(M, 'answer'))?.switchWins);
    const end = events.find((e) => e.type === ev(M, 'reveal'));
    const game: Game = { car: switchWins ? other : pick, pick, other, opened };
    return planBeats(p, n, game, (end?.stayWins as number) ?? 0, (end?.swapWins as number) ?? 0, (end?.played as number) ?? p.games).map((b): NarrationBeat => ({ id: b.id, ...b.def, facts: b.facts }));
  },

  score(events, { durationS, targetS }) {
    const durFit = gaussFit(durationS, targetS, targetS * 0.3);
    const batches = events.filter((e) => e.type === ev(M, 'games'));
    const end = events.find((e) => e.type === ev(M, 'reveal'));
    const doors = (end?.doors as number) ?? 3;
    const games = Math.max(1, (end?.played as number) ?? 1);
    // Drama: "stay" keeping up (or leading) early on, before switching pulls away.
    let early = 0;
    for (const b of batches) {
      const played = b.played as number;
      if (played < 8 || played > games * 0.15) continue;
      early = Math.max(early, clamp01(((b.stayWins as number) - (b.swapWins as number)) / played / 0.3 + 1));
    }
    const finalFit = gaussFit(((end?.swapWins as number) ?? 0) / games, (doors - 1) / doors, 0.05);
    return { total: 0.35 * durFit + 0.35 * early + 0.3 * finalFit, parts: { durFit, early, finalFit }, notes: [`switch ${end?.swapWins}/${games}, stay ${end?.stayWins}/${games}`] };
  },
};

/** Door rectangles: one row up to five doors, two rows above that. */
function doorLayout(n: number): { x: number; y: number; w: number; h: number }[] {
  const rows = n <= 5 ? 1 : 2;
  const perRow = Math.ceil(n / rows);
  const w = Math.min(176, 940 / perRow - 22);
  const h = w * 1.55;
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = rows === 1 ? 0 : i < perRow ? 0 : 1;
    const inRow = r === 0 ? Math.min(perRow, n) : n - perRow;
    const c = r === 0 ? i : i - perRow;
    const rowW = inRow * (w + 22) - 22;
    const y = rows === 1 ? 960 : r === 0 ? 800 : 800 + h + 90;
    out.push({ x: 540 - rowW / 2 + c * (w + 22), y: y - h / 2, w, h });
  }
  return out;
}

function drawAct1(ctx: Ctx2D, theme: Theme, s: State) {
  const t = s.t;
  const g = s.game;
  const doors = doorLayout(s.n);
  const answered = s.answerAt >= 0 && t >= s.answerAt;
  const switchWins = g.other === g.car;

  // The line at the top says where the game is.
  let line = 'Pick a door…';
  let lineAt = 0;
  let fill = theme.text;
  if (answered) {
    line = switchWins ? 'Switching wins!' : 'Staying wins… this time';
    lineAt = s.answerAt;
    fill = theme.accent;
  } else if (s.askAt >= 0) {
    line = 'Switch or stay?';
    lineAt = s.askAt;
    fill = theme.accent;
  } else if (s.openAt.some((x) => x >= 0)) {
    line = `The host opens ${s.n === 3 ? 'a goat door' : `${s.n - 2} goat doors`}`;
    lineAt = Math.min(...s.openAt.filter((x) => x >= 0));
  } else if (s.picked) {
    line = `You pick door ${g.pick + 1}`;
    lineAt = s.pickedAt;
  }
  outlined(ctx, theme, line, 540, 470, { size: 74, fill, scale: popIn((t - lineAt) / 0.35) * (s.askAt >= 0 && !answered ? 1 + 0.03 * Math.sin(t * 6) : 1) });

  doors.forEach((d, i) => {
    const opensAt = answered && (i === g.pick || i === g.other) ? s.answerAt + (i === g.pick ? 0 : 0.35) : s.openAt[i];
    const open = opensAt >= 0 ? smooth((t - opensAt) / 0.35) : 0;
    const col = paletteAt(theme.palette, 0.15 + (0.7 * i) / Math.max(1, s.n - 1));
    drawDoor(ctx, theme, d, i + 1, open, i === g.car ? '🚗' : '🐐', col, s.picked && i === g.pick, i === g.other && s.askAt >= 0);
  });

  if (answered) {
    const u = t - s.answerAt - 0.6;
    const yy = doors[doors.length - 1].y + doors[doors.length - 1].h + 90;
    caption(ctx, `Stay → ${g.pick === g.car ? 'car 🚗' : 'goat 🐐'}      Switch → ${switchWins ? 'car 🚗' : 'goat 🐐'}`, 540, yy, 38, `rgba(255,255,255,${0.85 * clamp01(u / 0.3)})`, 'center', 900);
  }
  const promptFrom = s.askAt + 0.4;
  const promptTo = s.answerAt >= 0 ? s.answerAt : s.cues.find((c) => c.kind === 'answer')!.t;
  if (s.askAt >= 0 && t >= promptFrom && t < promptTo) drawCommentPrompt(ctx, theme, t - promptFrom, promptTo - t, { x: 540, y: 1585 }, 'Switch or stay? Comment!');
}

function drawDoor(ctx: Ctx2D, theme: Theme, d: { x: number; y: number; w: number; h: number }, num: number, open: number, prize: string, col: RGB, mine: boolean, other: boolean) {
  // Behind the door.
  panel(ctx, d.x, d.y, d.w, d.h, 10, 'rgba(0,0,0,0.5)', 'rgba(255,255,255,0.2)');
  if (open > 0) {
    ctx.save();
    ctx.globalAlpha *= open;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(d.w * 0.55)}px ${FONT_FAMILY}`;
    ctx.fillText(prize, d.x + d.w / 2, d.y + d.h * 0.58);
    ctx.restore();
  }
  // The door swings open (narrows toward its hinge).
  const w = d.w * (1 - 0.86 * open);
  const grad = ctx.createLinearGradient(d.x, d.y, d.x + d.w, d.y + d.h);
  grad.addColorStop(0, rgbToCss(lighten(col, 0.18)));
  grad.addColorStop(1, rgbToCss(col));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(d.x, d.y, w, d.h, 10);
  ctx.fill();
  if (open < 0.6) {
    ctx.globalAlpha *= 1 - open / 0.6;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(d.w * 0.42)}px ${FONT_FAMILY}`;
    ctx.fillText(String(num), d.x + w / 2, d.y + d.h * 0.42);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(d.x + w * 0.82, d.y + d.h * 0.55, Math.max(4, d.w * 0.045), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (mine || other) {
    ctx.strokeStyle = mine ? theme.accent : 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.roundRect(d.x - 8, d.y - 8, d.w + 16, d.h + 16, 16);
    ctx.stroke();
    caption(ctx, mine ? 'YOURS' : 'SWITCH?', d.x + d.w / 2, d.y - 34, Math.min(30, d.w * 0.2), mine ? theme.accent : 'rgba(255,255,255,0.85)', 'center', 900);
  }
}

/** Two strategies side by side: win rate, every game as a cell, and the rates converging below. */
function drawRace(ctx: Ctx2D, theme: Theme, s: State) {
  const t = s.t;
  const games = s.p.games;
  const lanes = [
    { label: 'ALWAYS STAY', wins: s.stayWins, res: s.stay, col: paletteAt(theme.palette, 0.08) },
    { label: 'ALWAYS SWITCH', wins: s.swapWins, res: s.swap, col: paletteAt(theme.palette, 0.6) },
  ];
  const played = s.played;
  if (s.revealed) {
    const pct = Math.round((100 * s.swapWins) / Math.max(1, played));
    outlined(ctx, theme, `Switching wins ${pct}%`, 540, 445, { size: 78, fill: theme.accent, scale: popIn((t - s.revealAt) / 0.4) });
  } else outlined(ctx, theme, `${fmtInt(played)} games each`, 540, 445, { size: 64 });
  const gridTop = 700;
  const gridH = 500;
  const laneW = 440;
  const cols = Math.ceil(Math.sqrt((games * laneW) / gridH));
  const rows = Math.ceil(games / cols);
  const cell = Math.min(laneW / cols, gridH / rows);
  lanes.forEach((lane, li) => {
    const x = COLS[li];
    const better = li === 1 ? s.swapWins >= s.stayWins : s.stayWins > s.swapWins;
    caption(ctx, lane.label, x, 530, 34, rgbToCss(lighten(lane.col, 0.2)), 'center', 900);
    const rate = played ? lane.wins / played : 0;
    outlined(ctx, theme, `${Math.round(rate * 100)}%`, x, 600, { size: 84, fill: better && played > 10 ? theme.accent : theme.text });
    caption(ctx, `${fmtInt(lane.wins)} / ${fmtInt(played)} wins`, x, 662, 28, 'rgba(255,255,255,0.6)', 'center', 800);
    const gw = cols * cell;
    const x0 = x - gw / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (let i = played; i < games; i++) ctx.fillRect(x0 + (i % cols) * cell + 1, gridTop + Math.floor(i / cols) * cell + 1, cell - 2, cell - 2);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    for (let i = 0; i < played; i++) if (!lane.res[i]) ctx.fillRect(x0 + (i % cols) * cell + 1, gridTop + Math.floor(i / cols) * cell + 1, cell - 2, cell - 2);
    ctx.fillStyle = rgbToCss(lighten(lane.col, 0.2));
    for (let i = 0; i < played; i++) if (lane.res[i]) ctx.fillRect(x0 + (i % cols) * cell + 1, gridTop + Math.floor(i / cols) * cell + 1, cell - 2, cell - 2);
  });
  drawRates(ctx, theme, s, lanes.map((l) => ({ res: l.res, col: l.col })));
}

function drawRates(ctx: Ctx2D, theme: Theme, s: State, lanes: { res: Uint8Array; col: RGB }[]) {
  const box = { x: 110, y: 1270, w: 860, h: 230 };
  panel(ctx, box.x - 20, box.y - 20, box.w + 40, box.h + 40, 20, 'rgba(0,0,0,0.3)');
  const games = s.p.games;
  const py = (r: number) => box.y + box.h - r * box.h;
  const px = (i: number) => box.x + (i / games) * box.w;
  const n = s.n;
  ctx.setLineDash([8, 8]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  for (const r of [1 / n, (n - 1) / n]) {
    ctx.beginPath();
    ctx.moveTo(box.x, py(r));
    ctx.lineTo(box.x + box.w, py(r));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  caption(ctx, `1/${n}`, box.x + box.w + 8, py(1 / n), 22, 'rgba(255,255,255,0.5)', 'left', 800);
  caption(ctx, `${n - 1}/${n}`, box.x + box.w + 8, py((n - 1) / n), 22, 'rgba(255,255,255,0.5)', 'left', 800);
  const step = Math.max(1, Math.floor(games / 300));
  lanes.forEach((lane) => {
    ctx.strokeStyle = rgbToCss(lighten(lane.col, 0.2));
    ctx.lineWidth = 4;
    ctx.beginPath();
    let wins = 0;
    for (let i = 0; i < s.played; i++) {
      wins += lane.res[i];
      if (i % step && i !== s.played - 1) continue;
      const x = px(i + 1);
      const y = py(wins / (i + 1));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  caption(ctx, 'games →', box.x + box.w, box.y + box.h + 2, 22, 'rgba(255,255,255,0.35)', 'right', 700);
}
