/**
 * The Rube Goldberg simulation: a Rapier world plus everything needed to replay it. The machine is
 * generated and simulated in one pass at init (trying, rolling back and retrying modules), and the
 * pass records a tape: every dynamic body's pose each video frame, and every event with its step.
 * The template then just plays the tape, so Node and Chrome see the same run by construction.
 *
 * Units are real: metres, kilograms, seconds, g = 9.81.
 */
import * as dm from '@sim/physics/math';
import { RAPIER } from './rapier';

export type RWorld = InstanceType<typeof RAPIER.World>;
export type RBody = InstanceType<typeof RAPIER.RigidBody>;
export type RCollider = InstanceType<typeof RAPIER.Collider>;

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const ID_Q: Quat = { x: 0, y: 0, z: 0, w: 1 };

export const DT = 1 / 240;
/** Physics steps per video frame (the tape stores one pose per frame). */
export const STEPS_PER_FRAME = 4;
export const MARBLE_R = 0.0125;

/** Real-world contact properties (friction, restitution, density kg/m³). */
export const MATERIALS = {
  glass: { friction: 0.35, restitution: 0.6, density: 2500 },
  steel: { friction: 0.25, restitution: 0.55, density: 7850 },
  wood: { friction: 0.5, restitution: 0.45, density: 650 },
  brass: { friction: 0.3, restitution: 0.5, density: 8500 },
  rubber: { friction: 0.9, restitution: 0.2, density: 1200 },
  ivory: { friction: 0.4, restitution: 0.4, density: 900 },
  /** A landing pad: soaks up a drop (no bounce of its own). */
  felt: { friction: 0.8, restitution: 0, density: 300 },
} as const;
export type Material = keyof typeof MATERIALS;

/** How a piece is drawn (the view builds three.js meshes from these). */
export type Shape =
  | { kind: 'box'; hx: number; hy: number; hz: number; round?: number }
  | { kind: 'sphere'; r: number }
  | { kind: 'cylinder'; r: number; hh: number }
  | { kind: 'capsule'; r: number; hh: number }
  | { kind: 'mesh'; positions: Float32Array; indices: Uint32Array; /** Rapier TriMeshFlags (e.g. fix internal edges, so balls don't catch on seams). */ flags?: number }
  /** Drawing only (a ring in the x–z plane, e.g. a funnel's rolled rim). */
  | { kind: 'torus'; R: number; r: number };

/** Visual finish (independent of the physical material where it matters, e.g. painted wood). */
export type Finish = 'maple' | 'walnut' | 'paint' | 'brass' | 'steel' | 'glass' | 'ivory' | 'rubber' | 'felt' | 'bell';

export interface Piece {
  shape: Shape;
  /** Drawn as this instead of the collision shape (e.g. a bell's flared mesh over a simple cylinder). */
  draw?: Shape;
  finish: Finish;
  /** Paint colour index (theme accent / palette), for 'paint' and marble vanes. */
  hue?: number;
  /** Pose in the body's frame (dynamic) or the world (static). */
  pos: V3;
  rot: Quat;
}

/** One collider of a moving body, with optional overrides of its material's density and bounce. */
export interface BodyPiece {
  piece: Piece;
  material: Material;
  tag?: string;
  density?: number;
  restitution?: number;
  /** Drawn with the body but not part of its collision shape (decoration). */
  drawOnly?: boolean;
}

export interface BodyRec {
  handle: number;
  pieces: Piece[];
  kind: 'marble' | 'part';
  /** Step it was created at (it is drawn at its first recorded pose before that). */
  born: number;
}

/** Something that happened, at a physics step (sounds, music, camera beats). */
export interface TapeEvent {
  step: number;
  type: string;
  [key: string]: unknown;
}

interface ColliderInfo {
  material: Material;
  tag: string;
  /** Index into bodies, or -1 for static scenery. */
  body: number;
}

export interface Mark {
  snap: Uint8Array;
  step: number;
  bodies: number;
  statics: number;
  frames: number;
  events: number;
  colliders: number;
}

