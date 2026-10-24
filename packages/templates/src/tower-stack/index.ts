import { z } from 'zod';
import type { DramaScore, Melody, OverlaySpec, Rng, StepCtx, Template } from '@sim/engine';
import { clamp01, gaussFit } from '../scoring';
import type { Spark } from '../fx';
import { PIECES, PIECE_SETS, extent, type PieceDef } from './pieces';
import { FINE_SPOTS, MAX_GAP, SPOTS, bestNext, holdY, leavesRoom, testDrops, value, type Candidate } from './planner';
import { DropWatch, StackWorld, measure, worlds, type Shape, type Snap } from './world';
import { drawTowerStack3D, drawTowerStackTop, initialCamera, updateCamera, type Cam } from './view3d';

export const TOWER_STACK_MODES = ['daily', 'endless'] as const;

export const towerStackSchema = z.object({
  mode: z.enum(TOWER_STACK_MODES).default('daily').meta({ title: 'Mode' }),
  pieces: z.number().int().min(8).max(30).default(20).meta({ title: 'Pieces (endless: about how long)' }),
  lives: z.number().int().min(1).max(5).default(3).meta({ title: 'Falls allowed' }),
  pieceSet: z.enum(['classic', 'blocky', 'wild']).default('classic').meta({ title: 'Piece set' }),
  skill: z.number().min(0.3).max(1).default(0.8).meta({ title: 'Skill (1 = flawless in endless)', step: 0.05 }),
  grip: z.number().min(0.5).max(1.4).default(1).meta({ title: 'Grip (friction)', step: 0.05 }),
  pace: z.number().min(0.6).max(1.6).default(1).meta({ title: 'Pace', step: 0.05 }),
  look: z.enum(['day', 'night']).default('day').meta({ title: 'Look' }),
  music: z.enum(['placements', 'background']).default('placements').meta({ title: 'Music (placements: a melody note as each piece lands; background: the melody as a soundtrack at its own tempo)' }),
  bass: z.boolean().default(true).meta({ title: 'Soft bass under the background music' }),
});

export type TowerStackParams = z.infer<typeof towerStackSchema>;

/** A real thing the tower is measured against (height in cm). */
export interface Milestone {
  cm: number;
  icon: string;
  name: string;
}

export const MILESTONES: Milestone[] = [
  { cm: 15, icon: '📱', name: 'a phone' },
  { cm: 20, icon: '🐕', name: 'a Chihuahua' },
  { cm: 27, icon: '🐶', name: 'a corgi' },
  { cm: 38, icon: '🎳', name: 'a bowling pin' },
  { cm: 57, icon: '🦮', name: 'a Labrador' },
  { cm: 70, icon: '🧯', name: 'a fire hydrant' },
  { cm: 90, icon: '🐧', name: 'a king penguin' },
  { cm: 115, icon: '🐧', name: 'an emperor penguin' },
  { cm: 130, icon: '🦩', name: 'a flamingo' },
  { cm: 150, icon: '🦘', name: 'a kangaroo' },
  { cm: 170, icon: '🧍', name: 'an adult' },
  { cm: 200, icon: '🚪', name: 'a door' },
  { cm: 250, icon: '🦤', name: 'an ostrich' },
  { cm: 305, icon: '🏀', name: 'a basketball hoop' },
  { cm: 330, icon: '🐘', name: 'an elephant' },
  { cm: 550, icon: '🦒', name: 'a giraffe' },
];

export type Phase = 'intro' | 'think' | 'aim' | 'drop' | 'fallen' | 'rewind' | 'steady' | 'over';

export interface Aim {
  fromX: number;
  fromA: number;
  toX: number;
  toA: number;
  at: number;
  len: number;
  /** Quarter turns already ticked off (for the turn sound). */
  ticks: number;
  /** How far the hand overshoots and comes back (0 for a clean slide). */
  back: number;
}

/** Visual only: a "+12 cm" or a toast. */
export interface Popup {
  text: string;
  sub?: string;
  icon?: string;
  t0: number;
  kind: 'gain' | 'milestone' | 'fall' | 'final';
  /** Its confetti has been thrown. */
  burst?: boolean;
}

