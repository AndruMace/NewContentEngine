/**
 * Deep Sea Submarine, in metres. The camera is the pilot's eye in a small submersible's cockpit,
 * looking forward (towards -z) out of a big acrylic dome; the console curves across below it, panels
 * run up either side, switches overhead. The submarine cruises forward a few metres above the
 * seabed, its twin headlights under the dome lighting the water ahead.
 */
/** The dome: a hemisphere on the hull's front ring (centre on the ring's plane, bulging to -z). */
export const DOME = { c: [0, 1.2, -0.5] as const, r: 0.98 };
/** The dome's furthest point: nothing outside comes closer than this. */
export const NOSE_Z = DOME.c[2] - DOME.r;
export const CAMERA = { pos: [0, 1.22, 0.72] as const, target: [0, 1.08, -3] as const, fov: 64 };
/** The seabed, below the submarine. */
export const SEABED_Y = -5;
/** Twin headlights under the dome, aimed ahead and down. */
export const LAMPS = { pos: [[-0.85, 0.32, -1.25] as const, [0.85, 0.32, -1.25] as const], aim: [0, -0.6, -16] as const };
/** The console: across the bottom of the dome, close to the pilot. */
export const CONSOLE = { y: 0.86, z0: -0.46, z1: 0.3, halfW: 1.0 };
