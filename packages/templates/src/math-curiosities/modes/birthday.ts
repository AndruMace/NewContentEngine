import { lighten, paletteAt, rgbToCss, type Ctx2D, type NarrationBeat, type Theme } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { drawCommentPrompt } from '../../guess';
import { scaleNote } from '../../music';
import { gaussFit } from '../../scoring';
import type { MathParams } from '../params';
import { drawSpoken, fireSays, lineLength, newSpeech, sayAudio, speaking, spokenProgress, type BeatDef, type Speech } from '../speech';
import { OUTRO_DELAY_S, REVEAL_S, caption, clamp01, drawModeTitle, ev, evName, fireCues, flash, outlined, popIn, smooth, type Cue, type ModeImpl } from '../shared';

/**
 * The birthday paradox: people walk into a room one at a time, each with a random birthday (365
 * equally likely days), until two share one. It takes 23 people for even odds, far fewer than most
 * guess. Every room is drawn up front (integers only), so the video can be timed to its length.
 */

export const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Day of the year (0..364) → [month 0..11, day 0..30]. */
export function monthDay(d: number): [number, number] {
  let m = 0;
  while (d >= MONTH_DAYS[m]) d -= MONTH_DAYS[m++];
  return [m, d];
}

/** Birthdays of one room, up to and including the first shared one. */
export function fillRoom(rng: { int(a: number, b: number): number }): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (;;) {
    const d = rng.int(0, 364);
    out.push(d);
    if (seen.has(d)) return out;
    seen.add(d);
  }
}

interface RoomCue extends Cue {
  kind: 'room' | 'person';
  r: number;
  i: number;
}

interface State {
  p: MathParams;
  rooms: number[][];
  cues: RoomCue[];
  cue: number;
  r: number;
  /** People in the current room so far. */
  k: number;
  roomAt: number;
  lastPersonT: number;
  /** When each day of the current room was filled (-1 = empty). */
  filledAt: Float64Array;
  matchAt: number;
  results: number[];
  revealAt: number;
  started: boolean;
  revealed: boolean;
  speech: Speech;
  hue: number;
  t: number;
}

const M = 'birthday';
const ROOM_IN_S = 0.5;
const MATCH_HOLD_S = 1.4;
const FIRST_S = 1.0;
const GRID = { x: 60, y: 640, colW: 80, rowH: 25.8 };
/** The guess prompt, up while the first people walk in (before a lucky early match can spoil it). */
const PROMPT = { from: 0.9, to: 3.7, y: 1585 };

/** Voiceover beats (see speech.ts). The first room is narrated; the others play under the match line. */
const BEAT: Record<string, BeatDef> = {
  intro: {
    about: 'People walk into a room one at a time, each with a random birthday. The question: how many until two share a birthday? Ask the viewer to guess.',
    required: [],
    maxWords: 17,
    fallback: ['One by one, people walk into a room. How many until two of them share a birthday?', 'Let’s fill a room with people. When do two of them share a birthday?'],
  },
  arrivals: {
    about: 'Each person lights up their birthday on a calendar of {days} days. With that many days, a match feels a long way off.',
    required: ['days'],
    maxWords: 12,
    fallback: ['Each person lights up their birthday, out of {days} days.', 'With {days} possible birthdays, a match should take ages… right?'],
  },
  match: {
    about: 'Two people in the room share a birthday, after {count} people walked in.',
    required: ['count'],
    maxWords: 11,
    fallback: ['A match! After just {count} people.', 'There it is, a shared birthday, {count} people in.'],
  },
  revealOne: {
    about: 'It took {count} people for two to share a birthday. In fact just {half} people give a {odds} percent chance of a match.',
    required: ['half', 'odds'],
    maxWords: 18,
    fallback: ['It took {count} people! In fact, just {half} people give a {odds} percent chance of a match.', 'Just {half} people give you a {odds} percent chance. Surprised?'],
  },
  revealMany: {
    about: 'Across {rooms} rooms, a shared birthday turned up after {fewest} to {most} people. In fact just {half} people give a {odds} percent chance of a match.',
    required: ['half', 'odds'],
    maxWords: 18,
    fallback: ['Every room found a match within {most} people. Just {half} people give a {odds} percent chance.', 'Just {half} people give you a {odds} percent chance. Surprised?'],
  },
};