export interface State {
  p: TowerStackParams;
  world: StackWorld;
  /** The last steady tower: every test drop, live drop and rollback starts from it. */
  snap: Snap;
  queue: PieceDef[];
  /** Current piece (0-based). */
  index: number;
  lives: number;
  falls: number;
  /** Steady height so far, in cm. */
  height: number;
  shape: Shape;
  phase: Phase;
  phaseAt: number;
  cands: Candidate[];
  /** The turn's thinking, a share of physics steps a frame (see planner). */
  thinking: Generator<number, void> | null;
  thinkFromX: number;
  /** The player's hand this turn: how long it ponders, how it moves and how long it holds. */
  ponder: number;
  hold: number;
  pause: number;
  /** How high above the tower each piece is let go (drawn up front, so a look ahead knows it). */
  gaps: number[];
  /** Placements already dropped this turn (that fell). */
  tried: Candidate[];
  plan: Candidate | null;
  aim: Aim;
  /** The piece held (and dropped) this turn, in the world once let go. */
  held: { x: number; y: number; a: number };
  watch: DropWatch;
  /** Landing sounds for the current drop: last fall speed of the new piece, and when it last hit. */
  lastVy: number;
  lastLandT: number;
  lands: number;
  lastWobbleT: number;
  nextMilestone: number;
  endAt: number | null;
  t: number;
  rng: Rng;
  visual: boolean;
  /** Visual only. */
  cam: Cam;
  sparks: Spark[];
  popups: Popup[];
  fxRng: Rng;
  fallAt: number;
  rewindAt: number;
  /** The melody (transposed) and where the background music has got to. */
  melody: Melody;
  mus: { stepAt: number; idx: number; beatAt: number; beat: number; root: number; notes: number[] };
}

/** World units (10 cm) per second²: a little floatier than real, so falls read clearly. */
const GRAVITY = 50;
const INTRO_S = 0.9;
const AIM_BASE_S = 0.45;
const HOLD_S = 0.14;
/** Physics steps of test drops per frame while the player thinks. */
const STEPS_PER_FRAME = 200;
const FALL_SHOW_S = 1.5;
const REWIND_S = 0.55;
const OUTRO_S = 4;
/** Placements looked at one piece ahead each turn, then checked for room for the next piece. */
const lookahead = (p: TowerStackParams) => (p.skill >= 0.95 ? 5 : 3);
const roomChecks = (p: TowerStackParams) => (p.skill >= 0.95 ? 5 : 3);

/** The background music starts just after the first frame, and keeps a calm puzzle-game tempo. */
const MUSIC_START_S = 0.3;
const MUSIC_BPM = [80, 132] as const;

const smooth = (u: number) => u * u * (3 - 2 * u);
/** Eases out past 1 and back (k sets how far: 1.5 is about 10%). */
const easeOutBack = (u: number, k: number) => 1 + (k + 1) * (u - 1) ** 3 + k * (u - 1) ** 2;
const cmOf = (top: number) => Math.round(top * 10);
const pan = (x: number) => Math.max(-0.6, Math.min(0.6, x / 4));

/** The pieces in order: the set shuffled, again and again, so every piece comes up regularly. */
function buildQueue(rng: Rng, set: keyof typeof PIECE_SETS, n: number): PieceDef[] {
  const out: PieceDef[] = [];
  while (out.length < n) {
    const bag = [...PIECE_SETS[set]];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    // The opening piece is a steady one, as in the real game (a bridge or a slab).
    if (!out.length) {
      const k = bag.findIndex((id) => id === 'bridge' || id === 'slab' || id === 'notched');
      if (k > 0) [bag[0], bag[k]] = [bag[k], bag[0]];
    }
    out.push(...bag.map((id) => PIECES[id]));
  }
  return out.slice(0, n);
}

const totalPieces = (p: TowerStackParams) => (p.mode === 'daily' ? p.pieces : p.pieces * 2);

