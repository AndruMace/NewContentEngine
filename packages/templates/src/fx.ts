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

/** Draw a team ball: flag filling the ball (or colour + initial), team-colour rim, glossy highlight. */
export function drawTeamBall(ctx: Ctx2D, x: number, y: number, r: number, team: Team, fontFamily: string) {
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
  } else {
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
