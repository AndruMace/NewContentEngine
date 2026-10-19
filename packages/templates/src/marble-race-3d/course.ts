/**
 * The race course: a tower of wide, gently sloping lanes, each joined to the next by a drop, a
 * banked hairpin, a helix or a coin funnel, built as real colliders in a Rapier world (the Rube
 * Goldberg template's recording sim). Runs go along x, depth is z (towards the camera is +z), and
 * every piece sits below the one before it, so the course always runs downhill.
 *
 * Alongside the colliders the builder records the course's centre line (where a marble's centre
 * travels), which turns a marble's position into how far along the course it is.
 */
import * as dm from '@sim/physics/math';
import type { Rng } from '@sim/engine';
import { plank } from '../rube-goldberg/parts';
import { RAPIER } from '../rube-goldberg/rapier';
import { boxOf, hiddenShare, inBox, occluders, type Box } from './visibility';
import { ID_Q, quatAxis, v3, type Sim, type V3 } from '../rube-goldberg/sim';

/** Track meshes smooth over their triangle seams (a rolling marble would otherwise catch on them). */
const SMOOTH = RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES;

/** Marble radius (16 mm-ish race marbles, a little bigger to read on a phone). */
export const R = 0.011;
/** Lane inside width (room for four or five abreast, and for a marble past either side of a peg pair). */
export const W = 0.105;
/** Wall height and thickness, floor thickness. */
export const WALL_H = 0.03;
export const T = 0.005;
/** Lanes run between ±XL. */
export const XL = 0.15;
/** Turn radius of hairpins and helixes (centre line). */
export const RT = 0.07;
/** A funnel's spout: from its hole down to just above the walls of the lane it drops onto. */
const SPOUT = 0.026;
/** Vertical room a lane needs above the one below it: walls, floor and enough of a gap to see in. */
const CLEAR = WALL_H + T + 0.035;
/** Lane fall per metre. */
const SLOPE = 0.045;
/**
 * Banking of hairpins and helixes (rise across per unit width). None: banking has to fade out where
 * a turn meets a flat lane, and wherever it fades the low edge climbs, leaving a pit slow marbles
 * sit in. Turns are flat, with a taller outer wall for the marbles to ride round.
 */
const BANK = 0;
export const OUTER_H = WALL_H * 1.5;
/** A helix's fall per turn: its turns stack with room between (the outer wall, the banking and the floor). */
const HELIX_PITCH = OUTER_H + (W / 2) * BANK + T + 0.01;

export type Connector = 'drop' | 'hairpin' | 'helix' | 'funnel' | 'trapdoor' | 'wheel' | 'jump' | 'lift';
/** The contraptions: joins that are a show of their own (at most one a section). */
export const SPECIALS: Connector[] = ['trapdoor', 'wheel', 'jump', 'lift'];
export type SectionKind = 'zigzag' | 'pegs' | 'spinners' | 'funnel' | 'helix';
export const SECTION_KINDS: SectionKind[] = ['zigzag', 'pegs', 'spinners', 'funnel', 'helix'];

/** A spinning bar (a kinematic body the race loop turns every step). */
export interface Spinner {
  body: number;
  at: V3;
  omega: number;
  phase: number;
}

/** A gate bar across a lane that lifts out of the way when it opens. */
export interface Gate {
  body: number;
  at: V3;
  openAt: number | null;
}

export interface Section {
  kind: SectionKind;
  /** Course distance where it starts and ends (the end is its checkpoint line). */
  s0: number;
  s1: number;
  /** Palette position for its colour. */
  hue: number;
}

/** A turn or helix as built (for drawing it smooth): round c, from angle a0 to a1, floor height y0 to y1. */
export interface TurnSpec {
  c: V3;
  a0: number;
  a1: number;
  y0: number;
  y1: number;
  hue: number;
}

/** A coin funnel as built: rim centre c, rim and hole radii, depth to the hole, spout length. */
export interface FunnelSpec {
  c: V3;
  rTop: number;
  rHole: number;
  depth: number;
  spout: number;
  hue: number;
}

export interface Course {
  /** The turns and funnels, for drawing (their colliders are coarser triangle meshes). */
  turns: TurnSpec[];
  funnels: FunnelSpec[];
  /** Centre line samples, with the course distance at each. */
  path: V3[];
  dist: number[];
  /** Unit direction of travel at each sample. */
  tangent: V3[];
  sections: Section[];
  /** Every lane's stretch of course distance, and what obstacles it carries. */
  lanes: { s0: number; s1: number; kind: SectionKind; obstacles: boolean; from: V3; to: V3; /** How much track existed when it was laid (statics, turns, funnels). */ built: [number, number, number]; /** It forks (a shortcut through a hole to the lane below). */ fork: boolean }[];
  /** Where each checkpoint line is drawn (point and lane direction): the start of each section after the first, then the finish. */
  lines: { at: V3; dir: number; s: number }[];
  /** Round gates (elimination mode), one per checkpoint except the finish. */
  gates: Gate[];
  spinners: Spinner[];
  /** Trapdoors (a weighted flap that tips under a few marbles), for the race loop's release timer. */
  trapdoors: Trapdoor[];
  /** Stair elevators: their slats, which the race loop moves. */
  lifts: Lift[];
  /** The start: where the grid of marbles sits behind the start gate. */
  grid: V3[];
  startGate: Gate;
  /** Lowest point (the finish tray floor). */
  bottom: number;
  /** Track extent, for framing. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** A trapdoor at a lane's end: a flap on a hinge, held shut by a counterweight until enough marbles sit on it. */
export interface Trapdoor {
  body: number;
  /** The flap's angle about z when shut, and how far it swings open (toward -dir). */
  rest: number;
  open: number;
  /** The hinge (the flap's upstream edge, at its mid-thickness). */
  pivot: V3;
  /** Flap centre (top surface), its length along the lane, and the lane's direction. */
  at: V3;
  len: number;
  dir: number;
}

/** A stair elevator: slats that rise and fall in turn, passing marbles up one step at a time. */
export interface Lift {
  bodies: number[];
  /** Each slat's resting centre; it moves up and down by `amp`, alternate slats in opposite phase. */
  at: V3[];
  amp: number;
}

/**
 * A fork in a lane: from `split` (distance along the lane) a divider runs to the lane's end. On the
 * `side` half a hole opens from d0 to d1: marbles that take that side drop straight through to the
 * middle of the lane below (a shortcut); the rest run on to the end and drop there.
 */
interface Fork {
  split: number;
  d0: number;
  d1: number;
  side: 1 | -1;
}

interface Cursor {
  /** Floor point at the lane start (centre of the lane). */
  at: V3;
  /** Direction of travel along x. */
  dir: 1 | -1;
  /** Marbles land on its start (a drop or a funnel), so it needs an end stop behind them. */
  cap: boolean;
  /** How far its start reaches below its floor (an elevator's foot): the next join must clear it. */
  deep?: number;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

class Builder {
  path: V3[] = [];
  turns: TurnSpec[] = [];
  funnels: FunnelSpec[] = [];
  trapdoors: Trapdoor[] = [];
  lifts: Lift[] = [];
  /** Space moving parts sweep through (elevator slats, wheels, trapdoor flaps): no later lane may enter it. */
  reserved: { lo: V3; hi: V3 }[] = [];
  minX = Infinity;
  maxX = -Infinity;
  minZ = Infinity;
  maxZ = -Infinity;
  constructor(public sim: Sim, public rng: Rng) {}

  /** What a rollback has to undo besides the sim (see Sim.mark). */
  save() {
    return { path: this.path.length, turns: this.turns.length, funnels: this.funnels.length, trapdoors: this.trapdoors.length, lifts: this.lifts.length, reserved: this.reserved.length, bounds: [this.minX, this.maxX, this.minZ, this.maxZ] };
  }

  restore(m: ReturnType<Builder['save']>) {
    this.path.length = m.path;
    this.turns.length = m.turns;
    this.funnels.length = m.funnels;
    this.trapdoors.length = m.trapdoors;
    this.lifts.length = m.lifts;
    this.reserved.length = m.reserved;
    [this.minX, this.maxX, this.minZ, this.maxZ] = m.bounds;
  }

