import { Runner, getTheme, hashString, parseParams, type NarrationBeat, type NarrationLine, type Recipe } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from '@sim/templates';
import { hasClip, voiceLine, voicePassage } from './cache';
import { kokoro } from './kokoro';
import type { TtsProvider } from './provider';
import { fallbackLines, fillLine } from './writer';

const PROVIDERS: Record<string, TtsProvider> = { kokoro };

export const getProvider = (id: string): TtsProvider => {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown voice provider: ${id}`);
  return p;
};

export interface PrepareOptions {
  provider?: TtsProvider;
  /** Rewrite and re-voice even if the recipe already has lines for these facts. */
  force?: boolean;
}

/** This run's beats: facts come from a headless run (they don't depend on line lengths). */
export function beatsFor(recipe: Recipe): { beats: NarrationBeat[]; params: unknown } | null {
  const template = getTemplate(recipe.templateId);
  const spec = template.narration;
  const params = parseParams(template, recipe.params);
  if (!spec?.enabled(params)) return null;
  const run = new Runner(template, { seed: recipe.seed, params, theme: getTheme(recipe.themeId), melody: getMelody(recipe.melodyId), visual: false, maxSeconds: 90 }).runToEnd();
  return { beats: spec.beats(params, run.events), params };
}

/** Bumped when the way lines are made changes (units spoken in full; hand-written lines only), so old voicings are redone. */
const LINES_VERSION = 3;
const factsHash = (beats: NarrationBeat[], provider: string, voice: string) => hashString(JSON.stringify([LINES_VERSION, provider, voice, beats.map((b) => [b.id, b.facts])]));

/**
 * Write and voice a recipe's narration, returning the recipe with `voice` set (or cleared, for a
 * template or mode without narration). Lines already made for the same facts are kept, so a
 * re-render sounds the same; a new seed means new numbers, so new lines.
 */
export async function prepareNarration(recipe: Recipe, opts: PrepareOptions = {}): Promise<Recipe> {
  const found = beatsFor(recipe);
  if (!found) return recipe.voice ? { ...recipe, voice: undefined } : recipe;
  const template = getTemplate(recipe.templateId);
  const spec = template.narration!;
  const provider = opts.provider ?? kokoro;
  const voiceId = spec.voice(found.params);
  const hash = factsHash(found.beats, provider.id, voiceId);
  const current = recipe.voice;
  if (!opts.force && current?.factsHash === hash && current.lines.every((l) => hasClip(l.clip))) return recipe;

  // Keep the words if only the clips went missing (e.g. a cleared cache): same video, same lines.
  const reuse = !opts.force && current?.factsHash === hash ? current : undefined;
  const written = reuse ? {} : fallbackLines(found.beats, recipe.seed);
  const lines: NarrationLine[] = [];
  for (const beat of found.beats) {
    const prior = reuse?.lines.find((l) => l.beat === beat.id);
    if (prior && hasClip(prior.clip)) {
      lines.push(prior);
      continue;
    }
    const filled = prior ? { text: prior.text, caption: prior.caption, parts: prior.parts } : fillLine(beat, written[beat.id]);
    if (beat.parts && filled.parts) {
      // A passage: each sentence voiced on its own, so the picture can change exactly as it starts.
      const { clip, durationS, parts } = await voicePassage(provider, voiceId, filled.parts.map((p) => p.text));
      const withTimes = filled.parts.map((p, k) => ({ text: p.text, caption: p.caption, ...parts[k] }));
      lines.push({ beat: beat.id, text: filled.text, caption: filled.caption, clip, durationS, parts: withTimes });
    } else {
      const { clip, durationS } = await voiceLine(provider, voiceId, filled.text);
      lines.push({ beat: beat.id, text: filled.text, caption: filled.caption, clip, durationS });
    }
  }
  return { ...recipe, voice: { provider: provider.id, voiceId, factsHash: hash, lines } };
}
