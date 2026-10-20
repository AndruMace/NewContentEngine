import { lighten, paletteAt, rgbToCss, type Ctx2D, type Theme } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { drawCommentPrompt } from '../../guess';
import { scaleNote } from '../../music';
import { gaussFit } from '../../scoring';
import type { MathParams } from '../params';
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

export const birthdayMode: ModeImpl<State> = {
  copy: () => ({ hook: 'How many people until two share a birthday?', cta: 'A shared birthday after just {result} 🎂 Lower than you guessed?' }),
  searchBudget: 60,
  glowScale: 0.5,

  init({ params: p, rng }) {
    const rooms = Array.from({ length: p.rooms }, () => fillRoom(rng));
    const revealAt = p.durationS - REVEAL_S;
    // Each room: a beat to clear the calendar, people arriving (the first few slower), then a hold on
    // the match. Leftover time (rooms that matched early) goes to the holds.
    const weights = rooms.map((room) => room.map((_, i) => 1 + 1.5 * dm.exp(-i / 3)));
    const sumW = weights.flat().reduce((a, b) => a + b, 0);
    const people = Math.max(1, revealAt - FIRST_S - rooms.length * (ROOM_IN_S + MATCH_HOLD_S));
    const base = Math.min(0.5, people / sumW);
    const extraHold = (people - base * sumW) / rooms.length;
    const cues: RoomCue[] = [];
    let at = FIRST_S;
    rooms.forEach((room, r) => {
      cues.push({ t: at, kind: 'room', r, i: 0 });
      at += ROOM_IN_S;
      room.forEach((_, i) => {
        cues.push({ t: at, kind: 'person', r, i });
        at += base * weights[r][i];
      });
      at += MATCH_HOLD_S + extraHold;
    });
    return {
      p, rooms, cues, cue: 0, r: -1, k: 0, roomAt: -9, lastPersonT: -9, filledAt: new Float64Array(365).fill(-1), matchAt: -9,
      results: [], revealAt, started: false, revealed: false, hue: rng.next(), t: 0,
    };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    if (!s.started) {
      s.started = true;
      emit({ type: ev(M, 'start'), rooms: s.rooms.length });
    }
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
    if (s.revealed) {
      const u = t - s.revealAt;
      const big = counts.length === 1 ? `${counts[0]} PEOPLE` : counts.join(' · ');
      outlined(ctx, theme, big, 540, 450, { size: big.length > 14 ? 88 : 110, fill: theme.accent, scale: popIn(u / 0.4) });
      caption(ctx, 'Just 23 people gives a 50% chance', 540, 548, 36, `rgba(255,255,255,${0.8 * clamp01((u - 0.3) / 0.3)})`, 'center', 900);
    } else {
      const hit = flash(t - s.lastPersonT, 8);
      outlined(ctx, theme, `${s.k} ${s.k === 1 ? 'PERSON' : 'PEOPLE'}`, 540, 450, { size: 104, scale: 1 + 0.06 * hit });
      const parts = [s.rooms.length > 1 && s.r >= 0 ? `ROOM ${s.r + 1} OF ${s.rooms.length}` : '', s.results.length ? `matched at ${s.results.join(' · ')}` : ''].filter(Boolean);
      if (parts.length) caption(ctx, parts.join('   ·   '), 540, 548, 32, 'rgba(255,255,255,0.6)', 'center', 900);
    }
    drawCalendar(ctx, theme, s);
    if (t >= PROMPT.from && t < PROMPT.to) drawCommentPrompt(ctx, theme, t - PROMPT.from, PROMPT.to - t, { x: 540, y: PROMPT.y });
  },

  audio(e) {
    switch (evName(e)) {
      case 'start':
      case 'room':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.15 }];
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
