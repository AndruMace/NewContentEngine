import { z } from 'zod';
import { hexToRgb, paletteAt, type Ctx2D, type DramaScore, type Rng, type Template, type Theme } from '@sim/engine';
import { gaussFit } from '../scoring';
import * as dm from '@sim/physics/math';

export const sandPourSchema = z.object({
  container: z.enum(['jar', 'heart', 'hourglass', 'galton']).default('jar').meta({ title: 'Container' }),
  cellSize: z.number().int().min(4).max(8).default(5).meta({ title: 'Grain size (px)' }),
  fillSeconds: z.number().min(10).max(60).default(26).meta({ title: 'Fill time (s)' }),
  fillTarget: z.number().min(0.5).max(1).default(0.95).meta({ title: 'Stop at fill %', step: 0.01 }),
  emitterWidth: z.number().int().min(1).max(10).default(4).meta({ title: 'Stream width (grains)' }),
  emitterWander: z.number().min(0).max(1).default(0.85).meta({ title: 'Stream wander (range)', step: 0.05 }),
  aimStrength: z.number().min(0).max(1).default(0.35).meta({ title: 'Aim strength (0 = pure wander, 1 = fill gaps)', step: 0.05 }),
  overflowSeconds: z.number().min(0).max(5).default(1.5).meta({ title: 'Overflow before stopping (s)', step: 0.1 }),
  layerSeconds: z.number().min(0.5).max(6).default(2).meta({ title: 'Seconds per colour layer', step: 0.1 }),
});

export type SandPourParams = z.infer<typeof sandPourSchema>;

const EMPTY = 0;
const WALL = 1;
const OUTRO_S = 1.6;
const MAX_FALL = 4;
/** Heart opening as a share of the distance between its lobe peaks. */
const HEART_SLOT = 0.28;

interface State {
  p: SandPourParams;
  gw: number;
  gh: number;
  grid: Uint8Array;
  shade: Uint8Array;
  inside: Uint8Array;
  capacity: number;
  top: Int32Array;
  mouthX0: number;
  mouthX1: number;
  /** Highest row of the shape (smallest y). */
  minTop: number;
  stopCells: number[];
  deficit: Int32Array;
  maxDeficit: number;
  emitX: number;
  aimX: number;
  /** Random-walk wander: current target column, and when to pick a new one / stop dwelling. */
  wanderX: number;
  wanderUntil: number;
  dwellUntil: number;
  /** Overflow tracking: grains spilled recently (decaying) and when steady overflow began. */
  spillRate: number;
  overflowSince: number | null;
  overflowed: boolean;
  lastScanT: number;
  progressT: number;
  progressFilled: number;
  filled: number;
  poured: number;
  active: number[];
  isActive: Uint8Array;
  vel: Uint8Array;
  colorU: number;
  emitting: boolean;
  fullAt: number | null;
  settledAt: number | null;
  t: number;
  rng: Rng;
  fxRng: Rng;
  emitAcc: number;
  lastPourEventT: number;
  lastLayer: number;
  milestones: number;
  movedThisStep: number;
}

/** Container shapes in normalised coords (u across, v down). */
function insideShape(kind: SandPourParams['container'], u: number, v: number): boolean {
  switch (kind) {
    case 'jar': {
      if (v < 0.34 || v > 0.9) return false;
      const dx = Math.abs(u - 0.5) / 0.36;
      const dy = Math.max(0, v - 0.8) / 0.1;
      return dm.pow(dx, 4) + dm.pow(dy, 4) < 1;
    }
    case 'heart': {
      const x = (u - 0.5) * 2.6;
      const y = 1.25 - (v - 0.3) * 3.75;
      const a = x * x + y * y - 1;
      return a * a * a - x * x * y * y * y < 0;
    }
    case 'hourglass': {
      const neck = 0.62;
      if (v < 0.32 || v > 0.92) return false;
      const k = v < neck ? (neck - v) / (neck - 0.32) : (v - neck) / (0.92 - neck);
      return Math.abs(u - 0.5) < 0.025 + 0.34 * dm.pow(k, 0.8);
    }
    case 'galton':
      return v > 0.66 && v < 0.92 && Math.abs(u - 0.5) < 0.42;
  }
}

