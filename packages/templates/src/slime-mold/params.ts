import { z } from 'zod';
import { storyParams } from '../story';

export const MOLD_MODES = ['network', 'maze', 'foraging', 'tokyo'] as const;

const FOOD_MODES = ['network', 'foraging'] as const;

export const moldSchema = z.object({
  mode: z.enum(MOLD_MODES).default('network').meta({
    title: 'Mode',
    optionLabels: { network: 'Connect the food (vs the shortest network)', maze: 'Solve a maze', foraging: 'Explore, then prune', tokyo: 'Tokyo rail (2010 experiment, approximate map)' },
  }),
  ...storyParams(42),
  agents: z.number().int().min(15000).max(150000).default(50000).meta({ title: 'Agents', step: 5000 }),
  sensorAngle: z.number().min(15).max(60).default(30).meta({ title: 'Sensor angle (degrees)', step: 1 }),
  sensorDistance: z.number().min(4).max(16).default(9).meta({ title: 'Sensor reach', step: 0.5 }),
  turn: z.number().min(10).max(60).default(30).meta({ title: 'Turn per step (degrees)', step: 1 }),
  keep: z.number().min(0.8).max(0.97).default(0.9).meta({ title: 'How long trails last', step: 0.005 }),
  spread: z.number().min(0.1).max(0.9).default(0.5).meta({ title: 'Trail spread', step: 0.05 }),
  food: z.number().int().min(4).max(14).default(8).meta({ title: 'Oat flakes', step: 1, modes: [...FOOD_MODES] }),
  mazeSize: z.number().int().min(5).max(10).default(7).meta({ title: 'Maze size', step: 1, modes: ['maze'] }),
  palette: z.enum(['agar', 'neon', 'glow']).default('agar').meta({ title: 'Look', optionLabels: { agar: 'Yellow on agar (real)', neon: 'Neon', glow: 'Bioluminescent' } }),
  overlay: z.boolean().default(true).meta({ title: 'Show the shortest route at the end' }),
  guess: z.boolean().default(true).meta({ title: 'Comment-your-guess prompt' }),
});

export type MoldParams = z.infer<typeof moldSchema>;
