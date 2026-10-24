/**
 * The AI player: for each piece it test-drops every placement worth trying (a spread of spots across
 * the top of the tower, every distinct quarter turn) on an exact copy of the world, and keeps how each
 * one came out. Because the world restores exactly, the live drop of a tested placement plays out
 * identically to its test. The searches are generators that yield the physics steps of every test
 * drop, so a turn's thinking can be spread evenly over a few frames.
 */
import { BASE_HW, DropWatch, measure, skyline, type PieceBody, type Shape, type Snap, type StackWorld, type DropState } from './world';
import { extent, distinctTurns, type PieceDef } from './pieces';

/** The most a piece is let go above the tower (5 cm); each piece has its own gap up to this. */
export const MAX_GAP = 0.5;
/**
 * Spots across the tower: 13 (17 for the best players), so the look-ahead's 5 (every quarter of the
 * way) are among them.
 */
export const SPOTS = 13;
export const FINE_SPOTS = 17;
const NEXT_SPOTS = 5;
const TOP_SPOTS = [0, -0.5, 0.5, -1, 1];

export interface Candidate {
  x: number;
  /** Quarter turns. */
  turn: number;
  /** Where the piece's centre is held before it is let go. */
  y: number;
  result: DropState;
  /** Steps until it settled or fell. */
  steps: number;
  after: Shape;
  /** How far the pieces already standing were knocked (world units, plus radians). */
  disturb: number;
  /** The AI's opinion of it (set when it is ranked). */
  value?: number;
  /** Looked at one piece ahead: the next piece has somewhere to go, or nowhere. */
  room?: boolean;
  dead?: boolean;
}

/** Held so that its lowest point is `gap` above the tower beneath it. */
export function holdY(def: PieceDef, x: number, angle: number, pieces: PieceBody[], gap: number): number {
  const e = extent(def, angle);
  return skyline(pieces, x + e.minX, x + e.maxX) + gap - e.minY;
}

export function* testDrops(w: StackWorld, snap: Snap, def: PieceDef, before: Shape, gap: number, spots = SPOTS, topSpots = TOP_SPOTS): Generator<number, Candidate[]> {
  const out: Candidate[] = [];
  // Anywhere over the tower: on its peak, or down on a ledge beside it.
  const lo = Math.max(-BASE_HW - 0.6, before.minX - 0.3);
  const hi = Math.min(BASE_HW + 0.6, before.maxX + 0.3);
  const pieces = w.pieces;
  const turns = distinctTurns(def);
  // Pieces that look the same turned round get more spots instead (a finer grid that keeps every
  // spot of the coarse one, so a spot the look-ahead found is tried again when the piece comes up).
  const n = (spots - 1) * (turns.length < 3 ? 2 : 1) + 1;
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(lo + ((hi - lo) * i) / (n - 1));
  // And always a few right over the top, where a narrow peak needs a precise drop.
  const mid = (before.topMinX + before.topMaxX) / 2;
  const half = (before.topMaxX - before.topMinX) / 2 + 0.3;
  for (const k of topSpots) xs.push(mid + k * half);
  for (const turn of turns) {
    const a = (turn * Math.PI) / 2;
    for (const raw of xs) {
      // Spots on a 2.5 cm grid, so the same spot is tried the same way every time.
      const x = Math.round(raw * 40) / 40;
      if (out.some((c) => c.turn === turn && c.x === x)) continue;
      out.push(yield* testDrop(w, snap, def, x, turn, holdY(def, x, a, pieces, gap)));
    }
  }
  w.restore(snap);
  return out;
}

/** A test drop yields every this many physics steps, so no frame of thinking runs long. */
const CHUNK = 40;