  /** Extend the centre line (marble-centre height) through p. */
  pass(p: V3) {
    const last = this.path[this.path.length - 1];
    if (last) {
      const d = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
      // Sample about every 8 mm, so a marble's nearest sample is never far off.
      const n = Math.max(1, Math.ceil(d / 0.008));
      for (let i = 1; i <= n; i++) this.path.push(v3(lerp(last.x, p.x, i / n), lerp(last.y, p.y, i / n), lerp(last.z, p.z, i / n)));
    } else this.path.push(p);
    this.minX = Math.min(this.minX, p.x);
    this.maxX = Math.max(this.maxX, p.x);
    this.minZ = Math.min(this.minZ, p.z);
    this.maxZ = Math.max(this.maxZ, p.z);
  }

  /** A box-built straight lane: floor, two side walls, optionally an end cap behind its start. */
  lane(from: V3, to: V3, o: { capStart?: boolean; capEnd?: boolean; width?: number; hue: number; floorTo?: number; fork?: Fork }) {
    const w = o.width ?? W;
    const dir = Math.sign(to.x - from.x);
    // The floor can stop short of the walls' end (a drop: the marbles fall through the gap).
    const floorEnd = o.floorTo !== undefined ? v3(lerp(from.x, to.x, o.floorTo), lerp(from.y, to.y, o.floorTo), from.z) : to;
    const f = o.fork;
    const at = (d: number) => {
      const x = from.x + dir * d;
      return v3(x, floorAt(from, x), from.z);
    };
    const shift = (p: V3, dz: number) => v3(p.x, p.y, p.z + dz);
    if (!f) plank(this.sim, from, floorEnd, w + 2 * T, T, 'paint', 'glass', 'floor', o.hue);
    else {
      // Full width up to the hole; then only the far half (the hole's side has no floor from there:
      // through the hole, and beyond it the half is closed off).
      plank(this.sim, from, at(f.d0), w + 2 * T, T, 'paint', 'glass', 'floor', o.hue);
      const dz = -f.side * (w / 4 + T / 2);
      plank(this.sim, shift(at(f.d0), dz), shift(floorEnd, dz), w / 2 + T, T, 'paint', 'glass', 'floor', o.hue);
    }
    for (const side of [-1, 1]) {
      const z = from.z + side * (w / 2 + T / 2);
      // On a fork, the hole's side wall stops at the hole's far end.
      const end = f && side === f.side ? at(f.d1) : to;
      plank(this.sim, v3(from.x, from.y + WALL_H, z), v3(end.x, end.y + WALL_H, z), T, WALL_H + T, 'glass', 'glass', 'wall');
    }
    if (f) {
      // The divider down the middle, with a rounded nose at the split, a post just before it to
      // scatter the marbles (which way each goes is luck), and a stop across the hole's far end.
      const a = at(f.split);
      plank(this.sim, v3(a.x, a.y + WALL_H, from.z), v3(to.x, to.y + WALL_H, from.z), T, WALL_H + T, 'glass', 'glass', 'wall');
      this.peg(a, 0.005);
      const sc = at(f.split - 0.045);
      this.peg(v3(sc.x, sc.y, from.z + this.rng.range(-0.012, 0.012)), 0.0035);
      const e = at(f.d1);
      this.sim.addStatic({ shape: { kind: 'box', hx: T / 2, hy: (WALL_H + T) / 2, hz: w / 4 + T / 2 }, finish: 'glass', pos: v3(e.x + dir * (T / 2), e.y + (WALL_H - T) / 2, from.z + f.side * (w / 4 + T / 2)), rot: ID_Q }, 'glass', 'wall');
    }
    const cap = (p: V3) =>
      this.sim.addStatic({ shape: { kind: 'box', hx: T / 2, hy: (WALL_H + T) / 2, hz: w / 2 + T }, finish: 'glass', pos: v3(p.x, p.y + (WALL_H - T) / 2, p.z), rot: ID_Q }, 'glass', 'wall');
    if (o.capStart) cap(v3(from.x - dir * (T / 2), from.y, from.z));
    if (o.capEnd) cap(v3(to.x + dir * (T / 2), to.y, to.z));
    this.minX = Math.min(this.minX, from.x, to.x);
    this.maxX = Math.max(this.maxX, from.x, to.x);
    this.minZ = Math.min(this.minZ, from.z - w / 2);
    this.maxZ = Math.max(this.maxZ, from.z + w / 2);
  }

  /**
   * A banked trough round a vertical axis (a helix; half a turn is a hairpin): from angle a0 to a1
   * (radians, about +y; z = sin), dropping from y0 to y1 (floor height on the centre line). Banking
   * fades in and out so it meets flat lanes. A two-sided triangle mesh: floor, inner and outer walls.
   */
  trough(c: V3, a0: number, a1: number, y0: number, y1: number, hue: number) {
    this.turns.push({ c, a0, a1, y0, y1, hue });
    const span = Math.abs(a1 - a0);
    const n = Math.max(8, Math.ceil((span * RT) / 0.01));
    const across = 6;
    const pos: number[] = [];
    const idx: number[] = [];
    const bankMax = BANK;
    const rows: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const a = lerp(a0, a1, u);
      const ca = dm.cos(a);
      const sa = dm.sin(a);
      const y = lerp(y0, y1, u);
      // Bank up to the outside, fading in over the first and out over the last fifth.
      const fade = Math.min(1, u / 0.2, (1 - u) / 0.2);
      const bank = bankMax * fade;
      const row: number[] = [];
      const put = (r: number, h: number) => {
        row.push(pos.length / 3);
        pos.push(c.x + r * ca, h, c.z + r * sa);
      };
      // Inner wall top, then the floor from inside to outside, then the outer wall top (taller).
      const rIn = RT - W / 2;
      const rOut = RT + W / 2;
      const yIn = y - (W / 2) * bank;
      const yOut = y + (W / 2) * bank;
      put(rIn, yIn + WALL_H);
      for (let k = 0; k <= across; k++) put(lerp(rIn, rOut, k / across), lerp(yIn, yOut, k / across));
      put(rOut, yOut + OUTER_H);
      rows.push(row);
      this.minX = Math.min(this.minX, c.x + rOut * ca);
      this.maxX = Math.max(this.maxX, c.x + rOut * ca);
      this.minZ = Math.min(this.minZ, c.z + rOut * sa);
      this.maxZ = Math.max(this.maxZ, c.z + rOut * sa);
    }
    for (let i = 0; i < n; i++)
      for (let k = 0; k < rows[i].length - 1; k++) {
        const a = rows[i][k];
        const b = rows[i][k + 1];
        const d = rows[i + 1][k];
        const e = rows[i + 1][k + 1];
        idx.push(a, d, b, b, d, e);
      }
    // Inside is towards the centre line, a little above the floor, at the same angle round.
    orientMesh(pos, idx, (x, y, z) => {
      const dx = x - c.x;
      const dz = z - c.z;
      const r = Math.hypot(dx, dz) || 1;
      return v3(c.x + (dx / r) * RT, y + 0.012, c.z + (dz / r) * RT);
    });
    this.sim.addStatic({ shape: { kind: 'mesh', positions: new Float32Array(pos), indices: new Uint32Array(idx), flags: SMOOTH }, finish: 'paint', hue, pos: v3(0, 0, 0), rot: ID_Q }, 'glass', 'floor');
    for (let i = 0; i <= n; i += 1) {
      const a = lerp(a0, a1, i / n);
      this.pass(v3(c.x + RT * dm.cos(a), lerp(y0, y1, i / n) + R, c.z + RT * dm.sin(a)));
    }
  }

