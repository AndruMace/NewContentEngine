import type { Ctx2D, Rng } from '@sim/engine';
import * as dm from '@sim/physics/math';

/** Visual-only particle bursts shared by templates. Lives in sim state but never touches physics. */
export interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

export function burst(list: Spark[], rng: Rng, x: number, y: number, n: number, power: number, color: string | (() => string), size = 6) {
  for (let k = 0; k < n; k++) {
    const a = rng.range(0, Math.PI * 2);
    const v = rng.range(0.25, 1) * power;
    const life = rng.range(0.5, 1.4);
    list.push({
      x,
      y,
      vx: dm.cos(a) * v,
      vy: dm.sin(a) * v,
      life,
      maxLife: life,
      size: rng.range(0.6, 1.4) * size,
      color: typeof color === 'function' ? color() : color,
    });
  }
}

export function updateSparks(list: Spark[], dt: number, gravity: number): Spark[] {
  for (const p of list) {
    p.vy += gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
  }
  return list.length && list.some((p) => p.life <= 0) ? list.filter((p) => p.life > 0) : list;
}

export function drawSparks(ctx: Ctx2D, list: Spark[]) {
  for (const p of list) {
    ctx.globalAlpha = Math.min(1, (p.life / p.maxLife) * 1.5);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

export interface Team {
  label: string;
  color: string;
  icon?: string;
}

export const COUNTRY_TEAMS: Team[] = [
  { label: 'USA', icon: '🇺🇸', color: '#2f5bd3' },
  { label: 'Brazil', icon: '🇧🇷', color: '#16a34a' },
  { label: 'Japan', icon: '🇯🇵', color: '#e11d48' },
  { label: 'Germany', icon: '🇩🇪', color: '#facc15' },
  { label: 'France', icon: '🇫🇷', color: '#60a5fa' },
  { label: 'UK', icon: '🇬🇧', color: '#b91c1c' },
  { label: 'India', icon: '🇮🇳', color: '#fb923c' },
  { label: 'Canada', icon: '🇨🇦', color: '#ef4444' },
  { label: 'Mexico', icon: '🇲🇽', color: '#15803d' },
  { label: 'Italy', icon: '🇮🇹', color: '#22c55e' },
  { label: 'Spain', icon: '🇪🇸', color: '#f59e0b' },
  { label: 'Korea', icon: '🇰🇷', color: '#e5e7eb' },
  { label: 'Australia', icon: '🇦🇺', color: '#1e40af' },
  { label: 'Argentina', icon: '🇦🇷', color: '#7dd3fc' },
  { label: 'Nigeria', icon: '🇳🇬', color: '#059669' },
  { label: 'Sweden', icon: '🇸🇪', color: '#0ea5e9' },
];

export const COLOR_TEAMS: Team[] = [
  { label: 'Red', color: '#ff3b3b' },
  { label: 'Blue', color: '#3b82f6' },
  { label: 'Yellow', color: '#ffd60a' },
  { label: 'Green', color: '#22c55e' },
  { label: 'Purple', color: '#a855f7' },
  { label: 'Orange', color: '#ff8c1a' },
  { label: 'Pink', color: '#ff5fa2' },
  { label: 'Cyan', color: '#22d3ee' },
  { label: 'White', color: '#f5f5f5' },
  { label: 'Lime', color: '#a3e635' },
  { label: 'Teal', color: '#14b8a6' },
  { label: 'Gold', color: '#d4af37' },
  { label: 'Navy', color: '#1e3a8a' },
  { label: 'Brown', color: '#a0522d' },
  { label: 'Silver', color: '#b8bcc6' },
  { label: 'Black', color: '#2a2a2a' },
];

/** Pick n distinct teams in a seeded order. Pools are ordered most-distinct first, so prefer the head. */
export function pickTeams(pool: Team[], n: number, rng: Rng): Team[] {
  const idx = pool.slice(0, Math.max(n, 8)).map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).map((i) => pool[i]);
}

const rgbOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Pick n teams whose colours are clearly different (for templates where team colour fills large
 * areas, e.g. Territory War). Falls back to the closest-spaced remaining teams if the pool runs out.
 */
export function pickDistinctTeams(pool: Team[], n: number, rng: Rng, minDistance = 120): Team[] {
  const order = pool.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const dist = (a: Team, b: Team) => {
    const [r1, g1, b1] = rgbOf(a.color);
    const [r2, g2, b2] = rgbOf(b.color);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  };
  const chosen: Team[] = [];
  for (const i of order) {
    if (chosen.length === n) break;
    if (chosen.every((c) => dist(c, pool[i]) >= minDistance)) chosen.push(pool[i]);
  }
  for (const i of order) {
    if (chosen.length === n) break;
    if (!chosen.includes(pool[i])) chosen.push(pool[i]);
  }
  return chosen;
}

/** Draw a team ball: flag filling the ball (or colour + initial), team-colour rim, glossy highlight. */
export function drawTeamBall(ctx: Ctx2D, x: number, y: number, r: number, team: Team, fontFamily: string, opts: { initial?: boolean } = {}) {
  ctx.save();
  ctx.fillStyle = team.color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (team.icon) {
    ctx.save();
    ctx.clip();
    ctx.font = `${Math.round(r * 2.9)}px ${fontFamily}`;
    ctx.fillText(team.icon, x, y + r * 0.12);
    ctx.restore();
  } else if (opts.initial !== false) {
    ctx.font = `900 ${Math.round(r * 0.95)}px ${fontFamily}`;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(team.label[0], x, y + r * 0.05);
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(3, r * 0.16);
  ctx.strokeStyle = team.icon ? team.color : '#ffffff';
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(x, y, r + Math.max(1.5, r * 0.08), 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(x - r * 0.35, y - r * 0.38, r * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A broken-off piece of a team ball (visual only). */
export interface Shard {
  /** Polygon around the shard's pivot (flat x,y pairs). */
  pts: number[];
  /** Where the ball's centre sits relative to the pivot, so the flag/colour lines up. */
  bx: number;
  by: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  life: number;
  maxLife: number;
  r: number;
  team: Team;
}

/** Break a team ball into n jagged wedges flying outward. */
export function shatter(list: Shard[], rng: Rng, x: number, y: number, r: number, team: Team, n = 12, power = 560) {
  const cuts = Array.from({ length: n }, (_, k) => ((k + rng.range(-0.35, 0.35)) / n) * Math.PI * 2).sort((a, b) => a - b);
  const cx = rng.range(-0.22, 0.22) * r;
  const cy = rng.range(-0.22, 0.22) * r;
  for (let k = 0; k < n; k++) {
    const a0 = cuts[k];
    const a1 = k + 1 < n ? cuts[k + 1] : cuts[0] + Math.PI * 2;
    const poly: number[] = [cx, cy];
    const steps = 3;
    for (let j = 0; j <= steps; j++) {
      const a = a0 + ((a1 - a0) * j) / steps;
      const rr = r * (j === 0 || j === steps ? 1 : rng.range(0.97, 1.02));
      poly.push(dm.cos(a) * rr, dm.sin(a) * rr);
    }
    let gx = 0;
    let gy = 0;
    for (let i = 0; i < poly.length; i += 2) {
      gx += poly[i];
      gy += poly[i + 1];
    }
    gx /= poly.length / 2;
    gy /= poly.length / 2;
    const d = Math.sqrt(gx * gx + gy * gy) || 1;
    const v = power * rng.range(0.5, 1.15);
    const life = rng.range(1.1, 1.7);
    list.push({
      pts: poly.map((p, i) => p - (i % 2 ? gy : gx)),
      bx: -gx,
      by: -gy,
      x: x + gx,
      y: y + gy,
      vx: (gx / d) * v + rng.range(-80, 80),
      vy: (gy / d) * v + rng.range(-80, 80) - 120,
      rot: 0,
      vr: rng.range(-9, 9),
      life,
      maxLife: life,
      r,
      team,
    });
  }
}

export function updateShards(list: Shard[], dt: number, gravity: number): Shard[] {
  for (const s of list) {
    s.vy += gravity * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vx *= 1 - 0.6 * dt;
    s.rot += s.vr * dt;
    s.life -= dt;
  }
  return list.some((s) => s.life <= 0) ? list.filter((s) => s.life > 0) : list;
}

export function drawShards(ctx: Ctx2D, list: Shard[], fontFamily: string) {
  for (const s of list) {
    const a = Math.min(1, s.life / (s.maxLife * 0.45));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(s.x, s.y);
    ctx.rotate(s.rot);
    ctx.beginPath();
    ctx.moveTo(s.pts[0], s.pts[1]);
    for (let i = 2; i < s.pts.length; i += 2) ctx.lineTo(s.pts[i], s.pts[i + 1]);
    ctx.closePath();
    ctx.save();
    ctx.clip();
    drawTeamBall(ctx, s.bx, s.by, s.r, s.team, fontFamily, { initial: false });
    ctx.restore();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.restore();
  }
}
