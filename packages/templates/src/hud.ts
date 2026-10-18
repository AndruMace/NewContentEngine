import { FONT_FAMILY, type Ctx2D } from '@sim/engine';

/** Live share per team as one segmented bar, the leader crowned (Territory War, RPS Battle). */
export function drawShareBar(
  ctx: Ctx2D,
  o: { x: number; y: number; w: number; h: number; teams: { color: string; icon?: string }[]; counts: number[]; leader: number; precise: boolean },
) {
  const total = o.counts.reduce((a, b) => a + b, 0) || 1;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.roundRect(o.x - 8, o.y - 8, o.w + 16, o.h + 16, 22);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(o.x, o.y, o.w, o.h, 16);
  ctx.clip();
  let x = o.x;
  o.teams.forEach((tm, k) => {
    const w = (o.counts[k] / total) * o.w;
    ctx.fillStyle = tm.color;
    ctx.fillRect(x, o.y, w + 0.5, o.h);
    if (w > 90) {
      // One decimal when precise (final seconds, the end), so a close finish reads as a real result.
      const pct = `${((o.counts[k] / total) * 100).toFixed(o.precise ? 1 : 0)}%`;
      const label = `${k === o.leader ? '👑 ' : ''}${tm.icon ?? ''} ${pct}`.trim();
      ctx.font = `900 ${w > 200 ? 36 : 28}px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 7;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(label, x + w / 2, o.y + o.h / 2 + 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x + w / 2, o.y + o.h / 2 + 2);
    }
    x += w;
  });
  ctx.restore();
}

/**
 * Time left as a label (or the final-rush banner) at labelY, and a big pulsing countdown at bigY in
 * the last five seconds. Nothing once the match has ended.
 */
export function drawClock(ctx: Ctx2D, o: { left: number; rush: boolean; ended: boolean; labelY: number; bigY: number; text: string; stroke: string }) {
  if (o.ended) return;
  const left = Math.max(0, o.left);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const label = o.rush ? `⚡ FINAL RUSH · ${left.toFixed(1)}s` : `${Math.ceil(left)}s left`;
  ctx.font = `900 44px ${FONT_FAMILY}`;
  ctx.lineWidth = 9;
  ctx.strokeStyle = o.stroke;
  ctx.strokeText(label, 540, o.labelY);
  ctx.fillStyle = o.text;
  ctx.fillText(label, 540, o.labelY);
  if (left <= 5 && left > 0) {
    const frac = left - Math.floor(left);
    ctx.globalAlpha = 0.55 + 0.4 * frac;
    ctx.font = `900 ${Math.round(260 + 120 * frac)}px ${FONT_FAMILY}`;
    ctx.lineWidth = 16;
    ctx.strokeStyle = o.stroke;
    ctx.strokeText(String(Math.ceil(left)), 540, o.bigY);
    ctx.fillStyle = o.text;
    ctx.fillText(String(Math.ceil(left)), 540, o.bigY);
  }
  ctx.restore();
}
