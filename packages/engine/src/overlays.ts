import type { Ctx2D, LeaderboardRow, OverlaySpec } from './types';
import type { Theme } from './themes';

export const FONT_FAMILY = '"Montserrat", "Arial Black", "Helvetica Neue", sans-serif';

/** Replace {name} placeholders with values from params/hud. */
export function fillCopy(text: string, values: Record<string, unknown>): string {
  return text.replace(/\{(\w+)\}/g, (m, key) => (key in values ? String(values[key]) : m));
}

export interface OverlayState {
  prev: Record<string, unknown>;
  changedAt: Record<string, number>;
  outroAt: number | null;
}

export function newOverlayState(): OverlayState {
  return { prev: {}, changedAt: {}, outroAt: null };
}

const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function wrapLines(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function strokedText(
  ctx: Ctx2D,
  theme: Theme,
  text: string,
  x: number,
  y: number,
  size: number,
  opts: {
    maxWidth?: number;
    scale?: number;
    alpha?: number;
    color?: string;
    /** Shrink the font until the text fits in this many lines. */
    maxLines?: number;
    /** 'bottom' keeps the last line's centre at y, so extra lines grow upwards. */
    anchor?: 'middle' | 'bottom';
  } = {},
) {
  const { maxWidth = 820, scale = 1, alpha = 1, color = theme.text, maxLines = 99, anchor = 'middle' } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  let lines: string[];
  for (;;) {
    ctx.font = `900 ${size}px ${FONT_FAMILY}`;
    lines = wrapLines(ctx, text, maxWidth);
    if (lines.length <= maxLines || size < 40) break;
    size *= 0.92;
  }
  const lh = size * 1.12;
  const y0 = anchor === 'bottom' ? -(lines.length - 1) * lh : -((lines.length - 1) * lh) / 2;
  lines.forEach((line, i) => {
    ctx.lineWidth = Math.max(6, size * 0.16);
    ctx.strokeStyle = theme.textStroke;
    ctx.strokeText(line, 0, y0 + i * lh);
    ctx.fillStyle = color;
    ctx.fillText(line, 0, y0 + i * lh);
  });
  ctx.restore();
}

/**
 * Draws hook text, counters, timers and CTAs. Layout keeps clear of the platform UI:
 * nothing below 78% height, text width capped so it avoids the right-hand action column.
 */
export function drawOverlays(
  ctx: Ctx2D,
  width: number,
  height: number,
  specs: OverlaySpec[],
  state: OverlayState,
  t: number,
  hud: Record<string, unknown>,
  theme: Theme,
) {
  if (hud.outro && state.outroAt === null) state.outroAt = t;
  const cx = width / 2;

  for (const spec of specs) {
    switch (spec.kind) {
      case 'hook': {
        const from = spec.from ?? 0;
        const to = spec.to ?? 2.2;
        if (t < from || t > to) break;
        const pop = easeOutBack(clamp01((t - from) / 0.18));
        const fade = clamp01((to - t) / 0.25);
        strokedText(ctx, theme, fillCopy(spec.text, hud), cx, height * (spec.y ?? 0.15), 78, {
          scale: 0.6 + 0.4 * pop,
          alpha: fade,
          maxLines: 2,
          anchor: 'bottom',
        });
        break;
      }
      case 'counter': {
        const value = hud[spec.key];
        if (value === undefined) break;
        if (state.prev[spec.key] !== value) {
          if (spec.key in state.prev) state.changedAt[spec.key] = t;
          state.prev[spec.key] = value;
        }
        const since = t - (state.changedAt[spec.key] ?? -10);
        const pulse = 1 + 0.28 * Math.exp(-since * 9);
        const y = height * (spec.y ?? 0.22);
        const size = spec.size ?? 120;
        // Counters make way for the CTA once the outro starts.
        const alpha = state.outroAt === null ? 1 : clamp01(1 - (t - state.outroAt) / 0.25);
        if (alpha <= 0) break;
        if (spec.label) strokedText(ctx, theme, spec.label, cx, y - size * 0.72, 34, { color: theme.accent, alpha });
        strokedText(ctx, theme, String(value), cx, y, size, { scale: pulse, alpha });
        break;
      }
      case 'timer': {
        strokedText(ctx, theme, `${t.toFixed(1)}s`, cx, height * (spec.y ?? 0.72), 54);
        break;
      }
      case 'cta': {
        let start: number;
        if (spec.when === 'outro') {
          if (state.outroAt === null) break;
          start = state.outroAt;
        } else {
          if (t < spec.when.from || t > spec.when.to) break;
          start = spec.when.from;
        }
        const pop = easeOutBack(clamp01((t - start) / 0.2));
        strokedText(ctx, theme, fillCopy(spec.text, hud), cx, height * (spec.y ?? 0.74), 64, {
          maxLines: 2,
          scale: 0.5 + 0.5 * pop,
          alpha: clamp01((t - start) / 0.1),
        });
        break;
      }
      case 'leaderboard': {
        const rows = hud[spec.key] as LeaderboardRow[] | undefined;
        if (!rows?.length) break;
        drawLeaderboard(ctx, theme, rows.slice(0, spec.max ?? 8), spec.title, spec.x ?? 36, height * (spec.y ?? 0.2));
        break;
      }
      case 'label': {
        strokedText(ctx, theme, fillCopy(spec.text, hud), cx, height * (spec.y ?? 0.08), 40);
        break;
      }
      case 'nudge': {
        if (t < spec.from || t > spec.to) break;
        const pop = easeOutBack(clamp01((t - spec.from) / 0.22));
        const alpha = clamp01((t - spec.from) / 0.15) * clamp01((spec.to - t) / 0.3);
        drawPill(ctx, theme, fillCopy(spec.text, hud), cx, height * spec.y, 0.75 + 0.25 * pop, alpha);
        break;
      }
      case 'heart': {
        const at = spec.when === 'outro' ? (state.outroAt === null ? null : state.outroAt + 0.35) : spec.when.at + 0.35;
        if (at === null || t < at || t > at + HEART_S) break;
        drawHeartCue(ctx, width, height, (t - at) / HEART_S);
        break;
      }
    }
  }
}

const HEART_S = 1.6;

/** Comment prompt: a compact dark pill with white text, unobtrusive but readable on any background. */
function drawPill(ctx: Ctx2D, theme: Theme, text: string, cx: number, cy: number, scale: number, alpha: number) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.font = `800 40px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = Math.min(860, ctx.measureText(text).width + 64);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.roundRect(-w / 2, -38, w, 76, 38);
  ctx.fill();
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = alpha * 0.55;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 0, 2, 820);
  ctx.restore();
}

function heartPath(ctx: Ctx2D, s: number) {
  ctx.beginPath();
  ctx.moveTo(0, s * 0.35);
  ctx.bezierCurveTo(-s * 1.1, -s * 0.35, -s * 0.5, -s * 1.05, 0, -s * 0.45);
  ctx.bezierCurveTo(s * 0.5, -s * 1.05, s * 1.1, -s * 0.35, 0, s * 0.35);
  ctx.closePath();
}

/**
 * Like cue: a heart (and a smaller follower) floating up the right edge toward where the like
 * button sits, swelling then fading. u runs 0..1 over its life. No text.
 */
function drawHeartCue(ctx: Ctx2D, width: number, height: number, u: number) {
  const hearts = [
    { delay: 0, size: 44, dx: 0 },
    { delay: 0.18, size: 26, dx: -38 },
  ];
  for (const h of hearts) {
    const k = clamp01((u - h.delay) / (1 - h.delay));
    if (k <= 0 || k >= 1) continue;
    const ease = 1 - (1 - k) * (1 - k);
    const x = width * 0.86 + h.dx + Math.sin(k * Math.PI * 2) * 10;
    const y = height * (0.71 - 0.13 * ease);
    const scale = 0.6 + 0.55 * easeOutBack(clamp01(k / 0.35));
    const alpha = clamp01(k / 0.12) * clamp01((1 - k) / 0.35);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    heartPath(ctx, h.size);
    ctx.fillStyle = '#ff3d6e';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.restore();
  }
}

function drawLeaderboard(ctx: Ctx2D, theme: Theme, rows: LeaderboardRow[], title: string | undefined, x: number, y: number) {
  const rowH = 44;
  const w = 250;
  const top = title ? 40 : 0;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, top + rows.length * rowH + 14, 18);
  ctx.fill();
  ctx.textBaseline = 'middle';
  if (title) {
    ctx.font = `900 24px ${FONT_FAMILY}`;
    ctx.fillStyle = theme.accent;
    ctx.fillText(title, x + 18, y + 26);
  }
  rows.forEach((row, i) => {
    const cy = y + top + 14 + i * rowH + rowH / 2 - 4;
    ctx.globalAlpha = row.out ? 0.38 : 1;
    ctx.font = `900 24px ${FONT_FAMILY}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${i + 1}`, x + 16, cy);
    ctx.fillStyle = row.color;
    ctx.beginPath();
    ctx.arc(x + 62, cy, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `900 26px ${FONT_FAMILY}`;
    const label = row.icon ? `${row.icon} ${row.label}` : row.label;
    ctx.fillText(label, x + 88, cy, w - 100);
    if (row.out) {
      ctx.fillRect(x + 84, cy, Math.min(w - 100, ctx.measureText(label).width + 6), 3);
    }
  });
  ctx.restore();
}