export const towerStack: Template<TowerStackParams, State> = {
  id: 'tower-stack',
  name: 'Tower Stack',
  family: 'kinetic',
  category: 'brainy',
  description:
    'A run of the daily stacking puzzle game, seen as the player plays it. Chunky toy pieces with names (Bridge, Step, Notched beam, Counterbeam, Mesa, Ramp…) come one at a time; the player drags each one over the tower, turns it and lets go, and real physics decides whether it holds. A good player builds a broad base first and goes for height with the last pieces, but now and then a piece tips the tower: a heart is lost and the game rewinds to the last steady tower. A ruler climbs the side, with real things to beat (a corgi, a fire hydrant, an emperor penguin, a door). Daily: {pieces} pieces, how tall can it get? Endless: it keeps going until the falls run out.',
  schema: towerStackSchema,
  substeps: 1,
  searchBudget: 12,
  glowScale: 0,
  maxSeconds: (p) => 20 + (totalPieces(p) * 3.4) / p.pace,
  defaultCopy: {
    hook: 'How tall can this tower get? 📏',
    cta: '{result} Could you beat it? 👇',
  },
  nudges: ['Guess the final height 👇', 'How many cm will it reach? 👇', 'Will it fall? 👇', 'Could you do better? 👇', 'Call the final height 👇'],

  init({ params: p, rng, fxRng, visual, melody }) {
    const world = new StackWorld(GRAVITY, p.grip);
    const s: State = {
      p,
      world,
      snap: world.save(),
      queue: buildQueue(rng, p.pieceSet, totalPieces(p)),
      index: 0,
      lives: p.lives,
      falls: 0,
      height: 0,
      shape: measure([]),
      phase: 'intro',
      phaseAt: 0,
      cands: [],
      tried: [],
      thinking: null,
      thinkFromX: 0,
      ponder: 0,
      hold: HOLD_S,
      pause: 0,
      gaps: [],
      plan: null,
      aim: { fromX: 0, fromA: 0, toX: 0, toA: 0, at: 0, len: 1, ticks: 0, back: 0 },
      held: { x: 0, y: 0, a: 0 },
      watch: new DropWatch(),
      lastVy: 0,
      lastLandT: -1,
      lands: 0,
      lastWobbleT: -1,
      nextMilestone: 0,
      endAt: null,
      t: 0,
      rng,
      visual,
      cam: undefined as unknown as Cam,
      sparks: [],
      popups: [],
      fxRng,
      fallAt: -10,
      rewindAt: -10,
      melody,
      mus: { stepAt: MUSIC_START_S, idx: 0, beatAt: MUSIC_START_S, beat: 0, root: Math.min(...melody.steps[0]), notes: melody.steps[0] },
    };
    // A player lets go a little above the tower, some pieces closer than others: never higher than
    // MAX_GAP, often well under it.
    s.gaps = s.queue.map(() => (rng.chance(0.55) ? rng.range(0.1, 0.3) : rng.range(0.3, MAX_GAP)));
    s.cam = initialCamera(s);
    worlds.register(s, world);
    return s;
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    const { p } = s;
    if (p.music === 'background') runMusic(s, t, dt, emit);
    switch (s.phase) {
      case 'intro':
        if (t >= INTRO_S) startTurn(s, t, emit);
        break;
      case 'think': {
        // A share of physics steps a frame (not of test drops, which vary a lot in length), so the
        // thinking is spread evenly over the frames.
        let budget = STEPS_PER_FRAME;
        while (s.thinking && budget > 0) {
          const r = s.thinking.next();
          if (r.done) s.thinking = null;
          else budget -= r.value;
        }
        // The player hesitates a moment, however quickly the choice is made.
        if (!s.thinking && t >= s.phaseAt + s.ponder) decide(s, t);
        else {
          // Meanwhile the piece drifts over toward the top of the tower.
          const u = smooth(clamp01((t - s.phaseAt) / 0.6));
          s.held.x = s.thinkFromX + ((s.shape.topMinX + s.shape.topMaxX) / 2 - s.thinkFromX) * 0.5 * u;
        }
        break;
      }
      case 'aim': {
        const u = clamp01((t - s.aim.at) / s.aim.len);
        // A hand slides fast, slows into place and sometimes overshoots a touch and comes back.
        const e = s.aim.back > 0 ? easeOutBack(u, s.aim.back) : smooth(u);
        const a = s.aim.fromA + (s.aim.toA - s.aim.fromA) * e;
        const ticks = Math.floor(Math.abs(a - s.aim.fromA) / (Math.PI / 2) + 1e-6);
        if (ticks > s.aim.ticks) {
          s.aim.ticks = ticks;
          emit({ type: 'turn', x: s.held.x });
        }
        const x = s.aim.fromX + (s.aim.toX - s.aim.fromX) * e;
        // Carried over the tower, clear of everything still between it and its spot however it is
        // turned on the way, then lowered onto the spot it was tested at.
        const def = s.queue[s.index];
        let want = s.plan!.y;
        for (let k = 0; k <= 6; k++) want = Math.max(want, holdY(def, x + ((s.aim.toX - x) * k) / 6, a, s.world.pieces, s.gaps[s.index]));
        s.held = { x, y: want > s.held.y ? want : Math.max(want, s.held.y - 9 * dt), a };
        if (t >= s.aim.at + s.aim.len + s.hold / p.pace) letGo(s, t, emit);
        break;
      }
      case 'drop': {
        s.world.advance();
        const r = s.watch.update(s.world);
        dropSounds(s, t, emit);
        if (r === 'fell') fell(s, t, emit);
        else if (r !== 'moving') steady(s, t, emit);
        break;
      }
      case 'fallen':
        // The tumble is only for show (nothing in it changes the run): headless runs skip it.
        if (s.visual) s.world.advance();
        if (t >= s.phaseAt + FALL_SHOW_S) {
          s.world.restore(s.snap);
          if (s.lives <= 0) return finish(s, t, emit);
          s.phase = 'rewind';
          s.phaseAt = t;
          s.rewindAt = t;
          emit({ type: 'rewind', lives: s.lives });
        }
        break;
      case 'rewind':
        if (t >= s.phaseAt + REWIND_S / p.pace) {
          // Try the same piece again: the AI already knows which spots hold.
          aimAt(s, t, choose(s, false));
        }
        break;
      case 'steady':
        if (t >= s.phaseAt + s.pause / p.pace) startTurn(s, t, emit);
        break;
      case 'over':
        break;
    }
    if (s.visual) updateCamera(s, t, dt);
  },

  isDone(s) {
    const done = s.endAt !== null && s.t >= s.endAt + OUTRO_S;
    if (done) s.world.free();
    return done;
  },

  hud(s) {
    const over = s.endAt !== null;
    const passed = MILESTONES.filter((m) => m.cm <= s.height).pop();
    const result = s.lives <= 0 ? `${s.height} cm before the last fall!` : s.p.mode === 'endless' ? `${s.height} cm and still standing!` : `${s.height} cm tall!`;
    return {
      height: s.height,
      piece: Math.min(s.index + 1, s.queue.length),
      falls: s.falls,
      result,
      tallerThan: passed ? passed.name : '',
      outro: over && s.t >= s.endAt! + 0.8,
    };
  },

  overlays(_p, copy): OverlaySpec[] {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.8, y: 0.1 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.11 },
    ];
  },

  render(rc, s) {
    drawTowerStack3D(rc.ctx, s, rc.t);
  },

  renderTop(rc, s) {
    drawTowerStackTop(rc.ctx, s, rc.t);
  },

  audio(e, { melody, theme, lastNoteT }) {
    const x = typeof e.x === 'number' ? pan(e.x) : 0;
    // With background music the landings only knock, and the bells ring in the soundtrack's chord.
    const bg = Array.isArray(e.notes);
    switch (e.type) {
      case 'mnote':
        return (e.notes as number[]).map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? 0.12 : 0.27, voice: theme.voice, dur: e.dur as number, bright: 0.8 }));
      case 'mbass':
        return [{ kind: 'note', midi: e.midi as number, vel: 0.26, voice: 'bass', dur: e.dur as number, bright: 0.6 }];
      case 'spawn':
        return [{ kind: 'sfx', name: 'pop', vel: 0.18, pitch: 1.3, pan: x }];
      case 'turn':
        return [{ kind: 'sfx', name: 'tick', vel: 0.3, pitch: 1.4, pan: x }];
      case 'drop':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.18, pitch: 1.3, pan: x }];
      case 'land': {
        const v = clamp01((e.speed as number) / 6);
        const knock = { kind: 'sfx' as const, name: 'knock' as const, vel: 0.25 + 0.5 * v, pitch: 0.9 + 0.3 * v, pan: x };
        if (e.first && e.bg) return [knock];
        if (e.first && e.t - lastNoteT > 0.08) return [knock, ...melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: (i ? 0.2 : 0.42) + 0.2 * v, voice: theme.voice, pan: x }))];
        return [{ ...knock, vel: knock.vel * 0.6, name: 'clack' as const }];
      }
      case 'wobble':
        return [{ kind: 'sfx', name: 'knock', vel: 0.16, pitch: 0.55, pan: x }];
      case 'settle':
        return [{ kind: 'sfx', name: 'pop', vel: 0.35, pitch: 0.9 + Math.min(0.8, (e.height as number) / 250), pan: x }];
      case 'milestone':
        return [
          { kind: 'sfx', name: 'chime', vel: 0.55, pitch: 1.1 },
          ...(bg ? (e.notes as number[]).slice(0, 1) : melody.peek()).map((midi) => ({ kind: 'note' as const, midi: midi + 12, vel: 0.4, voice: 'bell' as const, dur: 1.2 })),
        ];
      case 'fall':
        return [
          { kind: 'sfx', name: 'gasp', vel: 0.45 },
          { kind: 'sfx', name: 'boom', vel: 0.35, pitch: 0.6, pan: x },
        ];
      case 'rewind':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.4, pitch: 1.7 }];
      case 'end':
        return [
          { kind: 'sfx', name: e.cleared ? 'cheer' : 'gasp', vel: 0.6 },
          { kind: 'sfx', name: 'chime', vel: 0.7 },
          ...(bg ? (e.notes as number[]) : melody.peek()).flatMap((midi) => [
            { kind: 'note' as const, midi, vel: 0.6, voice: 'bell' as const, dur: 2.4 },
            { kind: 'note' as const, midi: midi + 12, vel: 0.4, voice: 'bell' as const, dur: 2.4 },
          ]),
        ];
    }
    return [];
  },

  score(events, { durationS, targetS, timedOut }): DramaScore {
    const end = events.find((e) => e.type === 'end');
    const durFit = gaussFit(durationS, targetS, targetS * 0.3);
    if (timedOut || !end) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no finish'] };
    const placed = end.placed as number;
    const height = end.height as number;
    // Around 8 cm a piece is a good tower; 4 or less a flat heap.
    const heightFit = clamp01(((height / Math.max(1, placed)) - 4) / 5);
    const falls = events.filter((e) => e.type === 'fall').length;
    // A fall or two is the drama; losing every heart is only good in endless mode.
    const fallFit = end.mode === 'endless' ? (end.cleared ? 0.3 : 1) : !end.cleared ? 0.35 : falls === 1 ? 1 : falls === 2 ? 0.85 : falls === 0 ? 0.45 : 0.5;
    const wobbles = events.filter((e) => e.type === 'wobble').length;
    const wobbleFit = clamp01(wobbles / 8);
    const mileFit = clamp01(events.filter((e) => e.type === 'milestone').length / 6);
    const total = durFit * (0.3 + 0.3 * heightFit + 0.2 * fallFit + 0.1 * wobbleFit + 0.1 * mileFit);
    return { total, parts: { durFit, heightFit, fallFit, wobbleFit, mileFit }, notes: [`${height} cm from ${placed} pieces`, `${falls} falls`] };
  },

  outcome(events) {
    const end = events.find((e) => e.type === 'end');
    if (!end) return null;
    const bucket = Math.floor((end.height as number) / 25) * 25;
    return `${bucket}–${bucket + 25} cm${end.cleared ? '' : ', out of falls'}`;
  },
};

