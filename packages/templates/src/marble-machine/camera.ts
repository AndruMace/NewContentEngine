/**
 * The Marble Machine's camera director: a shot list planned from the schedule, and the camera pose
 * as a pure function of time (shots blend into each other), so Playground and renders match.
 * Opens on the whole machine, follows featured marbles through the showpiece routes onto their bar,
 * holds on the vibraphone through busy passages, tracks the domino run, and pulls back for the reveal.
 */
import { DOMINO, type DominoRun } from './machine';
import type { Drop, Schedule } from './routes';
import { smooth, type V3 } from './segments';

export type ShotKind = 'establish' | 'wide' | 'bars' | 'follow' | 'dominoes' | 'reveal';

export interface Shot {
  kind: ShotKind;
  from: number;
  drop?: Drop;
}

export interface Pose {
  pos: V3;
  look: V3;
}

const ESTABLISH_S = 2.4;
const BLEND_S = 0.8;
const FEATURE: Record<string, number> = { loop: 3, seesaw: 2, helix: 1 };

/** Notes per second around t (for choosing a wider vibraphone shot in busy passages). */
function density(drops: Drop[], t: number): number {
  return drops.filter((d) => !d.bass && Math.abs(d.t - t) < 1).length / 2;
}

export function planShots(sched: Schedule, lastNote: number, revealAt: number, mode: 'director' | 'wide'): Shot[] {
  if (mode === 'wide') return [{ kind: 'establish', from: 0 }, { kind: 'wide', from: ESTABLISH_S }, { kind: 'reveal', from: revealAt + 0.2 }];
  const shots: Shot[] = [{ kind: 'establish', from: 0 }];
  const features = sched.drops
    .filter((d) => d.route in FEATURE && d.t < lastNote - 0.4)
    .sort((a, b) => a.release - b.release);
  let tc = ESTABLISH_S;
  let filler = 0;
  while (tc < lastNote - 1) {
    // The next showpiece marble that starts after a short filler, preferring loops, then seesaws.
    const candidates = features.filter((d) => d.release - 0.4 >= tc + 1.2 && d.release - 0.4 <= tc + 5);
    const next = candidates.sort((a, b) => FEATURE[b.route] - FEATURE[a.route] || a.release - b.release)[0];
    const kind: ShotKind = density(sched.drops, tc + 0.8) > 3 || filler % 2 === 1 ? 'bars' : 'wide';
    shots.push({ kind, from: tc });
    filler++;
    if (!next) {
      tc += 2.5;
      continue;
    }
    shots.push({ kind: 'follow', from: next.release - 0.4, drop: next });
    tc = next.t + 0.7;
  }
  if (sched.dominoes) shots.push({ kind: 'dominoes', from: Math.max(tc, lastNote - 0.3) });
  else shots.push({ kind: 'bars', from: Math.max(tc, lastNote - 1) });
  shots.push({ kind: 'reveal', from: revealAt + 0.2 });
  return shots.sort((a, b) => a.from - b.from);
}

const lerp = (a: V3, b: V3, k: number): V3 => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k });

/** A marble's position smoothed over a short window, so the camera doesn't jitter round the helix. */
function soft(d: Drop, t: number): V3 {
  let x = 0, y = 0, z = 0;
  const n = 7;
  for (let k = 0; k < n; k++) {
    const p = d.path.at(Math.min(d.t + 0.6, Math.max(d.release, t + (k - (n - 1) / 2) * 0.08)));
    x += p.x;
    y += p.y;
    z += p.z;
  }
  return { x: x / n, y: y / n, z: z / n };
}

function poseOf(shot: Shot, t: number, dominoes: DominoRun | null): Pose {
  switch (shot.kind) {
    case 'establish': {
      const a = 0.85 * (1 - smooth(t / ESTABLISH_S));
      return { pos: { x: Math.sin(a) * 19, y: 7, z: Math.cos(a) * 19 }, look: { x: 0, y: 6.2, z: 0 } };
    }
    case 'wide':
      return { pos: { x: Math.sin(t * 0.17) * 2.6, y: 7, z: 18.5 }, look: { x: 0, y: 6.2, z: 0 } };
    case 'reveal':
      return { pos: { x: Math.sin(t * 0.17) * 1.5, y: 7.2, z: 19.5 }, look: { x: 0, y: 6.2, z: 0 } };
    case 'bars':
      return { pos: { x: Math.sin(t * 0.3) * 0.9, y: 4.1, z: 7.6 }, look: { x: 0, y: 2.5, z: 0.2 } };
    case 'follow': {
      const m = soft(shot.drop!, t);
      // Closer in the middle of the machine; pulled back a little near the bars to show the hit.
      const near = Math.max(0, Math.min(1, (m.y - 2) / 3));
      return { pos: { x: m.x * 0.7 + 0.9, y: m.y + 1.2, z: m.z + 5 + 1.4 * (1 - near) }, look: { x: m.x, y: m.y + 0.35, z: m.z } };
    }
    case 'dominoes': {
      if (!dominoes) return { pos: { x: 0, y: 4.1, z: 7.6 }, look: { x: 0, y: 2.5, z: 0.2 } };
      const k = Math.max(0, Math.min(dominoes.n - 1, (t - dominoes.start) / DOMINO.dt));
      const x = dominoes.x0 + dominoes.dir * k * DOMINO.spacing;
      return { pos: { x: x - dominoes.dir * 1.1, y: 1.6, z: 4.6 }, look: { x: x + dominoes.dir * 0.4, y: 0.4, z: DOMINO.z } };
    }
  }
}

export function cameraAt(shots: Shot[], dominoes: DominoRun | null, t: number): Pose {
  let i = 0;
  while (i + 1 < shots.length && shots[i + 1].from <= t) i++;
  const cur = poseOf(shots[i], t, dominoes);
  const into = t - shots[i].from;
  if (i === 0 || into >= BLEND_S) return cur;
  const prev = poseOf(shots[i - 1], t, dominoes);
  const k = smooth(into / BLEND_S);
  return { pos: lerp(prev.pos, cur.pos, k), look: lerp(prev.look, cur.look, k) };
}
