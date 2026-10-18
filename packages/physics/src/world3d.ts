import * as dm from './math';

/**
 * Minimal deterministic 3D physics for sphere bodies against static and spinning shapes: planes,
 * oriented boxes, vertical tubes (solid posts when the inner radius is 0, cup walls otherwise, whose
 * square-edged rim is a real circle a ball can rattle on) and spheres. The 3D sibling of World:
 * same impulse and friction model, same insertion-order iteration, so a setup always plays out the
 * same way. Only sqrt and the deterministic trig in ./math are used.
 */

export interface Body3 {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  invMass: number;
  restitution: number;
  friction: number;
  alive: boolean;
}

/** Row-major 3×3 rotation: columns are the shape's local x, y and z axes in world space. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

interface ShapeBase {
  restitution: number;
  friction: number;
  tag: string;
  active: boolean;
}

/** One-sided plane n·p = d (n unit, pointing into the allowed side). */
export interface Plane3 extends ShapeBase {
  kind: 'plane';
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

export interface Box3 extends ShapeBase {
  kind: 'box';
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  rot: Mat3;
  /** Spinning about the vertical axis through its centre: rot is rebuilt from angle each step. */
  spin?: { angle: number; omega: number; tilt: Mat3 };
}

/** Vertical tube: solid between radii ri..ro and heights y0..y1 (ri = 0 is a solid post). */
export interface Tube3 extends ShapeBase {
  kind: 'tube';
  cx: number;
  cz: number;
  y0: number;
  y1: number;
  ri: number;
  ro: number;
}

export interface Sphere3 extends ShapeBase {
  kind: 'sphere';
  x: number;
  y: number;
  z: number;
  r: number;
  /** Extra outward speed on contact (bumpers). */
  kick?: number;
}

export type Shape3 = Plane3 | Box3 | Tube3 | Sphere3;

export interface Contact3 {
  body: Body3;
  other: Body3 | Shape3;
  kind: 'body' | 'shape';
  impulse: number;
  x: number;
  y: number;
  z: number;
}

/** Rotation from yaw (about y), then pitch (about x), then roll (about z). */
export function rotation(yaw: number, pitch = 0, roll = 0): Mat3 {
  const cy = dm.cos(yaw), sy = dm.sin(yaw);
  const cp = dm.cos(pitch), sp = dm.sin(pitch);
  const cr = dm.cos(roll), sr = dm.sin(roll);
  // Ry · Rx · Rz
  return [
    cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp,
    cp * sr, cp * cr, -sp,
    -sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp,
  ];
}

const mul = (a: Mat3, b: Mat3): Mat3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];

const CELL = 1;
const key = (x: number, y: number, z: number) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);

/** Where a sphere centre is relative to a shape: the surface normal toward it and its distance out. */
interface Near {
  nx: number;
  ny: number;
  nz: number;
  /** Signed distance from the surface (negative: the centre is inside the shape). */
  dist: number;
  /** Closest surface point. */
  px: number;
  py: number;
  pz: number;
}

const near: Near = { nx: 0, ny: 1, nz: 0, dist: 0, px: 0, py: 0, pz: 0 };

function nearPlane(s: Plane3, x: number, y: number, z: number): Near {
  near.dist = s.nx * x + s.ny * y + s.nz * z - s.d;
  near.nx = s.nx;
  near.ny = s.ny;
  near.nz = s.nz;
  near.px = x - s.nx * near.dist;
  near.py = y - s.ny * near.dist;
  near.pz = z - s.nz * near.dist;
  return near;
}

function nearSphere(s: Sphere3, x: number, y: number, z: number): Near {
  const ox = x - s.x, oy = y - s.y, oz = z - s.z;
  const d = Math.sqrt(ox * ox + oy * oy + oz * oz);
  if (d === 0) {
    near.nx = 0, near.ny = 1, near.nz = 0;
  } else {
    near.nx = ox / d, near.ny = oy / d, near.nz = oz / d;
  }
  near.dist = d - s.r;
  near.px = s.x + near.nx * s.r;
  near.py = s.y + near.ny * s.r;
  near.pz = s.z + near.nz * s.r;
  return near;
}

