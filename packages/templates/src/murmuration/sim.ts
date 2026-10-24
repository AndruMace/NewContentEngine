import * as dm from '@sim/physics/math';
import type { Rng } from '@sim/engine';

/**
 * 3D boids. Each bird steers by three rules about its neighbours: separation (don't crowd them),
 * alignment (fly the way they fly) and cohesion (stay near them), plus fleeing predators and
 * turning back from the edges of the sky. Neighbours are either everyone within a radius or the k
 * nearest (real starlings track about seven, whatever the distance).
 *
 * Only + − × ÷ and sqrt (exact in every JS engine), so Node and the browser fly the same flock.
 */
export const WORLD = { w: 160, h: 230, d: 110 };
/** World seconds per tick. */
export const DT = 1 / 60;

/** How fear fades each tick, how much of it a bird passes on, how likely per tick, and how hard a frightened bird darts. */
const FEAR_FADE = 0.965;
const FEAR_PASS = 0.93;
const FEAR_CATCH = 0.3;
const FEAR_DART = 150;

/** Strength of each steering term (tuned so the defaults make one murmuration). */
export const TUNE = { sep: 45, align: 9, coh: 0.9, pull: 0.25, noise: 3 };

export interface Rules {
  separation: boolean;
  alignment: boolean;
  cohesion: boolean;
}

export interface FlockOpts {
  n: number;
  separation: number;
  alignment: number;
  cohesion: number;
  radius: number;
  /** 0 = everyone within the radius; else the k nearest. */
  neighbours: number;
  speed: number;
  /** How hard a bird can turn (acceleration limit, world units/s²). */
  agility: number;
}

/**
 * A hunter, as a peregrine hunts a murmuration: it circles high above the flock, picks a bird on the
 * edge nearest to it, stoops at it (tucked, two to three times the flock's speed), shoots past when
 * the flock opens around it, climbs back up on its speed, and circles for another try. In water (a
 * shark under a school) the same, level: it patrols round the school and lunges.
 */
export interface Predator {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mode: 'circle' | 'stoop' | 'climb';
  /** Ticks in the current mode, and how long to circle before the next stoop. */
  timer: number;
  wait: number;
  /** The bird it's stooping at. */
  target: number;
  /** Direction round the flock while circling (a unit vector in the level plane). */
  ox: number;
  oz: number;
  /** Level hunting (a shark): no climbing or stooping from above. */
  level: boolean;
}

const ROT = 0.009;
const ROT_C = dm.cos(ROT);
const ROT_S = dm.sin(ROT);

export interface Flock {
  o: FlockOpts;
  rules: Rules;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  vz: Float64Array;
  /** Last tick's positions, for drawing between ticks. */
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
  /** How sharply each bird turned this tick (picture only: lights up a turning wave). */
  turn: Float32Array;
  predators: Predator[];
  rng: Rng;
  /** Grid of bird indices by cell. */
  cell: number;
  heads: Int32Array;
  next: Int32Array;
  gx: number;
  gy: number;
  gz: number;
  /** Ticks a startled bird keeps its swerve. */
  startle: Int32Array;
  sdx: Float64Array;
  sdy: Float64Array;
  /**
   * Fear, 0..1: a bird that sees a predator close panics and darts away, and its neighbours catch
   * the panic (a moment later) and dart the same way, so a wave of escape runs through the flock.
   */
  fear: Float32Array;
  /** The way each frightened bird is escaping (a unit vector). */
  ex: Float64Array;
  ey: Float64Array;
  ez: Float64Array;
}

