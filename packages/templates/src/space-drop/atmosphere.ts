import * as dm from '@sim/physics/math';

/**
 * The 1976 US Standard Atmosphere: temperature and pressure from the layer formulas up to 86 km,
 * density from its tables above that (log-interpolated) up to 1,000 km. Everything that feeds the
 * trajectory uses @sim/physics/math, so a run gives the same numbers in Node and in Chrome.
 */

export const R_EARTH = 6_371_000;
/** Earth's gravitational parameter (m³/s²). */
export const MU = 3.986004418e14;
/** Earth's spin (rad/s): the air turns with the ground. */
export const OMEGA = 7.292115e-5;
const G0 = 9.80665;
/** Specific gas constant of air (J/kg·K) and its heat capacity at constant pressure. */
export const R_AIR = 287.053;
export const CP_AIR = 1004.7;
const GAMMA = 1.4;

/** Layers below 86 km: base geopotential height (m), base temperature (K), lapse rate (K/m), base pressure (Pa). */
const LAYERS: [number, number, number, number][] = [
  [0, 288.15, -0.0065, 101325],
  [11000, 216.65, 0, 22632.06],
  [20000, 216.65, 0.001, 5474.889],
  [32000, 228.65, 0.0028, 868.0187],
  [47000, 270.65, 0, 110.9063],
  [51000, 270.65, -0.0028, 66.93887],
  [71000, 214.65, -0.002, 3.956420],
];

/** Above 86 km: geometric altitude (km), density (kg/m³), kinetic temperature (K). */
const UPPER: [number, number, number][] = [
  [86, 6.958e-6, 186.87],
  [90, 3.416e-6, 186.87],
  [95, 1.393e-6, 188.42],
  [100, 5.604e-7, 195.08],
  [110, 9.708e-8, 240.0],
  [120, 2.222e-8, 360.0],
  [130, 8.152e-9, 469.27],
  [140, 3.831e-9, 559.63],
  [150, 2.076e-9, 634.39],
  [160, 1.233e-9, 696.29],
  [180, 5.194e-10, 790.07],
  [200, 2.541e-10, 854.56],
  [250, 6.073e-11, 941.33],
  [300, 1.916e-11, 976.01],
  [350, 7.014e-12, 990.06],
  [400, 2.803e-12, 995.83],
  [450, 1.184e-12, 998.22],
  [500, 5.215e-13, 999.24],
  [600, 1.137e-13, 999.85],
  [700, 3.070e-14, 999.97],
  [800, 1.136e-14, 999.99],
  [900, 5.759e-15, 1000],
  [1000, 3.561e-15, 1000],
];
const UPPER_LOG = UPPER.map(([, rho]) => dm.log(rho));

export interface Air {
  /** Density (kg/m³). */
  rho: number;
  /** Temperature (K). */
  T: number;
  /** Pressure (Pa). */
  p: number;
  /** Speed of sound (m/s). */
  a: number;
  /** Mean free path of the molecules (m). */
  mfp: number;
}

/** Air at a geometric altitude (m). Below the ground it's sea-level air; above 1,000 km it thins on. */
export function air(h: number): Air {
  const z = Math.max(0, h);
  let rho: number;
  let T: number;
  if (z < 86000) {
    const H = (R_EARTH * z) / (R_EARTH + z);
    let k = LAYERS.length - 1;
    while (k > 0 && H < LAYERS[k][0]) k--;
    const [Hb, Tb, L, pb] = LAYERS[k];
    T = Tb + L * (H - Hb);
    const p = L === 0 ? pb * dm.exp((-G0 * (H - Hb)) / (R_AIR * Tb)) : pb * dm.pow(Tb / T, G0 / (R_AIR * L));
    rho = p / (R_AIR * T);
  } else {
    const km = z / 1000;
    let k = 0;
    while (k < UPPER.length - 2 && km > UPPER[k + 1][0]) k++;
    const [z0, , T0] = UPPER[k];
    const [z1, , T1] = UPPER[k + 1];
    const u = (km - z0) / (z1 - z0);
    // Beyond the table, carry on with the last scale height.
    rho = dm.exp(UPPER_LOG[k] + (UPPER_LOG[k + 1] - UPPER_LOG[k]) * u);
    T = T0 + (T1 - T0) * Math.min(1, u);
  }
  // Above about 90 km the air is no longer well mixed and its molar mass drops; for drag only density
  // matters, and the speed of sound there is only nominal.
  return { rho, T, p: rho * R_AIR * T, a: Math.sqrt(GAMMA * R_AIR * Math.min(T, 1000)), mfp: 8.13e-8 / Math.max(rho, 1e-30) };
}

/** Where the atmosphere's named layers end (km), for the altitude ladder. */
export const LAYER_NAMES: { name: string; top: number }[] = [
  { name: 'Troposphere', top: 12 },
  { name: 'Stratosphere', top: 50 },
  { name: 'Mesosphere', top: 85 },
  { name: 'Thermosphere', top: 600 },
  { name: 'Exosphere', top: 10000 },
];

/**
 * Air's temperature right behind a strong shock (K), in chemical equilibrium: past ~2,500 K the
 * molecules break apart and soak up the energy, so a capsule at 7.8 km/s sees about 7,000 K, not the
 * 30,000 K a simple gas would give. Interpolated in the post-shock enthalpy (≈ v²/2) from equilibrium
 * air at about 0.1 atm (Hansen 1959; Anderson, Hypersonic and High-Temperature Gas Dynamics).
 */
const SHOCK_H: [number, number][] = [
  // [enthalpy MJ/kg, temperature K]
  [0, 0],
  [2.0, 1950],
  [3.0, 2700],
  [4.5, 3300],
  [7.0, 3700],
  [10, 4200],
  [14, 5000],
  [18, 5600],
  [24, 6300],
  [32, 7000],
  [45, 8600],
  [60, 10600],
  [80, 12200],
  [120, 14000],
  [200, 16500],
  [400, 20000],
  [1200, 27000],
];

export function shockTemperature(v: number, Tair: number): number {
  const h = (CP_AIR * Tair + 0.5 * v * v) / 1e6;
  let k = 0;
  while (k < SHOCK_H.length - 2 && h > SHOCK_H[k + 1][0]) k++;
  const [h0, T0] = SHOCK_H[k];
  const [h1, T1] = SHOCK_H[k + 1];
  const T = T0 + ((T1 - T0) * (h - h0)) / (h1 - h0);
  return Math.max(Tair, T);
}
