import { paramsJsonSchema, type Rng, type Template } from '@sim/engine';
import { MELODIES } from '@sim/audio';
import { FOURIER_GUESS, getTemplate } from '@sim/templates';
import { HOOK_STYLES, type Arm } from './arms';
import { uploadText, type Platform } from './platforms';

/** On-screen text plus per-platform copy for one video. */
export interface SocialCopy {
  hook: string;
  cta: string;
  /** On-screen comment prompt (engagement cues; absent for the comparison group). */
  nudge?: string;
  title: string;
  youtubeDescription: string;
  tiktokCaption: string;
  xPost: string;
  hashtags: string[];
  /** Instagram Reels caption (absent on videos planned before Instagram was added). */
  instagramCaption?: string;
  /** A first comment to pin on each platform (on X, a reply to your own post). */
  pinnedComments?: Partial<Record<Platform, string>>;
  /** A few words to put on the TikTok / Instagram cover image. */
  coverText?: string;
  /** Emojis that fit this video, offered first in the export page's emoji picker. */
  emojis?: string[];
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
  /** Set when the learner chose this arm to test it rather than because it is expected to win. */
  experiment?: { reason: string };
  /** Whether the title was planned to lead with an emoji (most do; the rest are a comparison group). */
  titleEmoji?: boolean;
  /** Where the settings came from when the taste model chose them (e.g. "near a video you approved"). */
  paramsSource?: string;
  /** Owner's notes for Claude when the copy was written (Playground exports). */
  notes?: string;
}

