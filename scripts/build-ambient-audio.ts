/**
 * Build the long-form templates' recordings (assets/ambient/audio) from the original Freesound
 * downloads, and record them in assets/ambient/manifest.json. The originals (hundreds of MB) stay out
 * of the repo: download them into data/ambient-sources/ (see SOURCES for the files) and run
 *
 *   npx tsx scripts/build-ambient-audio.ts [sourcesDir]
 *
 * Beds are cut to an exact length that divides every allowed loop (60, 120 or 600 s), their end
 * crossfaded into their start so they loop seamlessly. Thunder recordings are cut into single claps
 * (clip times picked by hand from each recording's loudness envelope), close or far, with faded tails.
 * Everything is high-passed at 25 Hz, levelled (beds' transients limited to CREST_DB above their
 * loudness, so a fire pop never startles), and encoded as 48 kHz stereo Opus.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(process.argv[2] ?? join(ROOT, 'data/ambient-sources'));
const OUT = join(ROOT, 'assets/ambient/audio');
const MANIFEST = join(ROOT, 'assets/ambient/manifest.json');
const SR = 48000;
/** How far a bed's peaks may rise above its loudness (dB): enough for crackle, never a startle. */
const CREST_DB = 15;

/** A hand-picked thunder clip (from the recording's loudness envelope): start and end in seconds. */
interface Clip {
  from: number;
  to: number;
  class: 'close' | 'far';
}

interface Source {
  /** Freesound sound id: the downloaded file's name starts with it. */
  id: number;
  author: string;
  title: string;
  url: string;
  use: string;
  build: { bed: { name: string; lengthS: number; fromS: number; lufs: number } } | { clips: Clip[] };
}

const SOURCES: Source[] = [
  { id: 833924, author: 'bassimat', title: 'Rain on the House Roof Window #001', url: 'https://freesound.org/people/bassimat/sounds/833924/', use: 'Cabin rain bed', build: { bed: { name: 'rain-window', lengthS: 600, fromS: 60, lufs: -23 } } },
  { id: 398626, author: 'bobgon55', title: 'Rainy Night in Summer', url: 'https://freesound.org/people/bobgon55/sounds/398626/', use: 'Cabin rain bed (steady, alternative)', build: { bed: { name: 'rain-steady', lengthS: 600, fromS: 15, lufs: -23 } } },
  { id: 501417, author: 'visionear', title: 'Aachen_Burning Fireplace Crackling Fire Sounds.wav', url: 'https://freesound.org/people/visionear/sounds/501417/', use: 'Cabin fire bed', build: { bed: { name: 'fire-hearth', lengthS: 600, fromS: 45, lufs: -23 } } },
  { id: 185070, author: 'juryduty', title: 'howling_wind.wav', url: 'https://freesound.org/people/juryduty/sounds/185070/', use: 'Cabin wind bed', build: { bed: { name: 'wind-howl', lengthS: 60, fromS: 0, lufs: -26 } } },
  { id: 614461, author: 'secondbody', title: '17. flying spaceship interior (roomtone)', url: 'https://freesound.org/people/secondbody/sounds/614461/', use: 'Spaceship room tone bed', build: { bed: { name: 'ship-roomtone', lengthS: 120, fromS: 3, lufs: -24 } } },
  { id: 534023, author: 'Fission9', title: 'Thunderclap', url: 'https://freesound.org/people/Fission9/sounds/534023/', use: 'Thunder (close)', build: { clips: [{ from: 0.3, to: 13.4, class: 'close' }] } },
  { id: 559804, author: 'Fugeni', title: 'Booming Thunder in Distance', url: 'https://freesound.org/people/Fugeni/sounds/559804/', use: 'Thunder (far)', build: { clips: [{ from: 1, to: 18, class: 'far' }] } },
  { id: 194364, author: 'Dave Welsh', title: 'Thunder Clap OWB KY 441x16.wav', url: 'https://freesound.org/people/Dave%20Welsh/sounds/194364/', use: 'Thunder (close)', build: { clips: [{ from: 13, to: 33, class: 'close' }] } },
  { id: 567746, author: 'TRP', title: '200708 Thunders various, big, med, distant, crack booming, hiss of rain.flac', url: 'https://freesound.org/people/TRP/sounds/567746/', use: 'Thunder (mixed)', build: { clips: [{ from: 2.5, to: 18, class: 'close' }, { from: 27, to: 40, class: 'close' }, { from: 50, to: 60, class: 'far' }, { from: 80, to: 92, class: 'far' }, { from: 132.5, to: 146, class: 'far' }] } },
  { id: 242735, author: 'hifijohn', title: 'thunder', url: 'https://freesound.org/people/hifijohn/sounds/242735/', use: 'Thunder (mixed)', build: { clips: [{ from: 1.5, to: 14, class: 'far' }, { from: 20, to: 30, class: 'close' }, { from: 39.5, to: 56, class: 'close' }] } },
];

