import { paramsJsonSchema, type Rng, type Template } from '@sim/engine';
import { MELODIES } from '@sim/audio';
import { getTemplate } from '@sim/templates';
import { HOOK_STYLES, type Arm } from './arms';

/** On-screen text plus per-platform copy for one video. */
export interface SocialCopy {
  hook: string;
  cta: string;
  title: string;
  youtubeDescription: string;
  tiktokCaption: string;
  xPost: string;
  hashtags: string[];
}

/** A planned video, everything except the seed (chosen by seed search). */
export interface Concept {
  arm: Arm;
  templateId: string;
  themeId: string;
  melodyId: string;
  params: Record<string, unknown>;
  targetS: number;
  copy: SocialCopy;
  source: 'claude' | 'fallback' | 'mock' | 'manual';
  rationale?: string;
}

export const LIMITS = { hook: 60, cta: 48, title: 90, tiktok: 300, x: 270, hashtags: 6 };

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');

/**
 * Hashtags about the tooling rather than the video. They attract no relevant viewers, so they
 * are stripped from hashtag lists and caption text no matter who wrote the copy.
 */
const BLOCKED_TAGS = new Set([
  'claude', 'claudeai', 'anthropic', 'opus', 'sonnet', 'haiku', 'ai', 'aiart', 'aigenerated', 'aivideo', 'madewithai',
  'generativeai', 'genai', 'chatgpt', 'openai', 'gpt', 'llm', 'aitools', 'artificialintelligence',
]);

