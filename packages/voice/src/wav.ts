/** Mono float samples → 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Length in seconds of a WAV written by encodeWav. */
export function wavDuration(wav: Buffer): number {
  return wav.readUInt32LE(40) / 2 / wav.readUInt32LE(24);
}

/**
 * Cut the silence a TTS model leaves before and after a line (keeping a short pad), so the measured
 * length is the speech itself and beats can be timed to it.
 */
export function trimSilence(samples: Float32Array, sampleRate: number, threshold = 0.012, padS = 0.04): Float32Array {
  let a = 0;
  let b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < threshold) a++;
  while (b > a && Math.abs(samples[b]) < threshold) b--;
  const pad = Math.round(padS * sampleRate);
  return samples.slice(Math.max(0, a - pad), Math.min(samples.length, b + 1 + pad));
}