  /**
   * A coin funnel (a lathe surface round a vertical axis) with a wall round its rim: marbles come in
   * along its rim, circle down and drop out of the hole. Returns the hole's centre.
   */
  funnel(c: V3, rTop: number, rHole: number, depth: number, hue: number, spout = SPOUT): V3 {
    this.funnels.push({ c, rTop, rHole, depth, spout, hue });
    const segs = 48;
    const rows = 8;
    const pos: number[] = [];
    const idx: number[] = [];
    const ring = (r: number, y: number) => {
      const base = pos.length / 3;
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        pos.push(c.x + r * dm.cos(a), y, c.z + r * dm.sin(a));
      }
      return base;
    };
    const rings: number[] = [];
    for (let j = 0; j <= rows; j++) {
      const u = j / rows;
      // Flared like a real coin funnel: steep near the hole, shallow at the rim.
      const r = rHole + (rTop - rHole) * u;
      const y = c.y - depth * (1 - u) ** 1.8;
      rings.push(ring(r, y));
    }
    // The rim wall.
    rings.push(ring(rTop, c.y + WALL_H));
    for (let j = 0; j < rings.length - 1; j++)
      for (let k = 0; k < segs; k++) {
        const a = rings[j] + k;
        const b = rings[j] + ((k + 1) % segs);
        idx.push(a, a + segs, b, b, a + segs, b + segs);
      }
    // A short spout under the hole: marbles leave the funnel whirling fast, and would fly clear
    // of the lane below without it. It takes their swirl and drops them straight down.
    const spoutBase = pos.length / 3;
    for (const y of [c.y - depth, c.y - depth - spout]) {
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        pos.push(c.x + rHole * dm.cos(a), y, c.z + rHole * dm.sin(a));
      }
    }
    for (let k = 0; k < segs; k++) {
      const a = spoutBase + k;
      const b2 = spoutBase + ((k + 1) % segs);
      idx.push(a, a + segs, b2, b2, a + segs, b2 + segs);
    }
    // Inside is up and in, towards the axis.
    orientMesh(pos, idx, (_x, y) => v3(c.x, y + 0.05, c.z));
    this.sim.addStatic({ shape: { kind: 'mesh', positions: new Float32Array(pos), indices: new Uint32Array(idx), flags: SMOOTH }, finish: 'paint', hue, pos: v3(0, 0, 0), rot: ID_Q }, 'glass', 'funnel');
    this.minX = Math.min(this.minX, c.x - rTop);
    this.maxX = Math.max(this.maxX, c.x + rTop);
    this.minZ = Math.min(this.minZ, c.z - rTop);
    this.maxZ = Math.max(this.maxZ, c.z + rTop);
    return v3(c.x, c.y - depth, c.z);
  }

  /**
   * A felt pad on a lane's floor where marbles land after a fall (from `at`, `len` along the lane
   * heading dir): it soaks up the drop, so they don't bounce out over the walls.
   */
  pad(at: V3, dir: number, len: number, lane: V3) {
    const x1 = at.x + dir * len;
    // Flush with the floor: a pad standing proud is a step a slow marble rolling onto it stalls at.
    const y0 = floorAt(lane, at.x) + 0.0002;
    const y1 = floorAt(lane, x1) + 0.0002;
    plank(this.sim, v3(at.x, y0, at.z), v3(x1, y1, at.z), W - 0.002, 0.003, 'felt', 'felt', 'pad');
  }

  /** Taller walls (and end stop) round where a funnel drops marbles onto a lane. */
  catchWalls(start: V3, dir: number, len: number) {
    const h = 0.03;
    const y = start.y + WALL_H + h / 2;
    for (const s of [-1, 1])
      this.sim.addStatic({ shape: { kind: 'box', hx: len / 2, hy: h / 2, hz: T / 2 }, finish: 'glass', pos: v3(start.x + dir * (len / 2), y, start.z + s * (W / 2 + T / 2)), rot: ID_Q }, 'glass', 'wall');
    this.sim.addStatic({ shape: { kind: 'box', hx: T / 2, hy: h / 2, hz: W / 2 + T }, finish: 'glass', pos: v3(start.x - dir * (T / 2), y, start.z), rot: ID_Q }, 'glass', 'wall');
  }

  /** A post a marble bounces off (axis vertical), standing on a lane floor. */
  peg(at: V3, r: number) {
    this.sim.addStatic({ shape: { kind: 'cylinder', r, hh: WALL_H / 2 }, finish: 'steel', pos: v3(at.x, at.y + WALL_H / 2, at.z), rot: ID_Q }, 'steel', 'peg');
  }
}

/**
 * Turn every triangle to face the inside of the track (the side marbles roll on): with internal
 * edges fixed, Rapier treats a mesh as one-sided. `inside` gives a point on the marbles' side for a
 * triangle's centre.
 */
function orientMesh(pos: number[], idx: number[], inside: (x: number, y: number, z: number) => V3) {
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const cx = (pos[a] + pos[b] + pos[c]) / 3, cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, cz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    const p = inside(cx, cy, cz);
    if (nx * (p.x - cx) + ny * (p.y - cy) + nz * (p.z - cz) < 0) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  }
}

/** Floor height along a lane from `from`, at x. */
const floorAt = (from: V3, x: number) => from.y - SLOPE * Math.abs(x - from.x);

export interface CourseOpts {
  sections: number;
  lanesPerSection: number;
  density: number;
  spinnerSpeed: number;
  /** Elimination mode: a gate across the lane after every checkpoint line but the last. */
  gates: boolean;
  marbles: number;
  /** Which contraptions may appear, and how often (tests: one at a time, in every section). */
  specials?: Connector[];
  specialChance?: number;
}

/**
 * Build the whole course into the sim. Sections each get a kind (no two in a row alike), which
 * decides their lanes' obstacles and how their lanes join; every section after the first starts
 * on a fresh lane with its checkpoint line (and gate) near the lane's start.
 */
