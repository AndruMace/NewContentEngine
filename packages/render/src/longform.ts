/**
 * Long-form (ambient) renders: a seamless master loop, rendered in segments in headless Chrome,
 * joined and repeated to the final length (hours) with ffmpeg.
 *
 *   events + seam check → video segments → audio segments → join → master → stills → QC
 *
 * Segments are written as `.part` files and renamed when complete, and the job's settings are
 * saved next to them: rendering again into the same folder resumes after the last finished segment.
 */
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Runner, getTheme, hashString, loopLengthOf, type Recipe } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { getTemplate } from '@sim/templates';
import { RenderHarness, type LongFormInfo, type SeamCheck } from './harness';
import { longFormStills, masterLongForm, qcLongForm, run, type LongFormQcReport } from './ffmpeg';

/** Segment length: bounds memory per page call and how much a crash loses. */
export const SEGMENT_S = 300;
/** Each audio segment renders this much further, crossfaded into the next one where they join. */
const AUDIO_OVERLAP_S = 0.05;
const SAMPLE_RATE = 48000;
/**
 * Most the two sides of an audio join may differ before the crossfade (RMS of difference over RMS).
 * Matching renders measure 0 to 0.03 (noise bursts landing a fraction of a sample apart); a bed out
 * of step measures about 1.
 */
const MAX_JOIN_MISMATCH = 0.15;
/** 1080p30 ambient: YouTube's recommended upload bitrate. */
export const LONG_FORM_BITRATE = 8_000_000;

export type LongFormStage = 'prepare' | 'frames' | 'audio' | 'joining' | 'mastering' | 'qc';

export interface LongFormOutput {
  dir: string;
  final: string;
  thumbnail: string;
  contact: string;
  loopS: number;
  totalS: number;
  qc: LongFormQcReport;
  seam: SeamCheck & { pass: boolean };
  audioSeam: { step: number; percentile: number; pass: boolean };
  /** Per audio join (the last is the loop's own join): how different the two sides were before the crossfade. */
  audioJoins: number[];
  codec: string;
  loopLufs: number;
  gainDb: number;
  resumedSegments: number;
  timings: { framesMs: number; audioMs: number; masterMs: number; totalMs: number };
}

interface Manifest {
  key: string;
  loopS: number;
  segments: { video: string[]; audio: string[] };
  codec?: string;
}

const pad = (i: number) => String(i).padStart(3, '0');
const exists = (p: string) => stat(p).then(() => true, () => false);

/** Bytes needed on disk: the final file plus the loop video, raw loop audio and the final audio. */
function diskEstimate(loopS: number, totalS: number) {
  const videoPerS = LONG_FORM_BITRATE / 8;
  return totalS * (videoPerS + 33_000) + loopS * (videoPerS + 384_000 * 2);
}

/**
 * Join raw audio segments into the loop. Each segment carries AUDIO_OVERLAP_S of the next one's start,
 * which is crossfaded into it (linearly: the two are nearly identical); the last segment's overlap is
 * the loop's start again and is crossfaded into the first segment, closing the loop.
 */
async function joinAudio(segments: string[], out: string): Promise<number[]> {
  const overlap = Math.round(AUDIO_OVERLAP_S * SAMPLE_RATE) * 2;
  // How much the two sides of each join differ before blending (RMS of the difference over RMS of the
  // signal): near 0 normally, near 1 or more if a segment is missing sounds the other has.
  const mismatch: number[] = [];
  const blend = (into: Float32Array, tail: Float32Array) => {
    let d = 0;
    let e = 0;
    for (let i = 0; i < overlap; i++) {
      d += (into[i] - tail[i]) ** 2;
      e += into[i] ** 2;
    }
    mismatch.push(Math.sqrt(d / Math.max(e, 1e-12)));
    for (let i = 0; i < overlap; i++) {
      const w = Math.floor(i / 2) / (overlap / 2);
      into[i] = tail[i] * (1 - w) + into[i] * w;
    }
  };
  await rm(out, { force: true });
  let tail: Float32Array | null = null;
  for (const f of segments) {
    const b = await readFile(f);
    const seg = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    if (tail) blend(seg, tail);
    tail = seg.slice(seg.length - overlap);
    await appendFile(out, Buffer.from(seg.buffer, seg.byteOffset, (seg.length - overlap) * 4));
  }
  if (!tail) return mismatch;
  const fh = await open(out, 'r+');
  try {
    const head = Buffer.alloc(overlap * 4);
    await fh.read(head, 0, head.length, 0);
    const h = new Float32Array(head.buffer, head.byteOffset, overlap);
    blend(h, tail);
    await fh.write(head, 0, head.length, 0);
  } finally {
    await fh.close();
  }
  return mismatch;
}

