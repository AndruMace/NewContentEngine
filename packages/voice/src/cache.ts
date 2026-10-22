import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TtsProvider } from './provider';
import { VOICE_CACHE } from './paths';
import { encodeWav, trimSilence, wavDuration } from './wav';

/** Cache file name for a line: the same text in the same voice is only ever voiced once. */
export const clipName = (provider: string, voice: string, text: string) =>
  `${createHash('sha1').update(`${provider}|${voice}|1|${text}`).digest('hex').slice(0, 20)}.wav`;

export const clipPath = (clip: string) => join(VOICE_CACHE, clip);

export const hasClip = (clip: string) => existsSync(clipPath(clip));

/** Voice a line (or reuse the cached clip): returns the clip's name and its length in seconds. */
export async function voiceLine(provider: TtsProvider, voice: string, text: string): Promise<{ clip: string; durationS: number }> {
  const clip = clipName(provider.id, voice, text);
  const path = clipPath(clip);
  if (existsSync(path)) return { clip, durationS: wavDuration(await readFile(path)) };
  const speech = await provider.synthesize(text, voice);
  const wav = encodeWav(trimSilence(speech.samples, speech.sampleRate), speech.sampleRate);
  await mkdir(VOICE_CACHE, { recursive: true });
  await writeFile(path, wav);
  return { clip, durationS: wavDuration(wav) };
}
