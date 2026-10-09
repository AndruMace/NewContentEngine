import * as dm from '@sim/physics/math';

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** 1 at x == target, falling off as a Gaussian with the given width. */
export const gaussFit = (x: number, target: number, width: number) => dm.exp(-(((x - target) / width) ** 2));
