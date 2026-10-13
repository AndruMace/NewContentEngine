import type { VoiceId } from './types';

export interface Theme {
  id: string;
  name: string;
  /** Vertical background gradient, top -> bottom. */
  bg: [string, string];
  /** Object colors, sampled as a gradient. */
  palette: string[];
  ball: string;
  text: string;
  textStroke: string;
  accent: string;
  /** Bloom strength, 0 = off. */
  glow: number;
  /** Trail length multiplier, 0 = off. */
  trail: number;
  voice: VoiceId;
  /** Reverb wet level 0..1. */
  reverb: number;
  scanlines?: boolean;
  vignette?: number;
}

export const THEMES: Theme[] = [
  {
    id: 'neon-dark',
    name: 'Neon Dark',
    bg: ['#05010f', '#0b0322'],
    palette: ['#ff2a6d', '#ff8a00', '#ffe600', '#05ffa1', '#01cdfe', '#b967ff'],
    ball: '#ffffff',
    text: '#ffffff',
    textStroke: '#000000',
    accent: '#05ffa1',
    glow: 1.0,
    trail: 1,
    voice: 'marimba',
    reverb: 0.25,
    vignette: 0.5,
  },
  {
    id: 'pastel-minimal',
    name: 'Pastel Minimal',
    bg: ['#fdf6f0', '#f3e8ff'],
    palette: ['#ff6b8b', '#ff9f43', '#f7c948', '#4cd98a', '#38bdf8', '#7c83fd', '#c77dff'],
    ball: '#3d3a4b',
    text: '#3d3a4b',
    textStroke: '#ffffff',
    accent: '#ff8fab',
    glow: 0,
    trail: 0.6,
    voice: 'glass',
    reverb: 0.35,
  },
  {
    id: 'retro-crt',
    name: 'Retro CRT',
    bg: ['#001a0d', '#000a05'],
    palette: ['#39ff14', '#7dff63', '#c6ff00', '#00ffcc'],
    ball: '#eaffea',
    text: '#c8ffc8',
    textStroke: '#002200',
    accent: '#39ff14',
    glow: 1.2,
    trail: 1.4,
    voice: 'pluck',
    reverb: 0.2,
    scanlines: true,
    vignette: 0.8,
  },
  {
    id: 'mono-gold',
    name: 'Monochrome Gold',
    bg: ['#0c0c0c', '#1a1712'],
    palette: ['#fff3c4', '#ffd166', '#e0a526', '#b8860b'],
    ball: '#fff8e1',
    text: '#fff3c4',
    textStroke: '#000000',
    accent: '#ffd166',
    glow: 0.7,
    trail: 0.8,
    voice: 'bell',
    reverb: 0.4,
    vignette: 0.6,
  },
  {
    id: 'sunset',
    name: 'Sunset',
    bg: ['#1a0b2e', '#3d1036'],
    // Warm first (most templates sample the start), then the dusk sky's teal and blue, ending in violet and pink.
    palette: ['#ff6b6b', '#ff9e57', '#ffd166', '#4ecdc4', '#6c8cff', '#c56cf0', '#f78fb3'],
    ball: '#fff4e6',
    text: '#ffffff',
    textStroke: '#2b0a2e',
    accent: '#ffd166',
    glow: 0.8,
    trail: 1,
    voice: 'glass',
    reverb: 0.35,
    vignette: 0.5,
  },
  {
    id: 'ocean',
    name: 'Deep Ocean',
    bg: ['#021526', '#03346e'],
    // Ocean blues first, then reef and glowing sea-life accents (jellyfish violet, coral, anglerfish yellow, sea-green).
    palette: ['#00d2ff', '#48cae4', '#4361ee', '#c77dff', '#ff7b6b', '#ffd166', '#3ddc97'],
    ball: '#e0fbfc',
    text: '#ffffff',
    textStroke: '#001020',
    accent: '#90e0ef',
    glow: 0.9,
    trail: 1.2,
    voice: 'bell',
    reverb: 0.45,
    vignette: 0.55,
  },
  // Palettes run around the colour wheel so gradient blends stay vivid (blending opposite hues goes grey).
  {
    id: 'aurora',
    name: 'Aurora',
    bg: ['#020a10', '#05201d'],
    palette: ['#c6ff6b', '#3dff9a', '#2de2e6', '#7cc8ff', '#9b5cff', '#ff4fd8'],
    ball: '#f2fff8',
    text: '#ffffff',
    textStroke: '#00140f',
    accent: '#3dff9a',
    glow: 0.9,
    trail: 1.1,
    voice: 'glass',
    reverb: 0.4,
    vignette: 0.55,
  },
  {
    id: 'jewel',
    name: 'Jewel',
    bg: ['#0b0a10', '#17121f'],
    palette: ['#e0115f', '#ffb547', '#00c878', '#19d3c5', '#2f6bff', '#a066ff'],
    ball: '#fffaf0',
    text: '#ffffff',
    textStroke: '#000000',
    accent: '#ffb547',
    // Low glow: gemstones stay deep and saturated instead of blooming into neon.
    glow: 0.45,
    trail: 0.8,
    voice: 'bell',
    reverb: 0.4,
    vignette: 0.6,
  },
  {
    id: 'ember',
    name: 'Ember',
    bg: ['#100a07', '#22120c'],
    palette: ['#e94f6e', '#ff6f3c', '#ffc93c', '#9bc53d', '#3fb8af', '#b67bd6'],
    ball: '#fff4e8',
    text: '#ffffff',
    textStroke: '#1a0800',
    accent: '#ffc93c',
    glow: 0.6,
    trail: 0.9,
    voice: 'pluck',
    reverb: 0.3,
    vignette: 0.65,
  },
  {
    id: 'arcade',
    name: 'Arcade',
    // Arcade-cabinet navy, so it doesn't read as the same near-black as Jewel.
    bg: ['#060a1c', '#0e1838'],
    palette: ['#ff3b3b', '#ff8c1a', '#ffd60a', '#22c55e', '#3b82f6', '#ff5fa2'],
    ball: '#ffffff',
    text: '#ffffff',
    textStroke: '#000000',
    accent: '#ffd60a',
    // Flat and crisp: bright primaries with almost no bloom.
    glow: 0.25,
    trail: 0.7,
    voice: 'marimba',
    reverb: 0.2,
    vignette: 0.35,
  },
];

export function getTheme(id: string): Theme {
  const theme = THEMES.find((t) => t.id === id);
  if (!theme) throw new Error(`Unknown theme: ${id}`);
  return theme;
}
