import { z } from 'zod';
import { storyParams } from '../story';

export const DRIFT_MODES = ['race', 'drift-vs-selection', 'small-vs-large', 'bottleneck', 'lucky-mutant'] as const;
export type DriftMode = (typeof DRIFT_MODES)[number];

/** Colour sets, each colour with the name the narration uses. */
export const COLOURS = {
  vivid: [
    { name: 'red', hex: '#ff4d5e' },
    { name: 'blue', hex: '#3d8bff' },
    { name: 'yellow', hex: '#ffd23d' },
    { name: 'green', hex: '#3ddc84' },
    { name: 'purple', hex: '#b36bff' },
    { name: 'orange', hex: '#ff9a3d' },
  ],
  pastel: [
    { name: 'pink', hex: '#ff9ec4' },
    { name: 'sky blue', hex: '#8fd3ff' },
    { name: 'lemon', hex: '#fff08a' },
    { name: 'mint', hex: '#9ef0c4' },
    { name: 'lilac', hex: '#c9a8ff' },
    { name: 'peach', hex: '#ffc39e' },
  ],
  earth: [
    { name: 'rust', hex: '#d0603f' },
    { name: 'teal', hex: '#2aa597' },
    { name: 'sand', hex: '#e9c46a' },
    { name: 'moss', hex: '#87a85a' },
    { name: 'plum', hex: '#a05d82' },
    { name: 'slate', hex: '#7d8b9b' },
  ],
  neon: [
    { name: 'pink', hex: '#ff2a6d' },
    { name: 'cyan', hex: '#01cdfe' },
    { name: 'lime', hex: '#b6ff3b' },
    { name: 'gold', hex: '#ffd700' },
    { name: 'violet', hex: '#b967ff' },
    { name: 'orange', hex: '#ff8a00' },
  ],
} as const satisfies Record<string, readonly { name: string; hex: string }[]>;

/** Lucky mutant's two colours (whatever the palette). */
export const MUTANT = { mutant: { name: 'golden', hex: '#ffc93d' }, wild: { name: 'grey', hex: '#9aa3ad' } };

/** How individuals look, and what the narration calls them. */
export const SKINS = {
  beetles: { one: 'beetle', plural: 'beetles' },
  flowers: { one: 'flower', plural: 'flowers' },
  fish: { one: 'fish', plural: 'fish' },
  marbles: { one: 'marble', plural: 'marbles' },
  cells: { one: 'cell', plural: 'cells' },
} as const;

const SPLIT: DriftMode[] = ['race', 'small-vs-large', 'bottleneck'];

export const driftSchema = z.object({
  mode: z.enum(DRIFT_MODES).default('race').meta({
    title: 'Mode',
    optionLabels: { race: 'Colour race (which takes over?)', 'drift-vs-selection': 'Drift vs selection (does the fitter one win?)', 'small-vs-large': 'Small vs large population', bottleneck: 'Bottleneck (a crash)', 'lucky-mutant': 'Lucky mutant (one in N)' },
  }),
  ...storyParams(45),
  popSize: z.number().int().min(10).max(600).default(24).meta({ title: 'Population (the big one, for small vs large)', step: 1 }),
  smallSize: z.number().int().min(6).max(60).default(12).meta({ title: 'Small population', step: 1, modes: ['small-vs-large'] }),
  colours: z.number().int().min(2).max(6).default(4).meta({ title: 'Colours', modes: SPLIT }),
  advantage: z.number().min(0.01).max(0.5).default(0.1).meta({ title: 'Fitness advantage of the first colour', step: 0.01, modes: ['drift-vs-selection'] }),
  bottleneckSize: z.number().int().min(2).max(40).default(5).meta({ title: 'Survivors of the crash', step: 1, modes: ['bottleneck'] }),
  view: z.enum(['auto', 'lineage', 'grid']).default('auto').meta({ title: 'View (auto: family tree for small populations)', optionLabels: { auto: 'Auto', lineage: 'Family tree', grid: 'Grid' } }),
  skin: z.enum(Object.keys(SKINS) as [keyof typeof SKINS, ...(keyof typeof SKINS)[]]).default('beetles').meta({ title: 'Individuals' }),
  palette: z.enum(Object.keys(COLOURS) as [keyof typeof COLOURS, ...(keyof typeof COLOURS)[]]).default('vivid').meta({ title: 'Colours style' }),
  chart: z.boolean().default(true).meta({ title: 'Share chart' }),
  guess: z.boolean().default(true).meta({ title: 'Comment-your-guess prompt' }),
  maxGenerations: z.number().int().min(60).max(4000).default(1500).meta({ title: 'Generation limit', step: 10 }),
});

export type DriftParams = z.infer<typeof driftSchema>;
