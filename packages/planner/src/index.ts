import Anthropic from '@anthropic-ai/sdk';
import { Rng } from '@sim/engine';
import { chooseArms, targetLength, type Arm, type ArmChoiceSettings, type ArmStats } from './arms';
import { conceptFromClaude, conceptFromMock, PlannerRefusal, type PlanContext } from './claude';
import { fallbackConcept, type Concept } from './concept';

export * from './arms';
export * from './concept';
export * from './claude';

export type Generator = 'claude' | 'fallback' | 'mock';

/** True if the SDK will find credentials (API key or auth token) in the environment. */
export function claudeAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export interface PlannedConcept {
  concept: Concept;
  /** Set when Claude was requested but this concept fell back. */
  warning?: string;
}

/** One concept for an arm. Never throws: API/validation failures fall back to template copy. */
export async function planOne(
  arm: Arm,
  targetS: number,
  generator: Generator,
  ctx: PlanContext,
  rng: Rng,
  client?: Anthropic,
): Promise<PlannedConcept> {
  if (generator === 'mock') return { concept: conceptFromMock(arm, targetS, rng) };
  if (generator === 'claude' && client) {
    try {
      return { concept: await conceptFromClaude(client, arm, targetS, ctx) };
    } catch (e) {
      const reason =
        e instanceof PlannerRefusal
          ? e.message
          : e instanceof Anthropic.AuthenticationError
            ? 'API key rejected'
            : e instanceof Anthropic.RateLimitError
              ? 'rate limited'
              : e instanceof Anthropic.APIError
                ? `API error ${e.status}`
                : (e as Error).message;
      return { concept: fallbackConcept(arm, targetS, rng), warning: `Claude unavailable for this concept (${reason}); used template copy.` };
    }
  }
  return { concept: fallbackConcept(arm, targetS, rng) };
}

/** Choose arms and plan their concepts, at most `concurrency` API calls at a time. */
export async function planConcepts(
  settings: ArmChoiceSettings & { generator: Generator; seed: number },
  stats: Map<string, ArmStats>,
  ctx: PlanContext,
  onConcept?: (p: PlannedConcept, index: number) => void | Promise<void>,
  concurrency = 4,
): Promise<PlannedConcept[]> {
  const rng = new Rng(settings.seed);
  const arms = chooseArms(settings, stats, rng);
  const client = settings.generator === 'claude' && claudeAvailable() ? new Anthropic() : undefined;
  const results: PlannedConcept[] = new Array(arms.length);
  let next = 0;
  const worker = async () => {
    while (next < arms.length) {
      const i = next++;
      const armRng = new Rng(settings.seed + 1000 + i);
      const target = targetLength(arms[i].lengthBucket, settings.minLengthS, settings.maxLengthS, armRng);
      results[i] = await planOne(arms[i], target, settings.generator, ctx, armRng, client);
      await onConcept?.(results[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, arms.length) }, worker));
  return results;
}