export function buildCourse(sim: Sim, rng: Rng, o: CourseOpts): Course {
  const b = new Builder(sim, rng);
  const sections: Section[] = [];
  const lanes: Course['lanes'] = [];
  const lines: Course['lines'] = [];
  const gates: Gate[] = [];
  const spinners: Spinner[] = [];
  const kinds: SectionKind[] = [];
  for (let i = 0; i < o.sections; i++) {
    const options = SECTION_KINDS.filter((k) => k !== kinds[i - 1]);
    kinds.push(rng.pick(options));
  }

  // The start box: a level-ish lane with the grid behind a gate.
  const rows = Math.ceil(o.marbles / 4);
  const boxLen = 0.03 + rows * R * 2.3;
  let cur: Cursor = { at: v3(-XL, 0, 0), dir: 1, cap: true };
  const grid: V3[] = [];
  const gateX = -XL + boxLen;
  for (let i = 0; i < o.marbles; i++) {
    const row = Math.floor(i / 4);
    const col = i % 4;
    const inRow = Math.min(4, o.marbles - row * 4);
    const x = gateX - 0.006 - R - row * R * 2.3;
    grid.push(v3(x, floorAt(cur.at, x) + R + 0.0005, (col - (inRow - 1) / 2) * R * 2.35 + rng.range(-0.001, 0.001)));
  }
  const gateBar = (at: V3): Gate => {
    const body = sim.addBody(
      v3(at.x, at.y + WALL_H / 2, at.z),
      ID_Q,
      [{ piece: { shape: { kind: 'box', hx: 0.003, hy: WALL_H / 2, hz: W / 2 }, finish: 'paint', hue: -1, pos: v3(0, 0, 0), rot: ID_Q }, material: 'glass', tag: 'gate' }],
      { kinematic: true },
    );
    return { body, at: v3(at.x, at.y + WALL_H / 2, at.z), openAt: null };
  };
  const startGate = gateBar(v3(gateX + 0.003, floorAt(cur.at, gateX), 0));
  b.path.push(v3(-XL, R, 0));

  // The contraptions on offer. An elevator's catch tray can't take a big crowd (they pile two deep
  // and wedge against the slats), so big fields go without.
  const specials = (o.specials ?? SPECIALS).filter((c) => c !== 'lift' || o.marbles <= LIFT_MAX_MARBLES || o.specials);
  for (let si = 0; si < o.sections; si++) {
    const kind = kinds[si];
    const hue = o.sections > 1 ? si / (o.sections - 1) : 0;
    const s0 = pathLength(b.path);
    let forked = false;
    let special = false;
    for (let li = 0; li < o.lanesPerSection; li++) {
      const last = si === o.sections - 1 && li === o.lanesPerSection - 1;
      const from = cur.at;
      const endX = cur.dir * XL;
      const to = v3(endX, floorAt(from, endX), from.z);
      // How this lane joins the next (the last one ends in the finish tray).
      let conn: Connector = 'drop';
      if (!last) {
        if (kind === 'funnel' && li === 0) conn = 'funnel';
        else if (kind === 'helix' && li === 0) conn = 'helix';
        // Now and then a contraption (one a section at most, never off the start lane).
        else if (!special && !(si === 0 && li === 0) && specials.length && rng.chance(o.specialChance ?? SPECIAL_CHANCE)) conn = rng.pick(specials);
        else conn = rng.chance(0.35) ? 'hairpin' : 'drop';
        // Turns step sideways in z: keep the tower within reach of the camera.
        if (conn === 'hairpin' && Math.abs(from.z) > 0.16) conn = 'drop';
      }
      // Settle the join first (keeping the next lane in view): the lane's end depends on it.
      const join = last ? null : chooseJoin(b, conn, from, to, cur.dir, hue, cur.deep ?? 0);
      if (join) conn = join.conn;
      if (SPECIALS.includes(conn)) special = true;
      // A fork now and then, on a plain lane that drops to the next: one way round is a shortcut
      // through a hole halfway along, and which marbles get it is luck. Not on the start lane (the
      // pack is bunched), a gated lane (the queue), or a lane with obstacles; one per section at most.
      const run0 = Math.abs(to.x - from.x);
      let fork: Fork | undefined;
      if (conn === 'drop' && !last && !(si === 0 && li === 0) && !(li === 0 && si > 0 && o.gates) && kind !== 'pegs' && kind !== 'spinners' && !forked && rng.chance(FORK_CHANCE)) {
        const d0 = run0 * rng.range(0.45, 0.58);
        // The hole is on the camera's side, so the shortcut is always in view.
        fork = { split: d0 - 0.06, d0, d1: d0 + 0.06, side: 1 };
        forked = true;
      }
      // A drop's floor stops short of the lane's end stop: the marbles fall through the gap.
      const gap = R * 2 + 0.012;
      const dropping = (conn === 'drop' || conn === 'lift') && !last;
      // How far short of the lane's end its floor stops: a drop's gap, a trapdoor's flap, a jump's kicker.
      const short = last ? 0 : dropping ? gap : conn === 'trapdoor' ? FLAP_LEN : conn === 'jump' ? KICKER_LEN : 0;
      const capEnd = last || dropping;
      b.lane(from, to, { capStart: cur.cap, capEnd, hue, floorTo: short ? 1 - short / Math.abs(to.x - from.x) : undefined, fork });
      b.pass(v3(from.x, from.y + R, from.z));
      const laneS0 = pathLength(b.path);
      let obstacles = false;
      // A checkpoint line (and the round's gate) near the start of each section after the first.
      if (li === 0 && si > 0) {
        const lx = from.x + cur.dir * 0.04;
        lines.push({ at: v3(lx, floorAt(from, lx), from.z), dir: cur.dir, s: pathLength(b.path) + 0.04 });
        if (o.gates) {
          const gx = from.x + cur.dir * 0.2;
          gates.push(gateBar(v3(gx, floorAt(from, gx), from.z)));
        }
      }
      // Obstacles along the lane (kept clear of its first 0.25 m in gated lanes: the queue waits there).
      // The start lane stays clear (the whole pack is still bunched there: obstacles jam it solid),
      // and so does the queue in front of a round's gate.
      const clearFrom = si === 0 && li === 0 ? Infinity : li === 0 && si > 0 && o.gates ? 0.24 : 0.07;
      const run = Math.abs(to.x - from.x);
      // Obstacles stay clear of a trapdoor's flap and a jump's run-up.
      const endClear = conn === 'trapdoor' || conn === 'jump' ? 0.13 : 0.05;
      if (kind === 'pegs') {
        // Rows in turn: middle, one wall, middle, pair, middle, the other wall: a peg in the middle,
        // a pair either side of it, and a peg close to each wall in turn, so a marble riding a wall
        // out of a turn can't slip past every row. Wall pegs only ever neighbour middle pegs, and no row
        // narrows the lane from both sides: every gap, straight or diagonal, is two to three
        // marbles wide, so a crowd on this gentle slope can't wedge across one.
        const gap = 0.05 / Math.sqrt(o.density);
        let row = rng.int(0, 5);
        for (let d = clearFrom; d < run - endClear; d += gap, row++) {
          const x = from.x + cur.dir * d;
          const y = floorAt(from, x);
          obstacles = true;
          const phase = row % 6;
          if (phase % 2 === 0) b.peg(v3(x, y, from.z + rng.range(-0.004, 0.004)), 0.0035);
          else if (phase === 3) for (const s of [-1, 1]) b.peg(v3(x, y, from.z + s * 0.0225), 0.0035);
          else b.peg(v3(x, y, from.z + (phase === 1 ? -1 : 1) * (W / 2 - 0.0085)), 0.0035);
        }
      } else if (kind === 'spinners' && run - clearFrom > 0.12) {
        // At least two to a lane: a marble can time its way past one.
        const count = Math.max(2, Math.round(((run - clearFrom) / 0.11) * o.density * 0.8));
        for (let k = 0; k < count; k++) {
          const d = lerp(clearFrom + 0.04, run - endClear, count === 1 ? 0.5 : k / (count - 1));
          const x = from.x + cur.dir * d;
          const at = v3(x, floorAt(from, x) + 0.008, from.z);
          // A bar a little shorter than the lane is wide (a marble fits past its end at the wall; one
          // reaching the walls holds marbles back, its upstream-moving end sweeping them up the lane
          // again and again). Wall-riders are steered into its reach by a post on each wall just
          // before it.
          const half = W / 2 - R * 2 - 0.004;
          const px = from.x + cur.dir * (d - 0.035);
          for (const side of [-1, 1]) b.peg(v3(px, floorAt(from, px), from.z + side * (W / 2 - 0.0085)), 0.0035);
          const body = sim.addBody(at, ID_Q, [{ piece: { shape: { kind: 'box', hx: half, hy: 0.008, hz: 0.0025 }, finish: 'paint', hue: -1, pos: v3(0, 0, 0), rot: ID_Q }, material: 'glass', tag: 'spinner' }], { kinematic: true });
          obstacles = true;
          spinners.push({ body, at, omega: o.spinnerSpeed * rng.range(0.8, 1.2) * (rng.chance(0.5) ? 1 : -1), phase: rng.range(0, Math.PI) });
          b.peg(v3(x, at.y - 0.008, from.z), 0.005);
        }
      }
      // The centre line runs to the lane's end (a drop: to the middle of the gap it falls through).
      const ex = dropping ? to.x - cur.dir * gap * 0.5 : conn === 'trapdoor' ? to.x - cur.dir * (FLAP_LEN / 2) : conn === 'jump' ? to.x - cur.dir * KICKER_LEN : to.x;
      b.pass(v3(ex, floorAt(from, ex) + R, to.z));
      lanes.push({ s0: laneS0, s1: pathLength(b.path), kind, obstacles, from, to, built: [sim.statics.length, b.turns.length, b.funnels.length], fork: !!fork });
      if (last) {
        // The finish line, a little before the end stop the marbles come to rest against.
        const fx = to.x - cur.dir * 0.09;
        lines.push({ at: v3(fx, floorAt(from, fx), from.z), dir: cur.dir, s: pathLength(b.path) - 0.09 });
        sections.push({ kind, s0, s1: lines[lines.length - 1].s, hue });
        return finish(b, { sections, lanes, lines, gates, spinners, grid, startGate, bottom: to.y });
      }
      cur = connect(b, join!.conn, to, cur.dir, hue, join!.side, join!.extra, join!.jitter, fork && { from, fork });
    }
    sections.push({ kind, s0, s1: pathLength(b.path), hue });
  }
  throw new Error('unreachable');
}

/** Elevators only in fields up to this size. */
const LIFT_MAX_MARBLES = 10;

/** The chance a lane gets a contraption join (at most one a section). */
const SPECIAL_CHANCE = 0.4;

/** The chance a lane that could fork does (at most one fork a section). */
const FORK_CHANCE = 0.45;

/** How far a lane may sit from z = 0 (toward the camera or away): the tower stays compact. */
const Z_LIMIT = 0.2;
/** A lane this much hidden (or less) counts as in view. */
const HIDDEN_OK = 0.08;

/**
 * Choose how to join a lane to the next, keeping the next lane in view: the tower is watched from the front and a little above,
 * so a lane placed behind solid track at about its own height disappears. Try the planned join
 * first; then the other way round in z, a deeper drop (drops and funnels), or (for a hairpin) a
 * plain drop instead,
 * rolling back every try (the lane it leaves from is built afterwards, to suit the join chosen).
 * Picks the first that leaves the next lane in view, else the best.
 */
interface Join {
  conn: Connector;
  side: 1 | -1;
  extra: number;
  jitter: number;
}

