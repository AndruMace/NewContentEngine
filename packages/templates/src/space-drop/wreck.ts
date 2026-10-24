/**
 * What an object looks like after it hits the ground at the end of its fall: the very model it fell
 * as, in the attitude it landed in, crumpled along the line it hit on (flattened where it touched,
 * buckled in folds, creased, bulging out sideways) and pressed into the dent it digs. It rebounds a
 * little and rocks to rest. Wheels, trim, a turret or wings tear off and tumble away; glass bursts
 * into shards; fragments of panel, plastic and metal scatter; the dust settles on it. Rendering only.
 *
 * How far it crushes comes from the work that takes: a structure that resists with an average force
 * F gives way through d = m v² / 2F (a car's crumple zone, ~0.6 m at 50 km/h, is ~4e5 N), until
 * it's packed nearly solid.
 *
 * The heavy lifting is spread out so the impact itself never stutters: the surfaces are subdivided
 * and the wreck drawn (too small to see, so its shaders compile) from when the scene is built, and
 * the crush is worked out a slice per frame while the object comes in to land (its attitude is
 * settled by then).
 */
import { THREE } from '../three-layer';
import type { Detach } from './models';

export interface CrushSpec {
  /** Average force the structure resists crushing with (N). */
  force: number;
  /** The most it can be crushed, as a fraction of its height along the hit. */
  max: number;
  /** Rebound speed as a fraction of the impact speed. */
  bounce: number;
}

/** By the name of what lands. Anything not listed (rocks, an anvil, a cow) lands whole. */
export const CRUSH: Record<string, CrushSpec> = {
  car: { force: 4e5, max: 0.6, bounce: 0.04 },
  'pickup truck': { force: 6e5, max: 0.58, bounce: 0.04 },
  'school bus': { force: 1.5e6, max: 0.6, bounce: 0.03 },
  tank: { force: 4e7, max: 0.35, bounce: 0.03 },
  'jumbo jet': { force: 4e6, max: 0.65, bounce: 0.03 },
  'shipping container': { force: 3e6, max: 0.55, bounce: 0.04 },
  refrigerator: { force: 3e4, max: 0.55, bounce: 0.05 },
  'grand piano': { force: 8e4, max: 0.6, bounce: 0.04 },
  satellite: { force: 2e5, max: 0.55, bounce: 0.05 },
  'station module': { force: 3e6, max: 0.5, bounce: 0.04 },
  'engine block': { force: 6e7, max: 0.12, bounce: 0.05 },
  'engine and frame': { force: 6e7, max: 0.15, bounce: 0.05 },
  'diesel engine': { force: 1e8, max: 0.12, bounce: 0.04 },
  'jet engine': { force: 2e7, max: 0.35, bounce: 0.04 },
  'hull section': { force: 2e8, max: 0.6, bounce: 0.01 },
  'steel docking frame': { force: 3e7, max: 0.3, bounce: 0.04 },
};

/** Brittle things that burst apart rather than crumple: how many chunks they break into. */
export const SHATTER: Record<string, { chunks: number }> = {
  'brick chimney': { chunks: 150 },
};

/**
 * How much of its height (along the hit) it's crushed by: the work done crushing it through d against
 * force F takes all its kinetic energy, d = m v² / 2F, eased into the most it can give.
 */
export function crushFraction(spec: CrushSpec, mass: number, v: number, H: number): number {
  const d = (mass * v * v) / (2 * spec.force);
  return spec.max * (1 - Math.exp(-d / (H * spec.max)));
}

const G = 9.81;
/** Sampling of the precomputed paths (physical s), and how long they run. */
const STEP = 1 / 100;
const SPAN = 9;
const SAMPLES = Math.ceil(SPAN / STEP) + 1;

export interface CraterShape {
  /** Radius, depth and rim height of the finished crater (m). */
  R: number;
  depth: number;
  rim: number;
}

/** Ground height of the finished crater at distance r from its centre (matches the ground shader). */
export function bowl(cr: CraterShape, r: number): number {
  if (cr.R <= 0) return 0;
  const x = r / cr.R;
  return x < 1 ? -cr.depth * (1 - x * x) + cr.rim * x ** 5 : cr.rim * x ** -3;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The transform from an object's space to an ancestor's. */
export function relativeTo(o: THREE.Object3D, top: THREE.Object3D, out: THREE.Matrix4): THREE.Matrix4 {
  out.identity();
  for (let p: THREE.Object3D | null = o; p && p !== top; p = p.parent) {
    p.updateMatrix();
    out.premultiply(p.matrix);
  }
  return out;
}

function meshesUnder(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh);
  });
  return out;
}

const materialsOf = (m: THREE.Mesh) => (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];

/**
 * Splits every edge longer than `maxEdge` at its midpoint until none is, so the surface can fold.
 * Whether an edge splits, and where, depends only on its two ends, so the triangles either side of
 * it split it alike and no cracks open when it bends (three's TessellateModifier splits one edge of
 * a triangle at a time and leaves T-junctions that tear open).
 */