/** A new piece: test-drop it everywhere, pick a spot, and start sliding it over. */
function startTurn(s: State, t: number, emit: StepCtx['emit']) {
  const def = s.queue[s.index];
  s.snap = s.world.save();
  s.shape = measure(s.world.pieces);
  s.tried = [];
  s.thinking = think(s);
  // Enters from where the last piece was let go, unturned.
  const fromX = s.plan ? s.plan.x * 0.5 : -1.2;
  s.held = { x: fromX, y: s.shape.top + 1.2 - extent(def, 0).minY, a: 0 };
  s.thinkFromX = fromX;
  // This turn's rhythm: a pause before the next piece, a moment's thought, a hold before letting go.
  // Each varies, around the same average pace.
  s.ponder = s.rng.range(0.05, 0.4) / s.p.pace;
  s.hold = s.rng.chance(0.7) ? s.rng.range(0.04, 0.2) : s.rng.range(0.2, 0.42);
  s.phase = 'think';
  s.phaseAt = t;
  emit({ type: 'spawn', piece: def.id, index: s.index });
}

/** The AI's thinking for a turn: test-drop everywhere, then rank what held. */
function* think(s: State): Generator<number, void> {
  s.cands = yield* testDrops(s.world, s.snap, s.queue[s.index], s.shape, s.gaps[s.index], s.p.skill >= 0.95 ? FINE_SPOTS : SPOTS);
  yield* rank(s);
}