function nearBox(s: Box3, x: number, y: number, z: number): Near {
  const R = s.rot;
  const dx = x - s.cx, dy = y - s.cy, dz = z - s.cz;
  // Into the box's frame (Rᵀ · d).
  const lx = R[0] * dx + R[3] * dy + R[6] * dz;
  const ly = R[1] * dx + R[4] * dy + R[7] * dz;
  const lz = R[2] * dx + R[5] * dy + R[8] * dz;
  const qx = Math.max(-s.hx, Math.min(s.hx, lx));
  const qy = Math.max(-s.hy, Math.min(s.hy, ly));
  const qz = Math.max(-s.hz, Math.min(s.hz, lz));
  let nlx: number, nly: number, nlz: number, dist: number;
  let px = qx, py = qy, pz = qz;
  if (qx === lx && qy === ly && qz === lz) {
    // Inside: out through the nearest face.
    const fx = s.hx - Math.abs(lx), fy = s.hy - Math.abs(ly), fz = s.hz - Math.abs(lz);
    nlx = nly = nlz = 0;
    if (fx <= fy && fx <= fz) {
      nlx = lx < 0 ? -1 : 1;
      px = nlx * s.hx;
      dist = -fx;
    } else if (fy <= fz) {
      nly = ly < 0 ? -1 : 1;
      py = nly * s.hy;
      dist = -fy;
    } else {
      nlz = lz < 0 ? -1 : 1;
      pz = nlz * s.hz;
      dist = -fz;
    }
  } else {
    const ex = lx - qx, ey = ly - qy, ez = lz - qz;
    dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
    nlx = ex / dist, nly = ey / dist, nlz = ez / dist;
  }
  near.nx = R[0] * nlx + R[1] * nly + R[2] * nlz;
  near.ny = R[3] * nlx + R[4] * nly + R[5] * nlz;
  near.nz = R[6] * nlx + R[7] * nly + R[8] * nlz;
  near.dist = dist;
  near.px = s.cx + R[0] * px + R[1] * py + R[2] * pz;
  near.py = s.cy + R[3] * px + R[4] * py + R[5] * pz;
  near.pz = s.cz + R[6] * px + R[7] * py + R[8] * pz;
  return near;
}

/** Closest point in the tube's (radius, height) cross-section, mapped back round the axis. */
function nearTube(s: Tube3, x: number, y: number, z: number): Near {
  const ox = x - s.cx, oz = z - s.cz;
  const rho = Math.sqrt(ox * ox + oz * oz);
  const ux = rho > 0 ? ox / rho : 1;
  const uz = rho > 0 ? oz / rho : 0;
  const qr = Math.max(s.ri, Math.min(s.ro, rho));
  const qy = Math.max(s.y0, Math.min(s.y1, y));
  let nr: number, ny: number, dist: number;
  let pr = qr, py = qy;
  if (qr === rho && qy === y) {
    // Inside the wall: out through the nearest of the inner side, outer side, top and bottom.
    const fi = s.ri > 0 ? rho - s.ri : Infinity;
    const fo = s.ro - rho;
    const ft = s.y1 - y;
    const fb = y - s.y0;
    const m = Math.min(fi, fo, ft, fb);
    nr = ny = 0;
    if (m === ft) {
      ny = 1;
      py = s.y1;
    } else if (m === fo) {
      nr = 1;
      pr = s.ro;
    } else if (m === fi) {
      nr = -1;
      pr = s.ri;
    } else {
      ny = -1;
      py = s.y0;
    }
    dist = -m;
  } else {
    const er = rho - qr, ey = y - qy;
    dist = Math.sqrt(er * er + ey * ey);
    nr = er / dist;
    ny = ey / dist;
  }
  near.nx = ux * nr;
  near.ny = ny;
  near.nz = uz * nr;
  near.dist = dist;
  near.px = s.cx + ux * pr;
  near.py = py;
  near.pz = s.cz + uz * pr;
  return near;
}

function nearShape(s: Shape3, x: number, y: number, z: number): Near {
  switch (s.kind) {
    case 'plane':
      return nearPlane(s, x, y, z);
    case 'sphere':
      return nearSphere(s, x, y, z);
    case 'box':
      return nearBox(s, x, y, z);
    case 'tube':
      return nearTube(s, x, y, z);
  }
}

function bounds(s: Shape3): [number, number, number, number, number, number] | null {
  switch (s.kind) {
    case 'plane':
      return null;
    case 'sphere':
      return [s.x - s.r, s.y - s.r, s.z - s.r, s.x + s.r, s.y + s.r, s.z + s.r];
    case 'tube':
      return [s.cx - s.ro, s.y0, s.cz - s.ro, s.cx + s.ro, s.y1, s.cz + s.ro];
    case 'box': {
      const R = s.rot;
      const ex = Math.abs(R[0]) * s.hx + Math.abs(R[1]) * s.hy + Math.abs(R[2]) * s.hz;
      const ey = Math.abs(R[3]) * s.hx + Math.abs(R[4]) * s.hy + Math.abs(R[5]) * s.hz;
      const ez = Math.abs(R[6]) * s.hx + Math.abs(R[7]) * s.hy + Math.abs(R[8]) * s.hz;
      return [s.cx - ex, s.cy - ey, s.cz - ez, s.cx + ex, s.cy + ey, s.cz + ez];
    }
  }
}

