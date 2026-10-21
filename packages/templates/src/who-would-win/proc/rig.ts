/**
 * Procedural creature rig: one skinned mesh for the body and tail (bending along a chain of spine and
 * tail bones), a rigid head with a hinged jaw, and legs of rigid segments placed by two-bone IK onto
 * foot targets. A gait engine plants the feet on the ground (stance moves them back at exactly the
 * body's speed, so nothing slides) and swings them forward in an arc.
 *
 * Posing is a pure function of the inputs: the view calls it every frame from sim state.
 */
import { THREE } from '../../three-layer';
import { MeshBuilder, loft, type Skin, type V3 } from './builder';

/** Limb names: LF/RF/LH/RH for four legs, LL/RL legs and LA/RA arms for bipeds, L1-L4/R1-R4 for a spider. */
export type LegName = string;
const SPINE = ['pelvis', 'spine', 'chest', 'neck1', 'neck2'] as const;
export type SpineBone = (typeof SPINE)[number];

export interface LegSpec {
  name: LegName;
  /** The bone the leg hangs from. */
  bone: 'chest' | 'pelvis';
  /** Hip / shoulder joint, model space at rest. */
  hip: V3;
  /** Foot contact point at rest (y = 0). */
  home: V3;
  /** Upper and lower segment lengths (the IK pair). */
  lens: [number, number];
  /**
   * The last joint (wrist / hock / ankle) sits this far above and behind the foot's contact point;
   * `segment` draws a third piece between them (a pastern or the long hock of a cat).
   */
  end: { up: number; back: number; segment: boolean };
  /** Radii at the hip, the knee, the last joint. */
  radii: [number, number, number];
  /** Which way the knee / elbow points (model space). */
  pole: V3;
  /** The paw, built round its contact point (origin), +Z forward. */
  paw: (b: MeshBuilder) => void;
  color: THREE.Color;
  /**
   * An arm: never walks; the hand rests at `home` (model space, in the air) and swings fore and aft
   * this far as the body walks, unless the pose places it.
   */
  arm?: { swing: number };
  /** Segment colours, if not all `color` (upper, lower): sleeves, socks, stockings. */
  colors?: [THREE.Color, THREE.Color];
}

/** Something held at the end of a limb (a sword), built along +Y from the grip. The pose aims it. */
export interface PropSpec {
  name: string;
  limb: LegName;
  build: (b: MeshBuilder) => void;
}

/** A wing on a spine bone: the inner part from `root`, the outer part hinged at `elbow` (both built
 * along +X, outwards, for the left wing; the right one is mirrored). */
export interface WingSpec {
  bone: SpineBone;
  root: V3;
  elbow: V3;
  inner: (b: MeshBuilder) => void;
  outer: (b: MeshBuilder) => void;
}

export interface Gait {
  /** Used from this speed (m/s) up. */
  from: number;
  /** Fraction of a cycle each foot is on the ground. */
  duty: number;
  /** Phase offset of each foot (and arm). */
  offsets: Record<LegName, number>;
  lift: number;
  /** Body bob (m) and gallop flex (rad). */
  bob: number;
  flex: number;
}

export interface ProcSpec {
  bones: Record<SpineBone, V3> & { tail: V3[] };
  /** The skinned body and tail, model space. */
  body: (b: MeshBuilder, skin: (p: V3) => Skin) => void;
  /** Head, in neck2's space (origin at the bone). */
  head: (b: MeshBuilder) => void;
  /** Scale of the head (and jaw) relative to how it is modelled. */
  headScale?: number;
  /** The head's resting tilt on its neck (positive: nose down). */
  headTilt?: number;
  props?: PropSpec[];
  wings?: WingSpec;
  /** Jaw hinge (in head space) and the jaw, in hinge space. */
  jawPivot: V3;
  jaw: (b: MeshBuilder) => void;
  /** Rigid extras (a mane) in a spine bone's space. */
  extras?: { bone: SpineBone; build: (b: MeshBuilder) => void }[];
  legs: LegSpec[];
  gaits: Gait[];
  /** Height of the long axis the body rolls round (death rolls, falling on its side). */
  rollY: number;
}