/**
 * Thinking done: sometimes the player misjudges. Never with the last heart in daily mode (so the run
 * can finish), and in endless mode a flawless player (skill 1) never does: it only falls when nothing
 * would hold. In daily mode even a flawless player slips now and then, for the suspense.
 */
function decide(s: State, t: number) {
  const p = s.p;
  const sloppy = 1 - p.skill;
  const ramp = p.mode === 'endless' ? 0.55 * clamp01((s.index - p.pieces * 0.6) / p.pieces) * Math.min(1, sloppy * 5) : 0;
  const lastHeart = s.lives <= 1 && p.mode === 'daily';
  const chance = sloppy * 0.25 + ramp + (p.mode === 'daily' ? 0.025 : 0);
  const blunder = s.index >= 2 && !lastHeart && s.rng.chance(chance);
  aimAt(s, t, choose(s, blunder));
}

/**
 * How far through the run a piece is (0 to 1), which is when a player starts going for height. In
 * endless mode there is no last piece to save height for: it builds steadily the whole way.
 */
const progressOf = (s: State, index: number) => (s.p.mode === 'endless' ? 0.5 : clamp01(index / Math.max(1, s.queue.length - 1)));

/**
 * Score every placement that held, with a look one piece ahead for the most promising few: a
 * placement that leaves nowhere for the next piece to go is a dead end.
 */
