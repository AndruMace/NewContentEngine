/**
 * Poses for the procedural creatures, computed from a fighter's sim state alone: the gait from the
 * distance walked, the head tracking its target, crouches and flinches, every attack's motion keyed
 * to the move's own timing (hits land exactly where the sim lands them), grapples, being held, and
 * falling. Angles in radians; "yaw" turns towards the animal's left, "pitch" tips the nose down.
 */
import { strideFor, type MoveDef } from '../roster';
import type { FighterView } from '../index';
import { condition, isBiped, severity, type HurtKey } from '../sim';
import { restPose, type LegName, type PoseIn } from './rig';
import { SPECIES } from './species';
import { limbFor } from './contact';
import type { V3 } from './builder';

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const sat = (x: number) => clamp(x, 0, 1);
const ease = (x: number) => {
  const t = sat(x);
  return t * t * (3 - 2 * t);
};
/** 0 → 1 between a and b. */
const ramp = (u: number, a: number, b: number) => ease((u - a) / (b - a));
/** 0 → 1 → 0: up from a to the peak, back down by b. */
const pulse = (u: number, a: number, peak: number, b: number) => (u < peak ? ramp(u, a, peak) : 1 - ramp(u, peak, b));
const wrap = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpV = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

const home = (kind: keyof typeof SPECIES, leg: LegName): V3 => SPECIES[kind].legs.find((l) => l.name === leg)!.home;

/** Where the target is, relative to the fighter's facing (positive: to its right). */
function aimOf(f: FighterView, others: FighterView[]) {
  const t = others.find((o) => o.idx === f.target);
  if (!t) return { rel: 0, t: null as FighterView | null };
  return { rel: wrap(Math.atan2(t.y - f.y, t.x - f.x) - f.heading), t };
}

/** A death roll's spin at a moment (both the roller and its prey turn with it). */
export const rollAngle = (roller: { idx: number; grab: { t0: number } | null }, simT: number) => (simT - roller.grab!.t0) * Math.PI * 2 * 1.4 * (roller.idx % 2 ? 1 : -1);

/** The grapple this fighter is in, from either side. */
function heldInfo(f: FighterView, others: FighterView[]) {
  const by = others.find((o) => o.grab && o.grab.target === f.idx);
  return by ? { by, g: by.grab!, self: f } : null;
}

const moveOf = (f: FighterView): MoveDef | null => (f.state === 'attack' && f.moveIdx >= 0 ? f.def.moves[f.moveIdx] : null);

/** A direction in the world (an angle on the floor) in a fighter's own model space (x: its left, z: ahead). */
const toModel = (f: FighterView, ang: number) => {
  const r = wrap(ang - f.heading);
  return { x: -Math.sin(r), z: Math.cos(r) };
};

/** Shared base: gait, head tracking, turning bend, recoil from the last hit, a hop back from a blow it read. */
function base(f: FighterView, simT: number, others: FighterView[]): { p: PoseIn; rel: number; t: FighterView | null; flinch: number; side: number } {
  const p = restPose();
  const proc = f.def.proc!;
  p.speed = Math.abs(f.spd);
  p.stride = strideFor(proc, p.speed);
  p.gait = f.gait;
  p.time = simT + f.idx * 1.37;
  const { rel, t } = aimOf(f, others);
  const look = clamp(-rel, -1, 1);
  p.neckYaw = look * 0.6;
  p.headYaw = look * 0.35;
  p.spineYaw = clamp(-f.yawRate * 0.22, -0.45, 0.45);
  const flinch = Math.exp(-Math.max(0, simT - f.lastHitT) * 7);
  // Which way the blow came from (positive: from its left).
  const side = Math.sign(wrap(f.lastHitDir - f.heading)) || 1;
  p.chestPitch -= flinch * 0.12;
  p.roll += flinch * 0.12 * side;
  p.headYaw += flinch * 0.25 * side;
  // Recoil: the body is shoved the way the blow pushed it (harder the harder the blow), then sways back.
  const age = Math.max(0, simT - f.lastHitT);
  const pow = Math.min(2, f.lastHitPow);
  const k = (age < 0.05 ? age / 0.05 : Math.exp(-(age - 0.05) * 6) * Math.cos((age - 0.05) * 9)) * pow;
  if (Math.abs(k) > 0.002) {
    const d = toModel(f, f.lastHitDir);
    const sz = f.def.proc.kind === 'fox' ? 0.5 : 1;
    p.lean = [p.lean[0] + d.x * 0.13 * k * sz, p.lean[1] - 0.03 * Math.abs(k), p.lean[2] + d.z * 0.13 * k * sz];
    p.roll -= d.x * 0.16 * k;
    p.chestPitch += d.z * 0.18 * k;
    p.headYaw += d.x * 0.35 * k;
    p.neckPitch -= 0.12 * Math.abs(k);
  }
  // Slipping a blow: ducks and pulls its head back as it hops away.
  const ev = pulse(simT - f.evadeT, 0, 0.12, 0.45);
  if (ev > 0) {
    p.y -= 0.06 * ev * SPECIES[f.def.proc.kind].rollY;
    p.neckPitch -= 0.3 * ev;
    p.chestPitch -= 0.08 * ev;
  }
  return { p, rel, t, flinch, side };
}