export const LIMITS = { hook: 60, cta: 48, nudge: 44, title: 90, tiktok: 300, instagram: 500, x: 270, hashtags: 6, pinned: 150, cover: 40, emojis: 12 };

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
    ...(c.nudge?.trim() ? { nudge: clip(c.nudge.trim(), LIMITS.nudge) } : {}),
    ...(c.instagramCaption !== undefined ? { instagramCaption: clip(stripBlockedTags(c.instagramCaption), LIMITS.instagram) } : {}),
    ...(c.pinnedComments
      ? { pinnedComments: Object.fromEntries(Object.entries(c.pinnedComments).map(([k, v]) => [k, clip(stripBlockedTags(v ?? ''), LIMITS.pinned)])) }
      : {}),
    ...(c.coverText !== undefined ? { coverText: clip(c.coverText.replace(/#[\p{L}\p{N}_]+/gu, '').trim(), LIMITS.cover) } : {}),
    ...(c.emojis ? { emojis: [...new Set(c.emojis.map((e) => e.trim()).filter((e) => e && startsWithEmoji(e)))].slice(0, LIMITS.emojis) } : {}),
  };
}

/** Share of videos with engagement cues (comment prompt + like heart); the rest are the comparison group. */
export const CUES_SHARE = 0.75;

/**
 * A comment prompt for this template, avoiding ones used recently (and earlier in this batch) so
 * the same nudge doesn't keep coming back. Records the pick in `recent`.
 */
export function pickNudge(templateId: string, rng: Rng, recent: string[] = []): string | undefined {
  const pool = getTemplate(templateId).nudges ?? [];
  if (!pool.length) return undefined;
  const fresh = pool.filter((n) => !recent.includes(n));
  const pick = rng.pick(fresh.length ? fresh : pool);
  recent.unshift(pick);
  return pick;
}

/**
 * Params the planner decides itself (seeded, evenly split) instead of leaving them to Claude, which
 * tends to keep defaults for cosmetic options. Even splits also give the analytics a clean comparison.
 */
export interface PlannedVariant {
  param: string;
  values: readonly string[];
  /** Prompt line telling Claude what the chosen value means for the copy. */
  guide: Record<string, string>;
  /** On-screen hook used verbatim for a value (overrides whatever the model writes). */
  hook?: Record<string, string>;
  /**
   * Only planned (and only learned from) when an earlier variant took one of these values, e.g. the
   * player count only for a free-for-all. Unplanned, the param keeps its default.
   */
  when?: { param: string; values: readonly string[] };
}

/** Analytics key for one value of a planned variant (with its condition, if any). */
export const variantKey = (templateId: string, v: PlannedVariant, value: string) =>
  `${templateId}.${v.param}=${value}${v.when ? `?${v.when.param}=${v.when.values.join(',')}` : ''}`;

export const PLANNED_VARIANTS: Record<string, PlannedVariant[]> = {
  'ball-battle': [
    {
      param: 'teams',
      values: ['colors', 'countries'],
      guide: {
        colors: 'Teams: colors (fixed for this video). Balls are named by colour (Red, Blue, Green…); don\'t mention countries or flags.',
        countries:
          'Teams: countries (fixed for this video). Every ball is a country with its national flag filling the whole ball (USA, Brazil, Japan, Germany…), and {winner} is a country name. Lean into friendly national rivalry: invite viewers to back their country. Keep it light, no politics.',
      },
    },
  ],
  'territory-war': [
    {
      param: 'teams',
      values: ['colors', 'countries'],
      guide: {
        colors: 'Teams: colors (fixed for this video). Territories and balls are named by colour (Red, Blue, Green…); don\'t mention countries or flags.',
        countries:
          'Teams: countries (fixed for this video). Each territory is a country with its flag showing across its tiles and on its balls (USA, Brazil, Japan, Germany…), and {winner} is a country name. Lean into friendly national rivalry: invite viewers to back their country. Keep it light, no politics.',
      },
    },
  ],
  'gravity-funnel': [
    {
      param: 'teams',
      values: ['colors', 'countries'],
      guide: {
        colors: 'Teams: colors (fixed for this video). Marbles are named by colour (Red, Blue, Green…); don\'t mention countries or flags.',
        countries:
          'Teams: countries (fixed for this video). Every marble carries a national flag (USA, Brazil, Japan, Germany…), and {winner} is a country name. Lean into friendly national rivalry: invite viewers to back their country. Keep it light, no politics.',
      },
    },
  ],
  polyrhythm: [
    {
      // Rotates the looks so batches don't repeat one style, and lets the learner compare them.
      param: 'style',
      values: ['arcs', 'pendulum-wave', 'polygons', 'string-art', 'piano', 'pendulum-3d'],
      guide: {
        arcs: 'Style: arcs (fixed for this video). Dots swing along concentric half-circles, each edge hit plays a note.',
        'pendulum-wave': 'Style: pendulum-wave (fixed for this video). A pendulum wave seen from above: rows of bobs swinging side to side, forming snakes and waves before lining up.',
        polygons:
          'Style: polygons (fixed for this video). Dots trace nested shapes (triangle, square, pentagon…) and ping at every corner, so you hear 3 against 4 against 5. Hooks can name the shapes or the rhythm.',
        'string-art':
          'Style: string-art (fixed for this video). Dots orbit rings joined by strings that draw a mandala as they move; it completes just before they all line up. "Watch what it draws" works well.',
        piano: 'Style: piano (fixed for this video). Balls bounce on piano keys, each landing plays its key; slow balls bounce high, fast ones skip. Musical, piano-roll feel.',
        'pendulum-3d':
          'Style: pendulum-3d (fixed for this video). A real-looking 3D pendulum-wave apparatus: balls on strings of different lengths swinging in and out of sync. Hooks can lean on "real physics".',
      },
    },
  ],
  'pathfinding-race': [
    {
      param: 'map',
      values: ['maze', 'braided', 'open', 'weighted'],
      guide: {
        maze: 'Map: a classic maze (fixed for this video). There is only one route, so every algorithm ends on the same path; the race is about how much each one has to explore. Never predict the winner.',
        braided: 'Map: a maze with loops (fixed for this video). Several routes exist, so an algorithm can arrive first on a longer path. "Fastest isn\'t always shortest" angles work. Never predict the winner.',
        open: 'Map: an open field with scattered walls (fixed for this video). Goal-directed searches (A*, Greedy) beeline while blind ones flood everywhere. Never predict the winner.',
        weighted:
          'Map: an open field with mud patches that cost 5× to cross (fixed for this video). Dijkstra and A* route around the mud; the others plough straight through. "Fastest vs cheapest" angles work. Never predict the winner.',
      },
    },
  ],
  'fourier-drawing': [
    {
      param: 'subject',
      values: ['countries', 'states', 'dinosaurs', 'animals', 'fantasy'],
      guide: Object.fromEntries(
        (
          [
            ['countries', 'country', 'country', 'a mystery country\'s outline'],
            ['states', 'state', 'US state', 'a mystery US state\'s outline'],
            ['dinosaurs', 'dinosaur', 'dinosaur', 'a mystery dinosaur\'s silhouette'],
            ['animals', 'animal', 'animal', 'a mystery animal\'s silhouette'],
            ['fantasy', 'fantasy', 'mythical creature', 'a mystery mythical creature\'s silhouette (unicorn, griffin, mermaid…)'],
          ] as const
        ).map(([value, category, kind, what]) => [
          value,
          `Subject: ${value} (fixed for this video). The circles draw ${what}, revealed at the end; early on it is just a blob. The on-screen hook is fixed ("${FOURIER_GUESS[category]}"). Invite guessing which ${kind} it is in the title and captions too, but never name or hint at the answer anywhere (title, captions, hashtags). The CTA should reveal it with {answer} and {icon}, e.g. "It was {answer} {icon}! Did you get it?".`,
        ]),
      ),
      hook: {
        countries: FOURIER_GUESS.country,
        states: FOURIER_GUESS.state,
        dinosaurs: FOURIER_GUESS.dinosaur,
        animals: FOURIER_GUESS.animal,
        fantasy: FOURIER_GUESS.fantasy,
      },
    },
    // Keeps the mystery shape a seeded pick (Claude can't choose one, so batches don't repeat it).
    { param: 'shape', values: ['random'], guide: { random: 'Shape: picked at random after you write the copy, so keep the copy generic to the subject.' } },
  ],
  'spin-battle': [
    {
      param: 'format',
      values: ['duel', 'points', 'ffa'],
      guide: {
        duel: 'Format: duel (fixed for this video). One fight: the last top still spinning (or still in the stadium) wins.',
        points:
          'Format: points (fixed for this video). Several rounds: a spin finish (the loser runs out of spin) scores 1, an over finish (knocked out of the stadium) scores 2, first to {targetPoints} wins. "Who gets to {targetPoints} first?" angles work; in the CTA, {score} is the final score.',
        ffa: 'Format: free-for-all (fixed for this video). Several tops in one stadium, knocked out or spun out one at a time until only one is left spinning. Their types are random (two of a kind can meet) and picked after you write, so don\'t name types; "last one spinning wins" and "pick your top" angles work. Never predict the winner.',
      },
    },
    {
      param: 'players',
      values: ['4', '3'],
      when: { param: 'format', values: ['ffa'] },
      guide: {
        '4': 'Players: 4 tops in the free-for-all (fixed for this video).',
        '3': 'Players: 3 tops in the free-for-all (fixed for this video).',
      },
    },
    {
      param: 'matchup',
      values: ['attack-defense', 'attack-stamina', 'defense-stamina', 'mirror', 'random'],
      when: { param: 'format', values: ['duel', 'points'] },
      guide: {
        'attack-defense':
          'Matchup: Attack vs Defense (fixed for this video). Attack races around and smashes into its rival; Defense is heavy and tries to absorb hits. Which colour/name gets which type is picked after you write, so name the types, not the tops. Never predict the winner.',
        'attack-stamina':
          'Matchup: Attack vs Stamina (fixed for this video). Attack hunts and smashes; Stamina sits in the middle trying to outlast it. Which colour/name gets which type is picked after you write, so name the types, not the tops. Never predict the winner.',
        'defense-stamina':
          'Matchup: Defense vs Stamina (fixed for this video). A heavy wall against a top built to spin longest: a battle of endurance. Which colour/name gets which type is picked after you write, so name the types, not the tops. Never predict the winner.',
        mirror: 'Matchup: mirror (fixed for this video). Both tops are the same type (picked after you write), so it comes down to the launch. Keep the copy about two identical tops, without naming the type.',
        random: 'Matchup: random (fixed for this video). The two types (Attack, Defense, Stamina or Balance) are picked after you write, so keep the copy generic about two battle tops.',
      },
    },
    {
      param: 'identity',
      values: ['colors', 'countries', 'named'],
      guide: {
        colors: 'Tops: colors (fixed for this video). Tops are named by colour (Red, Blue…); don\'t mention countries, flags or top names.',
        countries:
          'Tops: countries (fixed for this video). Each top carries a national flag (USA, Brazil, Japan…), and {winner} is a country name. Lean into friendly national rivalry: invite viewers to back their country. Keep it light, no politics.',
        named:
          'Tops: named (fixed for this video). Each top has an invented anime-style name and emblem (e.g. Ember Lynx, Frost Mammoth), and {winner} is that name. You can lean into the anime-tournament feel, but never mention any real toy brand.',
      },
    },
  ],
  'snake-ai': [
    {
      param: 'ending',
      values: ['filled', 'trapped'],
      guide: {
        filled:
          'Ending: fixed for this video (the seed search picks a game that ends this way). Never hint at how it ends in the hook, title or captions; keep "will it make it?" open. The CTA may use {result}.',
        trapped:
          'Ending: fixed for this video (the seed search picks a game that ends this way). Never hint at how it ends in the hook, title or captions; keep "will it make it?" open. The CTA may use {result}.',
      },
    },
  ],
};

/** Seeded choice of every planned variant for a template ({} when it has none, consuming no randomness). */
export function planVariants(templateId: string, rng: Rng): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of PLANNED_VARIANTS[templateId] ?? []) {
    if (v.when && !v.when.values.includes(out[v.when.param])) continue;
    out[v.param] = rng.pick(v.values);
  }
  return out;
}

