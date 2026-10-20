/**
 * Deep Sea Observatory, in metres. The camera stands in the station looking at a big round porthole
 * in the hull (z = WALL), instrument panels either side; outside, the seabed lies below
 * (y = SEABED_Y) and runs off into the dark. The station drifts sideways (towards +x).
 */
export const WALL = -1.2;
export const PORT = { x: 0, y: 1.4, r: 0.86, depth: 0.34 };
export const CAMERA = { pos: [0.08, 1.4, 0.85] as const, target: [0.0, 1.37, WALL] as const, fov: 50 };
/** The instrument panels left and right of the porthole (x ranges on the hull). */
export const PANELS = { left: [-1.6, -1.12], right: [1.12, 1.6] } as const;
/** The seabed, below and ahead (it slopes gently away). */
export const SEABED_Y = -4.2;
/** The floodlight on the hull below the porthole, pointing down and out over the seabed. */
export const FLOOD = { pos: [0.0, 0.4, WALL - 0.4] as const, aim: [0.0, SEABED_Y, WALL - 11] as const };
