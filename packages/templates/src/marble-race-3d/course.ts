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
import { hiddenShare, occluders } from './visibility';
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

export type Connector = 'drop' | 'hairpin' | 'helix' | 'funnel';
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
  lanes: { s0: number; s1: number; kind: SectionKind; obstacles: boolean; from: V3; to: V3; /** How much track existed when it was laid (statics, turns, funnels). */ built: [number, number, number] }[];
  /** Where each checkpoint line is drawn (point and lane direction): the start of each section after the first, then the finish. */
  lines: { at: V3; dir: number; s: number }[];
  /** Round gates (elimination mode), one per checkpoint except the finish. */
  gates: Gate[];
  spinners: Spinner[];
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

interface Cursor {
  /** Floor point at the lane start (centre of the lane). */
  at: V3;
  /** Direction of travel along x. */
  dir: 1 | -1;
  /** Marbles land on its start (a drop or a funnel), so it needs an end stop behind them. */
  cap: boolean;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

class Builder {
  path: V3[] = [];
  turns: TurnSpec[] = [];
  funnels: FunnelSpec[] = [];
  minX = Infinity;
  maxX = -Infinity;
  minZ = Infinity;
  maxZ = -Infinity;
  constructor(public sim: Sim, public rng: Rng) {}

  /** What a rollback has to undo besides the sim (see Sim.mark). */
  save() {
    return { path: this.path.length, turns: this.turns.length, funnels: this.funnels.length, bounds: [this.minX, this.maxX, this.minZ, this.maxZ] };
  }