export class World3D {
  bodies: Body3[] = [];
  shapes: Shape3[] = [];
  gravity = 14;
  private grid = new Map<number, number[]>();
  /** Shapes tested against every body: planes and spinners. */
  private always: number[] = [];
  private nextId = 0;

  addBody(b: Omit<Body3, 'id' | 'alive' | 'invMass' | 'restitution' | 'friction'> & Partial<Body3>): Body3 {
    const body: Body3 = { invMass: 1, restitution: 0.5, friction: 0.05, alive: true, ...b, id: this.nextId++ };
    this.bodies.push(body);
    return body;
  }

  /** Add a shape (restitution 0.5, friction 0.05 and tag 'wall' unless given). */
  add<S extends Shape3>(s: Omit<S, 'restitution' | 'friction' | 'tag' | 'active'> & Partial<ShapeBase>): S {
    const shape = { restitution: 0.5, friction: 0.05, tag: 'wall', active: true, ...s } as S;
    const idx = this.shapes.push(shape) - 1;
    if (shape.kind === 'box' && shape.spin) this.updateSpin(shape, 0);
    const b = shape.kind === 'box' && shape.spin ? null : bounds(shape);
    if (!b) this.always.push(idx);
    else {
      for (let cz = Math.floor(b[2] / CELL); cz <= Math.floor(b[5] / CELL); cz++)
        for (let cy = Math.floor(b[1] / CELL); cy <= Math.floor(b[4] / CELL); cy++)
          for (let cx = Math.floor(b[0] / CELL); cx <= Math.floor(b[3] / CELL); cx++) {
            const k = key(cx, cy, cz);
            const cell = this.grid.get(k);
            if (cell) cell.push(idx);
            else this.grid.set(k, [idx]);
          }
    }
    return shape;
  }

  /** A box spinning about the vertical axis through its centre (tilt: its pose before spinning). */
  addSpinner(b: Omit<Box3, 'kind' | 'rot' | 'spin' | 'restitution' | 'friction' | 'tag' | 'active'> & Partial<ShapeBase>, angle: number, omega: number, tilt: Mat3 = rotation(0)): Box3 {
    return this.add<Box3>({ ...b, kind: 'box', rot: tilt, spin: { angle, omega, tilt } });
  }

  private updateSpin(s: Box3, dt: number) {
    const k = s.spin!;
    k.angle += k.omega * dt;
    s.rot = mul(rotation(k.angle), k.tilt);
  }

  step(dt: number, onContact?: (c: Contact3) => void) {
    for (const i of this.always) {
      const s = this.shapes[i];
      if (s.kind === 'box' && s.spin) this.updateSpin(s, dt);
    }
    for (const b of this.bodies) {
      if (!b.alive || b.invMass === 0) continue;
      b.vy -= this.gravity * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
    }
    this.collideBodies(onContact);
    for (const b of this.bodies) {
      if (!b.alive) continue;
      const seen = new Set<number>();
      for (let cz = Math.floor((b.z - b.r) / CELL); cz <= Math.floor((b.z + b.r) / CELL); cz++)
        for (let cy = Math.floor((b.y - b.r) / CELL); cy <= Math.floor((b.y + b.r) / CELL); cy++)
          for (let cx = Math.floor((b.x - b.r) / CELL); cx <= Math.floor((b.x + b.r) / CELL); cx++) {
            const cell = this.grid.get(key(cx, cy, cz));
            if (!cell) continue;
            for (const i of cell) {
              if (seen.has(i)) continue;
              seen.add(i);
              this.collideShape(b, this.shapes[i], onContact);
            }
          }
      for (const i of this.always) this.collideShape(b, this.shapes[i], onContact);
    }
  }

