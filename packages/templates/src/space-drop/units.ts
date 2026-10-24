import { round2 } from './impact';

export type Units = 'metric' | 'imperial';

const sep = (x: number) => Math.round(x).toLocaleString('en-US');

/** Speed for speech and captions: "26,000 km/h", "16,000 mph" (three significant figures at most). */
export function speedText(v: number, u: Units): string {
  const x = u === 'metric' ? v * 3.6 : v * 2.23694;
  return `${sig(x)} ${u === 'metric' ? 'km/h' : 'mph'}`;
}

/** Altitude: "100 km", "62 miles"; under a kilometre in metres or feet. */
export function altText(h: number, u: Units): string {
  if (u === 'metric') return h >= 1000 ? `${round2(h / 1000)} km` : `${sig(h)} m`;
  const mi = h / 1609.34;
  return mi >= 1 ? `${round2(mi)} miles` : `${sig(h * 3.28084)} feet`;
}

/** A temperature (from kelvin): "1,460 °C". */
export function tempText(K: number, u: Units): string {
  const c = K - 273.15;
  return u === 'metric' ? `${sig(c)} °C` : `${sig(c * 1.8 + 32)} °F`;
}

/** Number only, for the speech writer ("1,460 degrees"). */
export const tempNumber = (K: number, u: Units) => (u === 'metric' ? sig(K - 273.15) : sig((K - 273.15) * 1.8 + 32));

export function lengthText(m: number, u: Units): string {
  if (u === 'metric') return m >= 1000 ? `${round2(m / 1000)} km` : m >= 1 ? `${round2(m)} m` : `${round2(m * 100)} cm`;
  const ft = m * 3.28084;
  return ft >= 5280 ? `${round2(ft / 5280)} miles` : ft >= 1 ? `${round2(ft)} feet` : `${round2(ft * 12)} inches`;
}

export function massText(kg: number, u: Units): string {
  if (u === 'metric') {
    if (kg < 1) return `${round2(kg * 1000)} grams`;
    if (kg < 1000) return `${round2(kg)} kg`;
    return `${round2(kg / 1000)} tonnes`;
  }
  const lb = kg * 2.20462;
  if (lb < 1) return `${round2(lb * 16)} ounces`;
  if (lb < 4000) return `${round2(lb)} pounds`;
  return `${round2(lb / 2000)} tons`;
}

/** "7 minutes", "1 hour 12 minutes", "48 seconds". */
export function durationText(s: number): string {
  if (s < 90) return `${Math.round(s)} seconds`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} hour${h > 1 ? 's' : ''}${m ? ` ${m} minutes` : ''}`;
}

/** Three significant figures, with separators. */
export function sig(x: number): string {
  const a = Math.abs(x);
  if (a >= 1000) return sep(Number(x.toPrecision(3)));
  if (a >= 10) return sep(x);
  return String(+x.toPrecision(2));
}

/** Readout pieces for the HUD: a number and its unit. */
export function speedReadout(v: number, u: Units): [string, string] {
  if (u === 'metric') return v >= 1000 ? [(v / 1000).toFixed(2), 'km/s'] : [v.toFixed(v < 10 ? 1 : 0), 'm/s'];
  const mph = v * 2.23694;
  return [sep(mph), 'mph'];
}

export function altReadout(h: number, u: Units): [string, string] {
  if (u === 'metric') return h >= 10_000 ? [(h / 1000).toFixed(1), 'km'] : h >= 1000 ? [(h / 1000).toFixed(2), 'km'] : [h.toFixed(0), 'm'];
  const ft = h * 3.28084;
  return ft >= 52_800 ? [(ft / 5280).toFixed(1), 'mi'] : [sep(ft), 'ft'];
}

export function tempReadout(K: number, u: Units): [string, string] {
  const c = K - 273.15;
  return u === 'metric' ? [sep(c), '°C'] : [sep(c * 1.8 + 32), '°F'];
}
