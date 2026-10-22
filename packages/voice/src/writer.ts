import Anthropic from '@anthropic-ai/sdk';
import { hashString, type NarrationBeat } from '@sim/engine';
import { numberForScreen, numberToWords } from './numbers';

/** Lines are short and factual: the small model writes them well, for a fraction of a cent. */
export const WRITER_MODEL = 'claude-haiku-5-5';

/** A beat's line, still with its {placeholders}. */
export type Lines = Record<string, string>;

const PLACEHOLDER = /\{(\w+)\}/g;

/** Words a fact takes to say ("250504" is seven). */
const spokenWords = (v: string | number) => (typeof v === 'number' ? numberToWords(v) : String(v)).split(/\s+/).length;

/** Words in a line as spoken: placeholders count as the words their values take to say. */
export const wordCount = (line: string, facts: Record<string, string | number> = {}) =>
  line
    .replace(PLACEHOLDER, (_, k: string) => ' X'.repeat(k in facts ? spokenWords(facts[k]) : 1))
    .split(/\s+/)
    .filter(Boolean).length;

/** Why a written line can't be used, or null when it's fine. */
export function checkLine(beat: NarrationBeat, line: string): string | null {
  const used = [...line.matchAll(PLACEHOLDER)].map((m) => m[1]);
  const unknown = used.filter((u) => !(u in beat.facts));
  if (unknown.length) return `beat "${beat.id}": unknown placeholder ${unknown.map((u) => `{${u}}`).join(', ')}`;
  const missing = beat.required.filter((r) => !used.includes(r));
  if (missing.length) return `beat "${beat.id}": must use ${missing.map((m) => `{${m}}`).join(', ')}`;
  if (/\d/.test(line.replace(PLACEHOLDER, ''))) return `beat "${beat.id}": write numbers only as placeholders`;
  if (/[×÷=+*/^]/.test(line)) return `beat "${beat.id}": no maths symbols, write the words`;
  const n = wordCount(line, beat.facts);
  if (n > beat.maxWords) return `beat "${beat.id}": ${n} words spoken, the limit is ${beat.maxWords}`;
  if (!line.trim()) return `beat "${beat.id}": empty line`;
  return null;
}

/** Fill a line's placeholders: words for the voice, digits for the screen. */
export function fillLine(beat: NarrationBeat, line: string): { text: string; caption: string } {
  const fill = (spoken: boolean) =>
    line.replace(PLACEHOLDER, (_, key: string) => {
      const v = beat.facts[key];
      return typeof v === 'number' ? (spoken ? numberToWords(v) : numberForScreen(v)) : String(v);
    });
  return { text: fill(true), caption: fill(false) };
}

/**
 * Hand-written lines, picked per beat from the seed (same video, same words) among those that fit
 * the budget with this run's numbers; the shortest if none does.
 */
export function fallbackLines(beats: NarrationBeat[], seed: number): Lines {
  return Object.fromEntries(
    beats.map((b) => {
      const fits = b.fallback.filter((l) => !checkLine(b, l));
      const pool = fits.length ? fits : [...b.fallback].sort((x, y) => wordCount(x, b.facts) - wordCount(y, b.facts)).slice(0, 1);
      return [b.id, pool[parseInt(hashString(`${seed}:${b.id}`), 16) % pool.length]];
    }),
  );
}

const SYSTEM = `You write voiceover lines for short vertical maths videos (YouTube Shorts, TikTok, Reels). Each line is spoken over one moment of an animation while it happens, so it must match that moment exactly and be easy to follow by ear.

Rules:
- Write every number as its {placeholder}, never as digits or words, and never invent a number or a fact.
- Use only the placeholders listed for that beat, and every required one.
- No maths symbols: say "times", "plus", "divided by", "equals".
- Stay within each beat's word limit, counted as spoken: a placeholder counts as the words its value takes to say (given as spokenWords). Leave out an optional placeholder whose number is long. Shorter is better.
- Plain spoken English, natural rhythm, no emojis, no hashtags, no "Hey guys", no filler.
- Each line should flow from the one before it; together they explain the idea step by step.`;