export function newFlock(rng: Rng, o: FlockOpts, scattered: boolean): Flock {
  const n = o.n;
  const f: Flock = {
    o,
    rules: { separation: false, alignment: false, cohesion: false },
    x: new Float64Array(n),
    y: new Float64Array(n),
    z: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    vz: new Float64Array(n),
    px: new Float64Array(n),
    py: new Float64Array(n),
    pz: new Float64Array(n),
    turn: new Float32Array(n),
    predators: [],
    rng,
    cell: Math.max(4, o.radius),
    heads: new Int32Array(0),
    next: new Int32Array(n),
    gx: 0,
    gy: 0,
    gz: 0,
    startle: new Int32Array(n),
    sdx: new Float64Array(n),
    sdy: new Float64Array(n),
    fear: new Float32Array(n),
    ex: new Float64Array(n),
    ey: new Float64Array(n),
    ez: new Float64Array(n),
  };
  f.gx = Math.ceil(WORLD.w / f.cell) + 1;
  f.gy = Math.ceil(WORLD.h / f.cell) + 1;
  f.gz = Math.ceil(WORLD.d / f.cell) + 1;
  f.heads = new Int32Array(f.gx * f.gy * f.gz);
  for (let i = 0; i < n; i++) {
    // Scattered over the sky (no rules yet), or already roughly together.
    const spread = scattered ? 1 : 0.45;
    f.x[i] = WORLD.w * (0.5 + (rng.next() - 0.5) * 0.85 * spread);
    f.y[i] = WORLD.h * (0.45 + (rng.next() - 0.5) * 0.7 * spread);
    f.z[i] = WORLD.d * (0.5 + (rng.next() - 0.5) * 0.8 * spread);
    let vx = rng.next() - 0.5;
    let vy = (rng.next() - 0.5) * 0.6;
    let vz = rng.next() - 0.5;
    const l = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    vx = (vx / l) * o.speed;
    vy = (vy / l) * o.speed;
    vz = (vz / l) * o.speed;
    f.vx[i] = vx;
    f.vy[i] = vy;
    f.vz[i] = vz;
  }
  f.px.set(f.x);
  f.py.set(f.y);
  f.pz.set(f.z);
  return f;
}

function rebuildGrid(f: Flock) {
  f.heads.fill(-1);
  for (let i = 0; i < f.o.n; i++) {
    const c = cellOf(f, f.x[i], f.y[i], f.z[i]);
    f.next[i] = f.heads[c];
    f.heads[c] = i;
  }
}

function cellOf(f: Flock, x: number, y: number, z: number) {
  const cx = Math.max(0, Math.min(f.gx - 1, Math.floor(x / f.cell)));
  const cy = Math.max(0, Math.min(f.gy - 1, Math.floor(y / f.cell)));
  const cz = Math.max(0, Math.min(f.gz - 1, Math.floor(z / f.cell)));
  return (cz * f.gy + cy) * f.gx + cx;
}

/** Visit every bird in the cells around a point (within `reach` cells). */
function around(f: Flock, x: number, y: number, z: number, reach: number, visit: (j: number) => void) {
  const cx = Math.floor(x / f.cell);
  const cy = Math.floor(y / f.cell);
  const cz = Math.floor(z / f.cell);
  for (let dz = -reach; dz <= reach; dz++) {
    const zz = cz + dz;
    if (zz < 0 || zz >= f.gz) continue;
    for (let dy = -reach; dy <= reach; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= f.gy) continue;
      for (let dx = -reach; dx <= reach; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= f.gx) continue;
        for (let j = f.heads[(zz * f.gy + yy) * f.gx + xx]; j >= 0; j = f.next[j]) visit(j);
      }
    }
  }
}

const K_MAX = 12;
const nIdx = new Int32Array(K_MAX);
const nD2 = new Float64Array(K_MAX);

/** The k nearest birds to bird i (within reach), into nIdx; returns how many. */
export function nearest(f: Flock, i: number, k: number): number {
  let count = 0;
  const x = f.x[i];
  const y = f.y[i];
  const z = f.z[i];
  // The cells next door first; further only if they don't hold k birds.
  let max2 = f.cell * f.cell;
  const visit = (j: number) => {
    if (j === i) return;
    const dx = f.x[j] - x;
    const dy = f.y[j] - y;
    const dz = f.z[j] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > max2) return;
    if (count < k) {
      let q = count++;
      while (q > 0 && nD2[q - 1] > d2) {
        nD2[q] = nD2[q - 1];
        nIdx[q] = nIdx[q - 1];
        q--;
      }
      nD2[q] = d2;
      nIdx[q] = j;
    } else if (d2 < nD2[k - 1]) {
      let q = k - 1;
      while (q > 0 && nD2[q - 1] > d2) {
        nD2[q] = nD2[q - 1];
        nIdx[q] = nIdx[q - 1];
        q--;
      }
      nD2[q] = d2;
      nIdx[q] = j;
    }
  };
  around(f, x, y, z, 1, visit);
  if (count < k) {
    count = 0;
    max2 = (f.cell * 2) ** 2;
    around(f, x, y, z, 2, visit);
  }
  return count;
}

export const neighbourIndex = (q: number) => nIdx[q];