export class Sim {
  world: RWorld;
  step = 0;
  bodies: BodyRec[] = [];
  statics: Piece[] = [];
  /** Per video frame, every body's pose so far: [x, y, z, qx, qy, qz, qw] × bodies. */
  frames: Float32Array[] = [];
  events: TapeEvent[] = [];
  private queue = new RAPIER.EventQueue(true);
  private info = new Map<number, ColliderInfo>();
  /** Collider handles in creation order (so a rollback can forget the newer ones). */
  private colliderOrder: number[] = [];
  /** Last time each body made a sound (to thin out rattles). */
  private lastSound = new Map<number, number>();

  constructor() {
    this.world = Sim.newWorld();
  }

  static newWorld(): RWorld {
    const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    Sim.tune(w);
    return w;
  }

  private static tune(w: RWorld) {
    w.timestep = DT;
    w.lengthUnit = 0.1;
    w.numSolverIterations = 8;
    w.maxCcdSubsteps = 2;
  }

  get t() {
    return this.step * DT;
  }

  body(i: number): RBody {
    return this.world.getRigidBody(this.bodies[i].handle);
  }

  private register(c: RCollider, material: Material, tag: string, body: number) {
    this.info.set(c.handle, { material, tag, body });
    this.colliderOrder.push(c.handle);
    c.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  }

  private colliderDesc(shape: Shape, material: Material): InstanceType<typeof RAPIER.ColliderDesc> {
    let d: InstanceType<typeof RAPIER.ColliderDesc>;
    switch (shape.kind) {
      case 'box':
        d = shape.round ? RAPIER.ColliderDesc.roundCuboid(shape.hx - shape.round, shape.hy - shape.round, shape.hz - shape.round, shape.round) : RAPIER.ColliderDesc.cuboid(shape.hx, shape.hy, shape.hz);
        break;
      case 'sphere':
        d = RAPIER.ColliderDesc.ball(shape.r);
        break;
      case 'cylinder':
        d = RAPIER.ColliderDesc.cylinder(shape.hh, shape.r);
        break;
      case 'capsule':
        d = RAPIER.ColliderDesc.capsule(shape.hh, shape.r);
        break;
      case 'mesh':
        d = shape.flags ? RAPIER.ColliderDesc.trimesh(shape.positions, shape.indices, shape.flags) : RAPIER.ColliderDesc.trimesh(shape.positions, shape.indices);
        break;
      case 'torus':
        throw new Error('torus pieces are drawing only');
    }
    const m = MATERIALS[material];
    return d.setFriction(m.friction).setRestitution(m.restitution).setDensity(m.density);
  }

  /** Fixed scenery: a collider and its drawing (or just a drawing, with collide = false). */
  addStatic(piece: Piece, material: Material, tag = 'static', collide = true) {
    this.statics.push(piece);
    if (!collide) return;
    const c = this.world.createCollider(this.colliderDesc(piece.shape, material).setTranslation(piece.pos.x, piece.pos.y, piece.pos.z).setRotation(piece.rot));
    this.register(c, material, tag, -1);
  }

  /** A moving body made of pieces (in its own frame). Returns its index. */
  addBody(
    at: V3,
    rot: Quat,
    pieces: BodyPiece[],
    o: { kind?: 'marble' | 'part'; fixed?: boolean; kinematic?: boolean; ccd?: boolean; angularDamping?: number; linearDamping?: number; sleeping?: boolean; canSleep?: boolean } = {},
  ): number {
    const desc = (o.fixed ? RAPIER.RigidBodyDesc.fixed() : o.kinematic ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic())
      .setTranslation(at.x, at.y, at.z)
      .setRotation(rot)
      .setCcdEnabled(!!o.ccd)
      .setAngularDamping(o.angularDamping ?? 0)
      .setLinearDamping(o.linearDamping ?? 0)
      .setCanSleep(o.canSleep ?? true);
    if (o.sleeping) desc.setSleeping(true);
    const b = this.world.createRigidBody(desc);
    const idx = this.bodies.length;
    for (const { piece, material, tag, density, restitution, drawOnly } of pieces) {
      if (drawOnly) continue;
      const d = this.colliderDesc(piece.shape, material).setTranslation(piece.pos.x, piece.pos.y, piece.pos.z).setRotation(piece.rot);
      if (density !== undefined) d.setDensity(density);
      if (restitution !== undefined) d.setRestitution(restitution);
      const c = this.world.createCollider(d, b);
      this.register(c, material, tag ?? 'part', idx);
    }
    this.bodies.push({ handle: b.handle, pieces: pieces.map((p) => p.piece), kind: o.kind ?? 'part', born: this.step });
    return idx;
  }