function chooseJoin(b: Builder, conn: Connector, from: V3, end: V3, dir: 1 | -1, hue: number, deep: number): Join {
  const rng = b.rng;
  const jitter = rng.range(0.004, 0.012);
  // Step towards the camera or away, whichever keeps the tower near z = 0.
  const prefer: 1 | -1 = end.z > 0.02 ? -1 : end.z < -0.02 ? 1 : rng.chance(0.5) ? 1 : -1;
  const step = conn === 'funnel' ? 0.095 : 2 * RT;
  const tries: Join[] = [];
  // Turns can't drop further (steeper, they fling marbles over their outer wall): they only try the
  // other way round; drops and funnels can drop the next lane deeper.
  // (A lane whose start reaches deep below it, an elevator's, needs every drop-like join from it to
  // clear that first.)
  const turn = conn === 'hairpin' || conn === 'helix';
  const sideways = turn || conn === 'funnel';
  const extras = (turn ? [0] : [0, 0.025, 0.05]).map((e) => (turn ? e : e + deep));
  for (const extra of extras)
    for (const side of sideways ? [prefer, -prefer as 1 | -1] : [prefer])
      if (!sideways || Math.abs(end.z + side * step) <= Z_LIMIT) tries.push({ conn, side, extra, jitter });
  // A hairpin that can't be seen becomes a drop; a contraption that can't, too.
  if (conn === 'hairpin' || SPECIALS.includes(conn)) for (const extra of [0, 0.025, 0.05]) tries.push({ conn: 'drop', side: prefer, extra: extra + deep, jitter });
  let best = { i: 0, hidden: Infinity };
  for (let i = 0; i < tries.length; i++) {
    const mark = b.sim.mark();
    const saved = b.save();
    const t = tries[i];
    // The lane we're leaving from (its floor: it may be what hides the next one), then the join.
    plank(b.sim, from, end, W + 2 * T, T, 'paint', 'glass', 'floor', hue);
    const next = connect(b, t.conn, end, dir, hue, t.side, t.extra, t.jitter);
    const ex = next.dir * XL;
    // (The join itself can cover the start of the lane it feeds, which is fine: a funnel's bowl
    // over its catch lane, a helix's upper turns over the lane it winds down into. The marble is
    // only out of sight behind its own track for a moment. That doesn't count against the lane.)
    const funnels = t.conn === 'funnel' || t.conn === 'jump' ? b.funnels.slice(0, -1) : b.funnels;
    const turns = t.conn === 'helix' || t.conn === 'hairpin' ? b.turns.slice(0, -1) : b.turns;
    const nextEnd = v3(ex, floorAt(next.at, ex), next.at.z);
    // A next lane that would run into track already built (or into what a moving part sweeps) is
    // out, however visible.
    const hidden = runsInto(b, mark.statics, saved, next.at, nextEnd) || joinCollides(b, mark.statics, saved) ? 1 : hiddenShare(occluders(b.sim.statics, turns, funnels), next.at, nextEnd);
    b.sim.rollback(mark);
    b.restore(saved);
    if (hidden <= HIDDEN_OK) return t;
    if (hidden < best.hidden) best = { i, hidden };
  }
  return tries[best.i];
}

/**
 * Does the join just built (its turns, funnels, static pieces and moving parts' space: everything
 * after `before`/`statics`) run into track built earlier? Turns and funnels are tested by points
 * through their solid parts; plates and planks by their boxes.
 */
function joinCollides(b: Builder, statics: number, before: ReturnType<Builder['save']>): boolean {
  const old: Box[] = [];
  for (let i = 0; i < statics; i++) {
    const box = boxOf(b.sim.statics[i]);
    if (box) old.push(box);
  }
  const oldFunnels = b.funnels.slice(0, before.funnels);
  const reserved = b.reserved.slice(0, before.reserved);
  const solid = (x: number, y: number, z: number) =>
    old.some((o) => x >= o.lo.x && x <= o.hi.x && y >= o.lo.y && y <= o.hi.y && z >= o.lo.z && z <= o.hi.z && inBox(o, x, y, z)) ||
    reserved.some((r) => x > r.lo.x && x < r.hi.x && y > r.lo.y && y < r.hi.y && z > r.lo.z && z < r.hi.z) ||
    oldFunnels.some((f) => Math.hypot(x - f.c.x, z - f.c.z) < f.rTop + T && y > f.c.y - f.depth - f.spout && y < f.c.y + WALL_H);
  // New turns: points across each cross-section, every few degrees along.
  for (const t of b.turns.slice(before.turns)) {
    const n = Math.ceil(Math.abs(t.a1 - t.a0) / 0.09);
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const a = t.a0 + (t.a1 - t.a0) * u;
      const fy = t.y0 + (t.y1 - t.y0) * u;
      for (let r = RT - W / 2; r <= RT + W / 2 + 1e-9; r += W / 5)
        for (let h = -T + 0.001; h <= OUTER_H; h += 0.01) if (solid(t.c.x + r * dm.cos(a), fy + h, t.c.z + r * dm.sin(a))) return true;
    }
  }
  // New funnels: points through the bowl and up its rim wall.
  for (const f of b.funnels.slice(before.funnels))
    for (let r = f.rHole; r <= f.rTop + 1e-9; r += (f.rTop - f.rHole) / 6)
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const u = (r - f.rHole) / (f.rTop - f.rHole);
        const sy = f.c.y - f.depth * (1 - u) ** 1.8;
        for (const h of [-T + 0.001, 0, u > 0.95 ? WALL_H * 0.9 : 0.004]) if (solid(f.c.x + r * dm.cos(a), sy + h, f.c.z + r * dm.sin(a))) return true;
      }
  // New pieces and moving parts' space: their boxes (a little inset) against the old ones.
  const inset = (lo: V3, hi: V3, m = 0.002) => ({ lo: v3(lo.x + m, lo.y + m, lo.z + m), hi: v3(hi.x - m, hi.y - m, hi.z - m) });
  const fresh: { lo: V3; hi: V3 }[] = [];
  // (From one past `statics`: the first piece after it is the trial floor of the lane being left,
  // which sits on its own landing pad.)
  for (let i = statics + 1; i < b.sim.statics.length; i++) {
    const box = boxOf(b.sim.statics[i]);
    if (box) fresh.push(inset(box.lo, box.hi));
  }
  for (const r of b.reserved.slice(before.reserved)) fresh.push(inset(r.lo, r.hi));
  const overlap = (a: { lo: V3; hi: V3 }, c: { lo: V3; hi: V3 }) => a.lo.x < c.hi.x && a.hi.x > c.lo.x && a.lo.y < c.hi.y && a.hi.y > c.lo.y && a.lo.z < c.hi.z && a.hi.z > c.lo.z;
  for (const f of fresh) if (old.some((o) => overlap(f, o)) || reserved.some((r) => overlap(f, r))) return true;
  return false;
}

/**
 * Would a lane from `from` to `to` run into track built before this join (`statics` pieces, and
 * the turns, funnels and moving parts' space recorded in `before`)?
 */
function runsInto(b: Builder, statics: number, before: ReturnType<Builder['save']>, from: V3, to: V3): boolean {
  const m = 0.002;
  const lo = v3(Math.min(from.x, to.x) + m, Math.min(from.y, to.y) - T + m, from.z - W / 2 - T + m);
  const hi = v3(Math.max(from.x, to.x) - m, Math.max(from.y, to.y) + WALL_H - m, from.z + W / 2 + T - m);
  const hit = (a: { lo: V3; hi: V3 }) => a.lo.x < hi.x && a.hi.x > lo.x && a.lo.y < hi.y && a.hi.y > lo.y && a.lo.z < hi.z && a.hi.z > lo.z;
  for (let i = 0; i < statics; i++) {
    const p = b.sim.statics[i];
    const box = boxOf(p);
    if (box && hit(box)) return true;
  }
  for (let i = 0; i < before.turns; i++) {
    const t = b.turns[i];
    const r = RT + W / 2 + T;
    if (hit({ lo: v3(t.c.x - r, Math.min(t.y0, t.y1) - T, t.c.z - r), hi: v3(t.c.x + r, Math.max(t.y0, t.y1) + OUTER_H, t.c.z + r) })) return true;
  }
  for (let i = 0; i < before.funnels; i++) {
    const f = b.funnels[i];
    const r = f.rTop + T;
    if (hit({ lo: v3(f.c.x - r, f.c.y - f.depth - f.spout, f.c.z - r), hi: v3(f.c.x + r, f.c.y + WALL_H, f.c.z + r) })) return true;
  }
  for (let i = 0; i < before.reserved; i++) if (hit(b.reserved[i])) return true;
  return false;
}

/**
 * Join a lane ending at `end` (heading dir) to the next lane's start; returns that start. `side`
 * picks the way a turn or funnel steps in z (toward the camera, +1, or away); `extra` drops the
 * next lane further (to bring it out from behind track in front of it).
 */