/** Knocked off its feet: thrown onto its side, struggling, then scrambling back up. */
function knocked(p: PoseIn, f: FighterView, simT: number, lie: number, roll: number) {
  const t = simT - f.stateT;
  const e = ramp(t, 0, 0.28) * (1 - ramp(t, f.downLen - 0.5, f.downLen));
  p.roll = -roll * f.fallDir * e;
  p.y = -lie * e;
  p.pitch *= 1 - e;
  p.chestPitch = 0;
  p.neckPitch = (-0.35 + Math.sin(t * 7) * 0.12) * e;
  p.jaw = 0.35 * e;
  p.tailWave = 0.4 * e;
  p.gaitScale = 0;
  p.wingFold = Math.max(p.wingFold, 0.6 * e);
  p.wingFlap = -0.2 * e + p.wingFlap * (1 - e);
  // Legs kick while it is down, and get back under it as it rises.
  if (e > 0.45) for (const l of limbsOf(f)) p.legs[l] = 'relax';
}

/**
 * Injuries, over whatever it is doing: it limps on a hurt leg (holding it up when it stands), a hurt arm
 * hangs, a blow to the head leaves it dazed (head low and swaying), a battered body or exhaustion has it
 * panting with its head down, a torn wing hangs.
 */
export function wounded(p: PoseIn, f: FighterView, simT: number) {
  if (!f.alive || f.state === 'down' || f.state === 'held') return;
  const spec = SPECIES[f.def.proc.kind];
  const c = condition(f);
  const limbs: [HurtKey, 'fore' | 'hind', 1 | -1][] = [
    ['LF', 'fore', 1],
    ['RF', 'fore', -1],
    ['LH', 'hind', 1],
    ['RH', 'hind', -1],
  ];
  for (const [key, zone, side] of limbs) {
    const sv = severity(f.hurt[key]);
    if (sv < 0.12) continue;
    const name = limbFor(spec, zone, side);
    const leg = name ? spec.legs.find((l) => l.name === name) : undefined;
    if (!leg) continue;
    if (leg.arm) {
      const v = p.legs[leg.name];
      if (Array.isArray(v) && f.state !== 'attack') p.legs[leg.name] = [v[0], v[1] - 0.35 * sv, v[2] - 0.12 * sv];
    } else p.limp[leg.name] = Math.max(p.limp[leg.name] ?? 0, sv);
  }
  const t = simT + f.idx * 1.7;
  const h = c.head;
  p.neckPitch += 0.22 * h;
  p.headYaw += Math.sin(t * 1.7) * 0.2 * h;
  p.headPitch += Math.sin(t * 2.3) * 0.08 * h;
  p.roll += Math.sin(t * 1.1) * 0.04 * h;
  const b = Math.max(c.body, c.spent);
  p.breath = Math.max(p.breath, 1 + 2 * b);
  if (!isBiped(f.def) && f.state !== 'attack' && f.state !== 'grab') p.jaw = Math.max(p.jaw, b * 0.35 * (0.55 + 0.45 * Math.sin(simT * 8 + f.idx)));
  p.neckPitch += 0.14 * c.spent;
  p.y -= 0.04 * c.spent * spec.rollY;
  if (spec.wings && c.wing > 0) {
    let l = 0;
    let r = 0;
    for (const w of f.wounds) if (w.zone === 'wing' && w.t <= simT) w.side > 0 ? l++ : r++;
    p.wingHurt = [c.wing * (l >= r ? 1 : 0.4), c.wing * (r >= l ? 1 : 0.4)];
  }
}

/** Lying on its side (or back), legs limp. */
function fallen(p: PoseIn, f: FighterView, simT: number, lie: number, roll: number) {
  const e = ramp(simT - f.diedAt, 0, 0.55);
  // Falls away from the blow that felled it.
  p.roll = -roll * e * f.fallDir;
  p.y = -lie * e;
  p.pitch = 0;
  p.chestPitch = 0;
  p.neckPitch = 0.3 * e;
  p.jaw = 0.25 * e;
  p.tailWave = 0;
  p.gaitScale = 0;
  p.wingFold = e;
  for (const l of limbsOf(f)) p.legs[l] = 'relax';
}

/** All of a fighter's limb names (four legs, a spider's eight, a person's arms and legs). */
const limbsOf = (f: FighterView): LegName[] => SPECIES[f.def.proc!.kind].legs.map((l) => l.name);

/** Thrashing in someone's grip (spun over and over in a death roll). */
function struggling(p: PoseIn, simT: number, held: { by: FighterView; g: NonNullable<FighterView['grab']>; self: FighterView }) {
  p.roll = held.g.kind === 'roll' ? rollAngle(held.by, simT) * 0.9 : Math.sin(simT * 13) * 0.4;
  p.y = -0.15;
  p.jaw = 0.6;
  p.neckPitch = -0.3;
  p.tailWave = 0.5;
  p.gaitScale = 0;
  for (const l of limbsOf(held.self)) p.legs[l] = 'relax';
}

