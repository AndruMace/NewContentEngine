/** Intro timing and layout shared by the sim (index.ts) and the 3D view. */

/** Countdown beat (3, 2, 1, then GO). */
export const BEAT_S = 0.42;
/**
 * VS card (round 1): contenders slide in, VS slams down at VS_SLAM, then the halves split apart
 * over the first VS_EXIT_S of the countdown to reveal the stadium.
 */
export const VS_S = 1.6;
export const VS_SLAM = 0.35;
export const VS_EXIT_S = 0.3;
/** Tops fall from the launchers for this long; the fight starts on landing. */
export const DROP_S = 0.3;
/** Where each contender's top sits on the VS card (video pixels). */
export const VS_TOP = [
  { x: 320, y: 640 },
  { x: 760, y: 1290 },
];
