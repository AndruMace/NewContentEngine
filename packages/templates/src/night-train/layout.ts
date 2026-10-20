/**
 * Night Train's compartment, in metres: an old-fashioned sleeper (walnut panelling, brass, velour).
 * The camera sits on the right-hand berth looking across at the big window in the outer wall
 * (z = WALL); the train travels towards +x, so the countryside slides left.
 *
 *   x = -HALF_W   left berth   | table under the WINDOW |   right berth (camera)   x = HALF_W
 */
export const HALF_W = 1.3;
export const WALL = -1.0;
/** The compartment door end (behind the camera). */
export const BACK = 1.4;
export const CEILING = 2.3;
export const WINDOW = { x0: -1.0, x1: 1.0, y0: 0.7, y1: 1.8, r: 0.06 };
export const TABLE = { x0: -0.62, x1: 0.62, y: 0.68, depth: 0.4 };
export const LAMP = { x: -0.42, y: TABLE.y, z: WALL + 0.19 };
export const BERTH = { x0: -HALF_W, x1: -0.62, top: 0.5 };
export const CAMERA = { pos: [0.38, 1.27, 0.6] as const, target: [-0.02, 1.22, WALL] as const, fov: 52 };
/** The ground (rail level) and our eye's height above it: the floor is 1.2 m above the rails. */
export const GROUND_Y = -1.25;
