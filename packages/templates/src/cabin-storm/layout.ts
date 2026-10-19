/**
 * Cabin Storm's floor plan, in metres. The camera stands in the room looking at the back wall
 * (z = BACK): a stone chimney in the middle with the fireplace, a big window either side.
 *
 *          x = -HALF_W                      0                        x = HALF_W
 *   back   |  log wall | WINDOW |  CHIMNEY + FIRE  | WINDOW |  log wall |
 */
export const HALF_W = 4.6;
/** Back wall (logs centred on it); the room runs from here towards the camera. */
export const BACK = -3;
export const FRONT = 6;
export const CEILING = 3.4;

export const LOG_R = 0.16;
/** Logs are stacked a little closer than their diameter (they sit in each other's notches). */
export const LOG_PITCH = 0.3;

export const CHIMNEY = { halfW: 1.25, front: BACK + 0.72 };
export const FIREBOX = { halfW: 0.58, bottom: 0.16, top: 1.02, back: BACK + 0.1 };
export const HEARTH = { halfW: 1.6, front: BACK + 1.35, height: 0.16 };
export const MANTEL = { halfW: 1.42, y: 1.16, h: 0.18, depth: 0.28 };

export interface Opening {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
/** The two windows: sill and head heights, either side of the chimney. */
export const WINDOWS: Opening[] = [
  { x0: -4.0, x1: -1.75, y0: 0.72, y1: 2.72 },
  { x0: 1.75, x1: 4.0, y0: 0.72, y1: 2.72 },
];

/** Where the fire burns (centre of the log pile, on the firebox floor). */
export const FIRE = { x: 0, y: FIREBOX.bottom, z: BACK + 0.42 };

export const CAMERA = { pos: [0, 1.32, 4.6] as const, target: [0, 1.38, BACK] as const, fov: 50 };