  private collideShape(b: Body3, s: Shape3, onContact?: (c: Contact3) => void) {
    if (!s.active || !b.alive) return;
    const n = nearShape(s, b.x, b.y, b.z);
    if (n.dist >= b.r) return;
    const { nx, ny, nz, px, py, pz } = n;
    const pen = b.r - n.dist;
    // Surface velocity of a spinner at the contact point: ω × (p − c), ω vertical.
    let svx = 0, svz = 0;
    if (s.kind === 'box' && s.spin) {
      svx = s.spin.omega * (pz - s.cz);
      svz = -s.spin.omega * (px - s.cx);
    }
    const e = s.kind === 'sphere' ? Math.max(b.restitution, s.restitution) : Math.min(b.restitution, s.restitution);
    const j = resolve(b, nx, ny, nz, pen, svx, 0, svz, e, Math.max(b.friction, s.friction));
    if (j > 0) {
      if (s.kind === 'sphere' && s.kick) {
        b.vx += nx * s.kick;
        b.vy += ny * s.kick;
        b.vz += nz * s.kick;
      }
      onContact?.({ body: b, other: s, kind: 'shape', impulse: j, x: px, y: py, z: pz });
    }
  }

  private collideBodies(onContact?: (c: Contact3) => void) {
    let maxR = 0;
    for (const b of this.bodies) if (b.alive) maxR = Math.max(maxR, b.r);
    if (maxR === 0) return;
    const cell = maxR * 2;
    const grid = new Map<number, number[]>();
    this.bodies.forEach((b, i) => {
      if (!b.alive) return;
      const k = key(Math.floor(b.x / cell), Math.floor(b.y / cell), Math.floor(b.z / cell));
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    });
    for (let i = 0; i < this.bodies.length; i++) {
      const a = this.bodies[i];
      if (!a.alive) continue;
      const cx = Math.floor(a.x / cell), cy = Math.floor(a.y / cell), cz = Math.floor(a.z / cell);
      for (let gz = cz - 1; gz <= cz + 1; gz++)
        for (let gy = cy - 1; gy <= cy + 1; gy++)
          for (let gx = cx - 1; gx <= cx + 1; gx++) {
            const list = grid.get(key(gx, gy, gz));
            if (!list) continue;
            for (const j of list) if (j > i) collidePair(a, this.bodies[j], onContact);
          }
    }
  }
}

/** Push a body out along n and apply a restitution impulse plus Coulomb friction. Returns the impulse. */
function resolve(b: Body3, nx: number, ny: number, nz: number, pen: number, svx: number, svy: number, svz: number, e: number, mu: number): number {
  b.x += nx * pen;
  b.y += ny * pen;
  b.z += nz * pen;
  const rvx = b.vx - svx, rvy = b.vy - svy, rvz = b.vz - svz;
  const vn = rvx * nx + rvy * ny + rvz * nz;
  if (vn >= 0) return 0;
  const j = -(1 + e) * vn;
  b.vx += j * nx;
  b.vy += j * ny;
  b.vz += j * nz;
  const tx = rvx - vn * nx, ty = rvy - vn * ny, tz = rvz - vn * nz;
  const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (vt > 0) {
    const f = Math.min(vt, mu * j) / vt;
    b.vx -= f * tx;
    b.vy -= f * ty;
    b.vz -= f * tz;
  }
  return j;
}

function collidePair(a: Body3, b: Body3, onContact?: (c: Contact3) => void) {
  const ox = b.x - a.x, oy = b.y - a.y, oz = b.z - a.z;
  const d = Math.sqrt(ox * ox + oy * oy + oz * oz);
  const min = a.r + b.r;
  if (d >= min || d === 0) return;
  const nx = ox / d, ny = oy / d, nz = oz / d;
  const im = a.invMass + b.invMass;
  if (im === 0) return;
  const pen = min - d;
  a.x -= nx * pen * (a.invMass / im);
  a.y -= ny * pen * (a.invMass / im);
  a.z -= nz * pen * (a.invMass / im);
  b.x += nx * pen * (b.invMass / im);
  b.y += ny * pen * (b.invMass / im);
  b.z += nz * pen * (b.invMass / im);
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny + (b.vz - a.vz) * nz;
  if (vn >= 0) return;
  const j = (-(1 + Math.min(a.restitution, b.restitution)) * vn) / im;
  a.vx -= j * nx * a.invMass;
  a.vy -= j * ny * a.invMass;
  a.vz -= j * nz * a.invMass;
  b.vx += j * nx * b.invMass;
  b.vy += j * ny * b.invMass;
  b.vz += j * nz * b.invMass;
  onContact?.({ body: a, other: b, kind: 'body', impulse: j, x: a.x + nx * a.r, y: a.y + ny * a.r, z: a.z + nz * a.r });
}
