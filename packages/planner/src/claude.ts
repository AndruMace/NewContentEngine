import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Rng } from '@sim/engine';
import { MELODIES } from '@sim/audio';
import { getTemplate } from '@sim/templates';
import type { Arm } from './arms';
import { COPY_GUIDE, PLATFORM_GUIDE } from './copyGuide';
import { applyTitleEmoji, coerceParams, conceptOutputSchema, describeTemplate, fallbackConcept, hookStyleGuide, mergeCopyOutput, normalizeCopy, variantGuide, variantHook, type Concept } from './concept';

export const PLANNER_MODEL = 'claude-opus-5-5';

export interface PlanContext {
  /** Hooks used recently, to avoid repeats. */
  recentHooks: string[];
  /** Free-text "notes / trends for today" from the batch settings. */
  notes?: string;
  /** Settings of a run already rendered (rewriting its copy): the model writes to these instead of choosing its own. */
  keepParams?: Record<string, unknown>;
  /** Comment prompts used recently (newest first); picks are added here so a batch varies them. */
  recentNudges?: string[];
  /** Recent titles on the channel (newest first), so new ones vary their structure. */
  recentTitles?: string[];
}

const SYSTEM = `You are the content strategist for a short-form video channel (YouTube Shorts, TikTok, Instagram Reels, X) that posts "oddly satisfying" physics simulations with collision-driven music: balls escaping rings, marble races, ball battles, spinning-top battles, falling sand, fluids, polyrhythms, sorting races.

Your job: for one planned video, choose simulation parameters and write the on-screen text and captions. You optimise for watch time, rewatches and comments.

What works on this channel:
- The hook appears in the first 2 seconds and creates an open question the video answers at the very end. Short, concrete, no clickbait the video can't pay off.
- Stakes and progress are visible (rings left, who's still in, HP). Pick parameters that make the outcome uncertain and the climax land late.
- The CTA invites a comment (a guess, a rating, a side) rather than asking for likes.
- Never claim something the simulation might not show (e.g. "it fails at the end"); the outcome is decided by real physics.

The titles, descriptions and captions are published as-is (strategy talk belongs only in the private rationale).

${COPY_GUIDE}

${PLATFORM_GUIDE}

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
  // Newer fields: optional so a mock or an older answer still validates.
  youtubePinnedComment: z.string().optional(),
  instagramCaption: z.string().optional(),
  tiktokPinnedComment: z.string().optional(),
  instagramPinnedComment: z.string().optional(),
  xReply: z.string().optional(),
  coverText: z.string().optional(),
  emojis: z.array(z.string()).optional(),
  rationale: z.string().default(''),
});

export interface ConceptOptions {
  /** Lead the title with an emoji (true) or not (false). */
  titleEmoji: boolean;
  /** Params the planner already chose (see PLANNED_VARIANTS); they override whatever the model returns. */
  variants?: Record<string, unknown>;
  /** Every param is already set (rewriting copy for a rendered run): tell the model they're fixed. */
  fixedParams?: boolean;
}

const titleEmojiGuide = (lead: boolean) =>
  lead
    ? 'Title: start it with one attention-grabbing emoji that fits this video\'s moment (e.g. 🤯 for a satisfying fill, 😱 for a close finish, 🏁 for a race). Pick what fits; don\'t default to the same one every time.'
    : 'Title: do not start it with an emoji this time (emoji later in the title are fine).';

function userPrompt(arm: Arm, targetS: number, ctx: PlanContext, opts: ConceptOptions, previousError?: string): string {
  const template = getTemplate(arm.templateId);
  return [
    describeTemplate(template),
    '',
    `Theme: ${arm.themeId}. Target length: about ${targetS} seconds.`,
    `Hook style: ${arm.hookStyle}. ${hookStyleGuide(arm)}`,
    titleEmojiGuide(opts.titleEmoji),
    ...variantGuide(arm.templateId, opts.variants ?? {}),
    opts.fixedParams
      ? `Parameters are already set for this video: ${JSON.stringify(opts.variants)}. Return them unchanged as params and write copy that matches them; prefer {paramName} placeholders over restating numbers.`
      : '',
    `Melody: assigned separately for variety; return "${MELODIES[0].id}" as melodyId.`,
    ctx.recentHooks.length ? `Recent hooks to avoid repeating:\n${ctx.recentHooks.slice(0, 20).map((h) => `- ${h}`).join('\n')}` : '',
    ctx.recentTitles?.length ? `Recent titles on the channel (vary the structure from these):\n${ctx.recentTitles.slice(0, 12).map((t) => `- ${t}`).join('\n')}` : '',
    ctx.notes ? `Notes from the channel owner for today: ${ctx.notes}` : '',
    previousError ? `Your previous answer could not be used: ${previousError}. Return a corrected answer.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Turn a raw structured-output object into a validated Concept (throws with a readable reason). */
export function conceptFromResponse(raw: unknown, arm: Arm, targetS: number, source: Concept['source'], opts?: ConceptOptions & { rng: Rng }): Concept {
  const r = ResponseShape.parse(raw);
  // Enforce the planned title style even if the model didn't follow it.
  if (opts) r.title = applyTitleEmoji(r.title, opts.titleEmoji, arm.templateId, opts.rng);
  const template = getTemplate(arm.templateId);
  const melodyId = MELODIES.some((m) => m.id === r.melodyId) ? r.melodyId : MELODIES[0].id;
  r.hook = variantHook(arm.templateId, opts?.variants ?? {}) ?? r.hook;
  return {
    arm,
    templateId: arm.templateId,
    themeId: arm.themeId,
    melodyId,
    params: coerceParams(template, { ...r.params, ...opts?.variants }),
    targetS,
    source,
    rationale: r.rationale,
    ...(opts ? { titleEmoji: opts.titleEmoji } : {}),
    copy: normalizeCopy(mergeCopyOutput({ hook: r.hook, cta: r.cta, title: r.title, youtubeDescription: r.youtubeDescription, tiktokCaption: r.tiktokCaption, xPost: r.xPost, hashtags: r.hashtags }, r)),
  };
}

export class PlannerRefusal extends Error {}

/** One concept from Claude (structured output), validated, with up to 2 corrective retries. */
export async function conceptFromClaude(client: Anthropic, arm: Arm, targetS: number, ctx: PlanContext, opts: ConceptOptions & { rng: Rng }): Promise<Concept> {
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
      messages: [{ role: 'user', content: userPrompt(arm, targetS, ctx, opts, lastError) }],
    });
    if (response.stop_reason === 'refusal') throw new PlannerRefusal(`declined (${response.stop_details?.category ?? 'unknown'})`);
    if (response.stop_reason === 'max_tokens') {
      lastError = 'the answer was cut off';
      continue;
    }
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      return conceptFromResponse(JSON.parse(text), arm, targetS, 'claude', opts);
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
export function conceptFromMock(arm: Arm, targetS: number, rng: Rng, opts: ConceptOptions = { titleEmoji: true }): Concept {
  const base = fallbackConcept(arm, targetS, rng, opts);
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
  return conceptFromResponse(raw, arm, targetS, 'mock', { ...opts, rng });
}

/** Exercise clamping: push the first numeric param far out of range. */
function firstNumericOutOfRange(templateId: string): Record<string, unknown> {
  const t = getTemplate(templateId);
  const shape = (t.schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
  const key = Object.keys(shape)[0];
  return key ? { [key]: 1e9 } : {};
}