export function subdivide(geo: THREE.BufferGeometry, maxEdge: number, maxTris = 160000): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const names = Object.keys(src.attributes);
  const sizes = names.map((n) => (src.attributes[n] as THREE.BufferAttribute).itemSize);
  let data = names.map((n) => Float32Array.from((src.attributes[n] as THREE.BufferAttribute).array as ArrayLike<number>));
  const P = names.indexOf('position');
  const m2 = maxEdge * maxEdge;
  for (let it = 0; it < 8; it++) {
    const pos = data[P];
    const nTri = pos.length / 9;
    const split = new Uint8Array(nTri);
    let outTris = 0;
    for (let t = 0; t < nTri; t++) {
      let bits = 0;
      for (let e = 0; e < 3; e++) {
        const i = t * 9 + e * 3;
        const j = t * 9 + ((e + 1) % 3) * 3;
        const d2 = (pos[i] - pos[j]) ** 2 + (pos[i + 1] - pos[j + 1]) ** 2 + (pos[i + 2] - pos[j + 2]) ** 2;
        if (d2 > m2) bits |= 1 << e;
      }
      split[t] = bits;
      outTris += (bits & 1) + ((bits >> 1) & 1) + ((bits >> 2) & 1) + 1;
    }
    if (outTris === nTri || outTris > maxTris) break;
    const out = data.map((_, k) => new Float32Array(outTris * 3 * sizes[k]));
    let o = 0;
    // A corner: vertex a of triangle t (b === a), or the midpoint of its edge a–b.
    const put = (t: number, a: number, b: number) => {
      for (let k = 0; k < data.length; k++) {
        const sz = sizes[k];
        const from = data[k];
        const to = out[k];
        const ia = (t * 3 + a) * sz;
        const ib = (t * 3 + b) * sz;
        for (let d = 0; d < sz; d++) to[o * sz + d] = (from[ia + d] + from[ib + d]) / 2;
      }
      o++;
    };
    const tri = (t: number, a0: number, a1: number, b0: number, b1: number, c0: number, c1: number) => {
      put(t, a0, a1);
      put(t, b0, b1);
      put(t, c0, c1);
    };
    for (let t = 0; t < nTri; t++) {
      const bits = split[t];
      if (bits === 0) tri(t, 0, 0, 1, 1, 2, 2);
      else if (bits === 7) {
        tri(t, 0, 0, 0, 1, 2, 0);
        tri(t, 0, 1, 1, 1, 1, 2);
        tri(t, 2, 0, 1, 2, 2, 2);
        tri(t, 0, 1, 1, 2, 2, 0);
      } else if (bits === 1 || bits === 2 || bits === 4) {
        // One edge split (edge e runs from corner e to e + 1).
        const a = bits === 1 ? 0 : bits === 2 ? 1 : 2;
        const b = (a + 1) % 3;
        const c = (a + 2) % 3;
        tri(t, a, a, a, b, c, c);
        tri(t, a, b, b, b, c, c);
      } else {
        // Two split; the whole one runs c → a.
        const whole = ~bits & 7;
        const c = whole === 1 ? 0 : whole === 2 ? 1 : 2;
        const a = (c + 1) % 3;
        const b = (c + 2) % 3;
        tri(t, a, b, b, b, b, c);
        tri(t, a, a, a, b, b, c);
        tri(t, a, a, b, c, c, c);
      }
    }
    data = out;
  }
  const g = new THREE.BufferGeometry();
  names.forEach((n, k) => g.setAttribute(n, new THREE.BufferAttribute(data[k], sizes[k])));
  return g;
}

/** A material's overall colour (its texture's average, if it has one). */
function colourOf(m: THREE.MeshStandardMaterial, out: THREE.Color): THREE.Color {
  out.copy(m.color);
  const img = m.map?.image as (HTMLCanvasElement & OffscreenCanvas) | undefined;
  try {
    const c = img?.getContext?.('2d') as CanvasRenderingContext2D | null | undefined;
    if (c && img) {
      const d = c.getImageData(0, 0, img.width, img.height).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 97) {
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        n++;
      }
      out.multiply(new THREE.Color(r / n / 255, g / n / 255, b / n / 255).convertSRGBToLinear());
    }
  } catch {
    // No canvas to read: keep the material's colour.
  }
  return out;
}

/** Random points on some meshes' surfaces (in `top`'s space), with the mesh each came from. */
function surfacePoints(meshes: THREE.Mesh[], top: THREE.Object3D, n: number, r: () => number): { p: THREE.Vector3; mesh: THREE.Mesh }[] {
  const tris: { a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; mesh: THREE.Mesh; cum: number }[] = [];
  let total = 0;
  const M = new THREE.Matrix4();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (const m of meshes) {
    relativeTo(m, top, M);
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const idx = m.geometry.index;
    const count = idx ? idx.count : pos.count;
    const at = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(M);
    // Big meshes: a sample of their triangles is plenty.
    const stride = Math.max(1, Math.floor(count / 3 / 4000)) * 3;
    for (let i = 0; i + 2 < count; i += stride) {
      const a = at(i);
      const b = at(i + 1);
      const c = at(i + 2);
      const area = ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
      if (area <= 0) continue;
      total += area;
      tris.push({ a, b, c, mesh: m, cum: total });
    }
  }
  const out: { p: THREE.Vector3; mesh: THREE.Mesh }[] = [];
  if (!tris.length) return out;
  for (let k = 0; k < n; k++) {
    const x = r() * total;
    let lo = 0;
    let hi = tris.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tris[mid].cum < x) lo = mid + 1;
      else hi = mid;
    }
    const t = tris[lo];
    let u = r();
    let v = r();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    out.push({ p: t.a.clone().addScaledVector(ab.subVectors(t.b, t.a), u).addScaledVector(ac.subVectors(t.c, t.a), v), mesh: t.mesh });
  }
  return out;
}

interface Piece {
  obj: THREE.Object3D;
  kind: Detach;
  /** Per sample: position (3) and quaternion (4), in the wreck's frame. */
  path: Float32Array;
  /** Where and when it first hit the ground, and how big it is (for the gouge it leaves). */
  hit: { x: number; z: number; t: number; size: number } | null;
}

/** A shard or fragment: thrown at t0, flies, lands and skids to a stop lying flat. */
interface Flyer {
  t0: number;
  /** Where it's thrown from (crushed down with the body until then). */
  start: THREE.Vector3;
  vel: THREE.Vector3;
  T: number;
  land: THREE.Vector3;
  skid: THREE.Vector3;
  axis: THREE.Vector3;
  spin: number;
  q0: THREE.Quaternion;
  rest: THREE.Quaternion;
  scale: THREE.Vector3;
}

export interface WreckImpact {
  /** Attitude and scale of the model at the moment it touches. */
  q: THREE.Quaternion;
  scale: THREE.Vector3;
  /** Impact speed (m/s), its horizontal part (m/s, site frame), mass (kg). */
  v: number;
  vh: THREE.Vector3;
  mass: number;
  /** The object's size (m) and the crater it digs. */
  size: number;
  crater: CraterShape;
}

const tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), m: new THREE.Matrix4() };

