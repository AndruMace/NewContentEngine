/**
 * YouTube copy for long-form ambient videos (hours long, for sleep, study and focus): title,
 * description, tags and a few words for the thumbnail. Written by Claude, with a plain fallback
 * when Claude isn't available. Long-form videos go to YouTube only (and are ignored by analytics).
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { parseParams, type LongFormCopyText, type Recipe } from '@sim/engine';
import { getTemplate } from '@sim/templates';
import { PLANNER_MODEL, PlannerRefusal } from './claude';

export type LongFormCopy = LongFormCopyText;

/** What valid copy looks like (YouTube limits). */
export const LongFormCopySchema = z.object({
  title: z.string().min(10).max(100),
  description: z.string().min(80).max(4800),
  tags: z
    .array(z.string().min(2).max(60))
    .min(5)
    .max(20)
    .refine((t) => t.join(',').length <= 480, 'tags must total under 480 characters'),
  thumbnailText: z.string().min(3).max(40),
});

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'tags', 'thumbnailText'],
  properties: {
    title: { type: 'string', description: 'YouTube title, at most 100 characters, with the length (e.g. "3 Hours").' },
    description: { type: 'string', description: 'YouTube description: a few short paragraphs, then 3 hashtags on the last line.' },
    tags: { type: 'array', items: { type: 'string' }, description: '8 to 15 search tags, under 480 characters in total.' },
    thumbnailText: { type: 'string', description: 'Two to five words for the thumbnail.' },
  },
};

const SYSTEM = `You write YouTube copy for long ambient videos: hours of a calm scene with real recorded sound, for
people to put on while they sleep, study, work or relax. Viewers find them by searching (e.g. "rain sounds for
sleeping", "spaceship ambience", "cozy cabin thunderstorm"), so titles and tags use the words people search for,
plainly, without clickbait or all caps.

- Title: the scene and its sounds first, then the use and the length, e.g. "Cozy Cabin Thunderstorm | Crackling
  Fire & Rain Sounds for Sleep | 3 Hours". At most 100 characters. No emoji.
- Description: 2 to 4 short paragraphs. Say what you see and hear, and what it's good for (sleep, study, focus,
  relaxing). The sound is real recordings (rain, fire, thunder, wind, a ship's room tone), the picture is an
  animated scene. Don't claim health benefits, don't invent facts about the channel, and don't add timestamps
  (it is one continuous scene). End with exactly 3 hashtags on their own line.
- Tags: 8 to 15 phrases people would search for.
- Thumbnail text: two to five words that read at a glance, e.g. "STORMY NIGHT" or "3 HOURS OF RAIN".`;

const hours = (s: number) => {
  const h = s / 3600;
  return Number.isInteger(h) ? `${h} Hour${h === 1 ? '' : 's'}` : `${Math.round(s / 60)} Minutes`;
};

/** A plain description of what the video shows, from its settings (the template's own words). */
export function describeScene(recipe: Recipe): string {
  const template = getTemplate(recipe.templateId);
  return template.longForm?.describe?.(parseParams(template, recipe.params ?? {})) ?? template.description;
}

/** Copy without Claude (no API key, or Claude declined). */
export function fallbackLongFormCopy(recipe: Recipe & { totalS: number }): LongFormCopy {
  const template = getTemplate(recipe.templateId);
  const len = hours(recipe.totalS);
  const own = template.longForm?.fallbackCopy?.(parseParams(template, recipe.params ?? {}), len);
  if (own) return own;
  return {
    title: `${template.name} | Ambience for Sleep & Focus | ${len}`,
    description: `${describeScene(recipe)}\n\nPut it on to fall asleep, study or focus. ${len} of one continuous, calm scene.\n\n#ambience #sleepsounds #studyambience`,
    tags: ['ambience', 'sleep sounds', 'study ambience', 'relaxing sounds', 'focus sounds'],
    thumbnailText: template.name.toUpperCase(),
  };
}

/** Claude's copy for a long-form video, validated, with up to 2 corrective retries. */
export async function longFormCopyFromClaude(client: Anthropic, recipe: Recipe & { loopS: number; totalS: number }, notes?: string | null): Promise<LongFormCopy> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const user = [
      `Scene: ${describeScene(recipe)}`,
      `Length: ${hours(recipe.totalS)}.`,
      notes ? `Notes from the channel owner: ${notes}` : '',
      lastError ? `Your last answer was rejected: ${lastError}. Fix that.` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const response = await client.beta.messages.create({
      model: PLANNER_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason === 'refusal') throw new PlannerRefusal(`declined (${response.stop_details?.category ?? 'unknown'})`);
    if (response.stop_reason === 'max_tokens') {
      lastError = 'the answer was cut off';
      continue;
    }
    const raw = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      return LongFormCopySchema.parse(JSON.parse(raw));
    } catch (e) {
      lastError = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e as Error).message;
    }
  }
  throw new Error(`invalid copy after 3 attempts: ${lastError}`);
}