/** A hook fixed by one of the chosen variants, if any. */
export const variantHook = (templateId: string, chosen: Record<string, unknown>): string | undefined =>
  applicableVariants(templateId, chosen).map((v) => v.hook?.[chosen[v.param] as string]).find(Boolean);

/** Prompt lines describing the fixed variant choices. */
export const variantGuide = (templateId: string, chosen: Record<string, unknown>): string[] =>
  applicableVariants(templateId, chosen).flatMap((v) => (typeof chosen[v.param] === 'string' && v.guide[chosen[v.param] as string] ? [v.guide[chosen[v.param] as string]] : []));

/** The template's planned variants that apply given these params (conditions met). */
const applicableVariants = (templateId: string, chosen: Record<string, unknown>) =>
  (PLANNED_VARIANTS[templateId] ?? []).filter((v) => !v.when || v.when.values.includes(String(chosen[v.when.param])));

/** Share of titles that lead with an emoji. The rest keep a comparison group for the analytics. */
export const TITLE_EMOJI_SHARE = 0.75;

/** Fallback lead emoji per template, used when a title should lead with one but doesn't. */
const TITLE_EMOJI: Record<string, string[]> = {
  'ring-escape': ['😱', '🤯', '👀'],
  'marble-race': ['🏁', '🔥', '😱'],
  'ball-battle': ['⚔️', '🔥', '😤'],
  'sand-pour': ['🤯', '😍', '✨'],
  polyrhythm: ['🎶', '🤯', '✨'],
  'sorting-race': ['🏁', '🤓', '👀'],
  'territory-war': ['⚔️', '🗺️', '😱'],
  'snake-ai': ['🐍', '😱', '🤯'],
  'shell-escape': ['🤯', '💎', '😱'],
  'gravity-funnel': ['🌀', '😱', '🔥'],
  'grow-until-full': ['😱', '🫧', '👀'],
  'colliding-blocks': ['🤯', '🧱', '😱'],
  'pathfinding-race': ['🧭', '🏁', '🤓'],
  'fourier-drawing': ['✏️', '🤯', '👀'],
  'spin-battle': ['🌀', '⚔️', '🔥'],
};
const DEFAULT_TITLE_EMOJI = ['🤯', '😱', '👀', '🔥'];

