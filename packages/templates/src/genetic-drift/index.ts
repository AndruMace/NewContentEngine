import type { AudioEventInput, SimEvent, Template } from '@sim/engine';
import { clamp01 } from '../scoring';
import { lengthFit, markAt, runDirector, storyDirector, storyAudio, storyNarration, weighted, type Director } from '../story';
import { driftSchema, type DriftParams } from './params';
import { buildDrift, CRASH_AT, type DriftSim } from './script';
import { coloursLeft, leaderOf } from './sim';
import { newVis, renderDrift, renderDriftTop, type DriftVis } from './render';

export { driftSchema, DRIFT_MODES, type DriftParams } from './params';

interface State {
  p: DriftParams;
  sim: DriftSim;
  dir: Director<DriftSim>;
  vis: DriftVis;
  t: number;
}

/** Hooks and CTAs per mode, used while the video still has the template's default copy. */
const DEFAULT_HOOK = 'Which colour takes over?';
const DEFAULT_CTA = '{answer}! Did you call it?';
const COPY: Record<DriftParams['mode'], { hook: string; cta: string }> = {
  race: { hook: 'No colour is better. Which one takes over?', cta: DEFAULT_CTA },
  'drift-vs-selection': { hook: '{fav} is fitter. Does it win?', cta: 'Did you see that coming? 👇' },
  'small-vs-large': { hook: 'Small vs big: which loses its colours first?', cta: 'Luck hits small groups hardest 🧬' },
  bottleneck: { hook: 'What happens when only a few survive?', cta: 'Luck picks the survivors 🧬' },
  'lucky-mutant': { hook: 'Can one mutant take over?', cta: 'It took {answer}. Guess right? 👇' },
};

/** One generation: show the next row, and log what changed. */
function tick(sim: DriftSim, emit: (e: Omit<SimEvent, 't'>) => void) {
  const last = Math.max(sim.hist.rows.length, sim.big?.rows.length ?? 0) - 1;
  if (sim.g >= last) return;
  sim.g++;
  const g = sim.g;
  const pops = sim.big ? [sim.hist, sim.big] : [sim.hist];
  pops.forEach((h, pop) => {
    if (g >= h.rows.length) return;
    const c0 = h.counts[g - 1];
    const c1 = h.counts[g];
    if (sim.starts.includes(g)) {
      emit({ type: 'drift:trial', n: sim.starts.indexOf(g) + 1 });
      return;
    }
    if (pop === 0) emit({ type: 'drift:gen', g, lead: leaderOf(c1) });
    for (let c = 0; c < c1.length; c++) if (c0[c] > 0 && c1[c] === 0) emit({ type: 'drift:lost', c, g, pop });
    if (coloursLeft(c1) === 1 && coloursLeft(c0) > 1) emit({ type: 'drift:fixed', c: c1.findIndex((x) => x > 0), g, pop });
  });
  if (sim.big === null && g === CRASH_AT && sim.hist.rows[g].length < sim.hist.rows[g - 1].length) emit({ type: 'drift:crash', g });
}

const LEAD_NOTES = [0, 4, 7, 9, 12, 14];

