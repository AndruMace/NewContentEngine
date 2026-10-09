/**
 * Ball Battle weapons: stats, how each one levels up when it lands a hit, the shapes used for
 * hit/clash detection, and how each one is drawn. Geometry is in the fighter's local frame:
 * +x points out from the ball along the weapon's angle.
 */
import type { Ctx2D, Rng } from '@sim/engine';
import { lighten, hexToRgb, rgbToCss } from '@sim/engine';
import * as dm from '@sim/physics/math';

export type WeaponId = 'sword' | 'dagger' | 'hammer' | 'bow';
export const WEAPON_IDS: WeaponId[] = ['sword', 'dagger', 'hammer', 'bow'];

export interface WeaponDef {
  id: WeaponId;
  name: string;
  emoji: string;
  /** Damage per hit, rolled uniformly (integers) from the physics RNG so every seed replays exactly. */
  damage: [number, number];
  /** Base spin in rad/s. */
  spin: number;
  /** Hit freeze multiplier (heavier weapons hit harder). */
  freeze: number;
  /** Extra speed given to the target on hit (0 = just redirect). */
  knock: number;
  /** Clash power: in a clash the weaker weapon is knocked into reverse; equal ones both reverse. */
  clash: number;
  /** Blade length / handle length at level 1 (px at scale 1). */
  length: number;
  /** Hammer head radius at level 1. */
  head: number;
  /** Per-hit growth: sword/hammer length (px), dagger spin (rad/s), hammer head (px). */
  grow: number;
  /** Bow: seconds between volleys. */
  reload: number;
  /** Each upgrade is this fraction of the previous one (1 = linear growth). */
  decay: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  // Balanced on seeded 1v1 sweeps (normal and fast fights): every weapon wins 47-53% overall and
  // no matchup is worse than 40/60. Re-check with a win-rate sweep after changing any of these.
  sword: { id: 'sword', name: 'Sword', emoji: '⚔️', damage: [9, 11], spin: 5.2, freeze: 1, knock: 0.25, clash: 3, length: 100, head: 0, grow: 18, reload: 0, decay: 0.75 },
  dagger: { id: 'dagger', name: 'Daggers', emoji: '🗡️', damage: [5, 7], spin: 6.6, freeze: 0.7, knock: 0.15, clash: 1, length: 50, head: 0, grow: 0.85, reload: 0, decay: 1 },
  hammer: { id: 'hammer', name: 'Hammer', emoji: '🔨', damage: [11, 14], spin: 1.8, freeze: 1.8, knock: 0.8, clash: 2, length: 64, head: 20, grow: 2.2, reload: 0, decay: 1 },
  bow: { id: 'bow', name: 'Bow', emoji: '🏹', damage: [5, 6], spin: 1.9, freeze: 0.6, knock: 0.2, clash: 1, length: 0, head: 0, grow: 1, reload: 0.9, decay: 1 },
};

/** Per-fighter weapon state. Dimensions are in pixels and already include the size scale. */
export interface Weapon {
  id: WeaponId;
  /** Hits landed (each one upgrades the weapon). */
  level: number;
  /** Size multiplier (the giant's weapons are bigger). */
  scale: number;
  dmgScale: number;
  growth: number;
  /** Signed spin, rad/s. */
  spin: number;
  /** Sword/dagger blade length, hammer handle length. */
  length: number;
  /** Hammer head radius. */
  head: number;
  /** Bow: arrows per volley, seconds between volleys, time until the next volley. */
  volley: number;
  reload: number;
  cooldown: number;
  /** Starting values, for resetting between bracket matches. */
  base: { spin: number; length: number; head: number; reload: number };
}