interface Built {
  grid: Uint8Array;
  inside: Uint8Array;
  capacity: number;
  /** First inside row per column (-1 if none): the container's opening, column by column. */
  top: Int32Array;
  /** Columns the stream may pour into. */
  mouthX0: number;
  mouthX1: number;
  /** Galton only: settled sand here means the centre bin is full. */
  stopCells: number[];
}

function build(p: SandPourParams, gw: number, gh: number): Built {
  const grid = new Uint8Array(gw * gh);
  const full = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (insideShape(p.container, (x + 0.5) / gw, (y + 0.5) / gh)) full[y * gw + x] = 1;
  const top = new Int32Array(gw).fill(-1);
  for (let x = 0; x < gw; x++) for (let y = 0; y < gh; y++) if (full[y * gw + x]) { top[x] = y; break; }

  // Walls: a T-cell rim around the shape.
  const T = 2;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (full[y * gw + x]) continue;
      search: for (let dy = -T; dy <= T; dy++) {
        for (let dx = -T; dx <= T; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && full[yy * gw + xx]) {
            grid[y * gw + x] = WALL;
            break search;
          }
        }
      }
    }
  }

  const cx = Math.floor(gw / 2);
  const inside = full.slice();
  let stopCells: number[] = [];
  // Open the top: no rim above the first inside cell of each column. The heart only opens in a
  // narrow slot at the dip between its lobes, so it still reads as a heart; the lobe tops above
  // the slot can't be reached and stay empty.
  let openX0 = 0;
  let openX1 = gw - 1;
  if (p.container === 'heart') {
    let peakL = cx;
    let peakR = cx;
    let bestL = Infinity;
    let bestR = Infinity;
    for (let x = 0; x < gw; x++) {
      if (top[x] < 0) continue;
      if (x < cx && top[x] < bestL) [bestL, peakL] = [top[x], x];
      if (x > cx && top[x] <= bestR) [bestR, peakR] = [top[x], x];
    }
    const half = Math.max(Math.ceil(p.emitterWidth / 2) + 5, Math.round((peakR - peakL) * HEART_SLOT / 2));
    openX0 = cx - half;
    openX1 = cx + half;
  }
  for (let x = openX0; x <= openX1; x++) {
    if (top[x] < 0) continue;
    for (let y = 0; y < top[x]; y++) {
      if (grid[y * gw + x] === WALL) grid[y * gw + x] = EMPTY;
    }
  }
  let mouthX0 = gw;
  let mouthX1 = -1;
  for (let x = openX0; x <= openX1; x++) {
    if (top[x] < 0) continue;
    mouthX0 = Math.min(mouthX0, x);
    mouthX1 = Math.max(mouthX1, x);
  }

  if (p.container === 'galton') {
    // Wedge pegs (/\) in a triangular lattice: grains slide off each wedge onto the apex of
    // the wedge below, picking left or right at random -> binomial distribution.
    const S = 14;
    const half = S / 2 - 1;
    const rows = 11;
    const pegTop = Math.floor(gh * 0.3);
    const rowStep = 11;
    for (let r = 0; r < rows; r++) {
      const ay = pegTop + r * rowStep;
      for (let k = 0; k <= r; k++) {
        const ax = Math.round(cx + (k - r / 2) * S);
        for (let d = 0; d <= half; d++) for (let w = -d; w <= d; w++) grid[(ay + d) * gw + ax + w] = WALL;
      }
    }
    // Bin dividers under the last row's wedge apexes, so each gap feeds one bin.
    const binTop = Math.floor(gh * 0.66) + 2;
    const binBottom = Math.floor(gh * 0.92);
    const last = rows - 1;
    for (let k = -1; k <= last + 1; k++) {
      const x = Math.round(cx + (k - last / 2) * S);
      if (x < gw * 0.08 || x > gw * 0.92) continue;
      for (let y = binTop; y < binBottom; y++) grid[y * gw + x] = WALL;
    }
    // Funnel to centre the stream on the top wedge.
    const fTop = Math.floor(gh * 0.16);
    for (let y = fTop; y < pegTop - 3; y++) {
      const off = Math.round(gw * 0.25 * (1 - (y - fTop) / (pegTop - 3 - fTop))) + 3;
      grid[y * gw + cx - off] = WALL;
      grid[y * gw + cx + off] = WALL;
    }
    // Stop when the centre bin is full to its top.
    stopCells = [(binTop + 1) * gw + Math.round(cx + S / 2)];
  }
  // Capacity counts only what sand can reach: nothing above the opening's highest point
  // (matters for the heart, whose lobe tops rise above its slot).
  let openTop = gh;
  for (let x = mouthX0; x <= mouthX1; x++) if (top[x] >= 0) openTop = Math.min(openTop, top[x]);
  let capacity = 0;
  for (let i = 0; i < inside.length; i++) if (inside[i] && grid[i] === EMPTY && (p.container !== 'heart' || ((i / gw) | 0) >= openTop)) capacity++;
  // Floor under the container: overflow lands here and piles up.
  const floorY = Math.min(gh - 2, Math.floor(gh * 0.955));
  for (let x = 0; x < gw; x++) for (let y = floorY; y < floorY + 2; y++) grid[y * gw + x] = WALL;
  return { grid, inside, capacity, top, mouthX0, mouthX1, stopCells };
}

