import type { Template } from '@sim/engine';
import { NARRATED, mathCuriositiesSchema, type MathParams, type ModeId } from './params';
import { modeOfEvent, type ModeImpl } from './shared';
import { BLOCKS_CTA, BLOCKS_HOOK, blocksMode } from './modes/blocks';
import { collatzMode } from './modes/collatz';
import { timesTableMode } from './modes/times-table';
import { phyllotaxisMode } from './modes/phyllotaxis';
import { chaosGameMode } from './modes/chaos-game';
import { montyHallMode } from './modes/monty-hall';
import { birthdayMode } from './modes/birthday';

export { MODES, CHAOS_RULES, mathCuriositiesSchema, type MathParams, type ModeId } from './params';

export const MODE_IMPLS: Record<ModeId, ModeImpl> = {
  blocks: blocksMode,
  collatz: collatzMode,
  'times-table': timesTableMode,
  phyllotaxis: phyllotaxisMode,
  'chaos-game': chaosGameMode,
  'monty-hall': montyHallMode,
  birthday: birthdayMode,
};

interface State {
  mode: ModeId;
  inner: unknown;
}

export const mathCuriosities: Template<MathParams, State> = {
  id: 'math-curiosities',
  name: 'Math Curiosities',
  family: 'bounce',
  category: 'brainy',
  description:
    'Surprising maths, one curiosity per video (the mode): colliding blocks whose collision counts spell π; Collatz hailstone numbers (how many steps to reach 1?); times tables drawn on a circle (cardioids and stars); a sunflower whose seed angle sweeps to the golden angle; the chaos game (random dots that draw a fractal); the Monty Hall problem, played once and then hundreds of times; and the birthday paradox (how many people until two share a birthday?). CTAs may use {result} (the mode\'s answer) and, for the blocks, {count}.',
  schema: mathCuriositiesSchema,
  substeps: 4,
  searchBudget: (p) => MODE_IMPLS[p.mode].searchBudget,
  glowScale: (p) => MODE_IMPLS[p.mode].glowScale,
  ownMusic: true,
  lengthParam: { param: 'durationS', offsetS: 0 },
  defaultCopy: { hook: BLOCKS_HOOK, cta: BLOCKS_CTA },
  narration: {
    enabled: (p) => p.narration === 'on' && NARRATED.includes(p.mode) && Boolean(MODE_IMPLS[p.mode].beats),
    voice: (p) => p.narrator,
    style:
      'A warm, curious maths explainer talking to someone scrolling Shorts: clear, quick, a little playful, never condescending. Short sentences that land on the beat.',
    beats: (p, events) => MODE_IMPLS[p.mode].beats?.(p, events) ?? [],
  },
  nudges: ['Comment your guess 👇', 'Lock in your answer 👇', 'Guess before the end 👇', 'Called it? Comment 👇', 'What do you think? 👇', 'Spot the pattern yet? 👇'],

  init(ctx) {
    return { mode: ctx.params.mode, inner: MODE_IMPLS[ctx.params.mode].init(ctx) };
  },
  step: (s, ctx) => MODE_IMPLS[s.mode].step(s.inner, ctx),
  isDone: (s) => MODE_IMPLS[s.mode].isDone(s.inner),
  hud: (s) => MODE_IMPLS[s.mode].hud(s.inner),
  render: (rc, s) => MODE_IMPLS[s.mode].render(rc, s.inner),

  overlays(p, copy) {
    // A video still on the template's default copy gets the copy written for its mode.
    const own = MODE_IMPLS[p.mode].copy(p);
    const hook = copy.hook === BLOCKS_HOOK ? own.hook : copy.hook;
    const cta = copy.cta === BLOCKS_CTA ? own.cta : copy.cta;
    return [
      { kind: 'hook', text: hook, from: 0, to: 2.6, y: 0.12 },
      { kind: 'cta', text: cta, when: 'outro', y: 0.12 },
    ];
  },

  audio: (e, m) => MODE_IMPLS[modeOfEvent(e)].audio(e, m),

  score(events, info) {
    return MODE_IMPLS[events.length ? modeOfEvent(events[events.length - 1]) : 'blocks'].score(events, info);
  },
};
