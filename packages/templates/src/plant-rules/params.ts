import { z } from 'zod';
import { storyParams } from '../story';

export const PLANT_MODES = ['rewrite', 'angle-sweep', 'garden', 'fractals'] as const;
export const PLANTS = ['fern', 'bush', 'tree', 'seaweed', 'grass', 'flowering'] as const;
export const FRACTALS = ['dragon', 'koch', 'sierpinski', 'hilbert'] as const;

const PLANT_ONLY = ['rewrite', 'angle-sweep'] as const;

export const plantSchema = z.object({
  mode: z.enum(PLANT_MODES).default('rewrite').meta({
    title: 'Mode',
    optionLabels: { rewrite: 'One rule grows a plant', 'angle-sweep': 'Same rule, sweep the angle', garden: 'Garden (rules with chance)', fractals: 'Fractals (Koch, dragon…)' },
  }),
  ...storyParams(40),
  preset: z.enum(['random', ...PLANTS]).default('random').meta({ title: 'Plant (random = picked by the seed)', modes: [...PLANT_ONLY] }),
  fractal: z.enum(['random', ...FRACTALS]).default('random').meta({ title: 'Fractal (random = picked by the seed)', modes: ['fractals'] }),
  rounds: z.number().int().min(0).max(12).default(0).meta({ title: 'Rounds (0 = the preset’s best)', step: 1 }),
  angle: z.number().min(0).max(60).default(0).meta({ title: 'Branch angle (0 = the preset’s)', step: 0.5, modes: ['rewrite', 'garden'] }),
  sweepFrom: z.number().min(5).max(45).default(12).meta({ title: 'Sweep from (degrees)', step: 0.5, modes: ['angle-sweep'] }),
  sweepTo: z.number().min(15).max(75).default(45).meta({ title: 'Sweep to (degrees)', step: 0.5, modes: ['angle-sweep'] }),
  plants: z.number().int().min(3).max(7).default(5).meta({ title: 'Plants', step: 1, modes: ['garden'] }),
  jitter: z.number().min(0).max(12).default(3).meta({ title: 'Natural wobble (degrees)', step: 0.5 }),
  taper: z.number().min(0.5).max(0.95).default(0.78).meta({ title: 'Branch taper', step: 0.01 }),
  leaves: z.boolean().default(true).meta({ title: 'Leaves' }),
  flowers: z.boolean().default(true).meta({ title: 'Flowers at the end' }),
  wind: z.number().min(0).max(1).default(0.35).meta({ title: 'Wind', step: 0.05 }),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']).default('spring').meta({ title: 'Season' }),
  background: z.enum(['night', 'paper', 'greenhouse']).default('night').meta({ title: 'Background' }),
  showString: z.boolean().default(true).meta({ title: 'Show the symbol string' }),
  maxSegments: z.number().int().min(2000).max(60000).default(24000).meta({ title: 'Most lines drawn', step: 1000 }),
  guess: z.boolean().default(true).meta({ title: 'Comment-your-guess prompt' }),
});

export type PlantParams = z.infer<typeof plantSchema>;
