/**
 * Tower Stack's pieces: chunky toy blocks, each with a name and its own colour. Most are built from
 * square cells (5 cm each); a few are smooth convex shapes (a mesa, a ramp, a roof, a dome). Every
 * piece is centred on its area centroid, so it turns about its middle and its body origin is its
 * centre of mass. One world unit is 10 cm.
 */
import * as dm from '@sim/physics/math';

export type V2 = [number, number];

/** Edge of one square cell, in world units. */
export const CELL = 0.5;
/** How deep every piece is (front to back). */
export const DEPTH = 0.62;

export interface PieceDef {
  id: string;
  name: string;
  color: string;
  /** Outline, counter-clockwise, centred on the area centroid. */
  outline: V2[];
  /** Convex parts for collision (together they cover the outline). */
  parts: { poly: V2[]; box?: { cx: number; cy: number; hw: number; hh: number } }[];
  area: number;
}

/** Rows top to bottom, '#' for a filled cell. */
const CELL_PIECES: { id: string; name: string; color: string; rows: string[] }[] = [
  { id: 'bridge', name: 'Bridge', color: '#6fd3e6', rows: ['####', '#..#', '#..#'] },
  { id: 'step', name: 'Step', color: '#f2c14e', rows: ['.##', '.#.', '##.'] },
  { id: 'notched', name: 'Notched beam', color: '#8edcc6', rows: ['######', '##..##'] },
  { id: 'counter', name: 'Counterbeam', color: '#8392f2', rows: ['##.....', '#######'] },
  { id: 'slab', name: 'Slab', color: '#f5a66c', rows: ['######'] },
  { id: 'block', name: 'Block', color: '#79b8f5', rows: ['##', '##'] },
  { id: 'plus', name: 'Plus', color: '#b89cf1', rows: ['.#.', '###', '.#.'] },
  { id: 'ell', name: 'Ell', color: '#f49ab9', rows: ['#..', '###'] },
  { id: 'tee', name: 'Tee', color: '#a9d673', rows: ['###', '.#.'] },
  { id: 'pillar', name: 'Pillar', color: '#f7d36b', rows: ['#', '#', '#', '#'] },
  { id: 'chair', name: 'Chair', color: '#ee8f7a', rows: ['#..', '#..', '###', '#.#'] },
  { id: 'crane', name: 'Crane', color: '#7fcfa8', rows: ['#####', '#....', '#....'] },
];

/** Convex pieces, in cells (y up). */
const POLY_PIECES: { id: string; name: string; color: string; poly: V2[] }[] = [
  { id: 'mesa', name: 'Mesa', color: '#ee7d66', poly: [[0, 0], [4, 0], [3, 2], [1, 2]] },
  { id: 'ramp', name: 'Ramp', color: '#9fb7f7', poly: [[0, 0], [4, 0], [0, 2]] },
  { id: 'roof', name: 'Roof', color: '#d99ae8', poly: [[0, 0], [4, 0], [2, 1.6]] },
  { id: 'dome', name: 'Dome', color: '#f0b37a', poly: Array.from({ length: 11 }, (_, i): V2 => [1.6 + 1.6 * dm.cos((Math.PI * i) / 10), 1.6 * dm.sin((Math.PI * i) / 10)]) },
];

export const PIECE_SETS = {
  classic: ['bridge', 'step', 'notched', 'counter', 'slab', 'block', 'plus', 'ell', 'tee', 'pillar', 'mesa', 'ramp'],
  blocky: ['bridge', 'step', 'notched', 'counter', 'slab', 'block', 'plus', 'ell', 'tee', 'pillar', 'chair', 'crane'],
  wild: ['bridge', 'step', 'counter', 'slab', 'plus', 'pillar', 'chair', 'crane', 'mesa', 'ramp', 'roof', 'dome'],
} as const;
export type PieceSet = keyof typeof PIECE_SETS;

const area = (p: V2[]) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
};

const centroid = (p: V2[]): V2 => {
  const a = area(p);
  let cx = 0, cy = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    const k = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * k;
    cy += (y0 + y1) * k;
  }
  return [cx / (6 * a), cy / (6 * a)];
};

/** Filled cells as [x, y] with y up. */
function cellsOf(rows: string[]): V2[] {
  const out: V2[] = [];
  rows.forEach((row, r) => [...row].forEach((ch, x) => ch === '#' && out.push([x, rows.length - 1 - r])));
  return out;
}

/**
 * The outline of a set of cells: every cell edge not shared with a neighbour, chained into one
 * counter-clockwise loop, with straight runs merged. (Pieces are one blob with no holes or corner
 * touches, so there is exactly one loop.)
 */