export function makeWeapon(id: WeaponId, opts: { scale: number; dmgScale: number; growth: number; spinScale: number; rng: Rng }): Weapon {
  const def = WEAPONS[id];
  const sc = opts.scale;
  const w: Omit<Weapon, 'base'> = {
    id,
    level: 0,
    scale: sc,
    dmgScale: opts.dmgScale,
    growth: opts.growth,
    spin: (opts.rng.chance(0.5) ? 1 : -1) * def.spin * opts.spinScale * opts.rng.range(0.9, 1.1) * (sc > 1 ? 0.75 : 1),
    length: def.length * sc,
    head: def.head * sc,
    volley: 1,
    reload: def.reload,
    cooldown: opts.rng.range(0.3, 0.9),
  };
  return { ...w, base: { spin: Math.abs(w.spin), length: w.length, head: w.head, reload: w.reload } };
}

/** Back to level 1 (keeps the current spin direction). */
export function resetWeapon(w: Weapon) {
  w.level = 0;
  w.spin = (w.spin < 0 ? -1 : 1) * w.base.spin;
  w.length = w.base.length;
  w.head = w.base.head;
  w.reload = w.base.reload;
  w.volley = 1;
  w.cooldown = Math.min(w.cooldown, 0.6);
}

/** Level up after landing a hit. */
export function upgrade(w: Weapon) {
  w.level++;
  const g = w.growth;
  const grow = WEAPONS[w.id].grow * dm.pow(WEAPONS[w.id].decay, w.level - 1);
  switch (w.id) {
    case 'sword':
      w.length += grow * w.scale * g;
      break;
    case 'dagger': {
      const sign = w.spin < 0 ? -1 : 1;
      w.spin = sign * Math.min(19, Math.abs(w.spin) + grow * g);
      break;
    }
    case 'hammer':
      w.head = Math.min(52 * w.scale, w.head + grow * w.scale * g);
      w.length += 4 * w.scale * g;
      break;
    case 'bow':
      w.volley = Math.min(7, 1 + Math.round(w.level * g));
      w.reload = Math.max(0.6, w.reload * (1 - 0.03 * g));
      break;
  }
}

export function rollDamage(w: Weapon, rng: Rng): number {
  const [lo, hi] = WEAPONS[w.id].damage;
  return Math.max(1, Math.round(rng.int(lo, hi) * w.dmgScale));
}

export const maxDamage = (w: Weapon) => Math.round(WEAPONS[w.id].damage[1] * w.dmgScale);

/** Short HUD readout of how far the weapon has grown. */
export function weaponStat(w: Weapon): string {
  switch (w.id) {
    case 'sword':
    case 'hammer':
    case 'dagger':
      return `Lv ${w.level + 1}`;
    case 'bow':
      return `×${w.volley}`;
  }
}

/** A capsule: segment a→b with radius r. `damage` parts hurt balls; all parts can clash. */
export interface Part {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
  damage: boolean;
}

/** Weapon parts in local coordinates (x outward from the ball centre). */
export function localParts(w: Weapon, ballR: number): Part[] {
  const sc = w.scale;
  switch (w.id) {
    case 'sword': {
      const g = ballR + 2 * sc;
      return [{ ax: g + 4 * sc, ay: 0, bx: ballR + w.length, by: 0, r: 7 * sc, damage: true }];
    }
    case 'dagger': {
      const a = ballR + 6 * sc;
      const b = ballR + 4 * sc + w.length;
      return [
        { ax: a, ay: 0, bx: b, by: 2 * sc, r: 6 * sc, damage: true },
        { ax: -a, ay: 0, bx: -b, by: -2 * sc, r: 6 * sc, damage: true },
      ];
    }
    case 'hammer': {
      const hx = ballR + w.length;
      return [
        { ax: ballR, ay: 0, bx: hx - w.head * 0.5, by: 0, r: 5 * sc, damage: false },
        { ax: hx, ay: 0, bx: hx, by: 0, r: w.head, damage: true },
      ];
    }
    case 'bow': {
      const span = ballR * 0.95 + 16 * sc;
      const x = ballR + 26 * sc;
      return [{ ax: x, ay: -span * 0.8, bx: x, by: span * 0.8, r: 5 * sc, damage: false }];
    }
  }
}

