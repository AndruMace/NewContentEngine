/**
 * Night Train's compartment, in metres. The camera sits on the right-hand berth looking across at the
 * window in the outer wall (z = WALL); the train travels towards +x, so the countryside slides left.
 *
 *   x = -HALF_W   left berth   | table under the WINDOW |   right berth (camera)   x = HALF_W
 */
export const HALF_W = 1.05;
export const WALL = -1.0;
/** The compartment door end (behind the camera). */
export const BACK = 1.6;
export const CEILING = 2.25;
export const WINDOW = { x0: -0.82, x1: 0.82, y0: 0.76, y1: 1.66, r: 0.12 };
export const TABLE = { x0: -0.55, x1: 0.55, y: 0.74, depth: 0.42 };
export const LAMP = { x: -0.36, y: TABLE.y, z: WALL + 0.2 };
export const BERTH = { x0: -HALF_W, x1: -0.3, top: 0.52 };
export const CAMERA = { pos: [0.42, 1.3, 0.95] as const, target: [-0.04, 1.2, WALL] as const, fov: 50 };
/** The ground (rail level) and our eye's height above it: the floor is 1.2 m above the rails. */
export const GROUND_Y = -1.25;