/**
 * Is the loop's last sample → first sample step like any other? Compares it with every step in the
 * loop's first and last 10 seconds (reading only those, the raw loop can be over a gigabyte).
 */
async function audioSeamCheck(raw: string) {
  const fh = await open(raw, 'r');
  try {
    const size = (await fh.stat()).size;
    const window = Math.min(size / 2, 10 * 48000 * 8);
    const read = async (pos: number) => {
      const b = Buffer.alloc(window);
      await fh.read(b, 0, window, pos);
      return new Float32Array(b.buffer, b.byteOffset, window / 4);
    };
    const head = await read(0);
    const tail = await read(size - window);
    const steps: number[] = [];
    for (const w of [head, tail]) for (let i = 2; i < w.length; i++) steps.push(Math.abs(w[i] - w[i - 2]));
    const step = Math.max(Math.abs(head[0] - tail[tail.length - 2]), Math.abs(head[1] - tail[tail.length - 1]));
    const percentile = (100 * steps.filter((x) => x < step).length) / steps.length;
    return { step, percentile, pass: percentile <= 99.9 };
  } finally {
    await fh.close();
  }
}

export async function renderLongForm(
  recipe: Recipe,
  opts: {
    outDir: string;
    harness?: RenderHarness;
    /** Allow loops shorter than the template's minimum (quick test renders). */
    allowShortLoop?: boolean;
    onStage?: (stage: LongFormStage) => void;
    onProgress?: (stage: LongFormStage, done: number, total: number) => void;
    keepIntermediates?: boolean;
  },
): Promise<LongFormOutput> {
  const t0 = performance.now();
  const template = getTemplate(recipe.templateId);
  if (!template.longForm) throw new Error(`${template.id} is not a long-form template`);
  const loopS = loopLengthOf(template, recipe.loopS, opts.allowShortLoop);
  const totalS = recipe.totalS ?? loopS;
  if (totalS < loopS) throw new Error(`Final length (${totalS}s) is shorter than the loop (${loopS}s)`);
  const dir = opts.outDir;
  await mkdir(dir, { recursive: true });
  const fixed: Recipe = { ...recipe, loopS, totalS };
  await writeFile(join(dir, 'recipe.json'), JSON.stringify(fixed, null, 2));

  const free = await statfs(dir).then((s) => s.bavail * s.bsize, () => Infinity);
  const need = diskEstimate(loopS, totalS);
  if (free < need) throw new Error(`Not enough disk space: about ${(need / 1e9).toFixed(1)} GB needed, ${(free / 1e9).toFixed(1)} GB free`);

  // Resume only segments of exactly this loop (the final length doesn't change them).
  const key = hashString(JSON.stringify({ ...fixed, totalS: undefined, copy: undefined }));
  const manifestPath = join(dir, 'longform.json');
  const old: Manifest | null = await readFile(manifestPath, 'utf8').then((s) => JSON.parse(s) as Manifest, () => null);
  const manifest: Manifest = old?.key === key ? old : { key, loopS, segments: { video: [], audio: [] } };
  if (old && old.key !== key) for (const f of [...old.segments.video, ...old.segments.audio]) await rm(join(dir, f), { force: true });
  const saveManifest = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const resumable = async (list: string[]) => (await Promise.all(list.map((f) => exists(join(dir, f))))).filter(Boolean).length;
  const resumedSegments = (await resumable(manifest.segments.video)) + (await resumable(manifest.segments.audio));

  const harness = opts.harness ?? new RenderHarness();
  if (!opts.harness) await harness.start();
  let info: LongFormInfo;
  let seam: SeamCheck;
  let framesMs = 0;
  let audioMs = 0;
  const job = { recipe: fixed, loopS };
  try {
    const page = await harness.openPage(dir, { onProgress: (f, est) => opts.onProgress?.('frames', f, est) });
    try {
      opts.onStage?.('prepare');
      info = await page.call<LongFormInfo>('longFormPrepare', job);
      seam = await page.call<SeamCheck>('longFormSeamCheck', job);
      const nSeg = Math.ceil(loopS / SEGMENT_S);

      opts.onStage?.('frames');
      const tf = performance.now();
      for (let i = 0; i < nSeg; i++) {
        const name = `seg-${pad(i)}.mp4`;
        if (manifest.segments.video.includes(name) && (await exists(join(dir, name)))) continue;
        const f0 = Math.round(i * SEGMENT_S * info.fps);
        const f1 = Math.min(info.frames, Math.round((i + 1) * SEGMENT_S * info.fps));
        const r = await page.call<{ codec: string }>('longFormVideoSegment', job, { name: `${name}.part`, f0, f1, bitrate: LONG_FORM_BITRATE });
        await rename(join(dir, `${name}.part`), join(dir, name));
        manifest.codec = r.codec;
        manifest.segments.video.push(name);
        await saveManifest();
        opts.onProgress?.('frames', f1, info.frames);
      }
      framesMs = performance.now() - tf;

      opts.onStage?.('audio');
      const ta = performance.now();
      for (let i = 0; i < nSeg; i++) {
        const name = `aseg-${pad(i)}.f32`;
        if (manifest.segments.audio.includes(name) && (await exists(join(dir, name)))) continue;
        const to = Math.min(loopS, (i + 1) * SEGMENT_S);
        await page.call('longFormAudioSegment', job, { name: `${name}.part`, from: i * SEGMENT_S, to, overlap: AUDIO_OVERLAP_S });
        await rename(join(dir, `${name}.part`), join(dir, name));
        manifest.segments.audio.push(name);
        await saveManifest();
        opts.onProgress?.('audio', to, loopS);
      }
      audioMs = performance.now() - ta;
    } finally {
      await page.close();
    }
  } finally {
    if (!opts.harness) await harness.stop();
  }

  // The browser must have produced exactly the cue schedule Node does (same check as Shorts renders).
  const node = new Runner(template, {
    seed: fixed.seed,
    params: fixed.params,
    theme: getTheme(fixed.themeId),
    melody: getMelody(fixed.melodyId),
    visual: false,
    loopS,
  }).runToEnd();
  const browserEvents = JSON.parse(await readFile(join(dir, 'events.json'), 'utf8')).events;
  const diverged = hashString(JSON.stringify(node.events)) !== hashString(JSON.stringify(browserEvents));

  const tm = performance.now();
  opts.onStage?.('joining');
  const video = manifest.segments.video.sort();
  const audio = manifest.segments.audio.sort();
  await writeFile(join(dir, 'segments.txt'), video.map((f) => `file '${f}'`).join('\n'));
  const concat = await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'segments.txt'), '-c', 'copy', join(dir, 'loop.mp4')]);
  if (concat.code !== 0) throw new Error(`ffmpeg concat failed: ${concat.stderr.slice(-1500)}`);
  const rawLoop = join(dir, 'loop.f32');
  await rm(rawLoop, { force: true });
  const audioJoins = await joinAudio(audio.map((f) => join(dir, f)), rawLoop);

  opts.onStage?.('mastering');
  const mastered = await masterLongForm(dir, { loopS, totalS });
  await longFormStills(dir, { loopS, thumbnailAtS: info.thumbnailAtS });

  opts.onStage?.('qc');
  const qc = await qcLongForm(mastered.final, { loopS, totalS, width: info.width, height: info.height, fps: info.fps });
  if (diverged) {
    qc.problems.push('browser sim diverged from Node sim (the cue schedule differs)');
    qc.pass = false;
  }
  const audioSeam = await audioSeamCheck(rawLoop);
  if (!audioSeam.pass) {
    qc.problems.push(`audio jumps at the loop join (step at the ${audioSeam.percentile.toFixed(1)}th percentile of ordinary steps)`);
    qc.pass = false;
  }
  // The stricter check: the audio just past the loop's end (rendered on, as the loop's start again)
  // must match the loop's actual start. A single sample step can look ordinary while the content
  // jumps (e.g. a bed whose length doesn't divide the loop).
  const loopJoin = audioJoins[audioJoins.length - 1] ?? 0;
  if (loopJoin > MAX_JOIN_MISMATCH) {
    qc.problems.push(`audio at the loop join doesn't match its start (mismatch ${loopJoin.toFixed(2)}; does every bed's length divide the loop?)`);
    qc.pass = false;
  }
  // The join should be no bigger a change than one ordinary frame step there.
  const seamPass = seam.seamStep <= seam.referenceStep * 1.5 + 0.5 && seam.wrapDiff <= 3;
  if (!seamPass) {
    qc.problems.push(`loop join jumps (step ${seam.seamStep.toFixed(2)} vs ${seam.referenceStep.toFixed(2)}, wrap ${seam.wrapDiff.toFixed(2)})`);
    qc.pass = false;
  }
  const masterMs = performance.now() - tm;

  if (!opts.keepIntermediates) {
    const leftovers = [...video, ...audio, 'segments.txt', 'loop.f32', 'audio.m4a', 'longform.json'];
    await Promise.all(leftovers.map((f) => rm(join(dir, f), { force: true })));
    for (const f of await readdir(dir)) if (f.endsWith('.part')) await rm(join(dir, f), { force: true });
  }

  const out: LongFormOutput = {
    dir,
    final: mastered.final,
    thumbnail: join(dir, 'thumbnail.jpg'),
    contact: join(dir, 'contact.jpg'),
    loopS,
    totalS,
    qc,
    seam: { ...seam, pass: seamPass },
    audioSeam,
    audioJoins,
    codec: manifest.codec ?? 'unknown',
    loopLufs: mastered.loopLufs,
    gainDb: mastered.gainDb,
    resumedSegments,
    timings: { framesMs, audioMs, masterMs, totalMs: performance.now() - t0 },
  };
  await writeFile(join(dir, 'result.json'), JSON.stringify({ ...out, score: info.score }, null, 2));
  return out;
}

/** Draw single frames of a long-form recipe to PNGs (still-<t>.png in outDir), without rendering the loop. */
export async function renderLongFormStills(recipe: Recipe, times: number[], opts: { outDir: string; allowShortLoop?: boolean }) {
  const template = getTemplate(recipe.templateId);
  if (!template.longForm) throw new Error(`${template.id} is not a long-form template`);
  const loopS = loopLengthOf(template, recipe.loopS, opts.allowShortLoop);
  const harness = new RenderHarness();
  await harness.start();
  const files: string[] = [];
  try {
    const page = await harness.openPage(opts.outDir);
    try {
      for (const t of [...times].sort((a, b) => a - b)) {
        const name = `still-${t.toFixed(2)}.png`;
        await page.call('longFormStill', { recipe: { ...recipe, loopS }, loopS }, { name, t });
        files.push(join(opts.outDir, name));
      }
    } finally {
      await page.close();
    }
  } finally {
    await harness.stop();
  }
  return files;
}
