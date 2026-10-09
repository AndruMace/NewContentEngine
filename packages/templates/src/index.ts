import type { Template } from '@sim/engine';
import { ringEscape } from './ring-escape';
import { marbleRace } from './marble-race';
import { ballBattle } from './ball-battle';
import { polyrhythm } from './polyrhythm';
import { sandPour } from './sand-pour';
import { growUntilFull } from './grow-until-full';
import { sortingRace } from './sorting-race';
import { liquidMix } from './liquid-mix';

export { ringEscape, marbleRace, ballBattle, polyrhythm, sandPour, growUntilFull, sortingRace, liquidMix };

export const TEMPLATES: Template[] = [ringEscape, growUntilFull, marbleRace, ballBattle, polyrhythm, sandPour, liquidMix, sortingRace];

export function getTemplate(id: string): Template {
  const template = TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`Unknown template: ${id}. Available: ${TEMPLATES.map((t) => t.id).join(', ')}`);
  return template;
}