function connect(b: Builder, conn: Connector, end: V3, dir: 1 | -1, hue: number, side: 1 | -1, extra = 0, jitter = 0.008, fork?: { from: V3; fork: Fork }): Cursor {
  switch (conn) {
    case 'drop': {
      // Through the gap at the lane's end onto the lane below, which runs back the other way. The
      // fall is boxed in (side plates and the end stop reach down to the lower lane's walls), so a
      // marble shoved sideways in a crowd can't squeeze out between the two lanes.
      const y = end.y - CLEAR - jitter - extra;
      const start = v3(end.x - dir * 0.004, y, end.z);
      const top = end.y - T + 0.002;
      const bottom = y + WALL_H - 0.004;
      // The longer the fall, the higher a marble can bounce on landing: the plates reach further along.
      const reach = R * 2 + 0.024 + Math.max(0, end.y - y - 0.09) * 0.6;
      const mid = (top + bottom) / 2;
      const hh = (top - bottom) / 2;
      for (const s of [-1, 1])
        b.sim.addStatic({ shape: { kind: 'box', hx: reach / 2, hy: hh, hz: T / 2 }, finish: 'glass', pos: v3(end.x - dir * (reach / 2), mid, end.z + s * (W / 2 + T / 2)), rot: ID_Q }, 'glass', 'wall');
      b.sim.addStatic({ shape: { kind: 'box', hx: T / 2, hy: hh, hz: W / 2 + T }, finish: 'glass', pos: v3(end.x + dir * (T / 2), mid, end.z), rot: ID_Q }, 'glass', 'wall');
      b.pad(start, -dir, reach + 0.01, start);
      if (fork) {
        // The fork's shortcut lands here too, mid-lane: a pad to land on, and a plate closing the
        // open side between the two lanes so a bouncing marble stays in.
        const f = fork.fork;
        // (Well past the hole's far end: a fast marble carries on forward as it falls, and lands there.)
        const x0 = fork.from.x + dir * (f.d0 - 0.01);
        const x1 = fork.from.x + dir * (f.d1 + 0.09);
        const xm = (x0 + x1) / 2;
        const len = Math.abs(x1 - x0);
        const top2 = floorAt(fork.from, xm) - T + 0.002;
        const bot2 = floorAt(start, xm) + WALL_H - 0.004;
        b.sim.addStatic({ shape: { kind: 'box', hx: len / 2, hy: (top2 - bot2) / 2, hz: T / 2 }, finish: 'glass', pos: v3(xm, (top2 + bot2) / 2, end.z + f.side * (W / 2 + T / 2)), rot: ID_Q }, 'glass', 'wall');
        b.pad(v3(x0, y, end.z), dir, len, start);
      }
      b.pass(v3(start.x - dir * (R + 0.008), y + R, end.z));
      return { at: start, dir: (-dir) as 1 | -1, cap: true };
    }
    case 'trapdoor':
      return trapdoor(b, end, dir, hue, extra, jitter);
    case 'wheel':
      return paddleWheel(b, end, dir, hue, extra);
    case 'jump':
      return jump(b, end, dir, hue, extra);
    case 'lift':
      return lift(b, end, dir, hue, extra, jitter);
    case 'hairpin':
    case 'helix': {
      // Round a vertical axis beside the lane's end: half a turn (hairpin), or one and a half
      // (helix, its turns stacked with room between), coming out the other way, one row over.
      const turns = conn === 'hairpin' ? 0.5 : 1.5;
      const c = v3(end.x, 0, end.z + side * RT);
      // Angle of the lane end as seen from the axis, and the way round that heads off along +dir.
      const a0 = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      const way = dir * side;
      const a1 = a0 + way * turns * Math.PI * 2;
      const drop = (conn === 'hairpin' ? 0.012 : turns * HELIX_PITCH) + extra;
      const y0 = end.y - 0.002;
      const y1 = y0 - drop;
      b.trough(c, a0, a1, y0, y1, hue);
      const z1 = end.z + side * 2 * RT;
      return { at: v3(end.x, y1 - 0.002, z1), dir: (-dir) as 1 | -1, cap: false };
    }
    case 'funnel': {
      // Off the lane's end onto a funnel's rim (along it, so the marbles circle), out of its
      // hole and onto a lane below that heads back. The funnel sits to one side of the lane, so
      // the lane enters it near the rim.
      // Big enough to take the whole lane's width, with its inner edge well clear of the hole.
      const offset = 0.095;
      const rTop = offset + W / 2 + R + 0.004;
      // Wide: a pack arriving together drains without bridging over the hole (a narrow hole
      // jams solid under a crowd).
      const rHole = R * 2.6;
      const depth = 0.07;
      const rimY = end.y - T - 0.006 - WALL_H;
      const cz = end.z + side * offset;
      const c = v3(end.x - dir * 0.0, rimY, cz);
      // (A catch lane set deeper than usual gets a longer spout: an open fall below it lets marbles
      // bounce out sideways.)
      const hole = b.funnel(c, rTop, rHole, depth, hue, SPOUT + extra);
      // The centre line circles in (about two turns) from the rim to the hole.
      const a0 = dm.atan2(end.z - cz, 0);
      const way = -dir * Math.sign(end.z - cz);
      const n = 48;
      for (let i = 1; i <= n; i++) {
        const u = i / n;
        const a = a0 + way * u * Math.PI * 4;
        const r = lerp(offset, rHole, u);
        const y = c.y - depth * (1 - (r - rHole) / (rTop - rHole)) ** 1.8 + R;
        b.pass(v3(c.x + r * dm.cos(a), y, c.z + r * dm.sin(a)));
      }
      const y = hole.y - SPOUT - extra - 0.004 - WALL_H;
      // The next lane starts just behind the hole (capped), so everything falling through lands on it.
      const start = v3(hole.x + dir * (rHole + 0.012), y, hole.z);
      b.pad(start, -dir, rHole * 2 + 0.03, start);
      b.catchWalls(start, -dir, rHole * 2 + 0.04);
      b.pass(v3(hole.x, y + R, hole.z));
      return { at: start, dir: (-dir) as 1 | -1, cap: true };
    }
  }
}

// ---- Contraptions ---------------------------------------------------------------------------------

const Z = v3(0, 0, 1);
/** A glass marble's mass (the trapdoor is balanced against them). */
const MARBLE_MASS = 2500 * ((4 / 3) * Math.PI * R ** 3);
/** The lane floor's tilt, as an angle. */
const SLOPE_ANGLE = dm.atan(SLOPE);
/** Trapdoor flap length (along the lane), and how many marbles' weight it takes to tip it. */
export const FLAP_LEN = 0.06;
const FLAP_TIP_MARBLES = 3;
const FLAP_OPEN = 1.0;
/** The clear gap between a trapdoor's tip and the end plate beyond it. */
const TRAP_GAP = 0.03;

/** Side plates closing a fall between two lanes (from x0 to x1), so a bouncing marble stays in. */
function boxIn(b: Builder, x0: number, x1: number, top: number, bottom: number, z: number) {
  const len = Math.abs(x1 - x0);
  for (const s of [-1, 1])
    b.sim.addStatic({ shape: { kind: 'box', hx: len / 2, hy: (top - bottom) / 2, hz: T / 2 }, finish: 'glass', pos: v3((x0 + x1) / 2, (top + bottom) / 2, z + s * (W / 2 + T / 2)), rot: ID_Q }, 'glass', 'wall');
}

/** A cap across the lane at x, from `bottom` to `top`. */
function endPlate(b: Builder, x: number, top: number, bottom: number, z: number) {
  b.sim.addStatic({ shape: { kind: 'box', hx: T / 2, hy: (top - bottom) / 2, hz: W / 2 + T }, finish: 'glass', pos: v3(x, (top + bottom) / 2, z), rot: ID_Q }, 'glass', 'wall');
}

/**
 * A trapdoor in place of a drop's gap: a flap hinged at its upstream edge, held shut by a
 * counterweight hung below the floor, which tips when about three marbles sit on it and drops them to
 * the lane below. Once it has opened it stays open for the rest of the race (the race loop latches
 * it), so the marbles behind never wait. (A timer opens it if a small group never gets heavy enough.)
 */
