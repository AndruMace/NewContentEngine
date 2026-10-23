import type { Template } from '@sim/engine';
import { automataSchema, type AutomataParams, type ModeId } from './params';
import { MANUAL_MAX_S, modeOfEvent, type ModeImpl } from './shared';
import { crystalMode } from './modes/crystal';
import { towerMode } from './modes/tower';
import { warMode } from './modes/war';

export { automataSchema, MODES as AUTOMATA_MODES, type AutomataParams } from './params';

export const MODE_IMPLS: Record<ModeId, ModeImpl> = {
  crystal: crystalMode,
  tower: towerMode,
  war: warMode,
};

const DEFAULT_HOOK = 'Guess what this grows into 👀';
const DEFAULT_CTA = '{result} What did you see?';

interface State {
  mode: ModeId;
  inner: unknown;
}

export const automata3d: Template<AutomataParams, State> = {
  id: 'automata-3d',
  name: '3D Cellular Automata',
  family: 'kinetic',
  category: 'brainy',
  description:
    'Emergent structures from simple cell rules, in 3D voxels (the mode). Crystal growth: a tiny symmetric seed grows under a 3D rule (Crystal Growth, Frost, Snowflake, 445, Builder, Shells, Expanding Shell, Coral, Amoeba, Pyroclastic) into a gem, snowflake or coral, with no walls: it grows for hundreds of generations, until it dies, settles or the run ends. Life tower: Conway\'s Game of Life (or HighLife, Day & Night, Mazectric) from a famous pattern (R-pentomino, Acorn, Diehard, glider gun…) on an endless board, every generation stacked on the last so the history becomes a sculpture; how long does it last (Acorn: 5,206 generations)? Colony war: 2–4 coloured colonies spread through a 3D arena (up to 256 cells across) and fight for every cell at their borders (majority, or rock-paper-scissors), with a live share bar; one takes everything or the biggest wins at the buzzer. CTAs may use {result} and {gen}.',
  schema: automataSchema,
  substeps: 1,
  maxSeconds: (p) => (p.genRate > 0 || p.generations > 0 ? MANUAL_MAX_S + 5 : 90),
  searchBudget: (p) => MODE_IMPLS[p.mode].searchBudget(p),
  glowScale: 0.3,
  lengthParam: { param: 'durationS', offsetS: 0 },
  defaultCopy: { hook: DEFAULT_HOOK, cta: DEFAULT_CTA },
  nudges: ['Comment your guess 👇', 'Lock in your guess 👇', 'Guess before the end 👇', 'Called it? Comment 👇', 'What do you think happens? 👇'],

  init(ctx) {
    return { mode: ctx.params.mode, inner: MODE_IMPLS[ctx.params.mode].init(ctx) };
  },
  step: (s, ctx) => MODE_IMPLS[s.mode].step(s.inner, ctx),
  isDone: (s) => MODE_IMPLS[s.mode].isDone(s.inner),
  hud: (s) => MODE_IMPLS[s.mode].hud(s.inner),
  render: (rc, s) => MODE_IMPLS[s.mode].render(rc, s.inner),
  renderTop: (rc, s) => MODE_IMPLS[s.mode].renderTop(rc, s.inner),

  overlays(p, copy) {
    // A video still on the template's default copy gets the copy written for its mode.
    const own = MODE_IMPLS[p.mode].copy(p);
    const hook = copy.hook === DEFAULT_HOOK ? own.hook : copy.hook;
    const cta = copy.cta === DEFAULT_CTA ? own.cta : copy.cta;
    return [
      { kind: 'hook', text: hook, from: 0, to: 2.8, y: 0.12 },
      { kind: 'cta', text: cta, when: 'outro', y: 0.13 },
    ];
  },

  audio: (e, m) => MODE_IMPLS[modeOfEvent(e)].audio(e, m),

  score(events, info) {
    return events.length ? MODE_IMPLS[modeOfEvent(events[events.length - 1])].score(events, info) : { total: 0, parts: {} };
  },

  outcome: (events) => (events.length ? MODE_IMPLS[modeOfEvent(events[events.length - 1])].outcome(events) : null),
};
