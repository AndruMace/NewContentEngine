/**
 * YouTube copy for long-form ambient videos (hours long, for sleep, study and focus): title,
 * description, tags and a few words for the thumbnail. Written by Claude, with a plain fallback
 * when Claude isn't available. Long-form videos go to YouTube only (and are ignored by analytics).
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Recipe } from '@sim/engine';
import { getTemplate } from '@sim/templates';
import { PLANNER_MODEL, PlannerRefusal } from './claude';

export interface LongFormCopy {
  title: string;
  description: string;
  tags: string[];
  /** Two to five words to set on the thumbnail. */
  thumbnailText: string;
}

const Output = z.object({
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

/** A plain description of what the video shows, from its settings. */
export function describeScene(recipe: Recipe): string {
  const p = recipe.params as Record<string, unknown>;
  if (recipe.templateId === 'cabin-storm') {
    const snow = p.precipitation === 'snow';
    const storm = Number(p.storm ?? 0.6);
    const lightning = Number(p.lightningPerHour ?? 30);
    return [
      `Inside a log cabin at night: a stone fireplace with a crackling fire (${Number(p.fire ?? 0.7) > 0.6 ? 'a big fire' : 'a gentle fire'}), between two big windows.`,
      snow ? `Outside it is snowing${storm > 0.6 ? ' hard, wind gusting' : ''}.` : `Outside, ${storm > 0.7 ? 'a heavy' : storm > 0.4 ? 'a steady' : 'a light'} rainstorm, rain running down the glass.`,
      lightning > 0 ? `Lightning about ${Math.round(lightning)} times an hour, with thunder.` : 'No thunder.',
      'Sound: real recordings of the fire, rain on the windows, wind and thunder.',
    ].join(' ');
  }
  if (recipe.templateId === 'orbital-viewport') {
    const planet = String(p.planet ?? 'earthlike');
    const names: Record<string, string> = { earthlike: 'an Earth-like planet', ocean: 'an ocean world', desert: 'a desert planet', ice: 'an ice world', gas: 'a gas giant' };
    return [
      `Looking out of a spaceship's viewport at ${names[planet] ?? 'a planet'} turning slowly below${p.rings ? ', with rings' : ''}, clouds drifting.`,
      Number(p.moons ?? 0) ? `${p.moons} moon${p.moons === 1 ? '' : 's'} in the sky.` : '',
      Number(p.shootingStarsPerHour ?? 20) > 0 ? 'Now and then a shooting star.' : '',
      `${String(p.cabinLight ?? 'cool')} cabin lighting, quiet consoles.`,
      "Sound: the ship's low hum and room tone, with the odd soft console blip.",
    ]
      .filter(Boolean)
      .join(' ');
  }
  return getTemplate(recipe.templateId).description;
}

/** Copy without Claude (no API key, or Claude declined). */
export function fallbackLongFormCopy(recipe: Recipe & { totalS: number }): LongFormCopy {
  const len = hours(recipe.totalS);
  const p = recipe.params as Record<string, unknown>;
  if (recipe.templateId === 'cabin-storm') {
    const snow = p.precipitation === 'snow';
    return {
      title: snow ? `Cozy Cabin in a Snowstorm | Crackling Fire & Wind Sounds for Sleep | ${len}` : `Cozy Cabin Thunderstorm | Crackling Fire & Rain Sounds for Sleep | ${len}`,
      description: `${describeScene(recipe)}\n\nPut it on to fall asleep, study, read or work. ${len} of one continuous, calm scene.\n\n#${snow ? 'snowstorm' : 'rainsounds'} #fireplace #sleepsounds`,
      tags: snow
        ? ['snowstorm sounds', 'cozy cabin', 'fireplace sounds', 'crackling fire', 'wind sounds', 'sleep sounds', 'study ambience', 'winter ambience']
        : ['rain sounds', 'thunderstorm sounds', 'cozy cabin', 'fireplace sounds', 'crackling fire', 'rain for sleeping', 'sleep sounds', 'study ambience'],
      thumbnailText: snow ? 'SNOWY CABIN' : 'STORMY NIGHT',
    };
  }
  return {
    title: `Spaceship Ambience | Orbiting a Planet | Deep Space Sounds for Sleep & Focus | ${len}`,
    description: `${describeScene(recipe)}\n\nPut it on to fall asleep, study or focus. ${len} of one continuous, calm scene.\n\n#spaceambience #sleepsounds #studymusic`,
    tags: ['spaceship ambience', 'space ambience', 'sleep sounds', 'study ambience', 'white noise', 'planet view', 'sci-fi ambience', 'focus sounds'],
    thumbnailText: 'ORBIT',
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
      return Output.parse(JSON.parse(raw));
    } catch (e) {
      lastError = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e as Error).message;
    }
  }
  throw new Error(`invalid copy after 3 attempts: ${lastError}`);
}
