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
    palette: ['#ff6b6b', '#ff9e57', '#ffd166', '#f78fb3', '#c56cf0'],
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
    palette: ['#00d2ff', '#48cae4', '#90e0ef', '#6eacda', '#4361ee'],
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
];

export function getTheme(id: string): Theme {
  const theme = THEMES.find((t) => t.id === id);
  if (!theme) throw new Error(`Unknown theme: ${id}`);
  return theme;
}
