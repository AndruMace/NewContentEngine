import { spawn } from 'node:child_process';
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