export function lionPose(f: FighterView, simT: number, others: FighterView[]): PoseIn {
  const { p, t } = base(f, simT, others);
  p.tailPitch = -0.25;
  p.tailWave = 0.12;
  if (!f.alive) {
    fallen(p, f, simT, 0.5, 1.45);
    return p;
  }
  const held = f.state === 'held' ? heldInfo(f, others) : null;
  if (held) {
    struggling(p, simT, held);
    return p;
  }
  if (f.state === 'down') {
    knocked(p, f, simT, 0.5, 1.45);
    return p;
  }
  // Stalking crouch: belly to the ground, head low, tail tip twitching.
  const c = f.crouch;
  p.y -= 0.24 * c;
  p.chestPitch += 0.06 * c;
  p.neckPitch += 0.35 * c;
  p.headPitch -= 0.2 * c;
  p.tailYaw += Math.sin(simT * 7) * 0.35 * c;
  const m = moveOf(f);
  const u = m ? (simT - f.stateT) / m.len : 0;
  if (f.state === 'grab' && f.grab?.kind === 'latch') {
    // Reared onto its prey, forepaws hooked over its back, jaws locked on and shaking.
    const v = others.find((o) => o.idx === f.grab!.target);
    const h = v ? v.def.height * (v.hover > 0.3 ? 1.3 : 0.75) : 1;
    const e = ramp(simT - f.grab.t0, 0, 0.2);
    p.pitch = -0.45 * e * clamp(h / 1.2, 0.3, 1);
    p.y = 0.05 * e;
    p.legs.LF = lerpV(home('lion', 'LF'), [0.22, clamp(h, 0.3, 1.5), 0.62], e);
    p.legs.RF = lerpV(home('lion', 'RF'), [-0.22, clamp(h, 0.3, 1.5), 0.62], e);
    p.gaitScale = 0;
    p.neckPitch = 0.35;
    p.headPitch = 0.25;
    p.neckYaw = Math.sin(simT * 17) * 0.25;
    p.jaw = 0.12;
    p.tailWave = 0.45;
    return p;
  }
  if (f.state === 'stagger') {
    const k = pulse((simT - f.stateT) / 0.45, 0, 0.2, 1);
    p.chestPitch -= 0.25 * k;
    p.y -= 0.06 * k;
    p.jaw = 0.4 * k;
  }
  if (!m) return p;
  switch (m.clip) {
    case 'swipe': {
      // Right forepaw up, out and across, claws first.
      const up = ramp(u, 0, 0.35);
      const across = ramp(u, 0.35, 0.55);
      const back = ramp(u, 0.6, 1);
      const h = home('lion', 'RF');
      const raised: V3 = [h[0] - 0.05, 0.5, h[2] + 0.35];
      const struck: V3 = [h[0] + 0.3, 0.12, h[2] + 0.55];
      p.legs.RF = lerpV(lerpV(lerpV(h, raised, up), struck, across), h, back);
      p.chestPitch -= 0.15 * pulse(u, 0, 0.35, 0.8);
      p.spineYaw += 0.15 * pulse(u, 0.3, 0.45, 0.8);
      p.jaw = 0.5 * pulse(u, 0.1, 0.4, 0.9);
      p.gaitScale = 0;
      break;
    }
    case 'bite': {
      const open = ramp(u, 0, 0.42);
      const snap = ramp(u, 0.45, 0.52);
      p.neckPitch += 0.3 * pulse(u, 0, 0.5, 1);
      p.headPitch += 0.1 * pulse(u, 0, 0.5, 1);
      p.jaw = open * (1 - snap) + 0.1 * snap * (1 - ramp(u, 0.7, 1));
      p.y -= 0.05 * pulse(u, 0, 0.5, 1);
      break;
    }
    case 'pounce': {
      if (u < 0.35) {
        // Coiled: lower, rocking back onto the haunches.
        const e = ramp(u, 0, 0.3);
        p.y = -0.28 * e;
        p.pitch = 0.08 * e;
        p.neckPitch = 0.3;
        p.jaw = 0.3 * e;
        p.tailYaw += Math.sin(simT * 12) * 0.3;
      } else {
        // Airborne: an arc to the target, forelegs reaching, hind legs streaming back.
        const s = sat((u - 0.35) / 0.27);
        const land = ramp(u, 0.62, 0.9);
        p.y = Math.sin(Math.PI * Math.min(1, s)) * 0.75 * (1 - land) - 0.1 * (1 - s);
        p.pitch = lerp(-0.4, 0.15, s) * (1 - land);
        const body = p.y + 0.9;
        p.legs.LF = lerpV([0.17, body + 0.25, 1.05], home('lion', 'LF'), land);
        p.legs.RF = lerpV([-0.17, body + 0.2, 1.0], home('lion', 'RF'), land);
        p.legs.LH = lerpV([0.17, body - 0.2, -1.1], home('lion', 'LH'), land);
        p.legs.RH = lerpV([-0.17, body - 0.25, -1.05], home('lion', 'RH'), land);
        p.jaw = 1 - land;
        p.tailPitch = -0.6 * (1 - land);
        p.gaitScale = 0;
      }
      break;
    }
    case 'roar': {
      const b = pulse(u, 0.05, 0.3, 0.95);
      p.neckPitch -= 0.55 * b;
      p.headPitch -= 0.25 * b;
      p.chestPitch -= 0.1 * b;
      p.jaw = b;
      p.headYaw += Math.sin(simT * 30) * 0.05 * b;
      break;
    }
  }
  return p;
}

