import { z } from 'zod';
import { Rng, type AudioEventInput, type DramaScore, type Template, type Theme } from '@sim/engine';
import { clamp01, gaussFit } from '../scoring';
import { buildTimeline, type Onset } from '../song';
import { generate, type Stage } from './generate';
import { DT, STEPS_PER_FRAME, type BodyRec, type Piece, type TapeEvent } from './sim';
import { BACKDROPS, drawRube3D } from './view3d';

export const rubeGoldbergSchema = z.object({
  durationS: z.number().min(18).max(60).default(30).meta({ title: 'Length (s)' }),
  marbles: z.enum(['glass', 'steel', 'mixed']).default('glass').meta({ title: 'Marbles' }),
  backdrop: z.enum(BACKDROPS).default('plywood').meta({ title: 'Backdrop (the wall behind the run)' }),
});

export type RubeGoldbergParams = z.infer<typeof rubeGoldbergSchema>;

export interface State {
  p: RubeGoldbergParams;
  stages: Stage[];
  statics: Piece[];
  bodies: BodyRec[];
  frames: Float32Array[];
  /** First frame each body appears in (it is drawn at that pose before then). */
  firstFrame: number[];
  events: TapeEvent[];
  steps: number;
  retries: number;
  /** Step the finale fired (the CTA and outro follow). */
  finaleStep: number;
  nextEvent: number;
  /** The tune underneath, timed so its last note lands as the bell rings; with a cursor. */
  music: Onset[];
  nextNote: number;
  /** The chord sounding now (xylophone strikes and the bell harmonise with it). */
  chord: number[];
  k: number;
  t: number;
  theme: Theme;
  visual: boolean;
}

const OUTRO_DELAY_S = 0.9;
/** The tune starts this far in. */
const MUSIC_LEAD_S = 0.6;

