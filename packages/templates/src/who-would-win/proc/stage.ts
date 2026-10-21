/**
 * Posing a whole scene of fighters from their states (shared by the view and the headless contact
 * checks): each in its own pose first (the species' motion, then its injuries), then every blow and grip
 * reaching for where its target's body actually is now.
 */
import { THREE } from '../../three-layer';
import type { FighterView } from '../index';
import { LEAP, type Aim } from '../sim';
import { reachFor, spotOf, spotWorld, strikeParts, strikeWeight, type Spot } from './contact';
import { PROC_POSES, wounded } from './poses';
import type { PoseIn, ProcRig } from './rig';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const wrapAngle = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

/** Place and pose a fighter from its own state (its strike reaches for its target afterwards: strike()). */
export function pose(rig: ProcRig, f: FighterView, simT: number, horde: boolean, all: FighterView[]): PoseIn {
  const d = f.def;
  let y = f.hover > 0.01 ? f.hover + Math.sin(simT * 3.1 + f.idx) * 0.12 * Math.min(1, f.hover / (d.hover ?? 1)) : 0;
  // Fallen dragons drop out of the air; in a horde the fallen sink away after a while.
  if (!f.alive && d.hover) y *= 1 - clamp01((simT - f.diedAt) / 0.6);
  if (!f.alive && horde && f.side === 1) y -= clamp01((simT - f.diedAt - 2.2) / 1.2) * d.height * 1.2;
  rig.root.position.set(f.x, y, f.y);
  rig.root.rotation.set(0, Math.atan2(Math.cos(f.heading), Math.sin(f.heading)), 0);
  rig.root.visible = f.alive || !horde || simT - f.diedAt < 3.6;
  const p = PROC_POSES[d.proc.kind](f, simT, all);
  wounded(p, f, simT);
  rig.pose(p);
  return p;
}

/** Which side of `t` a fighter at (x, y) is on, now (1: t's left). */
const sideNow = (t: FighterView, x: number, y: number): 1 | -1 => (wrapAngle(Math.atan2(y - t.y, x - t.x) - t.heading) < 0 ? 1 : -1);

const _P = new THREE.Vector3();
const _Q = new THREE.Vector3();

/**
 * Its blow (or its grip) reaching the spot it aims at on its target, as that spot is now: jaws, brow,
 * claws, hooves, fists or blade land on it at the impact. A grapple keeps its jaws on its hold, a lion's
 * forepaws hooked over its prey's back, a bear's paws raking down on it.
 */
function strike(rig: ProcRig, f: FighterView, p: PoseIn, simT: number, rigs: Map<number, ProcRig>, all: FighterView[]) {
  if (!f.alive || !f.aim) return;
  const t = all.find((o) => o.idx === (f.grab ? f.grab.target : f.target));
  const tr = t && rigs.get(t.idx);
  if (!t || !tr) return;
  const flier = f.hover > 0.3;
  // (Leaping up at a flier.)
  const leap = !flier && t.hover > 0.3 ? LEAP : 0;
  const at = (aim: Aim): Spot | null => spotOf(tr, aim);
  if (f.state === 'attack' && f.moveIdx >= 0) {
    const m = f.def.moves[f.moveIdx];
    const { a, k } = strikeWeight(m, simT - f.stateT);
    const parts = strikeParts(f.def, m, k);
    const s = at({ ...f.aim, side: sideNow(t, f.x, f.y) });
    if (s && a > 0) reachFor(rig, p, parts, spotWorld(s, _P), a, { flier, leap });
    return;
  }
  if (f.state !== 'grab' || !f.grab) return;
  const g = f.grab;
  const e = clamp01((simT - g.t0) / 0.2);
  if (g.kind === 'latch' || g.kind === 'pin') {
    // Forepaws on its back (a bear's slamming down in turn), either side of the hold.
    for (const [limb, du] of [['LF', 0.1], ['RF', -0.1]] as const) {
      const back = at({ zone: 'body', side: g.side, u: Math.max(0, Math.min(1, g.aim.u - 0.15 + du)), v: 0 });
      if (!back) continue;
      const slam = g.kind === 'pin' ? Math.max(0, Math.sin(simT * 9 + (limb === 'LF' ? 0 : Math.PI))) : 0;
      spotWorld(back, _Q);
      _Q.y += 0.04 + 0.5 * slam;
      reachFor(rig, p, [{ kind: 'paw', limb }], _Q, e);
    }
  }
  const hold = at(g.aim);
  if (hold) reachFor(rig, p, [{ kind: 'snout' }], spotWorld(hold, _P), e * 0.95, { flier });
}


/** Pose every fighter (rigs by fighter index) at sim time simT. */
export function stage(rigs: Map<number, ProcRig>, fighters: FighterView[], simT: number, horde: boolean) {
  const poses = new Map<number, PoseIn>();
  for (const f of fighters) {
    const rig = rigs.get(f.idx);
    if (rig) poses.set(f.idx, pose(rig, f, simT, horde, fighters));
  }
  for (const f of fighters) {
    const rig = rigs.get(f.idx);
    if (rig) strike(rig, f, poses.get(f.idx)!, simT, rigs, fighters);
  }
}