function trapdoor(b: Builder, end: V3, dir: 1 | -1, hue: number, extra: number, jitter: number): Cursor {
  const y = end.y - CLEAR - jitter - extra;
  const start = v3(end.x - dir * 0.004, y, end.z);
  const hingeX = end.x - dir * FLAP_LEN;
  const mid = end.x - dir * (FLAP_LEN / 2);
  const tilt = -dir * SLOPE_ANGLE;
  const q = quatAxis(Z, tilt);
  // Flap (wood) and counterweight (lead, pass-through: it only adds weight behind the hinge).
  const flapMass = 650 * FLAP_LEN * T * (W - 0.002);
  const cwArm = 0.025;
  const lever = FLAP_LEN - R;
  const cwMass = (flapMass * (FLAP_LEN / 2) + FLAP_TIP_MARBLES * MARBLE_MASS * lever) / cwArm;
  const cw = { hx: 0.008, hy: 0.006, hz: 0.03 };
  // (Floor height upstream of the lane's end: the floor rises going back.)
  const up = (x: number) => end.y + SLOPE * Math.abs(x - end.x);
  const body = b.sim.addBody(v3(mid, up(mid) - T / 2, end.z), q, [
    { piece: { shape: { kind: 'box', hx: FLAP_LEN / 2 - 0.0008, hy: T / 2, hz: W / 2 - 0.001 }, finish: 'maple', hue, pos: v3(0, 0, 0), rot: ID_Q }, material: 'wood', tag: 'flap' },
    { piece: { shape: { kind: 'box', ...cw }, finish: 'steel', pos: v3(-dir * (FLAP_LEN / 2 + cwArm), -0.016, 0), rot: ID_Q }, material: 'steel', tag: 'weight', density: cwMass / (8 * cw.hx * cw.hy * cw.hz) },
  ], { angularDamping: 0.6 });
  const rb = b.sim.body(body);
  rb.collider(1).setSensor(true);
  rb.collider(1).setActiveEvents(RAPIER.ActiveEvents.NONE);
  // Hinged at the flap's upstream edge (at floor level). Rapier measures the angle from the bodies'
  // starting frames, so the limits run from the rest tilt (shut) to the open tilt.
  const pivot = v3(hingeX, up(hingeX) - T / 2, end.z);
  const open = -dir * FLAP_OPEN;
  b.sim.hinge(null, body, pivot, v3(-dir * (FLAP_LEN / 2), 0, 0), Z, [Math.min(tilt, tilt + open), Math.max(tilt, tilt + open)]);
  b.trapdoors.push({ body, rest: tilt, open: FLAP_OPEN, pivot, at: v3(mid, end.y, end.z), len: FLAP_LEN, dir });
  b.reserved.push({ lo: v3(Math.min(hingeX, end.x) - 0.04, end.y - 0.06, end.z - W / 2), hi: v3(Math.max(hingeX, end.x) + 0.04, end.y, end.z + W / 2) });
  // A stop rod across the lane at the flap's tip, at a marble's middle: it holds the marbles on the
  // flap; when the flap tips, they drop under it and out through the gap beyond (wider than a marble
  // from the start, so nothing can wedge as the flap swings).
  const stopY = end.y + R;
  b.sim.addStatic({ shape: { kind: 'capsule', r: 0.003, hh: W / 2 }, finish: 'steel', pos: v3(end.x + dir * 0.003, stopY, end.z), rot: quatAxis(v3(1, 0, 0), Math.PI / 2) }, 'steel', 'wall');
  const plateX = end.x + dir * (TRAP_GAP + T / 2);
  boxIn(b, hingeX - dir * 0.005, plateX, end.y + WALL_H, y + WALL_H - 0.004, end.z);
  // One plate from above the flap right down to the lower lane's floor (in place of the lower
  // lane's own end stop, whose top edge marbles coming off the flap could perch on).
  endPlate(b, plateX, end.y + WALL_H, y - T, end.z);
  b.pad(v3(plateX - dir * (T / 2), y, end.z), -dir, FLAP_LEN + TRAP_GAP, v3(plateX - dir * (T / 2), y, end.z));
  b.pass(v3(end.x + dir * (TRAP_GAP / 2), stopY - 0.02, end.z));
  b.pass(v3(end.x, y + R, end.z));
  return { at: v3(plateX - dir * (T / 2), y, end.z), dir: (-dir) as 1 | -1, cap: false };
}

/** Paddle wheel size. */
const WHEEL_R = 0.05;
const PADDLES = 6;

/**
 * A paddle wheel under the lane's end, free on its axle: marbles roll off onto its far side, their
 * weight turns it, and it carries them down and sweeps them on along the lane below.
 */
function paddleWheel(b: Builder, end: V3, dir: 1 | -1, hue: number, extra: number): Cursor {
  // The axle sits back under the lane by half a radius: marbles leaving the lane drop onto the
  // wheel's far side (off centre), so their weight always turns it.
  const axle = v3(end.x - dir * (WHEEL_R / 2), end.y - T - 0.004 - WHEEL_R, end.z);
  // The lane below runs under the wheel with room for a marble beneath its paddles (paddles reaching
  // the floor would pinch marbles there and jam).
  const y = axle.y - WHEEL_R - R * 2 - 0.006 - extra;
  const pieces: Parameters<Sim['addBody']>[2] = [];
  const toZ = quatAxis(v3(1, 0, 0), Math.PI / 2);
  pieces.push({ piece: { shape: { kind: 'cylinder', r: 0.007, hh: W / 2 - 0.002 }, finish: 'brass', hue, pos: v3(0, 0, 0), rot: toZ }, material: 'brass', tag: 'wheel' });
  for (let k = 0; k < PADDLES; k++) {
    const a = (k / PADDLES) * Math.PI * 2;
    const r = (0.007 + WHEEL_R) / 2;
    pieces.push({
      piece: { shape: { kind: 'box', hx: (WHEEL_R - 0.007) / 2, hy: 0.0015, hz: W / 2 - 0.0055 }, finish: 'brass', hue, pos: v3(dm.cos(a) * r, dm.sin(a) * r, 0), rot: quatAxis(Z, a) },
      material: 'wood',
      tag: 'wheel',
    });
  }
  // Side discs turn with it, keeping marbles in their pockets without rubbing on the walls.
  // (Clear of the side plates: touching them, they'd brake the wheel to a stop.)
  for (const s of [-1, 1]) pieces.push({ piece: { shape: { kind: 'cylinder', r: WHEEL_R, hh: 0.0012 }, finish: 'glass', pos: v3(0, 0, s * (W / 2 - 0.0042)), rot: toZ }, material: 'glass', tag: 'wheel' });
  const body = b.sim.addBody(axle, ID_Q, pieces, { angularDamping: 0.2, canSleep: false });
  b.reserved.push({ lo: v3(axle.x - WHEEL_R - 0.003, axle.y - WHEEL_R - 0.003, end.z - W / 2), hi: v3(axle.x + WHEEL_R + 0.003, axle.y + WHEEL_R + 0.003, end.z + W / 2) });
  b.sim.hinge(null, body, axle, v3(0, 0, 0), Z);
  // The lane below starts beyond the wheel (marbles flung off its rim land there) and runs back
  // under it; the whole drop is boxed in.
  // (The end plate stands a marble and more beyond the rim: any closer, a marble pinches between
  // them and jams the wheel.)
  const start = v3(axle.x + dir * (WHEEL_R + R * 2 + 0.012), y, end.z);
  boxIn(b, axle.x - dir * (WHEEL_R + 0.01), start.x, end.y + WALL_H, y + WALL_H - 0.004, end.z);
  endPlate(b, start.x + dir * (T / 2), end.y + WALL_H, y + WALL_H - 0.004, end.z);
  b.pad(start, -dir, WHEEL_R * 2 + 0.03, start);
  b.pass(v3(end.x + dir * 0.02, axle.y + WHEEL_R * 0.6, end.z));
  b.pass(v3(end.x - dir * 0.01, y + R, end.z));
  b.minX = Math.min(b.minX, start.x);
  b.maxX = Math.max(b.maxX, start.x);
  return { at: start, dir: (-dir) as 1 | -1, cap: true };
}

/** Jump: the launch's length (a dip, then a short flick up), the gap marbles must clear, the tray. */
export const KICKER_LEN = 0.042;
const DIP_LEN = 0.03;
const DIP_DROP = 0.016;
const FLICK_RISE = 0.004;
const JUMP_GAP = 0.03;
const TRAY_LEN = 0.08;
/** How far below the lip the landing tray sits: how far a marble flies (so whether it makes it) depends on its speed. */
const TRAY_DROP = 0.04;

