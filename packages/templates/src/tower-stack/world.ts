/**
 * Tower Stack's physics: a deterministic Rapier world (identical in Node and Chrome) held flat, so
 * pieces only slide and tip in the picture plane. A fixed platform at the bottom, and pieces as
 * real rigid bodies (boxes for cell pieces, convex hulls for the rest). The world can be saved and
 * restored exactly, which the AI uses to test-drop every placement it considers and the game uses
 * to roll back to the last steady tower after a fall.
 */
import * as dm from '@sim/physics/math';
import { RAPIER } from '../rube-goldberg/rapier';
import { DEPTH, PIECES, placed, type PieceDef, type V2 } from './pieces';

type RWorld = InstanceType<typeof RAPIER.World>;

export const DT = 1 / 60;
/** Half the platform's width (it is 42 cm across) and its thickness. */
export const BASE_HW = 2.1;
const BASE_H = 0.35;
/** A piece this far below the platform's top has gone over the edge. */
const FALL_Y = -0.9;
/**
 * Or falling this fast: free fall through more than 10 cm, which no piece settling into place does
 * (the hardest a piece lands is let go from 5 cm). Calling it then, not once the piece has dropped
 * past the platform, keeps test drops of pieces that go over a tall tower's edge short.
 */
const FALL_VY = -10;
/** Steady: nothing moving faster than these for SETTLE_S. */
const SETTLE_V = 0.06;
const SETTLE_W = 0.06;
const SETTLE_S = 0.3;
const FLAT_STEP = 0.125;
/** Pieces whose top is this far below the tower's top are locked in place (45 cm). */
const LOCK_DEPTH = 4.5;
/** A drop that never comes to rest within this long counts as unsteady. */
export const MAX_DROP_S = 3;

export interface PieceBody {
  def: PieceDef;
  body: number;
  /** Pose, copied out of the world after every step (what the view and the rules read). */
  x: number;
  y: number;
  a: number;
  vx: number;
  vy: number;
  w: number;
  /** Set deep in the tower (see lockBelow): fixed in place, no longer simulated. */
  locked: boolean;
}

/** What one step of a drop came to. */
export type DropState = 'moving' | 'settled' | 'fell' | 'timeout';

export class StackWorld {
  world: RWorld;
  pieces: PieceBody[] = [];
  private freed = false;

  constructor(readonly gravity: number, readonly friction: number) {
    this.world = new RAPIER.World({ x: 0, y: -gravity, z: 0 });
    StackWorld.tune(this.world);
    const base = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -BASE_H / 2, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(BASE_HW, BASE_H / 2, DEPTH).setFriction(friction).setRestitution(0), base);
  }

  private static tune(w: RWorld) {
    w.timestep = DT;
    w.lengthUnit = 0.5;
    w.numSolverIterations = 8;
  }

  /** Add a piece at rest at a pose. */
  add(def: PieceDef, x: number, y: number, a: number): PieceBody {
    const b = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, 0)
        .setRotation({ x: 0, y: 0, z: dm.sin(a / 2), w: dm.cos(a / 2) })
        .enabledTranslations(true, true, false)
        .enabledRotations(false, false, true)
        .setLinearDamping(0.05)
        .setAngularDamping(0.25),
    );
    for (const part of def.parts) {
      let d;
      if (part.box) d = RAPIER.ColliderDesc.cuboid(part.box.hw, part.box.hh, DEPTH / 2).setTranslation(part.box.cx, part.box.cy, 0);
      else {
        const pts = new Float32Array(part.poly.length * 6);
        part.poly.forEach(([px, py], i) => pts.set([px, py, -DEPTH / 2, px, py, DEPTH / 2], i * 6));
        d = RAPIER.ColliderDesc.convexHull(pts)!;
      }
      this.world.createCollider(d.setDensity(1).setFriction(this.friction).setRestitution(0.04), b);
    }
    const p: PieceBody = { def, body: b.handle, x, y, a, vx: 0, vy: 0, w: 0, locked: false };
    this.pieces.push(p);
    return p;
  }

  advance() {
    this.world.step();
    for (const p of this.pieces) {
      if (p.locked) continue;
      const b = this.world.getRigidBody(p.body);
      // Asleep: exactly where it was, and still.
      if (b.isSleeping()) {
        p.vx = p.vy = p.w = 0;
        continue;
      }
      const t = b.translation();
      const q = b.rotation();
      const v = b.linvel();
      p.x = t.x;
      p.y = t.y;
      p.a = 2 * dm.atan2(q.z, q.w);
      p.vx = v.x;
      p.vy = v.y;
      p.w = b.angvel().z;
    }
  }

  /**
   * Fix in place every piece whose top is below `y`. A settled piece deep in a tall tower barely moves
   * whatever lands on top, but simulating it costs every test drop as much as a piece near the top
   * (the whole stack wakes up together): locking them keeps each drop's cost flat as the tower grows.
   */
  lockBelow(y: number) {
    for (const p of this.pieces) {
      if (p.locked || Math.max(...placed(p.def, p.x, p.y, p.a).map((q) => q[1])) >= y) continue;
      p.locked = true;
      p.vx = p.vy = p.w = 0;
      this.world.getRigidBody(p.body).setBodyType(RAPIER.RigidBodyType.Fixed, false);
    }
  }

  /** Lock what is now deep in the tower (after every steady drop, live or tested ahead). */
  lockDeep() {
    this.lockBelow(measure(this.pieces).top - LOCK_DEPTH);
  }

  /** The world as it stands, with the pieces in it (handles survive a restore). */
  save(): Snap {
    return { bytes: this.world.takeSnapshot(), pieces: this.pieces.map((p) => ({ ...p })) };
  }

  restore(snap: Snap) {
    this.world.free();
    this.world = RAPIER.World.restoreSnapshot(snap.bytes);
    StackWorld.tune(this.world);
    this.pieces = snap.pieces.map((p) => ({ ...p }));
  }

  free() {
    if (this.freed) return;
    this.freed = true;
    this.world.free();
  }
}

