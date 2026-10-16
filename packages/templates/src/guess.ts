import { FONT_FAMILY, type Ctx2D, type Theme } from '@sim/engine';

/** Shared pieces of the guessing templates (Fourier Drawing, Bounce Keys). */

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
