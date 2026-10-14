import type { Rng } from '@sim/engine';
import type { Team } from '../fx';

export type TopType = 'attack' | 'defense' | 'stamina' | 'balance';
export const TOP_TYPES: TopType[] = ['attack', 'defense', 'stamina', 'balance'];

export const MATCHUPS = ['random', 'attack-defense', 'attack-stamina', 'defense-stamina', 'mirror'] as const;
export type Matchup = (typeof MATCHUPS)[number];

export interface TopStats {
  label: string;
  emoji: string;
  /** One line for the VS card, so viewers can pick a side. */
  tagline: string;
  /** Stadium units (the rim is at radius 1). */
  radius: number;
  mass: number;
  /** How hard the tip drives the top around the bowl (flat tips race, sharp tips sit still). */
  traction: number;
  /** RPM fraction lost per second just spinning. */
  spinDecay: number;
  /** How much the contour adds to the recoil when tops meet. */
  smash: number;
  restitution: number;
  /** How much spin a hit costs this top (heavy, round contours shrug hits off). */
  fragility: number;
  /** How much its path bends towards the opponent (attack tops hunt, stamina tops wait). */
  aggression: number;
  /** Resistance to being knocked out of the stadium (flat rubber tips grip, sharp tips slide). */
  hold: number;
}

/**
 * Attack races around the rim and hits hard but burns its own spin; Defense is heavy and hard to
 * knock out; Stamina sits in the middle and outspins everything; Balance is in between. Tuned in
 * spin-battle.test.ts so every type wins about half its duels: types change how a fight looks, not
 * who tends to win.
 */
export const TOPS: Record<TopType, TopStats> = {
  attack: { label: 'Attack', tagline: 'Hits the hardest', emoji: '⚔️', radius: 0.16, mass: 1.12, traction: 4.3, spinDecay: 0.05, smash: 1.25, restitution: 0.85, fragility: 0.97, aggression: 0.55, hold: 1.38 },
  defense: { label: 'Defense', tagline: 'Hardest to knock out', emoji: '🛡️', radius: 0.172, mass: 1.63, traction: 3.28, spinDecay: 0.0422, smash: 0.55, restitution: 0.42, fragility: 0.67, aggression: 0.36, hold: 0.75 },
  stamina: { label: 'Stamina', tagline: 'Spins the longest', emoji: '⏳', radius: 0.165, mass: 0.93, traction: 0.62, spinDecay: 0.0306, smash: 0.38, restitution: 0.65, fragility: 1.15, aggression: 0, hold: 0.89 },
  balance: { label: 'Balance', tagline: 'A bit of everything', emoji: '⚖️', radius: 0.162, mass: 1.32, traction: 3.75, spinDecay: 0.0405, smash: 0.58, restitution: 0.48, fragility: 0.87, aggression: 0.41, hold: 1.01 },
};

/**
 * Opposite-spin fights play differently (the tops curl round the bowl in opposite directions and
 * meet head-on, and their contours swing them round together rather than flinging them apart), so
 * each type's spin cost per hit and knockout resistance get their own tuning there, to keep the
 * odds a coin flip. Tuned with spin-battle.test.ts.
 */
export const OPPOSITE: Record<TopType, { fragility: number; hold: number }> = {
  attack: { fragility: 1, hold: 0.48 },
  defense: { fragility: 1.59, hold: 1 },
  stamina: { fragility: 0.73, hold: 1.26 },
  balance: { fragility: 1, hold: 0.67 },
};

export function resolveMatchup(m: Matchup, rng: Rng): [TopType, TopType] {
  let pair: [TopType, TopType];
  if (m === 'random') {
    const a = rng.pick(TOP_TYPES);
    pair = [a, rng.pick(TOP_TYPES.filter((t) => t !== a))];
  } else if (m === 'mirror') {
    const a = rng.pick(TOP_TYPES);
    pair = [a, a];
  } else {
    pair = m.split('-') as [TopType, TopType];
  }
  // Which side each type starts on is random too.
  return rng.chance(0.5) ? pair : [pair[1], pair[0]];
}

/**
 * Invented names (no real toy-line product names), each with a colour and an emblem. Ordered so
 * neighbouring entries have clearly different colours.
 */
export const NAMED_TOPS: Team[] = [
  { label: 'Ember Lynx', icon: '🔥', color: '#ff5a1f' },
  { label: 'Frost Mammoth', icon: '❄️', color: '#7dd3fc' },
  { label: 'Volt Hornet', icon: '⚡', color: '#facc15' },
  { label: 'Thorn Mantis', icon: '🌿', color: '#22c55e' },
  { label: 'Neon Jackal', icon: '💜', color: '#d946ef' },
  { label: 'Ruby Scarab', icon: '💎', color: '#e11d48' },
  { label: 'Tide Serpent', icon: '🌊', color: '#2563eb' },
  { label: 'Solar Stag', icon: '☀️', color: '#f59e0b' },
  { label: 'Lunar Owl', icon: '🌙', color: '#a5b4fc' },
  { label: 'Jade Kraken', icon: '🐙', color: '#14b8a6' },
  { label: 'Magma Bison', icon: '🌋', color: '#dc2626' },
  { label: 'Acid Beetle', icon: '🪲', color: '#a3e635' },
  { label: 'Onyx Raven', icon: '🪶', color: '#64748b' },
  { label: 'Zephyr Falcon', icon: '🦅', color: '#e5e7eb' },
  { label: 'Iron Tortoise', icon: '🐢', color: '#94a3b8' },
  { label: 'Gold Sphinx', icon: '👑', color: '#d4af37' },
];