/** Everything a frame needs to pose the rig (all angles in radians). */
export interface PoseIn {
  speed: number;
  /** Metres per gait cycle at this speed (the sim's cadence uses the same, see strideFor). */
  stride: number;
  gait: number;
  /** Seconds, for idle motion (breathing, tail sway). */
  time: number;
  /** Body lift, pitch round the hips (negative: front up), roll round the long axis. */
  y: number;
  pitch: number;
  roll: number;
  spineYaw: number;
  chestPitch: number;
  neckYaw: number;
  neckPitch: number;
  headYaw: number;
  headPitch: number;
  /** 0 closed .. 1 wide open. */
  jaw: number;
  tailYaw: number;
  tailPitch: number;
  /** Side-to-side tail wave amplitude. */
  tailWave: number;
  /** Feet (and hands) placed by the action instead of the gait (model space), or hanging limp. */
  legs: Partial<Record<LegName, V3 | 'relax'>>;
  /** Which way each held prop points (model space). */
  props: Record<string, V3>;
  /** Wings: up/down beat (rad, + up) and how folded (0 open .. 1 folded). */
  wingFlap: number;
  wingFold: number;
  /** How much of the gait's stride and lift to use (0 freezes the feet at home). */
  gaitScale: number;
}

export const restPose = (): PoseIn => ({
  speed: 0,
  stride: 1,
  gait: 0,
  time: 0,
  y: 0,
  pitch: 0,
  roll: 0,
  spineYaw: 0,
  chestPitch: 0,
  neckYaw: 0,
  neckPitch: 0,
  headYaw: 0,
  headPitch: 0,
  jaw: 0,
  tailYaw: 0,
  tailPitch: 0,
  tailWave: 0.08,
  legs: {},
  props: {},
  wingFlap: 0,
  wingFold: 0,
  gaitScale: 1,
});

interface Built {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  jaw: THREE.BufferGeometry;
  extras: { bone: SpineBone; geo: THREE.BufferGeometry }[];
  props: { spec: PropSpec; geo: THREE.BufferGeometry }[];
  wings: { inner: THREE.BufferGeometry; outer: THREE.BufferGeometry } | null;
  legs: { upper: THREE.BufferGeometry; lower: THREE.BufferGeometry; end: THREE.BufferGeometry | null; paw: THREE.BufferGeometry }[];
  triangles: number;
}

/** Bone order for skinning: spine bones, then the tail from its root to its tip. */
const boneIndex = (spec: ProcSpec) => [...SPINE.map((n) => spec.bones[n]), ...spec.bones.tail];

/**
 * Skin weights from the bone chain tail tip → pelvis → … → neck2: each point is weighted between the
 * two ends of the nearest segment of that chain, so the chain can run any way (a horizontal spine, an
 * upright torso, a steep neck).
 */
function skinner(spec: ProcSpec) {
  const pts = boneIndex(spec);
  const order = [...spec.bones.tail.map((_, i) => SPINE.length + spec.bones.tail.length - 1 - i), 0, 1, 2, 3, 4];
  return (p: V3): Skin => {
    let best: Skin = [order[0], order[0], 1, 0];
    let bestD = Infinity;
    for (let k = 0; k < order.length - 1; k++) {
      const a = pts[order[k]];
      const b = pts[order[k + 1]];
      const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ap: V3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
      const L = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-9;
      const raw = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L;
      const t = Math.max(0, Math.min(1, raw));
      const d = Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
      if (d < bestD - 1e-9) {
        bestD = d;
        const s = t * t * (3 - 2 * t);
        best = [order[k], order[k + 1], 1 - s, s];
      }
    }
    return best;
  };
}

