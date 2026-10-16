import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { THEMES, paramsJsonSchema, parseParams, type Recipe, type Rng } from '@sim/engine';
import { getTemplate } from '@sim/templates';
import { PLANNER_MODEL, PlannerRefusal } from './claude';
import { applyTitleEmoji, copyFieldProps, mergeCopyOutput, normalizeCopy, variantGuide, type CopyGroup, type CopyOutput, type SocialCopy } from './concept';
import { COPY_GUIDE, PLATFORM_GUIDE } from './copyGuide';
import { PLATFORMS, uploadText, type Platform } from './platforms';

/** What one "Regenerate" button on the export page rewrites. */
export type CopyTarget = Platform | 'cover';
export const COPY_TARGETS: readonly CopyTarget[] = [...PLATFORMS, 'cover'];

const SYSTEM = `You write the published text for one finished short video on a channel that posts "oddly satisfying" physics simulations with collision-driven music (balls escaping rings, marble races, ball battles, spinning-top battles, falling sand, fluids, polyrhythms, sorting races) to YouTube Shorts, TikTok, Instagram Reels and X. You write like the creator posting their own video, and everything you write is published as-is.

The video is already rendered, and its on-screen hook and call to action are fixed. You get a description of what happens in it so you understand the video; it is background, not material to paraphrase.

${COPY_GUIDE}

${PLATFORM_GUIDE}

Each platform gets its own take, not the same sentence reworded four times. On-screen text may contain {placeholders} that are filled in when the video renders; never put placeholders in your text.`;

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
  /** What has been performing on the channel (see summarizePerformance). */
  performance?: string;
  /** Recent titles on the channel, newest first, so new ones don't repeat their structure. */
  recentTitles?: string[];
}

/** One posted video's result, for summarizePerformance. */
export interface PostResult {
  title: string;
  hook: string;
  templateName: string;
  /** Reward in typical post-to-post swings vs the channel's average. */
  reward: number;
  views?: number;
  /** Still early (not at the scoring horizon yet). */
  provisional: boolean;
}

/**
 * Best and weakest posts as prompt lines, so the copy can lean on what works for this audience.
 * Undefined until there are enough scored posts to say anything.
 */
export function summarizePerformance(posts: PostResult[], minPosts = 4): string | undefined {
  if (posts.length < minPosts) return undefined;
  const sorted = [...posts].sort((a, b) => b.reward - a.reward);
  const top = sorted.slice(0, Math.min(5, Math.ceil(sorted.length / 2)));
  const bottom = sorted.slice(top.length).slice(-3).reverse();
  const line = (p: PostResult) =>
    `- "${p.title}" (${p.templateName}; on-screen "${p.hook}"): ${p.reward >= 0 ? '+' : '−'}${Math.abs(p.reward).toFixed(1)} vs average${p.views !== undefined ? `, ${p.views.toLocaleString('en-US')} views` : ''}${p.provisional ? ', early numbers' : ''}`;
  return [
    'Best performers on YouTube (reward combines retention, reach, engagement and follows; in typical post-to-post swings):',
    ...top.map(line),
    ...(bottom.length ? ['Weakest:', ...bottom.map(line)] : []),
    'Lean on what the best ones have in common and avoid what the weakest share, without copying their wording. The template matters too, so judge the titles, not just the topic.',
  ].join('\n');
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

/** What happens in the video, for the copy writer: the template's description and its settings by name. */
function describeVideo(recipe: Recipe): string[] {
  const template = getTemplate(recipe.templateId);
  const hidden = HIDDEN_PARAMS[recipe.templateId] ?? [];
  // Defaults filled in: the Playground leaves untouched settings out.
  const full = parseParams(template, recipe.params) as Record<string, unknown>;
  const props = (paramsJsonSchema(template) as { properties: Record<string, { title?: string }> }).properties;
  const settings = Object.entries(full)
    .filter(([k]) => !hidden.includes(k) && k in props)
    .map(([k, v]) => `${props[k].title ?? k}: ${typeof v === 'number' ? +v.toFixed(2) : v}`);
  const theme = THEMES.find((t) => t.id === recipe.themeId);
  return [
    `${template.name}: ${template.description}`,
    `Settings: ${settings.join('; ')}.`,
    ...variantGuide(recipe.templateId, full),
    `Look: ${theme?.name ?? recipe.themeId}. Length: about ${recipe.targetS ?? 30} seconds.`,
  ];
}

function userPrompt(input: UploadCopyInput, target: CopyTarget | null, current: SocialCopy | null, previousError?: string): string {
  const text = current ? uploadText(current) : null;
  const section = (title: string, lines: (string | false | null | undefined)[]) => {
    const kept = lines.filter(Boolean);
    return kept.length ? `## ${title}\n${kept.join('\n')}` : '';
  };
  return [
    section('The video (background so you know what happens; don\'t paraphrase it)', describeVideo(input.recipe)),
    section('On screen (viewers already see this; your text adds a second angle)', [
      `Hook in the first seconds: "${input.onScreen.hook}"`,
      `Call to action at the end: "${input.onScreen.cta}"`,
      input.onScreen.nudge && `Comment prompt: "${input.onScreen.nudge}"`,
    ]),
    section('From the channel owner', [input.notes?.trim()]),
    section('What has been performing', [input.performance]),
    section('Recent titles on the channel (vary the structure from these)', (input.recentTitles ?? []).slice(0, 12).map((t) => `- ${t}`)),
    section('This request', [
      (target === null || target === 'youtube') &&
        (input.titleEmoji
          ? "Start the title with one emoji that fits this video's moment; don't default to the same one every time."
          : 'Do not start the title with an emoji this time (emoji later in it are fine).'),
      target &&
        text &&
        [
          `Rewrite only the ${target === 'cover' ? 'cover text' : `${target} text`}; the owner wants a fresh take. Current version (write something clearly different):`,
          target === 'cover' ? (current?.coverText ?? '') : text[target].all,
          'The other platforms currently say (stay consistent with them, without copying them):',
          ...PLATFORMS.filter((p) => p !== target).map((p) => `[${p}] ${text[p].all}`),
        ].join('\n'),
      previousError && `Your previous answer could not be used: ${previousError}. Return a corrected answer.`,
    ]),
  ]
    .filter(Boolean)
    .join('\n\n');
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
