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

/**
 * A hand-picked one-shot (from the recording's loudness envelope): start and end in seconds, and the
 * name it is numbered under (thunder-close-1, rail-click-3…).
 */
interface Clip {
  from: number;
  to: number;
  name: string;
  /** Loudness target (LUFS), or a peak target (dBFS) for clips too short to measure (clicks). */
  lufs?: number;
  peakDb?: number;
  crestDb?: number;
  /** ffmpeg filter applied first (e.g. a lowpass: a horn heard from inside the train). */
  filter?: string;
  fadeInS?: number;
  fadeOutS?: number;
  /**
   * Make it pass by (a level-crossing bell going past the window): loudest at `atS` into the clip,
   * fading with distance over about `widthS`, its pitch falling `semis` semitones as it goes past.
   */
  pass?: { atS: number; widthS: number; semis: number };
}

interface Bed {
  name: string;
  lengthS: number;
  fromS: number;
  lufs: number;
  /** ffmpeg filter applied to the stretch before levelling (length-preserving: EQ, not delays). */
  filter?: string;
  /** Right channel cut from here instead (widens a mono recording; both halves loop). */
  rightFromS?: number;
  /** Transient ceiling above the loudness (dB; default CREST_DB): lower is smoother. */
  crestDb?: number;
}

interface Source {
  /** Freesound sound id: the downloaded file's name starts with it. */
  id: number;
  author: string;
  title: string;
  url: string;
  use: string;
  build: { bed: Bed } | { clips: Clip[] };
}