interface PlannedBeat {
  id: string;
  def: BeatDef;
  facts: Record<string, number>;
}

/** This run's voiceover (facts from the rooms' match counts). */
function planBeats(counts: number[]): PlannedBeat[] {
  const end = { half: 23, odds: 50 };
  return [
    { id: 'intro', def: BEAT.intro, facts: {} },
    { id: 'arrivals', def: BEAT.arrivals, facts: { days: 365 } },
    { id: 'match', def: BEAT.match, facts: { count: counts[0] } },
    counts.length === 1
      ? { id: 'reveal', def: BEAT.revealOne, facts: { count: counts[0], ...end } }
      : { id: 'reveal', def: BEAT.revealMany, facts: { rooms: counts.length, fewest: Math.min(...counts), most: Math.max(...counts), ...end } },
  ];
}

export const birthdayMode: ModeImpl<State> = {
  copy: () => ({ hook: 'How many people until two share a birthday?', cta: 'A shared birthday after just {result} 🎂 Lower than you guessed?' }),
  searchBudget: 60,
  glowScale: 0.5,

  init({ params: p, rng, narration }) {
    const rooms = Array.from({ length: p.rooms }, () => fillRoom(rng));
    const voiced = p.narration === 'on';
    // With a voiceover each beat waits for its line (estimated until the lines are voiced).
    const beats = voiced ? planBeats(rooms.map((r) => r.length)) : [];
    const said = (id: string) => {
      const b = beats.find((x) => x.id === id);
      return b ? lineLength(narration, id, b.def) : 0;
    };
    const speech = newSpeech(narration);
    const say = (t: number, beat: string) => beats.some((b) => b.id === beat) && speech.says.push({ t, beat });
    const revealAt = p.durationS - Math.max(REVEAL_S, said('reveal') + 1);
    say(revealAt + 0.25, 'reveal');
    say(0.3, 'intro');
    const first = Math.max(FIRST_S, voiced ? 0.3 + said('intro') + 0.2 : 0);
    // Each room: a beat to clear the calendar, people arriving (the first few slower), then a hold on
    // the match. Leftover time (rooms that matched early) goes to the holds.
    const weights = rooms.map((room) => room.map((_, i) => 1 + 1.5 * dm.exp(-i / 3)));
    const sumW = weights.flat().reduce((a, b) => a + b, 0);
    // Voiced, the first room's match waits for the arrivals line, and its hold for the match line.
    const firstHold = voiced ? Math.max(0, said('match') + 0.3 - MATCH_HOLD_S) : 0;
    const people = Math.max(1, revealAt - first - rooms.length * (ROOM_IN_S + MATCH_HOLD_S) - firstHold);
    let base = Math.min(0.5, people / sumW);
    const preMatch = weights[0].slice(0, -1).reduce((a, b) => a + b, 0);
    const arrivals = voiced ? said('arrivals') + 0.3 : 0;
    // Stretch the first room's arrivals (the rest share what's left).
    const stretch = base * preMatch < arrivals;
    const firstBase = stretch ? arrivals / preMatch : base;
    if (stretch) base = Math.min(0.5, Math.max(0, people - arrivals) / (sumW - preMatch));
    const extraHold = stretch ? (people - arrivals - base * (sumW - preMatch)) / rooms.length : (people - base * sumW) / rooms.length;
    const cues: RoomCue[] = [];
    let at = first;
    rooms.forEach((room, r) => {
      cues.push({ t: at, kind: 'room', r, i: 0 });
      at += ROOM_IN_S;
      room.forEach((_, i) => {
        cues.push({ t: at, kind: 'person', r, i });
        if (r === 0 && i === 0) say(at, 'arrivals');
        if (r === 0 && i === room.length - 1) say(at, 'match');
        at += (r === 0 && i < room.length - 1 ? firstBase : base) * weights[r][i];
      });
      at += MATCH_HOLD_S + extraHold + (r === 0 ? firstHold : 0);
    });
    return {
      p, rooms, cues, cue: 0, r: -1, k: 0, roomAt: -9, lastPersonT: -9, filledAt: new Float64Array(365).fill(-1), matchAt: -9,
      results: [], revealAt, started: false, revealed: false, speech: { ...speech, says: speech.says.sort((a, b) => a.t - b.t) }, hue: rng.next(), t: 0,
    };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    if (!s.started) {
      s.started = true;
      emit({ type: ev(M, 'start'), rooms: s.rooms.length });
    }
    fireSays(s.speech, M, t, emit);
    fireCues(s.cues, s, t, (c) => {
      if (c.kind === 'room') {
        s.r = c.r;
        s.k = 0;
        s.roomAt = t;
        s.matchAt = -9;
        s.filledAt.fill(-1);
        emit({ type: ev(M, 'room'), r: c.r });
        return;
      }
      const room = s.rooms[c.r];
      const day = room[c.i];
      const [month] = monthDay(day);
      s.k = c.i + 1;
      s.lastPersonT = t;
      if (c.i === room.length - 1) {
        s.matchAt = t;
        s.results.push(room.length);
        emit({ type: ev(M, 'match'), r: c.r, count: room.length, day, month });
      } else {
        s.filledAt[day] = t;
        emit({ type: ev(M, 'person'), r: c.r, i: c.i, day, month });
      }
    });
    if (!s.revealed && t >= s.revealAt) {
      s.revealed = true;
      emit({ type: ev(M, 'reveal'), counts: s.rooms.map((r) => r.length).join(',') });
    }
  },

  isDone: (s) => s.t >= s.p.durationS,

  hud: (s) => ({ result: resultOf(s.rooms.map((r) => r.length)), people: s.k, outro: s.revealed && s.t >= s.revealAt + OUTRO_DELAY_S }),

  render({ ctx, theme }, s) {
    const t = s.t;
    drawModeTitle(ctx, 'The birthday paradox');
    const counts = s.rooms.map((r) => r.length);
    // A line being spoken takes the slot under the headline, as a caption.
    const said = speaking(s.speech, t);
    if (said) drawSpoken(ctx, theme, said.line.caption, spokenProgress(said.since, said.line.durationS), 540, 548, { size: 36, maxW: 980 });
    if (s.revealed) {
      const u = t - s.revealAt;
      const big = counts.length === 1 ? `${counts[0]} PEOPLE` : counts.join(' · ');
      outlined(ctx, theme, big, 540, 450, { size: big.length > 14 ? 88 : 110, fill: theme.accent, scale: popIn(u / 0.4) });
      if (!said) caption(ctx, 'Just 23 people gives a 50% chance', 540, 548, 36, `rgba(255,255,255,${0.8 * clamp01((u - 0.3) / 0.3)})`, 'center', 900);
    } else {
      const hit = flash(t - s.lastPersonT, 8);
      outlined(ctx, theme, `${s.k} ${s.k === 1 ? 'PERSON' : 'PEOPLE'}`, 540, 450, { size: 104, scale: 1 + 0.06 * hit });
      const parts = [s.rooms.length > 1 && s.r >= 0 ? `ROOM ${s.r + 1} OF ${s.rooms.length}` : '', s.results.length ? `matched at ${s.results.join(' · ')}` : ''].filter(Boolean);
      if (parts.length && !said) caption(ctx, parts.join('   ·   '), 540, 548, 32, 'rgba(255,255,255,0.6)', 'center', 900);
    }
    drawCalendar(ctx, theme, s);
    if (t >= PROMPT.from && t < PROMPT.to) drawCommentPrompt(ctx, theme, t - PROMPT.from, PROMPT.to - t, { x: 540, y: PROMPT.y });
  },

  audio(e) {
    switch (evName(e)) {
      case 'start':
      case 'room':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.15 }];
      case 'say':
        return sayAudio(e.clip as string);
      case 'person': {
        const m = e.month as number;
        return [{ kind: 'note', midi: scaleNote('major', 60, m), vel: 0.34, voice: 'kalimba', dur: 0.45, pan: (m / 11) * 1.0 - 0.5 }];
      }
      case 'match':
        return [
          { kind: 'sfx', name: 'ding', vel: 0.34 },
          { kind: 'sfx', name: 'boom', vel: 0.22 },
          ...[60, 64, 67, 72].map((midi) => ({ kind: 'note' as const, midi, vel: 0.26, voice: 'bell' as const, dur: 1.6 })),
        ];
      case 'reveal':
        return [48, 55, 60, 64].map((midi, i) => ({ kind: 'note' as const, midi, vel: 0.22 + i * 0.02, voice: 'softsine' as const, dur: 3.2 }));
    }
    return [];
  },

  beats(_p, events) {
    const counts = events.filter((e) => e.type === ev(M, 'match')).map((e) => e.count as number);
    return planBeats(counts.length ? counts : [23]).map((b): NarrationBeat => ({ id: b.id, ...b.def, facts: b.facts }));
  },

  score(events, { durationS, targetS }) {
    const durFit = gaussFit(durationS, targetS, targetS * 0.3);
    const counts = events.filter((e) => e.type === ev(M, 'match')).map((e) => e.count as number);
    if (!counts.length) return { total: 0, parts: { durFit, surprise: 0, spread: 0 } };
    const lo = Math.min(...counts);
    const hi = Math.max(...counts);
    // A surprisingly early match is the hook; different rooms landing far apart shows the randomness.
    const surprise = gaussFit(lo, 14, 7);
    const spread = counts.length > 1 ? clamp01((hi - lo) / 25) : surprise;
    return { total: 0.4 * durFit + 0.35 * surprise + 0.25 * spread, parts: { durFit, surprise, spread }, notes: [`rooms ${counts.join(' · ')}`] };
  },
};