export function bearPose(f: FighterView, simT: number, others: FighterView[]): PoseIn {
  const { p } = base(f, simT, others);
  p.tailWave = 0.03;
  if (!f.alive) {
    fallen(p, f, simT, 0.45, 1.4);
    return p;
  }
  const held = f.state === 'held' ? heldInfo(f, others) : null;
  if (held) {
    struggling(p, simT, held);
    return p;
  }
  if (f.state === 'down') {
    knocked(p, f, simT, 0.45, 1.4);
    return p;
  }
  // Heavy head sway when walking.
  p.neckYaw += Math.sin(f.gait * Math.PI * 2) * 0.08 * Math.min(1, Math.abs(f.spd) / 1.5);
  const m = moveOf(f);
  const u = m ? (simT - f.stateT) / m.len : 0;
  if (f.state === 'grab' && f.grab?.kind === 'pin') {
    // On top of it, raking down with both forepaws in turn, head down biting.
    const e = ramp(simT - f.grab.t0, 0, 0.2);
    p.pitch = -0.4 * e;
    const slam = (ph: number) => Math.max(0, Math.sin(simT * 9 + ph));
    p.legs.LF = [0.25, 0.15 + 0.55 * slam(0), 0.95];
    p.legs.RF = [-0.25, 0.15 + 0.55 * slam(Math.PI), 0.95];
    p.gaitScale = 0;
    p.neckPitch = 0.55;
    p.headPitch = 0.25;
    p.jaw = 0.5 + 0.4 * Math.sin(simT * 11);
    return p;
  }
  if (f.state === 'stagger') {
    const k = pulse((simT - f.stateT) / 0.45, 0, 0.2, 1);
    p.chestPitch -= 0.2 * k;
    p.jaw = 0.5 * k;
  }
  if (!m) return p;
  switch (m.clip) {
    case 'swipe': {
      const h = home('bear', 'LF');
      const up = ramp(u, 0, 0.38);
      const across = ramp(u, 0.38, 0.58);
      const back = ramp(u, 0.62, 1);
      p.legs.LF = lerpV(lerpV(lerpV(h, [h[0] + 0.05, 0.65, h[2] + 0.35], up), [h[0] - 0.4, 0.15, h[2] + 0.6], across), h, back);
      p.chestPitch -= 0.2 * pulse(u, 0, 0.38, 0.85);
      p.spineYaw -= 0.2 * pulse(u, 0.35, 0.5, 0.85);
      p.jaw = 0.6 * pulse(u, 0.1, 0.45, 0.9);
      p.gaitScale = 0;
      break;
    }
    case 'rear': {
      // Up on its hind legs (armoured while up), then down onto its foe with the left paw, up and down
      // again with the right, and back onto all fours.
      const slam = m.hits.reduce((acc, h) => Math.max(acc, pulse(u, h.at - 0.1, h.at, h.at + 0.08)), 0);
      const up = ramp(u, 0, 0.3) * (1 - ramp(u, 0.8, 1)) * (1 - 0.5 * slam);
      p.pitch = -1.0 * up;
      p.y = 0.08 * up;
      p.neckPitch = 0.6 * up;
      p.jaw = 0.8 * pulse(u, 0.05, 0.25, 0.5) + 0.5 * pulse(u, 0.4, 0.7, 0.9);
      // Forepaws (model space while reared): hanging forward, then each raking down across in turn.
      const shoulder = (sx: number): V3 => [sx * 0.3, 0.95 + 0.9 * up, 0.35 + 0.35 * up];
      const swipeL = pulse(u, 0.3, 0.42, 0.5);
      const downL = ramp(u, 0.42, 0.5);
      const swipeR = pulse(u, 0.52, 0.64, 0.72);
      const downR = ramp(u, 0.64, 0.72);
      const arm = (sx: number, raise: number, down: number): V3 => {
        const s = shoulder(sx);
        return [s[0] - sx * 0.35 * down, s[1] - 0.6 + 0.6 * raise - 0.7 * down, s[2] + 0.35 + 0.25 * down];
      };
      if (up > 0.05) {
        p.legs.LF = lerpV(home('bear', 'LF'), arm(1, swipeL, downL * (1 - ramp(u, 0.6, 0.8))), up);
        p.legs.RF = lerpV(home('bear', 'RF'), arm(-1, swipeR, downR * (1 - ramp(u, 0.8, 0.95))), up);
      }
      p.spineYaw += 0.25 * (pulse(u, 0.4, 0.46, 0.52) - pulse(u, 0.62, 0.68, 0.74));
      p.gaitScale = 0;
      break;
    }
    case 'bite': {
      p.neckPitch += 0.3 * pulse(u, 0, 0.55, 1);
      p.jaw = ramp(u, 0, 0.45) * (1 - ramp(u, 0.5, 0.58));
      break;
    }
    case 'charge': {
      // The slam at the end of a charge: head down, shoulder in.
      p.neckPitch += 0.35;
      p.headPitch += 0.15;
      p.jaw = 0.3;
      p.y -= 0.05;
      break;
    }
    case 'maul': {
      p.pitch = -0.3 * pulse(u, 0, 0.3, 1);
      p.neckPitch += 0.4 * pulse(u, 0, 0.3, 1);
      p.jaw = pulse(u, 0, 0.25, 0.6);
      break;
    }
    case 'roar': {
      const b = pulse(u, 0.05, 0.3, 0.95);
      p.pitch = -0.45 * b;
      p.neckPitch = -0.2 * b;
      p.headPitch -= 0.2 * b;
      p.jaw = b;
      const rise = b * 0.45;
      p.legs.LF = lerpV(home('bear', 'LF'), [0.3, 0.55, 0.75], rise * 1.6);
      p.legs.RF = lerpV(home('bear', 'RF'), [-0.3, 0.55, 0.75], rise * 1.6);
      p.headYaw += Math.sin(simT * 28) * 0.05 * b;
      break;
    }
  }
  return p;
}

