/**
 * Orbital Viewport's geometry, in metres. The camera is at the origin looking down -z, through a
 * rounded viewport in the wall in front of it; the planet hangs below and beyond.
 */
export const CAMERA = { fov: 50, pos: [0, 0, 0] as const };

/** The viewport: a rounded rectangle in the wall at z = WALL_Z. */
export const WALL_Z = -2.2;
export const VIEWPORT = { halfW: 1.62, halfH: 0.88, radius: 0.3, cy: 0.1 };

/**
 * A big planet: 52° in angular radius, its centre 50° below the line of sight and 8° right, so its
 * horizon arcs across the middle of the viewport.
 */
/** `tilt` turns the spin axis back so the point nearest the camera is at about 15° north. */
export const PLANET = { center: [35.8, -306.4, -254.6] as const, radius: 315.2, tilt: -0.615 };
/** Direction toward the sun: to the left and a little behind us, so the planet's day side faces us and the terminator crosses the view on the right. */
export const SUN = [-0.9, 0.3, -0.05] as const;

/**
 * From farther out (used for ringed planets and gas giants): 14° in angular radius, low in the
 * viewport with its centre 8° below the line of sight, so the rings show either side (close in,
 * they would circle around us).
 */
export const PLANET_FAR = { center: [134.6, -180.9, -1280.3] as const, radius: 314.5, tilt: 0.123 };