function resultOf(counts: number[]): string {
  if (counts.length === 1) return `${counts[0]} people`;
  return `${counts.slice(0, -1).join(', ')} and ${counts[counts.length - 1]} people`;
}

/** Twelve month columns of day cells; filled days in the month's colour, the shared day flashing. */
function drawCalendar(ctx: Ctx2D, theme: Theme, s: State) {
  const t = s.t;
  const { x, y, colW, rowH } = GRID;
  const clear = s.r >= 0 ? smooth((t - s.roomAt) / ROOM_IN_S) : 1;
  const room = s.r >= 0 ? s.rooms[s.r] : null;
  const matchDay = room && s.matchAt >= 0 ? room[room.length - 1] : -1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let d = 0;
  for (let m = 0; m < 12; m++) {
    const col = paletteAt(theme.palette, (s.hue + m / 12) % 1);
    caption(ctx, MONTHS[m][0], x + m * colW + colW / 2, y - 24, 26, 'rgba(255,255,255,0.5)', 'center', 900);
    for (let day = 0; day < MONTH_DAYS[m]; day++, d++) {
      const cx = x + m * colW + 4;
      const cy = y + day * rowH + 2;
      const at = s.filledAt[d];
      if (d === matchDay) {
        const u = t - s.matchAt;
        const pulse = 0.5 + 0.5 * Math.cos(u * 9);
        ctx.fillStyle = rgbToCss(lighten(col, 0.3 + 0.4 * pulse));
        ctx.beginPath();
        ctx.roundRect(cx - 4, cy - 3, colW, rowH + 2, 6);
        ctx.fill();
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 4;
        ctx.stroke();
        continue;
      }
      if (at >= 0) {
        const k = popIn((t - at) / 0.25);
        const w = (colW - 8) * k;
        const h = (rowH - 4) * k;
        ctx.fillStyle = rgbToCss(lighten(col, 0.5 * flash(t - at, 6)), 0.95);
        ctx.beginPath();
        ctx.roundRect(cx + (colW - 8 - w) / 2, cy + (rowH - 4 - h) / 2, w, h, 5);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(255,255,255,${0.06 * clear})`;
        ctx.beginPath();
        ctx.roundRect(cx, cy, colW - 8, rowH - 4, 5);
        ctx.fill();
      }
    }
  }
  if (matchDay >= 0) {
    const [m, day] = monthDay(matchDay);
    const u = t - s.matchAt;
    outlined(ctx, theme, `MATCH! Both born ${MONTHS[m]} ${day + 1}`, 540, 1505, { size: 50, fill: theme.accent, scale: popIn(u / 0.3) });
  }
}
