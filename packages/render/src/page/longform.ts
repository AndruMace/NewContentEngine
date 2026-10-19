/**
 * Long-form (ambient) rendering inside headless Chrome. The master loop is rendered in segments the
 * harness asks for one at a time, so nothing hours-long is ever held in memory: video streams out
 * as fragmented MP4 while it encodes, audio comes back as raw float32 per segment.
 *
 * Every frame of a long-form template depends only on t, so a segment just fast-forwards the
 * (trivial) sim to its first frame and starts drawing there.
 */
import { CanvasSource, Mp4OutputFormat, Output, StreamTarget, getFirstEncodableVideoCodec, type StreamTargetChunk } from 'mediabunny';
import { Runner, getTheme, loopLengthOf, type Recipe } from '@sim/engine';
import { getMelody, renderAudioRange } from '@sim/audio';
import { getTemplate, loadedSounds, setAssetBase } from '@sim/templates';
import { upload } from './upload';

setAssetBase('assets/');

/** Load the template's files once per page (textures, models, recordings). */
const preloaded = new Set<string>();
async function preload(job: LongFormJob) {
  const key = JSON.stringify(job.recipe.params) + job.recipe.templateId;
  if (preloaded.has(key)) return;
  const template = getTemplate(job.recipe.templateId);
  const r = runnerFor(job, false);
  await template.preload?.(r.params);
  preloaded.add(key);
}

export interface LongFormJob {
  recipe: Recipe;
  /** Already validated by the harness (see loopLengthOf). */
  loopS: number;
}

export interface LongFormInfo {
  frames: number;
  fps: number;
  width: number;
  height: number;
  thumbnailAtS: number;
  score: { total: number; parts: Record<string, number>; notes?: string[] };
  audioEvents: number;
}

export interface SeamCheck {
  /** Mean absolute pixel difference (0..255) between the loop's last frame and its first. */
  seamStep: number;
  /** The same for the last frame and frame loopS (which should equal frame 0): what one ordinary step looks like there. */
  referenceStep: number;
  /** Frame loopS vs frame 0: only per-frame grain should differ. */
  wrapDiff: number;
}

declare global {
  interface Window {
    longFormPrepare: (job: LongFormJob) => Promise<LongFormInfo>;
    longFormSeamCheck: (job: LongFormJob) => Promise<SeamCheck>;
    longFormVideoSegment: (job: LongFormJob, seg: { name: string; f0: number; f1: number; bitrate: number }) => Promise<{ frames: number; bytes: number; codec: string; ms: number }>;
    longFormAudioSegment: (job: LongFormJob, seg: { name: string; from: number; to: number; overlap: number }) => Promise<{ samples: number; ms: number }>;
    longFormStill: (job: LongFormJob, still: { name: string; t: number }) => Promise<{ ms: number }>;
  }
}

const runnerFor = (job: LongFormJob, visual: boolean) => {
  const template = getTemplate(job.recipe.templateId);
  if (!template.longForm) throw new Error(`${template.id} is not a long-form template`);
  return new Runner(template, {
    seed: job.recipe.seed,
    params: job.recipe.params,
    theme: getTheme(job.recipe.themeId),
    melody: getMelody(job.recipe.melodyId),
    visual,
    loopS: loopLengthOf(template, job.loopS, true),
  });
};

/** One headless run of the whole loop, kept for the audio segments (sound comes from its event log). */
let headless: { key: string; runner: Runner } | null = null;
function headlessRun(job: LongFormJob) {
  const key = JSON.stringify(job);
  if (headless?.key !== key) headless = { key, runner: runnerFor(job, false).runToEnd() };
  return headless.runner;
}

/** The drawing runner, reused across segments (they are asked for in order). */
let drawing: { key: string; runner: Runner } | null = null;
function drawingRunnerAt(job: LongFormJob, frame: number) {
  const key = JSON.stringify(job);
  if (drawing?.key !== key || drawing.runner.frame > frame) drawing = { key, runner: runnerFor(job, true) };
  const r = drawing.runner;
  while (r.frame < frame) r.advanceFrame();
  return r;
}

