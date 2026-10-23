import { z } from 'zod';
import { CRYSTAL_PRESET_IDS, LIFE_RULE_IDS } from './rules';
import { LIFE_PATTERN_IDS, SYMMETRIES } from './seeds';

export const MODES = ['crystal', 'tower', 'war'] as const;
export type ModeId = (typeof MODES)[number];

export const LOOKS = ['glossy', 'clay', 'neon'] as const;
export type LookId = (typeof LOOKS)[number];

/**
 * One schema for every mode. Mode-specific settings carry `modes` in their meta: the playground only
 * shows them for those modes and the planner is told they do nothing elsewhere.
 */
export const automataSchema = z.object({
  mode: z.enum(MODES).default('crystal').meta({ title: 'Mode (crystal growth, Life tower, colony war)' }),
  durationS: z.number().min(20).max(60).default(32).meta({ title: 'Length (s)' }),
  look: z.enum(LOOKS).default('glossy').meta({ title: 'Look' }),
  explain: z.boolean().default(false).meta({ title: 'Explain the rules (text at the bottom)' }),

  preset: z.enum(['random', ...CRYSTAL_PRESET_IDS]).default('random').meta({ title: 'Rule (random = picked by the seed)', modes: ['crystal'] }),
  symmetry: z.enum(SYMMETRIES).default('cubic').meta({ title: 'Seed symmetry (cubic = 48-fold)', modes: ['crystal'] }),
  size: z.number().int().min(40).max(96).default(64).meta({ title: 'Grid size (cells per side)', step: 2, modes: ['crystal'] }),

  pattern: z.enum(['random', ...LIFE_PATTERN_IDS]).default('random').meta({ title: 'Starting pattern (random = picked by the seed)', modes: ['tower'] }),
  lifeRule: z.enum(LIFE_RULE_IDS).default('life').meta({ title: 'Rule', modes: ['tower'] }),
  board: z.number().int().min(48).max(128).default(80).meta({ title: 'Board size (cells per side)', step: 2, modes: ['tower'] }),
  wrap: z.boolean().default(false).meta({ title: 'Edges wrap round (torus: gliders never stop, so fewer runs settle)', modes: ['tower'] }),

  colonies: z.number().int().min(2).max(4).default(3).meta({ title: 'Colonies', modes: ['war'] }),
  sides: z.enum(['colors', 'countries']).default('colors').meta({ title: 'Sides (colours or country flags)', modes: ['war'] }),
  warRule: z.enum(['majority', 'cyclic']).default('majority').meta({ title: 'Fight rule (cyclic = rock-paper-scissors, 3 colonies)', modes: ['war'] }),
  arena: z.enum(['sphere', 'cube']).default('sphere').meta({ title: 'Arena', modes: ['war'] }),
  warSize: z.number().int().min(28).max(56).default(40).meta({ title: 'Arena size (cells across)', step: 2, modes: ['war'] }),
  cutaway: z.boolean().default(true).meta({ title: 'Cut away a corner to show inside', modes: ['war'] }),
  finalRush: z.boolean().default(true).meta({ title: 'Final rush (arena shrinks)', modes: ['war'] }),
});

export type AutomataParams = z.infer<typeof automataSchema>;