export function crocPose(f: FighterView, simT: number, others: FighterView[]): PoseIn {
  const { p, rel } = base(f, simT, others);
  p.neckYaw *= 0.5;
  p.headYaw *= 0.5;
  const moving = Math.min(1, Math.abs(f.spd) / 0.5);
  // Belly down when still, up on its legs (the high walk) when moving; the body snakes as it walks.
  p.y = -0.13 * (1 - moving);
  p.spineYaw += Math.sin(f.gait * Math.PI * 2) * 0.22 * moving;
  p.tailWave = 0.05 + 0.25 * moving;
  p.tailYaw += Math.sin(f.gait * Math.PI * 2 - 1.2) * 0.4 * moving;
  // A slow gape now and then.
  p.jaw = 0.3 * Math.pow(Math.max(0, Math.sin(simT * 0.6 + f.idx)), 10);
  if (!f.alive) {
    // Belly up.
    fallen(p, f, simT, 0.05, Math.PI);
    return p;
  }
  const held = f.state === 'held' ? heldInfo(f, others) : null;
  if (held) {
    struggling(p, simT, held);
    return p;
  }
  if (f.state === 'down') {
    knocked(p, f, simT, 0.05, Math.PI * 0.8);
    return p;
  }
  const m = moveOf(f);
  const u = m ? (simT - f.stateT) / m.len : 0;
  if (f.state === 'grab' && f.grab?.kind === 'roll') {
    // The death roll: spinning round its long axis, jaws clamped, legs tucked.
    const sp = simT - f.grab.t0;
    p.roll = rollAngle(f, simT);
    p.y = 0.04;
    p.jaw = 0.05;
    p.tailWave = 0.1;
    p.tailYaw = Math.sin(sp * 9) * 0.5;
    p.spineYaw = Math.sin(sp * 9 + 1) * 0.25;
    p.gaitScale = 0;
    for (const l of ['LF', 'RF', 'LH', 'RH'] as LegName[]) p.legs[l] = 'relax';
    return p;
  }
  if (f.state === 'stagger') {
    const k = pulse((simT - f.stateT) / 0.45, 0, 0.2, 1);
    p.jaw = 0.6 * k;
    p.spineYaw += 0.3 * k;
  }
  if (!m) return p;
  switch (m.clip) {
    case 'lunge': {
      // Jaws gape wide, the body rises and surges, the jaws slam shut at the hit.
      const open = ramp(u, 0, 0.3);
      const shut = ramp(u, 0.36, 0.42);
      p.jaw = open * (1 - shut);
      p.y = 0.07 * pulse(u, 0.1, 0.4, 0.9);
      p.pitch = -0.12 * pulse(u, 0.1, 0.35, 0.6);
      p.neckPitch = -0.15 * open * (1 - shut) + 0.1 * shut * (1 - ramp(u, 0.6, 1));
      p.spineYaw += 0.3 * Math.sin(u * Math.PI * 3) * (1 - u);
      p.tailYaw += 0.6 * Math.sin(u * Math.PI * 3 + 1) * (1 - u);
      break;
    }
    case 'snap': {
      p.jaw = ramp(u, 0, 0.35) * (1 - ramp(u, 0.4, 0.48));
      p.headYaw += 0.3 * pulse(u, 0.3, 0.45, 0.7) * (rel > 0 ? -1 : 1);
      break;
    }
    case 'tail': {
      // A sweep from one side to the other, the body bending against it.
      const dir = rel > 0 ? 1 : -1;
      const sweep = lerp(-1.3, 1.5, ramp(u, 0.2, 0.55)) * (1 - ramp(u, 0.65, 1));
      p.tailYaw = sweep * dir * 2.2;
      p.tailWave = 0;
      p.spineYaw += -sweep * dir * 0.35;
      break;
    }
  }
  return p;
}

