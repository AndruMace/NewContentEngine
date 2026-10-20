/** Tuning shared by the template, its tests and scripts/battle-matrix.ts. */

/** At hpScale 1 a typical duel lasts about this long (sim seconds). */
export const BASE_FIGHT_S = 7;
export const MAX_SWARM_DEFAULT = 30;

/** HP multiplier so a typical fight lasts about `fightLength` seconds. */
export const hpScaleFor = (fightLength: number) => fightLength / BASE_FIGHT_S;

/** Every blow's damage (relative to HP): fewer, heavier hits make for upsets and tension. */
export const DAMAGE_MUL = 3;
/** Every move's cooldown: more sizing each other up between blows. */
export const COOLDOWN_MUL = 2.2;