export const rubeGoldberg: Template<RubeGoldbergParams, State> = {
  id: 'rube-goldberg',
  name: 'Rube Goldberg',
  family: 'kinetic',
  category: 'machines',
  description:
    'A Rube Goldberg marble machine, different for every seed, simulated with real rigid-body physics (rolling marbles, swinging gates and bells). A gate releases a marble at the top; it runs down wooden channels, clacks into backstops, swirls round catch funnels and works through contraption after contraption (spirals, a coin-funnel vortex, dominoes, a Newton\'s cradle, a paddle wheel, a seesaw catapult, xylophone steps and a zigzag peg drop), zigzagging down the machine until it rings a brass bell at the bottom. The machine is generated and tested so every video runs to its finale.',
  schema: rubeGoldbergSchema,
  lengthParam: { param: 'durationS', offsetS: 0 },
  substeps: STEPS_PER_FRAME,
  searchBudget: 6,
  glowScale: 0.1,
  defaultCopy: {
    hook: 'Watch it all connect 🔗',
    cta: 'Which part was your favourite? 👇',
  },
  nudges: ['Which part was the best? 👇', 'Rate this machine 1–10 👇', 'Would you build this? 👇', 'Watch the bell at the end 🔔', 'Spot every trick 👇', 'How long did this take? 👇'],

  init({ params: p, rng, visual, theme, melody }) {
    const marble = p.marbles === 'mixed' ? (rng.chance(0.5) ? 'glass' : 'steel') : p.marbles;
    const m = generate(new Rng(rng.u32()), { targetS: p.durationS, marble });
    const { sim } = m;
    const firstFrame = sim.bodies.map((_, i) => {
      let f = 0;
      while (f < sim.frames.length && sim.frames[f].length <= i * 7) f++;
      return Math.min(f, sim.frames.length - 1);
    });
    const finale = m.stages[m.stages.length - 1];
    const state: State = {
      p,
      stages: m.stages,
      statics: sim.statics,
      bodies: sim.bodies,
      frames: sim.frames,
      firstFrame,
      events: sim.events,
      steps: m.steps,
      retries: m.retries,
      finaleStep: finale.to,
      nextEvent: 0,
      music: [],
      nextNote: 0,
      chord: [],
      k: 0,
      t: 0,
      theme,
      visual,
    };
    // The tune: phrase-whole, at its own rhythm (within a tempo range), ending as the bell rings.
    const ring = finale.to * DT;
    state.music = buildTimeline(melody, MUSIC_LEAD_S, Math.max(4, ring - MUSIC_LEAD_S)).onsets;
    state.chord = [state.music[0].midi, ...state.music[0].bass];
    // The physics is done and on the tape: release the engine's memory.
    sim.free();
    return state;
  },

  step(s, { dt, emit }) {
    s.k++;
    s.t = s.k * dt;
    if (s.k === 1) emit({ type: 'start', stages: s.stages.length, retries: s.retries, kinds: s.stages.map((g) => g.kind).join(',') });
    while (s.nextNote < s.music.length && s.music[s.nextNote].t < s.t) {
      const o = s.music[s.nextNote++];
      s.chord = [o.midi, ...o.bass];
      emit({ type: 'music', midi: o.midi, bass: o.bass[0] ?? -1, dur: o.dur });
    }
    while (s.nextEvent < s.events.length && s.events[s.nextEvent].step <= s.k) {
      const { step: _, ...ev } = s.events[s.nextEvent++];
      // Xylophone bars ring a note of the chord sounding at that moment, so they harmonise.
      if (ev.tagA === 'xylo' || ev.tagB === 'xylo' || ev.tagA === 'peg' || ev.tagB === 'peg') (ev as Record<string, unknown>).chord = s.chord;
      if (ev.type === 'ding') (ev as Record<string, unknown>).chord = s.chord;
      emit(ev as { type: string });
    }
  },

  isDone(s) {
    return s.k >= s.steps;
  },

  hud(s) {
    return { outro: s.k * DT >= s.finaleStep * DT + OUTRO_DELAY_S };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.8, y: 0.12 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.12 },
    ];
  },

  render({ ctx, theme, t }, s) {
    drawRube3D(ctx, theme, s, t);
  },

  audio(e) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, (e.x as number) / 0.4)) : 0;
    switch (e.type) {
      case 'impact': {
        const v = clamp01((e.speed as number) / 1.4);
        const tags = [e.tagA, e.tagB];
        const mats = [e.a, e.b];
        // The bell rings through its own event; xylophone bars ring a note of the current chord.
        if (tags.includes('bell')) return [];
        if (tags.includes('xylo') || tags.includes('peg')) {
          // Tuned bars and pegs ring a note of the chord sounding now (pegs softer, an octave up).
          const peg = tags.includes('peg');
          const chord = (e.chord as number[]) ?? [72];
          const midi = chord[Math.floor(clamp01(((e.x as number) + 0.4) / 0.8) * (chord.length - 0.001))] ?? chord[0];
          return [
            { kind: 'note', midi: midi + (peg ? 36 : 24), vel: (peg ? 0.18 : 0.3) + (peg ? 0.25 : 0.35) * v, voice: peg ? 'glass' : 'bell', dur: peg ? 0.7 : 1.2, pan },
            { kind: 'sfx', name: 'clink', vel: 0.1 + 0.2 * v, pitch: peg ? 0.9 : 0.7, pan },
          ];
        }
        if (tags.includes('domino') && !tags.includes('marble')) return [{ kind: 'sfx', name: 'knock', vel: 0.12 + 0.35 * v, pitch: 0.95, pan }];
        if (mats.includes('wood') || mats.includes('ivory')) return [{ kind: 'sfx', name: 'knock', vel: 0.1 + 0.55 * v, pitch: 0.3 + 0.5 * v, pan }];
        if (mats.every((m) => m === 'steel' || m === 'brass')) return [{ kind: 'sfx', name: 'clang', vel: 0.06 + 0.3 * v, pitch: 0.9, pan }];
        return [{ kind: 'sfx', name: 'clink', vel: 0.08 + 0.45 * v, pitch: 0.3 + 0.5 * v, pan }];
      }
      case 'gate':
        return [{ kind: 'sfx', name: 'knock', vel: 0.45, pitch: 0.2, pan }];
      case 'music': {
        // A soft marimba carrying the tune under the machine, a gentle bass under it.
        const dur = Math.max(0.3, Math.min(2.4, (e.dur as number) * 1.5));
        const out: AudioEventInput[] = [{ kind: 'note', midi: e.midi as number, vel: 0.42, voice: 'marimba', dur }];
        if ((e.bass as number) > 0) out.push({ kind: 'note', midi: (e.bass as number) >= 48 ? (e.bass as number) - 12 : (e.bass as number), vel: 0.24, voice: 'softsine', dur: dur * 1.2 });
        return out;
      }
      case 'ding':
        return [
          { kind: 'sfx', name: 'ding', vel: 0.85, pitch: 0.4, pan },
          ...((e.chord as number[]) ?? []).flatMap((midi) => [
            { kind: 'note' as const, midi: midi + 12, vel: 0.55, voice: 'bell' as const, dur: 3, pan },
            { kind: 'note' as const, midi: midi + 24, vel: 0.25, voice: 'bell' as const, dur: 2.5, pan },
          ]),
        ];
    }
    return [];
  },

  score(events, { durationS, targetS, timedOut }): DramaScore {
    const start = events.find((e) => e.type === 'start');
    const durFit = gaussFit(durationS, targetS, targetS * 0.15);
    if (timedOut || !start) return { total: 0, parts: { durFit }, notes: ['no run'] };
    const kinds = String(start.kinds).split(',');
    const variety = clamp01((new Set(kinds).size - 2) / 5);
    const impacts = events.filter((e) => e.type === 'impact').length;
    const busyFit = clamp01(impacts / (durationS * 3));
    const total = durFit * (0.6 + 0.3 * variety + 0.1 * busyFit);
    return { total, parts: { durFit, variety, busyFit }, notes: [`${kinds.length} stages: ${kinds.join(' → ')}`, `${start.retries} retries`] };
  },
};
