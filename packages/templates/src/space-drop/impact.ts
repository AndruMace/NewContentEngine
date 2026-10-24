import * as dm from '@sim/physics/math';
import { MATERIALS, surfaceArea, type Body, type Shape } from './objects';
import type { Trajectory } from './physics';

/**
 * What the impact does: its energy (as TNT and against things people know), the crater it digs
 * (Holsapple's point-source scaling, strength and gravity regimes, 1993) and how hard it shakes the
 * ground (Schultz & Gault's seismic efficiency of 10⁻⁴, as in Collins et al. 2005).
 */

export const GROUNDS = {
  sand: { name: 'desert sand', rho: 1600, K1: 0.24, mu: 0.41, Y: 0, Kr: 1.3 },
  soil: { name: 'farmland', rho: 1800, K1: 0.2, mu: 0.55, Y: 0.3e6, Kr: 1.1 },
  rock: { name: 'granite', rho: 2650, K1: 0.2, mu: 0.55, Y: 18e6, Kr: 1.1 },
} as const;
export type Ground = keyof typeof GROUNDS;

const NU = 0.4;
const G0 = 9.80665;
export const TNT_J_PER_KG = 4.184e6;

function volumeOf(s: Shape): number {
  switch (s.kind) {
    case 'box':
      return s.l * s.w * s.h;
    case 'cyl':
      return (Math.PI * s.d * s.d * s.l) / 4;
    case 'sphere':
      return (Math.PI * s.d * s.d * s.d) / 6;
    case 'disc':
      return (Math.PI * s.d * s.d * s.t) / 4;
  }
}

export interface Crater {
  /** Rim-to-rim diameter and depth (m). */
  diameter: number;
  depth: number;
  /** Volume dug out (m³). */
  volume: number;
}

/**
 * The crater a projectile of mass m (kg) and bulk density delta (kg/m³) digs, hitting at v (m/s) at
 * `angle` degrees above the ground. Only the downward part of the speed digs.
 */
export function crater(m: number, delta: number, v: number, angle: number, ground: Ground): Crater {
  const g = GROUNDS[ground];
  const U = Math.max(0.1, v * dm.sin((Math.max(5, angle) * Math.PI) / 180));
  const a = dm.pow((3 * m) / (4 * Math.PI * delta), 1 / 3);
  const ratio = g.rho / delta;
  const pi2 = ((G0 * a) / (U * U)) * dm.pow(ratio, (6 * NU - 2 - g.mu) / (3 * g.mu));
  const pi3 = g.Y > 0 ? dm.pow((g.Y / (g.rho * U * U)) * dm.pow(ratio, (6 * NU - 2) / (3 * g.mu)), (2 + g.mu) / 2) : 0;
  const piV = g.K1 * dm.pow(pi2 + pi3, (-3 * g.mu) / (2 + g.mu));
  const volume = (piV * m) / g.rho;
  const diameter = 2 * g.Kr * dm.pow(volume, 1 / 3);
  return { diameter, depth: diameter * 0.2, volume };
}

/** The impact crater of a run (null if it never reached the ground). */
export function craterOf(tr: Trajectory, ground: Ground): Crater | null {
  const im = tr.impact;
  if (!im) return null;
  const body: Body = im.body;
  // A flattened cloud of rubble hits as a wide, loose mass.
  const vol = im.L > 0 ? (Math.PI * im.L * im.L * im.L) / 6 : volumeOf(im.shape);
  const delta = Math.min(MATERIALS[body.material].rho, Math.max(50, im.mass / vol));
  return crater(im.mass, delta, im.v, im.angle, ground);
}

/** Impact energy (J) of everything that lands (all the pieces, if it broke into several alike). */
export const impactEnergy = (tr: Trajectory) => (tr.impact ? 0.5 * tr.impact.mass * tr.impact.count * tr.impact.v * tr.impact.v : 0);

/** Earthquake magnitude the impact would register as (only meaningful above about 1). */
export const seismicMagnitude = (energyJ: number) => 0.67 * (dm.log(Math.max(1, energyJ)) / Math.LN10) - 5.87;

/** Energies people have a feel for (J), smallest first. */
export const REFERENCES: { J: number; name: string }[] = [
  { J: 0.74, name: 'an apple falling off a table' },
  { J: 116, name: 'a fastball pitch' },
  { J: 5.8e5, name: 'a car crashing at 100 km/h' },
  { J: 4.184e6, name: 'a kilogram of TNT' },
  { J: 1e9, name: 'a lightning bolt' },
  { J: 4.184e9, name: 'a tonne of TNT' },
  { J: 4.6e10, name: 'the biggest non-nuclear bomb ever used' },
  { J: 6.3e13, name: 'the Hiroshima bomb' },
  { J: 2.1e15, name: 'the Chelyabinsk meteor' },
  { J: 4.2e16, name: 'the Tunguska blast' },
];

/** The closest thing to compare an energy with, and how many of it. */
export function comparison(J: number): { ref: (typeof REFERENCES)[number]; times: number } {
  let best = REFERENCES[0];
  for (const r of REFERENCES) if (r.J <= J * 1.5) best = r;
  return { ref: best, times: J / best.J };
}

/** "about 40 tonnes of TNT", "3.2 kg of TNT", "12 kilotons of TNT". */
export function tntLabel(J: number): string {
  const kg = J / TNT_J_PER_KG;
  if (kg < 0.001) return `${round2(kg * 1e6)} mg of TNT`;
  if (kg < 1) return `${round2(kg * 1000)} g of TNT`;
  if (kg < 1000) return `${round2(kg)} kg of TNT`;
  if (kg < 1e6) return `${round2(kg / 1000)} tonnes of TNT`;
  if (kg < 1e9) return `${round2(kg / 1e6)} kilotons of TNT`;
  return `${round2(kg / 1e9)} megatons of TNT`;
}

/** "4.8 GJ", "160 kJ". */
export function energyLabel(J: number): string {
  const units: [number, string][] = [
    [1e18, 'EJ'],
    [1e15, 'PJ'],
    [1e12, 'TJ'],
    [1e9, 'GJ'],
    [1e6, 'MJ'],
    [1e3, 'kJ'],
  ];
  for (const [k, u] of units) if (J >= k) return `${round2(J / k)} ${u}`;
  return `${round2(J)} J`;
}

/** Two significant figures, as text with separators. */
export function round2(x: number): string {
  if (x === 0) return '0';
  const p = x >= 100 ? Math.round(x) : +x.toPrecision(2);
  return p.toLocaleString('en-US');
}

/** "3 times", "1,200 times", "half". */
export function timesLabel(x: number): string {
  if (x < 0.75) return x < 0.4 ? `${round2(x * 100)}% of` : 'half';
  if (x < 1.5) return 'about the same as';
  return `${round2(x)} times`;
}

/** How big the object is, for captions ("6.2 m long, 31 cm wide"). */
export function dimsLabel(s: Shape): string {
  const len = (m: number) => (m < 0.1 ? `${round2(m * 1000)} mm` : m < 1 ? `${round2(m * 100)} cm` : `${round2(m)} m`);
  switch (s.kind) {
    case 'box':
      return `${len(s.l)} long`;
    case 'cyl':
      return `${len(s.l)} long, ${len(s.d)} wide`;
    case 'sphere':
      return `${len(s.d)} across`;
    case 'disc':
      return `${len(s.d)} across`;
  }
}

export { surfaceArea };
