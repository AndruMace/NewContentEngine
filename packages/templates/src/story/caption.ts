import { FONT_FAMILY, type Ctx2D, type Theme } from '@sim/engine';
import { partProgress, saying, type AnyDirector } from './director';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * The spoken line as a caption, words lighting up as they're said (timed by their share of the
 * line's letters: no word timestamps from the voice). Wraps onto two lines; shrinks if it must.
 */
export function drawSpoken(ctx: Ctx2D, theme: Theme, caption: string, progress: number, x: number, y: number, o: { size: number; maxW: number; lit?: string }) {
  const words = caption.split(/\s+/).filter(Boolean);
  if (!words.length) return;
  let size = o.size;
  let rows: string[][] = [];
  for (; size >= o.size * 0.6; size -= 2) {
    ctx.font = `900 ${size}px ${FONT_FAMILY}`;
    rows = wrap(ctx, words, o.maxW);
    if (rows.length <= 2) break;
  }
  const total = caption.replace(/\s+/g, '').length;
  let seen = 0;
  const lineH = size * 1.22;
  ctx.save();
  ctx.font = `900 ${size}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, size / 8);
  ctx.strokeStyle = theme.textStroke;
  const space = ctx.measureText(' ').width;
  rows.forEach((row, r) => {
    const widths = row.map((w) => ctx.measureText(w).width);
    let cx = x - (widths.reduce((a, b) => a + b, 0) + space * (row.length - 1)) / 2;
    const cy = y + (r - (rows.length - 1) / 2) * lineH;
    row.forEach((w, i) => {
      const start = seen / total;
      seen += w.length;
      const on = clamp01((progress - start) / 0.04);
      ctx.strokeText(w, cx, cy);
      ctx.fillStyle = on >= 1 ? (o.lit ?? theme.accent) : `rgba(255,255,255,${0.45 + 0.5 * on})`;
      ctx.fillText(w, cx, cy);
      cx += widths[i] + space;
    });
  });
  ctx.restore();
}

function wrap(ctx: Ctx2D, words: string[], maxW: number): string[][] {
  const rows: string[][] = [[]];
  for (const w of words) {
    const row = rows[rows.length - 1];
    const next = [...row, w].join(' ');
    if (row.length && ctx.measureText(next).width > maxW) rows.push([w]);
    else row.push(w);
  }
  // Balance two rows, so the second isn't a single dangling word.
  if (rows.length === 2) {
    const all = [...rows[0], ...rows[1]];
    let best = rows;
    let bestDiff = Infinity;
    for (let k = 1; k < all.length; k++) {
      const a = all.slice(0, k);
      const b = all.slice(k);
      const wa = ctx.measureText(a.join(' ')).width;
      const wb = ctx.measureText(b.join(' ')).width;
      if (wa > maxW || wb > maxW) continue;
      if (Math.abs(wa - wb) < bestDiff) {
        bestDiff = Math.abs(wa - wb);
        best = [a, b];
      }
    }
    return best;
  }
  return rows;
}

/** Progress through a spoken line, 0..1 (speech starts a moment into the clip). */
export const spokenProgress = (since: number, durationS: number) => clamp01((since - 0.05) / Math.max(0.3, durationS - 0.15));

/**
 * The narration's caption (or, with narration off, the script as text): the current line, words
 * lighting up as they're said. Each sentence of a passage is timed on its own, so the highlight is
 * exact at every sentence start and estimated (by letters) within one.
 */
export function drawStoryCaption(ctx: Ctx2D, theme: Theme, d: AnyDirector, t: number, o: { y: number; size?: number; maxW?: number; lit?: string; x?: number }) {
  const now = saying(d, t);
  if (!now) return;
  const { line, since } = now;
  const fade = Math.min(1, since / 0.12, (line.durationS + 0.5 - since) / 0.25);
  if (fade <= 0) return;
  const { part, u } = partProgress(line, since);
  const letters = (s: string) => s.replace(/\s+/g, '').length;
  const total = Math.max(1, letters(line.caption));
  let seen = 0;
  for (let k = 0; k < part; k++) seen += letters(line.parts[k].caption);
  const progress = part < 0 ? 0 : (seen + letters(line.parts[part].caption) * u) / total;
  ctx.save();
  ctx.globalAlpha *= fade;
  drawSpoken(ctx, theme, line.caption, progress, o.x ?? 540, o.y, { size: o.size ?? 54, maxW: o.maxW ?? 940, lit: o.lit });
  ctx.restore();
}