const LEADING_EMOJI = /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\ufe0f]+\s*)+/u;

export const startsWithEmoji = (s: string) => /^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(s.trim());

/** Make a title lead with an emoji (keeping one that is already there) or not lead with one. */
export function applyTitleEmoji(title: string, lead: boolean, templateId: string, rng: Rng): string {
  const t = title.trim();
  if (!lead) return t.replace(LEADING_EMOJI, '').trim() || t;
  if (startsWithEmoji(t)) return t;
  return clip(`${rng.pick(TITLE_EMOJI[templateId] ?? DEFAULT_TITLE_EMOJI)} ${t}`, LIMITS.title);
}

/** Final per-platform text (every field in one block), as written to the .txt files. */
export function platformText(c: SocialCopy): Record<Platform, string> {
  const t = uploadText(c);
  return { youtube: t.youtube.all, tiktok: t.tiktok.all, instagram: t.instagram.all, x: t.x.all };
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
export function fallbackConcept(arm: Arm, targetS: number, rng: Rng, opts: { titleEmoji?: boolean; variants?: Record<string, unknown> } = {}): Concept {
  const template = getTemplate(arm.templateId);
  const schema = paramsJsonSchema(template) as { properties: Record<string, any> };
  const raw: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(schema.properties)) {
    // Only vary numbers mildly; defaults are tuned to finish reliably.
    if ((p.type === 'number' || p.type === 'integer') && rng.chance(0.35)) {
      raw[key] = (p.default as number) * rng.range(0.9, 1.1);
    }
  }
  const params = coerceParams(template, { ...raw, ...opts.variants });
  const melodyId = rng.pick(MELODIES).id;
  const name = template.name;
  const tags = ['satisfying', 'oddlysatisfying', 'asmr', 'physics', name.toLowerCase().replace(/\s+/g, '')];
  const titleEmoji = opts.titleEmoji ?? rng.chance(TITLE_EMOJI_SHARE);
  return {
    arm,
    templateId: arm.templateId,
    themeId: arm.themeId,
    melodyId,
    params,
    targetS,
    source: 'fallback',
    titleEmoji,
    copy: normalizeCopy({
      hook: variantHook(arm.templateId, params) ?? STYLE_HOOKS[arm.hookStyle](template),
      cta: template.defaultCopy.cta,
      title: applyTitleEmoji(`${name} — oddly satisfying`, titleEmoji, arm.templateId, rng),
      youtubeDescription: `${template.description}\nWatch till the end.`,
      tiktokCaption: `Wait for it… ${name.toLowerCase()} edition`,
      instagramCaption: `Wait for the end of this ${name.toLowerCase()} 👀`,
      xPost: `${name} — watch till the end 👀`,
      hashtags: tags,
      pinnedComments: { youtube: 'Did you call it? 👇', tiktok: 'Did you call it? 👇', instagram: 'Did you call it? 👇', x: 'Did you call it?' },
      coverText: name,
      emojis: [...(TITLE_EMOJI[arm.templateId] ?? DEFAULT_TITLE_EMOJI), '✨', '👀', '🔥', '😮‍💨'],
    }),
  };
}

