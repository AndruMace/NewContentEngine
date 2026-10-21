/**
 * Geometry for the procedural creatures: faceted, flat-shaded triangles with per-face colour, built
 * from lofts (rings swept along a path), cones and wedges. Bodies can carry skin weights (up to two
 * bones per vertex) so one continuous mesh bends along a spine and tail.
 *
 * Model space: metres, +Z forward, +Y up, ground at y = 0.
 */
import { THREE } from '../../three-layer';

export type V3 = [number, number, number];
/** Two bones and their weights. */
export type Skin = [number, number, number, number];

/** Deterministic noise in [0, 1). */
export const hash = (n: number) => {
  const s = Math.sin(n * 91.3458 + 47.853) * 43758.5453;
  return s - Math.floor(s);
};

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export class MeshBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private si: number[] = [];
  private sw: number[] = [];

  /** One triangle (counter-clockwise seen from outside), its colour the average of the three given. */
  tri(a: V3, b: V3, c: V3, ca: THREE.Color, cb: THREE.Color = ca, cc: THREE.Color = ca, skin: [Skin, Skin, Skin] | null = null) {
    const r = (ca.r + cb.r + cc.r) / 3;
    const g = (ca.g + cb.g + cc.g) / 3;
    const bl = (ca.b + cb.b + cc.b) / 3;
    for (const [k, p] of [a, b, c].entries()) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(r, g, bl);
      const s = skin ? skin[k] : ([0, 0, 1, 0] as Skin);
      this.si.push(s[0], s[1], 0, 0);
      this.sw.push(s[2], s[3], 0, 0);
    }
  }

  get triangles() {
    return this.pos.length / 9;
  }

  /** Every vertex so far (x, y, z flattened), for measuring a shape without building it. */
  get points(): readonly number[] {
    return this.pos;
  }

  build(skinned = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (skinned) {
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    }
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** A cross-section of a loft: centre, half-width, half-height, and shaping. */
export interface Ring {
  c: V3;
  w: number;
  h: number;
  /** Flatten the underside (0..1). */
  flat?: number;
  /** A ridge along the top (0..1 of the height). */
  ridge?: number;
  /** Shift the widest point up (+) or down (-), as a fraction of the height (a pear-shaped section). */
  pear?: number;
}

/** Catmull-Rom resample of control rings: `per` rings for every span between two control rings. */
export function smoothRings(ctrl: Ring[], per: number): Ring[] {
  const out: Ring[] = [];
  const n = ctrl.length;
  const at = (i: number) => ctrl[Math.max(0, Math.min(n - 1, i))];
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      const f = (get: (r: Ring) => number) => cr(get(a), get(b), get(c), get(d), t);
      out.push({
        c: [f((r) => r.c[0]), f((r) => r.c[1]), f((r) => r.c[2])],
        w: Math.max(0.004, f((r) => r.w)),
        h: Math.max(0.004, f((r) => r.h)),
        flat: f((r) => r.flat ?? 0),
        ridge: f((r) => r.ridge ?? 0),
        pear: f((r) => r.pear ?? 0),
      });
    }
  }
  out.push({ ...ctrl[n - 1] });
  return out;
}

export interface LoftOpts {
  sides: number;
  /** Reference "up" for the ring frames (use the forward axis for paths that run up or down). */
  ref?: V3;
  /** Random radial jitter per vertex (fraction), for organic facets. */
  jitter?: number;
  seed: number;
  /** Colour of a vertex: t along the path (0..1), angle round the ring (0 = side, π/2 = top), its position. */
  color: (t: number, ang: number, p: V3) => THREE.Color;
  /** Close the ends with a point pushed out this far along the path (0 = flat). */
  capStart?: number;
  capEnd?: number;
  /** Skin weights for a point (skinned bodies). */
  skin?: (p: V3) => Skin;
  /** Rotate the ring vertices round the path (radians), so facets don't line up with the axes. */
  twist?: number;
}