export const geneticDrift: Template<DriftParams, State> = {
  id: 'genetic-drift',
  name: 'Genetic Drift',
  family: 'kinetic',
  category: 'brainy',
  description:
    'Narrated biology: a population of beetles, flowers, fish, marbles or cells in a few colours, where every generation each individual copies one random parent. No colour is better, yet one always takes over (genetic drift). Modes: a colour race (which takes over?), drift vs selection (a fitter colour can still lose), small vs large populations, a bottleneck crash (founder effect), and a lucky mutant (one in N). Shown as a family tree for small populations or a grid, with a share chart. CTAs may use {answer}.',
  schema: driftSchema,
  substeps: 1,
  maxSeconds: 120,
  searchBudget: 60,
  glowScale: 0.45,
  ownMusic: true,
  lengthParam: { param: 'targetS', offsetS: 0 },
  defaultCopy: { hook: DEFAULT_HOOK, cta: DEFAULT_CTA },
  nudges: ['Comment your guess 👇', 'Which colour? 👇', 'Lock in your pick 👇', 'Called it? 👇'],
  nudgeY: 0.725,
  narration: storyNarration(
    'A warm, curious biology explainer talking to someone scrolling Shorts: clear and vivid, a little playful, never condescending. Short sentences spoken over the moment they describe.',
  ),

  init(ctx) {
    const p = ctx.params;
    const { sim, script } = buildDrift(p, ctx.rng);
    return { p, sim, dir: storyDirector(script, ctx, 1), vis: newVis(), t: 0 };
  },

  step(s, { t, emit }) {
    s.t = t;
    runDirector(s.dir, s.sim, emit, tick);
  },

  isDone: (s) => s.dir.done,

  hud: (s) => ({
    answer: s.sim.answer,
    fav: s.sim.colours[0]?.name ?? '',
    generation: s.sim.g,
    outro: s.t >= markAt(s.dir, 'outro') + 0.4,
  }),

  overlays(p, copy) {
    const own = COPY[p.mode];
    const hook = copy.hook === DEFAULT_HOOK ? own.hook : copy.hook;
    const cta = copy.cta === DEFAULT_CTA ? own.cta : copy.cta;
    return [
      { kind: 'hook', text: hook, from: 0, to: 3.2, y: 0.12 },
      { kind: 'cta', text: cta, when: 'outro', y: 0.12 },
    ];
  },

  render: ({ ctx, theme, t }, s) => renderDrift(ctx, theme, s, t),
  renderTop: ({ ctx, theme, t }, s) => renderDriftTop(ctx, theme, s, t),

  audio(e, m): AudioEventInput[] {
    const voice = storyAudio(e);
    if (voice) return voice;
    switch (e.type) {
      case 'drift:gen': {
        // A soft note per generation, pitched by the leading colour (thinned out when they fly by).
        if (e.t - m.lastNoteT < 0.085) return [];
        return [{ kind: 'note', midi: 62 + LEAD_NOTES[(e.lead as number) % LEAD_NOTES.length], vel: 0.22, voice: 'kalimba', dur: 0.5, bright: 0.6 }];
      }
      case 'drift:lost':
        return [
          { kind: 'sfx', name: 'knock', vel: 0.7 },
          { kind: 'note', midi: 38, vel: 0.5, voice: 'bass', dur: 0.8 },
        ];
      case 'drift:fixed':
        return [62, 66, 69, 74].map((midi, k) => ({ kind: 'note' as const, midi, vel: 0.42 - k * 0.04, voice: 'bell' as const, dur: 2.4 }));
      case 'drift:crash':
        return [
          { kind: 'sfx', name: 'boom', vel: 1 },
          { kind: 'note', midi: 31, vel: 0.7, voice: 'bass', dur: 1.6 },
        ];
      case 'drift:trial':
        return [{ kind: 'sfx', name: 'pop', vel: 0.35, pitch: 0.6 }];
      case 'drift:result':
        return [{ kind: 'sfx', name: 'chime', vel: 0.6 }];
      default:
        return [];
    }
  },

  score(events, { durationS, targetS }) {
    let leads = 0;
    let lead = -1;
    let lost = 0;
    for (const e of events) {
      if (e.type === 'drift:gen') {
        if (lead >= 0 && e.lead !== lead) leads++;
        lead = e.lead as number;
      } else if (e.type === 'drift:lost') lost++;
    }
    const ended = events.some((e) => e.type === 'drift:result');
    return weighted({ length: [lengthFit(durationS, targetS), 2], drama: [clamp01(leads / 8), 1], losses: [clamp01(lost / 4), 0.5], ending: [ended ? 1 : 0, 1] });
  },

  outcome(events) {
    const r = events.find((e) => e.type === 'drift:result');
    return r ? String(r.result) : null;
  },
};