/** Common opening for the new species: dead, held, or alive with its move (if any) and progress. */
function begin(f: FighterView, simT: number, others: FighterView[], lie: number, roll: number) {
  const b = base(f, simT, others);
  if (!f.alive) {
    fallen(b.p, f, simT, lie, roll);
    return { ...b, done: true, m: null as MoveDef | null, u: 0 };
  }
  const held = f.state === 'held' ? heldInfo(f, others) : null;
  if (held) {
    struggling(b.p, simT, held);
    return { ...b, done: true, m: null as MoveDef | null, u: 0 };
  }
  if (f.state === 'down') {
    knocked(b.p, f, simT, lie, roll);
    return { ...b, done: true, m: null as MoveDef | null, u: 0 };
  }
  const m = moveOf(f);
  return { ...b, done: false, m, u: m ? (simT - f.stateT) / m.len : 0 };
}

/**
 * Hoofed animals and dogs (the quadruped generator's animals): headbutts and gores, bites, rear-hoof
 * bucks (front down, hind legs lashing back), the donkey's headbutt-then-buck, charges.
 */
export function mammalPose(f: FighterView, simT: number, others: FighterView[]): PoseIn {
  const kind = f.def.proc!.kind;
  const spec = SPECIES[kind];
  const dog = kind === 'wolf' || kind === 'husky' || kind === 'fox';
  const { p, rel, done, m, u } = begin(f, simT, others, spec.rollY * 0.55, 1.45);
  if (done) return p;
  p.neckYaw *= 0.7;
  p.tailWave = dog ? 0.18 : 0.12;
  // Dogs carry their tails high and lips back when fighting; everyone lowers the head to face a foe.
  if (dog) p.tailPitch = -0.3;
  if (f.state === 'stagger') {
    const k = pulse((simT - f.stateT) / 0.45, 0, 0.2, 1);
    p.neckPitch -= 0.35 * k;
    p.chestPitch -= 0.1 * k;
    p.jaw = 0.4 * k;
  }
  if (f.state === 'dodge') p.roll += 0.2 * f.dodgeDir;
  if (!m) return p;
  const kick = (amount: number) => {
    // A buck: weight onto the forelegs, rump up, both hind legs lashing back.
    p.pitch += 0.35 * amount;
    p.y += 0.15 * amount * spec.rollY;
    p.neckPitch += 0.45 * amount;
    for (const leg of ['LH', 'RH']) {
      const h = home(kind, leg);
      p.legs[leg] = lerpV(h, [h[0], spec.rollY * 0.75, h[2] - spec.rollY * 0.7], amount);
    }
  };
  const butt = (amount: number) => {
    // Head down and driven forward (horns, antlers, a ram).
    p.neckPitch += 0.55 * amount;
    p.headPitch += 0.35 * amount;
    p.y -= 0.06 * amount;
    p.chestPitch += 0.08 * amount;
  };
  switch (m.clip) {
    case 'headbutt':
    case 'charge':
      butt(pulse(u, 0, 0.35, 0.85));
      p.jaw = 0.15 * pulse(u, 0, 0.35, 0.85);
      break;
    case 'bite': {
      const open = ramp(u, 0, 0.42);
      const snap = ramp(u, 0.45, 0.53);
      p.neckPitch += (dog ? 0.25 : 0.4) * pulse(u, 0, 0.5, 1);
      p.neckYaw += 0.25 * pulse(u, 0.2, 0.5, 0.9) * (rel > 0 ? -1 : 1);
      p.jaw = open * (1 - snap) + 0.1 * snap * (1 - ramp(u, 0.7, 1));
      p.y -= (dog ? 0.08 : 0.04) * pulse(u, 0, 0.5, 1);
      if (dog) p.tailYaw = Math.sin(simT * 14) * 0.3 * pulse(u, 0, 0.5, 1);
      break;
    }
    case 'buck':
      kick(pulse(u, 0.25, 0.6, 0.95));
      break;
    case 'combo':
      butt(pulse(u, 0, 0.15, 0.4));
      kick(pulse(u, 0.45, 0.75, 1));
      break;
  }
  return p;
}

