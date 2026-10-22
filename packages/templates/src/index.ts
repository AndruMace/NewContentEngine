import type { Template, TemplateCategory } from '@sim/engine';
import { ringEscape } from './ring-escape';
import { marbleRace } from './marble-race';
import { ballBattle } from './ball-battle';
import { polyrhythm } from './polyrhythm';
import { sandPour } from './sand-pour';
import { growUntilFull } from './grow-until-full';
import { sortingRace } from './sorting-race';
import { territoryWar } from './territory-war';
import { snakeAi } from './snake-ai';
import { shellEscape } from './shell-escape';
import { gravityFunnel } from './gravity-funnel';
import { mathCuriosities } from './math-curiosities';
import { pathfindingRace } from './pathfinding-race';
import { fourierDrawing, GUESS as FOURIER_GUESS } from './fourier-drawing';
import { spinBattle } from './spin-battle';
import { bounceKeys } from './bounce-keys';
import { rpsBattle } from './rps-battle';
import { trickShot } from './trick-shot';
import { marbleMachine } from './marble-machine';
import { rubeGoldberg } from './rube-goldberg';
import { marbleRace3d } from './marble-race-3d';
import { cabinStorm } from './cabin-storm';
import { orbitalViewport } from './orbital-viewport';
import { nightTrain } from './night-train';
import { dayTrain } from './day-train';
import { deepSea } from './deep-sea';
import { whoWouldWin } from './who-would-win';
import { automata3d } from './automata-3d';
export { DUELS as WHO_WOULD_WIN_DUELS, HORDES as WHO_WOULD_WIN_HORDES, creatureById, matchupId } from './who-would-win/roster';

export { ringEscape, marbleRace, ballBattle, polyrhythm, sandPour, growUntilFull, sortingRace, territoryWar, snakeAi, shellEscape, gravityFunnel, mathCuriosities, pathfindingRace, fourierDrawing, spinBattle, bounceKeys, rpsBattle, trickShot, marbleMachine, rubeGoldberg, marbleRace3d, whoWouldWin, automata3d, cabinStorm, orbitalViewport, nightTrain, dayTrain, deepSea, FOURIER_GUESS };

export const TEMPLATES: Template[] = [ringEscape, growUntilFull, marbleRace, ballBattle, polyrhythm, sandPour, sortingRace, territoryWar, snakeAi, shellEscape, gravityFunnel, mathCuriosities, pathfindingRace, fourierDrawing, spinBattle, bounceKeys, rpsBattle, trickShot, marbleMachine, rubeGoldberg, marbleRace3d, whoWouldWin, automata3d];

/**
 * Long-form ambient templates (hours-long background videos). Kept out of TEMPLATES on purpose: that
 * list feeds batches and the planner, which are all about Shorts.
 */
export { setAssetBase, loadedSounds } from './ambient/assets';

export const LONG_FORM_TEMPLATES: Template[] = [cabinStorm, orbitalViewport, nightTrain, dayTrain, deepSea];

export const ALL_TEMPLATES: Template[] = [...TEMPLATES, ...LONG_FORM_TEMPLATES];

/** Template picker sections, in the order they're shown. */
export const TEMPLATE_CATEGORIES: { id: TemplateCategory; label: string }[] = [
  { id: 'battles', label: 'Battles' },
  { id: 'races', label: 'Races' },
  { id: 'bounce', label: 'Bounce & Escape' },
  { id: 'machines', label: 'Satisfying Machines' },
  { id: 'brainy', label: 'Brainy & Algorithmic' },
  { id: 'ambient', label: 'Ambient' },
];

/** Templates grouped into picker sections (empty sections dropped), alphabetical within each. */
export const groupTemplates = (templates: Template[]): { id: TemplateCategory; label: string; templates: Template[] }[] =>
  TEMPLATE_CATEGORIES.map((c) => ({
    ...c,
    templates: templates.filter((t) => t.category === c.id).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.templates.length > 0);

/** Old ids of renamed templates: saved recipes, concepts and settings still name them. */
export const RENAMED_TEMPLATES: Record<string, string> = { 'colliding-blocks': 'math-curiosities' };

/** The current id for a template id (renamed templates map to their new id). */
export const canonicalTemplateId = (id: string): string => RENAMED_TEMPLATES[id] ?? id;

export function getTemplate(id: string): Template {
  const template = findTemplate(id);
  if (!template) throw new Error(`Unknown template: ${id}. Available: ${ALL_TEMPLATES.map((t) => t.id).join(', ')}`);
  return template;
}

/** Like getTemplate, but undefined for ids that no longer exist (e.g. renders of a removed template). */
export const findTemplate = (id: string): Template | undefined => {
  const current = canonicalTemplateId(id);
  return ALL_TEMPLATES.find((t) => t.id === current);
};

/** Long-form ambient videos are never planned into batches. */
export const isLongForm = (templateId: string | undefined): boolean => Boolean(templateId && LONG_FORM_TEMPLATES.some((t) => t.id === canonicalTemplateId(templateId)));