  restore(m: ReturnType<Builder['save']>) {
    this.path.length = m.path;
    this.turns.length = m.turns;
    this.funnels.length = m.funnels;
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
  lane(from: V3, to: V3, o: { capStart?: boolean; capEnd?: boolean; width?: number; hue: number; floorTo?: number }) {
    const w = o.width ?? W;
    // The floor can stop short of the walls' end (a drop: the marbles fall through the gap).
    const floorEnd = o.floorTo !== undefined ? v3(lerp(from.x, to.x, o.floorTo), lerp(from.y, to.y, o.floorTo), from.z) : to;
    plank(this.sim, from, floorEnd, w + 2 * T, T, 'paint', 'glass', 'floor', o.hue);
    for (const side of [-1, 1]) {
      const z = from.z + side * (w / 2 + T / 2);
      plank(this.sim, v3(from.x, from.y + WALL_H, z), v3(to.x, to.y + WALL_H, z), T, WALL_H + T, 'glass', 'glass', 'wall');
    }
    const cap = (p: V3) =>
      this.sim.addStatic({ shape: { kind: 'box', hx: T / 2, hy: (WALL_H + T) / 2, hz: w / 2 + T }, finish: 'glass', pos: v3(p.x, p.y + (WALL_H - T) / 2, p.z), rot: ID_Q }, 'glass', 'wall');
    const dir = Math.sign(to.x - from.x);
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
  funnel(c: V3, rTop: number, rHole: number, depth: number, hue: number): V3 {
    this.funnels.push({ c, rTop, rHole, depth, spout: SPOUT, hue });
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
    for (const y of [c.y - depth, c.y - depth - SPOUT]) {
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
    const y0 = floorAt(lane, at.x) + 0.0015;
    const y1 = floorAt(lane, x1) + 0.0015;
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

  for (let si = 0; si < o.sections; si++) {
    const kind = kinds[si];
    const hue = o.sections > 1 ? si / (o.sections - 1) : 0;
    const s0 = pathLength(b.path);
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
        else conn = rng.chance(0.35) ? 'hairpin' : 'drop';
        // Turns step sideways in z: keep the tower within reach of the camera.
        if (conn === 'hairpin' && Math.abs(from.z) > 0.16) conn = 'drop';
      }
      // Settle the join first (keeping the next lane in view): the lane's end depends on it.
      const join = last ? null : chooseJoin(b, conn, from, to, cur.dir, hue);
      if (join) conn = join.conn;
      // A drop's floor stops short of the lane's end stop: the marbles fall through the gap.
      const gap = R * 2 + 0.012;
      const dropping = conn === 'drop' && !last;
      b.lane(from, to, { capStart: cur.cap, capEnd: conn === 'drop' || last, hue, floorTo: dropping ? 1 - gap / Math.abs(to.x - from.x) : undefined });
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
      if (kind === 'pegs') {
        // Rows in turn: middle, one wall, middle, pair, middle, the other wall: a peg in the middle,
        // a pair either side of it, and a peg close to each wall in turn, so a marble riding a wall
        // out of a turn can't slip past every row. Wall pegs only ever neighbour middle pegs, and no row
        // narrows the lane from both sides: every gap, straight or diagonal, is two to three
        // marbles wide, so a crowd on this gentle slope can't wedge across one.
        const gap = 0.05 / Math.sqrt(o.density);
        let row = rng.int(0, 5);
        for (let d = clearFrom; d < run - 0.05; d += gap, row++) {
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
          const d = lerp(clearFrom + 0.04, run - 0.05, count === 1 ? 0.5 : k / (count - 1));
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
      const ex = dropping ? to.x - cur.dir * gap * 0.5 : to.x;
      b.pass(v3(ex, floorAt(from, ex) + R, to.z));
      lanes.push({ s0: laneS0, s1: pathLength(b.path), kind, obstacles, from, to, built: [sim.statics.length, b.turns.length, b.funnels.length] });
      if (last) {
        // The finish line, a little before the end stop the marbles come to rest against.
        const fx = to.x - cur.dir * 0.09;
        lines.push({ at: v3(fx, floorAt(from, fx), from.z), dir: cur.dir, s: pathLength(b.path) - 0.09 });
        sections.push({ kind, s0, s1: lines[lines.length - 1].s, hue });
        return finish(b, { sections, lanes, lines, gates, spinners, grid, startGate, bottom: to.y });
      }
      cur = connect(b, join!.conn, to, cur.dir, hue, join!.side, join!.extra, join!.jitter);
    }
    sections.push({ kind, s0, s1: pathLength(b.path), hue });
  }
  throw new Error('unreachable');
}

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

function chooseJoin(b: Builder, conn: Connector, from: V3, end: V3, dir: 1 | -1, hue: number): Join {
  const rng = b.rng;
  const jitter = rng.range(0.004, 0.012);
  // Step towards the camera or away, whichever keeps the tower near z = 0.
  const prefer: 1 | -1 = end.z > 0.02 ? -1 : end.z < -0.02 ? 1 : rng.chance(0.5) ? 1 : -1;
  const step = conn === 'funnel' ? 0.095 : 2 * RT;
  const tries: Join[] = [];
  // Turns can't drop further (steeper, they fling marbles over their outer wall): they only try the
  // other way round; drops and funnels can drop the next lane deeper.
  const extras = conn === 'hairpin' || conn === 'helix' ? [0] : [0, 0.025, 0.05];
  for (const extra of extras)
    for (const side of conn === 'drop' ? [prefer] : [prefer, -prefer as 1 | -1])
      if (conn === 'drop' || Math.abs(end.z + side * step) <= Z_LIMIT) tries.push({ conn, side, extra, jitter });
  if (conn === 'hairpin') for (const extra of [0, 0.025, 0.05]) tries.push({ conn: 'drop', side: prefer, extra, jitter });
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
    const funnels = t.conn === 'funnel' ? b.funnels.slice(0, -1) : b.funnels;
    const turns = t.conn === 'helix' || t.conn === 'hairpin' ? b.turns.slice(0, -1) : b.turns;
    const hidden = hiddenShare(occluders(b.sim.statics, turns, funnels), next.at, v3(ex, floorAt(next.at, ex), next.at.z));
    b.sim.rollback(mark);
    b.restore(saved);
    if (hidden <= HIDDEN_OK) return t;
    if (hidden < best.hidden) best = { i, hidden };
  }
  return tries[best.i];
}

/**
 * Join a lane ending at `end` (heading dir) to the next lane's start; returns that start. `side`
 * picks the way a turn or funnel steps in z (toward the camera, +1, or away); `extra` drops the
 * next lane further (to bring it out from behind track in front of it).
 */
function connect(b: Builder, conn: Connector, end: V3, dir: 1 | -1, hue: number, side: 1 | -1, extra = 0, jitter = 0.008): Cursor {
  switch (conn) {
    case 'drop': {
      // Through the gap at the lane's end onto the lane below, which runs back the other way. The
      // fall is boxed in (side plates and the end stop reach down to the lower lane's walls), so a
      // marble shoved sideways in a crowd can't squeeze out between the two lanes.
      const y = end.y - CLEAR - jitter - extra;
      const start = v3(end.x - dir * 0.004, y, end.z);
      const top = end.y - T + 0.002;
      const bottom = y + WALL_H - 0.004;
      const reach = R * 2 + 0.024;
      const mid = (top + bottom) / 2;
      const hh = (top - bottom) / 2;
      for (const s of [-1, 1])
        b.sim.addStatic({ shape: { kind: 'box', hx: reach / 2, hy: hh, hz: T / 2 }, finish: 'glass', pos: v3(end.x - dir * (reach / 2), mid, end.z + s * (W / 2 + T / 2)), rot: ID_Q }, 'glass', 'wall');
      b.sim.addStatic({ shape: { kind: 'box', hx: T / 2, hy: hh, hz: W / 2 + T }, finish: 'glass', pos: v3(end.x + dir * (T / 2), mid, end.z), rot: ID_Q }, 'glass', 'wall');
      b.pad(start, -dir, reach + 0.01, start);
      b.pass(v3(start.x - dir * (R + 0.008), y + R, end.z));
      return { at: start, dir: (-dir) as 1 | -1, cap: true };
    }
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
      const hole = b.funnel(c, rTop, rHole, depth, hue);
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
      const y = hole.y - SPOUT - 0.004 - WALL_H - extra;
      // The next lane starts just behind the hole (capped), so everything falling through lands on it.
      const start = v3(hole.x + dir * (rHole + 0.012), y, hole.z);
      b.pad(start, -dir, rHole * 2 + 0.03, start);
      b.catchWalls(start, -dir, rHole * 2 + 0.04);
      b.pass(v3(hole.x, y + R, hole.z));
      return { at: start, dir: (-dir) as 1 | -1, cap: true };
    }
  }
}

function pathLength(p: V3[]) {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y, p[i].z - p[i - 1].z);
  return s;
}

function finish(b: Builder, c: Omit<Course, 'path' | 'dist' | 'tangent' | 'minX' | 'maxX' | 'minZ' | 'maxZ' | 'turns' | 'funnels'>): Course {
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
  return { ...c, turns: b.turns, funnels: b.funnels, path: b.path, dist, tangent, minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
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