export function traceCells(cells: V2[]): V2[] {
  const key = (x: number, y: number) => `${x},${y}`;
  const edges = new Map<string, V2>();
  for (const [x, y] of cells) {
    const loop: V2[] = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
    for (let i = 0; i < 4; i++) {
      const a = loop[i], b = loop[(i + 1) % 4];
      const back = `${key(...b)}>${key(...a)}`;
      if (edges.has(back)) edges.delete(back);
      else edges.set(`${key(...a)}>${key(...b)}`, b);
    }
  }
  const next = new Map<string, V2>();
  for (const [k, b] of edges) next.set(k.split('>')[0], b);
  const start = [...next.keys()].sort()[0];
  const pts: V2[] = [];
  let cur = start;
  do {
    const [x, y] = cur.split(',').map(Number);
    pts.push([x, y]);
    const b = next.get(cur)!;
    cur = key(...b);
  } while (cur !== start);
  // Drop the points in the middle of straight runs.
  return pts.filter((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length];
    const b = pts[(i + 1) % pts.length];
    return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
  });
}

/** Cells merged into a few rectangles: runs along each row, stacked where rows match. */
export function mergeCells(cells: V2[]): { x: number; y: number; w: number; h: number }[] {
  const ys = [...new Set(cells.map((c) => c[1]))].sort((a, b) => a - b);
  const runs: { x: number; y: number; w: number; h: number }[] = [];
  for (const y of ys) {
    const xs = cells.filter((c) => c[1] === y).map((c) => c[0]).sort((a, b) => a - b);
    let i = 0;
    while (i < xs.length) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
      runs.push({ x: xs[i], y, w: xs[j] - xs[i] + 1, h: 1 });
      i = j + 1;
    }
  }
  const out: typeof runs = [];
  for (const r of runs) {
    const above = out.find((o) => o.x === r.x && o.w === r.w && o.y + o.h === r.y);
    if (above) above.h++;
    else out.push({ ...r });
  }
  return out;
}

function fromCells(id: string, name: string, color: string, rows: string[]): PieceDef {
  const cells = cellsOf(rows);
  const raw = traceCells(cells).map(([x, y]): V2 => [x * CELL, y * CELL]);
  const [cx, cy] = centroid(raw);
  const outline = raw.map(([x, y]): V2 => [x - cx, y - cy]);
  const parts = mergeCells(cells).map((r) => {
    const x0 = r.x * CELL - cx, y0 = r.y * CELL - cy, x1 = x0 + r.w * CELL, y1 = y0 + r.h * CELL;
    return { poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as V2[], box: { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hw: (x1 - x0) / 2, hh: (y1 - y0) / 2 } };
  });
  return { id, name, color, outline, parts, area: area(outline) };
}

function fromPoly(id: string, name: string, color: string, poly: V2[]): PieceDef {
  const raw = poly.map(([x, y]): V2 => [x * CELL, y * CELL]);
  const [cx, cy] = centroid(raw);
  const outline = raw.map(([x, y]): V2 => [x - cx, y - cy]);
  return { id, name, color, outline, parts: [{ poly: outline }], area: area(outline) };
}

export const PIECES: Record<string, PieceDef> = Object.fromEntries([
  ...CELL_PIECES.map((p) => [p.id, fromCells(p.id, p.name, p.color, p.rows)]),
  ...POLY_PIECES.map((p) => [p.id, fromPoly(p.id, p.name, p.color, p.poly)]),
]);

/** A piece's outline turned by `angle` and moved to (x, y). */
export function placed(def: PieceDef, x: number, y: number, angle: number): V2[] {
  const c = dm.cos(angle), s = dm.sin(angle);
  return def.outline.map(([px, py]): V2 => [x + px * c - py * s, y + px * s + py * c]);
}

/** Bounds of a piece's outline at an angle (about its centre). */
export function extent(def: PieceDef, angle: number) {
  const pts = placed(def, 0, 0, angle);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, maxX, minY, maxY };
}

/**
 * The distinct quarter turns of a piece (a block looks the same all four ways round, a slab two):
 * no point trying the same placement twice.
 */
export function distinctTurns(def: PieceDef): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let k = 0; k < 4; k++) {
    const pts = placed(def, 0, 0, (k * Math.PI) / 2).map(([x, y]) => `${Math.round(x * 100)},${Math.round(y * 100)}`).sort().join(' ');
    if (seen.has(pts)) continue;
    seen.add(pts);
    out.push(k);
  }
  return out;
}