/** One tick of flight. */
export function stepFlock(f: Flock) {
  const o = f.o;
  const n = o.n;
  rebuildGrid(f);
  f.px.set(f.x);
  f.py.set(f.y);
  f.pz.set(f.z);
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const az = new Float64Array(n);
  // Fear is passed on from last tick's fear (so it spreads neighbour to neighbour, not all at once).
  const nf = new Float32Array(n);
  const nex = new Float64Array(n);
  const ney = new Float64Array(n);
  const nez = new Float64Array(n);
  const r2 = o.radius * o.radius;
  const sep2 = (o.radius * 0.5) ** 2;
  const { separation, alignment, cohesion } = f.rules;
  const anyRule = separation || alignment || cohesion;
  // Cohesion also means staying with the flock as a whole (starlings gather over their roost):
  // a gentle pull to its middle, which is what keeps one murmuration from splintering.
  const mid = cohesion ? centroid(f) : null;
  for (let i = 0; i < n; i++) {
    const x = f.x[i];
    const y = f.y[i];
    const z = f.z[i];
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let avx = 0;
    let avy = 0;
    let avz = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let count = 0;
    let panic = -1;
    const take = (j: number) => {
      if (f.fear[j] > 0.05 && (panic < 0 || f.fear[j] > f.fear[panic])) panic = j;
      const dx = f.x[j] - x;
      const dy = f.y[j] - y;
      const dz = f.z[j] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < sep2 && d2 > 1e-9) {
        sx -= dx / d2;
        sy -= dy / d2;
        sz -= dz / d2;
      }
      avx += f.vx[j];
      avy += f.vy[j];
      avz += f.vz[j];
      cx += dx;
      cy += dy;
      cz += dz;
      count++;
    };
    if (anyRule) {
      if (o.neighbours > 0) {
        const k = nearest(f, i, Math.min(K_MAX, o.neighbours));
        for (let q = 0; q < k; q++) take(nIdx[q]);
      } else
        around(f, x, y, z, 1, (j) => {
          if (j === i) return;
          const dx = f.x[j] - x;
          const dy = f.y[j] - y;
          const dz = f.z[j] - z;
          if (dx * dx + dy * dy + dz * dz < r2) take(j);
        });
    }
    let gx = 0;
    let gy = 0;
    let gz = 0;
    if (count > 0) {
      if (separation) {
        gx += sx * o.separation * TUNE.sep;
        gy += sy * o.separation * TUNE.sep;
        gz += sz * o.separation * TUNE.sep;
      }
      if (alignment) {
        gx += (avx / count - f.vx[i]) * o.alignment * TUNE.align;
        gy += (avy / count - f.vy[i]) * o.alignment * TUNE.align;
        gz += (avz / count - f.vz[i]) * o.alignment * TUNE.align;
      }
      if (cohesion) {
        gx += (cx / count) * o.cohesion * TUNE.coh;
        gy += (cy / count) * o.cohesion * TUNE.coh;
        gz += (cz / count) * o.cohesion * TUNE.coh;
      }
    }
    if (mid) {
      gx += (mid.x - x) * o.cohesion * TUNE.pull;
      gy += (mid.y - y) * o.cohesion * TUNE.pull;
      gz += (mid.z - z) * o.cohesion * TUNE.pull;
    }
    // Fear: from seeing a predator close (fleeing away from it, and sideways out of its path),
    // or caught from the most frightened neighbour, a moment later (copying its escape).
    let fear = f.fear[i] * FEAR_FADE;
    let ex = f.ex[i];
    let ey = f.ey[i];
    let ez = f.ez[i];
    for (const p of f.predators) {
      const dx = x - p.x;
      const dy = y - p.y;
      const dz = z - p.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const reach = p.mode === 'stoop' ? 46 : 26;
      if (d < reach && d > 1e-6) {
        const seen = 1 - (d / reach) * 0.6;
        if (seen > fear) {
          fear = seen;
          // Away, with the part along the predator's line of flight mostly removed: they dodge aside.
          const pv = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz) || 1;
          const along = (dx * p.vx + dy * p.vy + dz * p.vz) / (d * pv);
          let wx = dx / d - 0.7 * along * (p.vx / pv);
          let wy = dy / d - 0.7 * along * (p.vy / pv);
          let wz = dz / d - 0.7 * along * (p.vz / pv);
          const wl = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
          wx /= wl;
          wy /= wl;
          wz /= wl;
          ex = wx;
          ey = wy;
          ez = wz;
        }
      }
    }
    if (panic >= 0 && f.fear[panic] * FEAR_PASS > fear && f.rng.next() < FEAR_CATCH) {
      fear = f.fear[panic] * FEAR_PASS;
      ex = f.ex[panic];
      ey = f.ey[panic];
      ez = f.ez[panic];
    }
    nf[i] = fear;
    nex[i] = ex;
    ney[i] = ey;
    nez[i] = ez;
    if (f.startle[i] > 0) {
      gx += f.sdx[i] * 90;
      gy += f.sdy[i] * 90;
      f.startle[i]--;
    }
    // A little restlessness.
    gx += (f.rng.next() - 0.5) * TUNE.noise;
    gy += (f.rng.next() - 0.5) * TUNE.noise * 0.7;
    gz += (f.rng.next() - 0.5) * TUNE.noise;
    const g = Math.sqrt(gx * gx + gy * gy + gz * gz);
    const cap = o.agility;
    const k = g > cap ? cap / g : 1;
    // Turning back from the edges of the sky comes on top of everything else (even fleeing), so
    // the flock never leaves the picture.
    const m = 30;
    const wall = 5;
    // So does a frightened bird's dart: panic lets it turn far harder than it ever would otherwise.
    const dart = fear > 0.05 ? fear * FEAR_DART : 0;
    ax[i] = gx * k + ex * dart + (x < m ? (m - x) * wall : x > WORLD.w - m ? (WORLD.w - m - x) * wall : 0);
    ay[i] = gy * k + ey * dart + (y < m ? (m - y) * wall : y > WORLD.h - m ? (WORLD.h - m - y) * wall : 0);
    az[i] = gz * k + ez * dart + (z < m ? (m - z) * wall : z > WORLD.d - m ? (WORLD.d - m - z) * wall : 0);
  }
  for (let i = 0; i < n; i++) {
    const ox = f.vx[i];
    const oy = f.vy[i];
    const oz = f.vz[i];
    let vx = ox + ax[i] * DT;
    let vy = oy + ay[i] * DT;
    let vz = oz + az[i] * DT;
    const s = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    const lo = o.speed * 0.7;
    // Frightened birds fly faster.
    const hi = o.speed * (1.4 + 0.7 * nf[i]);
    const t = s < lo ? lo / s : s > hi ? hi / s : 1;
    vx *= t;
    vy *= t;
    vz *= t;
    // How far its heading swung this tick (0..2), for the picture.
    const so = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1;
    const sn = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    f.turn[i] = 1 - (ox * vx + oy * vy + oz * vz) / (so * sn);
    f.vx[i] = vx;
    f.vy[i] = vy;
    f.vz[i] = vz;
    f.x[i] += vx * DT;
    f.y[i] += vy * DT;
    f.z[i] += vz * DT;
  }
  f.fear = nf;
  f.ex = nex;
  f.ey = ney;
  f.ez = nez;
  for (const p of f.predators) stepPredator(f, p);
}

