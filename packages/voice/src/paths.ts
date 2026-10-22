import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** Voiced lines, by content hash (see cache.ts). The render harness and the server serve files from here (tests point it elsewhere). */
export const VOICE_CACHE = process.env.SIM_VOICE_CACHE ?? join(ROOT, 'data/voice-cache');
/** Downloaded TTS models. */
export const MODELS_DIR = join(ROOT, 'data/models');
