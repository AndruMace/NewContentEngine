import type { TtsProvider } from './provider';
import { MODELS_DIR } from './paths';

/** Kokoro's American and British voices that sound best (its own grades: A to C+). */
export const KOKORO_VOICES = ['af_heart', 'af_bella', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bm_george'] as const;

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

type KokoroTTS = Awaited<ReturnType<typeof import('kokoro-js').KokoroTTS.from_pretrained>>;
let model: Promise<KokoroTTS> | null = null;

/** One model per process, loaded on first use (downloads about 90 MB to data/models the first time). */
async function load(): Promise<KokoroTTS> {
  model ??= (async () => {
    const [{ KokoroTTS }, { env }] = await Promise.all([import('kokoro-js'), import('@huggingface/transformers')]);
    env.cacheDir = MODELS_DIR;
    return KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'cpu' });
  })();
  return model;
}

/**
 * Load the model and voice one throwaway word (server start, in the background), so the first real
 * voicing doesn't pay for the load or the first inference's setup.
 */
export function warmUp(voice: string = KOKORO_VOICES[0]): Promise<void> {
  return load().then(
    async (tts) => {
      await tts.generate('Ready.', { voice: voice as never, speed: 1 });
    },
    (e) => {
      model = null; // let the next voicing try again
      throw e;
    },
  );
}

/**
 * Kokoro 82M (Apache-2.0): free, local and fine to publish. Runs on the CPU, about as fast as the
 * speech it makes.
 */
export const kokoro: TtsProvider = {
  id: 'kokoro',
  voices: KOKORO_VOICES,
  async synthesize(text, voice) {
    const tts = await load();
    const audio = await tts.generate(text, { voice: voice as never, speed: 1 });
    return { samples: audio.audio as Float32Array, sampleRate: audio.sampling_rate };
  },
};
