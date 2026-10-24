import * as dm from '@sim/physics/math';
import type { AudioEventInput, SimEvent, Template } from '@sim/engine';
import { lengthFit, markAt, runDirector, storyAudio, storyDirector, storyNarration, weighted, type Director } from '../story';
import { craterOf, impactEnergy, tntLabel } from './impact';
import { objectById, rodBody, type Body, type SpaceObject, type StartMode } from './objects';
import { simulate, type Start, type Trajectory } from './physics';
import { spaceDropSchema, type SpaceDropParams } from './params';
import { buildFall, simTimeAt, type FallSim, type Run } from './script';
import { drawSpaceDrop, makeLook, type Look } from './view3d';
import { CRUSH } from './wreck';
import { drawSpaceDropTop } from './hud';

export { spaceDropSchema, SPACE_DROP_MODES, type SpaceDropParams } from './params';

export interface SpaceDropState {
  p: SpaceDropParams;
  sim: FallSim;
  dir: Director<FallSim>;
  /** How it looks apart from the physics (visual-only randomness). */
  look: Look;
  visual: boolean;
  t: number;
}

/** Objects with windows (their glass shatters as they hit; see models.ts). */
const GLAZED = new Set(['sedan', 'pickup', 'school-bus', 'jumbo-jet']);

const DEFAULT_HOOK = 'What if you dropped this from space?';
const DEFAULT_CTA = 'Real physics, real numbers 🚀';

/** Falls are worked out once per object and start (they're deterministic, and a fall takes up to ~0.2 s to integrate). */
const cache = new Map<string, Trajectory>();
function fall(body: Body, start: Start, T0: number): Trajectory {
  const key = JSON.stringify([body, start, T0]);
  let tr = cache.get(key);
  if (!tr) {
    tr = simulate(body, start, { T0 });
    if (cache.size > 24) cache.delete(cache.keys().next().value as string);
    cache.set(key, tr);
  }
  return tr;
}

export function objectsOf(p: SpaceDropParams): SpaceObject[] {
  if (p.mode === 'solo') return [objectById(p.object)];
  const ids = [p.versusA, p.versusB, ...(p.versusC !== 'none' ? [p.versusC] : [])];
  return ids.map(objectById);
}

export function startOf(p: SpaceDropParams, objs: SpaceObject[]): Start {
  const mode: StartMode = p.start === 'auto' ? objs[0].start : p.start;
  // On auto, a meteor with a known arrival (Chelyabinsk) comes in as it really did.
  const real = p.start === 'auto' && mode === 'meteor' ? objs[0].entry : undefined;
  return {
    mode,
    altitude: (mode === 'orbit' ? p.orbitAltitude : p.dropAltitude) * 1000,
    angle: real?.angle ?? (mode === 'meteor' ? p.meteorAngle : p.entryAngle),
    speed: real?.speed ?? p.meteorSpeed * 1000,
  };
}

export function buildRuns(p: SpaceDropParams): Run[] {
  const objs = objectsOf(p);
  const start = startOf(p, objs);
  return objs.map((obj) => {
    const body = obj.id === 'tungsten-rod' ? rodBody(p.rodTonnes * 1000, p.rodFlight) : obj.body;
    const tr = fall(body, start, obj.group === 'space' ? 250 : 290);
    return { obj, body, start, tr, crater: craterOf(tr, p.ground), energy: impactEnergy(tr) };
  });
}

/** Events of the fall between two sim times, as sim events (for sound and the picture). */
function emitBetween(s: SpaceDropState, from: number, to: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  s.sim.runs.forEach((r, k) => {
    for (const e of r.tr.events) {
      if (e.t <= from || e.t > to) continue;
      if (e.kind === 'impact') {
        // Slow enough to leave a wreck: does it crumple (and is it still whole, windows and all)?
        const lands = r.tr.impact?.body.name ?? '';
        const wreck = e.v < 600 && CRUSH[lands] ? (lands === r.body.name && GLAZED.has(r.obj.id) ? 'glazed' : 'crush') : 'none';
        emit({ type: 'drop:impact', run: k, energy: r.energy, v: e.v, wreck });
      } else if (e.kind === 'airburst') emit({ type: 'drop:airburst', run: k, energy: e.value ?? 0, alt: e.alt });
      else if (e.kind === 'breakup') emit({ type: 'drop:breakup', run: k, alt: e.alt, rock: r.body.breakup?.kind === 'pancake' });
      else if (e.kind === 'subsonic') emit({ type: 'drop:boom', run: k });
      else if (e.kind === 'entry') emit({ type: 'drop:entry', run: k });
      else if (e.kind === 'burnup') emit({ type: 'drop:burnup', run: k });
    }
  });
}

