import type Anthropic from '@anthropic-ai/sdk';
import { Runner, getTheme, hashString, parseParams, type NarrationBeat, type NarrationLine, type Recipe, type VoiceTrack } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from '@sim/templates';
import { hasClip, voiceLine } from './cache';
import { kokoro } from './kokoro';
import type { TtsProvider } from './provider';
import { fillLine, writeLines } from './writer';

const PROVIDERS: Record<string, TtsProvider> = { kokoro };

export const getProvider = (id: string): TtsProvider => {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown voice provider: ${id}`);
  return p;
};

export interface PrepareOptions {
  /** Let Claude write the lines (default: when credentials are set and the planner isn't mocked). */
  useClaude?: boolean;
  client?: Anthropic;
  provider?: TtsProvider;
  /** Rewrite and re-voice even if the recipe already has lines for these facts. */
  force?: boolean;
  onWarning?: (message: string) => void;
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

const factsHash = (beats: NarrationBeat[], provider: string, voice: string) => hashString(JSON.stringify([provider, voice, beats.map((b) => [b.id, b.facts])]));

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

  const useClaude = opts.useClaude ?? process.env.SIM_PLANNER !== 'mock';
  // Keep the words if only the clips went missing (e.g. a cleared cache): same video, same lines.
  const reuse = !opts.force && current?.factsHash === hash ? current : undefined;
  let written: { lines: Record<string, string>; writer: VoiceTrack['writer'] };
  if (reuse) written = { lines: {}, writer: reuse.writer };
  else {
    const w = await writeLines(found.beats, { style: spec.style, seed: recipe.seed, useClaude, client: opts.client });
    if (w.warning) opts.onWarning?.(w.warning);
    written = w;
  }
  const lines: NarrationLine[] = [];
  for (const beat of found.beats) {
    const prior = reuse?.lines.find((l) => l.beat === beat.id);
    const { text, caption } = prior ?? fillLine(beat, written.lines[beat.id]);
    const { clip, durationS } = await voiceLine(provider, voiceId, text);
    lines.push({ beat: beat.id, text, caption, clip, durationS });
  }
  return { ...recipe, voice: { provider: provider.id, voiceId, factsHash: hash, writer: written.writer, lines } };
}