/**
 * A jump: at the lane's end the floor dips (every marble picks up speed: none can stall), then
 * flicks up at the lip and throws the marbles over a gap onto a landing tray below, the fast way on.
 * Those that fall short drop into a small coin funnel under the gap and lose time circling in it
 * before it lets them out onto the same lane below.
 */
function jump(b: Builder, end: V3, dir: 1 | -1, hue: number, extra: number): Cursor {
  const p0 = v3(end.x - dir * KICKER_LEN, end.y + SLOPE * KICKER_LEN, end.z);
  const p1 = v3(end.x - dir * (KICKER_LEN - DIP_LEN), p0.y - DIP_DROP, end.z);
  const lip = v3(end.x, p1.y + FLICK_RISE, end.z);
  plank(b.sim, p0, p1, W + 2 * T, T, 'paint', 'glass', 'floor', hue);
  plank(b.sim, p1, lip, W + 2 * T, T, 'paint', 'glass', 'floor', hue);
  // The landing tray beyond the gap, closed at its far end; it drops its marbles through a gap onto
  // the lane below.
  const t0 = v3(end.x + dir * JUMP_GAP, lip.y - TRAY_DROP, end.z);
  const t1 = v3(t0.x + dir * TRAY_LEN, t0.y - SLOPE * TRAY_LEN, end.z);
  const gap = R * 2 + 0.012;
  b.lane(t0, t1, { capEnd: true, hue, floorTo: 1 - gap / TRAY_LEN });
  // The penalty funnel under the gap (its rim wall below the tray), and the lane below its spout.
  const rTop = W / 2 + 0.004;
  // (Its rim wall stays under the tray.)
  const fc = v3(end.x + dir * (JUMP_GAP / 2), t0.y - T - 0.004 - WALL_H, end.z);
  const hole = b.funnel(fc, rTop, R * 2.6, 0.03, hue, SPOUT + extra);
  const y = hole.y - SPOUT - extra - 0.004 - WALL_H;
  const start = v3(t1.x - dir * 0.004, y, end.z);
  // Everything from the kicker to the tray's end is boxed in down to the lane below.
  // (Over the funnel's whole footprint too: marbles leave its spout still swirling, any way round.)
  boxIn(b, fc.x - dir * (rTop + 0.01), t1.x, p0.y + WALL_H, y + WALL_H - 0.004, end.z);
  endPlate(b, t1.x + dir * (T / 2), t1.y - T, y + WALL_H - 0.004, end.z);
  b.pad(start, -dir, gap + 0.03, start);
  b.pad(v3(hole.x + dir * 0.03, y, end.z), -dir, 0.06, start);
  b.pass(v3(lip.x, lip.y + R, end.z));
  b.pass(v3(t0.x + dir * 0.01, t0.y + R, end.z));
  b.pass(v3(t1.x - dir * gap * 0.5, t1.y + R, end.z));
  b.pass(v3(start.x - dir * (R + 0.01), y + R, end.z));
  b.minX = Math.min(b.minX, t1.x);
  b.maxX = Math.max(b.maxX, t1.x);
  return { at: start, dir: (-dir) as 1 | -1, cap: true };
}

/** Stair elevator: slats, step height, slat width (one marble deep), top tilt, and how fast they cycle. */
const SLATS = 6;
const SLAT_STEP = 0.012;
const SLAT_W = R * 2 + 0.006;
const SLAT_TILT = 0.2;
export const LIFT_HALF_PERIOD = 0.45;

/**
 * An elevator: the lane below starts deeper than usual, and a stair lifter carries the marbles back
 * up to it. Alternate slats rise and fall in opposite phase; their tops tilt forward, so whenever a
 * slat is up and the next one down, the marbles on it roll across onto the next, one step higher.
 */
function lift(b: Builder, end: V3, dir: 1 | -1, hue: number, extra: number, jitter: number): Cursor {
  const back = (-dir) as 1 | -1;
  // Across one slat its tilted top drops this much; the slats' travel lets each hand over to the next.
  const drop = SLAT_W * Math.tan(SLAT_TILT);
  const amp = (SLAT_STEP + drop) / 2;
  const top = end.y - CLEAR - jitter - extra;
  // From the catch tray at the bottom to the lane at the top.
  const rise = (SLATS - 1) * SLAT_STEP + 2 * amp - drop;
  const yTray = top - rise - 0.002;
  const trayStart = v3(end.x - dir * 0.004, yTray, end.z);
  // Long enough for a group to land and spread out before the first slat.
  const trayLen = 0.05;
  const trayEnd = v3(trayStart.x + back * trayLen, yTray - 0.002, end.z);
  plank(b.sim, trayStart, trayEnd, W + 2 * T, T, 'paint', 'glass', 'floor', hue);
  endPlate(b, trayStart.x + dir * (T / 2), end.y - T + 0.002, yTray - T, end.z);
  b.pad(trayStart, back, trayLen - 0.004, trayStart);
  const bodies: number[] = [];
  const at: V3[] = [];
  const q = quatAxis(Z, dir * SLAT_TILT);
  const slatH = 0.05;
  for (let k = 0; k < SLATS; k++) {
    const x = trayEnd.x + back * (0.0006 + SLAT_W / 2 + k * (SLAT_W + 0.001));
    // Resting centre of the slat's top: the first, when down, sits just under the tray's edge.
    const restTop = yTray - 0.002 - 0.001 + amp - drop / 2 + k * SLAT_STEP;
    const c = v3(x, restTop - slatH / 2, end.z);
    const body = b.sim.addBody(c, q, [{ piece: { shape: { kind: 'box', hx: SLAT_W / 2, hy: slatH / 2, hz: W / 2 - 0.001 }, finish: 'maple', hue, pos: v3(0, 0, 0), rot: ID_Q }, material: 'wood', tag: 'slat' }], { kinematic: true });
    bodies.push(body);
    at.push(c);
  }
  b.lifts.push({ bodies, at, amp });
  {
    const xs = at.map((a) => a.x);
    b.reserved.push({ lo: v3(Math.min(...xs, trayStart.x) - SLAT_W, yTray - slatH - amp - 0.005, end.z - W / 2 - T), hi: v3(Math.max(...xs, trayStart.x) + SLAT_W, yTray + rise + WALL_H, end.z + W / 2 + T) });
  }
  const xTop = at[SLATS - 1].x + back * (SLAT_W / 2 + 0.0006);
  const startY = at[SLATS - 1].y + slatH / 2 + amp - drop / 2 - 0.001;
  // Walls either side of the whole lift, as tall as its top lane's walls.
  const wallTop = startY + WALL_H;
  boxIn(b, trayStart.x, xTop, Math.max(wallTop, end.y - T + 0.002), yTray - T, end.z);
  b.pass(v3(trayEnd.x, yTray + R, end.z));
  b.pass(v3(xTop, startY + R, end.z));
  // Its slats reach well below the tray: the next join down must clear their feet.
  return { at: v3(xTop, startY, end.z), dir: back, cap: false, deep: startY - (yTray - slatH - amp) + 0.01 };
}

function pathLength(p: V3[]) {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y, p[i].z - p[i - 1].z);
  return s;
}

function finish(b: Builder, c: Omit<Course, 'path' | 'dist' | 'tangent' | 'minX' | 'maxX' | 'minZ' | 'maxZ' | 'turns' | 'funnels' | 'trapdoors' | 'lifts'>): Course {
  const dist = [0];
  for (let i = 1; i < b.path.length; i++) {
    const p = b.path[i];
    const q = b.path[i - 1];
    dist.push(dist[i - 1] + Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
  }
  const tangent = b.path.map((p, i) => {
    const a = b.path[Math.max(0, i - 1)];
    const z = b.path[Math.min(b.path.length - 1, i + 1)];
    const d = Math.hypot(z.x - a.x, z.y - a.y, z.z - a.z) || 1;
    return v3((z.x - a.x) / d, (z.y - a.y) / d, (z.z - a.z) / d);
  });
  return { ...c, turns: b.turns, funnels: b.funnels, trapdoors: b.trapdoors, lifts: b.lifts, path: b.path, dist, tangent, minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
}

/** Nearest centre-line sample to p, searching from a hint (marbles only move along a little each frame). */
export function locate(course: Course, p: V3, hint: number, back = 12, ahead = 90): number {
  let best = hint;
  let bd = Infinity;
  const lo = Math.max(0, hint - back);
  const hi = Math.min(course.path.length - 1, hint + ahead);
  for (let i = lo; i <= hi; i++) {
    const q = course.path[i];
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2 * 4 + (p.z - q.z) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

export { quatAxis };
