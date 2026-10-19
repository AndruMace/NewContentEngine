/**
 * Shell Escape's physics: a deterministic Rapier world (identical in Node and Chrome), with no
 * gravity. The shells are spinning kinematic bodies whose walls are thin glass plates (the window
 * face is a frame round an open hole); the ball is a real sphere bouncing elastically inside. When
 * the ball gets out, its shell breaks into glass shards: real bodies that fly out, rattle round
 * inside the next shell and can knock the ball.
 */
import * as dm from '@sim/physics/math';
import { RAPIER } from '../rube-goldberg/rapier';
import { polyhedron, type ShapeId, type V3 } from './polyhedra';

type RWorld = InstanceType<typeof RAPIER.World>;
type RBody = InstanceType<typeof RAPIER.RigidBody>;

export const DT = 1 / 120;
/** Glass wall thickness as a share of the shell's circumradius (it extends outward from the face plane). */
export const WALL_K = 0.035;
/** The ball is far heavier than any shard: debris nudges it, it scatters debris. */
const BALL_MASS = 1;
export const SHARD_MASS = 0.035;

/** A piece of a shell's glass: a flat polygon (shell frame, circumradius 1) extruded outward along n. */
export interface ShardSpec {
  face: number;
  poly: V3[];
  n: V3;
  /** Polygon centre (shell frame, circumradius 1). */
  c: V3;
}

export interface ShellSpec {
  shape: ShapeId;
  R: number;
  axis: V3;
  omega: number;
  angle0: number;
  hole: number;
  holeScale: number;
}

export type ColliderInfo = { kind: 'wall'; layer: number; face: number } | { kind: 'shard'; id: number } | { kind: 'ball' };