/**
 * Per-column free space measured from the opening down to the first settled sand or wall.
 * Falling grains don't count as filled, so a stream passing through never looks "full".
 */
function scanSurface(s: State) {
  const { gw, grid, inside, top, isActive } = s;
  let max = 0;
  for (let x = s.mouthX0; x <= s.mouthX1; x++) {
    let d = 0;
    if (top[x] >= 0) {
      for (let y = top[x]; y < s.gh; y++) {
        const i = y * gw + x;
        if (!inside[i] || grid[i] === WALL || (grid[i] >= 2 && !isActive[i])) break;
        d++;
      }
    }
    s.deficit[x] = d;
    max = Math.max(max, d);
  }
  s.maxDeficit = max;
  // Aim at the emptiest region (box-smoothed), preferring spots near the stream.
  const R = 6;
  let best = -Infinity;
  let bestX = s.emitX;
  for (let x = s.mouthX0; x <= s.mouthX1; x++) {
    let sum = 0;
    for (let k = -R; k <= R; k++) sum += s.deficit[Math.max(s.mouthX0, Math.min(s.mouthX1, x + k))];
    const score = sum - Math.abs(x - s.emitX) * 0.5;
    if (score > best) {
      best = score;
      bestX = x;
    }
  }
  s.aimX = bestX;
}

/** Outside the container and below its rim: where overflowing sand ends up. */
function isOutside(s: State, i: number): boolean {
  if (s.inside[i]) return false;
  const x = i % s.gw;
  const y = (i / s.gw) | 0;
  return s.top[x] < 0 ? y > s.minTop : y > s.top[x];
}

function wake(s: State, x: number, y: number) {
  for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx;
    const yy = y - 1;
    if (xx < 0 || yy < 0 || xx >= s.gw) continue;
    const i = yy * s.gw + xx;
    if (s.grid[i] >= 2 && !s.isActive[i]) {
      s.isActive[i] = 1;
      s.active.push(i);
    }
  }
}

const lutCache = new Map<string, Uint8Array>();
function paletteLut(theme: Theme): Uint8Array {
  let lut = lutCache.get(theme.id);
  if (!lut) {
    lut = new Uint8Array(256 * 3);
    for (let v = 2; v < 256; v++) {
      const c = paletteAt(theme.palette, (v - 2) / 253);
      lut.set([c[0], c[1], c[2]], v * 3);
    }
    lutCache.set(theme.id, lut);
  }
  return lut;
}

const surfaces = new WeakMap<State, { canvas: OffscreenCanvas | HTMLCanvasElement; img: ImageData }>();