function* rank(s: State): Generator<number, void> {
  const progress = progressOf(s, s.index);
  const ok = s.cands.filter((c) => c.result === 'settled');
  for (const c of ok) c.value = value(c, s.shape, progress);
  const next = s.queue[s.index + 1];
  if (next) {
    // Best first: the top few are played one piece ahead in full, the next few just checked for room.
    // Only those that leave room are kept in the running (unless none do).
    const order = [...ok].sort((a, b) => b.value! - a.value!);
    let looked = 0;
    for (const c of order) {
      if (looked >= lookahead(s.p) + roomChecks(s.p)) break;
      if (looked < lookahead(s.p)) {
        const ahead = yield* bestNext(s.world, s.snap, s.queue[s.index], c, next, s.gaps[s.index + 1], progressOf(s, s.index + 1));
        if (ahead === null) c.dead = true;
        else {
          c.value! += 0.4 * ahead.best + 2.5 * ahead.share;
          c.room = true;
          looked++;
        }
      } else if (yield* leavesRoom(s.world, s.snap, s.queue[s.index], c, next, s.gaps[s.index + 1])) {
        c.value! -= 0.2;
        c.room = true;
        looked++;
      } else c.dead = true;
    }
    s.world.restore(s.snap);
  }
}

/** The AI's pick from this turn's test drops. */
function choose(s: State, blunder: boolean): Candidate {
  const held = s.cands.filter((c) => c.result === 'settled');
  // Placements known to leave room for the next piece first, then any not known to be dead ends.
  const ok = held.some((c) => c.room) ? held.filter((c) => c.room) : held.some((c) => !c.dead) ? held.filter((c) => !c.dead) : held;
  // Never the same fall twice in a turn.
  const fresh = s.cands.filter((c) => c.result === 'fell' && !s.tried.includes(c));
  const falls = fresh.length ? fresh : s.cands.filter((c) => c.result === 'fell');
  // A misjudged drop: one that tips over, the later the better (it looks fine, then goes).
  if (blunder && falls.length) return falls.reduce((a, b) => (b.steps > a.steps ? b : a));
  const pool = ok.length ? ok : s.cands.filter((c) => c.result === 'timeout');
  if (!pool.length) return falls.reduce((a, b) => (b.steps > a.steps ? b : a));
  const noise = (1 - s.p.skill) * 1.1;
  let best = pool[0];
  let bestV = -Infinity;
  for (const c of pool) {
    const v = (c.value ?? value(c, s.shape, progressOf(s, s.index))) + s.rng.range(0, noise);
    if (v > bestV) {
      bestV = v;
      best = c;
    }
  }
  return best;
}

