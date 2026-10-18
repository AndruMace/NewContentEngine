/**
 * Build-and-simulate: generates a machine for a seed by adding modules one at a time below the last,
 * simulating each until it hands the marble on, and rolling back to try something else when it
 * doesn't. The result is a machine that is known to work, plus the tape of it working.
 */
import type { Rng } from '@sim/engine';
import { FINALES, MODULES, RAMP, START, type Ctx, type Entry, type ModuleDef, type Placed } from './modules/index';
import { DT, Sim, type Mark, type TapeEvent } from './sim';

export interface Stage {
  kind: string;
  showpiece: boolean;
  /** Steps when the marble entered (left the stage above) and when it left this one. */
  from: number;
  to: number;
  /** The marble carrying the run through this stage. */
  marble: number;
}

export interface Machine {
  sim: Sim;
  stages: Stage[];
  /** Total physics steps on the tape (the video's length). */
  steps: number;
  retries: number;
}

const MAX_TRIES = 5;
/** Physics after the finale: the bell rings out while the camera pulls back to the whole machine. */
const OUTRO_S = 3.6;

export interface GenerateOptions {
  /** The machine runs until about this long, then the finale. */
  targetS: number;
  marble: 'glass' | 'steel';
  modules?: ModuleDef[];
  finales?: ModuleDef[];
  /** Debugging: told about every module that didn't work, and where the marble was. */
  onFail?: (kind: string, sim: Sim, entry: Entry) => void;
}

/** Run until the module hands off or fails (or runs out of time). Events are checked as they come. */
function run(sim: Sim, placed: Placed): Entry | 'fail' {
  const deadline = sim.step + Math.round(placed.timeout / DT);
  while (sim.step < deadline) {
    placed.tick?.(sim);
    const before = sim.events.length;
    sim.advance();
    const res = placed.check(sim, sim.events.slice(before) as TapeEvent[]);
    if (res) return res;
  }
  return 'fail';
}

/** Share of stages after a contraption that are a plain ramp (a breather) rather than the next one. */
const RAMP_SHARE = 0.33;

function pick(rng: Rng, pool: ModuleDef[], last: string[], sinceShow: number): ModuleDef {
  const prev = last[last.length - 1];
  const ramp = pool.find((m) => !m.showpiece);
  // After a contraption, sometimes a plain ramp; otherwise (and always after a ramp) another
  // contraption, never the same kind twice running.
  if (ramp && sinceShow === 0 && rng.chance(RAMP_SHARE)) return ramp;
  const shows = pool.filter((m) => m.showpiece && m.kind !== prev);
  // Contraptions this machine hasn't shown yet come first: every kind appears before any repeats.
  const fresh = shows.filter((m) => !last.includes(m.kind));
  const from = fresh.length ? fresh : shows.length ? shows : pool.filter((m) => m.kind !== prev);
  return from.length ? from[rng.int(0, from.length - 1)] : pool[0];
}

export function generate(rng: Rng, o: GenerateOptions): Machine {
  const sim = new Sim();
  let hue = 0;
  const ctx: Ctx = { sim, rng, marble: o.marble, hue: () => hue++ };
  const pool = o.modules ?? MODULES;
  const finales = o.finales ?? FINALES;
  const stages: Stage[] = [];
  let retries = 0;

  sim.recordFrame();
  const start = START.build(ctx);
  let res = run(sim, start.placed);
  if (res === 'fail') throw new Error('start module failed');
  stages.push({ kind: 'start', showpiece: false, from: 0, to: sim.step, marble: start.marble });
  const kinds = ['start'];
  const finaleAt = o.targetS - OUTRO_S - 3;
  // A stack of placed stages, each with the mark taken before it and the marble that entered it, so
  // a dead end can back up and try something else one stage earlier.
  const placedStack: { mark: Mark; entry: Entry; sinceShow: number }[] = [];
  let entry: Entry = res;
  let sinceShow = 1;
  let backtracks = 0;
  /** Kinds that already led to a dead end at a given stage index (don't pick them there again). */
  const banned = new Map<number, Set<string>>();

  for (let guard = 0; guard < 80; guard++) {
    const finale = sim.t >= finaleAt;
    const mark = sim.mark();
    const slot = stages.length;
    const ban = banned.get(slot) ?? new Set<string>();
    let done: Entry | null = null;
    /** A finicky module gets its extra tries (fresh parameters) before something else is picked. */
    let again: { def: ModuleDef; left: number } | null = null;
    for (let attempt = 0; attempt <= MAX_TRIES && !done; attempt++) {
      const choices = pool.filter((m) => !ban.has(m.kind));
      const retrying: ModuleDef | null = again && again.left > 0 ? again.def : null;
      const def: ModuleDef = retrying ?? (finale ? finales[rng.int(0, finales.length - 1)] : attempt >= MAX_TRIES - 1 && !ban.has('ramp') ? RAMP : pick(rng, choices.length ? choices : pool, kinds, sinceShow));
      if (retrying && again) {
        again.left--;
        attempt--;
      } else again = def.tries ? { def, left: def.tries - 1 } : null;
      const from = sim.step;
      const placed = def.build(ctx, entry);
      res = run(sim, placed);
      if (res === 'fail') {
        o.onFail?.(def.kind, sim, entry);
        sim.rollback(mark);
        retries++;
        continue;
      }
      done = res;
      placedStack.push({ mark, entry, sinceShow });
      stages.push({ kind: def.kind, showpiece: def.showpiece, from, to: sim.step, marble: res.marble });
      kinds.push(def.kind);
      sinceShow = def.showpiece ? 0 : sinceShow + 1;
    }
    if (!done) {
      // Dead end: undo the stage before this one and ban its kind there, then carry on from it.
      const prev = placedStack.pop();
      if (!prev || backtracks >= 4) throw new Error(`no module would work after ${kinds.join(' → ')}`);
      backtracks++;
      const kind = stages.pop()!.kind;
      kinds.pop();
      const at = stages.length;
      banned.set(at, new Set([...(banned.get(at) ?? []), kind]));
      sim.rollback(prev.mark);
      entry = prev.entry;
      sinceShow = prev.sinceShow;
      continue;
    }
    entry = done;
    if (finale) break;
  }
  const end = sim.step + Math.round(OUTRO_S / DT);
  while (sim.step < end) sim.advance();
  return { sim, stages, steps: sim.step, retries };
}