/** Sweep rings along their centres into a closed tube. */
export function loft(b: MeshBuilder, rings: Ring[], o: LoftOpts) {
  const n = rings.length;
  const S = o.sides;
  const ref = o.ref ?? [0, 1, 0];
  const verts: V3[][] = [];
  const cols: THREE.Color[][] = [];
  const tans: V3[] = [];
  for (let i = 0; i < n; i++) {
    const r = rings[i];
    const t = norm(sub(rings[Math.min(n - 1, i + 1)].c, rings[Math.max(0, i - 1)].c));
    tans.push(t);
    const side = norm(cross(ref, t));
    const up = cross(t, side);
    const row: V3[] = [];
    const crow: THREE.Color[] = [];
    for (let j = 0; j < S; j++) {
      const a = (j / S) * Math.PI * 2 + (o.twist ?? 0);
      const sa = Math.sin(a);
      const jit = 1 + (o.jitter ?? 0) * (hash(o.seed * 7.13 + i * 31.7 + j * 5.31) - 0.5) * 2;
      let x = r.w * Math.cos(a) * jit;
      let y = r.h * sa * jit;
      if (sa < 0) y *= 1 - (r.flat ?? 0);
      if (sa > 0 && r.ridge) y += r.h * r.ridge * Math.pow(sa, 8);
      if (r.pear) x *= 1 + r.pear * sa;
      const p = add(r.c, add(mul(side, x), mul(up, y)));
      row.push(p);
      crow.push(o.color(i / (n - 1), a, p));
    }
    verts.push(row);
    cols.push(crow);
  }
  const sk = (p: V3) => (o.skin ? o.skin(p) : ([0, 0, 1, 0] as Skin));
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < S; j++) {
      const j1 = (j + 1) % S;
      const [a, bb, c, d] = [verts[i][j], verts[i][j1], verts[i + 1][j], verts[i + 1][j1]];
      b.tri(a, bb, c, cols[i][j], cols[i][j1], cols[i + 1][j], o.skin ? [sk(a), sk(bb), sk(c)] : null);
      b.tri(bb, d, c, cols[i][j1], cols[i + 1][j1], cols[i + 1][j], o.skin ? [sk(bb), sk(d), sk(c)] : null);
    }
  const cap = (i: number, out: number, dir: 1 | -1) => {
    const r = rings[i];
    const centre = add(r.c, mul(tans[i], out * dir * Math.max(r.w, r.h)));
    const cc = o.color(i / (n - 1), Math.PI / 2, centre);
    for (let j = 0; j < S; j++) {
      const j1 = (j + 1) % S;
      if (dir < 0) b.tri(centre, verts[i][j1], verts[i][j], cc, cols[i][j1], cols[i][j], o.skin ? [sk(centre), sk(verts[i][j1]), sk(verts[i][j])] : null);
      else b.tri(centre, verts[i][j], verts[i][j1], cc, cols[i][j], cols[i][j1], o.skin ? [sk(centre), sk(verts[i][j]), sk(verts[i][j1])] : null);
    }
  };
  if (o.capStart !== undefined) cap(0, o.capStart, -1);
  if (o.capEnd !== undefined) cap(n - 1, o.capEnd, 1);
}

/** A cone (tooth, claw, horn, spike) from base centre along `dir`, `sides` facets. */
export function cone(b: MeshBuilder, base: V3, dir: V3, len: number, r: number, color: THREE.Color, sides = 4, skin?: Skin, tip?: THREE.Color) {
  const t = norm(dir);
  const ref: V3 = Math.abs(t[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  const s = norm(cross(ref, t));
  const u = cross(t, s);
  const apex = add(base, mul(t, len));
  const ring: V3[] = [];
  for (let j = 0; j < sides; j++) {
    const a = (j / sides) * Math.PI * 2;
    ring.push(add(base, add(mul(s, Math.cos(a) * r), mul(u, Math.sin(a) * r))));
  }
  const sk: [Skin, Skin, Skin] | null = skin ? [skin, skin, skin] : null;
  for (let j = 0; j < sides; j++) {
    const j1 = (j + 1) % sides;
    b.tri(ring[j], ring[j1], apex, color, color, tip ?? color, sk);
    b.tri(base, ring[j1], ring[j], color, color, color, sk);
  }
}

/** A low-poly blob (eye, nose, knuckle): an octahedron stretched to half-sizes (sx, sy, sz). */
export function blob(b: MeshBuilder, c: V3, sx: number, sy: number, sz: number, color: THREE.Color, skin?: Skin) {
  const px: V3 = [c[0] + sx, c[1], c[2]];
  const nx: V3 = [c[0] - sx, c[1], c[2]];
  const py: V3 = [c[0], c[1] + sy, c[2]];
  const ny: V3 = [c[0], c[1] - sy, c[2]];
  const pz: V3 = [c[0], c[1], c[2] + sz];
  const nz: V3 = [c[0], c[1], c[2] - sz];
  const sk: [Skin, Skin, Skin] | null = skin ? [skin, skin, skin] : null;
  const f = (a: V3, bb: V3, cc: V3) => b.tri(a, bb, cc, color, color, color, sk);
  f(px, py, pz);
  f(pz, py, nx);
  f(nx, py, nz);
  f(nz, py, px);
  f(pz, ny, px);
  f(nx, ny, pz);
  f(nz, ny, nx);
  f(px, ny, nz);
}

/** Mix two colours with a little per-point noise in brightness. */
export function shade(base: THREE.Color, k: number, p: V3, amount = 0.08): THREE.Color {
  const n = (hash(p[0] * 13.1 + p[1] * 71.7 + p[2] * 37.3) - 0.5) * 2 * amount;
  return base.clone().multiplyScalar(Math.max(0, k + n));
}

export const rgb = (hex: string) => new THREE.Color(hex);
export const lerpColor = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, Math.max(0, Math.min(1, t)));
export const v3 = { sub, add, mul, cross, norm };
