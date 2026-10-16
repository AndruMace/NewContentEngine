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

export { ringEscape, marbleRace, ballBattle, polyrhythm, sandPour, growUntilFull, sortingRace, territoryWar, snakeAi, shellEscape, gravityFunnel, collidingBlocks, pathfindingRace, fourierDrawing, spinBattle, bounceKeys, FOURIER_GUESS };

export const TEMPLATES: Template[] = [ringEscape, growUntilFull, marbleRace, ballBattle, polyrhythm, sandPour, sortingRace, territoryWar, snakeAi, shellEscape, gravityFunnel, collidingBlocks, pathfindingRace, fourierDrawing, spinBattle, bounceKeys];

export function getTemplate(id: string): Template {
  const template = TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`Unknown template: ${id}. Available: ${TEMPLATES.map((t) => t.id).join(', ')}`);
  return template;
}

/** Like getTemplate, but undefined for ids that no longer exist (e.g. renders of a removed template). */
export const findTemplate = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);
