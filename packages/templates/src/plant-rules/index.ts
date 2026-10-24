import type { AudioEventInput, SimEvent, Template } from '@sim/engine';
import { lengthFit, markAt, runDirector, storyDirector, storyAudio, storyNarration, weighted, type Director } from '../story';
import { plantSchema, type PlantParams } from './params';
import { BLOOM, GROW, buildPlant, type PlantSim } from './script';
import { newVis, renderPlant, renderPlantTop, type PlantVis } from './render';

export { plantSchema, PLANT_MODES, type PlantParams } from './params';

interface State {
  p: PlantParams;
  sim: PlantSim;
  dir: Director<PlantSim>;
  vis: PlantVis;
  t: number;
}

const DEFAULT_HOOK = 'What does this rule grow into?';
const DEFAULT_CTA = 'One rule. {answer}. 🌱';
const COPY: Record<PlantParams['mode'], { hook: string; cta: string }> = {
  rewrite: { hook: DEFAULT_HOOK, cta: DEFAULT_CTA },
  'angle-sweep': { hook: 'Same rule. Only the angle changes.', cta: 'Which angle was your favourite? 👇' },
  garden: { hook: 'Same rules. Same plants?', cta: 'A little chance makes every plant unique 🌿' },
  fractals: { hook: 'This rule doesn’t grow a plant…', cta: 'It was the {answer}! Did you guess? 👇' },
};

/** One tick: the round grows in a little further, the angle sweeps on, the flowers open. */
function tick(sim: PlantSim, emit: (e: Omit<SimEvent, 't'>) => void) {
  if (sim.grow < GROW) {
    sim.grow++;
    if (sim.grow % 6 === 0) emit({ type: 'plant:sprout', round: sim.round, u: sim.grow / GROW });
  }
  if (sim.sweep && sim.sweep.done < sim.sweep.ticks) {
    const sw = sim.sweep;
    sw.done++;
    sim.angle = sw.from + ((sw.to - sw.from) * sw.done) / sw.ticks;
    if (sw.done % 30 === 0) emit({ type: 'plant:angle', angle: Math.round(sim.angle * 10) / 10 });
  }
  if (sim.revealed && sim.bloom < BLOOM) {
    sim.bloom++;
    if (sim.bloom % 5 === 0) emit({ type: 'plant:petal', k: sim.bloom / 5 });
  }
}

/** A pentatonic climb as each round grows, starting higher every round. */
const PENTA = [0, 2, 4, 7, 9];
const scaleNote = (deg: number) => 60 + 12 * Math.floor(deg / 5) + PENTA[((deg % 5) + 5) % 5];

export const plantRules: Template<PlantParams, State> = {
  id: 'plant-rules',
  name: 'Plant Rules',
  family: 'kinetic',
  category: 'brainy',
  description:
    'Narrated L-systems: a plant (fern, bush, tree, seaweed, grass, flowering plant) grows round by round from one rewriting rule shown on screen (F → F[+F]F[-F]F), its line count exploding while the shape appears. Modes: one rule grows a plant, the same rule with its branch angle sweeping, a garden of plants whose rules include chance (each comes out unique), and fractals that are not plants at all (dragon curve, Koch snowflake, Sierpinski triangle, Hilbert curve). Seasons, backgrounds, wind, leaves and flowers. CTAs may use {answer}.',
  schema: plantSchema,
  substeps: 1,
  maxSeconds: 120,
  searchBudget: 20,
  glowScale: (p) => (p.background === 'night' ? 0.55 : 0.15),
  ownMusic: true,
  lengthParam: { param: 'targetS', offsetS: 0 },
  defaultCopy: { hook: DEFAULT_HOOK, cta: DEFAULT_CTA },
  nudges: ['Guess the shape 👇', 'What will it become? 👇', 'Comment your guess 👇', 'Called it? 👇'],
  nudgeY: 0.76,
  narration: storyNarration(
    'A calm, curious nature-and-maths explainer talking to someone scrolling Shorts: clear and vivid, with a sense of wonder, never condescending. Short sentences spoken over the moment they describe.',
  ),

  init(ctx) {
    const p = ctx.params;
    const { sim, script } = buildPlant(p, ctx.rng);
    return { p, sim, dir: storyDirector(script, ctx, 1), vis: newVis(), t: 0 };
  },

  step(s, { t, emit }) {
    s.t = t;
    runDirector(s.dir, s.sim, emit, tick);
  },

  isDone: (s) => s.dir.done,

  hud: (s) => ({
    answer: s.sim.preset.name,
    round: s.sim.round,
    outro: s.t >= markAt(s.dir, 'outro') + 0.4,
  }),

  overlays(p, copy) {
    const own = COPY[p.mode];
    return [
      { kind: 'hook', text: copy.hook === DEFAULT_HOOK ? own.hook : copy.hook, from: 0, to: 3.2, y: 0.1 },
      { kind: 'cta', text: copy.cta === DEFAULT_CTA ? own.cta : copy.cta, when: 'outro', y: 0.1 },
    ];
  },

  render: ({ ctx, theme, t }, s) => renderPlant(ctx, theme, s, t),
  renderTop: ({ ctx, theme, t }, s) => renderPlantTop(ctx, theme, s, t),

  audio(e, m): AudioEventInput[] {
    const voice = storyAudio(e);
    if (voice) return voice;
    switch (e.type) {
      case 'plant:sprout': {
        if (e.t - m.lastNoteT < 0.1) return [];
        const deg = Math.floor((e.u as number) * 7) + (e.round as number);
        return [{ kind: 'note', midi: scaleNote(deg), vel: 0.2, voice: 'kalimba', dur: 0.5, bright: 0.7, pan: ((e.u as number) - 0.5) * 0.6 }];
      }
      case 'plant:round': {
        const r = e.round as number;
        return [0, 4, 7].map((k) => ({ kind: 'note' as const, midi: 48 + PENTA[r % 5] + k, vel: 0.28, voice: 'marimba' as const, dur: 1.4 }));
      }
      case 'plant:angle':
        return [{ kind: 'note', midi: 64 + Math.round(((e.angle as number) % 24) / 2), vel: 0.14, voice: 'glass', dur: 0.8 }];
      case 'plant:petal':
        return [{ kind: 'note', midi: scaleNote(10 + (e.k as number)), vel: 0.2, voice: 'musicbox', dur: 0.8 }];
      case 'plant:bloom':
        return [
          { kind: 'sfx', name: 'chime', vel: 0.6 },
          { kind: 'note', midi: 72, vel: 0.35, voice: 'bell', dur: 2.4 },
        ];
      default:
        return [];
    }
  },

  score(events, { durationS, targetS }) {
    const rounds = events.filter((e) => e.type === 'plant:round').length;
    const bloomed = events.some((e) => e.type === 'plant:bloom');
    return weighted({ length: [lengthFit(durationS, targetS), 2], rounds: [Math.min(1, rounds / 5), 1], ending: [bloomed ? 1 : 0, 1] });
  },

  outcome(events) {
    const b = events.find((e) => e.type === 'plant:bloom');
    return b ? String(b.answer).toLowerCase() : null;
  },
};
