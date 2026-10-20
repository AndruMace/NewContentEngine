import type { Template } from '@sim/engine';
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
import { deepSea } from './deep-sea';

export { ringEscape, marbleRace, ballBattle, polyrhythm, sandPour, growUntilFull, sortingRace, territoryWar, snakeAi, shellEscape, gravityFunnel, mathCuriosities, pathfindingRace, fourierDrawing, spinBattle, bounceKeys, rpsBattle, trickShot, marbleMachine, rubeGoldberg, marbleRace3d, cabinStorm, orbitalViewport, nightTrain, deepSea, FOURIER_GUESS };

export const TEMPLATES: Template[] = [ringEscape, growUntilFull, marbleRace, ballBattle, polyrhythm, sandPour, sortingRace, territoryWar, snakeAi, shellEscape, gravityFunnel, mathCuriosities, pathfindingRace, fourierDrawing, spinBattle, bounceKeys, rpsBattle, trickShot, marbleMachine, rubeGoldberg, marbleRace3d];

/**
 * Long-form ambient templates (hours-long background videos). Kept out of TEMPLATES on purpose: that
 * list feeds batches, the planner, the taste model and analytics, which are all about Shorts.
 */
export { setAssetBase, loadedSounds } from './ambient/assets';

export const LONG_FORM_TEMPLATES: Template[] = [cabinStorm, orbitalViewport, nightTrain, deepSea];

export const ALL_TEMPLATES: Template[] = [...TEMPLATES, ...LONG_FORM_TEMPLATES];

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

/** Long-form ambient videos are ignored by analytics and never planned into batches. */
export const isLongForm = (templateId: string | undefined): boolean => Boolean(templateId && LONG_FORM_TEMPLATES.some((t) => t.id === canonicalTemplateId(templateId)));