function ff(args: string[]) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-1500)}`);
  return r.stderr;
}

/** Decode to 48 kHz stereo float32, high-passed at 25 Hz (rumble and DC). */
function decode(file: string): Float32Array {
  const tmp = join(OUT, '.tmp.f32');
  ff(['-i', file, '-af', 'highpass=f=25', '-ac', '2', '-ar', String(SR), '-f', 'f32le', tmp]);
  const b = readFileSync(tmp);
  rmSync(tmp);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
}

/** Encode float32 stereo to Opus, at a loudness target (or peak-normalised one-shots). */
function encode(samples: Float32Array, out: string, opts: { lufs?: number; peakDb?: number; crestDb?: number; kbps: number }) {
  const tmp = join(OUT, '.tmp.f32');
  writeFileSync(tmp, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  const raw = ['-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', tmp];
  let gainDb = 0;
  if (opts.lufs !== undefined) {
    const err = ff([...raw, '-af', 'ebur128', '-f', 'null', '-']);
    const i = Number(/I:\s+(-?[\d.]+) LUFS/.exec(err.slice(err.lastIndexOf('Summary:')))?.[1]);
    gainDb = opts.lufs - i;
  } else if (opts.peakDb !== undefined) {
    let peak = 0;
    for (const x of samples) peak = Math.max(peak, Math.abs(x));
    gainDb = opts.peakDb - 20 * Math.log10(peak);
  }
  // Beds: shave transients (fire pops, big drops) to at most CREST_DB above the bed's loudness, with a
  // limiter fast enough (0.5 ms in, 15 ms out) to touch only the pop, not the sound around it.
  const ceiling = opts.lufs !== undefined ? Math.pow(10, Math.min(-1, opts.lufs + (opts.crestDb ?? CREST_DB)) / 20).toFixed(4) : null;
  const af = `volume=${gainDb.toFixed(2)}dB${ceiling ? `,alimiter=limit=${ceiling}:attack=0.5:release=15:level=false` : ''}`;
  ff([...raw, '-af', af, '-c:a', 'libopus', '-b:a', `${opts.kbps}k`, '-ar', String(SR), out]);
  rmSync(tmp);
}

/** Exactly `lengthS` from `fromS`, with the following few seconds crossfaded into the start (equal power: uncorrelated noise). */
function loopBed(x: Float32Array, fromS: number, lengthS: number): Float32Array {
  const X = 4 * SR;
  const n = lengthS * SR;
  const a = fromS * SR;
  if ((a + n + X) * 2 > x.length) throw new Error(`recording too short for a ${lengthS}s bed from ${fromS}s`);
  const out = x.slice(a * 2, (a + n) * 2);
  for (let i = 0; i < X; i++) {
    const w = i / X;
    const fin = Math.sin((Math.PI / 2) * w);
    const fout = Math.cos((Math.PI / 2) * w);
    for (let c = 0; c < 2; c++) out[i * 2 + c] = out[i * 2 + c] * fin + x[(a + n + i) * 2 + c] * fout;
  }
  return out;
}

function shape(x: Float32Array, start: number, end: number): Float32Array {
  const out = x.slice(start * 2, end * 2);
  const n = out.length / 2;
  const fin = Math.min(n, SR / 50);
  const fout = Math.min(n, Math.round(1.5 * SR));
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (i < fin) g *= i / fin;
    if (i > n - fout) g *= (n - i) / fout;
    out[i * 2] *= g;
    out[i * 2 + 1] *= g;
  }
  return out;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const files = existsSync(SRC) ? readdirSync(SRC) : [];
  const missing = SOURCES.filter((s) => !files.some((f) => f.startsWith(`${s.id}__`)));
  if (missing.length) console.warn(`Skipping originals not in ${SRC} (download them to include):\n${missing.map((s) => `  ${s.id} ${s.url}`).join('\n')}`);
  for (const f of readdirSync(OUT)) rmSync(join(OUT, f));

  const entries: Record<string, unknown>[] = [];
  const counts = { close: 0, far: 0 };
  for (const s of SOURCES.filter((x) => !missing.includes(x))) {
    const file = join(SRC, files.find((f) => f.startsWith(`${s.id}__`))!);
    const x = decode(file);
    if ('bed' in s.build) {
      const { name, lengthS, fromS, lufs } = s.build.bed;
      const rel = `audio/${name}-${lengthS}.opus`;
      encode(loopBed(x, fromS, lengthS), join(ROOT, 'assets/ambient', rel), { lufs, kbps: 112 });
      entries.push({ id: name, kind: 'sound', use: s.use, files: [rel], durationS: lengthS, derived: `${lengthS} s seamless loop from ${fromS} s, normalised to ${lufs} LUFS`, ...meta(s) });
      console.log(`bed ${rel}`);
    } else {
      for (const clip of s.build.clips) {
        const rel = `audio/thunder-${clip.class}-${++counts[clip.class]}.opus`;
        const [a, b] = [Math.round(clip.from * SR), Math.min(x.length / 2, Math.round(clip.to * SR))];
        // Close claps keep their punch; distant rolls sit lower. The template scales both by strength.
        encode(shape(x, a, b), join(ROOT, 'assets/ambient', rel), { lufs: clip.class === 'close' ? -18 : -23, crestDb: 20, kbps: 128 });
        entries.push({ id: `thunder-${clip.class}-${counts[clip.class]}`, kind: 'sound', use: s.use, files: [rel], durationS: +((b - a) / SR).toFixed(3), derived: `clip ${clip.from}–${clip.to} s of the original, faded`, ...meta(s) });
        console.log(`one-shot ${rel} (${((b - a) / SR).toFixed(1)} s from ${s.author})`);
      }
    }
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  manifest.assets = [...manifest.assets.filter((a: { kind: string }) => a.kind !== 'sound'), ...entries];
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}

const meta = (s: Source) => ({ source: s.url, site: 'Freesound', title: s.title, authors: [s.author], license: 'CC0-1.0' });

main();
