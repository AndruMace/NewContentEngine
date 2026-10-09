/**
 * Runs inside headless Chrome. Renders a recipe frame-by-frame into an MP4 via WebCodecs
 * (hardware H.264 when available), renders audio offline from the same event log, and
 * uploads both back to the harness.
 */
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, getFirstEncodableVideoCodec } from 'mediabunny';
import { FPS, Runner, VIDEO_HEIGHT, VIDEO_WIDTH, getTheme, type Recipe } from '@sim/engine';
import { audioBufferToWav, getMelody, renderAudio } from '@sim/audio';
import { getTemplate } from '@sim/templates';

declare global {
  interface Window {
    renderRecipe: (recipe: Recipe, opts: RenderPageOptions) => Promise<RenderPageResult>;
    reportProgress?: (frame: number, estFrames: number) => void;
    reportStage?: (stage: string) => void;
  }
}

export interface RenderPageOptions {
  bitrate: number;
  /** Max seconds before giving up (sim never finished). */
  maxSeconds: number;
}

export interface RenderPageResult {
  codec: string;
  frames: number;
  durationS: number;
  timedOut: boolean;
  score: { total: number; parts: Record<string, number>; notes?: string[] };
  encodeMs: number;
  audioMs: number;
}

/**
 * Send a file to the harness in 4 MB pieces. Playwright sees request bodies through the DevTools
 * protocol, where binary bytes are escaped (up to 6 characters each); a single ~90 MB video upload
 * produced a message longer than Node's maximum string length and crashed the render process.
 */
const UPLOAD_CHUNK = 4 * 1024 * 1024;

async function upload(name: string, data: ArrayBuffer | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  for (let off = 0; off === 0 || off < bytes.length; off += UPLOAD_CHUNK) {
    const res = await fetch(`upload?name=${encodeURIComponent(name)}${off ? '&append=1' : ''}`, { method: 'POST', body: bytes.subarray(off, off + UPLOAD_CHUNK) });
    if (!res.ok) throw new Error(`upload ${name} failed: ${res.status}`);
  }
}

async function loadFonts() {
  const face = new FontFace('Montserrat', 'url(fonts/montserrat-900.woff2)', { weight: '900' });
  await face.load();
  document.fonts.add(face);
}

window.renderRecipe = async (recipe, opts) => {
  await loadFonts();
  const template = getTemplate(recipe.templateId);
  const theme = getTheme(recipe.themeId);
  const runner = new Runner(template, {
    seed: recipe.seed,
    params: recipe.params,
    theme,
    melody: getMelody(recipe.melodyId),
    copy: recipe.copy,
    visual: true,
    maxSeconds: opts.maxSeconds,
  });

  // Headless pre-run gives the exact frame count for progress reporting.
  const pre = new Runner(template, {
    seed: recipe.seed,
    params: recipe.params,
    theme,
    melody: getMelody(recipe.melodyId),
    visual: false,
    maxSeconds: opts.maxSeconds,
  }).runToEnd();
  const estFrames = pre.frame + 1;

  const canvas = document.createElement('canvas');
  canvas.width = VIDEO_WIDTH;
  canvas.height = VIDEO_HEIGHT;
  document.body.appendChild(canvas);

  const codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: VIDEO_WIDTH, height: VIDEO_HEIGHT });
  if (!codec) throw new Error('No encodable video codec available in this browser');
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec, bitrate: opts.bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: FPS });
  await output.start();

  const t0 = performance.now();
  let frames = 0;
  const addFrame = async () => {
    runner.draw(canvas);
    await source.add(frames / FPS, 1 / FPS);
    frames++;
    if (frames % 30 === 0) window.reportProgress?.(frames, estFrames);
  };
  await addFrame();
  while (!runner.done) {
    runner.advanceFrame();
    if (runner.done && template.seamlessLoop) break;
    await addFrame();
  }
  await output.finalize();
  const encodeMs = performance.now() - t0;
  await upload('video.mp4', (output.target as BufferTarget).buffer!);

  window.reportStage?.('audio');
  const t1 = performance.now();
  const durationS = frames / FPS;
  const audio = await renderAudio(runner.audio, durationS, { reverb: theme.reverb });
  await upload('audio.wav', audioBufferToWav(audio));
  const audioMs = performance.now() - t1;

  await upload('events.json', JSON.stringify({ events: runner.events, audio: runner.audio }));
  return {
    codec,
    frames,
    durationS,
    timedOut: runner.timedOut,
    score: runner.score(recipe.targetS ?? durationS),
    encodeMs,
    audioMs,
  };
};