/** Steer a predator toward a velocity, turning no harder than `acc` (units/s²), and back in from the edges of the sky. */
function steer(p: Predator, dx: number, dy: number, dz: number, speed: number, acc: number) {
  const m = 12;
  if (p.x < m) dx = Math.max(dx, 40);
  else if (p.x > WORLD.w - m) dx = Math.min(dx, -40);
  if (p.y > WORLD.h - 25) dy = Math.min(dy, -40);
  if (p.z < m) dz = Math.max(dz, 40);
  else if (p.z > WORLD.d - m) dz = Math.min(dz, -40);
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  let ax = (dx / l) * speed - p.vx;
  let ay = (dy / l) * speed - p.vy;
  let az = (dz / l) * speed - p.vz;
  const a = Math.sqrt(ax * ax + ay * ay + az * az);
  const k = a > acc * DT ? (acc * DT) / a : 1;
  ax *= k;
  ay *= k;
  az *= k;
  p.vx += ax;
  p.vy += ay;
  p.vz += az;
}

/** The bird it goes for: on the side of the flock nearest to it (a falcon picks off the edge, not the middle). */
function pickTarget(f: Flock, p: Predator): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < f.o.n; i++) {
    const dx = f.x[i] - p.x;
    const dy = f.y[i] - p.y;
    const dz = f.z[i] - p.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function stepPredator(f: Flock, p: Predator) {
  const c = centroid(f);
  const cruise = f.o.speed * 1.25;
  p.timer++;
  if (p.mode === 'circle') {
    // Wide, slow circles above the flock (beside it, for a shark), waiting for a chance.
    const nx = p.ox * ROT_C - p.oz * ROT_S;
    p.oz = p.ox * ROT_S + p.oz * ROT_C;
    p.ox = nx;
    const r = 50;
    const tx = c.x + p.ox * r;
    const ty = p.level ? c.y : Math.max(12, c.y - 70);
    const tz = c.z + p.oz * r;
    steer(p, tx - p.x, (ty - p.y) * 0.8, tz - p.z, cruise, 22);
    if (p.timer >= p.wait) {
      p.mode = 'stoop';
      p.timer = 0;
      p.target = pickTarget(f, p);
    }
  } else if (p.mode === 'stoop') {
    // Fold and drop: aim where the bird will be, speeding up all the way down.
    const i = p.target;
    const dx = f.x[i] - p.x;
    const dy = f.y[i] - p.y;
    const dz = f.z[i] - p.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const speed = Math.min(f.o.speed * (p.level ? 2.2 : 3), cruise + p.timer * (p.level ? 0.35 : 0.6));
    const lead = Math.min(1.2, d / Math.max(1, speed));
    steer(p, dx + f.vx[i] * lead, dy + f.vy[i] * lead, dz + f.vz[i] * lead, speed, p.level ? 60 : 85);
    // Through the flock (it opened up), or past the bird: pull out.
    const below = !p.level && p.y > f.y[i] + 6;
    if (d < 3 || below || p.timer > 260) {
      p.mode = 'climb';
      p.timer = 0;
    }
  } else {
    // Carry the speed back up (a shark sweeps out to the side), then circle again.
    const out = 1;
    const awayX = p.x - c.x;
    const awayZ = p.z - c.z;
    steer(p, awayX * out + p.vx * 0.5, p.level ? 0 : -45, awayZ * out + p.vz * 0.5, cruise * 1.1, 32);
    if (p.timer > (p.level ? 110 : 150) && (p.level || p.y < c.y - 40 || p.y < 20)) {
      p.mode = 'circle';
      p.timer = 0;
      p.wait = 140 + Math.floor(f.rng.next() * 160);
      const ax = p.x - c.x;
      const az = p.z - c.z;
      const l = Math.sqrt(ax * ax + az * az) || 1;
      p.ox = ax / l;
      p.oz = az / l;
    }
  }
  p.x += p.vx * DT;
  p.y += p.vy * DT;
  p.z += p.vz * DT;
}

/** A predator arrives high over one side (level with the school, for a shark) and circles before its first stoop. */
export function addPredator(f: Flock, level = false) {
  const k = f.predators.length;
  const side = k % 2 ? 1 : -1;
  const c = centroid(f);
  f.predators.push({
    x: WORLD.w / 2 + side * (WORLD.w / 2 + 15),
    y: level ? c.y : Math.max(12, c.y - 70),
    z: WORLD.d * (0.3 + 0.4 * (k % 2)),
    vx: -side * f.o.speed,
    vy: level ? 0 : 3,
    vz: 0,
    mode: 'circle',
    timer: 0,
    // The first stoop comes quickly; two predators take turns.
    wait: 70 + k * 90,
    target: 0,
    ox: side,
    oz: 0,
    level,
  });
}

export function centroid(f: Flock) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < f.o.n; i++) {
    x += f.x[i];
    y += f.y[i];
    z += f.z[i];
  }
  return { x: x / f.o.n, y: y / f.o.n, z: z / f.o.n };
}

