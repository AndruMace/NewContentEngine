import type { AudioEventInput, SimEvent, Template } from '@sim/engine';
import { lengthFit, markAt, runDirector, storyAudio, storyDirector, storyNarration, weighted, type Director } from '../story';
import { moldSchema, type MoldParams } from './params';
import { buildMold, coverage, type MoldSim } from './script';
import { stepMold } from './sim';
import { newVis, renderMold, renderMoldTop, type MoldVis } from './render';

export { moldSchema, MOLD_MODES, type MoldParams } from './params';

interface State {
  p: MoldParams;
  sim: MoldSim;
  dir: Director<MoldSim>;
  vis: MoldVis;
  t: number;
}

const DEFAULT_HOOK = 'Can a brainless blob design a network?';
const DEFAULT_CTA = 'One cell. No brain. 🟡';
const COPY: Record<MoldParams['mode'], { hook: string; cta: string }> = {
  network: { hook: DEFAULT_HOOK, cta: DEFAULT_CTA },
  maze: { hook: 'Can a slime mold solve a maze?', cta: 'Solved, without a brain 🟡' },
  foraging: { hook: 'Watch a slime mold hunt for food', cta: 'Explore, then prune 🟡' },
  tokyo: { hook: 'This slime mold redesigned Tokyo’s railway', cta: 'One cell. No brain. 🚆' },
};

function tick(sim: MoldSim, emit: (e: Omit<SimEvent, 't'>) => void) {
  const before = sim.mold.food.map((f) => f.reached);
  stepMold(sim.mold);
  sim.mold.food.forEach((f, k) => {
    if (!f.start && before[k] < 0 && f.reached >= 0) emit({ type: 'mold:reach', k, tick: sim.mold.tick });
  });
  if (sim.mold.tick % 40 === 0) {
    const c = coverage(sim.mold);
    if (c > sim.peak) sim.peak = c;
    emit({ type: 'mold:cover', cover: Math.round(c * 100) });
  }
}

export const slimeMold: Template<MoldParams, State> = {
  id: 'slime-mold',
  name: 'Slime Mold',
  family: 'particles',
  category: 'brainy',
  description:
    'Narrated biology: a slime mold (Physarum, one cell with no brain), simulated as tens of thousands of agents laying chemical trails in a petri dish. Modes: connect oat flakes into an efficient network (compared with the shortest possible one), solve a maze (dead ends dry up, the shortest path survives; Nakagaki 2000), explore then prune, and the 2010 Tokyo rail experiment on an approximate, hand-placed map of the cities around Tokyo. Yellow on agar, neon or bioluminescent looks.',
  schema: moldSchema,
  substeps: 1,
  maxSeconds: 120,
  searchBudget: 4,
  glowScale: (p) => (p.palette === 'agar' ? 0.3 : 0.6),
  ownMusic: true,
  lengthParam: { param: 'targetS', offsetS: 0 },
  defaultCopy: { hook: DEFAULT_HOOK, cta: DEFAULT_CTA },
  nudges: ['Comment your guess 👇', 'Can it do it? 👇', 'Smarter than it looks? 👇', 'Lock in your guess 👇'],
  nudgeY: 0.78,
  narration: storyNarration(
    'A warm, curious biology explainer talking to someone scrolling Shorts: vivid, a little amazed by what a brainless cell can do, never condescending. Short sentences spoken over the moment they describe.',
  ),

  init(ctx) {
    const p = ctx.params;
    const { sim, script } = buildMold(p, ctx.rng);
    return { p, sim, dir: storyDirector(script, ctx, 1), vis: newVis(), t: 0 };
  },

  step(s, { t, emit }) {
    s.t = t;
    runDirector(s.dir, s.sim, emit, tick);
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

  render: ({ ctx, theme, t }, s) => renderMold(ctx, theme, s, t),
  renderTop: ({ ctx, theme, t }, s) => renderMoldTop(ctx, theme, s, t),

  audio(e): AudioEventInput[] {
    const voice = storyAudio(e);
    if (voice) return voice;
    switch (e.type) {
      case 'mold:reach': {
        const k = e.k as number;
        return [
          { kind: 'note', midi: 64 + [0, 2, 4, 7, 9, 12, 14, 16][k % 8], vel: 0.4, voice: 'bell', dur: 1.6 },
          { kind: 'sfx', name: 'bubble', vel: 0.35 },
        ];
      }
      case 'mold:cover':
        // A low, slow pulse that swells with how much of the dish it covers.
        return [{ kind: 'note', midi: 43, vel: 0.08 + Math.min(0.2, (e.cover as number) / 200), voice: 'softsine', dur: 1.4, bright: 0.4 }];
      case 'mold:food':
        return [{ kind: 'sfx', name: 'pop', vel: 0.5 }];
      case 'mold:route':
        return [
          { kind: 'sfx', name: 'chime', vel: 0.6 },
          { kind: 'note', midi: 72, vel: 0.35, voice: 'bell', dur: 2.4 },
        ];
      default:
        return [];
    }
  },

  score(events, { durationS, targetS }) {
    const reached = events.filter((e) => e.type === 'mold:reach').length;
    const route = events.find((e) => e.type === 'mold:route');
    const food = route ? (route.found as number) : reached;
    return weighted({ length: [lengthFit(durationS, targetS), 2], food: [Math.min(1, food / 8), 1] });
  },

  outcome(events) {
    const route = events.find((e) => e.type === 'mold:route');
    return route ? `found ${route.found}` : null;
  },
};