function aimAt(s: State, t: number, c: Candidate) {
  s.plan = c;
  // Turn the short way round to the chosen quarter turn.
  let toA = (c.turn * Math.PI) / 2;
  const fromA = s.held.a;
  while (toA - fromA > Math.PI + 1e-6) toA -= 2 * Math.PI;
  while (fromA - toA > Math.PI + 1e-6) toA += 2 * Math.PI;
  const dist = Math.abs(c.x - s.held.x) + Math.abs(toA - fromA) * 0.4;
  // Some moves are quicker, some more careful; a third overshoot a little and come back.
  const len = ((AIM_BASE_S + Math.min(0.6, dist * 0.22)) * s.rng.range(0.7, 1.25)) / s.p.pace;
  const back = s.rng.chance(0.35) && dist > 0.4 ? s.rng.range(0.6, 1.5) : 0;
  s.aim = { fromX: s.held.x, fromA, toX: c.x, toA, at: t, len, ticks: 0, back };
  s.phase = 'aim';
  s.phaseAt = t;
}

function letGo(s: State, t: number, emit: StepCtx['emit']) {
  const c = s.plan!;
  const def = s.queue[s.index];
  // Exactly as it was tested: from the last steady tower, at the tested pose.
  s.world.restore(s.snap);
  s.held = { x: c.x, y: c.y, a: (c.turn * Math.PI) / 2 };
  s.world.add(def, c.x, c.y, (c.turn * Math.PI) / 2);
  s.watch = new DropWatch();
  s.lastVy = 0;
  s.lands = 0;
  s.phase = 'drop';
  s.phaseAt = t;
  emit({ type: 'drop', piece: def.id, x: c.x, turn: c.turn, expect: c.result });
}

/** Knocks as the new piece lands and bounces, creaks as the tower beneath it shifts. */
function dropSounds(s: State, t: number, emit: StepCtx['emit']) {
  const pieces = s.world.pieces;
  const me = pieces[pieces.length - 1];
  const hit = me.vy - s.lastVy;
  if (hit > 1.2 && s.lastVy < -0.6 && t - s.lastLandT > 0.1 && s.lands < 4) {
    emit({ type: 'land', speed: -s.lastVy, first: s.lands === 0, bg: s.p.music === 'background', x: me.x });
    s.lands++;
    s.lastLandT = t;
  }
  s.lastVy = me.vy;
  if (t - s.lastWobbleT > 0.35)
    for (let i = 0; i < pieces.length - 1; i++)
      if (Math.abs(pieces[i].w) > 0.5) {
        emit({ type: 'wobble', x: pieces[i].x });
        s.lastWobbleT = t;
        break;
      }
}