function limb(len: number, r0: number, r1: number, color: THREE.Color, seed: number) {
  if (len <= 0) len = 0.01;
  const b = new MeshBuilder();
  loft(
    b,
    [
      { c: [0, r0 * 0.3, 0], w: r0 * 0.8, h: r0 * 0.8 },
      { c: [0, -len * 0.05, 0], w: r0, h: r0 * 1.05 },
      { c: [0, -len * 0.5, 0], w: (r0 + r1) / 2, h: ((r0 + r1) / 2) * 1.1 },
      { c: [0, -len, 0], w: r1, h: r1 * 1.05 },
      { c: [0, -len - r1 * 0.4, 0], w: r1 * 0.7, h: r1 * 0.7 },
    ],
    { sides: 7, ref: [0, 0, 1], jitter: 0.06, seed, color: (_t, _a, p) => color.clone().multiplyScalar(0.92 + 0.16 * Math.abs(Math.sin(p[1] * 31 + seed))), capStart: 0.3, capEnd: 0.3, twist: 0.3 },
  );
  return b;
}

const cache = new WeakMap<ProcSpec, Built>();

function build(spec: ProcSpec): Built {
  let built = cache.get(spec);
  if (built) return built;
  const body = new MeshBuilder();
  spec.body(body, skinner(spec));
  const head = new MeshBuilder();
  spec.head(head);
  const jaw = new MeshBuilder();
  spec.jaw(jaw);
  const extras = (spec.extras ?? []).map((e) => {
    const b = new MeshBuilder();
    e.build(b);
    return { bone: e.bone, b };
  });
  const legs = spec.legs.map((l, k) => {
    const endLen = Math.hypot(l.end.up, l.end.back);
    const paw = new MeshBuilder();
    l.paw(paw);
    return {
      upper: limb(l.lens[0], l.radii[0], l.radii[1], l.colors?.[0] ?? l.color, 11 + k),
      lower: limb(l.lens[1], l.radii[1], l.radii[2], l.colors?.[1] ?? l.color, 23 + k),
      end: l.end.segment ? limb(endLen, l.radii[2], l.radii[2] * 0.8, l.color, 37 + k) : null,
      paw,
    };
  });
  const props = (spec.props ?? []).map((pr) => {
    const b = new MeshBuilder();
    pr.build(b);
    return { spec: pr, b };
  });
  let wings: { inner: MeshBuilder; outer: MeshBuilder } | null = null;
  if (spec.wings) {
    wings = { inner: new MeshBuilder(), outer: new MeshBuilder() };
    spec.wings.inner(wings.inner);
    spec.wings.outer(wings.outer);
  }
  const tris = props.reduce((a, pr) => a + pr.b.triangles, 0) + (wings ? 2 * (wings.inner.triangles + wings.outer.triangles) : 0) + body.triangles + head.triangles + jaw.triangles + extras.reduce((a, e) => a + e.b.triangles, 0) + legs.reduce((a, l) => a + l.upper.triangles + l.lower.triangles + (l.end?.triangles ?? 0) + l.paw.triangles, 0);
  built = {
    body: body.build(true),
    head: head.build(),
    jaw: jaw.build(),
    extras: extras.map((e) => ({ bone: e.bone, geo: e.b.build() })),
    props: props.map((pr) => ({ spec: pr.spec, geo: pr.b.build() })),
    wings: wings ? { inner: wings.inner.build(), outer: wings.outer.build() } : null,
    legs: legs.map((l) => ({ upper: l.upper.build(), lower: l.lower.build(), end: l.end?.build() ?? null, paw: l.paw.build() })),
    triangles: tris,
  };
  cache.set(spec, built);
  return built;
}

export const triangleCount = (spec: ProcSpec) => build(spec).triangles;

interface LegRig {
  spec: LegSpec;
  pivot: THREE.Object3D;
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  end: THREE.Mesh | null;
  paw: THREE.Mesh;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);

