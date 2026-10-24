import { z } from 'zod';
import { storyParams } from '../story';

export const FLOCK_MODES = ['three-rules', 'remove-one', 'seven-neighbours', 'school'] as const;
export const SETTINGS = ['dusk', 'sunrise', 'overcast', 'neon', 'ocean'] as const;

export const flockSchema = z.object({
  mode: z.enum(FLOCK_MODES).default('three-rules').meta({
    title: 'Mode',
    optionLabels: { 'three-rules': 'Three rules make a flock', 'remove-one': 'Guess the missing rule', 'seven-neighbours': 'Seven neighbours (a turn ripples)', school: 'Fish school and a shark' },
  }),
  ...storyParams(42),
  count: z.number().int().min(300).max(3000).default(1100).meta({ title: 'Birds', step: 50 }),
  separation: z.number().min(0.3).max(3).default(1.2).meta({ title: 'Separation strength', step: 0.05 }),
  alignment: z.number().min(0.3).max(3).default(1).meta({ title: 'Alignment strength', step: 0.05 }),
  cohesion: z.number().min(0.3).max(3).default(1).meta({ title: 'Cohesion strength', step: 0.05 }),
  radius: z.number().min(5).max(16).default(9).meta({ title: 'How far a bird sees', step: 0.5 }),
  neighbours: z.number().int().min(0).max(12).default(7).meta({ title: 'Neighbours watched (0 = all within sight)', step: 1 }),
  speed: z.number().min(8).max(24).default(14).meta({ title: 'Speed', step: 0.5 }),
  agility: z.number().min(20).max(120).default(55).meta({ title: 'Agility', step: 1 }),
  predators: z.number().int().min(0).max(3).default(1).meta({ title: 'Predators', step: 1, modes: ['three-rules', 'school'] }),
  removed: z.enum(['random', 'separation', 'alignment', 'cohesion']).default('random').meta({ title: 'Rule switched off (random = picked by the seed)', modes: ['remove-one'] }),
  setting: z.enum(SETTINGS).default('dusk').meta({ title: 'Sky (ocean for the school)' }),
  drift: z.number().min(0).max(1).default(0.4).meta({ title: 'Camera drift', step: 0.05 }),
  guess: z.boolean().default(true).meta({ title: 'Comment-your-guess prompt' }),
});

export type FlockParams = z.infer<typeof flockSchema>;