  /** A glass or steel marble (CCD on, a little rolling resistance). */
  addMarble(at: V3, material: 'glass' | 'steel', hue: number, sleeping = false): number {
    const piece: Piece = { shape: { kind: 'sphere', r: MARBLE_R }, finish: material === 'glass' ? 'glass' : 'steel', hue, pos: v3(0, 0, 0), rot: ID_Q };
    // Rolling resistance (wood and felt aren't perfectly hard): calms marbles to a watchable pace.
    return this.addBody(at, ID_Q, [{ piece, material, tag: 'marble' }], { kind: 'marble', ccd: true, angularDamping: 0.25, sleeping });
  }

  hinge(a: number | null, b: number, anchorA: V3, anchorB: V3, axis: V3, limits?: [number, number]) {
    const bodyA = a === null ? this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()) : this.body(a);
    const j = this.world.createImpulseJoint(RAPIER.JointData.revolute(anchorA, anchorB, axis), bodyA, this.body(b), true) as InstanceType<typeof RAPIER.RevoluteImpulseJoint>;
    if (limits) j.setLimits(limits[0], limits[1]);
    return j;
  }

  emit(type: string, data: Record<string, unknown> = {}) {
    this.events.push({ step: this.step, type, ...data });
  }

  /** Advance one physics step: integrate, turn new contacts into impact events, record the frame. */
  advance() {
    this.world.step(this.queue);
    this.step++;
    this.queue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = this.info.get(h1);
      const b = this.info.get(h2);
      if (!a || !b) return;
      const va = a.body >= 0 ? this.body(a.body).linvel() : { x: 0, y: 0, z: 0 };
      const vb = b.body >= 0 ? this.body(b.body).linvel() : { x: 0, y: 0, z: 0 };
      const speed = Math.sqrt((va.x - vb.x) ** 2 + (va.y - vb.y) ** 2 + (va.z - vb.z) ** 2);
      if (speed < 0.05) return;
      // One sound per body per 30 ms: a rattle shouldn't machine-gun.
      const who = Math.max(a.body, b.body);
      if (this.step - (this.lastSound.get(who) ?? -100) < 7) return;
      this.lastSound.set(who, this.step);
      const p = who >= 0 ? this.body(who).translation() : { x: 0, y: 0, z: 0 };
      this.emit('impact', { a: a.material, b: b.material, tagA: a.tag, tagB: b.tag, speed, x: p.x, y: p.y });
    });
    if (this.step % STEPS_PER_FRAME === 0) this.recordFrame();
  }

  recordFrame() {
    const f = new Float32Array(this.bodies.length * 7);
    this.bodies.forEach((rec, i) => {
      const b = this.world.getRigidBody(rec.handle);
      const t = b.translation();
      const r = b.rotation();
      f.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w], i * 7);
    });
    this.frames.push(f);
  }

  mark(): Mark {
    return { snap: this.world.takeSnapshot(), step: this.step, bodies: this.bodies.length, statics: this.statics.length, frames: this.frames.length, events: this.events.length, colliders: this.colliderOrder.length };
  }

  /** Go back to a mark: the world, the tape and the registries as they were. */
  rollback(m: Mark) {
    this.world.free();
    this.world = RAPIER.World.restoreSnapshot(m.snap);
    Sim.tune(this.world);
    this.queue = new RAPIER.EventQueue(true);
    this.step = m.step;
    this.bodies.length = m.bodies;
    this.statics.length = m.statics;
    this.frames.length = m.frames;
    this.events.length = m.events;
    for (const h of this.colliderOrder.splice(m.colliders)) this.info.delete(h);
    for (const [k, v] of this.lastSound) if (v > m.step) this.lastSound.delete(k);
  }

  free() {
    this.world.free();
    this.queue.free();
  }
}

/** Quaternion for a rotation of angle a about a unit axis. */
export function quatAxis(ax: V3, a: number): Quat {
  const s = dm.sin(a / 2);
  return { x: ax.x * s, y: ax.y * s, z: ax.z * s, w: dm.cos(a / 2) };
}

/** q1 · q2. */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/** Rotate v by q. */
export function rotate(q: Quat, v: V3): V3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

export const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: V3, k: number): V3 => v3(a.x * k, a.y * k, a.z * k);
export const len = (a: V3) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
