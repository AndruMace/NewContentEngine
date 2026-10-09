import { hypot } from './math';
import * as dm from './math';

/**
 * Minimal deterministic 2D physics for circle bodies against static/kinematic shapes.
 * Bodies are circles; level geometry is capsule segments (optionally rotating about a pivot)
 * and static discs. Everything iterates in insertion order, so a given setup always
 * produces the same result.
 */

export interface Body {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  invMass: number;
  restitution: number;
  friction: number;
  alive: boolean;
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Capsule radius (half thickness). */
  r: number;
  restitution: number;
  friction: number;
  tag: string;
  /** Rotating segment: endpoints are recomputed from pivot + angle each step. */
  kin?: { cx: number; cy: number; angle: number; omega: number; la: number; lb: number };
  active: boolean;
}

export interface Disc {
  x: number;
  y: number;
  r: number;
  restitution: number;
  tag: string;
  /** Extra outward speed added on contact (pinball bumpers). */
  kick?: number;
}

export interface Contact {
  body: Body;
  other: Body | Segment | Disc;
  kind: 'body' | 'segment' | 'disc';
  impulse: number;
  x: number;
  y: number;
}

const CELL = 128;
const key = (cx: number, cy: number) => cx * 73856093 + cy * 19349663;

export class World {
  bodies: Body[] = [];
  segments: Segment[] = [];
  discs: Disc[] = [];
  gravity = 1500;
  private staticGrid = new Map<number, { segs: number[]; discs: number[] }>();
  private kinematic: number[] = [];
  private nextId = 0;

  addBody(b: Omit<Body, 'id' | 'alive' | 'invMass' | 'restitution' | 'friction'> & Partial<Body>): Body {
    const body: Body = { invMass: 1, restitution: 0.5, friction: 0.05, alive: true, ...b, id: this.nextId++ };
    this.bodies.push(body);
    return body;
  }

  addSegment(s: Omit<Segment, 'active' | 'restitution' | 'friction' | 'tag' | 'r'> & Partial<Segment>): Segment {
    const seg: Segment = { r: 6, restitution: 0.5, friction: 0.05, tag: 'wall', active: true, ...s };
    const idx = this.segments.push(seg) - 1;
    if (seg.kin) {
      this.kinematic.push(idx);
      this.updateKinematic(seg, 0);
    } else this.indexStatic(Math.min(seg.ax, seg.bx) - seg.r, Math.min(seg.ay, seg.by) - seg.r, Math.max(seg.ax, seg.bx) + seg.r, Math.max(seg.ay, seg.by) + seg.r, idx, 'segs');
    return seg;
  }

  /** Rotating bar about (cx, cy); la/lb are signed distances of the endpoints from the pivot. */
  addSpinner(cx: number, cy: number, la: number, lb: number, angle: number, omega: number, extra: Partial<Segment> = {}) {
    return this.addSegment({ ax: 0, ay: 0, bx: 0, by: 0, ...extra, kin: { cx, cy, angle, omega, la, lb } });
  }

  addDisc(d: Omit<Disc, 'restitution' | 'tag'> & Partial<Disc>): Disc {
    const disc: Disc = { restitution: 0.5, tag: 'peg', ...d };
    const idx = this.discs.push(disc) - 1;
    this.indexStatic(disc.x - disc.r, disc.y - disc.r, disc.x + disc.r, disc.y + disc.r, idx, 'discs');
    return disc;
  }

