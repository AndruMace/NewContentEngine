import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Rng } from '@sim/engine';
import { MELODIES } from '@sim/audio';
import { getTemplate } from '@sim/templates';
import type { Arm } from './arms';
import { coerceParams, conceptOutputSchema, describeTemplate, fallbackConcept, hookStyleGuide, normalizeCopy, type Concept } from './concept';

export const PLANNER_MODEL = 'claude-opus-5-5';

export interface PlanContext {
  /** Hooks used recently, to avoid repeats. */
  recentHooks: string[];
  /** Free-text "notes / trends for today" from the batch settings. */
  notes?: string;
  /** Phase 5: summary of what has been performing. */
  performanceSummary?: string;
}

const SYSTEM = `You are the content strategist for a short-form video channel (YouTube Shorts, TikTok, X) that posts "oddly satisfying" physics simulations with collision-driven music: balls escaping rings, marble races, ball battles, falling sand, fluids, polyrhythms, sorting races.

Your job: for one planned video, choose simulation parameters and write the on-screen text and captions. You optimise for watch time, rewatches and comments.

What works on this channel:
- The hook appears in the first 2 seconds and creates an open question the video answers at the very end. Short, concrete, no clickbait the video can't pay off.
- Stakes and progress are visible (rings left, who's still in, HP). Pick parameters that make the outcome uncertain and the climax land late.
- The CTA invites a comment (a guess, a rating, a side) rather than asking for likes.
- Titles, descriptions and captions are published as-is, so write them to the viewer about what happens in the video: casual, human, and using the words people actually search for. Keep strategy talk (retention, hooks, "viewers", stakes) out of them; that belongs only in the private rationale.
- Hashtags exist to reach people who would enjoy this exact video: one or two broad tags plus specific ones for the format and subject. Never tag the tools used to make it (no #claude, #ai, #anthropic).
- Never claim something the simulation might not show (e.g. "it fails at the end"); the outcome is decided by real physics.

Parameter guidance: stay near the defaults unless you have a reason; extreme values can make simulations that never finish. Choose values so the video plausibly runs close to the requested length.`;

const ResponseShape = z.object({
  params: z.record(z.string(), z.unknown()),
  melodyId: z.string(),
  hook: z.string().min(3),
  cta: z.string().min(3),
  title: z.string().min(3),
  youtubeDescription: z.string(),
  tiktokCaption: z.string().min(3),
  xPost: z.string().min(3),
  hashtags: z.array(z.string()).min(1),
  rationale: z.string().default(''),
});

function userPrompt(arm: Arm, targetS: number, ctx: PlanContext, previousError?: string): string {
  const template = getTemplate(arm.templateId);
  return [
    describeTemplate(template),
    '',
    `Theme: ${arm.themeId}. Target length: about ${targetS} seconds.`,
    `Hook style: ${arm.hookStyle}. ${hookStyleGuide(arm)}`,
    `Available melodies (public domain): ${MELODIES.map((m) => `${m.id} (${m.title})`).join(', ')}.`,
    ctx.recentHooks.length ? `Recent hooks to avoid repeating:\n${ctx.recentHooks.slice(0, 20).map((h) => `- ${h}`).join('\n')}` : '',
    ctx.performanceSummary ? `What has been performing:\n${ctx.performanceSummary}` : '',
    ctx.notes ? `Notes from the channel owner for today: ${ctx.notes}` : '',
    previousError ? `Your previous answer could not be used: ${previousError}. Return a corrected answer.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Turn a raw structured-output object into a validated Concept (throws with a readable reason). */
export function conceptFromResponse(raw: unknown, arm: Arm, targetS: number, source: Concept['source']): Concept {
  const r = ResponseShape.parse(raw);
  const template = getTemplate(arm.templateId);
  const melodyId = MELODIES.some((m) => m.id === r.melodyId) ? r.melodyId : MELODIES[0].id;
  return {
    arm,
    templateId: arm.templateId,
    themeId: arm.themeId,
    melodyId,
    params: coerceParams(template, r.params),
    targetS,
    source,
    rationale: r.rationale,
    copy: normalizeCopy(r),
  };
}

export class PlannerRefusal extends Error {}

/** One concept from Claude (structured output), validated, with up to 2 corrective retries. */
export async function conceptFromClaude(client: Anthropic, arm: Arm, targetS: number, ctx: PlanContext): Promise<Concept> {
  const template = getTemplate(arm.templateId);
  const schema = conceptOutputSchema(template);
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await client.beta.messages.create({
      model: PLANNER_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: userPrompt(arm, targetS, ctx, lastError) }],
    });
    if (response.stop_reason === 'refusal') throw new PlannerRefusal(`declined (${response.stop_details?.category ?? 'unknown'})`);
    if (response.stop_reason === 'max_tokens') {
      lastError = 'the answer was cut off';
      continue;
    }
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      return conceptFromResponse(JSON.parse(text), arm, targetS, 'claude');
    } catch (e) {
      lastError = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e as Error).message;
    }
  }
  throw new Error(`invalid concept after 3 attempts: ${lastError}`);
}

/**
 * Offline stand-in for Claude used by dry runs and tests: builds a plausible structured-output
 * object (including out-of-range values) and sends it through the same validation path.
 */
export function conceptFromMock(arm: Arm, targetS: number, rng: Rng): Concept {
  const base = fallbackConcept(arm, targetS, rng);
  const raw = {
    params: { ...base.params, __unknown: 1, ...firstNumericOutOfRange(arm.templateId) },
    melodyId: base.melodyId,
    hook: `[mock] ${base.copy.hook}`,
    cta: base.copy.cta,
    title: `${base.copy.title} (mock)`,
    youtubeDescription: base.copy.youtubeDescription,
    tiktokCaption: base.copy.tiktokCaption,
    xPost: base.copy.xPost,
    hashtags: ['#satisfying', 'oddly satisfying', 'mock'],
    rationale: 'mock response',
  };
  return conceptFromResponse(raw, arm, targetS, 'mock');
}

/** Exercise clamping: push the first numeric param far out of range. */
function firstNumericOutOfRange(templateId: string): Record<string, unknown> {
  const t = getTemplate(templateId);
  const shape = (t.schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
  const key = Object.keys(shape)[0];
  return key ? { [key]: 1e9 } : {};
}
