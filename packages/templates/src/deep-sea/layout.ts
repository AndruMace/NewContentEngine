/**
 * Deep Sea Observatory, in metres. The camera stands in the station looking at a big round porthole
 * in the hull (z = WALL); outside, the seabed lies below (y = SEABED_Y) and runs off into the dark.
 */
export const WALL = -1.2;
export const PORT = { x: 0, y: 1.4, r: 0.74, depth: 0.32 };
export const CAMERA = { pos: [0.12, 1.4, 1.0] as const, target: [0.0, 1.36, WALL] as const, fov: 50 };
/** The seabed, below and ahead (it slopes gently away). */
export const SEABED_Y = -4.2;
/** The floodlight on the hull below the porthole, pointing down and out over the seabed. */
export const FLOOD = { pos: [0.0, 0.4, WALL - 0.4] as const, aim: [0.0, SEABED_Y, WALL - 11] as const };