function steady(s: State, t: number, emit: StepCtx['emit']) {
  s.shape = measure(s.world.pieces);
  const height = cmOf(s.shape.top);
  const gain = height - s.height;
  s.height = height;
  const def = s.queue[s.index];
  emit({ type: 'settle', piece: def.id, height, gain, x: s.plan!.x, steps: s.watch.steps });
  if (s.visual) s.popups.push({ text: `${gain >= 0 ? '+' : ''}${gain} cm`, t0: t, kind: 'gain' });
  while (s.nextMilestone < MILESTONES.length && MILESTONES[s.nextMilestone].cm <= height) {
    const m = MILESTONES[s.nextMilestone++];
    emit({ type: 'milestone', cm: m.cm, name: m.name, ...musicNotes(s) });
    if (s.visual) s.popups.push({ text: `Taller than ${m.name}!`, sub: `${cap(m.name)} is about ${m.cm} cm tall.`, icon: m.icon, t0: t, kind: 'milestone' });
  }
  s.index++;
  if (s.index >= s.queue.length) return finish(s, t, emit);
  s.world.lockDeep();
  s.phase = 'steady';
  s.phaseAt = t;
  s.pause = s.rng.chance(0.75) ? s.rng.range(0, 0.25) : s.rng.range(0.25, 0.6);
  s.snap = s.world.save();
}

function fell(s: State, t: number, emit: StepCtx['emit']) {
  s.lives--;
  s.falls++;
  s.tried.push(s.plan!);
  s.fallAt = t;
  // Misjudged: something would have held. Cornered: nothing tested held.
  const why = s.cands.some((c) => c.result !== 'fell') ? 'misjudged' : 'cornered';
  emit({ type: 'fall', piece: s.queue[s.index].id, pieceIndex: s.index, lives: s.lives, x: s.plan!.x, height: s.height, why });
  if (s.visual) s.popups.push({ text: s.lives > 0 ? 'It fell!' : 'Out of falls!', sub: s.lives > 0 ? 'Back to the last steady tower' : `Final height ${s.height} cm`, t0: t, kind: 'fall' });
  s.phase = 'fallen';
  s.phaseAt = t;
}

function finish(s: State, t: number, emit: StepCtx['emit']) {
  s.phase = 'over';
  s.phaseAt = t;
  s.endAt = t;
  s.shape = measure(s.world.pieces);
  const cleared = s.lives > 0;
  emit({ type: 'end', height: s.height, placed: s.world.pieces.length, falls: s.falls, cleared, mode: s.p.mode, ...musicNotes(s) });
  if (s.visual) s.popups.push({ text: `${s.height} cm`, t0: t, kind: 'final' });
}

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/**
 * Background music: the melody at its own tempo (held to a calm MUSIC_BPM range), looping, with a
 * soft bass on every other beat (the root of the latest chord in the tune). Independent of the game.
 */
function runMusic(s: State, t: number, dt: number, emit: StepCtx['emit']) {
  const m = s.melody;
  const bpm = Math.max(MUSIC_BPM[0], Math.min(MUSIC_BPM[1], m.bpm ?? 100));
  const beat = 60 / bpm;
  const unit = beat * (m.unit ?? 1);
  const mu = s.mus;
  while (mu.stepAt < t + dt) {
    const i = mu.idx % m.steps.length;
    const notes = m.steps[i];
    const dur = (m.beats?.[i] ?? 1) * unit;
    emit({ type: 'mnote', notes, dur: Math.round(dur * 0.92 * 1000) / 1000 });
    mu.notes = notes;
    if (notes.length > 1) mu.root = Math.min(...notes);
    mu.stepAt += dur;
    mu.idx++;
  }
  while (mu.beatAt < t + dt) {
    if (s.p.bass && mu.beat % 2 === 0) emit({ type: 'mbass', midi: 36 + (((mu.root % 12) + 12) % 12), dur: Math.round(beat * 1.7 * 1000) / 1000 });
    mu.beat++;
    mu.beatAt += beat;
  }
}

/** For bells over the background music: the chord it is playing now (nothing without it). */
const musicNotes = (s: State) => (s.p.music === 'background' ? { notes: s.mus.notes } : {});
