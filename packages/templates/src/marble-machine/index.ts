import { z } from 'zod';
import { type DramaScore, type Template, type Theme, type VoiceId } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { SONG_FINAL_COUNT, drawCommentPrompt, drawSongCountdown, drawSongProgress, drawSongTitle } from '../guess';
import { gaussFit } from '../scoring';
import { buildTimeline, type Onset } from '../song';
import { planShots, type Shot } from './camera';
import { layoutChannels, type Channel } from './machine';
import { schedule, type Drop, type Note, type Schedule } from './routes';
import { drawMachine3D } from './view3d';

export const MARBLE_MACHINE_CAMERAS = ['director', 'wide'] as const;

export const marbleMachineSchema = z.object({
  camera: z.enum(MARBLE_MACHINE_CAMERAS).default('director').meta({ title: 'Camera (director follows the action, wide shows the whole machine)' }),
  durationS: z.number().min(18).max(60).default(32).meta({ title: 'Length (s)' }),
  bass: z.boolean().default(true).meta({ title: 'Bass marbles' }),
  voice: z.enum(['theme', 'marimba', 'bell', 'pluck', 'glass']).default('marimba').meta({ title: 'Voice' }),
});

export type MarbleMachineParams = z.infer<typeof marbleMachineSchema>;

export interface State {
  p: MarbleMachineParams;
  title: string;
  composer: string;
  onsets: Onset[];
  channels: Channel[];
  sched: Schedule;
  /** Drops in hit order, with a cursor (a [t, t + dt) window would drop hits on float step edges). */
  byHit: Drop[];
  shots: Shot[];
  tempo: number;
  passes: number;
  bassEnterAt: number;
  revealAt: number;
  nextHit: number;
  nextGadget: number;
  lastGadget: Record<string, number>;
  nextCount: number;
  started: boolean;
  bassEntered: boolean;
  revealed: boolean;
  landed: number;
  hueShift: number;
  theme: Theme;
  t: number;
  visual: boolean;
}

/** The first marble lands this far in. */
const LEAD_S = 1.2;
/** Time from the last note to the reveal: the final marble sets off the domino run that rings it. */
const REVEAL_DELAY_S = 2.6;
const REVEAL_S = 3.6;
const OUTRO_DELAY_S = 1.0;
const PROGRESS = { y: 310, w: 600 };
const PROMPT = { x: 560, y: 403 };
const ANSWER_Y = 880;
/** Mechanism sounds are thinned to at most one per this long (per kind), so they never drown the tune. */
const GADGET_GAP_S: Record<string, number> = { clack: 0.2, tip: 0.25, loop: 0.6, domino: 0.12, wheel: 1 };
const GUESS_HOOK = 'Guess the song 🎵';

const pan = (x: number) => Math.max(-0.6, Math.min(0.6, (x / 2.8) * 0.6));

