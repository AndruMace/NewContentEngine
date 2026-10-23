/**
 * Cellular-automaton rules.
 *
 * 3D rules use the "survive / birth / states / neighbourhood" notation of the 3D CA community
 * (e.g. "4/4/5/M"): a live cell with a survive count of live neighbours stays alive, an empty cell
 * with a birth count comes alive, and with more than two states a live cell that doesn't survive
 * decays through the remaining states (which don't count as live neighbours) before it's empty again.
 * M = the 26 cells of the surrounding cube (Moore), VN = the 6 face neighbours (von Neumann).
 *
 * 2D rules (for the Life tower) use the usual "B3/S23" notation on the 8 surrounding cells.
 */

export type Neighbourhood = 'moore' | 'vn';

export interface Rule3 {
  /** Bit n set: a live cell with n live neighbours stays alive. */
  survive: number;
  /** Bit n set: an empty cell with n live neighbours comes alive. */
  birth: number;
  /** 2 = plain alive/dead; more adds decay states. */
  states: number;
  nb: Neighbourhood;
}

/** Bits for a list like "0-6", "4", "5-7,12-13,15" (empty = none). */
function countMask(src: string, max: number): number {
  let mask = 0;
  for (const part of src.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map((n) => parseInt(n, 10));
    const hi = Number.isFinite(b) ? b : a;
    if (!Number.isFinite(a) || a < 0 || hi > max || hi < a) throw new Error(`Bad neighbour count "${part}"`);
    for (let n = a; n <= hi; n++) mask |= 1 << n;
  }
  return mask >>> 0;
}

/** Parse "S/B/C/N", e.g. "4/4/5/M" or "0-6/1,3/2/VN". */
export function parseRule3(src: string): Rule3 {
  const [s, b, c, n] = src.split('/');
  const nb = n?.trim().toUpperCase() === 'VN' ? 'vn' : 'moore';
  const max = nb === 'vn' ? 6 : 26;
  const states = parseInt(c, 10);
  if (!(states >= 2 && states <= 250)) throw new Error(`Bad state count in "${src}"`);
  return { survive: countMask(s, max), birth: countMask(b, max), states, nb };
}

export interface Rule2 {
  birth: number;
  survive: number;
}

/** Parse "B3/S23" (digits 0–8). */
export function parseRule2(src: string): Rule2 {
  const m = /^B([0-8]*)\/S([0-8]*)$/i.exec(src.trim());
  if (!m) throw new Error(`Bad 2D rule "${src}"`);
  const bits = (d: string) => [...d].reduce((acc, ch) => acc | (1 << Number(ch)), 0);
  return { birth: bits(m[1]), survive: bits(m[2]) };
}

/** How a crystal preset starts: a small symmetric cluster at the centre, or a bigger random ball. */
export type SeedKind = 'cluster' | 'ball';

export interface CrystalPreset {
  label: string;
  rule: string;
  seed: SeedKind;
  /** Half-size of the seed region (cells) and the fraction of it that starts alive. */
  seedSize: number;
  density: number;
}

/** 3D rules that grow something worth watching from a small start (tuned by eye in the playground). */
export const CRYSTAL_PRESETS = {
  crystal: { label: 'Crystal Growth', rule: '0-6/1,3/2/VN', seed: 'cluster', seedSize: 2, density: 0.5 },
  frost: { label: 'Frost', rule: '1-2/1,3/5/VN', seed: 'cluster', seedSize: 2, density: 0.5 },
  snowflake: { label: 'Snowflake', rule: '1,3/1,3/6/VN', seed: 'cluster', seedSize: 2, density: 0.4 },
  '445': { label: '445', rule: '4/4/5/M', seed: 'cluster', seedSize: 3, density: 0.45 },
  builder: { label: 'Builder', rule: '2,6,9/4,6,8-9/10/M', seed: 'cluster', seedSize: 3, density: 0.45 },
  shells: { label: 'Shells', rule: '3,5,7,9,11,15,17,19,21,23-24,26/3,6,8-9,11,14-17,19,24/7/M', seed: 'cluster', seedSize: 3, density: 0.35 },
  expanding: { label: 'Expanding Shell', rule: '6,7-9,11,13,15-16,18/6-10,13-14,16,18-19,22-25/5/M', seed: 'ball', seedSize: 5, density: 0.4 },
  coral: { label: 'Coral', rule: '5-8/6-7,9,12/4/M', seed: 'ball', seedSize: 6, density: 0.35 },
  amoeba: { label: 'Amoeba', rule: '9-26/5-7,12-13,15/5/M', seed: 'ball', seedSize: 5, density: 0.35 },
  pyroclastic: { label: 'Pyroclastic', rule: '4-7/6-8/10/M', seed: 'ball', seedSize: 6, density: 0.4 },
} satisfies Record<string, CrystalPreset>;

export type CrystalPresetId = keyof typeof CRYSTAL_PRESETS;
export const CRYSTAL_PRESET_IDS = Object.keys(CRYSTAL_PRESETS) as CrystalPresetId[];

/** Life-like 2D rules for the tower. */
export const LIFE_RULES = {
  life: { label: 'Game of Life', rule: 'B3/S23' },
  highlife: { label: 'HighLife', rule: 'B36/S23' },
  'day-night': { label: 'Day & Night', rule: 'B3678/S34678' },
  maze: { label: 'Mazectric', rule: 'B3/S1234' },
} as const;

export type LifeRuleId = keyof typeof LIFE_RULES;
export const LIFE_RULE_IDS = Object.keys(LIFE_RULES) as LifeRuleId[];

/** Neighbour counts in a mask as words: "exactly 3", "2 or 3", "5 to 7, 12, 13 or 15", "9 or more". */
export function countsText(mask: number, max: number): string {
  const runs: [number, number][] = [];
  for (let k = 0; k <= max; k++) {
    if (!((mask >>> k) & 1)) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === k - 1) last[1] = k;
    else runs.push([k, k]);
  }
  if (runs.length === 1 && runs[0][0] === runs[0][1]) return `exactly ${runs[0][0]}`;
  const parts = runs.flatMap(([a, b]) => (b === max && a > 0 ? [`${a} or more`] : b - a >= 2 ? [`${a} to ${b}`] : b === a ? [`${a}`] : [`${a}`, `${b}`]));
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/** A 3D rule in a sentence or two, for viewers. */
export function describeRule3(rule: Rule3): string {
  const max = rule.nb === 'vn' ? 6 : 26;
  const who = rule.nb === 'vn' ? 'its 6 face neighbours' : 'the 26 cubes touching it';
  const born = rule.birth ? `An empty cell with ${countsText(rule.birth, max)} live neighbours is born` : 'Nothing new is ever born';
  const fade = rule.states > 2 ? `, otherwise it fades through ${rule.states - 2} dying ${rule.states === 3 ? 'stage' : 'stages'}` : ', otherwise it dies';
  const lives = rule.survive ? `a live cell survives with ${countsText(rule.survive, max)}${fade}` : `a live cell never survives${rule.states > 2 ? ` (it fades through ${rule.states - 2} dying stages)` : ''}`;
  return `Every cube is a cell that looks at ${who}. ${born}; ${lives}.`;
}

/** A 2D rule in a sentence, for viewers. */
export function describeRule2(rule: Rule2): string {
  return `Each square looks at its 8 neighbours. An empty one with ${countsText(rule.birth, 8)} live neighbours comes alive; a live one survives with ${countsText(rule.survive, 8)}, otherwise it dies.`;
}