export interface Contact {
  /** What the ball (or a shard) hit, and how fast they met. */
  a: ColliderInfo;
  b: ColliderInfo;
  speed: number;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp3 = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const mean3 = (pts: V3[]): V3 => {
  const c: V3 = [0, 0, 0];
  for (const p of pts) for (let i = 0; i < 3; i++) c[i] += p[i] / pts.length;
  return c;
};

/** The shell's orientation at angle a (about its axis), as a quaternion. */
export function axisQuat(axis: V3, a: number) {
  const s = dm.sin(a / 2);
  return { x: axis[0] * s, y: axis[1] * s, z: axis[2] * s, w: dm.cos(a / 2) };
}

/** Rotate v by unit quaternion q. */
export function qrot(q: { x: number; y: number; z: number; w: number }, v: V3): V3 {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** About this many shards per shell, whatever its shape (more makes the physics slow). */
const SHARDS_PER_SHELL = 28;

/**
 * How a shell breaks: each solid face cracks from a point near its middle out to some of its
 * corners (into about the same number of pieces per shell for every shape), and the window face's
 * frame breaks at its corners. Seeded: the cracks are part of the run.
 */
export function crackShell(sh: ShellSpec, rng: { range(a: number, b: number): number; int(a: number, b: number): number }): ShardSpec[] {
  const poly = polyhedron(sh.shape);
  const out: ShardSpec[] = [];
  const push = (face: number, pts: V3[], n: V3) => out.push({ face, poly: pts, n, c: mean3(pts) });
  const per = SHARDS_PER_SHELL / poly.faces.length;
  poly.faces.forEach((face, f) => {
    const pts = face.pts;
    const k = pts.length;
    const c = mean3(pts);
    if (f === sh.hole) {
      const win = pts.map((p) => lerp3(c, p, sh.holeScale));
      for (let i = 0; i < k; i++) {
        const j = (i + 1) % k;
        push(f, [pts[i], pts[j], win[j], win[i]], face.n);
      }
      return;
    }
    // Pieces for this face: the share per face, rounded up or down at random (so it averages out).
    const m = Math.max(1, Math.min(2 * k, Math.floor(per) + (rng.range(0, 1) < per - Math.floor(per) ? 1 : 0)));
    if (m === 1) return push(f, pts.slice(), face.n);
    if (m === 2) {
      // One straight crack across, between two different edges.
      const i = rng.int(0, k - 1);
      const j = (i + (k > 3 ? rng.int(2, k - 2) : rng.int(1, 2))) % k;
      const a = lerp3(pts[i], pts[(i + 1) % k], rng.range(0.3, 0.7));
      const b = lerp3(pts[j], pts[(j + 1) % k], rng.range(0.3, 0.7));
      const one: V3[] = [a];
      for (let v = (i + 1) % k; v !== (j + 1) % k; v = (v + 1) % k) one.push(pts[v]);
      one.push(b);
      const two: V3[] = [b];
      for (let v = (j + 1) % k; v !== (i + 1) % k; v = (v + 1) % k) two.push(pts[v]);
      two.push(a);
      push(f, one, face.n);
      push(f, two, face.n);
      return;
    }
    // A star of cracks from a point off the centre, out to m points round the rim (corners first,
    // then points along edges), each piece a convex wedge.
    const wts = pts.map(() => rng.range(0.6, 1.4));
    const sum = wts.reduce((x, y) => x + y, 0);
    const q: V3 = [0, 0, 0];
    pts.forEach((p, i) => {
      for (let d = 0; d < 3; d++) q[d] += (p[d] * wts[i]) / sum;
    });
    const crack = lerp3(c, q, 0.5);
    // The rim as a loop of points: every corner, plus one point along each edge.
    const rim: { p: V3; corner: boolean }[] = [];
    for (let i = 0; i < k; i++) {
      rim.push({ p: pts[i], corner: true });
      rim.push({ p: lerp3(pts[i], pts[(i + 1) % k], rng.range(0.35, 0.65)), corner: false });
    }
    // Pick m crack ends spread evenly round the rim.
    const start = rng.int(0, rim.length - 1);
    const ends: number[] = [];
    for (let e = 0; e < m; e++) ends.push((start + Math.round((e * rim.length) / m)) % rim.length);
    ends.sort((x, y) => x - y);
    for (let e = 0; e < m; e++) {
      const from = ends[e];
      const to = ends[(e + 1) % m];
      const piece: V3[] = [crack];
      // Walk the rim from one crack end to the next, keeping the corners (and the two ends).
      for (let v = from; ; v = (v + 1) % rim.length) {
        if (v === from || v === to || rim[v].corner) piece.push(rim[v].p);
        if (v === to) break;
      }
      push(f, piece, face.n);
    }
  });
  return out;
}

/** The prism a flat polygon makes when extruded outward by T: inner face, then outer face. */
export function prismPoints(pts: V3[], n: V3, c: V3, R: number, T: number): Float32Array {
  const out = new Float32Array(pts.length * 6);
  pts.forEach((p, i) => {
    for (let d = 0; d < 3; d++) {
      out[i * 3 + d] = (p[d] - c[d]) * R;
      out[(pts.length + i) * 3 + d] = (p[d] - c[d]) * R + n[d] * T;
    }
  });
  return out;
}

export class ShellWorld {
  world: RWorld;
  private queue = new RAPIER.EventQueue(true);
  info = new Map<number, ColliderInfo>();
  shells: (number | null)[] = [];
  ball: number;
  ballCollider: number;
  /** Shard body handles, by global shard id (null until its shell breaks, or once it's gone). */
  shardBodies: (number | null)[] = [];
  private freed = false;

  constructor(specs: ShellSpec[], ballR: number, nShards: number) {
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const w = this.world;
    w.timestep = DT;
    w.lengthUnit = specs[0].R * 0.3;
    w.numSolverIterations = 4;
    w.maxCcdSubsteps = 2;
    this.shardBodies = new Array(nShards).fill(null);
    specs.forEach((sh, layer) => {
      const poly = polyhedron(sh.shape);
      const body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setRotation(axisQuat(sh.axis, sh.angle0)));
      const T = WALL_K * sh.R;
      const plate = (pts: V3[], n: V3, f: number) => {
        const c = mean3(pts);
        const d = RAPIER.ColliderDesc.convexHull(prismPoints(pts, n, c, sh.R, T));
        if (!d) return;
        d.setTranslation(c[0] * sh.R, c[1] * sh.R, c[2] * sh.R);
        this.glass(d, 1);
        const col = w.createCollider(d, body);
        this.info.set(col.handle, { kind: 'wall', layer, face: f });
      };
      poly.faces.forEach((face, f) => {
        if (f !== sh.hole) return plate(face.pts, face.n, f);
        // The window face: a frame of trapezoids round the hole.
        const c = mean3(face.pts);
        const win = face.pts.map((p) => lerp3(c, p, sh.holeScale));
        for (let i = 0; i < face.pts.length; i++) {
          const j = (i + 1) % face.pts.length;
          plate([face.pts[i], face.pts[j], win[j], win[i]], face.n, f);
        }
      });
      this.shells.push(body.handle);
    });
    const ball = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setCanSleep(false).lockRotations());
    const bc = w.createCollider(
      RAPIER.ColliderDesc.ball(ballR)
        .setMass(BALL_MASS)
        .setRestitution(1)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setFriction(0)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      ball,
    );
    this.ball = ball.handle;
    this.ballCollider = bc.handle;
    this.info.set(bc.handle, { kind: 'ball' });
  }

