import { z } from 'zod';

export const MODES = ['blocks', 'collatz', 'times-table', 'phyllotaxis', 'chaos-game', 'monty-hall', 'birthday'] as const;
export type ModeId = (typeof MODES)[number];

export const CHAOS_RULES = ['triangle', 'square', 'pentagon', 'hexagon', 'carpet'] as const;
export type ChaosRule = (typeof CHAOS_RULES)[number];

/** Modes with narration (their openings have explainer beats to voice). */
export const NARRATED: ModeId[] = ['collatz', 'times-table'];

/** Kokoro voices offered (its best-graded; @sim/voice keeps the same list). */
export const NARRATORS = ['af_heart', 'af_bella', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bm_george'] as const;

/** Every mode but the blocks (whose length is set by the number of digits). */
const TIMED: ModeId[] = MODES.filter((m) => m !== 'blocks');

/**
 * One schema for every mode. Mode-specific settings carry `modes` in their meta: the playground only
 * shows them for those modes and the planner is told they do nothing elsewhere. The blocks settings
 * keep their old names so recipes made before the modes existed (no `mode`) replay unchanged.
 */
export const mathCuriositiesSchema = z.object({
  mode: z.enum(MODES).default('blocks').meta({ title: 'Mode' }),
  durationS: z.number().min(20).max(60).default(32).meta({ title: 'Length (s)', modes: TIMED }),
  narration: z.enum(['off', 'on']).default('off').meta({ title: 'Narration (voiceover)', modes: NARRATED }),
  narrator: z.enum(NARRATORS).default('af_heart').meta({ title: 'Narrator voice', modes: NARRATED }),

  digits: z.number().int().min(3).max(6).default(5).meta({ title: 'Digits of π (final round)', modes: ['blocks'] }),
  staged: z.boolean().default(true).meta({ title: 'Play every round (1 kg, 100 kg, …)', modes: ['blocks'] }),
  diagram: z.boolean().default(true).meta({ title: 'Velocity circle diagram', modes: ['blocks'] }),
  burstSeconds: z.number().min(0.6).max(3).default(1.6).meta({ title: 'Collision burst length (s)', modes: ['blocks'] }),

  start: z.number().int().min(0).max(99999).default(0).meta({ title: 'Starting number (0 = picked by the seed)', modes: ['collatz'] }),
  compare: z.boolean().default(false).meta({ title: 'Race two neighbouring numbers', modes: ['collatz'] }),

  points: z.number().int().min(60).max(400).default(200).meta({ title: 'Points on the circle', modes: ['times-table'] }),
  maxMultiplier: z.number().int().min(0).max(399).default(0).meta({ title: 'Last multiplier (0 = picked by the seed)', modes: ['times-table'] }),

  seeds: z.number().int().min(300).max(2000).default(1200).meta({ title: 'Sunflower seeds', modes: ['phyllotaxis'] }),

  rule: z.enum(['random', ...CHAOS_RULES]).default('random').meta({ title: 'Shape (random = picked by the seed)', modes: ['chaos-game'] }),
  dots: z.number().int().min(20000).max(300000).default(120000).meta({ title: 'Dots', modes: ['chaos-game'] }),

  doors: z.number().int().min(3).max(10).default(3).meta({ title: 'Doors', modes: ['monty-hall'] }),
  games: z.number().int().min(100).max(2000).default(500).meta({ title: 'Games per strategy', modes: ['monty-hall'] }),

  rooms: z.number().int().min(1).max(6).default(3).meta({ title: 'Rooms', modes: ['birthday'] }),
});

export type MathParams = z.infer<typeof mathCuriositiesSchema>;