export function* testDrop(w: StackWorld, snap: Snap, def: PieceDef, x: number, turn: number, y: number): Generator<number, Candidate> {
  w.restore(snap);
  const old = w.pieces.map((p) => ({ x: p.x, y: p.y, a: p.a }));
  w.add(def, x, y, (turn * Math.PI) / 2);
  const watch = new DropWatch();
  let result: DropState = 'moving';
  while (result === 'moving') {
    w.advance();
    result = watch.update(w);
    if (watch.steps % CHUNK === 0) yield CHUNK;
  }
  yield watch.steps % CHUNK;
  let disturb = 0;
  old.forEach((o, i) => {
    const p = w.pieces[i];
    disturb += Math.abs(p.x - o.x) + Math.abs(p.y - o.y) + Math.abs(p.a - o.a);
  });
  return { x, turn, y, result, steps: watch.steps, after: measure(w.pieces), disturb };
}

/**
 * How much the AI likes a placement that held. Like a good player it builds a broad, steady base
 * first (a wide flat top to land the next piece on, the weight over the platform, nothing knocked)
 * and only goes for height over the last quarter of the pieces: the last one is pure height.
 * `progress` runs from 0 (first piece) to 1 (last).
 */
export function value(c: Candidate, before: Shape, progress: number): number {
  const gain = c.after.top - before.top;
  const width = Math.min(3, c.after.flat);
  const narrow = Math.max(0, 1.4 - width);
  const lean = Math.abs(c.after.comX) / BASE_HW + c.after.overhang / 1.5;
  const late = Math.max(0, (progress - 0.75) / 0.25) ** 2;
  return (0.35 + 0.65 * late) * gain + (1 - late) * (0.6 * width - 2 * narrow - 1.2 * lean - 1.2 * c.disturb);
}

/**
 * One piece ahead: build the tower this placement leaves, then see whether the next piece has
 * anywhere to go on it, trying the likeliest spots first (flat, near the middle of the top) and
 * stopping at the first that holds. False is a dead end: every spot tried falls.
 */
export function* leavesRoom(w: StackWorld, snap: Snap, def: PieceDef, c: Candidate, next: PieceDef, gap: number): Generator<number, boolean> {
  yield* testDrop(w, snap, def, c.x, c.turn, c.y);
  w.lockDeep();
  const snap2 = w.save();
  const shape = measure(w.pieces);
  const pieces = w.pieces;
  const mid = (shape.topMinX + shape.topMaxX) / 2;
  const half = (shape.topMaxX - shape.topMinX) / 2 + 0.3;
  const tries: { x: number; turn: number }[] = [];
  for (const turn of distinctTurns(next).sort((a, b) => flatness(next, b) - flatness(next, a)))
    for (const k of TOP_SPOTS) tries.push({ x: Math.round((mid + k * half) * 40) / 40, turn });
  for (const { x, turn } of tries) {
    const n = yield* testDrop(w, snap2, next, x, turn, holdY(next, x, (turn * Math.PI) / 2, pieces, gap));
    if (n.result === 'settled') return true;
  }
  return false;
}

/**
 * One piece ahead, in full: on the tower this placement leaves, the best the next piece could do (by
 * value) over a coarser spread of spots, and the share of those spots that hold (a forgiving top
 * has many). Null when every spot falls.
 */
export function* bestNext(w: StackWorld, snap: Snap, def: PieceDef, c: Candidate, next: PieceDef, gap: number, progressNext: number): Generator<number, { best: number; share: number } | null> {
  yield* testDrop(w, snap, def, c.x, c.turn, c.y);
  // The tower exactly as the next turn will find it.
  w.lockDeep();
  const snap2 = w.save();
  const shape = measure(w.pieces);
  const tests = yield* testDrops(w, snap2, next, shape, gap, NEXT_SPOTS, TOP_SPOTS.slice(0, 3));
  const held = tests.filter((n) => n.result === 'settled');
  if (!held.length) return null;
  return { best: Math.max(...held.map((n) => value(n, shape, progressNext))), share: held.length / tests.length };
}

/** Wide and low first. */
const flatness = (def: PieceDef, turn: number) => {
  const e = extent(def, (turn * Math.PI) / 2);
  return e.maxX - e.minX - (e.maxY - e.minY);
};