const SOURCES: Source[] = [
  { id: 833924, author: 'bassimat', title: 'Rain on the House Roof Window #001', url: 'https://freesound.org/people/bassimat/sounds/833924/', use: 'Cabin rain bed', build: { bed: { name: 'rain-window', lengthS: 600, fromS: 60, lufs: -23 } } },
  { id: 398626, author: 'bobgon55', title: 'Rainy Night in Summer', url: 'https://freesound.org/people/bobgon55/sounds/398626/', use: 'Cabin rain bed (steady, alternative)', build: { bed: { name: 'rain-steady', lengthS: 600, fromS: 15, lufs: -23 } } },
  { id: 501417, author: 'visionear', title: 'Aachen_Burning Fireplace Crackling Fire Sounds.wav', url: 'https://freesound.org/people/visionear/sounds/501417/', use: 'Cabin fire bed', build: { bed: { name: 'fire-hearth', lengthS: 600, fromS: 45, lufs: -23 } } },
  { id: 185070, author: 'juryduty', title: 'howling_wind.wav', url: 'https://freesound.org/people/juryduty/sounds/185070/', use: 'Cabin wind bed', build: { bed: { name: 'wind-howl', lengthS: 60, fromS: 0, lufs: -26 } } },
  { id: 614461, author: 'secondbody', title: '17. flying spaceship interior (roomtone)', url: 'https://freesound.org/people/secondbody/sounds/614461/', use: 'Spaceship room tone bed', build: { bed: { name: 'ship-roomtone', lengthS: 120, fromS: 3, lufs: -24 } } },
  { id: 534023, author: 'Fission9', title: 'Thunderclap', url: 'https://freesound.org/people/Fission9/sounds/534023/', use: 'Thunder (close)', build: { clips: [{ from: 0.3, to: 13.4, name: 'thunder-close', lufs: -18, crestDb: 20 }] } },
  { id: 559804, author: 'Fugeni', title: 'Booming Thunder in Distance', url: 'https://freesound.org/people/Fugeni/sounds/559804/', use: 'Thunder (far)', build: { clips: [{ from: 1, to: 18, name: 'thunder-far', lufs: -23, crestDb: 20 }] } },
  { id: 194364, author: 'Dave Welsh', title: 'Thunder Clap OWB KY 441x16.wav', url: 'https://freesound.org/people/Dave%20Welsh/sounds/194364/', use: 'Thunder (close)', build: { clips: [{ from: 13, to: 33, name: 'thunder-close', lufs: -18, crestDb: 20 }] } },
  { id: 567746, author: 'TRP', title: '200708 Thunders various, big, med, distant, crack booming, hiss of rain.flac', url: 'https://freesound.org/people/TRP/sounds/567746/', use: 'Thunder (mixed)', build: { clips: [{ from: 2.5, to: 18, name: 'thunder-close', lufs: -18, crestDb: 20 }, { from: 27, to: 40, name: 'thunder-close', lufs: -18, crestDb: 20 }, { from: 50, to: 60, name: 'thunder-far', lufs: -23, crestDb: 20 }, { from: 80, to: 92, name: 'thunder-far', lufs: -23, crestDb: 20 }, { from: 132.5, to: 146, name: 'thunder-far', lufs: -23, crestDb: 20 }] } },
  { id: 242735, author: 'hifijohn', title: 'thunder', url: 'https://freesound.org/people/hifijohn/sounds/242735/', use: 'Thunder (mixed)', build: { clips: [{ from: 1.5, to: 14, name: 'thunder-far', lufs: -23, crestDb: 20 }, { from: 20, to: 30, name: 'thunder-close', lufs: -18, crestDb: 20 }, { from: 39.5, to: 56, name: 'thunder-close', lufs: -18, crestDb: 20 }] } },

  // ---- Night Train ----
  // The compartment: a sleeper on an overnight train, its rattles smoothed (a soft top, transients
  // held close to the rumble) so it lulls rather than clatters.
  { id: 788565, author: 'HT4891', title: 'Night Train', url: 'https://freesound.org/people/HT4891/sounds/788565/', use: 'Night Train compartment bed, tunnel and bridge sounds', build: { bed: { name: 'train-compartment', lengthS: 600, fromS: 228, lufs: -23, filter: 'highshelf=f=2200:g=-9,lowpass=f=5500,lowpass=f=5500', crestDb: 9 } } },
  // Tunnels and bridges, from the same recording (a part the bed doesn't use): boomier and louder in
  // a tunnel (30, 45 and 60 s, the tunnel lengths), hollow and ringing on a bridge.
  {
    id: 788565, author: 'HT4891', title: 'Night Train', url: 'https://freesound.org/people/HT4891/sounds/788565/', use: 'Night Train tunnels and bridges (processed)',
    build: {
      clips: [
        ...[[10, 40], [50, 95], [100, 160]].map(([from, to]) => ({ from, to, name: 'train-tunnel', lufs: -20, filter: 'bass=g=7:f=140,aecho=0.8:0.7:45|80:0.35|0.25', fadeInS: 1.2, fadeOutS: 3 })),
        ...[[160, 172], [180, 192]].map(([from, to]) => ({ from, to, name: 'train-bridge', lufs: -24, filter: 'highpass=f=160,equalizer=f=850:t=q:w=1.2:g=6,aecho=0.6:0.6:9|17|23:0.5|0.4|0.3', fadeInS: 1, fadeOutS: 2.5 })),
      ],
    },
  },
  // Wheel clicks: the strongest single transients of two train interiors (from an onset scan).
  {
    id: 76078, author: 'ceejay', title: 'Passenger Train on the run', url: 'https://freesound.org/people/ceejay/sounds/76078/', use: 'Night Train wheel clicks',
    build: { clips: [1.6, 32.67, 78.21, 11.1, 33.925, 53.57].map((t) => ({ from: t - 0.015, to: t + 0.35, name: 'rail-click', peakDb: -3, filter: 'lowpass=f=2400,lowpass=f=2400', fadeInS: 0.01, fadeOutS: 0.15 })) },
  },
  {
    id: 616533, author: 'TRP', title: '120618 Train, interior, moving clacks rumbles, NYC.mp3', url: 'https://freesound.org/people/TRP/sounds/616533/', use: 'Night Train wheel clicks',
    build: { clips: [237.9, 420.245, 182.95, 410.17, 201.605, 270.57].map((t) => ({ from: t - 0.015, to: t + 0.35, name: 'rail-click', peakDb: -3, filter: 'lowpass=f=2400,lowpass=f=2400', fadeInS: 0.01, fadeOutS: 0.15 })) },
  },
  // Level-crossing bells, made to pass the window (louder, then falling in pitch and fading).
  { id: 457125, author: 'mycompasstv', title: 'Railway Crossing Warning Bell / Signal', url: 'https://freesound.org/people/mycompasstv/sounds/457125/', use: 'Night Train level crossing (passing)', build: { clips: [{ from: 1, to: 17, name: 'crossing-bell', lufs: -27, pass: { atS: 7, widthS: 2.2, semis: 1.2 }, fadeInS: 0.5, fadeOutS: 2 }] } },
  { id: 370824, author: 'mpaol2023', title: 'Railway/Level Crossing Sond Effect', url: 'https://freesound.org/people/mpaol2023/sounds/370824/', use: 'Night Train level crossing (passing)', build: { clips: [{ from: 0.5, to: 16.5, name: 'crossing-bell', lufs: -27, pass: { atS: 7, widthS: 2.2, semis: 1.2 }, fadeInS: 0.5, fadeOutS: 2 }] } },
  // The locomotive's horn, far ahead, heard from inside (lowpassed; that also removes the crickets).
  { id: 667705, author: 'felix.blume', title: 'Train passing at 200 meters with loud horn, rail vibration, crickets and road hum, recorded at night in Pampa, Texas', url: 'https://freesound.org/people/felix.blume/sounds/667705/', use: 'Night Train distant horn', build: { clips: [{ from: 129.3, to: 150.5, name: 'train-horn', lufs: -27, filter: 'lowpass=f=1400,lowpass=f=1400', fadeInS: 0.3, fadeOutS: 2.5 }] } },
  { id: 254270, author: 'PhilllChabbb', title: 'Midnight train horn, with a dose of crickets.', url: 'https://freesound.org/people/PhilllChabbb/sounds/254270/', use: 'Night Train distant horn', build: { clips: [{ from: 3.5, to: 16, name: 'train-horn', lufs: -27, filter: 'lowpass=f=1400,lowpass=f=1400', fadeInS: 0.3, fadeOutS: 2.5 }, { from: 19.5, to: 30, name: 'train-horn', lufs: -27, filter: 'lowpass=f=1400,lowpass=f=1400', fadeInS: 0.3, fadeOutS: 2.5 }] } },

  // ---- Deep Sea Observatory ----
  { id: 393819, author: 'Kinoton', title: 'Underwater Ambience', url: 'https://freesound.org/people/Kinoton/sounds/393819/', use: 'Deep Sea water bed', build: { bed: { name: 'deep-water', lengthS: 300, fromS: 3, lufs: -24 } } },
  { id: 465472, author: 'blaukreuz', title: 'Submarine internal', url: 'https://freesound.org/people/blaukreuz/sounds/465472/', use: 'Deep Sea station hum (5.1 mixed to stereo)', build: { bed: { name: 'station-hum', lengthS: 200, fromS: 15, lufs: -26 } } },
  // Pistol shrimp crackle for the reef; a mono hydrophone, widened by taking the right channel from later on.
  { id: 630436, author: 'KaleidacousticsAudio', title: 'Underwater crackling sounds_Hydrophone.wav', url: 'https://freesound.org/people/KaleidacousticsAudio/sounds/630436/', use: 'Deep Sea reef bed (snapping shrimp)', build: { bed: { name: 'reef-shrimp', lengthS: 600, fromS: 15, rightFromS: 205, lufs: -25 } } },
  { id: 514306, author: 'Lewooz', title: 'Sub Sul FONDO.mp3', url: 'https://freesound.org/people/Lewooz/sounds/514306/', use: 'Deep Sea hull groan', build: { clips: [{ from: 2.5, to: 9.5, name: 'hull-creak', lufs: -25, crestDb: 18, fadeOutS: 1.5 }] } },
  {
    id: 59160, author: 'f_ilippo', title: 'grincements_helvetia.aif', url: 'https://freesound.org/people/f_ilippo/sounds/59160/', use: 'Deep Sea hull creaks',
    build: { clips: [[1.5, 6], [8.5, 11.5], [12.5, 15], [26.5, 29], [41.5, 44.5], [49.5, 52.5], [63.5, 66.5], [76.5, 79.5]].map(([from, to]) => ({ from, to, name: 'hull-creak', lufs: -26, crestDb: 18, filter: 'lowpass=f=5000', fadeOutS: 0.8 })) },
  },
  {
    id: 17341, author: 'Halion', title: 'Water.wav', url: 'https://freesound.org/people/Halion/sounds/17341/', use: 'Deep Sea bubble bursts',
    build: { clips: [[55.5, 62.5], [65, 71.5], [86.5, 93.5], [124.8, 128.8], [130, 138], [139.8, 146]].map(([from, to]) => ({ from, to, name: 'bubbles', lufs: -26, fadeInS: 0.05, fadeOutS: 1 })) },
  },
  {
    id: 82325, author: 'KEVOY', title: 'Diving with whales.wav', url: 'https://freesound.org/people/KEVOY/sounds/82325/', use: 'Deep Sea whale song (humpback phrases)',
    build: { clips: [[1, 12], [12, 24], [24, 35.8], [36, 47], [47, 57.5]].map(([from, to]) => ({ from, to, name: 'whale', lufs: -25, fadeInS: 0.4, fadeOutS: 1.5 })) },
  },
  { id: 12677, author: 'Peter_Gross', title: 'Sonar_pings.ogg', url: 'https://freesound.org/people/Peter_Gross/sounds/12677/', use: 'Deep Sea sonar ping', build: { clips: [{ from: 0, to: 1.45, name: 'sonar', lufs: -28, fadeOutS: 0.2 }, { from: 1.45, to: 3.66, name: 'sonar', lufs: -28, fadeOutS: 0.4 }] } },
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

function writeRaw(samples: Float32Array) {
  const tmp = join(OUT, '.tmp.f32');
  writeFileSync(tmp, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  return { tmp, args: ['-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', tmp] };
}

/**
 * Level float32 stereo: gain to a loudness target (or a peak), and for beds a fast transient limiter.
 * Returns the processed samples, sample-aligned with the input: the limiter's lookahead delay is
 * compensated (latency=1). Without that it shifted a bed by its lookahead, so a bed made seamless
 * before limiting no longer joined end to start.
 */
function level(samples: Float32Array, opts: { lufs?: number; peakDb?: number; crestDb?: number }): Float32Array {
  const { tmp, args } = writeRaw(samples);
  let gainDb = 0;
  if (opts.lufs !== undefined) {
    const err = ff([...args, '-af', 'ebur128', '-f', 'null', '-']);
    const i = Number(/I:\s+(-?[\d.]+) LUFS/.exec(err.slice(err.lastIndexOf('Summary:')))?.[1]);
    gainDb = opts.lufs - i;
  } else if (opts.peakDb !== undefined) {
    let peak = 0;
    for (const x of samples) peak = Math.max(peak, Math.abs(x));
    gainDb = opts.peakDb - 20 * Math.log10(peak);
  }
  // Shave transients (fire pops, big drops) to at most CREST_DB above the loudness, with a limiter fast
  // enough (0.5 ms in, 15 ms out) to touch only the pop, not the sound around it.
  const ceiling = opts.lufs !== undefined ? Math.pow(10, Math.min(-1, opts.lufs + (opts.crestDb ?? CREST_DB)) / 20).toFixed(4) : null;
  const af = `volume=${gainDb.toFixed(2)}dB${ceiling ? `,alimiter=limit=${ceiling}:attack=0.5:release=15:level=false:latency=1` : ''}`;
  const out = join(OUT, '.tmp-out.f32');
  ff([...args, '-af', af, '-f', 'f32le', '-ar', String(SR), '-ac', '2', out]);
  const b = readFileSync(out);
  rmSync(tmp);
  rmSync(out);
  const y = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
  if (y.length !== samples.length) throw new Error(`levelling changed the length: ${samples.length} → ${y.length} samples`);
  return y;
}

/** Encode float32 stereo to Opus as it is (no filters, so a seamless loop stays seamless). */
function toOpus(samples: Float32Array, out: string, kbps: number) {
  const { tmp, args } = writeRaw(samples);
  ff([...args, '-c:a', 'libopus', '-b:a', `${kbps}k`, '-ar', String(SR), out]);
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

function shape(x: Float32Array, start: number, end: number, fadeInS = 0.02, fadeOutS = 1.5): Float32Array {
  const out = x.slice(start * 2, end * 2);
  const n = out.length / 2;
  const fin = Math.min(n, Math.round(fadeInS * SR));
  const fout = Math.min(n, Math.round(fadeOutS * SR));
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (i < fin) g *= i / fin;
    if (i > n - fout) g *= (n - i) / fout;
    out[i * 2] *= g;
    out[i * 2 + 1] *= g;
  }
  return out;
}

/** Run float32 stereo through an ffmpeg filter that keeps its length (EQ, lowpass, echo). */
function filtered(samples: Float32Array, filter: string): Float32Array {
  const { tmp, args } = writeRaw(samples);
  const out = join(OUT, '.tmp-out.f32');
  ff([...args, '-af', filter, '-f', 'f32le', '-ar', String(SR), '-ac', '2', out]);
  const b = readFileSync(out);
  rmSync(tmp);
  rmSync(out);
  const y = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice(0, samples.length);
  if (y.length !== samples.length) throw new Error(`filter shortened the sound: ${samples.length} → ${y.length} samples`);
  return y;
}

/**
 * A sound passing by: the gain follows distance (1 / (1 + (d / width)²)), the pitch slides down by
 * `semis` across the pass (a smooth Doppler-like fall), read with linear interpolation.
 */
function passBy(x: Float32Array, { atS, widthS, semis }: { atS: number; widthS: number; semis: number }): Float32Array {
  const n = x.length / 2;
  const out = new Float32Array(x.length);
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const u = (t - atS) / widthS;
    const rate = Math.pow(2, (-semis / 2) * Math.tanh(u * 1.5) / 12);
    const g = 1 / (1 + u * u);
    const k = Math.floor(pos);
    const f = pos - k;
    if (k + 1 >= n) break;
    for (let c = 0; c < 2; c++) out[i * 2 + c] = g * (x[k * 2 + c] * (1 - f) + x[(k + 1) * 2 + c] * f);
    pos += rate;
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
  const counts: Record<string, number> = {};
  for (const s of SOURCES.filter((x) => !missing.includes(x))) {
    const file = join(SRC, files.find((f) => f.startsWith(`${s.id}__`))!);
    const x = decode(file);
    if ('bed' in s.build) {
      const { name, lengthS, fromS, lufs, filter, rightFromS, crestDb } = s.build.bed;
      const rel = `audio/${name}-${lengthS}.opus`;
      // Level the stretch the bed is cut from (plus its crossfade tail), then make the loop: the loop
      // is the last step, so nothing afterwards can shift it.
      const cut = (from: number) => x.slice(from * SR * 2, Math.min(x.length, (from + lengthS + 4) * SR * 2));
      let region = cut(fromS);
      if (rightFromS !== undefined) {
        const right = cut(rightFromS);
        if (right.length !== region.length) throw new Error(`${name}: recording too short for its right channel from ${rightFromS} s`);
        for (let i = 1; i < region.length; i += 2) region[i] = right[i];
      }
      if (filter) region = filtered(region, filter);
      toOpus(loopBed(level(region, { lufs, crestDb }), 0, lengthS), join(ROOT, 'assets/ambient', rel), 112);
      const how = [filter && `filtered (${filter})`, rightFromS !== undefined && `right channel from ${rightFromS} s`].filter(Boolean).join(', ');
      entries.push({ id: name, kind: 'sound', use: s.use, files: [rel], durationS: lengthS, derived: `${lengthS} s seamless loop from ${fromS} s${how ? `, ${how}` : ''}, normalised to ${lufs} LUFS`, ...meta(s) });
      console.log(`bed ${rel}`);
    } else {
      for (const clip of s.build.clips) {
        const id = `${clip.name}-${(counts[clip.name] = (counts[clip.name] ?? 0) + 1)}`;
        const rel = `audio/${id}.opus`;
        const [a, b] = [Math.round(clip.from * SR), Math.min(x.length / 2, Math.round(clip.to * SR))];
        // Filter and pass-by work on the raw cut; the fades come after them, then the level.
        let y = x.slice(a * 2, b * 2);
        if (clip.filter) y = filtered(y, clip.filter);
        if (clip.pass) y = passBy(y, clip.pass);
        y = shape(y, 0, b - a, clip.fadeInS, clip.fadeOutS);
        toOpus(level(y, { lufs: clip.lufs, peakDb: clip.peakDb, crestDb: clip.crestDb }), join(ROOT, 'assets/ambient', rel), 128);
        const how = [clip.filter && `filtered (${clip.filter})`, clip.pass && `made to pass by`].filter(Boolean).join(', ');
        entries.push({ id, kind: 'sound', use: s.use, files: [rel], durationS: +((b - a) / SR).toFixed(3), derived: `clip ${clip.from}–${clip.to} s of the original${how ? `, ${how}` : ''}, faded`, ...meta(s) });
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
