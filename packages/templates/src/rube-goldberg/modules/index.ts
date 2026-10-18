import { RAMP } from './basic';
import { BELL } from './bell';
import { DOMINOES, JUMP, PEGDROP, XYLOPHONE } from './contraptions';
import { CATAPULT, CRADLE, SPIRAL, VORTEX, WHEEL } from './contraptions2';
import type { ModuleDef } from './common';

export * from './common';
export { RAMP, START } from './basic';

export const MODULES: ModuleDef[] = [RAMP, JUMP, DOMINOES, XYLOPHONE, PEGDROP, VORTEX, SPIRAL, CATAPULT, WHEEL, CRADLE];
export const FINALES: ModuleDef[] = [BELL];