export class Wreck {
  /** Everything, in the site frame with its origin at the point of contact. */
  readonly group = new THREE.Group();
  private readonly root = new THREE.Group();
  private readonly spec: CrushSpec | null;
  private readonly body: THREE.Mesh[] = [];
  private readonly glass: THREE.Mesh[] = [];
  private readonly pieces: Piece[] = [];
  private readonly shards: THREE.InstancedMesh;
  private readonly bits: THREE.InstancedMesh;
  /** Brittle things: the chunks they burst into, and the rubble mound they leave. */
  private readonly shatter: { chunks: number } | null;
  private readonly chunks: THREE.InstancedMesh;
  private readonly mound: THREE.Mesh;
  private chunkF: Flyer[] = [];
  private moundSize = 0;
  private shardF: Flyer[] = [];
  private bitF: Flyer[] = [];
  private coats: { m: THREE.MeshStandardMaterial; base: THREE.Color; rough: number }[] = [];
  private prepared = false;
  private jobs: (() => void)[] = [];
  private R = new THREE.Quaternion();
  private ymin = 0;
  private H = 1;
  private c = 0;
  private tc = 0.01;
  private vb = 0;
  private sink = 0;
  private slide = new THREE.Vector3();
  private carry = new THREE.Vector3();
  private rockAxis = new THREE.Vector3(1, 0, 0);
  private rock0 = 0;
  /** Left standing tall and narrow, it topples: about this edge on the ground, by this much, taking this long. */
  private pivot = new THREE.Vector3();
  private topAxis = new THREE.Vector3(1, 0, 0);
  private topple = 0;
  private topT = 1;
  /** How far above the ground its lowest point ends up once it has toppled (settled out as it falls). */
  private restDrop = 0;
  /** A burning engine bay (a marker in the model), where it is after the crush (root frame). */
  private smokeMark: THREE.Object3D | null = null;
  private smokeAt: THREE.Vector3 | null = null;
  /** How wide it is across the ground, for the scrape it leaves. */
  private width = 1;