export const marbleMachine: Template<MarbleMachineParams, State> = {
  id: 'marble-machine',
  name: 'Marble Machine',
  family: 'kinetic',
  category: 'machines',
  description:
    'A mystery tune played by a 3D Rube Goldberg marble machine. Pegs on a turning drum release steel marbles into contraptions (a spiral ramp round a column, a pair of tipping seesaws, a loop-the-loop with a jump, zigzag rails, or a straight drop), and each one leaps onto its vibraphone bar exactly on its note. Spent marbles hop into a trough, turn a paddle wheel and ride a bucket elevator back to the top. Partway through, a lever opens the hopper for heavier bass marbles. The final note\'s marble sets off a domino run that rings a bell as the song\'s title is revealed. The camera (director) opens wide, follows marbles through the contraptions and tracks the dominoes; wide keeps the whole machine in view.',
  schema: marbleMachineSchema,
  lengthParam: { param: 'durationS', offsetS: 0 },
  searchBudget: 6,
  melodyDriven: true,
  glowScale: 0.45,
  defaultCopy: {
    hook: GUESS_HOOK,
    cta: 'It was {answer}! Did you get it? 🎵',
  },
  nudges: ['Name that tune 👇', 'Got it yet? Comment 👇', 'How many notes did you need? 👇', 'Drop your guess before the reveal 👇', 'Know this song? 👇', 'Lock in your answer 👇'],
  nudgeY: 0.21,

  init({ params: p, rng, visual, melody, theme }) {
    const span = Math.max(4, p.durationS - LEAD_S - REVEAL_DELAY_S - REVEAL_S);
    const { onsets, tempo, passes } = buildTimeline(melody, LEAD_S, span);
    const notes: Note[] = onsets.map((o, i) => ({ i, t: o.t, dur: o.dur, midi: o.midi, bass: false }));

    // The bass joins on the second time through the tune, or halfway if it plays once (as in Bounce
    // Keys), an octave down so it sits under the tune.
    let bassEnterAt = Infinity;
    if (p.bass) {
      const second = onsets.find((o) => o.pass === 1);
      const from = second ? second.t : LEAD_S + span * 0.45;
      const timed = onsets.filter((o) => o.bass.length && o.t >= from + 0.6);
      timed.forEach((o, k) => {
        const end = k + 1 < timed.length ? timed[k + 1].t : o.t + o.dur;
        notes.push({ i: -1, t: o.t, dur: end - o.t, midi: o.bass[0] >= 48 ? o.bass[0] - 12 : o.bass[0], bass: true });
      });
      if (timed.length) bassEnterAt = timed[0].t - 3.5;
    }
    const channels = layoutChannels(
      notes.map((n) => n.midi),
      new Set(notes.filter((n) => n.bass).map((n) => n.midi)),
    );
    const last = onsets[onsets.length - 1];
    const revealAt = last.t + REVEAL_DELAY_S;
    const sched = schedule(notes, channels, rng, revealAt);
    // The bass lever is thrown just before the first bass marble leaves the drum.
    const firstBass = sched.drops.filter((d) => d.bass).sort((a, b) => a.release - b.release)[0];
    if (firstBass) bassEnterAt = Math.max(0.5, firstBass.release - 0.6);
    const byHit = [...sched.drops].sort((a, b) => a.t - b.t || a.i - b.i);
    return {
      p,
      title: melody.title,
      composer: melody.composer,
      onsets,
      channels,
      sched,
      byHit,
      shots: planShots(sched, last.t, revealAt, p.camera),
      tempo,
      passes,
      bassEnterAt,
      revealAt,
      nextHit: 0,
      nextGadget: 0,
      lastGadget: {},
      nextCount: SONG_FINAL_COUNT,
      started: false,
      bassEntered: false,
      revealed: false,
      landed: 0,
      hueShift: rng.next(),
      theme,
      t: 0,
      visual,
    };
  },

  step(s, { dt, t, emit }) {
    const end = t + dt;
    if (!s.started) {
      s.started = true;
      const routes: Record<string, number> = {};
      for (const d of s.sched.drops) routes[d.route] = (routes[d.route] ?? 0) + 1;
      emit({ type: 'start', tempo: s.tempo, passes: s.passes, notes: s.onsets.length, marbles: s.sched.drops.length, ...routes });
    }
    while (s.nextHit < s.byHit.length && s.byHit[s.nextHit].t < end) {
      const d = s.byHit[s.nextHit++];
      const c = s.channels[d.ch];
      const voice = s.p.voice === 'theme' ? {} : { voice: s.p.voice };
      if (d.bass) emit({ type: 'bassLand', midi: d.midi, dur: d.dur, pan: pan(c.x) });
      else {
        s.landed++;
        emit({ type: 'land', i: d.i, midi: d.midi, dur: d.dur, accent: s.onsets[d.i].bass.length > 0, route: d.route, pan: pan(c.x), ...voice });
      }
    }
    const ev = s.sched.events;
    while (s.nextGadget < ev.length && ev[s.nextGadget].t < end) {
      const g = ev[s.nextGadget++];
      if (g.t - (s.lastGadget[g.kind] ?? -10) < GADGET_GAP_S[g.kind] || g.t > s.revealAt + 0.05) continue;
      s.lastGadget[g.kind] = g.t;
      emit({ type: 'gadget', kind: g.kind, pan: pan(g.x) });
    }
    if (!s.bassEntered && s.bassEnterAt < end) {
      s.bassEntered = true;
      emit({ type: 'bassEnter' });
    }
    while (s.nextCount > 0 && s.revealAt - s.nextCount < end) {
      if (s.revealAt - s.nextCount >= s.onsets[0].t) emit({ type: 'count', n: s.nextCount });
      s.nextCount--;
    }
    if (!s.revealed && s.revealAt < end) {
      s.revealed = true;
      emit({ type: 'reveal' });
    }
    s.t = end;
  },

  isDone(s) {
    return s.t >= s.revealAt + REVEAL_S;
  },

  hud(s) {
    return { answer: s.title, composer: s.composer, notes: s.landed, outro: s.t >= s.revealAt + OUTRO_DELAY_S };
  },

  overlays(_p, copy) {
    // The question stays up for the whole tune and hands over to the CTA (same spot) at the reveal.
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 600, y: 0.12, untilOutro: true },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.12 },
    ];
  },

  render({ ctx, theme, t }, s) {
    drawMachine3D(ctx, theme, s, t);
  },

  renderTop({ ctx, theme, t }, s) {
    const clock = { first: s.onsets[0].t, revealAt: s.revealAt, t };
    drawSongProgress(ctx, theme, clock, { y: PROGRESS.y, w: PROGRESS.w, outroDelay: OUTRO_DELAY_S });
    drawSongCountdown(ctx, theme, clock, { labelY: PROGRESS.y + 40, bigY: ANSWER_Y });
    if (t >= s.revealAt) {
      drawSongTitle(ctx, theme, s.title, s.composer, t - s.revealAt - 0.2, ANSWER_Y);
      return;
    }
    const first = s.onsets[0].t;
    const promptFrom = first + (s.revealAt - first) * 0.5;
    if (t >= promptFrom) drawCommentPrompt(ctx, theme, t - promptFrom, s.revealAt - t, PROMPT);
  },

  audio(e, { theme }) {
    const p = typeof e.pan === 'number' ? e.pan : 0;
    switch (e.type) {
      case 'land': {
        // Notes are held for their written length (a little more, so they ring into the next).
        const dur = Math.max(0.25, Math.min(2.5, (e.dur as number) * 1.6));
        const voice: VoiceId = (e.voice as VoiceId | undefined) ?? theme.voice;
        return [{ kind: 'note', midi: e.midi as number, vel: e.accent ? 0.82 : 0.66, voice, dur, pan: p }];
      }
      case 'bassLand': {
        const dur = Math.max(0.4, Math.min(3, (e.dur as number) * 1.2));
        return [
          { kind: 'note', midi: e.midi as number, vel: 0.5, voice: 'softsine', dur, pan: p },
          { kind: 'note', midi: (e.midi as number) + 12, vel: 0.18, voice: 'pluck', dur: 0.5, pan: p },
        ];
      }
      case 'gadget':
        switch (e.kind) {
          case 'tip':
            return [{ kind: 'sfx', name: 'clack', vel: 0.12, pitch: 0.6, pan: p }];
          case 'clack':
            return [{ kind: 'sfx', name: 'clack', vel: 0.07, pan: p }];
          case 'loop':
            return [{ kind: 'sfx', name: 'whoosh', vel: 0.12, pan: p }];
          case 'domino':
            return [{ kind: 'sfx', name: 'tick', vel: 0.2, pitch: 1.4, pan: p }];
        }
        return [];
      case 'count':
        return [{ kind: 'sfx', name: 'tick', vel: e.n === 1 ? 0.7 : 0.5 }];
      case 'bassEnter':
        return [
          { kind: 'sfx', name: 'clang', vel: 0.25, pitch: 0.7 },
          { kind: 'sfx', name: 'whoosh', vel: 0.35 },
        ];
      case 'reveal':
        return [
          { kind: 'sfx', name: 'chime', vel: 0.9 },
          { kind: 'sfx', name: 'whoosh', vel: 0.5 },
        ];
    }
    return [];
  },

  score(events, { durationS, targetS }): DramaScore {
    const start = events.find((e) => e.type === 'start');
    const lands = events.filter((e) => e.type === 'land').length;
    const durFit = gaussFit(durationS, targetS, targetS * 0.18);
    if (!start || !lands) return { total: 0, parts: { durFit }, notes: ['no notes played'] };
    const tempoFit = gaussFit(dm.log(start.tempo as number), 0, 0.25);
    const rate = lands / durationS;
    const densityFit = rate < 1 ? rate : rate > 7 ? dm.exp(-(rate - 7) / 3) : 1;
    // Plenty of marbles through the contraptions (not just straight drops) makes the better machine.
    const showpieces = ((start.loop as number) ?? 0) + ((start.seesaw as number) ?? 0) + ((start.helix as number) ?? 0);
    const showFit = Math.min(1, showpieces / Math.max(6, lands * 0.3));
    const total = durFit * (0.7 + 0.3 * tempoFit) * (0.8 + 0.2 * densityFit) * (0.8 + 0.2 * showFit);
    return {
      total,
      parts: { durFit, tempoFit, densityFit, showFit },
      notes: [`${lands} notes, ${start.passes} pass${start.passes === 1 ? '' : 'es'}`, `tempo ×${(start.tempo as number).toFixed(2)}`, `${showpieces} through contraptions`],
    };
  },
};
