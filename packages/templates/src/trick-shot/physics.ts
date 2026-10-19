/**
 * Trick Shot's physics: a deterministic Rapier world (identical in Node and Chrome) holding the
 * cabinet, the course and the balls. Balls are real rolling spheres; each step reports every
 * collider a ball pushed against, with the impulse (per unit of ball mass, i.e. a change in speed)
 * and the contact point, so the template can turn impacts into hits, kicks and floor bounces.
 */
import * as dm from '@sim/physics/math';
import { RAPIER } from '../rube-goldberg/rapier';
import { quatFromBasis } from '../rube-goldberg/parts';

export type RWorld = InstanceType<typeof RAPIER.World>;
type RColliderDesc = InstanceType<typeof RAPIER.ColliderDesc>;

/** Row-major 3×3 rotation: columns are the shape's local x, y and z axes in world space. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

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

/** A unit quaternion as a Mat3. */
export function quatMat(q: { x: number; y: number; z: number; w: number }): Mat3 {
  const { x, y, z, w } = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

export const matQuat = (R: Mat3) => quatFromBasis({ x: R[0], y: R[3], z: R[6] }, { x: R[1], y: R[4], z: R[7] }, { x: R[2], y: R[5], z: R[8] });

/** What a collider is, for the rules: its tag, the obstacle it belongs to and, for bumpers, a kick. */
export interface ColliderInfo {
  tag: string;
  obstacle: number;
  kick?: number;
  /** Bumper centre (the kick pushes away from it). */
  at?: { x: number; y: number; z: number };
}

/** A ball's pose and velocity, copied out of the world after every step (what the view and rules read). */
export interface Ball3 {
  body: number;
  collider: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  q: { x: number; y: number; z: number; w: number };
  alive: boolean;
  /** Steps of the last bumper kick and springy-floor bounce (one per impact, not per touching step). */
  kickStep: number;
  floorStep: number;
}

export interface Touch {
  info: ColliderInfo | null;
  /** The other ball, when it was a ball. */
  ball: Ball3 | null;
  impulse: number;
  x: number;
  y: number;
  z: number;
}

export const DT = 1 / 240;

export interface Surface {
  restitution: number;
  friction: number;
  /** Bounce off it at least as hard as the livelier of the two (rather than the duller). */
  lively?: boolean;
}

const MIN = RAPIER.CoefficientCombineRule.Min;
const MAX = RAPIER.CoefficientCombineRule.Max;

export class Table {
  world: RWorld;
  step = 0;
  info = new Map<number, ColliderInfo>();
  balls = new Map<number, Ball3>();
  private freed = false;

  constructor(gravity: number) {
    this.world = new RAPIER.World({ x: 0, y: -gravity, z: 0 });
    Table.tune(this.world);
  }

  private static tune(w: RWorld) {
    w.timestep = DT;
    w.lengthUnit = 0.5;
    w.numSolverIterations = 8;
    w.maxCcdSubsteps = 2;
  }

  private surface(d: RColliderDesc, s: Surface) {
    return d.setRestitution(s.restitution).setFriction(s.friction).setRestitutionCombineRule(s.lively ? MAX : MIN).setFrictionCombineRule(MAX);
  }

  /** Fixed scenery. Returns the collider handle. */
  addStatic(d: RColliderDesc, at: { x: number; y: number; z: number }, rot: Mat3 | null, s: Surface, info: ColliderInfo): number {
    d.setTranslation(at.x, at.y, at.z);
    if (rot) d.setRotation(matQuat(rot));
    const c = this.world.createCollider(this.surface(d, s));
    this.info.set(c.handle, info);
    return c.handle;
  }

  /** A box turned by setting its yaw each step (spinners). Returns its body handle. */
  addKinematicBox(at: { x: number; y: number; z: number }, half: { x: number; y: number; z: number }, yaw: number, s: Surface, info: ColliderInfo): number {
    const b = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y, at.z).setRotation(yawQuat(yaw)));
    const c = this.world.createCollider(this.surface(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z), s), b);
    this.info.set(c.handle, info);
    return b.handle;
  }

  /**
   * A paddle hanging from a hinge at its top edge, free to swing (about its local z axis, turned to
   * `yaw`) when a ball knocks it. Returns its body handle.
   */
  addSwing(pivot: { x: number; y: number; z: number }, half: { x: number; y: number; z: number }, yaw: number, s: Surface, info: ColliderInfo): number {
    const q = yawQuat(yaw);
    const anchor = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(pivot.x, pivot.y, pivot.z).setRotation(q));
    const b = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(pivot.x, pivot.y - half.y, pivot.z).setRotation(q).setAngularDamping(0.6),
    );
    const c = this.world.createCollider(this.surface(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setMass(1.5), s), b);
    this.info.set(c.handle, info);
    this.world.createImpulseJoint(RAPIER.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: half.y, z: 0 }, { x: 0, y: 0, z: 1 }), anchor, b, true);
    return b.handle;
  }

  /** A body's pose, for drawing. */
  pose(body: number) {
    const b = this.world.getRigidBody(body);
    return { t: b.translation(), q: b.rotation() };
  }

  setYaw(body: number, yaw: number) {
    this.world.getRigidBody(body).setNextKinematicRotation(yawQuat(yaw));
  }

  addBall(at: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }, r: number, s: Surface): Ball3 {
    const b = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setLinvel(v.x, v.y, v.z).setCcdEnabled(true).setAngularDamping(0.3).setCanSleep(false),
    );
    // Mass 1, so contact impulses read as changes in speed.
    const c = this.world.createCollider(this.surface(RAPIER.ColliderDesc.ball(r).setMass(1), s), b);
    const ball: Ball3 = { body: b.handle, collider: c.handle, x: at.x, y: at.y, z: at.z, vx: v.x, vy: v.y, vz: v.z, q: { x: 0, y: 0, z: 0, w: 1 }, alive: true, kickStep: -100, floorStep: -100 };
    this.balls.set(c.handle, ball);
    return ball;
  }

  removeBall(ball: Ball3) {
    if (!ball.alive) return;
    ball.alive = false;
    this.balls.delete(ball.collider);
    this.world.removeRigidBody(this.world.getRigidBody(ball.body));
  }

  advance() {
    this.world.step();
    this.step++;
  }

  /** Everything a ball pushed against during the last step (impulse > 0), in the engine's order. */
  touches(ball: Ball3): Touch[] {
    const out: Touch[] = [];
    const w = this.world;
    const me = w.getCollider(ball.collider);
    w.contactPairsWith(me, (other) => {
      w.contactPair(me, other, (m) => {
        let j = 0;
        for (let i = 0; i < m.numContacts(); i++) j += m.contactImpulse(i);
        if (!(j > 0) || m.numSolverContacts() === 0) return;
        const p = m.solverContactPoint(0)!;
        out.push({ info: this.info.get(other.handle) ?? null, ball: this.balls.get(other.handle) ?? null, impulse: j, x: p.x, y: p.y, z: p.z });
      });
    });
    return out;
  }

  /** Copy a ball's pose and velocity out of the world. */
  read(ball: Ball3) {
    const b = this.world.getRigidBody(ball.body);
    const t = b.translation();
    const v = b.linvel();
    ball.x = t.x;
    ball.y = t.y;
    ball.z = t.z;
    ball.vx = v.x;
    ball.vy = v.y;
    ball.vz = v.z;
    ball.q = b.rotation();
  }

  /** Write a ball's (changed) velocity back into the world. */
  write(ball: Ball3) {
    this.world.getRigidBody(ball.body).setLinvel({ x: ball.vx, y: ball.vy, z: ball.vz }, true);
  }

  snapshot(): Uint8Array {
    return this.world.takeSnapshot();
  }

  /** Back to a snapshot (the course as built, no balls): the identical world every time. */
  restore(snap: Uint8Array) {
    this.world.free();
    this.world = RAPIER.World.restoreSnapshot(snap);
    Table.tune(this.world);
    this.balls.clear();
  }

  free() {
    if (this.freed) return;
    this.freed = true;
    this.world.free();
  }
}

export const yawQuat = (a: number) => ({ x: 0, y: dm.sin(a / 2), z: 0, w: dm.cos(a / 2) });

/**
 * Worlds live in WASM memory, which the JS garbage collector can't see: a run frees its world when it
 * ends, and this catches the ones that never do (timed out, or abandoned mid-run).
 */
export const tables = new FinalizationRegistry<Table>((t) => t.free());