const str = (description: string) => ({ type: 'string', description });

/**
 * Structured-output properties for the published text, per platform. Shared by the batch planner
 * and the export copy writer, which can also ask for one platform at a time.
 */
export const COPY_FIELDS = {
  youtube: {
    title: str(`YouTube Shorts title without #Shorts, following the request's instruction about a leading emoji. Front-load the words people search for. Max ${LIMITS.title} characters.`),
    youtubeDescription: str(
      'Published YouTube description, written to the viewer: 1-3 short lines saying what happens in this video, using words people search for (e.g. "marble race", "satisfying sand art"). No hashtags. Never mention retention, hooks, strategy or how it was made.',
    ),
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description:
        '3-6 hashtags, without spaces, chosen to reach people who would enjoy this exact video: mix 1-2 broad ones (#satisfying, #oddlysatisfying) with specific ones for the format and subject (#marblerace, #sandart, #sortingalgorithms). Never tags about tools or AI (#claude, #ai).',
    },
    youtubePinnedComment: str(`A comment to pin under the YouTube Short that starts replies: a question about this video (a guess, a side, a rating). Don't repeat the on-screen CTA word for word. Max ${LIMITS.pinned} characters.`),
  },
  tiktok: {
    tiktokCaption: str(`Published TikTok caption, written to the viewer, ending with 3-5 hashtags. Max ${LIMITS.tiktok} characters.`),
    tiktokPinnedComment: str(`A comment to pin on TikTok that starts replies, different from the YouTube one. Max ${LIMITS.pinned} characters.`),
  },
  instagram: {
    instagramCaption: str(
      `Published Instagram Reels caption, written to the viewer. The first line shows before "more", so make it count; then at most a line or two, ending with 3-5 hashtags (Instagram allows no more than 5). Max ${LIMITS.instagram} characters.`,
    ),
    instagramPinnedComment: str(`A comment to pin on Instagram that starts replies, different from the others. Max ${LIMITS.pinned} characters.`),
  },
  x: {
    xPost: str(`Published post for X, written to the viewer, with 1-2 hashtags. Max ${LIMITS.x} characters.`),
    xReply: str(`A short reply to post under your own X post that invites replies (a question or a poll-style "A or B?"). No hashtags. Max ${LIMITS.pinned} characters.`),
  },
  cover: {
    coverText: str(`Text for the TikTok / Instagram cover image: 2-5 punchy words that make people tap, no hashtags, never giving away the ending. Max ${LIMITS.cover} characters.`),
  },
  emojis: {
    emojis: { type: 'array', items: { type: 'string' }, description: `8-${LIMITS.emojis} single emojis that fit this video's subject and mood, most fitting first, for the owner to use when editing.` },
  },
} as const;