export const sandPour: Template<SandPourParams, State> = {
  id: 'sand-pour',
  name: 'Sand Pour',
  family: 'particles',
  description:
    'Coloured sand pours from a wandering stream into a container (jar, heart, hourglass or Galton board), building up striped layers. Overfilled sand spills over the rim and piles up on the floor.',
  schema: sandPourSchema,
  substeps: 2,
  searchBudget: 16,
  glowScale: 0.5,
  defaultCopy: {
    hook: 'Wait for the last layer…',
    cta: 'Which color was your favorite?',
  },

  init({ params: p, rng, fxRng, width, height }) {
    const gw = Math.floor(width / p.cellSize);
    const gh = Math.floor(height / p.cellSize);
    const { grid, inside, capacity, top, mouthX0, mouthX1, stopCells } = build(p, gw, gh);
    return {
      p,
      gw,
      gh,
      grid,
      shade: new Uint8Array(gw * gh),
      inside,
      capacity,
      top,
      mouthX0,
      mouthX1,
      minTop: Math.min(...Array.from(top).filter((v) => v >= 0)),
      stopCells,
      deficit: new Int32Array(gw),
      maxDeficit: Infinity,
      emitX: gw / 2,
      aimX: gw / 2,
      wanderX: gw / 2,
      wanderUntil: 0,
      dwellUntil: 0,
      spillRate: 0,
      overflowSince: null,
      overflowed: false,
      lastScanT: -1,
      progressT: 0,
      progressFilled: 0,
      filled: 0,
      poured: 0,
      active: [],
      isActive: new Uint8Array(gw * gh),
      vel: new Uint8Array(gw * gh),
      colorU: rng.next(),
      emitting: true,
      fullAt: null,
      settledAt: null,
      t: 0,
      rng,
      fxRng,
      emitAcc: 0,
      lastPourEventT: -1,
      lastLayer: 0,
      milestones: 0,
      movedThisStep: 0,
    };
  },

  step(s, { dt, t, emit }) {
    const { p, gw, gh, grid } = s;
    // Emit.
    if (s.emitting) {
      // Galton boards stop at the centre bin (a bell curve fills ~half the bins).
      const share = p.container === 'galton' ? 0.33 : p.fillTarget;
      s.emitAcc += ((s.capacity * share) / p.fillSeconds) * dt;
      const layer = Math.floor(t / p.layerSeconds);
      if (layer !== s.lastLayer) {
        s.lastLayer = layer;
        emit({ type: 'layer', n: layer });
      }
      const colorV = 2 + Math.floor((((s.colorU + layer * 0.137) % 1) * 253));
      let cx: number;
      if (p.container === 'galton') {
        cx = Math.floor(gw / 2);
      } else {
        if (t - s.lastScanT >= 0.05) {
          scanSurface(s);
          s.lastScanT = t;
        }
        const margin = Math.ceil(p.emitterWidth / 2) + 2;
        const lo = s.mouthX0 + margin;
        const hi = s.mouthX1 - margin;
        const mid = (lo + hi) / 2;
        // Wander: a seeded random walk between points across the mouth, sometimes pausing
        // (pauses build peaks; quick sweeps leave valleys).
        if (t >= s.wanderUntil) {
          s.wanderX = mid + s.rng.range(-1, 1) * ((hi - lo) / 2) * p.emitterWander;
          s.wanderUntil = t + s.rng.range(0.8, 2.6);
          if (s.rng.chance(0.3)) s.dwellUntil = t + s.rng.range(0.4, 1.4);
        }
        // Aim: pull towards the emptiest region, stronger as the container fills up.
        const frac0 = s.filled / Math.max(1, s.capacity);
        const bias = p.aimStrength * (0.3 + 0.7 * Math.min(1, frac0 / 0.7));
        const target = s.wanderX + (s.aimX - s.wanderX) * bias;
        if (t >= s.dwellUntil) {
          const maxStep = gw * 0.3 * dt;
          s.emitX += Math.max(-maxStep, Math.min(maxStep, target - s.emitX));
        }
        const wobble = (dm.sin(t * 2.3) * 0.6 + dm.sin(t * 0.9 + 1.3) * 0.4) * 2;
        cx = Math.round(Math.max(lo, Math.min(hi, s.emitX + wobble)));
      }
      const y0 = Math.floor(gh * 0.1);
      while (s.emitAcc >= 1) {
        s.emitAcc -= 1;
        let i = -1;
        for (let tries = 0; tries < 8 && i < 0; tries++) {
          const x = cx + s.rng.int(-Math.floor(p.emitterWidth / 2), Math.ceil(p.emitterWidth / 2) - 1);
          const y = y0 + s.rng.int(0, 9);
          if (grid[y * gw + x] === EMPTY) i = y * gw + x;
        }
        if (i < 0) continue;
        grid[i] = colorV;
        s.poured++;
        s.shade[i] = s.fxRng.int(0, 40);
        s.vel[i] = 1;
        s.isActive[i] = 1;
        s.active.push(i);
      }
    }

    // Move active grains, bottom rows first, deterministic order.
    s.active.sort((a, b) => b - a);
    const next: number[] = [];
    let moved = 0;
    let spilledNow = 0;
    for (const start of s.active) {
      let i = start;
      if (grid[i] < 2) {
        s.isActive[i] = 0;
        continue;
      }
      let x = i % gw;
      let y = (i / gw) | 0;
      let steps = Math.min(MAX_FALL, s.vel[i] + 1);
      let any = false;
      while (steps-- > 0) {
        if (y + 1 >= gh) {
          // Fell off the bottom of the screen.
          grid[i] = EMPTY;
          s.isActive[i] = 0;
          wake(s, x, y);
          i = -1;
          break;
        }
        const below = i + gw;
        let to = -1;
        if (grid[below] === EMPTY) to = below;
        else {
          const first = s.rng.chance(0.5) ? -1 : 1;
          for (const d of [first, -first]) {
            const xx = x + d;
            if (xx >= 0 && xx < gw && grid[below + d] === EMPTY && grid[i + d] === EMPTY) {
              to = below + d;
              break;
            }
          }
          // Gentle slopes: slide sideways if there's a drop two cells over. Lowers the angle of
          // repose from 45° to ~27°, so piles flatten and curved containers fill to their edges.
          if (to < 0 && steps === Math.min(MAX_FALL, s.vel[start] + 1) - 1) {
            for (const d of [first, -first]) {
              const xx = x + 2 * d;
              if (xx >= 0 && xx < gw && grid[i + d] === EMPTY && grid[i + 2 * d] === EMPTY && grid[below + 2 * d] === EMPTY && grid[below + d] !== WALL) {
                to = i + d;
                break;
              }
            }
          }
        }
        if (to < 0) break;
        grid[to] = grid[i];
        s.shade[to] = s.shade[i];
        s.vel[to] = Math.min(MAX_FALL, s.vel[i] + (to === below ? 1 : 0));
        grid[i] = EMPTY;
        s.isActive[i] = 0;
        s.isActive[to] = 1;
        if (s.inside[i]) s.filled--;
        if (s.inside[to]) s.filled++;
        // Overflow: a grain leaving the container (or its mouth) for the outside, below the rim.
        if (!isOutside(s, i) && isOutside(s, to)) spilledNow++;
        wake(s, x, y);
        i = to;
        x = i % gw;
        y = (i / gw) | 0;
        any = true;
      }
      if (i < 0) continue;
      if (any) {
        moved++;
        next.push(i);
      } else {
        s.vel[i] = 0;
        s.isActive[i] = 0;
      }
    }
    // Re-add grains woken during this pass that weren't processed.
    for (const i of s.active) if (s.isActive[i] && grid[i] >= 2 && !next.includes(i)) next.push(i);
    s.active = next;
    s.movedThisStep = moved;

    const frac = s.filled / Math.max(1, s.capacity);
    while (s.milestones < 3 && frac >= (s.milestones + 1) * 0.25) {
      s.milestones++;
      emit({ type: 'milestone', pct: s.milestones * 25 });
    }
    let done: boolean;
    if (p.container === 'galton') {
      done = s.stopCells.some((i) => grid[i] >= 2 && !s.isActive[i]);
    } else {
      // Full when the target is reached, or every column is filled to its top with settled sand.
      // (98.5% counts as full: levelling the last few grains takes disproportionately long.)
      // The heart's slot plugs early with a cone while sand can still run down the inside slopes
      // into the shoulders, so it keeps pouring until it overflows or stops taking sand.
      done = frac >= Math.min(p.fillTarget, 0.985) || (p.container !== 'heart' && frac > 0.2 && s.maxDeficit <= 1);
      // Overflow: once sand has been spilling steadily for overflowSeconds, stop.
      s.spillRate = s.spillRate * dm.exp(-dt / 0.25) + spilledNow;
      const overflowing = s.spillRate > 6;
      if (overflowing && !s.overflowed) {
        s.overflowed = true;
        emit({ type: 'overflow' });
      }
      if (overflowing) s.overflowSince ??= t;
      else s.overflowSince = null;
      if (s.emitting && s.overflowSince !== null && t - s.overflowSince >= p.overflowSeconds) done = true;
      // Safety: sand is going in but the fill level has stalled (nowhere left for it to go).
      if (s.emitting && t - s.progressT >= 4) {
        if (frac > 0.3 && s.filled - s.progressFilled < s.capacity * 0.002) done = true;
        s.progressT = t;
        s.progressFilled = s.filled;
      }
    }
    if (s.emitting && done) {
      s.emitting = false;
      s.fullAt = t;
      emit({ type: 'full' });
    }
    // "Settled" once only a trickle is still moving (a few grains can creep for a long time).
    if (!s.emitting && s.settledAt === null && moved < 8) s.settledAt = t;
    if (t - s.lastPourEventT >= 0.06 && moved > 0) {
      s.lastPourEventT = t;
      emit({ type: 'pour', amount: Math.min(1, moved / 400), x: 0 });
    }
    s.t = t + dt;
  },

  isDone(s) {
    if (s.fullAt === null) return false;
    // Wait for the sand to settle, but cap it (an hourglass can keep draining for a while).
    const settled = Math.min((s.settledAt ?? Infinity) + 0.6, s.fullAt + 8);
    return s.t >= Math.max(s.fullAt + OUTRO_S, settled);
  },

  hud(s) {
    return { grains: s.poured.toLocaleString('en-US'), outro: s.fullAt !== null };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.6, y: 0.08 },
      { kind: 'counter', key: 'grains', label: 'GRAINS', y: 0.2, size: 88 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.2 },
    ];
  },

  render({ ctx, theme, width, height }, s) {
    let surf = surfaces.get(s);
    if (!surf) {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(s.gw, s.gh) : Object.assign(document.createElement('canvas'), { width: s.gw, height: s.gh });
      const c2 = canvas.getContext('2d') as Ctx2D;
      surf = { canvas, img: c2.createImageData(s.gw, s.gh) };
      surfaces.set(s, surf);
    }
    const lut = paletteLut(theme);
    const wall = hexToRgb(theme.text);
    const data = surf.img.data;
    const g = s.grid;
    for (let i = 0; i < g.length; i++) {
      const v = g[i];
      const o = i * 4;
      if (v === EMPTY) {
        data[o + 3] = 0;
      } else if (v === WALL) {
        data[o] = wall[0];
        data[o + 1] = wall[1];
        data[o + 2] = wall[2];
        data[o + 3] = 200;
      } else {
        const k = 1 - s.shade[i] / 255;
        data[o] = lut[v * 3] * k;
        data[o + 1] = lut[v * 3 + 1] * k;
        data[o + 2] = lut[v * 3 + 2] * k;
        data[o + 3] = 255;
      }
    }
    const c2 = surf.canvas.getContext('2d') as Ctx2D;
    c2.putImageData(surf.img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(surf.canvas, 0, 0, s.gw * s.p.cellSize, s.gh * s.p.cellSize);
    ctx.imageSmoothingEnabled = true;
    void width;
    void height;
  },

  audio(e, { melody, theme }) {
    switch (e.type) {
      case 'pour':
        return [{ kind: 'sfx', name: 'sand', vel: 0.25 + 0.6 * (e.amount as number), pitch: ((e.t * 0.37) % 1) }];
      case 'layer':
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? 0.25 : 0.45, voice: theme.voice, dur: 1.6 }));
      case 'overflow':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.35 }];
      case 'milestone':
        return [{ kind: 'sfx', name: 'chime', vel: 0.45, pitch: (e.pct as number) / 100 }];
      case 'full':
        return [
          { kind: 'sfx', name: 'whoosh', vel: 0.5 },
          ...melody.peek().flatMap((midi) => [
            { kind: 'note' as const, midi, vel: 0.7, voice: 'bell' as const, dur: 2.5 },
            { kind: 'note' as const, midi: midi + 12, vel: 0.4, voice: 'bell' as const, dur: 2.5 },
          ]),
        ];
    }
    return [];
  },

  score(events, { durationS, targetS, timedOut }): DramaScore {
    const full = events.find((e) => e.type === 'full');
    const durFit = gaussFit(durationS, targetS, targetS * 0.25);
    if (timedOut || !full) return { total: 0.05 * durFit, parts: { durFit }, notes: ['never filled'] };
    return { total: durFit, parts: { durFit }, notes: [`full at ${full.t.toFixed(1)}s`] };
  },
};
