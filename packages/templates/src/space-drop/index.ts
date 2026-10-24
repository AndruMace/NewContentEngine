import * as dm from '@sim/physics/math';
import type { AudioEventInput, SimEvent, Template } from '@sim/engine';
import { lengthFit, markAt, runDirector, storyAudio, storyDirector, storyNarration, weighted, type Director } from '../story';
import { craterOf, impactEnergy, tntLabel } from './impact';
import { objectById, rodBody, type Body, type SpaceObject, type StartMode } from './objects';
import { simulate, type Start, type Trajectory } from './physics';
import { spaceDropSchema, type SpaceDropParams } from './params';
import { REPLAY, buildFall, simTimeAt, type FallSim, type Run } from './script';
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
  /** Video time and sim time at every step, so the picture can replay any moment exactly. */
  hist: { t: number[]; simT: number[] };
}

/** Sim time at an earlier video time (from the recorded history). */
export function simTimeAtVideo(s: SpaceDropState, t: number): number {
  const ts = s.hist.t;
  if (!ts.length || t <= ts[0]) return ts.length ? s.hist.simT[0] : 0;
  let lo = 0;
  let hi = ts.length - 1;
  if (t >= ts[hi]) return s.hist.simT[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const u = (t - ts[lo]) / (ts[hi] - ts[lo]);
  return s.hist.simT[lo] + (s.hist.simT[hi] - s.hist.simT[lo]) * u;
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

/** What its landing leaves: a crumpled wreck (with its windows bursting, if it still has them), or none. */
function wreckOf(r: Run, v: number): 'glazed' | 'crush' | 'none' {
  const lands = r.tr.impact?.body.name ?? '';
  if (v >= 600 || !CRUSH[lands]) return 'none';
  return lands === r.body.name && GLAZED.has(r.obj.id) ? 'glazed' : 'crush';
}

/** The sounds of a landing (`gain` < 1 for the replay). */
function impactSounds(energy: number, wreck: unknown, gain: number): AudioEventInput[] {
  // Bigger impacts sound deeper.
  const size = Math.min(1, Math.max(0, (Math.log10(energy + 1) - 2) / 12));
  const out: AudioEventInput[] = [
    { kind: 'sfx', name: 'blast', vel: (0.5 + 0.5 * size) * gain, pitch: 1 - size },
    { kind: 'sfx', name: 'crunch', vel: 0.7 * gain, pitch: 0.3 },
  ];
  // Metal folding up, parts tearing off; a vehicle's windows bursting.
  if (wreck !== 'none') out.push({ kind: 'sfx', name: 'crunch', vel: 0.9 * gain, pitch: 0.15 }, { kind: 'sfx', name: 'clang', vel: 0.55 * gain, pitch: 0.35 });
  if (wreck === 'glazed') out.push({ kind: 'sfx', name: 'shatter', vel: 0.75 * gain, pitch: 0.5 });
  return out;
}

/** "a car", "an anvil". */
const aName = (o: SpaceObject) => {
  const n = o.short.replace(/^the /, '');
  return `${/^[aeiou]/i.test(n) ? 'an' : 'a'} ${n}`;
};

/** The opening line on screen, fitted to what falls and how. */
export function hookFor(p: SpaceDropParams): string {
  const objs = objectsOf(p);
  if (p.mode !== 'solo') {
    const names = objs.map((o) => o.short.replace(/^the /, '')).join(' vs ');
    return `${names.charAt(0).toUpperCase()}${names.slice(1)}, from space: which hits hardest?`;
  }
  const o = objs[0];
  const start = startOf(p, objs).mode;
  const from = start === 'orbit' ? 'out of orbit' : start === 'meteor' ? 'from deep space' : 'from space';
  switch (o.id) {
    case 'tungsten-rod': {
      const t = p.rodTonnes;
      const mass = t >= 1 ? `${Number(t.toPrecision(3))}-tonne` : `${Math.round(t * 1000)} kg`;
      return `A ${mass} tungsten rod, dropped ${from}`;
    }
    case 'asteroid':
      return p.start === 'auto' ? 'The Chelyabinsk meteor, recreated' : `A Chelyabinsk-size asteroid, ${from}`;
    case 'penny':
      return 'Can a penny dropped from space hurt you?';
    case 'steel-cube':
      return `The Eiffel Tower's iron, dropped ${from}`;
    case 'jumbo-jet':
      return `A jumbo jet falling ${from}`;
    case 'iron-meteorite':
    case 'stony-meteorite':
      return `What happens when ${aName(o)} hits?`;
    default:
      return start === 'drop' ? `We dropped ${aName(o)} from the edge of space` : `What if ${aName(o)} fell ${from}?`;
  }
}

/** Events of the fall between two sim times, as sim events (for sound and the picture). */
function emitBetween(s: SpaceDropState, from: number, to: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  s.sim.runs.forEach((r, k) => {
    for (const e of r.tr.events) {
      if (e.t <= from || e.t > to) continue;
      if (e.kind === 'impact') emit({ type: 'drop:impact', run: k, energy: r.energy, v: e.v, wreck: wreckOf(r, e.v) });
      else if (e.kind === 'airburst') emit({ type: 'drop:airburst', run: k, energy: e.value ?? 0, alt: e.alt });
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
    const { sim, script } = buildFall(runs, p.units, p.ground, p.replay);
    const dir = storyDirector(script, ctx, 1);
    const s: SpaceDropState = { p, sim, dir, look: makeLook(ctx.fxRng, p.sun, runs.length), visual: ctx.visual, t: 0, hist: { t: [], simT: [] } };
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
    const was = s.t;
    s.t = t;
    runDirector(s.dir, s.sim, emit, (sim, emit) => {
      const before = sim.simT;
      sim.tick++;
      sim.simT = simTimeAt(sim, sim.tick);
      if (sim.simT > before) emitBetween(s, before, sim.simT, emit);
    });
    s.hist.t.push(t);
    s.hist.simT.push(s.sim.simT);
    // The replay: a rewind swish, then the landings again (quieter), as they hit on screen.
    const r0 = markAt(s.dir, 'replay');
    if (Number.isFinite(r0)) {
      if (was < r0 && t >= r0) emit({ type: 'drop:rewind' });
      const hit = r0 + REPLAY.lead;
      if (was < hit && t >= hit)
        s.sim.runs.forEach((r, k) => {
          if (r.tr.impact) emit({ type: 'drop:replay', run: k, energy: r.energy, wreck: wreckOf(r, r.tr.impact.v) });
        });
    }
  },

  isDone: (s) => s.dir.done,

  hud: (s) => ({ answer: s.sim.answer, outro: s.t >= markAt(s.dir, 'outro') + 0.4 }),

  overlays(p, copy) {
    const hook = copy.hook === DEFAULT_HOOK ? hookFor(p) : copy.hook;
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
      case 'drop:impact':
        return impactSounds(e.energy as number, e.wreck, 1);
      case 'drop:rewind':
        return [{ kind: 'sfx', name: 'swish', vel: 0.6, pitch: 0.3 }];
      case 'drop:replay':
        return impactSounds(e.energy as number, e.wreck, 0.55);
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
