import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { THEMES, parseParams, type Recipe, type Rng } from '@sim/engine';
import { getTemplate } from '@sim/templates';
import { PLANNER_MODEL, PlannerRefusal } from './claude';
import { applyTitleEmoji, copyFieldProps, describeTemplate, mergeCopyOutput, normalizeCopy, variantGuide, type CopyGroup, type CopyOutput, type SocialCopy } from './concept';
import { PLATFORMS, uploadText, type Platform } from './platforms';

/** What one "Regenerate" button on the export page rewrites. */
export type CopyTarget = Platform | 'cover';
export const COPY_TARGETS: readonly CopyTarget[] = [...PLATFORMS, 'cover'];

const SYSTEM = `You write the upload text for one finished short video on a channel that posts "oddly satisfying" physics simulations with collision-driven music (balls escaping rings, marble races, ball battles, spinning-top battles, falling sand, fluids, polyrhythms, sorting races) to YouTube Shorts, TikTok, Instagram Reels and X.

The video is already rendered. Its on-screen hook and call to action are fixed; you write what goes around it on each platform, and it is published as-is.

- Write to the viewer about what happens in this video: casual, human, and using the words people actually search for. Keep strategy talk (retention, hooks, "viewers", engagement) out of it.
- Each platform gets its own take, not the same sentence pasted four times. YouTube titles are found through search, so lead with the searchable words. TikTok captions are short and punchy. Instagram shows the first line before "more". X posts read like a person talking.
- Pinned comments and the X reply should start a conversation: a guess, a side to pick, a rating. Don't just repeat the on-screen CTA.
- Never spoil the ending: don't name the winner or the mystery answer, or say how it finishes. The outcome is decided by real physics, so never claim something the video might not show.
- Hashtags exist to reach people who would enjoy this exact video: one or two broad tags plus specific ones for the format and subject. Never tag the tools used to make it (no #claude, #ai, #anthropic).
- On-screen text may contain {placeholders} that are filled in when the video renders; never put placeholders in your text.`;

/** Params that would give away a mystery if Claude saw them (it would be tempted to hint at them). */
const HIDDEN_PARAMS: Record<string, string[]> = { 'fourier-drawing': ['shape'] };

/** Fields each regenerate target asks for. */
const TARGET_GROUPS: Record<CopyTarget, CopyGroup[]> = {
  youtube: ['youtube'],
  tiktok: ['tiktok'],
  instagram: ['instagram'],
  x: ['x'],
  cover: ['cover'],
};

export interface UploadCopyInput {
  recipe: Recipe;
  /** On-screen text as it appears in the video (template defaults filled in). */
  onScreen: { hook: string; cta: string; nudge?: string };
  /** Owner's notes for this video ("part 2 of the series", a trend to lean into…). */
  notes?: string;
  /** Lead the title with an emoji (true) or not (false). */
  titleEmoji: boolean;
}

function schemaFor(groups: CopyGroup[]) {
  const props = copyFieldProps(groups);
  return { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props };
}

const Output = z.object({
  title: z.string().min(3).optional(),
  youtubeDescription: z.string().optional(),
  hashtags: z.array(z.string()).min(1).optional(),
  youtubePinnedComment: z.string().optional(),
  tiktokCaption: z.string().min(3).optional(),
  tiktokPinnedComment: z.string().optional(),
  instagramCaption: z.string().min(3).optional(),
  instagramPinnedComment: z.string().optional(),
  xPost: z.string().min(3).optional(),
  xReply: z.string().optional(),
  coverText: z.string().optional(),
  emojis: z.array(z.string()).optional(),
});

function userPrompt(input: UploadCopyInput, target: CopyTarget | null, current: SocialCopy | null, previousError?: string): string {
  const { recipe } = input;
  const template = getTemplate(recipe.templateId);
  const hidden = HIDDEN_PARAMS[recipe.templateId] ?? [];
  // Defaults filled in: the Playground leaves untouched settings out.
  const full = parseParams(template, recipe.params) as Record<string, unknown>;
  const params = Object.fromEntries(Object.entries(full).filter(([k]) => !hidden.includes(k)));
  const theme = THEMES.find((t) => t.id === recipe.themeId);
  const text = current ? uploadText(current) : null;
  return [
    describeTemplate(template),
    '',
    `This video's settings: ${JSON.stringify(params)}.`,
    ...variantGuide(recipe.templateId, full),
    `Theme: ${theme?.name ?? recipe.themeId}. Length: about ${recipe.targetS ?? 30} seconds.`,
    `On-screen hook: "${input.onScreen.hook}". On-screen call to action: "${input.onScreen.cta}".${input.onScreen.nudge ? ` On-screen comment prompt: "${input.onScreen.nudge}".` : ''}`,
    target === null || target === 'youtube'
      ? input.titleEmoji
        ? "Title: start it with one attention-grabbing emoji that fits this video's moment. Pick what fits; don't default to the same one every time."
        : 'Title: do not start it with an emoji this time (emoji later in the title are fine).'
      : '',
    input.notes?.trim() ? `Notes from the channel owner for this video: ${input.notes.trim()}` : '',
    target && text
      ? [
          `Rewrite only the ${target === 'cover' ? 'cover text' : `${target} text`}; the owner wants a fresh take. Current version (write something clearly different):`,
          target === 'cover' ? (current?.coverText ?? '') : text[target].all,
          'The other platforms currently say (stay consistent with them, without copying them):',
          ...PLATFORMS.filter((p) => p !== target).map((p) => `[${p}] ${text[p].all}`),
        ].join('\n')
      : '',
    previousError ? `Your previous answer could not be used: ${previousError}. Return a corrected answer.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Upload text for a finished video from Claude (structured output). With a target, only that
 * platform's fields are rewritten and the rest of `current` is kept. Throws on failure.
 */
export async function uploadCopyFromClaude(client: Anthropic, input: UploadCopyInput, base: SocialCopy, rng: Rng, target: CopyTarget | null = null): Promise<SocialCopy> {
  const groups: CopyGroup[] = target ? TARGET_GROUPS[target] : ['youtube', 'tiktok', 'instagram', 'x', 'cover', 'emojis'];
  const schema = schemaFor(groups);
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await client.beta.messages.create({
      model: PLANNER_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: userPrompt(input, target, target ? base : null, lastError) }],
    });
    if (response.stop_reason === 'refusal') throw new PlannerRefusal(`declined (${response.stop_details?.category ?? 'unknown'})`);
    if (response.stop_reason === 'max_tokens') {
      lastError = 'the answer was cut off';
      continue;
    }
    const raw = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      const out: CopyOutput = Output.parse(JSON.parse(raw));
      if (out.title) out.title = applyTitleEmoji(out.title, input.titleEmoji, input.recipe.templateId, rng);
      return normalizeCopy(mergeCopyOutput(base, out));
    } catch (e) {
      lastError = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e as Error).message;
    }
  }
  throw new Error(`invalid copy after 3 attempts: ${lastError}`);
}

/** Readable reason for a failed Claude call. */
export function claudeErrorReason(e: unknown): string {
  return e instanceof PlannerRefusal
    ? e.message
    : e instanceof Anthropic.AuthenticationError
      ? 'API key rejected'
      : e instanceof Anthropic.RateLimitError
        ? 'rate limited'
        : e instanceof Anthropic.APIError
          ? `API error ${e.status}`
          : (e as Error).message;
}