const outputSchema = (beats: NarrationBeat[]) => ({
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { beat: { type: 'string', enum: beats.map((b) => b.id) }, line: { type: 'string' } },
        required: ['beat', 'line'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
});

function userPrompt(beats: NarrationBeat[], style: string, problem?: string) {
  const list = beats.map((b) => ({
    beat: b.id,
    moment: b.about,
    placeholders: Object.fromEntries(Object.entries(b.facts).map(([k, v]) => [k, { value: v, spokenWords: spokenWords(v) }])),
    required: b.required,
    maxWords: b.maxWords,
    example: b.fallback[0],
  }));
  return [
    `Voice and tone: ${style}`,
    'Write one line per beat, in this order. The example shows the kind of line wanted; write your own, with some variety.',
    JSON.stringify(list, null, 2),
    problem ? `Your previous answer could not be used: ${problem}. Fix that.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Lines from Claude Haiku, checked beat by beat (placeholders, word limits); retried twice with the
 * problems spelled out. Every line that passes on any attempt is kept; `missing` lists the beats that
 * never got a usable line (the caller fills those in).
 */
export async function claudeLines(client: Anthropic, beats: NarrationBeat[], style: string): Promise<{ lines: Lines; missing: string[]; problem?: string }> {
  let problem: string | undefined;
  const good: Lines = {};
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await client.messages.create({
      model: WRITER_MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: outputSchema(beats) } },
      messages: [{ role: 'user', content: userPrompt(beats, style, problem) }],
    });
    if (response.stop_reason === 'refusal') return { lines: good, missing: beats.filter((b) => !(b.id in good)).map((b) => b.id), problem: 'the model declined' };
    if (response.stop_reason === 'max_tokens') {
      problem = 'the answer was cut off';
      continue;
    }
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      const parsed = JSON.parse(text) as { lines: { beat: string; line: string }[] };
      const lines: Lines = Object.fromEntries(parsed.lines.map((l) => [l.beat, l.line.trim()]));
      const issues: string[] = [];
      for (const b of beats) {
        const issue = b.id in lines ? checkLine(b, lines[b.id]) : `beat "${b.id}": missing`;
        if (issue) issues.push(issue);
        else good[b.id] ??= lines[b.id];
      }
      if (beats.every((b) => b.id in good)) return { lines: good, missing: [] };
      problem = issues.join('; ');
    } catch (e) {
      problem = (e as Error).message;
    }
  }
  return { lines: good, missing: beats.filter((b) => !(b.id in good)).map((b) => b.id), problem: problem ?? 'no answer' };
}

/** True if the SDK will find credentials (same rule as the planner). */
export const claudeAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/**
 * Lines for every beat: Claude when it's available and asked for, the hand-written set otherwise (or
 * when Claude's answers don't pass the checks).
 */
export async function writeLines(beats: NarrationBeat[], opts: { style: string; seed: number; useClaude: boolean; client?: Anthropic }): Promise<{ lines: Lines; writer: 'claude' | 'fallback'; warning?: string }> {
  if (opts.useClaude && (opts.client || claudeAvailable())) {
    try {
      const out = await claudeLines(opts.client ?? new Anthropic(), beats, opts.style);
      if (!out.missing.length) return { lines: out.lines, writer: 'claude' };
      const fallback = fallbackLines(beats, opts.seed);
      const lines = Object.fromEntries(beats.map((b) => [b.id, out.lines[b.id] ?? fallback[b.id]]));
      const allMissing = out.missing.length === beats.length;
      return {
        lines,
        writer: allMissing ? 'fallback' : 'claude',
        warning: `Built-in lines used for ${allMissing ? 'every beat' : out.missing.join(', ')} (${out.problem})`,
      };
    } catch (e) {
      return { lines: fallbackLines(beats, opts.seed), writer: 'fallback', warning: `Claude narration failed (${(e as Error).message}); used the built-in lines` };
    }
  }
  return { lines: fallbackLines(beats, opts.seed), writer: 'fallback' };
}