  constructor(
    private readonly model: THREE.Group,
    name: string,
    private readonly seed: number,
    size: number,
  ) {
    this.spec = CRUSH[name] ?? null;
    this.root.add(model);
    this.group.add(this.root);
    this.group.visible = false;
    const walk = (o: THREE.Object3D) => {
      if (o !== model && o.userData.detach) {
        this.pieces.push({ obj: o, kind: o.userData.detach as Detach, path: new Float32Array(0), hit: null });
        // Its windows shatter too (a jet's cockpit, a tank's periscopes).
        o.traverse((c) => {
          if ((c as THREE.Mesh).isMesh && c.userData.glass) this.glass.push(c as THREE.Mesh);
        });
        return;
      }
      if (o.userData.smoke) this.smokeMark = o;
      if ((o as THREE.Mesh).isMesh) (o.userData.glass ? this.glass : this.body).push(o as THREE.Mesh);
      o.children.forEach(walk);
    };
    walk(model);
    // Fine enough to fold (each mesh's own scale taken into account), with a crush shape to fill in
    // later (a stand-in now, so the shaders it needs are compiled with the rest of the scene).
    if (this.spec)
      for (const m of this.body) {
        const s = Math.max(Math.abs(m.scale.x), Math.abs(m.scale.y), Math.abs(m.scale.z), 1e-6);
        // Its corners, kept for measuring it fast (the extra points lie between them).
        m.userData.hull = Float32Array.from((m.geometry.attributes.position as THREE.BufferAttribute).array as ArrayLike<number>);
        const geo = subdivide(m.geometry, size / 30 / s);
        m.geometry.dispose();
        m.geometry = geo;
        geo.morphAttributes.position = [(geo.attributes.position as THREE.BufferAttribute).clone()];
        geo.morphTargetsRelative = false;
        m.updateMorphTargets();
        m.morphTargetInfluences![0] = 0;
        for (const mat of materialsOf(m)) mat.flatShading = true;
      }
    // Shards and fragments share one shader (both coloured per instance).
    const shardMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.04, metalness: 1, envMapIntensity: 2.2, flatShading: true });
    this.shards = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1, 0).scale(1, 0.12, 0.8), shardMat, this.glass.length ? 220 : 1);
    const glassCol = new THREE.Color(0xd6e6f0);
    for (let i = 0; i < this.shards.count; i++) this.shards.setColorAt(i, glassCol);
    const bitMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.45, flatShading: true });
    this.bits = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0).scale(1, 0.16, 0.75), bitMat, 80);
    for (let i = 0; i < this.bits.count; i++) this.bits.setColorAt(i, glassCol);
    // Chunks of brickwork and a rubble mound, for things that burst apart.
    this.shatter = SHATTER[name] ?? null;
    this.chunks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.55, 0.7), bitMat.clone(), this.shatter?.chunks ?? 1);
    (this.chunks.material as THREE.MeshStandardMaterial).roughness = 0.9;
    (this.chunks.material as THREE.MeshStandardMaterial).metalness = 0;
    for (let i = 0; i < this.chunks.count; i++) this.chunks.setColorAt(i, glassCol);
    const moundGeo = new THREE.IcosahedronGeometry(1, 3);
    const mp = moundGeo.attributes.position as THREE.BufferAttribute;
    const rr = rng(seed + 5);
    const bumps = Array.from({ length: 12 }, () => new THREE.Vector3(rr() - 0.5, rr() - 0.5, rr() - 0.5).normalize());
    for (let i = 0; i < mp.count; i++) {
      tmp.a.fromBufferAttribute(mp, i);
      const n = tmp.a.clone().normalize();
      let f = 1;
      for (const b of bumps) f += 0.18 * Math.max(0, n.dot(b)) ** 6;
      f *= 0.9 + 0.2 * rr();
      tmp.a.multiplyScalar(f);
      tmp.a.y = Math.max(-0.05, tmp.a.y) * 0.2;
      mp.setXYZ(i, tmp.a.x, tmp.a.y, tmp.a.z);
    }
    // Broken brick, mortar and dust: each face its own shade.
    const flatMound = moundGeo.toNonIndexed();
    const mc = new Float32Array(flatMound.attributes.position.count * 3);
    for (let f = 0; f < mc.length; f += 9) {
      const k = 0.55 + 0.55 * rr();
      const dusty = rr() < 0.3;
      for (let j = 0; j < 3; j++) mc.set(dusty ? [0.5 * k, 0.45 * k, 0.4 * k] : [0.55 * k, 0.26 * k, 0.18 * k], f + j * 3);
    }
    flatMound.setAttribute('color', new THREE.BufferAttribute(mc, 3));
    flatMound.computeVertexNormals();
    this.mound = new THREE.Mesh(flatMound, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true, vertexColors: true }));
    this.mound.scale.setScalar(this.shatter ? 1e-6 : 0);
    this.group.add(this.shards, this.bits, this.chunks, this.mound);
    // Drawn wherever the camera looks, so it's always compiled before it's needed.
    this.group.traverse((o) => (o.frustumCulled = false));
    this.warm();
  }

  /**
   * Fixes how it lands (once: its attitude is settled before it touches) and queues the work that
   * follows from that.
   */
  prepare(make: () => WreckImpact) {
    if (this.prepared) return;
    this.prepared = true;
    const im = make();
    const r = rng(this.seed * 7919 + 13);
    this.R.copy(im.q);
    this.root.position.set(0, 0, 0);
    this.root.quaternion.copy(im.q);
    this.model.scale.copy(im.scale);
    const M = new THREE.Matrix4();
    // Its extent, over every part, in level site axes.
    const box = new THREE.Box3();
    for (const m of meshesUnder(this.model)) {
      relativeTo(m, this.group, M);
      const pts = (m.userData.hull as Float32Array | undefined) ?? ((m.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array);
      for (let i = 0; i < pts.length; i += 3) box.expandByPoint(tmp.a.set(pts[i], pts[i + 1], pts[i + 2]).applyMatrix4(M));
    }
    const ymin = box.min.y;
    const ymax = box.max.y;
    const H = Math.max(1e-3, ymax - ymin);
    this.ymin = ymin;
    this.H = H;
    const v = Math.max(1, im.v);
    const spec = this.spec;
    const c = spec ? crushFraction(spec, im.mass, v, H) : 0;
    this.c = c;
    // It decelerates over the distance it crushes (plus a little give in the ground).
    this.tc = Math.max(0.008, (2 * (H * c + 0.02 * H)) / v);
    this.vb = Math.min(6, (spec?.bounce ?? 0.03) * v);
    this.sink = spec ? 0 : im.crater.depth * 0.55;
    // It skids on a little the way it was going (the crater soaks up most of that), never far.
    this.slide.set(im.vh.x * 0.09 + (r() - 0.5) * 0.01 * v, 0, im.vh.z * 0.09 + (r() - 0.5) * 0.01 * v);
    this.slide.clampLength(0, 0.4 * im.crater.R + 0.3 * im.size);
    // What's thrown off keeps some of that sideways speed.
    this.carry.copy(im.vh).clampLength(0, 12);
    const ra = r() * Math.PI * 2;
    this.rockAxis.set(Math.cos(ra), 0, Math.sin(ra));
    this.rock0 = (0.05 + 0.08 * r()) * (spec ? 1 : 0.5);
    // Crushed end-on and left taller than it is wide, it falls over across its narrower side (the
    // way it was moving, if it was), pivoting on the bottom edge on that side.
    const wx = (box.max.x - box.min.x) * (1 + 0.16 * c);
    const wz = (box.max.z - box.min.z) * (1 + 0.16 * c);
    const Hc = H * (1 - c);
    this.topple = 0;
    if (Hc > 1.25 * Math.min(wx, wz)) {
      const alongX = wx < wz;
      const sgn = Math.sign(alongX ? im.vh.x : im.vh.z) || (r() < 0.5 ? -1 : 1);
      const d = new THREE.Vector3(alongX ? sgn : 0, 0, alongX ? 0 : sgn);
      const half = (alongX ? wx : wz) / 2;
      const mid = alongX ? (box.min.x + box.max.x) / 2 : (box.min.z + box.max.z) / 2;
      const edge = mid + sgn * half;
      this.pivot.set(alongX ? edge : 0, 0, alongX ? 0 : edge);
      this.topAxis.crossVectors(new THREE.Vector3(0, 1, 0), d).normalize();
      this.topple = (Math.PI / 2) * (0.9 + 0.08 * r());
      this.topT = 1.4 * Math.sqrt((2 * Hc) / G);
    }
    const cr = im.crater;
    const size = im.size;
    const centreY = H / 2;
    this.width = Math.max(0.05, Math.min(box.max.x - box.min.x, box.max.z - box.min.z));

    // The crush, as a morph target on each body mesh: one mesh per job.
    if (c > 0.005) {
      // Broad dents, and sharp creases (ridged: sheet metal kinks rather than ripples).
      const waves = Array.from({ length: 14 }, (_, i) => {
        const big = i < 6;
        const lam = size * (big ? 0.3 + 0.4 * r() : 0.12 + 0.1 * r());
        const k = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar((Math.PI * 2) / lam);
        const dir = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
        return { kx: k.x, ky: k.y, kz: k.z, ph: r() * Math.PI * 2, dx: dir.x, dy: dir.y, dz: dir.z, amp: size * (big ? 0.022 : 0.007) * c, ridged: !big };
      });
      const folds = 2 + Math.floor(r() * 2);
      const foldPh = r() * Math.PI * 2;
      const deform = (w: THREE.Vector3) => {
        const s = Math.min(1, Math.max(0, (w.y - ymin) / H));
        // Down: crushed most at the contact.
        let y = ymin + H * s * (0.6 + 0.4 * s) * (1 - c);
        // Out: squashed material bulges sideways, most near the ground; the sides kink in folds.
        let dx = w.x;
        let dz = w.z;
        const rh = Math.hypot(dx, dz);
        const spread = 1 + c * (0.08 + 0.16 * (1 - s));
        const fold = c * size * 0.03 * Math.sin(Math.PI * folds * s + foldPh + 2.1 * Math.sin((dx + dz) / size));
        dx = dx * spread + (rh > 1e-6 ? (dx / rh) * fold : 0);
        dz = dz * spread + (rh > 1e-6 ? (dz / rh) * fold : 0);
        // Dents and creases.
        let ex = 0;
        let ey = 0;
        let ez = 0;
        for (const wv of waves) {
          const sn = Math.sin(wv.kx * w.x + wv.ky * w.y + wv.kz * w.z + wv.ph);
          const a = wv.amp * (wv.ridged ? 1 - 2 * Math.abs(sn) : sn);
          ex += wv.dx * a;
          ey += wv.dy * a;
          ez += wv.dz * a;
        }
        dx += ex;
        dz += ez;
        y += ey * (0.3 + 0.7 * s);
        // Pressed into the dent it digs: the underside follows the bowl, the top less so.
        const b = bowl(cr, Math.hypot(dx, dz));
        y += b * (1 - 0.5 * s);
        w.set(dx, Math.max(y, ymin + b - 0.02 * H), dz);
      };
      if (this.smokeMark) {
        const w = new THREE.Vector3().applyMatrix4(relativeTo(this.smokeMark, this.group, M));
        deform(w);
        this.smokeAt = w.applyQuaternion(this.R.clone().invert());
      }
      // In slices of a few thousand vertices.
      const CHUNK = 6000;
      for (const m of this.body) {
        // Mesh space → level site axes about the root, and back.
        const A = relativeTo(m, this.group, new THREE.Matrix4());
        const inv = A.clone().invert();
        const pos = m.geometry.attributes.position as THREE.BufferAttribute;
        const target = m.geometry.morphAttributes.position![0] as THREE.BufferAttribute;
        for (let i0 = 0; i0 < pos.count; i0 += CHUNK)
          this.jobs.push(() => {
            const i1 = Math.min(pos.count, i0 + CHUNK);
            for (let i = i0; i < i1; i++) {
              tmp.a.fromBufferAttribute(pos, i).applyMatrix4(A);
              deform(tmp.a);
              tmp.a.applyMatrix4(inv);
              target.setXYZ(i, tmp.a.x, tmp.a.y, tmp.a.z);
            }
            // Done: let the renderer pick up the new shape (it caches it per geometry).
            if (i1 === pos.count) m.geometry.dispose();
          });
      }
    }

    // Toppled, how high its lowest point ends up (it's crumpled, so not on the pivot edge).
    if (this.topple > 0)
      this.jobs.push(() => {
        const q = new THREE.Quaternion().setFromAxisAngle(this.topAxis, this.topple);
        let low = Infinity;
        for (const m of this.body) {
          const A = relativeTo(m, this.group, M);
          const pos = (m.geometry.morphAttributes.position?.[0] ?? m.geometry.attributes.position) as THREE.BufferAttribute;
          const stride = Math.max(1, Math.floor(pos.count / 4000));
          for (let i = 0; i < pos.count; i += stride) {
            tmp.a.fromBufferAttribute(pos, i).applyMatrix4(A);
            tmp.a.y -= ymin;
            low = Math.min(low, tmp.a.sub(this.pivot).applyQuaternion(q).add(this.pivot).y);
          }
        }
        this.restDrop = Number.isFinite(low) ? low : 0;
      });

    // Torn-off parts: where they sit now, then flung out on their own paths (one per job).
    const inner = new THREE.Matrix4();
    for (const p of this.pieces)
      this.jobs.push(() => {
        const box = new THREE.Box3();
        relativeTo(p.obj, this.group, M);
        const pos0 = new THREE.Vector3();
        const q0 = new THREE.Quaternion();
        const s0 = new THREE.Vector3();
        M.decompose(pos0, q0, s0);
        pos0.y -= ymin;
        // Its box, in its own space.
        box.makeEmpty();
        for (const m of meshesUnder(p.obj)) {
          m.geometry.computeBoundingBox();
          box.union(m.geometry.boundingBox!.clone().applyMatrix4(relativeTo(m, p.obj, inner)));
        }
        p.obj.parent?.remove(p.obj);
        this.group.add(p.obj);
        p.obj.position.copy(pos0);
        p.obj.quaternion.copy(q0);
        p.obj.scale.copy(s0);
        p.path = this.flingPiece(p, pos0, q0, box, s0, centreY, im, r);
      });
    this.jobs.push(() => {
      const seen = new Set<THREE.Material>();
      for (const m of [...this.body, ...this.pieces.flatMap((p) => meshesUnder(p.obj))])
        for (const mat of materialsOf(m))
          if (!seen.has(mat) && mat.color) {
            seen.add(mat);
            this.coats.push({ m: mat, base: mat.color.clone(), rough: mat.roughness });
          }
    });

    // Glass bursts from the windows; fragments of panel, black plastic and trim, bare metal.
    this.jobs.push(() => {
      const shardPts = this.glass.length ? surfacePoints(this.glass, this.group, this.shards.count, r) : [];
      const bitPts = spec ? surfacePoints(this.body, this.group, this.bits.count, r) : [];
      this.shardF = shardPts.map(({ p }) => this.flyer(p, 'shard', centreY, im, r));
      this.bitF = bitPts.map(({ p }) => this.flyer(p, 'bit', centreY, im, r));
      const col = new THREE.Color();
      bitPts.forEach(({ mesh }, i) => {
        const u = r();
        if (u < 0.32) colourOf(materialsOf(mesh)[0], col).multiplyScalar(0.55 + 0.35 * r());
        else if (u < 0.72) col.setRGB(0.025, 0.025, 0.028).multiplyScalar(0.7 + 0.6 * r());
        else col.setRGB(0.32, 0.33, 0.35).multiplyScalar(0.7 + 0.5 * r());
        this.bits.setColorAt(i, col);
      });
      if (this.bits.instanceColor) this.bits.instanceColor.needsUpdate = true;
      this.shards.count = Math.max(1, this.shardF.length);
      this.bits.count = Math.max(1, this.bitF.length);
      this.place(this.shards, this.shardF, -1);
      this.place(this.bits, this.bitF, -1);
      if (this.shatter) {
        const pts = surfacePoints(this.body, this.group, this.chunks.count, r);
        this.chunkF = pts.map(({ p }) => this.flyer(p, 'chunk', centreY, im, r));
        pts.forEach(({ mesh }, i) => this.chunks.setColorAt(i, colourOf(materialsOf(mesh)[0], col).multiplyScalar(0.6 + 0.5 * r())));
        if (this.chunks.instanceColor) this.chunks.instanceColor.needsUpdate = true;
        this.mound.position.set(0, bowl(im.crater, 0) * 0.6, 0);
        this.moundSize = Math.max(im.size * 0.3, im.crater.R * 0.75);
      }
      this.chunks.count = Math.max(1, this.chunkF.length);
      this.place(this.chunks, this.chunkF, -1);
    });
  }

  /** The parts that tear off (in the wreck's frame once it has landed). */
  get parts(): readonly THREE.Object3D[] {
    return this.pieces.map((p) => p.obj);
  }

  /** Where smoke rises from (the wreck's frame), once it has landed; false if nothing burns. */
  smokeSource(out: THREE.Vector3): boolean {
    if (!this.smokeAt || !this.prepared) return false;
    out.copy(this.smokeAt).applyQuaternion(this.root.quaternion).add(this.root.position);
    out.y = Math.max(out.y, 0.1);
    return true;
  }

  /** The scrape it leaves: from where it hit to where it is now (wreck frame), and how wide. */
  scar(out: THREE.Vector4): number {
    out.set(0, 0, this.root.position.x, this.root.position.z);
    return Math.hypot(out.z, out.w) > 0.2 * this.width ? this.width * 0.7 : 0;
  }

  /** Gouges where the heaviest parts first hit, up to `out.length`: x, z, radius and how far formed. */
  gouges(psi: number, out: THREE.Vector4[]) {
    const hits = this.pieces
      .map((p) => p.hit)
      .filter((h): h is NonNullable<Piece['hit']> => h !== null)
      .sort((a, b) => b.size - a.size);
    out.forEach((g, i) => {
      const h = hits[i];
      g.set(h?.x ?? 0, h?.z ?? 0, (h?.size ?? 1) * 0.3, h ? smooth(h.t, h.t + 0.08, psi) : 0);
    });
  }

  /** Does queued work for up to `ms` milliseconds. */
  work(ms: number) {
    const t0 = performance.now();
    while (this.jobs.length && performance.now() - t0 < ms) this.jobs.shift()!();
  }

  /** Before it lands: drawn too small to see, so its shaders are compiled by the time it does. */
  warm() {
    this.group.visible = true;
    this.group.scale.setScalar(1e-6);
  }

  /** Crush progress at physical time psi after contact: it decelerates through the crush. */
  private progress(psi: number): number {
    if (psi >= this.tc) return 1;
    const u = Math.max(0, psi / this.tc);
    return 1 - (1 - u) * (1 - u);
  }

  /** A shard of glass or a fragment of the body, from a point on its surface (wreck frame). */
  private flyer(p: THREE.Vector3, kind: 'shard' | 'bit' | 'chunk', centreY: number, im: WreckImpact, r: () => number): Flyer {
    const start = new THREE.Vector3(p.x, p.y - this.ymin, p.z);
    const s = Math.min(1, Math.max(0, start.y / this.H));
    const t0 = this.tc * (kind === 'shard' ? 0.08 + 0.4 * s : 0.15 + 0.85 * s) * (0.7 + 0.6 * r());
    start.y *= 1 - this.c * this.progress(t0);
    const out = new THREE.Vector3(start.x, 0, start.z);
    if (out.lengthSq() < 1e-8) out.set(r() - 0.5, 0, r() - 0.5);
    out.normalize().applyAxisAngle(tmp.b.set(0, 1, 0), (r() - 0.5) * 1.2);
    const v = im.v;
    const speed = kind === 'shard' ? Math.min(28, v * (0.04 + 0.28 * r() ** 2)) : kind === 'chunk' ? Math.min(16, v * (0.02 + 0.13 * r() ** 2)) : Math.min(24, v * (0.03 + 0.2 * r() ** 2));
    const up = 0.25 + 0.6 * r() + 0.3 * (start.y > centreY ? 1 : 0);
    const vel = new THREE.Vector3(out.x * speed, up * speed * 0.7, out.z * speed).addScaledVector(this.carry, 0.35);
    const sz = im.size * (kind === 'shard' ? 0.005 + 0.012 * r() : kind === 'chunk' ? 0.025 + 0.05 * r() ** 1.5 : 0.01 + 0.032 * r() ** 1.5);
    const scale = new THREE.Vector3(sz, sz, sz * (0.6 + 0.8 * r()));
    // Flight to the ground (the finished crater's shape).
    const at = (t: number) => tmp.a.set(start.x + vel.x * t, 0, start.z + vel.z * t);
    let T = (vel.y + Math.sqrt(vel.y * vel.y + 2 * G * Math.max(0, start.y))) / G;
    for (let k = 0; k < 2; k++) {
      const gy = bowl(im.crater, at(T).length());
      T = (vel.y + Math.sqrt(Math.max(0, vel.y * vel.y + 2 * G * (start.y - gy)))) / G;
    }
    const land = at(T).clone();
    land.y = bowl(im.crater, land.length()) + scale.y * 0.12;
    const flipped = r() < 0.5 ? Math.PI : 0;
    return {
      t0,
      start,
      vel,
      T,
      land,
      skid: new THREE.Vector3(vel.x, 0, vel.z).multiplyScalar(kind === 'shard' ? 0.05 : 0.08),
      axis: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(),
      spin: 10 + 30 * r(),
      q0: new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 6, r() * 6, r() * 6)),
      rest: new THREE.Quaternion().setFromEuler(new THREE.Euler(flipped + (r() - 0.5) * 0.3, r() * Math.PI * 2, (r() - 0.5) * 0.3)),
      scale,
    };
  }

  /** A torn-off part's path: crushed down with the body, thrown, bouncing, and settling flat. */
  private flingPiece(piece: Piece, pos0: THREE.Vector3, q0: THREE.Quaternion, box: THREE.Box3, s0: THREE.Vector3, centreY: number, im: WreckImpact, r: () => number): Float32Array {
    const kind = piece.kind;
    const path = new Float32Array(SAMPLES * 7);
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).multiply(s0));
    const extent = new THREE.Vector3().subVectors(box.max, box.min).multiply(s0);
    const pieceSize = Math.max(0.05, extent.length());
    const low = (q: THREE.Quaternion) => {
      let m = Infinity;
      for (const c of corners) m = Math.min(m, tmp.a.copy(c).applyQuaternion(q).y);
      return m;
    };
    // It comes to rest on its broadest face: the shortest axis of its box ends up vertical.
    const ax = Math.abs(extent.x);
    const ay = Math.abs(extent.y);
    const az = Math.abs(extent.z);
    const thin = ax <= ay && ax <= az ? new THREE.Vector3(1, 0, 0) : ay <= az ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const restOf = (q: THREE.Quaternion) => {
      const a = thin.clone().applyQuaternion(q);
      return new THREE.Quaternion().setFromUnitVectors(a, new THREE.Vector3(0, Math.sign(a.y) || 1, 0)).multiply(q);
    };
    const s = Math.min(1, Math.max(0, pos0.y / this.H));
    const tDet = this.tc * (0.1 + 0.75 * s) * (0.8 + 0.4 * r());
    const out = new THREE.Vector3(pos0.x, 0, pos0.z);
    if (out.lengthSq() < 1e-8) out.set(r() - 0.5, 0, r() - 0.5);
    out.normalize().applyAxisAngle(tmp.b.set(0, 1, 0), (r() - 0.5) * 0.9);
    const v = im.v;
    const [h, u] =
      kind === 'wheel' ? [0.1 + 0.12 * r(), 0.05 + 0.12 * r()] : kind === 'trim' ? [0.08 + 0.2 * r(), 0.06 + 0.16 * r()] : [0.03 + 0.06 * r(), 0.02 + 0.06 * r() + (pos0.y > centreY ? 0.03 : 0)];
    // Heavy parts (a turret, a wing) are only shoved; light ones fly.
    const [hMax, uMax] = kind === 'heavy' ? [9, 6] : [30, 18];
    const vel = new THREE.Vector3(out.x, 0, out.z)
      .multiplyScalar(Math.min(hMax, v * h))
      .add(new THREE.Vector3(0, Math.min(uMax, v * u), 0))
      .addScaledVector(this.carry, 0.5);
    const w = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar((kind === 'heavy' ? 1.5 + 3 * r() : 8 + 18 * r()) / Math.sqrt(pieceSize));
    const p = pos0.clone();
    const q = q0.clone();
    let phase = 0;
    let bounces = 0;
    let ts = 0;
    const ps = new THREE.Vector3();
    const qs = new THREE.Quaternion();
    let qRest = q.clone();
    let lift = 0;
    const sub = 4;
    const dt = STEP / sub;
    const dq = new THREE.Quaternion();
    // Rolling (wheels): along `roll`, turning about `rollAxis`.
    const axle = new THREE.Vector3();
    const roll = new THREE.Vector3();
    const rollAxis = new THREE.Vector3();
    const radius = Math.max(0.05, Math.max(Math.abs(extent.x), Math.abs(extent.y)) / 2);
    let rollSpeed = 0;
    let rollAngle = 0;
    let rollT = 0;
    let t = 0;
    for (let i = 0; i < SAMPLES; i++) {
      for (let k = 0; k < (i === 0 ? 0 : sub); k++) {
        t += dt;
        if (phase === 0) {
          p.y = pos0.y * (1 - this.c * this.progress(t));
          if (t >= tDet) phase = 1;
        } else if (phase === 1) {
          vel.y -= G * dt;
          p.addScaledVector(vel, dt);
          const wl = w.length();
          if (wl > 0) q.premultiply(dq.setFromAxisAngle(tmp.b.copy(w).divideScalar(wl), wl * dt));
          const gy = bowl(im.crater, Math.hypot(p.x, p.z));
          const lo = low(q) + p.y;
          if (lo < gy) {
            p.y += gy - lo;
            if (vel.y < 0) {
              if (!piece.hit) piece.hit = { x: p.x, z: p.z, t, size: pieceSize };
              bounces++;
              // A wheel that comes down on its tread rolls away.
              axle.set(0, 0, 1).applyQuaternion(q);
              const vh = Math.hypot(vel.x, vel.z);
              if (kind === 'wheel' && Math.abs(axle.y) < 0.5 && vh > 2.5) {
                const ah = axle.setY(0).normalize();
                roll.set(vel.x, 0, vel.z).addScaledVector(ah, -(vel.x * ah.x + vel.z * ah.z));
                if (roll.lengthSq() > 0.25) {
                  roll.normalize();
                  // Stood upright on its tread, turning about the axle as it goes.
                  qs.setFromUnitVectors(tmp.b.set(0, 0, 1).applyQuaternion(q), ah).multiply(q);
                  q.copy(qs);
                  rollAxis.crossVectors(tmp.b.set(0, 1, 0), roll).normalize();
                  rollSpeed = Math.hypot(vel.x, vel.z) * 0.85;
                  rollT = t;
                  phase = 3;
                  continue;
                }
              }
              vel.y = -vel.y * 0.3;
              vel.x *= 0.6;
              vel.z *= 0.6;
              w.multiplyScalar(0.5);
              if (bounces >= 3 || vel.y < 1.2) {
                phase = 2;
                ts = t;
                ps.copy(p);
                qs.copy(q);
                qRest = restOf(q);
                lift = -low(qRest);
              }
            }
          }
        } else if (phase === 3) {
          // Rolling: slowed by the ground, wobbling more as it slows, until it falls flat.
          rollSpeed = Math.max(0, rollSpeed - (1.4 + 0.5 * rollSpeed * 0.1) * dt);
          p.addScaledVector(roll, rollSpeed * dt);
          rollAngle += (rollSpeed / radius) * dt;
          const wob = 0.12 * (1 - Math.min(1, rollSpeed / 6)) * Math.sin((t - rollT) * 7);
          q.copy(qs).premultiply(dq.setFromAxisAngle(rollAxis, rollAngle)).premultiply(tmp.q2.setFromAxisAngle(roll, wob));
          // On its tread: the centre a radius up (its box's corners would make it bob).
          p.y = bowl(im.crater, Math.hypot(p.x, p.z)) + radius;
          if (rollSpeed < 1.2 || t - rollT > 5) {
            // Falls over onto its side.
            phase = 2;
            ts = t;
            ps.copy(p);
            qs.copy(q);
            qRest = restOf(q);
            lift = -low(qRest);
            vel.set(roll.x * rollSpeed, 0, roll.z * rollSpeed);
          }
        } else {
          const a = smooth(0, kind === 'wheel' ? 0.5 : 0.35, t - ts);
          q.slerpQuaternions(qs, qRest, a);
          const f = Math.exp(-dt / 0.2);
          vel.x *= f;
          vel.z *= f;
          p.x += vel.x * dt;
          p.z += vel.z * dt;
          p.y = ps.y + (bowl(im.crater, Math.hypot(p.x, p.z)) + lift - ps.y) * a;
        }
      }
      path.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w], i * 7);
    }
    return path;
  }

  /** Poses everything at physical time psi after contact; `grow` is how far the crater has formed. */
  update(psi: number, grow: number, dust: THREE.Color) {
    this.work(Infinity);
    this.group.visible = true;
    this.group.scale.setScalar(1);
    const prog = this.progress(psi);
    for (const m of this.body) if (m.morphTargetInfluences) m.morphTargetInfluences[0] = prog;
    for (const m of this.glass) m.visible = psi < this.tc * 0.1;
    // Something brittle bursts as it hits: chunks fly, the rubble settles into a mound.
    if (this.shatter) {
      for (const m of this.body) m.visible = psi < this.tc * 0.35;
      this.mound.scale.set(1, 1, 1).multiplyScalar(this.moundSize * Math.max(1e-6, smooth(this.tc * 0.3, this.tc * 0.3 + 0.35, psi)));
    }
    // Rebound and rock (two hops), sliding on a little.
    const tau = psi - this.tc;
    let y = 0;
    let rock = 0;
    if (tau > 0 && this.vb > 0) {
      const T1 = (2 * this.vb) / G;
      const v2 = this.vb * 0.3;
      const T2 = (2 * v2) / G;
      if (tau < T1) {
        y = this.vb * tau - 0.5 * G * tau * tau;
        rock = this.rock0 * Math.sin((Math.PI * tau) / T1);
      } else if (tau < T1 + T2) {
        const u = tau - T1;
        y = v2 * u - 0.5 * G * u * u;
        rock = -this.rock0 * 0.35 * Math.sin((Math.PI * u) / T2);
      }
    }
    const sl = 1 - Math.exp(-Math.max(0, psi) / 0.35);
    this.root.position.set(this.slide.x * sl, -this.ymin - this.sink * grow, this.slide.z * sl);
    if (this.topple > 0) {
      // Falls over, gathering speed, then a small jolt as it lands on its side.
      const u = Math.min(1, Math.max(0, tau) / this.topT);
      const land = tau > this.topT ? 0.05 * Math.sin(Math.min(Math.PI, ((tau - this.topT) / 0.3) * Math.PI)) : 0;
      tmp.q.setFromAxisAngle(this.topAxis, this.topple * (u * u - land));
      // The edge slides along with it.
      tmp.b.set(this.root.position.x, 0, this.root.position.z).add(this.pivot);
      tmp.a.copy(this.root.position).sub(tmp.b).applyQuaternion(tmp.q).add(tmp.b);
      this.root.position.copy(tmp.a);
      this.root.position.y -= this.restDrop * u * u;
      this.root.quaternion.copy(tmp.q).multiply(this.R);
    } else {
      this.root.position.y += y;
      this.root.quaternion.copy(tmp.q.setFromAxisAngle(this.rockAxis, rock)).multiply(this.R);
    }
    // Torn-off parts along their paths.
    const x = Math.min(SAMPLES - 1, Math.max(0, psi / STEP));
    const i0 = Math.floor(x);
    const i1 = Math.min(SAMPLES - 1, i0 + 1);
    const f = x - i0;
    for (const p of this.pieces) {
      const a = p.path;
      if (!a.length) continue;
      const j = i0 * 7;
      const k = i1 * 7;
      p.obj.position.set(a[j] + (a[k] - a[j]) * f, a[j + 1] + (a[k + 1] - a[j + 1]) * f, a[j + 2] + (a[k + 2] - a[j + 2]) * f);
      tmp.q.set(a[j + 3], a[j + 4], a[j + 5], a[j + 6]);
      tmp.q2.set(a[k + 3], a[k + 4], a[k + 5], a[k + 6]);
      p.obj.quaternion.slerpQuaternions(tmp.q, tmp.q2, f);
    }
    this.place(this.shards, this.shardF, psi);
    this.place(this.bits, this.bitF, psi);
    if (this.shatter) this.place(this.chunks, this.chunkF, psi);
    // Scuffed and dusted: duller, and the colour of the ground.
    const coat = 0.28 * smooth(0.02, 1.5, psi);
    for (const c of this.coats) {
      c.m.color.copy(c.base).lerp(dust, coat);
      c.m.roughness = c.rough + (0.85 - c.rough) * Math.min(1, coat * 1.6);
    }
  }

  private place(im: THREE.InstancedMesh, fs: Flyer[], psi: number) {
    if (!fs.length) {
      im.setMatrixAt(0, tmp.m.makeScale(0, 0, 0));
      im.instanceMatrix.needsUpdate = true;
      return;
    }
    for (let i = 0; i < fs.length; i++) {
      const fl = fs[i];
      const tau = psi - fl.t0;
      const pos = tmp.a;
      if (tau < 0) {
        // Not thrown yet: drawn too small to see.
        im.setMatrixAt(i, tmp.m.makeScale(1e-6, 1e-6, 1e-6));
        continue;
      }
      if (tau < fl.T) {
        pos.copy(fl.start).addScaledVector(fl.vel, tau);
        pos.y -= 0.5 * G * tau * tau;
        tmp.q.setFromAxisAngle(fl.axis, fl.spin * tau).multiply(fl.q0);
      } else {
        pos.copy(fl.land).addScaledVector(fl.skid, 1 - Math.exp(-(tau - fl.T) / 0.12));
        tmp.q.copy(fl.rest);
      }
      tmp.m.compose(pos, tmp.q, fl.scale);
      im.setMatrixAt(i, tmp.m);
    }
    im.instanceMatrix.needsUpdate = true;
  }
}