/** Local blade tips (for swoosh trails). */
export function localTips(w: Weapon, ballR: number): { x: number; y: number }[] {
  switch (w.id) {
    case 'sword':
      return [{ x: ballR + w.length, y: 0 }];
    case 'dagger':
      return [
        { x: ballR + 4 * w.scale + w.length, y: 2 * w.scale },
        { x: -(ballR + 4 * w.scale + w.length), y: -2 * w.scale },
      ];
    case 'hammer':
      return [{ x: ballR + w.length, y: 0 }];
    case 'bow':
      return [];
  }
}

// ---- drawing ----------------------------------------------------------------------------------

const steel = (ctx: Ctx2D, half: number) => {
  const g = ctx.createLinearGradient(0, -half, 0, half);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.42, '#d5dbe6');
  g.addColorStop(0.5, '#8e97aa');
  g.addColorStop(0.58, '#c9d0dc');
  g.addColorStop(1, '#f4f6fa');
  return g;
};

const GOLD = '#e0b23a';
const GOLD_DARK = '#9a7414';
const WOOD = '#8a5a2b';
const WOOD_DARK = '#5b3818';

/** Draw the weapon in the fighter's local frame (call after translate+rotate to the ball). */
export function drawWeapon(ctx: Ctx2D, w: Weapon, ballR: number, teamColor: string) {
  const sc = w.scale;
  const team = rgbToCss(hexToRgb(teamColor));
  const teamLight = rgbToCss(lighten(hexToRgb(teamColor), 0.35));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  switch (w.id) {
    case 'sword': {
      const g = ballR + 2 * sc;
      const tip = ballR + w.length;
      const half = 8 * sc;
      // Grip (mostly hidden by the ball) and crossguard with a team-coloured gem.
      ctx.fillStyle = '#3a2618';
      ctx.fillRect(ballR - 14 * sc, -4 * sc, 16 * sc, 8 * sc);
      // Blade: long taper to a sharp point, steel gradient, central fuller, bright edge.
      ctx.beginPath();
      ctx.moveTo(g + 3 * sc, -half);
      ctx.lineTo(tip - half * 2.4, -half * 0.8);
      ctx.lineTo(tip, 0);
      ctx.lineTo(tip - half * 2.4, half * 0.8);
      ctx.lineTo(g + 3 * sc, half);
      ctx.closePath();
      ctx.fillStyle = steel(ctx, half);
      ctx.fill();
      ctx.lineWidth = 1.6 * sc;
      ctx.strokeStyle = 'rgba(30,36,50,0.7)';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(g + 8 * sc, 0);
      ctx.lineTo(tip - half * 3, 0);
      ctx.lineWidth = 2.6 * sc;
      ctx.strokeStyle = 'rgba(80,92,115,0.75)';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(g + 6 * sc, -half + 1.5 * sc);
      ctx.lineTo(tip - half * 2.4, -half * 0.8 + 1.5 * sc);
      ctx.lineWidth = 1.2 * sc;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
      // Crossguard.
      ctx.beginPath();
      ctx.roundRect(g - 3 * sc, -21 * sc, 8 * sc, 42 * sc, 4 * sc);
      ctx.fillStyle = GOLD;
      ctx.fill();
      ctx.lineWidth = 1.5 * sc;
      ctx.strokeStyle = GOLD_DARK;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(g + 1 * sc, 0, 4.5 * sc, 0, Math.PI * 2);
      ctx.fillStyle = teamLight;
      ctx.fill();
      ctx.strokeStyle = GOLD_DARK;
      ctx.stroke();
      break;
    }
    case 'dagger': {
      for (const side of [1, -1]) {
        ctx.save();
        ctx.scale(side, side);
        const x0 = ballR + 4 * sc;
        const L = w.length;
        // Team-coloured grip wrap and a small swept guard.
        ctx.fillStyle = team;
        ctx.fillRect(ballR - 10 * sc, -4 * sc, 14 * sc, 8 * sc);
        ctx.beginPath();
        ctx.moveTo(x0 - 1 * sc, -13 * sc);
        ctx.quadraticCurveTo(x0 + 5 * sc, 0, x0 - 1 * sc, 13 * sc);
        ctx.lineWidth = 5 * sc;
        ctx.strokeStyle = GOLD;
        ctx.stroke();
        // Curved blade.
        ctx.beginPath();
        ctx.moveTo(x0 + 2 * sc, -6.5 * sc);
        ctx.quadraticCurveTo(x0 + L * 0.62, -11 * sc, x0 + L, 3 * sc);
        ctx.quadraticCurveTo(x0 + L * 0.55, 1 * sc, x0 + 2 * sc, 6.5 * sc);
        ctx.closePath();
        ctx.fillStyle = steel(ctx, 7 * sc);
        ctx.fill();
        ctx.lineWidth = 1.4 * sc;
        ctx.strokeStyle = 'rgba(30,36,50,0.7)';
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x0 + 6 * sc, -5 * sc);
        ctx.quadraticCurveTo(x0 + L * 0.6, -9 * sc, x0 + L - 3 * sc, 1.5 * sc);
        ctx.lineWidth = 1.1 * sc;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
        ctx.restore();
      }
      break;
    }
    case 'hammer': {
      const hx = ballR + w.length;
      // Drawn a little larger than its hit circle so it reads at phone size.
      const hw = w.head * 1.35;
      const hh = w.head * 2.5;
      // Wooden handle with grain and a leather wrap.
      const wood = ctx.createLinearGradient(0, -6 * sc, 0, 6 * sc);
      wood.addColorStop(0, '#b07a42');
      wood.addColorStop(0.5, WOOD);
      wood.addColorStop(1, WOOD_DARK);
      ctx.fillStyle = wood;
      ctx.beginPath();
      ctx.roundRect(ballR - 12 * sc, -6 * sc, hx - ballR + 12 * sc, 12 * sc, 5 * sc);
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,22,8,0.55)';
      ctx.lineWidth = 1.2 * sc;
      for (let k = 1; k < 4; k++) {
        const y = -6 * sc + k * 3 * sc;
        ctx.beginPath();
        ctx.moveTo(ballR + 4 * sc, y);
        ctx.lineTo(hx - hw * 0.6, y + (k % 2 ? 0.8 : -0.8) * sc);
        ctx.stroke();
      }
      ctx.fillStyle = team;
      ctx.fillRect(ballR + 2 * sc, -7 * sc, 14 * sc, 14 * sc);
      // Iron head with a team-coloured band and rivets.
      const iron = ctx.createLinearGradient(hx - hw / 2, 0, hx + hw / 2, 0);
      iron.addColorStop(0, '#4b5261');
      iron.addColorStop(0.35, '#c7cdd8');
      iron.addColorStop(0.55, '#8b93a3');
      iron.addColorStop(1, '#3d4350');
      ctx.fillStyle = iron;
      ctx.beginPath();
      ctx.roundRect(hx - hw / 2, -hh / 2, hw, hh, 6 * sc);
      ctx.fill();
      ctx.lineWidth = 2 * sc;
      ctx.strokeStyle = '#262a33';
      ctx.stroke();
      // Striking faces.
      ctx.fillStyle = '#e9edf3';
      ctx.fillRect(hx - hw / 2 + 2 * sc, -hh / 2 + 1 * sc, hw - 4 * sc, 4 * sc);
      ctx.fillRect(hx - hw / 2 + 2 * sc, hh / 2 - 5 * sc, hw - 4 * sc, 4 * sc);
      ctx.fillStyle = team;
      ctx.fillRect(hx - hw / 2, -hh * 0.14, hw, hh * 0.28);
      ctx.fillStyle = '#20242c';
      for (const [rx, ry] of [
        [-0.28, -0.32],
        [0.28, -0.32],
        [-0.28, 0.32],
        [0.28, 0.32],
      ]) {
        ctx.beginPath();
        ctx.arc(hx + rx * hw, ry * hh, 2.2 * sc, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'bow': {
      const span = ballR * 0.95 + 16 * sc;
      const x = ballR + 12 * sc;
      // Draw-back: the string is pulled further as the next volley gets close.
      const ready = 1 - Math.max(0, Math.min(1, w.cooldown / w.reload));
      const pull = 22 * sc * ready * ready;
      // String.
      ctx.beginPath();
      ctx.moveTo(x + 4 * sc, -span);
      ctx.lineTo(x - pull, 0);
      ctx.lineTo(x + 4 * sc, span);
      ctx.lineWidth = 1.8 * sc;
      ctx.strokeStyle = '#f6efdc';
      ctx.stroke();
      // Nocked arrow(s) once it's mostly drawn.
      if (ready > 0.35) {
        const n = Math.min(w.volley, 4);
        for (let k = 0; k < n; k++) {
          const off = (k - (n - 1) / 2) * 7 * sc;
          drawArrowShape(ctx, x - pull + 46 * sc, off, 0, sc, teamColor, ready);
        }
      }
      // Recurve limbs: dark outline, wood, light highlight; team-coloured grip.
      const limb = () => {
        ctx.beginPath();
        ctx.moveTo(x + 4 * sc, -span);
        ctx.quadraticCurveTo(x + 20 * sc, -span * 0.95, x + 26 * sc, -span * 0.45);
        ctx.quadraticCurveTo(x + 32 * sc, 0, x + 26 * sc, span * 0.45);
        ctx.quadraticCurveTo(x + 20 * sc, span * 0.95, x + 4 * sc, span);
      };
      limb();
      ctx.lineWidth = 12 * sc;
      ctx.strokeStyle = '#3a220d';
      ctx.stroke();
      limb();
      ctx.lineWidth = 8 * sc;
      ctx.strokeStyle = WOOD;
      ctx.stroke();
      limb();
      ctx.lineWidth = 2.5 * sc;
      ctx.strokeStyle = '#d29a5b';
      ctx.stroke();
      ctx.fillStyle = team;
      ctx.beginPath();
      ctx.roundRect(x + 22 * sc, -12 * sc, 10 * sc, 24 * sc, 3 * sc);
      ctx.fill();
      // Limb tips.
      ctx.fillStyle = GOLD;
      for (const y of [-span, span]) {
        ctx.beginPath();
        ctx.arc(x + 4 * sc, y, 3.5 * sc, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }
}

/** Arrow pointing along +x with its tip at (x, y). */
export function drawArrowShape(ctx: Ctx2D, x: number, y: number, angle: number, sc: number, teamColor: string, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(angle);
  const L = 58 * sc;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-L, 0);
  ctx.lineTo(-8 * sc, 0);
  ctx.lineWidth = 3.2 * sc;
  ctx.strokeStyle = '#c99a62';
  ctx.stroke();
  // Head.
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-13 * sc, -6 * sc);
  ctx.lineTo(-10 * sc, 0);
  ctx.lineTo(-13 * sc, 6 * sc);
  ctx.closePath();
  ctx.fillStyle = '#e8ecf2';
  ctx.fill();
  ctx.lineWidth = 1 * sc;
  ctx.strokeStyle = '#4a5160';
  ctx.stroke();
  // Fletching in team colour.
  ctx.fillStyle = teamColor;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(-L + 2 * sc, 0);
    ctx.lineTo(-L - 4 * sc, s * 7 * sc);
    ctx.lineTo(-L + 14 * sc, s * 2 * sc);
    ctx.lineTo(-L + 12 * sc, 0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Rotate a local point by `a` (cos/sin precomputed) and translate to the ball. */
export function toWorld(lx: number, ly: number, x: number, y: number, c: number, s: number) {
  return { x: x + c * lx - s * ly, y: y + s * lx + c * ly };
}