export type CopyGroup = keyof typeof COPY_FIELDS;

/** Structured-output properties for some groups (all by default). */
export function copyFieldProps(groups: readonly CopyGroup[] = Object.keys(COPY_FIELDS) as CopyGroup[]): Record<string, unknown> {
  return Object.assign({}, ...groups.map((g) => COPY_FIELDS[g]));
}

/** The flat structured-output fields, as returned by the model (each optional when only some groups were asked for). */
export interface CopyOutput {
  title?: string;
  youtubeDescription?: string;
  hashtags?: string[];
  youtubePinnedComment?: string;
  tiktokCaption?: string;
  tiktokPinnedComment?: string;
  instagramCaption?: string;
  instagramPinnedComment?: string;
  xPost?: string;
  xReply?: string;
  coverText?: string;
  emojis?: string[];
}

/** Merge flat model output into existing copy (only the fields present in `out` change). Not normalized. */
export function mergeCopyOutput(base: SocialCopy, out: CopyOutput): SocialCopy {
  const pinned = { ...base.pinnedComments };
  if (out.youtubePinnedComment !== undefined) pinned.youtube = out.youtubePinnedComment;
  if (out.tiktokPinnedComment !== undefined) pinned.tiktok = out.tiktokPinnedComment;
  if (out.instagramPinnedComment !== undefined) pinned.instagram = out.instagramPinnedComment;
  if (out.xReply !== undefined) pinned.x = out.xReply;
  const pick = <K extends keyof SocialCopy>(k: K, v: SocialCopy[K] | undefined) => (v === undefined ? {} : { [k]: v });
  return {
    ...base,
    ...pick('title', out.title),
    ...pick('youtubeDescription', out.youtubeDescription),
    ...pick('hashtags', out.hashtags),
    ...pick('tiktokCaption', out.tiktokCaption),
    ...pick('instagramCaption', out.instagramCaption),
    ...pick('xPost', out.xPost),
    ...pick('coverText', out.coverText),
    ...pick('emojis', out.emojis),
    ...(Object.keys(pinned).length ? { pinnedComments: pinned } : {}),
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
  const copyProps = copyFieldProps();
  return {
    type: 'object',
    additionalProperties: false,
    required: ['params', 'melodyId', 'hook', 'cta', ...Object.keys(copyProps), 'rationale'],
    properties: {
      params: { type: 'object', additionalProperties: false, required: Object.keys(paramProps), properties: paramProps },
      melodyId: { type: 'string', enum: MELODIES.map((m) => m.id) },
      hook: str(`On-screen hook shown in the first 2 seconds. Max ${LIMITS.hook} characters.`),
      cta: str(`On-screen call to action at the end. Max ${LIMITS.cta} characters.`),
      ...copyProps,
      rationale: str('Private note for the channel owner (never published): one sentence on why this concept should hold attention.'),
    },
  };
}

export function hookStyleGuide(arm: Arm): string {
  return HOOK_STYLES[arm.hookStyle];
}