  /** Walls bounce the ball perfectly (its Max rule wins); shards on glass bounce dully (their Min rule wins). */
  private glass(d: InstanceType<typeof RAPIER.ColliderDesc>, restitution: number) {
    d.setRestitution(restitution).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Average).setFriction(0.35).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average);
    d.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  }

  body(h: number): RBody {
    return this.world.getRigidBody(h);
  }

  setBall(p: V3, v: V3) {
    const b = this.body(this.ball);
    b.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
    b.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
  }

  setBallRadius(r: number) {
    const c = this.world.getCollider(this.ballCollider);
    c.setRadius(r);
    c.setMass(BALL_MASS);
  }

  /** Turn a shell to angle a for the coming step. */
  spin(layer: number, q: { x: number; y: number; z: number; w: number }) {
    const h = this.shells[layer];
    if (h !== null) this.body(h).setNextKinematicRotation(q);
  }

  /**
   * Break a shell: its walls go, and each shard becomes a body where its glass was, moving with the
   * spinning shell plus the kick it gets from breaking.
   */
  shatter(layer: number, sh: ShellSpec, q: { x: number; y: number; z: number; w: number }, shards: { id: number; spec: ShardSpec; v: V3; w: V3; mass: number }[]) {
    const h = this.shells[layer];
    if (h === null) return;
    this.world.removeRigidBody(this.body(h));
    this.shells[layer] = null;
    const T = WALL_K * sh.R;
    for (const { id, spec, v, w, mass } of shards) {
      const p = qrot(q, [spec.c[0] * sh.R, spec.c[1] * sh.R, spec.c[2] * sh.R]);
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(p[0], p[1], p[2])
          .setRotation(q)
          .setLinvel(v[0], v[1], v[2])
          .setAngvel({ x: w[0], y: w[1], z: w[2] })
          .setLinearDamping(0.3)
          .setAngularDamping(0.25),
      );
      const d = RAPIER.ColliderDesc.convexHull(prismPoints(spec.poly, spec.n, spec.c, sh.R, T));
      if (!d) continue;
      d.setMass(mass);
      d.setRestitution(0.35).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min).setFriction(0.35).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average);
      d.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const c = this.world.createCollider(d, body);
      this.info.set(c.handle, { kind: 'shard', id });
      this.shardBodies[id] = body.handle;
    }
  }

  /** Forget a shard that has drifted far away. */
  dropShard(id: number) {
    const h = this.shardBodies[id];
    if (h === null) return;
    this.world.removeRigidBody(this.body(h));
    this.shardBodies[id] = null;
  }

  /** One step; returns the collisions that started in it (with how fast the two met). */
  advance(): Contact[] {
    this.world.step(this.queue);
    const out: Contact[] = [];
    this.queue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = this.info.get(h1);
      const b = this.info.get(h2);
      if (!a || !b) return;
      const va = this.velAt(h1);
      const vb = this.velAt(h2);
      out.push({ a, b, speed: Math.sqrt((va[0] - vb[0]) ** 2 + (va[1] - vb[1]) ** 2 + (va[2] - vb[2]) ** 2) });
    });
    return out;
  }

  private velAt(collider: number): V3 {
    const parent = this.world.getCollider(collider).parent();
    if (!parent || !parent.isDynamic()) return [0, 0, 0];
    const v = parent.linvel();
    return [v.x, v.y, v.z];
  }

  free() {
    if (this.freed) return;
    this.freed = true;
    this.world.free();
  }
}

/** Worlds live in WASM memory the garbage collector can't see: this frees the ones a run never did. */
export const worlds = new FinalizationRegistry<ShellWorld>((w) => w.free());

export { dot };
