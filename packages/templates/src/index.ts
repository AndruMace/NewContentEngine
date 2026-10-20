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
import { collidingBlocks } from './colliding-blocks';
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

export { ringEscape, marbleRace, ballBattle, polyrhythm, sandPour, growUntilFull, sortingRace, territoryWar, snakeAi, shellEscape, gravityFunnel, collidingBlocks, pathfindingRace, fourierDrawing, spinBattle, bounceKeys, rpsBattle, trickShot, marbleMachine, rubeGoldberg, marbleRace3d, cabinStorm, orbitalViewport, nightTrain, deepSea, FOURIER_GUESS };

export const TEMPLATES: Template[] = [ringEscape, growUntilFull, marbleRace, ballBattle, polyrhythm, sandPour, sortingRace, territoryWar, snakeAi, shellEscape, gravityFunnel, collidingBlocks, pathfindingRace, fourierDrawing, spinBattle, bounceKeys, rpsBattle, trickShot, marbleMachine, rubeGoldberg, marbleRace3d];

/**
 * Long-form ambient templates (hours-long background videos). Kept out of TEMPLATES on purpose: that
 * list feeds batches, the planner, the taste model and analytics, which are all about Shorts.
 */
export { setAssetBase, loadedSounds } from './ambient/assets';

export const LONG_FORM_TEMPLATES: Template[] = [cabinStorm, orbitalViewport, nightTrain, deepSea];

export const ALL_TEMPLATES: Template[] = [...TEMPLATES, ...LONG_FORM_TEMPLATES];

export function getTemplate(id: string): Template {
  const template = ALL_TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`Unknown template: ${id}. Available: ${ALL_TEMPLATES.map((t) => t.id).join(', ')}`);
  return template;
}

/** Like getTemplate, but undefined for ids that no longer exist (e.g. renders of a removed template). */
export const findTemplate = (id: string): Template | undefined => ALL_TEMPLATES.find((t) => t.id === id);

/** Long-form ambient videos are ignored by analytics and never planned into batches. */
export const isLongForm = (templateId: string | undefined): boolean => Boolean(templateId && LONG_FORM_TEMPLATES.some((t) => t.id === templateId));