const isBlockedTag = (tag: string) => BLOCKED_TAGS.has(tag.replace(/^#+/, '').toLowerCase());

/** Remove blocked #tags from free text and tidy the leftover whitespace. */
function stripBlockedTags(text: string): string {
  return text
    .replace(/#[\p{L}\p{N}_]+/gu, (tag) => (isBlockedTag(tag) ? '' : tag))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .trim();
}

/** Enforce platform limits, tidy hashtags and drop self-referencing ones. Never throws. */
export function normalizeCopy(c: SocialCopy): SocialCopy {
  const tags = [...new Set(c.hashtags.map((h) => '#' + h.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')).filter((h) => h.length > 1 && !isBlockedTag(h)))].slice(
    0,
    LIMITS.hashtags,
  );
  return {
    hook: clip(c.hook.trim(), LIMITS.hook),
    cta: clip(c.cta.trim(), LIMITS.cta),
    title: clip(stripBlockedTags(c.title.replace(/#shorts/gi, '')), LIMITS.title),
    youtubeDescription: stripBlockedTags(c.youtubeDescription),
    tiktokCaption: clip(stripBlockedTags(c.tiktokCaption), LIMITS.tiktok),
    xPost: clip(stripBlockedTags(c.xPost), LIMITS.x),
    hashtags: tags,
  };
}

/** Final per-platform text files, ready to paste. */
export function platformText(c: SocialCopy) {
  const tags = c.hashtags.join(' ');
  return {
    youtube: `${c.title} #Shorts\n\n${c.youtubeDescription}\n\n${tags} #Shorts`.trim(),
    tiktok: c.tiktokCaption.includes('#') ? c.tiktokCaption : `${c.tiktokCaption} ${tags}`.trim(),
    x: c.xPost,
  };
}

/**
 * Coerce LLM-proposed params into the template's ranges, then validate with zod.
 * Out-of-range numbers are clamped and integers rounded rather than rejected.
 */
export function coerceParams(template: Template, raw: Record<string, unknown>): Record<string, unknown> {
  const schema = paramsJsonSchema(template) as { properties: Record<string, any> };
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (prop.type === 'number' || prop.type === 'integer') {
      let n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (prop.minimum !== undefined) n = Math.max(prop.minimum, n);
      if (prop.maximum !== undefined) n = Math.min(prop.maximum, n);
      out[key] = prop.type === 'integer' ? Math.round(n) : n;
    } else if (prop.enum) {
      if (prop.enum.includes(v)) out[key] = v;
    } else if (prop.type === 'boolean') {
      out[key] = Boolean(v);
    }
  }
  return template.schema.parse(out) as Record<string, unknown>;
}

/** Template description for prompts: what it is, its params (with ranges/defaults) and copy placeholders. */
export function describeTemplate(template: Template): string {
  const schema = paramsJsonSchema(template) as { properties: Record<string, any> };
  const params = Object.entries(schema.properties).map(([key, p]) => {
    const range = p.enum ? `one of ${p.enum.map((e: string) => `"${e}"`).join(', ')}` : p.type === 'boolean' ? 'true/false' : `${p.minimum}–${p.maximum}`;
    return `- ${key} (${p.title ?? key}): ${range}; default ${JSON.stringify(p.default)}`;
  });
  return [
    `Template "${template.id}" (${template.name}, family: ${template.family})`,
    template.description,
    `Default hook: "${template.defaultCopy.hook}"  Default CTA: "${template.defaultCopy.cta}"`,
    'Hook/CTA may use {paramName} placeholders (filled from params) and, in CTAs, {winner} where the template reports a winner.',
    template.ownMusic ? 'This template generates its own notes; the melody choice is ignored.' : '',
    'Parameters:',
    ...params,
  ]
    .filter(Boolean)
    .join('\n');
}

const STYLE_HOOKS: Record<Arm['hookStyle'], (t: Template) => string> = {
  question: (t) => t.defaultCopy.hook,
  challenge: (t) => (t.family === 'race' ? "Bet you can't pick the winner" : "Try not to blink until it's done"),
  'pick-a-side': (t) => (t.family === 'race' ? 'Pick your favorite before it starts!' : 'Guess how it ends before it starts'),
  curiosity: (t) => (t.family === 'particles' ? 'Wait for the last layer…' : 'Wait for the ending…'),
};

/**
 * Concept without an LLM: template defaults with gentle seeded variation, and copy from
 * fill-in templates. Used when there is no API key or the API fails.
 */
export function fallbackConcept(arm: Arm, targetS: number, rng: Rng): Concept {
  const template = getTemplate(arm.templateId);
  const schema = paramsJsonSchema(template) as { properties: Record<string, any> };
  const raw: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(schema.properties)) {
    // Only vary numbers mildly; defaults are tuned to finish reliably.
    if ((p.type === 'number' || p.type === 'integer') && rng.chance(0.35)) {
      raw[key] = (p.default as number) * rng.range(0.9, 1.1);
    }
  }
  const params = coerceParams(template, raw);
  const melodyId = rng.pick(MELODIES).id;
  const name = template.name;
  const tags = ['satisfying', 'oddlysatisfying', 'asmr', 'physics', name.toLowerCase().replace(/\s+/g, '')];
  return {
    arm,
    templateId: arm.templateId,
    themeId: arm.themeId,
    melodyId,
    params,
    targetS,
    source: 'fallback',
    copy: normalizeCopy({
      hook: STYLE_HOOKS[arm.hookStyle](template),
      cta: template.defaultCopy.cta,
      title: `${name} — oddly satisfying`,
      youtubeDescription: `${template.description}\nWatch till the end.`,
      tiktokCaption: `Wait for it… ${name.toLowerCase()} edition`,
      xPost: `${name} — watch till the end 👀`,
      hashtags: tags,
    }),
  };
}

/** JSON schema for the LLM's structured output for one arm (no numeric constraints: those go in descriptions). */
export function conceptOutputSchema(template: Template) {
  const ps = paramsJsonSchema(template) as { properties: Record<string, any> };
  const paramProps: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(ps.properties)) {
    const desc = `${p.title ?? key}. ${p.enum ? '' : p.type === 'boolean' ? '' : `Range ${p.minimum} to ${p.maximum}. `}Default ${JSON.stringify(p.default)}.`;
    paramProps[key] = p.enum ? { type: 'string', enum: p.enum, description: desc } : { type: p.type === 'integer' ? 'integer' : p.type, description: desc };
  }
  const str = (description: string) => ({ type: 'string', description });
  return {
    type: 'object',
    additionalProperties: false,
    required: ['params', 'melodyId', 'hook', 'cta', 'title', 'youtubeDescription', 'tiktokCaption', 'xPost', 'hashtags', 'rationale'],
    properties: {
      params: { type: 'object', additionalProperties: false, required: Object.keys(paramProps), properties: paramProps },
      melodyId: { type: 'string', enum: MELODIES.map((m) => m.id) },
      hook: str(`On-screen hook shown in the first 2 seconds. Max ${LIMITS.hook} characters.`),
      cta: str(`On-screen call to action at the end. Max ${LIMITS.cta} characters.`),
      title: str(`YouTube Shorts title without #Shorts. Max ${LIMITS.title} characters.`),
      youtubeDescription: str(
        'Published YouTube description, written to the viewer: 1-3 short lines saying what happens in this video, using words people search for (e.g. "marble race", "satisfying sand art"). No hashtags. Never mention retention, hooks, strategy or how it was made.',
      ),
      tiktokCaption: str(`Published TikTok caption, written to the viewer, ending with 3-5 hashtags. Max ${LIMITS.tiktok} characters.`),
      xPost: str(`Published post for X, written to the viewer, with 1-2 hashtags. Max ${LIMITS.x} characters.`),
      hashtags: {
        type: 'array',
        items: { type: 'string' },
        description:
          '3-6 hashtags, without spaces, chosen to reach people who would enjoy this exact video: mix 1-2 broad ones (#satisfying, #oddlysatisfying) with specific ones for the format and subject (#marblerace, #sandart, #sortingalgorithms). Never tags about tools or AI (#claude, #ai).',
      },
      rationale: str('Private note for the channel owner (never published): one sentence on why this concept should hold attention.'),
    },
  };
}

export function hookStyleGuide(arm: Arm): string {
  return HOOK_STYLES[arm.hookStyle];
}