window.longFormPrepare = async (job) => {
  await preload(job);
  const r = headlessRun(job);
  const template = getTemplate(job.recipe.templateId);
  await upload('events.json', JSON.stringify({ events: r.events, audio: r.audio }));
  return {
    frames: r.frame,
    fps: r.fps,
    width: r.width,
    height: r.height,
    thumbnailAtS: template.longForm?.thumbnailAt?.(r.state) ?? r.loopS / 2,
    score: r.score(r.loopS),
    audioEvents: r.audio.length,
  };
};

/**
 * Draw the frames either side of the loop's join and compare pixels. Uses its own runner and canvas:
 * reading pixels back would switch the encode canvas to slow software rendering.
 */
window.longFormSeamCheck = async (job) => {
  await preload(job);
  const r = runnerFor(job, true);
  const canvas = Object.assign(document.createElement('canvas'), { width: r.width, height: r.height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const snap = () => {
    r.draw(canvas);
    return ctx.getImageData(0, 0, r.width, r.height).data;
  };
  const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return sum / ((a.length / 4) * 3);
  };
  const first = snap();
  const total = Math.round(r.loopS * r.fps);
  while (r.frame < total - 1) r.advanceFrame();
  const last = snap();
  r.advanceFrame();
  const wrapped = snap();
  return { seamStep: diff(last, first), referenceStep: diff(last, wrapped), wrapDiff: diff(wrapped, first) };
};

window.longFormVideoSegment = async (job, seg) => {
  const t0 = performance.now();
  await preload(job);
  const r = drawingRunnerAt(job, seg.f0);
  const canvas = Object.assign(document.createElement('canvas'), { width: r.width, height: r.height });
  document.body.appendChild(canvas);
  const codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: r.width, height: r.height });
  if (!codec) throw new Error('No encodable video codec available in this browser');
  let bytes = 0;
  let first = true;
  let pending: Promise<void> = Promise.resolve();
  // Fragmented MP4 is written strictly in order, so chunks can simply be appended on disk.
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      bytes += chunk.data.byteLength;
      const data = chunk.data.slice();
      const append = !first;
      first = false;
      pending = pending.then(() => upload(seg.name, data, { append }));
      return pending;
    },
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  });
  const source = new CanvasSource(canvas, { codec, bitrate: seg.bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: r.fps });
  await output.start();
  for (let f = seg.f0; f < seg.f1; f++) {
    while (r.frame < f) r.advanceFrame();
    r.draw(canvas);
    // Each segment starts at 0; ffmpeg's concat lines them up end to end.
    await source.add((f - seg.f0) / r.fps, 1 / r.fps);
    if ((f - seg.f0) % 60 === 0) window.reportProgress?.(f, Math.round(r.loopS * r.fps));
  }
  await output.finalize();
  await pending;
  canvas.remove();
  return { frames: seg.f1 - seg.f0, bytes, codec, ms: performance.now() - t0 };
};

window.longFormAudioSegment = async (job, seg) => {
  const t0 = performance.now();
  const r = headlessRun(job);
  await preload(job);
  const lf = getTemplate(job.recipe.templateId).longForm!;
  const beds = lf.beds?.(r.params) ?? [];
  // The pre-roll must outlast the longest one-shot (a thunder roll), so one ringing at a segment's
  // start sounds exactly as in the segment before.
  const bedSounds = new Set(beds.map((b) => b.sound));
  let longest = 0;
  for (const [name, buf] of loadedSounds()) if (!bedSounds.has(name)) longest = Math.max(longest, buf.duration);
  const samples = await renderAudioRange(r.audio, seg.from, seg.to, {
    preRoll: Math.max(12, Math.ceil(longest) + 2),
    reverb: lf.reverb ?? 0,
    loopS: r.loopS,
    postRoll: seg.overlap,
    samples: loadedSounds(),
    beds,
    compress: false,
  });
  await upload(seg.name, samples);
  return { samples: samples.length / 2, ms: performance.now() - t0 };
};


/** One frame as a PNG (for looking at a scene without rendering the loop). */
window.longFormStill = async (job, still) => {
  const t0 = performance.now();
  await preload(job);
  const probe = runnerFor(job, false);
  const r = drawingRunnerAt(job, Math.round(still.t * probe.fps));
  const canvas = Object.assign(document.createElement('canvas'), { width: r.width, height: r.height });
  r.draw(canvas);
  const blob = await new Promise<Blob>((ok) => canvas.toBlob((b) => ok(b!), 'image/png'));
  await upload(still.name, await blob.arrayBuffer());
  return { ms: performance.now() - t0 };
};