/** How loud the air is on a run at a sim time, 0..1 (ram pressure, on a log scale). */
export function roarLevel(sim: FallSim, t: number): number {
  let L = 0;
  for (const r of sim.runs) {
    const tr = r.tr;
    if (t > tr.t[tr.t.length - 1]) continue;
    let i = 0;
    let hi = tr.t.length - 1;
    while (hi - i > 1) {
      const mid = (i + hi) >> 1;
      if (tr.t[mid] <= t) i = mid;
      else hi = mid;
    }
    const q = tr.q[i];
    L = Math.max(L, Math.min(1, Math.max(0, (dm.log(q + 1) / Math.LN10 - 1.3) / 4.2)));
  }
  return L;
}

export const spaceDrop: Template<SpaceDropParams, SpaceDropState> = {
  id: 'space-drop',
  name: 'Space Drop',
  family: 'kinetic',
  category: 'brainy',
  description:
    'Narrated physics: an object falls from space and hits the ground, with live, physically modelled speed, altitude, heat and impact energy. A tungsten rod (any mass, point-first or tumbling), vehicles (car, pickup, school bus, battle tank, jumbo jet, shipping container), classic what-ifs (penny, bowling ball, anvil, grand piano, fridge, cow), space objects (iron and stony meteorites, a Chelyabinsk-size asteroid, a dead satellite, a station module) and huge things (blue whale, house, cruise ship, the Eiffel Tower as a steel cube). Dropped from rest, de-orbited at an entry angle, or arriving as a meteor. The fall is integrated in real atmosphere (US Standard 1976 to 1,000 km) around a spinning Earth: Mach- and rarefaction-dependent drag, Sutton–Graves and Tauber–Sutton heating, heat soaking into the surface, melting and ablation, breakup when ram pressure beats its strength or its skin burns through, rocks pancaking into airbursts (Chelyabinsk comes out at ~25 km and ~370 kt). Impact energy as TNT, crater by Holsapple scaling, earthquake magnitude. Solo, or Versus with 2–3 objects side by side. CTAs may use {answer}.',
  schema: spaceDropSchema,
  substeps: 1,
  maxSeconds: 110,
  searchBudget: 3,
  glowScale: 0,
  ownMusic: true,
  lengthParam: { param: 'targetS', offsetS: 0 },
  defaultCopy: { hook: DEFAULT_HOOK, cta: DEFAULT_CTA },
  nudges: ['Guess the impact energy 👇', 'Which hits hardest? 👇', 'What should we drop next? 👇', 'Sound on 🔊'],
  nudgeY: 0.8,
  narration: storyNarration(
    'A gripping, precise science narrator for Shorts: vivid, a little awed by the numbers, never sensational. Every number is real; say it plainly. Short sentences spoken over the moment they describe.',
  ),

  init(ctx) {
    const p = ctx.params;
    const runs = buildRuns(p);
    const { sim, script } = buildFall(runs, p.units, p.ground);
    const dir = storyDirector(script, ctx, 1);
    const s: SpaceDropState = { p, sim, dir, look: makeLook(ctx.fxRng, p.sun, runs.length), visual: ctx.visual, t: 0 };
    dir.onSpan = (sim, emit, span) => {
      if (span.seconds <= 0) return;
      const a = roarLevel(sim, simTimeAt(sim, span.from));
      const b = roarLevel(sim, simTimeAt(sim, span.to));
      // A deep drone under everything; the roar of the air when there is some.
      emit({ type: 'drop:drone', dur: span.seconds + 0.04 });
      if (a > 0.02 || b > 0.02) emit({ type: 'drop:roar', from: a, to: b, dur: span.seconds + 0.04 });
    };
    return s;
  },

  step(s, { t, emit }) {
    s.t = t;
    runDirector(s.dir, s.sim, emit, (sim, emit) => {
      const before = sim.simT;
      sim.tick++;
      sim.simT = simTimeAt(sim, sim.tick);
      if (sim.simT > before) emitBetween(s, before, sim.simT, emit);
    });
  },

  isDone: (s) => s.dir.done,

  hud: (s) => ({ answer: s.sim.answer, outro: s.t >= markAt(s.dir, 'outro') + 0.4 }),

  overlays(p, copy) {
    const name = objectsOf(p)
      .map((o) => o.short.replace(/^the /, 'a '))
      .join(' vs ');
    const hook =
      copy.hook === DEFAULT_HOOK
        ? p.mode === 'solo'
          ? `What if you dropped ${name} from space?`
          : `${objectsOf(p)
              .map((o) => o.name)
              .join(' vs ')}: dropped from space`
        : copy.hook;
    return [
      { kind: 'hook', text: hook, from: 0, to: 3.4, y: 0.1 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.1 },
    ];
  },

  render: (rc, s) => drawSpaceDrop(rc, s),
  renderTop: (rc, s) => drawSpaceDropTop(rc, s),

  audio(e): AudioEventInput[] {
    const voice = storyAudio(e);
    if (voice) return voice;
    switch (e.type) {
      case 'drop:drone':
        return [
          { kind: 'tone', hz: 41.2, dur: e.dur as number, vel: 0.5, wave: 'sine' },
          { kind: 'tone', hz: 110, dur: e.dur as number, vel: 0.08, wave: 'glass' },
        ];
      case 'drop:roar': {
        const a = e.from as number;
        const b = e.to as number;
        return [{ kind: 'tone', hz: 180 + 2200 * a * a, hzEnd: 180 + 2200 * b * b, dur: e.dur as number, vel: 0.15 + 1.6 * Math.max(a, b), wave: 'roar' }];
      }
      case 'drop:boom':
        return [{ kind: 'sfx', name: 'sonicboom', vel: 0.9 }];
      case 'drop:breakup':
        // A rock cracking and flattening rumbles; a machine tears apart with metal and glass.
        if (e.rock)
          return [
            { kind: 'sfx', name: 'crunch', vel: 0.9, pitch: 0.05 },
            { kind: 'sfx', name: 'blast', vel: 0.45, pitch: 0.1 },
          ];
        return [
          { kind: 'sfx', name: 'crunch', vel: 0.9, pitch: 0.2 },
          { kind: 'sfx', name: 'shatter', vel: 0.6, pitch: 0.3 },
          { kind: 'sfx', name: 'clang', vel: 0.5, pitch: 0.15 },
        ];
      case 'drop:airburst':
        return [{ kind: 'sfx', name: 'blast', vel: 1.0, pitch: 0.15 }];
      case 'drop:impact': {
        // Bigger impacts sound deeper.
        const E = e.energy as number;
        const size = Math.min(1, Math.max(0, (Math.log10(E + 1) - 2) / 12));
        const out: AudioEventInput[] = [
          { kind: 'sfx', name: 'blast', vel: 0.5 + 0.5 * size, pitch: 1 - size },
          { kind: 'sfx', name: 'crunch', vel: 0.7, pitch: 0.3 },
        ];
        // Metal folding up, parts tearing off; a vehicle's windows bursting.
        if (e.wreck !== 'none') out.push({ kind: 'sfx', name: 'crunch', vel: 0.9, pitch: 0.15 }, { kind: 'sfx', name: 'clang', vel: 0.55, pitch: 0.35 });
        if (e.wreck === 'glazed') out.push({ kind: 'sfx', name: 'shatter', vel: 0.75, pitch: 0.5 });
        return out;
      }
      case 'drop:burnup':
        return [{ kind: 'sfx', name: 'flame', vel: 0.6 }];
      default:
        return [];
    }
  },

  score(events, { durationS, targetS }) {
    const hits = events.filter((e) => e.type === 'drop:impact' || e.type === 'drop:airburst').length;
    return weighted({ length: [lengthFit(durationS, targetS), 2], payoff: [Math.min(1, hits), 1] });
  },

  outcome(events) {
    const hits = events.filter((e) => e.type === 'drop:impact' || e.type === 'drop:airburst');
    if (!hits.length) return 'burned up';
    const best = hits.reduce((a, b) => ((a.energy as number) >= (b.energy as number) ? a : b));
    return tntLabel(best.energy as number);
  },
};

export type { FallSim, Run };
