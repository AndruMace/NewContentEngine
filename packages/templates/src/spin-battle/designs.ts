/**
 * Top designs: each archetype has several contour shapes. A contour is a real collision polygon
 * (it spins with the top), so the shape decides how hits land: a hooked face sweeping into an
 * opponent strikes hard, a smooth rim glances off. Profiles use @sim/physics/math so the polygon is
 * bit-identical in Node and Chrome.
 */
import type { Rng } from '@sim/engine';
import * as dm from '@sim/physics/math';
import type { TopType } from './tops';

export interface Design {
  id: string;
  name: string;
  type: TopType;
  /** Contour radius (fraction of the top's radius, max 1) at profile angle a. */
  profile: (a: number) => number;
  /** Small physical differences that come with the shape. */
  radiusScale: number;
  massScale: number;
}

const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);
const pw = (x: number, e: number) => (x <= 0 ? 0 : dm.pow(x, e));
/** A hooked tooth: rises slowly over the period, then a steep face (the hook) drops back. */
const hook = (u: number, lo: number, rise: number, e: number) => (u < rise ? lo + (1 - lo) * pw(u / rise, e) : 1 - (1 - lo) * ((u - rise) / (1 - rise)));

export const DESIGNS: Design[] = [
  // Attack: hooks and spikes that catch the opponent.
  { id: 'tri-blade', name: 'Tri-Blade', type: 'attack', profile: (a) => hook(frac((3 * a) / TAU), 0.62, 0.85, 0.7), radiusScale: 1, massScale: 1 },
  { id: 'sickle', name: 'Sickle', type: 'attack', profile: (a) => hook(frac((2 * a) / TAU), 0.55, 0.88, 1.4), radiusScale: 1.05, massScale: 0.95 },
  { id: 'starburst', name: 'Starburst', type: 'attack', profile: (a) => 0.68 + 0.32 * pw(Math.abs(dm.cos((5 * a) / 2)), 4), radiusScale: 1, massScale: 1 },
  // Defense: round, heavy, flat faces that turn hits aside.
  { id: 'bastion', name: 'Bastion', type: 'defense', profile: (a) => 0.92 + 0.08 * Math.abs(dm.cos(4 * a)), radiusScale: 1, massScale: 1 },
  {
    id: 'fortress',
    name: 'Fortress',
    type: 'defense',
    profile: (a) => {
      const seg = TAU / 8;
      return dm.cos(seg / 2) / dm.cos(frac(a / seg) * seg - seg / 2);
    },
    radiusScale: 1,
    massScale: 1.04,
  },
  { id: 'dome', name: 'Dome', type: 'defense', profile: (a) => 0.97 + 0.03 * dm.cos(3 * a), radiusScale: 1.03, massScale: 1.06 },
  // Stamina: smooth rims that let hits slide past.
  { id: 'halo', name: 'Halo', type: 'stamina', profile: (a) => 0.97 + 0.03 * dm.cos(12 * a), radiusScale: 1, massScale: 1 },
  { id: 'saucer', name: 'Saucer', type: 'stamina', profile: () => 1, radiusScale: 1.06, massScale: 0.97 },
  { id: 'serrate', name: 'Serrate', type: 'stamina', profile: (a) => hook(frac((16 * a) / TAU), 0.9, 0.8, 1), radiusScale: 1, massScale: 1 },
  // Balance: lobes and teeth, a bit of both.
  { id: 'trinity', name: 'Trinity', type: 'balance', profile: (a) => 0.78 + 0.22 * pw(Math.abs(dm.cos(3 * a)), 1.5), radiusScale: 1, massScale: 1 },
  { id: 'cross', name: 'Cross', type: 'balance', profile: (a) => 0.8 + 0.2 * Math.min(1, 1.6 * Math.abs(dm.cos(2 * a))), radiusScale: 1, massScale: 1 },
  {
    id: 'cog',
    name: 'Cog',
    type: 'balance',
    profile: (a) => {
      const u = frac((10 * a) / TAU);
      if (u < 0.4) return 1;
      if (u < 0.5) return 1 - 0.16 * ((u - 0.4) / 0.1);
      if (u < 0.9) return 0.84;
      return 0.84 + 0.16 * ((u - 0.9) / 0.1);
    },
    radiusScale: 1,
    massScale: 1,
  },
];

export const designsOf = (type: TopType) => DESIGNS.filter((d) => d.type === type);
export const getDesign = (id: string) => DESIGNS.find((d) => d.id === id)!;
export const pickDesign = (type: TopType, rng: Rng) => rng.pick(designsOf(type));

/** Vertices per contour polygon. */
export const POLY_N = 96;

/** The contour polygon in the top's own frame, scaled to radius r (profile angle a_i = i/N · τ). */
export function contourPolygon(d: Design, r: number): { x: Float64Array; y: Float64Array; min: number; max: number } {
  const x = new Float64Array(POLY_N);
  const y = new Float64Array(POLY_N);
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < POLY_N; i++) {
    const a = (i / POLY_N) * TAU;
    const rr = r * d.profile(a);
    x[i] = rr * dm.cos(a);
    y[i] = rr * dm.sin(a);
    min = Math.min(min, rr);
    max = Math.max(max, rr);
  }
  return { x, y, min, max };
}