export interface Snap {
  bytes: Uint8Array;
  pieces: PieceBody[];
}

/**
 * Watches a drop step by step: has the piece (or anything else) gone over the edge, has the whole
 * tower come to rest, or is it taking too long? Used for test drops and the live drop alike, so the
 * live drop ends exactly as its test did.
 */
export class DropWatch {
  steps = 0;
  stillS = 0;

  update(w: StackWorld): DropState {
    this.steps++;
    let still = true;
    for (const p of w.pieces) {
      if (p.y < FALL_Y || p.vy < FALL_VY) return 'fell';
      if (Math.abs(p.vx) > SETTLE_V || Math.abs(p.vy) > SETTLE_V || Math.abs(p.w) > SETTLE_W) still = false;
    }
    this.stillS = still ? this.stillS + DT : 0;
    if (this.stillS >= SETTLE_S) return 'settled';
    if (this.steps * DT >= MAX_DROP_S) return 'timeout';
    return 'moving';
  }
}

/** Everything about the tower's shape the rules and the AI care about. */
export interface Shape {
  /** Top of the highest piece above the platform (world units). */
  top: number;
  /** How wide the tower is near its top: what the next piece has to land on. */
  topMinX: number;
  topMaxX: number;
  /**
   * The width of the tower's top that is nearly level with its peak (a soft measure: a ledge a cell
   * below the peak counts for about half), in world units.
   */
  flat: number;
  /** How far the top half of the tower's weight sits to the side of the bottom half's. */
  overhang: number;
  /** Where the tower's weight sits, sideways. */
  comX: number;
  /** The whole tower's sideways extent (the platform at least). */
  minX: number;
  maxX: number;
}

export function measure(pieces: PieceBody[]): Shape {
  let top = 0;
  const outlines: V2[][] = pieces.map((p) => placed(p.def, p.x, p.y, p.a));
  for (const o of outlines) for (const [, y] of o) top = Math.max(top, y);
  let topMinX = Infinity, topMaxX = -Infinity;
  for (const o of outlines) for (const [x, y] of o) if (y > top - 0.2) {
    topMinX = Math.min(topMinX, x);
    topMaxX = Math.max(topMaxX, x);
  }
  if (!pieces.length) {
    topMinX = -BASE_HW;
    topMaxX = BASE_HW;
  }
  let m = 0, mx = 0;
  let minX = -BASE_HW, maxX = BASE_HW;
  for (const p of pieces) {
    m += p.def.area;
    mx += p.def.area * p.x;
  }
  for (const o of outlines) for (const [x, y] of o) if (y > -0.2) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  let flat = 0;
  if (pieces.length)
    for (let x = minX + FLAT_STEP / 2; x < maxX; x += FLAT_STEP) {
      const sky = skylineOf(outlines, x - FLAT_STEP / 2, x + FLAT_STEP / 2);
      if (sky > 0) flat += FLAT_STEP * dm.exp(-(top - sky) / 0.7);
    }
  let mLo = 0, xLo = 0, mHi = 0, xHi = 0;
  for (const p of pieces)
    if (p.y < top / 2) {
      mLo += p.def.area;
      xLo += p.def.area * p.x;
    } else {
      mHi += p.def.area;
      xHi += p.def.area * p.x;
    }
  const overhang = mLo && mHi ? Math.abs(xHi / mHi - xLo / mLo) : 0;
  return { top, topMinX, topMaxX, flat, overhang, comX: m ? mx / m : 0, minX, maxX };
}

/**
 * The highest point of the tower between x0 and x1 (the platform's top, 0, where there is nothing):
 * how low a piece spanning that stretch can be held.
 */
export function skyline(pieces: PieceBody[], x0: number, x1: number): number {
  return skylineOf(pieces.map((p) => placed(p.def, p.x, p.y, p.a)), x0, x1);
}

/** skyline() over outlines already placed in the world. */
function skylineOf(outlines: V2[][], x0: number, x1: number): number {
  let top = 0;
  for (const o of outlines)
    for (let i = 0; i < o.length; i++) {
      const [ax, ay] = o[i];
      const [bx, by] = o[(i + 1) % o.length];
      // The part of this edge over [x0, x1]: its highest end.
      const lo = Math.max(x0, Math.min(ax, bx));
      const hi = Math.min(x1, Math.max(ax, bx));
      if (lo > hi) continue;
      if (bx === ax) top = Math.max(top, ay, by);
      else top = Math.max(top, ay + ((by - ay) * (lo - ax)) / (bx - ax), ay + ((by - ay) * (hi - ax)) / (bx - ax));
    }
  return top;
}

export { PIECES };

/**
 * Worlds live in WASM memory, which the JS garbage collector can't see: a run frees its world when it
 * ends, and this catches the ones that never do (timed out, or abandoned mid-run).
 */
export const worlds = new FinalizationRegistry<StackWorld>((w) => w.free());
