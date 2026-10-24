import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TtsProvider } from './provider';
import { VOICE_CACHE } from './paths';
import { decodeWav, encodeWav, trimSilence, wavDuration } from './wav';

/** Cache file name for a line: the same text in the same voice is only ever voiced once. */
export const clipName = (provider: string, voice: string, text: string) =>
  `${createHash('sha1').update(`${provider}|${voice}|1|${text}`).digest('hex').slice(0, 20)}.wav`;

export const clipPath = (clip: string) => join(VOICE_CACHE, clip);

export const hasClip = (clip: string) => existsSync(clipPath(clip));

/** Voice a line (or reuse the cached clip): returns the clip's name and its length in seconds. */
export async function voiceLine(provider: TtsProvider, voice: string, text: string): Promise<{ clip: string; durationS: number }> {
  const clip = clipName(provider.id, voice, text);
  const path = clipPath(clip);
  if (existsSync(path)) {
    // Reuse counts as use: pruning goes by age, and a Playground recipe may not be saved as a render yet.
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return { clip, durationS: wavDuration(await readFile(path)) };
  }
  const speech = await provider.synthesize(text, voice);
  const wav = encodeWav(trimSilence(speech.samples, speech.sampleRate), speech.sampleRate);
  await mkdir(VOICE_CACHE, { recursive: true });
  await writeFile(path, wav);
  return { clip, durationS: wavDuration(wav) };
}

/** Silence between the sentences of a passage. */
export const PART_GAP_S = 0.12;

/**
 * Voice a passage sentence by sentence (each cached as its own line) and join the sentences into one
 * clip, a short pause between them: one sound to play, with the exact start of each sentence in it.
 */
export async function voicePassage(provider: TtsProvider, voice: string, texts: string[]): Promise<{ clip: string; durationS: number; parts: { at: number; durationS: number }[] }> {
  const pieces = await Promise.all(texts.map((t) => voiceLine(provider, voice, t)));
  const clip = `${createHash('sha1').update(`passage|${pieces.map((p) => p.clip).join('|')}`).digest('hex').slice(0, 20)}.wav`;
  const parts: { at: number; durationS: number }[] = [];
  let at = 0;
  for (const p of pieces) {
    parts.push({ at, durationS: p.durationS });
    at += p.durationS + PART_GAP_S;
  }
  const path = clipPath(clip);
  if (existsSync(path)) {
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return { clip, durationS: wavDuration(await readFile(path)), parts };
  }
  const decoded = await Promise.all(pieces.map(async (p) => decodeWav(await readFile(clipPath(p.clip)))));
  const sr = decoded[0].sampleRate;
  // Each piece starts at its exact sample (rounded the same way as `at`), so the offsets hold.
  const starts = parts.map((p) => Math.round(p.at * sr));
  const total = starts[starts.length - 1] + decoded[decoded.length - 1].samples.length;
  const joined = new Float32Array(total);
  decoded.forEach((d, k) => joined.set(d.samples.subarray(0, Math.min(d.samples.length, (starts[k + 1] ?? total) - starts[k])), starts[k]));
  const wav = encodeWav(joined, sr);
  await mkdir(VOICE_CACHE, { recursive: true });
  await writeFile(path, wav);
  return { clip, durationS: wavDuration(wav), parts };
}

/**
 * Delete cached clips that `keep` doesn't name and that were last voiced or reused before `cutoff`
 * (ms). Renders keep their own copies under voice/, so only recipes still to render need the cache.
 */
export async function pruneVoiceCache(keep: Set<string>, cutoff: number): Promise<{ deleted: number; freedBytes: number }> {
  let deleted = 0;
  let freed = 0;
  const files = await readdir(VOICE_CACHE).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith('.wav') || keep.has(f)) continue;
    const path = clipPath(f);
    const s = await stat(path).catch(() => null);
    if (!s?.isFile() || s.mtimeMs >= cutoff) continue;
    await rm(path, { force: true });
    deleted++;
    freed += s.size;
  }
  return { deleted, freedBytes: freed };
}