export class ProcRig {
  /** Placed in the world (position and heading) by the caller. */
  readonly root = new THREE.Group();
  /** Lift and roll of the body (round the long axis at rollY). */
  private readonly rollPivot = new THREE.Group();
  readonly bones: Record<string, THREE.Bone> = {};
  readonly tail: THREE.Bone[] = [];
  readonly head = new THREE.Group();
  readonly jaw = new THREE.Group();
  private readonly legs: LegRig[] = [];
  private readonly props: { spec: PropSpec; mesh: THREE.Mesh }[] = [];
  private readonly wings: { inner: THREE.Group; outer: THREE.Group; side: 1 | -1 }[] = [];
  readonly material: THREE.MeshStandardMaterial;
  /** The wings' material (both faces drawn: one wing is a mirror image). */
  readonly wingMaterial: THREE.MeshStandardMaterial | null = null;

  constructor(readonly spec: ProcSpec) {
    const built = build(spec);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.88, metalness: 0 });
    const mat = this.material;
    this.rollPivot.position.y = spec.rollY;
    const inner = new THREE.Group();
    inner.position.y = -spec.rollY;
    this.root.add(this.rollPivot);
    this.rollPivot.add(inner);

    // Bones: pelvis → spine → chest → neck1 → neck2, and pelvis → tail1 → … (all at rest unrotated).
    const pos = (p: V3) => new THREE.Vector3(...p);
    const list: THREE.Bone[] = [];
    let parent: THREE.Bone | null = null;
    let parentPos = new THREE.Vector3();
    for (const name of SPINE) {
      const bone = new THREE.Bone();
      bone.name = name;
      const p = pos(spec.bones[name]);
      bone.position.copy(parent ? p.clone().sub(parentPos) : p);
      if (parent) parent.add(bone);
      parent = bone;
      parentPos = p;
      this.bones[name] = bone;
      list.push(bone);
    }
    parent = this.bones.pelvis;
    parentPos = pos(spec.bones.pelvis);
    for (const [i, tp] of spec.bones.tail.entries()) {
      const bone = new THREE.Bone();
      bone.name = `tail${i}`;
      const p = pos(tp);
      bone.position.copy(p.clone().sub(parentPos));
      parent.add(bone);
      parent = bone;
      parentPos = p;
      this.tail.push(bone);
      list.push(bone);
    }
    const mesh = new THREE.SkinnedMesh(built.body, mat);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.add(this.bones.pelvis);
    inner.add(mesh);
    mesh.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(list));

    // Head and jaw ride neck2.
    const headMesh = new THREE.Mesh(built.head, mat);
    headMesh.castShadow = true;
    this.head.add(headMesh);
    this.jaw.position.set(...spec.jawPivot);
    const jawMesh = new THREE.Mesh(built.jaw, mat);
    jawMesh.castShadow = true;
    this.jaw.add(jawMesh);
    this.head.add(this.jaw);
    this.head.scale.setScalar(spec.headScale ?? 1);
    this.head.rotation.x = spec.headTilt ?? 0;
    this.bones.neck2.add(this.head);
    for (const e of built.extras) {
      const m = new THREE.Mesh(e.geo, mat);
      m.castShadow = true;
      this.bones[e.bone].add(m);
    }

    // Legs: a pivot on their bone (moves with the body); the segments live in root space.
    spec.legs.forEach((l, k) => {
      const pivot = new THREE.Object3D();
      const bonePos = pos(spec.bones[l.bone]);
      pivot.position.copy(pos(l.hip).sub(bonePos));
      this.bones[l.bone].add(pivot);
      const mk = (g: THREE.BufferGeometry) => {
        const m = new THREE.Mesh(g, mat);
        m.castShadow = true;
        this.root.add(m);
        return m;
      };
      const g = built.legs[k];
      this.legs.push({ spec: l, pivot, upper: mk(g.upper), lower: mk(g.lower), end: g.end ? mk(g.end) : null, paw: mk(g.paw) });
    });
    for (const pr of built.props) {
      const m = new THREE.Mesh(pr.geo, mat);
      m.castShadow = true;
      this.root.add(m);
      this.props.push({ spec: pr.spec, mesh: m });
    }
    if (spec.wings && built.wings) {
      const wm = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
      this.wingMaterial = wm;
      const bonePos = pos(spec.bones[spec.wings.bone]);
      for (const side of [1, -1] as const) {
        const inner = new THREE.Group();
        inner.position.set(spec.wings.root[0] * side - bonePos.x, spec.wings.root[1] - bonePos.y, spec.wings.root[2] - bonePos.z);
        inner.scale.x = side;
        const im = new THREE.Mesh(built.wings.inner, wm);
        im.castShadow = true;
        inner.add(im);
        const outer = new THREE.Group();
        outer.position.set(...spec.wings.elbow);
        const om = new THREE.Mesh(built.wings.outer, wm);
        om.castShadow = true;
        outer.add(om);
        inner.add(outer);
        this.bones[spec.wings.bone].add(inner);
        this.wings.push({ inner, outer, side });
      }
    }
  }

  /** Pose everything from the inputs (the root's position and heading are set by the caller first). */
  pose(p: PoseIn) {
    const b = this.bones;
    this.rollPivot.position.y = this.spec.rollY + p.y;
    this.rollPivot.rotation.set(0, 0, p.roll);
    const g = this.gaitAt(p.speed);
    const m = Math.min(1, p.speed / 0.5) * p.gaitScale;
    const cyc = p.gait * Math.PI * 2;
    const flex = g.flex * Math.sin(cyc) * m;
    const bob = g.bob * (0.5 - 0.5 * Math.cos(cyc * 2)) * m;
    const breathe = Math.sin(p.time * 1.7) * 0.012;
    this.rollPivot.position.y -= bob;
    b.pelvis.rotation.set(p.pitch + flex * 0.5, p.spineYaw * 0.15, 0);
    b.spine.rotation.set(-flex + breathe, p.spineYaw * 0.3, 0);
    b.chest.rotation.set(p.chestPitch + flex * 0.5 - breathe, p.spineYaw * 0.3, 0);
    b.neck1.rotation.set(p.neckPitch * 0.5, p.spineYaw * 0.15 + p.neckYaw * 0.5, 0);
    b.neck2.rotation.set(p.neckPitch * 0.5 + p.headPitch, p.neckYaw * 0.5 + p.headYaw, 0);
    this.jaw.rotation.x = p.jaw * 0.75;
    // (The right wing is a mirror image: its rotations about y and z flip with it.)
    for (const w of this.wings) {
      w.inner.rotation.set(0, w.side * -0.15 * p.wingFold, w.side * (p.wingFlap - 0.2 * p.wingFold));
      w.outer.rotation.set(0, w.side * -1.9 * p.wingFold, w.side * (p.wingFlap * 0.5 - 0.3 * p.wingFold));
    }
    const n = this.tail.length;
    this.tail.forEach((t, i) => {
      const k = (i + 1) / n;
      t.rotation.set(p.tailPitch / n, -p.spineYaw * 0.12 + p.tailYaw / n + p.tailWave * Math.sin(p.time * 2.2 - i * 0.7) * k, 0);
    });
    this.root.updateMatrixWorld(true);

    // Legs.
    const bodyQ = new THREE.Quaternion();
    this.rollPivot.getWorldQuaternion(bodyQ);
    const rootQ = new THREE.Quaternion();
    this.root.getWorldQuaternion(rootQ);
    // Body orientation relative to the root (for limp legs and rolled paws).
    const rel = rootQ.clone().invert().multiply(bodyQ);
    for (const leg of this.legs) {
      const s = leg.spec;
      const hip = this.root.worldToLocal(leg.pivot.getWorldPosition(new THREE.Vector3()));
      const over = p.legs[s.name];
      let foot: THREE.Vector3;
      let lifted = 0;
      let relax = false;
      if (over === 'relax') {
        relax = true;
        const reach = (s.lens[0] + s.lens[1] + Math.hypot(s.end.up, s.end.back)) * 0.8;
        const down = new THREE.Vector3(Math.sign(s.home[0]) * 0.25, -1, 0.15).normalize().applyQuaternion(rel);
        foot = hip.clone().addScaledVector(down, reach);
      } else if (over) foot = new THREE.Vector3(...over);
      else if (s.arm) {
        // Arms swing opposite the legs while walking (their offsets say how).
        const ph = (((p.gait + (g.offsets[s.name] ?? 0)) % 1) + 1) % 1;
        foot = new THREE.Vector3(s.home[0], s.home[1], s.home[2] + Math.sin(ph * Math.PI * 2) * s.arm.swing * m);
      } else {
        const ph = (((p.gait + (g.offsets[s.name] ?? 0)) % 1) + 1) % 1;
        const stride = p.stride * g.duty * m;
        let dz: number;
        if (ph < g.duty) dz = stride * (0.5 - ph / g.duty);
        else {
          const u = (ph - g.duty) / (1 - g.duty);
          const e = u * u * (3 - 2 * u);
          dz = stride * (-0.5 + e);
          lifted = Math.sin(Math.PI * u) * m;
        }
        foot = new THREE.Vector3(s.home[0], g.lift * lifted, s.home[2] + dz);
      }
      // The last joint sits above and behind the foot (in the body's frame when limp).
      const up = new THREE.Vector3(0, 1, 0);
      const fwd = new THREE.Vector3(0, 0, 1);
      if (relax) {
        up.applyQuaternion(rel);
        fwd.applyQuaternion(rel);
      }
      const ankle = foot.clone().addScaledVector(up, s.end.up).addScaledVector(fwd, -s.end.back);
      const pole = new THREE.Vector3(...s.pole).applyQuaternion(rel);
      const knee = solve(hip, ankle, s.lens[0], s.lens[1], pole);
      const reached = knee.end;
      place(leg.upper, hip, knee.knee);
      place(leg.lower, knee.knee, reached);
      const footAt = reached.clone().addScaledVector(up, -s.end.up).addScaledVector(fwd, s.end.back);
      if (leg.end) place(leg.end, reached, footAt);
      leg.paw.position.copy(footAt);
      if (relax || s.arm) leg.paw.quaternion.copy(rel);
      else leg.paw.quaternion.setFromEuler(new THREE.Euler(lifted * 0.5, 0, 0));
      for (const pr of this.props) {
        if (pr.spec.limb !== s.name) continue;
        pr.mesh.position.copy(footAt);
        const dir = new THREE.Vector3(...(p.props[pr.spec.name] ?? [0, 0.6, 0.8])).normalize();
        pr.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      }
    }
  }

  private gaitAt(speed: number): Gait {
    let g = this.spec.gaits[0];
    for (const x of this.spec.gaits) if (speed >= x.from) g = x;
    return g;
  }

  /** Total triangles (for the performance budget). */
  get triangles() {
    return build(this.spec).triangles;
  }
}

/** Two-bone IK: the knee for a hip and a target, bending towards the pole. */
function solve(hip: THREE.Vector3, target: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3) {
  const d0 = hip.distanceTo(target);
  const d = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(l1 + l2 - 1e-3, d0));
  const x = target.clone().sub(hip).normalize();
  const end = hip.clone().addScaledVector(x, d);
  const a = (l1 * l1 + d * d - l2 * l2) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const y = pole.clone().sub(x.clone().multiplyScalar(pole.dot(x)));
  if (y.lengthSq() < 1e-8) y.set(0, 0, 1);
  y.normalize();
  return { knee: hip.clone().addScaledVector(x, a).addScaledVector(y, h), end };
}

/** Put a segment (built hanging down -Y from its origin) between two points. */
function place(m: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3) {
  m.position.copy(from);
  _v.copy(to).sub(from).normalize();
  _q.setFromUnitVectors(DOWN, _v);
  m.quaternion.copy(_q);
}
