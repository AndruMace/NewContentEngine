import { FONT_FAMILY, type Ctx2D, type Theme } from '@sim/engine';

/** Shared pieces of the guessing templates (Fourier Drawing, Bounce Keys, Marble Machine). */

/** Roughly where TikTok, Reels and Shorts put the comment button (right-hand rail, about 2/3 down). */
const COMMENT_BUTTON = { x: 1010, y: 1270 };

/**
 * "Comment your guess!" in a dark pill centred on `at`, with a pointing hand tilted toward the comment
 * button and tapping toward it. `since` is time since it appeared, `left` the time until the reveal.
 */
export function drawCommentPrompt(ctx: Ctx2D, theme: Theme, since: number, left: number, at: { x: number; y: number }, text = 'Comment your guess!') {
  const alpha = Math.min(1, since / 0.3, left / 0.3);
  if (alpha <= 0) return;
  const k = Math.min(1, since / 0.35);
  const pop = 0.8 + 0.2 * (1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(at.x, at.y);
  ctx.scale(pop, pop);
  ctx.font = `800 34px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const textW = ctx.measureText(text).width;
  const hand = 60;
  const w = textW + hand + 72;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(-w / 2, -30, w, 60, 30);
  ctx.fill();
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = alpha * 0.6;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, -hand / 2, 2);

  // The hand sits at the pill's right end, turned to point at the comment button.
  const hx = w / 2 - 22 - hand / 2;
  const angle = Math.atan2(COMMENT_BUTTON.y - at.y, COMMENT_BUTTON.x - (at.x + hx));
  const tap = 6 * Math.max(0, Math.sin(since * 7));
  ctx.translate(hx + Math.cos(angle) * tap, Math.sin(angle) * tap);
  ctx.rotate(angle);
  ctx.font = `50px ${FONT_FAMILY}`;
  ctx.fillText('👉', 0, 2);
  ctx.restore();
}

/** The answer in big outlined capitals, popping in over 0.35 s from `since` = 0. */
export function drawAnswer(ctx: Ctx2D, theme: Theme, label: string, x: number, y: number, since: number, size = 80) {
  const k = Math.min(1, since / 0.35);
  if (k <= 0) return;
  const pop = 1 + 0.25 * Math.sin(Math.PI * k) * (1 - k * 0.5);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(pop, pop);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${size}px ${FONT_FAMILY}`;
  ctx.lineWidth = size / 8;
  ctx.strokeStyle = theme.textStroke;
  ctx.strokeText(label, 0, 0);
  ctx.fillStyle = theme.text;
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

/** Guess-the-song templates: the last seconds before the reveal count down 3-2-1 in big digits. */
export const SONG_FINAL_COUNT = 3;

/** Where a guess-the-song video is: first note, reveal time and now (s). */
export interface SongClock {
  first: number;
  revealAt: number;
  t: number;
}

/** Long titles on two lines, split at the space nearest the middle. */
export function splitTitle(title: string): string[] {
  if (title.length <= 16) return [title];
  const mid = title.length / 2;
  let best = -1;
  for (let i = 0; i < title.length; i++) if (title[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? [title] : [title.slice(0, best), title.slice(best + 1)];
}

/** "0:18": seconds until the reveal, rounded up. */
export function formatCountdown(seconds: number): string {
  const n = Math.max(0, Math.ceil(seconds - 1e-9));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

/**
 * "ANSWER IN 0:18" at labelY, ticking down; in the last SONG_FINAL_COUNT seconds a big 3-2-1 pulses
 * at bigY, one digit per second (the template emits a tick for each).
 */
export function drawSongCountdown(ctx: Ctx2D, theme: Theme, c: SongClock, at: { labelY: number; bigY: number }) {
  const left = c.revealAt - c.t;
  if (left <= 0) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = Math.min(1, c.t / 0.5);
  ctx.font = `800 28px ${FONT_FAMILY}`;
  ctx.lineWidth = 6;
  ctx.strokeStyle = theme.textStroke;
  const label = `ANSWER IN ${formatCountdown(left)}`;
  ctx.strokeText(label, 540 - 12, at.labelY);
  ctx.fillStyle = theme.text;
  ctx.fillText(label, 540 - 12, at.labelY);
  if (left <= SONG_FINAL_COUNT && c.revealAt - SONG_FINAL_COUNT >= c.first) {
    const n = Math.ceil(left);
    const into = n - left; // 0 when the digit appears, 1 as the next one takes over
    const pop = 1 - Math.min(1, into * 5);
    ctx.globalAlpha = 0.9 * (1 - 0.65 * into);
    ctx.translate(540, at.bigY);
    ctx.scale(1 + 0.45 * pop * pop, 1 + 0.45 * pop * pop);
    ctx.font = `900 260px ${FONT_FAMILY}`;
    ctx.lineWidth = 16;
    ctx.strokeText(String(n), 0, 0);
    ctx.fillStyle = theme.accent;
    ctx.fillText(String(n), 0, 0);
  }
  ctx.restore();
}

/** A thin bar that fills toward the reveal, with a lock at the end that opens; fades for the CTA. */
export function drawSongProgress(ctx: Ctx2D, theme: Theme, c: SongClock, at: { y: number; w: number; outroDelay: number }) {
  const u = Math.min(1, Math.max(0, (c.t - c.first) / (c.revealAt - c.first)));
  // Makes way for the CTA, which can run to two lines.
  const alpha = Math.min(1, Math.max(0, 1 - (c.t - c.revealAt - at.outroDelay) / 0.25));
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const x0 = 540 - at.w / 2 - 24;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.roundRect(x0, at.y - 7, at.w, 14, 7);
  ctx.fill();
  if (u > 0) {
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.roundRect(x0, at.y - 7, Math.max(14, at.w * u), 14, 7);
    ctx.fill();
  }
  ctx.font = `44px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(u >= 1 ? '🔓' : '🔒', x0 + at.w + 40, at.y);
  ctx.restore();
}

/** The song's title in big capitals (two lines if long) with the composer under it, from `since` = 0. */
export function drawSongTitle(ctx: Ctx2D, theme: Theme, title: string, composer: string, since: number, y: number) {
  const lines = splitTitle(title.toUpperCase());
  const size = lines.length > 1 ? 70 : 80;
  lines.forEach((line, i) => drawAnswer(ctx, theme, line, 540, y + (i - (lines.length - 1) / 2) * size * 1.1, since - i * 0.08, size));
  const a = Math.min(1, Math.max(0, (since - 0.35) / 0.3));
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 40px ${FONT_FAMILY}`;
  ctx.lineWidth = 6;
  ctx.strokeStyle = theme.textStroke;
  const by = y + (lines.length / 2) * size * 1.1 + 34;
  ctx.strokeText(composer, 540, by);
  ctx.fillStyle = theme.accent;
  ctx.fillText(composer, 540, by);
  ctx.restore();
}
