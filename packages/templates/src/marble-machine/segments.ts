/**
 * Marble paths for the Marble Machine: a chain of timed segments (rails at a steady speed, ballistic
 * flights, helices, loops, waits), each a pure function of time. Built from the song's timeline, so a
 * marble is exactly where the schedule says, every frame, in the Playground and in renders alike.
 * Coordinates are three.js-style: x right, y up, z toward the camera.
 */
import * as dm from '@sim/physics/math';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface Seg {
  t0: number;
  t1: number;
  /** What the marble is doing (for sound and camera), e.g. 'rail', 'fly', 'loop', 'helix', 'wait'. */
  kind: string;
  at(t: number): V3;
}

export const G = 14;

export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const dist = (a: V3, b: V3) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);

/** A marble's path: segments appended end to end in time, each starting where the last ended. */
export class Path {
  segs: Seg[] = [];
  t: number;
  p: V3;

  constructor(t0: number, p0: V3) {
    this.t = t0;
    this.p = p0;
  }

  private push(kind: string, dur: number, at: (u: number) => V3): this {
    const t0 = this.t;
    const seg: Seg = { t0, t1: t0 + dur, kind, at: (t) => at(Math.min(dur, Math.max(0, t - t0))) };
    this.segs.push(seg);
    this.t = seg.t1;
    this.p = at(dur);
    return this;
  }

  /** A straight rail to `to` at a steady speed. */
  rail(to: V3, speed: number, kind = 'rail'): this {
    const a = this.p;
    const dur = dist(a, to) / speed;
    return this.push(kind, dur, (u) => {
      const k = dur > 0 ? u / dur : 1;
      return v3(a.x + (to.x - a.x) * k, a.y + (to.y - a.y) * k, a.z + (to.z - a.z) * k);
    });
  }

  /** A ballistic flight to `to` taking exactly `dur` seconds under gravity G. */
  fly(to: V3, dur: number, kind = 'fly'): this {
    const a = this.p;
    const vx = (to.x - a.x) / dur;
    const vz = (to.z - a.z) / dur;
    const vy = (to.y - a.y + 0.5 * G * dur * dur) / dur;
    return this.push(kind, dur, (u) => v3(a.x + vx * u, a.y + vy * u - 0.5 * G * u * u, a.z + vz * u));
  }

  /** Free fall straight down onto height y (from rest). */
  drop(y: number, kind = 'drop'): this {
    const a = this.p;
    const dur = Math.sqrt((2 * (a.y - y)) / G);
    return this.push(kind, dur, (u) => v3(a.x, a.y - 0.5 * G * u * u, a.z));
  }

  /** Down a helix round a vertical axis at (cx, cz), from the current point, `turns` turns to height y1. */
  helix(cx: number, cz: number, r: number, turns: number, y1: number, speed: number, dir = 1): this {
    const a = this.p;
    const th0 = dm.atan2(a.z - cz, a.x - cx);
    const sweep = dir * turns * Math.PI * 2;
    const len = Math.sqrt((sweep * r) ** 2 + (a.y - y1) ** 2);
    const dur = len / speed;
    return this.push('helix', dur, (u) => {
      const k = u / dur;
      const th = th0 + sweep * k;
      return v3(cx + r * dm.cos(th), a.y + (y1 - a.y) * k, cz + r * dm.sin(th));
    });
  }

  /** Round a vertical loop in the x–y plane (centre c, radius r) from its bottom, `dir` = +1 counter-clockwise. */
  loop(c: V3, r: number, speed: number, dir = 1): this {
    const dur = (Math.PI * 2 * r) / speed;
    return this.push('loop', dur, (u) => {
      const th = -Math.PI / 2 + dir * ((Math.PI * 2 * u) / dur);
      return v3(c.x + r * dm.cos(th), c.y + r * dm.sin(th), c.z);
    });
  }

  /** Ride along with a moving point (a lever end, a wheel paddle) for `dur` seconds. */
  ride(dur: number, at: (t: number) => V3, kind = 'ride'): this {
    const t0 = this.t;
    return this.push(kind, dur, (u) => at(t0 + u));
  }

  wait(dur: number, kind = 'wait'): this {
    const a = this.p;
    return this.push(kind, dur, () => a);
  }

  at(t: number): V3 {
    const s = this.segs;
    if (!s.length) return this.p;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t1 < t) lo = mid + 1;
      else hi = mid;
    }
    return s[lo].at(t);
  }

  segAt(t: number): Seg | undefined {
    return this.segs.find((g) => t >= g.t0 && t < g.t1);
  }

  get t0() {
    return this.segs.length ? this.segs[0].t0 : this.t;
  }
}

/** Ease in-out on 0..1. */
export const smooth = (u: number) => {
  const k = Math.min(1, Math.max(0, u));
  return k * k * (3 - 2 * k);
};