/** People: guard stances, slashes, kicks and punches, sidesteps. */
export function humanPose(f: FighterView, simT: number, others: FighterView[]): PoseIn {
  const sword = !!f.def.weapon;
  const { p, done, m, u } = begin(f, simT, others, 0.72, 1.45);
  if (done) return p;
  p.neckYaw *= 0.6;
  p.headYaw *= 0.5;
  p.spineYaw *= 0.4;
  const running = Math.abs(f.spd) > 3;
  // Guard: sword up and forward, the other hand ready; a boxer's fists by the chin.
  const guardL: V3 = sword ? [0.2, 1.12, 0.25] : [0.14, 1.42, 0.26];
  const guardR: V3 = sword ? [-0.2, 1.08, 0.3] : [-0.15, 1.38, 0.3];
  const bladeGuard: V3 = [0.15, 0.85, 0.5];
  if (!running) {
    p.legs.LA = guardL;
    p.legs.RA = guardR;
  }
  p.props.sword = running ? [0, 0.4, 1] : bladeGuard;
  // A slight fighting crouch and bounce.
  p.y -= 0.03 + Math.abs(Math.sin(simT * 4)) * 0.015 * (1 - Math.min(1, Math.abs(f.spd)));
  if (f.state === 'stagger') {
    const k = pulse((simT - f.stateT) / 0.45, 0, 0.2, 1);
    p.pitch -= 0.25 * k;
    p.neckPitch -= 0.3 * k;
    p.legs.LA = lerpV(guardL, [0.35, 1.55, -0.05], k);
    p.legs.RA = lerpV(guardR, [-0.35, 1.5, -0.05], k);
  }
  if (f.state === 'dodge') {
    // Sidestep: lean away, feet wide.
    const k = pulse((simT - f.stateT) / 0.6, 0, 0.3, 1);
    p.roll += -0.28 * f.dodgeDir * k;
    p.y -= 0.08 * k;
    p.legs.LL = [0.3, 0, 0.02];
    p.legs.RL = [-0.3, 0, 0.02];
  }
  if (!m) return p;
  switch (m.clip) {
    case 'slash': {
      // Overhead and across: hand up behind the head, then down to the left, the torso unwinding.
      const up = ramp(u, 0.05, 0.3);
      const strike = ramp(u, 0.3, 0.42);
      const back = ramp(u, 0.55, 1);
      const raised: V3 = [-0.12, 1.85, -0.05];
      const struck: V3 = [0.22, 0.95, 0.55];
      p.legs.RA = lerpV(lerpV(lerpV(guardR, raised, up), struck, strike), guardR, back);
      p.legs.LA = lerpV(guardL, [0.3, 1.25, 0.1], pulse(u, 0.05, 0.35, 0.9));
      const bladeUp: V3 = [0, 0.55, -1];
      const bladeDown: V3 = [0.6, -0.35, 1];
      p.props.sword = lerpV(lerpV(lerpV(bladeGuard, bladeUp, up), bladeDown, strike), bladeGuard, back);
      p.spineYaw += lerp(-0.5 * up, 0.55, strike) * (1 - back);
      p.pitch += 0.15 * strike * (1 - back);
      p.legs.RL = [-0.12, 0, 0.03 + 0.25 * strike * (1 - back)];
      break;
    }
    case 'kick': {
      // Right foot up and out at the target, leaning back, arms out for balance.
      const k = pulse(u, 0.15, 0.5, 0.9);
      p.legs.RL = lerpV([-0.12, 0, 0.03], [-0.08, 0.85, 0.72], k);
      p.pitch -= 0.2 * k;
      p.legs.LA = lerpV(guardL, [0.4, 1.2, -0.05], k);
      p.legs.RA = lerpV(guardR, [-0.4, 1.2, -0.05], k);
      break;
    }
    case 'punch_l':
    case 'punch_r': {
      const right = m.clip === 'punch_r';
      const hitAt = m.hits[0].at;
      const wind = ramp(u, 0, hitAt * 0.6);
      const out = ramp(u, hitAt * 0.6, hitAt);
      const back = ramp(u, hitAt + 0.1, 1);
      const sx = right ? -1 : 1;
      const g = right ? guardR : guardL;
      p.legs[right ? 'RA' : 'LA'] = lerpV(lerpV(lerpV(g, [sx * 0.2, 1.35, 0.05], wind), [sx * 0.06, 1.42, 0.72], out), g, back);
      p.spineYaw += 0.35 * sx * (out - wind * 0.5) * (1 - back);
      p.legs[right ? 'RL' : 'LL'] = [sx * 0.12, 0, 0.03 + 0.15 * out * (1 - back)];
      break;
    }
  }
  return p;
}