  private indexStatic(x0: number, y0: number, x1: number, y1: number, idx: number, kind: 'segs' | 'discs') {
    for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        const k = key(cx, cy);
        let cell = this.staticGrid.get(k);
        if (!cell) this.staticGrid.set(k, (cell = { segs: [], discs: [] }));
        cell[kind].push(idx);
      }
    }
  }

  private updateKinematic(s: Segment, dt: number) {
    const k = s.kin!;
    k.angle += k.omega * dt;
    const c = dm.cos(k.angle);
    const sn = dm.sin(k.angle);
    s.ax = k.cx + c * k.la;
    s.ay = k.cy + sn * k.la;
    s.bx = k.cx + c * k.lb;
    s.by = k.cy + sn * k.lb;
  }

  step(dt: number, onContact?: (c: Contact) => void) {
    for (const i of this.kinematic) this.updateKinematic(this.segments[i], dt);
    for (const b of this.bodies) {
      if (!b.alive || b.invMass === 0) continue;
      b.vy += this.gravity * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    this.collideBodies(onContact);
    for (const b of this.bodies) {
      if (!b.alive) continue;
      this.collideStatics(b, onContact);
      for (const i of this.kinematic) this.collideSegment(b, this.segments[i], onContact);
    }
  }

  private collideStatics(b: Body, onContact?: (c: Contact) => void) {
    const seenSeg = new Set<number>();
    const seenDisc = new Set<number>();
    for (let cy = Math.floor((b.y - b.r) / CELL); cy <= Math.floor((b.y + b.r) / CELL); cy++) {
      for (let cx = Math.floor((b.x - b.r) / CELL); cx <= Math.floor((b.x + b.r) / CELL); cx++) {
        const cell = this.staticGrid.get(key(cx, cy));
        if (!cell) continue;
        for (const i of cell.segs) {
          if (seenSeg.has(i)) continue;
          seenSeg.add(i);
          this.collideSegment(b, this.segments[i], onContact);
        }
        for (const i of cell.discs) {
          if (seenDisc.has(i)) continue;
          seenDisc.add(i);
          this.collideDisc(b, this.discs[i], onContact);
        }
      }
    }
  }

  private resolve(b: Body, nx: number, ny: number, pen: number, svx: number, svy: number, e: number, mu: number): number {
    b.x += nx * pen;
    b.y += ny * pen;
    const rvx = b.vx - svx;
    const rvy = b.vy - svy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return 0;
    const j = -(1 + e) * vn;
    b.vx += j * nx;
    b.vy += j * ny;
    // Coulomb-ish friction on the tangential component.
    const tx = -ny;
    const ty = nx;
    const vt = rvx * tx + rvy * ty;
    const f = Math.min(Math.abs(vt), mu * j) * Math.sign(vt);
    b.vx -= f * tx;
    b.vy -= f * ty;
    return j;
  }

  private collideSegment(b: Body, s: Segment, onContact?: (c: Contact) => void) {
    if (!s.active) return;
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const len2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((b.x - s.ax) * dx + (b.y - s.ay) * dy) / len2));
    const px = s.ax + dx * u;
    const py = s.ay + dy * u;
    const ox = b.x - px;
    const oy = b.y - py;
    const d = hypot(ox, oy);
    const min = b.r + s.r;
    if (d >= min || d === 0) return;
    const nx = ox / d;
    const ny = oy / d;
    let svx = 0;
    let svy = 0;
    if (s.kin) {
      svx = -s.kin.omega * (py - s.kin.cy);
      svy = s.kin.omega * (px - s.kin.cx);
    }
    const j = this.resolve(b, nx, ny, min - d, svx, svy, Math.min(b.restitution, s.restitution), Math.max(b.friction, s.friction));
    if (j > 0) onContact?.({ body: b, other: s, kind: 'segment', impulse: j, x: px, y: py });
  }

  private collideDisc(b: Body, c: Disc, onContact?: (c: Contact) => void) {
    const ox = b.x - c.x;
    const oy = b.y - c.y;
    const d = hypot(ox, oy);
    const min = b.r + c.r;
    if (d >= min || d === 0) return;
    const nx = ox / d;
    const ny = oy / d;
    const j = this.resolve(b, nx, ny, min - d, 0, 0, Math.max(b.restitution, c.restitution), b.friction);
    if (j > 0) {
      if (c.kick) {
        b.vx += nx * c.kick;
        b.vy += ny * c.kick;
      }
      onContact?.({ body: b, other: c, kind: 'disc', impulse: j, x: c.x + nx * c.r, y: c.y + ny * c.r });
    }
  }

  private collideBodies(onContact?: (c: Contact) => void) {
    const cell = Math.max(32, ...this.bodies.map((b) => b.r * 2));
    const grid = new Map<number, number[]>();
    this.bodies.forEach((b, i) => {
      if (!b.alive) return;
      const k = key(Math.floor(b.x / cell), Math.floor(b.y / cell));
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    });
    for (let i = 0; i < this.bodies.length; i++) {
      const a = this.bodies[i];
      if (!a.alive) continue;
      const cx = Math.floor(a.x / cell);
      const cy = Math.floor(a.y / cell);
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          const list = grid.get(key(gx, gy));
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            this.collidePair(a, this.bodies[j], onContact);
          }
        }
      }
    }
  }

  private collidePair(a: Body, b: Body, onContact?: (c: Contact) => void) {
    const ox = b.x - a.x;
    const oy = b.y - a.y;
    const d = hypot(ox, oy);
    const min = a.r + b.r;
    if (d >= min || d === 0) return;
    const nx = ox / d;
    const ny = oy / d;
    const im = a.invMass + b.invMass;
    if (im === 0) return;
    const pen = min - d;
    a.x -= nx * pen * (a.invMass / im);
    a.y -= ny * pen * (a.invMass / im);
    b.x += nx * pen * (b.invMass / im);
    b.y += ny * pen * (b.invMass / im);
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn >= 0) return;
    const e = Math.min(a.restitution, b.restitution);
    const j = (-(1 + e) * vn) / im;
    a.vx -= j * nx * a.invMass;
    a.vy -= j * ny * a.invMass;
    b.vx += j * nx * b.invMass;
    b.vy += j * ny * b.invMass;
    onContact?.({ body: a, other: b, kind: 'body', impulse: j, x: a.x + nx * a.r, y: a.y + ny * a.r });
  }
}
