import type { AudioEventInput, SimEvent, Template } from '@sim/engine';
import { lengthFit, markAt, runDirector, storyAudio, storyDirector, storyNarration, weighted, type Director } from '../story';
import { flockSchema, type FlockParams } from './params';
import { buildFlock, type FlockSim } from './script';
import { order, stepFlock } from './sim';
import { renderFlock, renderFlockTop } from './render';

export { flockSchema, FLOCK_MODES, type FlockParams } from './params';

interface State {
  p: FlockParams;
  sim: FlockSim;
  dir: Director<FlockSim>;
  alarm: Float32Array | null;
  ticks: number;
  t: number;
}

const DEFAULT_HOOK = 'How do 1,000 birds fly as one?';
const DEFAULT_CTA = 'No leader. Just 3 rules. 🐦';
const COPY: Record<FlockParams['mode'], { hook: string; cta: string }> = {
  'three-rules': { hook: DEFAULT_HOOK, cta: DEFAULT_CTA },
  'remove-one': { hook: 'One rule is missing. Which one?', cta: 'It was {answer}. Did you spot it? 👇' },
  'seven-neighbours': { hook: 'Each bird watches just 7 others', cta: 'Seven neighbours. That’s all it takes 🐦' },
  school: { hook: 'How does a school of fish move as one?', cta: 'No leader. Just 3 rules. 🐟' },
};

function tick(sim: FlockSim, emit: (e: Omit<SimEvent, 't'>) => void, s: State) {
  const modes = sim.flock.predators.map((p) => p.mode);
  stepFlock(sim.flock);
  sim.flock.predators.forEach((p, k) => {
    if (p.mode === 'stoop' && modes[k] !== 'stoop') emit({ type: 'flock:stoop', k });
  });
  s.ticks++;
  // The flock's state now and then: for the music and the score.
  if (s.ticks % 60 === 0) emit({ type: 'flock:order', order: Math.round(order(sim.flock) * 100), predators: sim.flock.predators.length });
}

const PENTA = [0, 2, 4, 7, 9];

export const murmuration: Template<FlockParams, State> = {
  id: 'murmuration',
  name: 'Murmuration',
  family: 'particles',
  category: 'brainy',
  description:
    'Narrated emergence: a murmuration of starlings (or a school of fish) in 3D, built from three rules each bird follows about its neighbours: separation, alignment and cohesion. Modes: switch the rules on one by one until a flock appears and a falcon attacks; guess which rule was switched off; seven neighbours (a single swerve ripples through the whole flock, as found in real starlings over Rome); and a fish school with a shark. Dusk, sunrise, overcast or neon skies. CTAs may use {answer}.',
  schema: flockSchema,
  substeps: 1,
  maxSeconds: 120,
  searchBudget: 6,
  glowScale: (p) => (p.setting === 'neon' ? 0.6 : 0.2),
  ownMusic: true,
  lengthParam: { param: 'targetS', offsetS: 0 },
  defaultCopy: { hook: DEFAULT_HOOK, cta: DEFAULT_CTA },
  nudges: ['Comment your guess 👇', 'Which rule? 👇', 'Could you tell? 👇', 'Lock in your guess 👇'],
  nudgeY: 0.8,
  narration: storyNarration(
    'A warm, curious nature explainer talking to someone scrolling Shorts: vivid and calm, with wonder at how simple rules make something beautiful, never condescending. Short sentences spoken over the moment they describe.',
  ),

  init(ctx) {
    const p = ctx.params;
    const { sim, script } = buildFlock(p, ctx.rng);
    return { p, sim, dir: storyDirector(script, ctx, 1), alarm: null, ticks: 0, t: 0 };
  },

  step(s, { t, emit }) {
    s.t = t;
    runDirector(s.dir, s.sim, emit, (sim, emit) => tick(sim, emit, s));
  },

  isDone: (s) => s.dir.done,

  hud: (s) => ({ answer: s.sim.answer, outro: s.t >= markAt(s.dir, 'outro') + 0.4 }),

  overlays(p, copy) {
    const own = COPY[p.mode];
    return [
      { kind: 'hook', text: copy.hook === DEFAULT_HOOK ? own.hook : copy.hook, from: 0, to: 3.2, y: 0.1 },
      { kind: 'cta', text: copy.cta === DEFAULT_CTA ? own.cta : copy.cta, when: 'outro', y: 0.1 },
    ];
  },

  render: ({ ctx, theme, t }, s) => renderFlock(ctx, theme, s, t),
  renderTop: ({ ctx, theme, t }, s) => renderFlockTop(ctx, theme, s, t),

  audio(e): AudioEventInput[] {
    const voice = storyAudio(e);
    if (voice) return voice;
    switch (e.type) {
      case 'flock:order': {
        // A soft pad note each second that climbs as the flock comes together.
        const o = e.order as number;
        const deg = Math.floor(o / 14);
        return [{ kind: 'note', midi: 55 + 12 * Math.floor(deg / 5) + PENTA[deg % 5], vel: 0.16, voice: 'softsine', dur: 1.6, bright: 0.5 }];
      }
      case 'flock:rule':
        return e.on ? [{ kind: 'note', midi: 67, vel: 0.35, voice: 'bell', dur: 1.2 }] : [{ kind: 'note', midi: 55, vel: 0.35, voice: 'glass', dur: 1.2 }];
      case 'flock:predator':
        return [{ kind: 'sfx', name: 'screech', vel: 0.45 }];
      case 'flock:stoop':
        // The rush of air as it drops through the flock.
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.75 }];
      case 'flock:startle':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.6 }];
      default:
        return [];
    }
  },

  score(events, { durationS, targetS }) {
    const orders = events.filter((e) => e.type === 'flock:order').map((e) => e.order as number);
    const peak = orders.length ? Math.max(...orders) / 100 : 0;
    return weighted({ length: [lengthFit(durationS, targetS), 2], flock: [peak, 1] });
  },

  outcome(events) {
    const orders = events.filter((e) => e.type === 'flock:order').map((e) => e.order as number);
    if (!orders.length) return null;
    const peak = Math.max(...orders);
    return peak >= 80 ? 'tight flock' : peak >= 50 ? 'loose flock' : 'no flock';
  },
};