/** The dragon: always flying (the view lifts it), wings beating; bites from above, breathes fire. */
export function dragonPose(f: FighterView, simT: number, others: FighterView[]): PoseIn {
  const { p, done, m, u } = begin(f, simT, others, 0.55, 1.4);
  const beat = Math.sin(simT * 6.5 + f.idx);
  if (done) {
    if (!f.alive) p.wingFlap = -0.3;
    return p;
  }
  // Brought down (a torn wing): on its feet, wings folded up over its back, twitching. (Swooping down to
  // bite, it is still flying.)
  const flying = f.hover > 0.35 || condition(f).wing < 0.6;
  // Wings held high in a V and swept back, beating: they read from the side as well as from behind.
  p.wingFlap = flying ? 0.6 + beat * 0.6 : 0.95 + beat * 0.08;
  p.wingFold = flying ? 0.25 : 0.85;
  p.tailWave = 0.25;
  p.pitch -= flying ? 0.12 : 0;
  p.neckPitch += 0.25;
  // Legs tucked under in flight.
  if (flying) {
    for (const l of ['LF', 'RF', 'LH', 'RH']) p.legs[l] = 'relax';
    p.gaitScale = 0;
  }
  if (f.state === 'stagger') {
    const k = pulse((simT - f.stateT) / 0.45, 0, 0.2, 1);
    p.wingFold = 0.4 * k;
    p.pitch -= 0.2 * k;
    p.jaw = 0.5 * k;
  }
  if (!m) return p;
  if (m.breath) {
    // Rear back with wings wide, then the neck forward and down, jaws open: fire.
    const rear = pulse(u, 0, 0.25, 0.45);
    const fire = pulse(u, 0.25, 0.4, 0.85);
    p.pitch -= 0.35 * rear;
    p.neckPitch += -0.4 * rear + 0.35 * fire;
    p.headPitch += 0.2 * fire;
    p.jaw = Math.max(0.4 * rear, fire);
    p.wingFlap = lerp(p.wingFlap, 0.7, Math.max(rear, fire));
  } else {
    // A bite from above: the neck strikes down.
    const open = ramp(u, 0, 0.25);
    const snap = ramp(u, 0.28, 0.35);
    p.neckPitch += 0.6 * pulse(u, 0, 0.3, 0.8);
    p.headPitch += 0.25 * pulse(u, 0, 0.3, 0.8);
    p.jaw = open * (1 - snap);
    p.wingFlap += 0.3 * pulse(u, 0, 0.3, 0.8);
  }
  return p;
}

/** The spider: forelegs raised for a fang strike, crouch and leap. */
export function spiderPose(f: FighterView, simT: number, others: FighterView[]): PoseIn {
  const { p, done, m, u } = begin(f, simT, others, 0.2, Math.PI);
  if (done) return p;
  p.neckYaw = 0;
  p.headYaw = 0;
  p.spineYaw *= 0.3;
  // Fangs twitch.
  p.jaw = 0.15 + 0.15 * Math.max(0, Math.sin(simT * 3 + f.idx));
  if (f.state === 'stagger') {
    const k = pulse((simT - f.stateT) / 0.45, 0, 0.2, 1);
    p.pitch -= 0.3 * k;
    p.legs.L1 = lerpV(home('spider', 'L1'), [0.5, 0.9, 1.0], k);
    p.legs.R1 = lerpV(home('spider', 'R1'), [-0.5, 0.9, 1.0], k);
  }
  if (!m) return p;
  if (m.clip === 'leap') {
    if (u < 0.3) {
      p.y = -0.25 * ramp(u, 0, 0.25);
    } else {
      const s = sat((u - 0.3) / 0.45);
      const land = ramp(u, 0.75, 1);
      p.y = Math.sin(Math.PI * s) * 0.8 * (1 - land) - 0.1 * (1 - s);
      p.pitch = lerp(-0.3, 0.2, s) * (1 - land);
      p.gaitScale = 0;
      // Legs splayed forward in the air, reaching for the prey.
      for (const l of limbsOf(f)) {
        const h = home('spider', l);
        p.legs[l] = lerpV([h[0] * 0.8, p.y + 0.3, h[2] + 0.5], h, land);
      }
    }
    p.jaw = ramp(u, 0.3, 0.6) * (1 - ramp(u, 0.75, 0.8));
  } else {
    // Rear up on the back legs, forelegs high, then the fangs strike down.
    const rear = pulse(u, 0, 0.35, 0.7);
    const strike = ramp(u, 0.45, 0.55) * (1 - ramp(u, 0.7, 1));
    p.pitch -= 0.3 * rear - 0.25 * strike;
    p.y += 0.1 * rear;
    p.legs.L1 = lerpV(home('spider', 'L1'), [0.45, 1.1, 1.1], rear);
    p.legs.R1 = lerpV(home('spider', 'R1'), [-0.45, 1.1, 1.1], rear);
    p.legs.L2 = lerpV(home('spider', 'L2'), [0.8, 0.5, 0.8], rear * 0.6);
    p.legs.R2 = lerpV(home('spider', 'R2'), [-0.8, 0.5, 0.8], rear * 0.6);
    p.jaw = Math.max(rear, 1 - strike) * (u < 0.55 ? 1 : 0.3);
  }
  return p;
}

export const PROC_POSES = {
  lion: lionPose,
  bear: bearPose,
  croc: crocPose,
  horse: mammalPose,
  unicorn: mammalPose,
  donkey: mammalPose,
  bull: mammalPose,
  stag: mammalPose,
  deer: mammalPose,
  alpaca: mammalPose,
  wolf: mammalPose,
  husky: mammalPose,
  fox: mammalPose,
  swordsman: humanPose,
  king: humanPose,
  brawler: humanPose,
  dragon: dragonPose,
  spider: spiderPose,
} as const;
