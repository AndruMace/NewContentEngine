/** Raw speech from a provider (mono). */
export interface Speech {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * A text-to-speech service. Everything else (writing, caching, timing, mixing) is shared, so adding a
 * provider (ElevenLabs, OpenAI…) is one implementation of this.
 */
export interface TtsProvider {
  id: string;
  /** Voice ids this provider accepts. */
  voices: readonly string[];
  synthesize(text: string, voice: string): Promise<Speech>;
}
