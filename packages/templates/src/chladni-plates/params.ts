import { z } from 'zod';
import { storyParams } from '../story';

export const CHLADNI_MODES = ['rising-pitch', 'guess-the-pattern', 'plate-shapes'] as const;

export const SANDS = {
  sand: { name: 'sand', rgb: [236, 214, 160] },
  salt: { name: 'salt', rgb: [245, 248, 255] },
  gold: { name: 'gold dust', rgb: [255, 206, 92] },
  neon: { name: 'glowing powder', rgb: [80, 255, 210] },
} as const;

export const chladniSchema = z.object({
  mode: z.enum(CHLADNI_MODES).default('rising-pitch').meta({
    title: 'Mode',
    optionLabels: { 'rising-pitch': 'Rising pitch (patterns get complex)', 'guess-the-pattern': 'Guess the pattern', 'plate-shapes': 'Same note, square vs round plate' },
  }),
  ...storyParams(40),
  plate: z.enum(['square', 'circle']).default('square').meta({ title: 'Plate', modes: ['rising-pitch', 'guess-the-pattern'] }),
  patterns: z.number().int().min(3).max(8).default(5).meta({ title: 'Patterns (fewer if the plate has fewer)', step: 1, modes: ['rising-pitch'] }),
  startAt: z.number().int().min(0).max(12).default(0).meta({ title: 'First pattern (0 = simplest)', step: 1 }),
  spread: z.number().int().min(1).max(4).default(2).meta({ title: 'Jump between patterns', step: 1, modes: ['rising-pitch'] }),
  options: z.number().int().min(2).max(4).default(3).meta({ title: 'Patterns to choose from', step: 1, modes: ['guess-the-pattern'] }),
  rounds: z.number().int().min(1).max(3).default(2).meta({ title: 'Rounds', step: 1, modes: ['guess-the-pattern'] }),
  grains: z.number().int().min(6000).max(60000).default(28000).meta({ title: 'Grains', step: 1000 }),
  grainSize: z.number().min(1).max(3).default(2).meta({ title: 'Grain size (px)', step: 0.5 }),
  sand: z.enum(Object.keys(SANDS) as [keyof typeof SANDS, ...(keyof typeof SANDS)[]]).default('sand').meta({ title: 'Grains are' }),
  material: z.enum(['steel', 'brass', 'aluminium', 'glass']).default('steel').meta({ title: 'Plate material' }),
  size: z.number().min(15).max(40).default(24).meta({ title: 'Plate size (cm: side, or diameter)', step: 1 }),
  thickness: z.number().min(0.5).max(3).default(2).meta({ title: 'Plate thickness (mm)', step: 0.1 }),
  driver: z.enum(['auto', 'speaker', 'bow']).default('auto').meta({
    title: 'What makes it ring',
    optionLabels: { auto: 'Speaker under the centre, a bow for figures it can’t drive', speaker: 'Speaker only (only figures that move at the centre)', bow: 'Violin bow on the edge (any figure)' },
  }),
  showHz: z.boolean().default(true).meta({ title: 'Show the frequency' }),
  nodalHint: z.boolean().default(false).meta({ title: 'Trace the still lines at the end' }),
  guess: z.boolean().default(true).meta({ title: 'Comment-your-guess prompt' }),
});

export type ChladniParams = z.infer<typeof chladniSchema>;
