import { spawn } from 'node:child_process';
import { rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';

export function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', fail);
    p.on('close', (code) => ok({ code: code ?? -1, stdout, stderr }));
  });
}

async function ffmpeg(args: string[]) {
  const r = await run('ffmpeg', ['-hide_banner', '-nostdin', ...args]);
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.slice(-2000)}`);
  return r.stderr;
}

export const LOUDNESS = { I: -14, TP: -1.5, LRA: 11 };

/** Two-pass EBU R128 normalisation to the -14 LUFS that Shorts/TikTok/Reels play back at. */
async function measureLoudness(wav: string) {
  const err = await ffmpeg(['-i', wav, '-af', `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}:print_format=json`, '-f', 'null', '-']);
  const json = err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1);
  return JSON.parse(json) as { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string };
}

/** Mux encoder output + rendered audio into the final, platform-ready MP4. */
export async function master(dir: string, videoCodec: string) {
  const video = join(dir, 'video.mp4');
  const wav = join(dir, 'audio.wav');
  const out = join(dir, 'final.mp4');
  const m = await measureLoudness(wav);
  const af =
    `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000` +
    // Brickwall below the true-peak ceiling: collision transients (pops, booms) are very peaky.
    `,alimiter=limit=${Math.pow(10, (LOUDNESS.TP - 0.7) / 20).toFixed(3)}:attack=1:release=60:level=false`;
  const vcodec =
    videoCodec === 'avc'
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
  await ffmpeg([
    '-y', '-i', video, '-i', wav,
    '-map', '0:v:0', '-map', '1:a:0',
    ...vcodec,
    '-af', af, '-c:a', 'aac', '-b:a', '320k', '-ar', '48000',
    '-movflags', '+faststart', '-shortest', out,
  ]);
  return out;
}

export async function extractStills(dir: string, coverAtS: number, durationS: number) {
  const final = join(dir, 'final.mp4');
  await ffmpeg(['-y', '-ss', coverAtS.toFixed(3), '-i', final, '-frames:v', '1', '-q:v', '2', join(dir, 'cover.jpg')]);
  await ffmpeg([
    '-y', '-i', final,
    '-vf', `fps=12/${durationS.toFixed(3)},scale=270:-1,tile=6x2:padding=4:color=black`,
    '-frames:v', '1', '-q:v', '3', join(dir, 'contact.jpg'),
  ]);
}

export interface QcReport {
  pass: boolean;
  problems: string[];
  width: number;
  height: number;
  fps: number;
  durationS: number;
  videoCodec: string;
  audioCodec: string;
  integratedLufs: number;
  truePeakDb: number;
  blackSegments: number;
  freezeSegments: number;
}

export async function qc(file: string, expectedDurationS: number): Promise<QcReport> {
  const probe = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const info = JSON.parse(probe.stdout);
  const v = info.streams.find((s: any) => s.codec_type === 'video') ?? {};
  const a = info.streams.find((s: any) => s.codec_type === 'audio') ?? {};
  const [num, den] = String(v.avg_frame_rate ?? '0/1').split('/').map(Number);
  const err = await ffmpeg([
    '-nostats', '-i', file,
    '-vf', 'blackdetect=d=0.5:pic_th=0.995:pix_th=0.02,freezedetect=n=0.0005:d=3',
    '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ]);
  const summary = err.slice(err.lastIndexOf('Summary:'));
  const integratedLufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1] ?? NaN);
  const truePeakDb = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1] ?? NaN);
  const report: QcReport = {
    pass: true,
    problems: [],
    width: v.width,
    height: v.height,
    fps: den ? num / den : 0,
    durationS: Number(info.format?.duration ?? 0),
    videoCodec: v.codec_name,
    audioCodec: a.codec_name,
    integratedLufs,
    truePeakDb,
    blackSegments: (err.match(/black_start/g) ?? []).length,
    freezeSegments: (err.match(/freeze_start/g) ?? []).length,
  };
  const p = report.problems;
  if (report.width !== 1080 || report.height !== 1920) p.push(`resolution ${report.width}x${report.height}`);
  if (Math.abs(report.fps - 60) > 0.01) p.push(`fps ${report.fps}`);
  if (Math.abs(report.durationS - expectedDurationS) > 0.1) p.push(`duration ${report.durationS} vs ${expectedDurationS}`);
  if (report.videoCodec !== 'h264') p.push(`video codec ${report.videoCodec}`);
  if (report.audioCodec !== 'aac') p.push(`audio codec ${report.audioCodec}`);
  if (!(Math.abs(integratedLufs - LOUDNESS.I) <= 1.5)) p.push(`loudness ${integratedLufs} LUFS`);
  if (truePeakDb > -0.5) p.push(`true peak ${truePeakDb} dBFS`);
  if (report.blackSegments) p.push(`${report.blackSegments} black segment(s)`);
  if (report.freezeSegments) p.push(`${report.freezeSegments} frozen segment(s)`);
  report.pass = p.length === 0;
  return report;
}

// ---- Long-form (ambient) ----------------------------------------------------------------------

/**
 * Ambient loudness: well under the −14 LUFS Shorts target, so a sleep/study video sits quietly in the
 * background (YouTube only ever turns loud videos down). The ceiling leaves thunder its dynamics.
 */
export const AMBIENT_LOUDNESS = { I: -21, TP: -2 };

/** Raw interleaved float32 stereo at 48 kHz, as the page renders it. */
const RAW = ['-f', 'f32le', '-ar', '48000', '-ac', '2'];

/** Integrated loudness and true peak of a raw float32 loop. */
async function measureRaw(raw: string) {
  const err = await ffmpeg([...RAW, '-i', raw, '-af', `loudnorm=I=${AMBIENT_LOUDNESS.I}:TP=${AMBIENT_LOUDNESS.TP}:print_format=json`, '-f', 'null', '-']);
  const json = JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1));
  return { i: Number(json.input_i), tp: Number(json.input_tp) };
}

/**
 * Build the final long video from one master loop.
 *
 * The loop's audio is mastered once: a fixed gain to the ambient target (every repeat is identical,
 * so one measurement does) and a limiter run at 4× oversampling, which also catches the peaks
 * between samples (thunder through plain limiting and AAC came out at −0.3 dBFS true peak). The
 * limiter runs on the loop with the loop's own last seconds in front, so the mastered loop is exactly
 * periodic. That mastered loop is repeated to the full length and encoded to AAC in one go (no gaps
 * at the repeats), with a fade-out at the very end; the video is repeated by stream copy.
 */
export async function masterLongForm(dir: string, opts: { loopS: number; totalS: number }) {
  const raw = join(dir, 'loop.f32');
  const m = await measureRaw(raw);
  const gainDb = AMBIENT_LOUDNESS.I - m.i;
  const fade = Math.min(5, opts.totalS / 4);
  const limit = Math.pow(10, (AMBIENT_LOUDNESS.TP - 0.7) / 20).toFixed(3);
  const lead = Math.min(2, opts.loopS / 2);
  const mastered = join(dir, 'loop-master.f32');
  await ffmpeg([
    '-y', ...RAW, '-i', raw,
    '-filter_complex',
    `[0]asplit=2[a][b];[a]atrim=start=${(opts.loopS - lead).toFixed(6)},asetpts=PTS-STARTPTS[lead];[lead][b]concat=n=2:v=0:a=1,` +
      `volume=${gainDb.toFixed(2)}dB,aresample=192000,alimiter=limit=${limit}:attack=5:release=200:level=false:latency=1,aresample=48000,` +
      `atrim=start=${lead.toFixed(6)},asetpts=PTS-STARTPTS[out]`,
    '-map', '[out]', '-f', 'f32le', '-ar', '48000', '-ac', '2', mastered,
  ]);
  // The mastered loop must be exactly the loop's length, or the repeats would drift.
  const want = Math.round(opts.loopS * 48000) * 8;
  const got = (await stat(mastered)).size;
  if (got < want) throw new Error(`mastered loop is ${got} bytes, expected ${want}`);
  if (got > want) await truncate(mastered, want);
  // Lossless copy of the mastered loop (below full scale, so nothing clips), for making another
  // final length without re-rendering.
  await ffmpeg(['-y', ...RAW, '-i', mastered, '-c:a', 'flac', '-sample_fmt', 's32', join(dir, 'loop.flac')]);
  const audio = join(dir, 'audio.m4a');
  await ffmpeg([
    '-y', '-stream_loop', '-1', ...RAW, '-i', mastered, '-t', opts.totalS.toFixed(3),
    '-af', `afade=t=out:st=${(opts.totalS - fade).toFixed(3)}:d=${fade}`,
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', audio,
  ]);
  await rm(mastered, { force: true });
  const out = join(dir, 'final.mp4');
  await ffmpeg([
    '-y', '-stream_loop', '-1', '-i', join(dir, 'loop.mp4'), '-i', audio, '-t', opts.totalS.toFixed(3),
    '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', out,
  ]);
  return { final: out, loopLufs: m.i, gainDb };
}

/** 1280×720 thumbnail at a chosen moment, and a 12-frame contact sheet spread over the loop (seeking, not decoding it all). */
export async function longFormStills(dir: string, opts: { loopS: number; thumbnailAtS: number }) {
  const loop = join(dir, 'loop.mp4');
  await ffmpeg(['-y', '-ss', opts.thumbnailAtS.toFixed(3), '-i', loop, '-frames:v', '1', '-vf', 'scale=1280:720', '-q:v', '2', join(dir, 'thumbnail.jpg')]);
  const n = 12;
  for (let i = 0; i < n; i++) {
    const at = ((i + 0.5) / n) * opts.loopS;
    await ffmpeg(['-y', '-ss', at.toFixed(3), '-i', loop, '-frames:v', '1', '-vf', 'scale=320:-1', '-q:v', '3', join(dir, `contact-${String(i).padStart(2, '0')}.jpg`)]);
  }
  await ffmpeg(['-y', '-i', join(dir, 'contact-%02d.jpg'), '-vf', 'tile=6x2:padding=4:color=black', '-frames:v', '1', '-q:v', '3', join(dir, 'contact.jpg')]);
  await Promise.all(Array.from({ length: n }, (_, i) => rm(join(dir, `contact-${String(i).padStart(2, '0')}.jpg`), { force: true })));
}

export interface LongFormQcReport extends QcReport {
  loopS: number;
  /** Most frame-average brightness jumps in any one second (photosensitivity: at most 3). */
  maxFlashesPerSecond: number;
}

/**
 * Long-form QC. The full analysis (loudness, black and frozen stretches, flashes) runs on the first
 * repeat of the loop only, since every repeat is the same; the whole file just has its streams,
 * size and length checked. Thresholds suit dark, calm scenes: a few seconds of a dim, still frame
 * is normal here, so only long black or frozen stretches count.
 */
export async function qcLongForm(file: string, opts: { loopS: number; totalS: number; width: number; height: number; fps: number }): Promise<LongFormQcReport> {
  const probe = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const info = JSON.parse(probe.stdout);
  const v = info.streams.find((s: any) => s.codec_type === 'video') ?? {};
  const a = info.streams.find((s: any) => s.codec_type === 'audio') ?? {};
  const [num, den] = String(v.avg_frame_rate ?? '0/1').split('/').map(Number);
  // Hardware decoding and a small analysis size: an hour of 1080p otherwise takes many minutes.
  const hw = process.platform === 'darwin' ? ['-hwaccel', 'videotoolbox'] : [];
  const err = await ffmpeg([
    '-nostats', ...hw, '-t', opts.loopS.toFixed(3), '-i', file,
    '-vf', 'scale=480:-2,blackdetect=d=5:pic_th=0.995:pix_th=0.01,freezedetect=n=0.0003:d=20,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ]);
  const summary = err.slice(err.lastIndexOf('Summary:'));
  const integratedLufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1] ?? NaN);
  const truePeakDb = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1] ?? NaN);
  const yavg = [...err.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  const report: LongFormQcReport = {
    pass: true,
    problems: [],
    width: v.width,
    height: v.height,
    fps: den ? num / den : 0,
    durationS: Number(info.format?.duration ?? 0),
    videoCodec: v.codec_name,
    audioCodec: a.codec_name,
    integratedLufs,
    truePeakDb,
    blackSegments: (err.match(/black_start/g) ?? []).length,
    freezeSegments: (err.match(/freeze_start/g) ?? []).length,
    loopS: opts.loopS,
    maxFlashesPerSecond: maxFlashesPerSecond(yavg, opts.fps),
  };
  const p = report.problems;
  if (report.width !== opts.width || report.height !== opts.height) p.push(`resolution ${report.width}x${report.height}`);
  if (Math.abs(report.fps - opts.fps) > 0.01) p.push(`fps ${report.fps}`);
  if (Math.abs(report.durationS - opts.totalS) > 0.5) p.push(`duration ${report.durationS} vs ${opts.totalS}`);
  if (report.videoCodec !== 'h264') p.push(`video codec ${report.videoCodec}`);
  if (report.audioCodec !== 'aac') p.push(`audio codec ${report.audioCodec}`);
  if (!(Math.abs(integratedLufs - AMBIENT_LOUDNESS.I) <= 1.5)) p.push(`loudness ${integratedLufs} LUFS`);
  if (truePeakDb > -1) p.push(`true peak ${truePeakDb} dBFS`);
  if (report.blackSegments) p.push(`${report.blackSegments} black segment(s)`);
  if (report.freezeSegments) p.push(`${report.freezeSegments} frozen segment(s)`);
  if (report.maxFlashesPerSecond > 3) p.push(`${report.maxFlashesPerSecond} flashes in one second (max 3)`);
  report.pass = p.length === 0;
  return report;
}

/**
 * Flashes per second from per-frame average brightness (0–255): a flash is a rise of at least 10%
 * of full brightness within a few frames. Returns the most in any one-second window.
 */
export function maxFlashesPerSecond(yavg: number[], fps: number): number {
  const RISE = 25.5;
  const WITHIN = 3;
  const flashes: number[] = [];
  for (let i = WITHIN; i < yavg.length; i++) {
    const base = Math.min(...yavg.slice(i - WITHIN, i));
    if (yavg[i] - base >= RISE && (!flashes.length || i - flashes[flashes.length - 1] > WITHIN)) flashes.push(i);
  }
  let most = 0;
  for (let a = 0, b = 0; b < flashes.length; b++) {
    while (flashes[b] - flashes[a] >= fps) a++;
    most = Math.max(most, b - a + 1);
  }
  return most;
}