/** How much the flock points one way: 1 = all the same, near 0 = every which way. */
export function order(f: Flock): number {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < f.o.n; i++) {
    const s = Math.sqrt(f.vx[i] * f.vx[i] + f.vy[i] * f.vy[i] + f.vz[i] * f.vz[i]) || 1;
    x += f.vx[i] / s;
    y += f.vy[i] / s;
    z += f.vz[i] / s;
  }
  return Math.sqrt(x * x + y * y + z * z) / f.o.n;
}

/** Startle the bird furthest along x: it swerves hard for a moment (a turn the others pass on). */
export function startle(f: Flock): number {
  const c = centroid(f);
  let best = 0;
  let bestD = -Infinity;
  for (let i = 0; i < f.o.n; i++) {
    const d = f.x[i] - c.x;
    if (d > bestD) {
      bestD = d;
      best = i;
    }
  }
  // Everyone near it swerves too (it saw something): a small group, a big wave.
  const k = nearest(f, best, 7);
  const swerve = (i: number) => {
    const s = Math.sqrt(f.vx[i] * f.vx[i] + f.vy[i] * f.vy[i]) || 1;
    f.sdx[i] = -f.vy[i] / s;
    f.sdy[i] = f.vx[i] / s;
    f.startle[i] = 24;
  };
  const near = Array.from(nIdx.subarray(0, k));
  swerve(best);
  for (const j of near) swerve(j);
  return best;
}
