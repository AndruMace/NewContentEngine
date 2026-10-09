import Anthropic from '@anthropic-ai/sdk';
import { Rng } from '@sim/engine';
import { chooseArms, targetLength, type Arm, type ArmChoiceSettings, type ArmModel } from './arms';
import { conceptFromClaude, conceptFromMock, PlannerRefusal, type PlanContext } from './claude';
import { TITLE_EMOJI_SHARE, fallbackConcept, type Concept } from './concept';

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
  // Decided up front (seeded) so most titles lead with an emoji and the rest form a comparison group.
  const titleEmoji = rng.chance(TITLE_EMOJI_SHARE);
  if (generator === 'mock') return { concept: conceptFromMock(arm, targetS, rng, { titleEmoji }) };
  if (generator === 'claude' && client) {
    try {
      return { concept: await conceptFromClaude(client, arm, targetS, ctx, { titleEmoji, rng }) };
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
      return { concept: fallbackConcept(arm, targetS, rng, { titleEmoji }), warning: `Claude unavailable for this concept (${reason}); used template copy.` };
    }
  }
  return { concept: fallbackConcept(arm, targetS, rng, { titleEmoji }) };
}

/** Choose arms and plan their concepts, at most `concurrency` API calls at a time. */
export async function planConcepts(
  settings: ArmChoiceSettings & { generator: Generator; seed: number },
  model: ArmModel,
  ctx: PlanContext,
  onConcept?: (p: PlannedConcept, index: number) => void | Promise<void>,
  concurrency = 4,
): Promise<PlannedConcept[]> {
  const rng = new Rng(settings.seed);
  const arms = chooseArms(settings, model, rng);
  const client = settings.generator === 'claude' && claudeAvailable() ? new Anthropic() : undefined;
  const results: PlannedConcept[] = new Array(arms.length);
  let next = 0;
  const worker = async () => {
    while (next < arms.length) {
      const i = next++;
      const armRng = new Rng(settings.seed + 1000 + i);
      const { arm, experiment } = arms[i];
      const target = targetLength(arm.lengthBucket, settings.minLengthS, settings.maxLengthS, armRng);
      results[i] = await planOne(arm, target, settings.generator, ctx, armRng, client);
      if (experiment) results[i].concept.experiment = experiment;
      await onConcept?.(results[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, arms.length) }, worker));
  return results;
}
