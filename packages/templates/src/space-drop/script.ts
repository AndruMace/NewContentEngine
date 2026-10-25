import { Script, estimateS, type Act, type BeatSpec, type Facts } from '../story';
import { air } from './atmosphere';
import { comparison, craterOf, energyLabel, impactEnergy, seismicMagnitude, timesLabel, tntLabel, dimsLabel, type Crater, type Ground } from './impact';
import { findEvent, type Start, type Trajectory } from './physics';
import type { Body, SpaceObject } from './objects';
import { altText, durationText, lengthText, massText, speedText, tempText, type Units } from './units';

/**
 * The video's story, written against the precomputed fall. A tick is a step of the picture; the time
 * curve says how many seconds of the fall each tick stands for, so the clock runs hundreds of times
 * faster through the long, quiet coast and slows to real time for the last moments before impact.
 * Lines are keyed to sim times (the burst, the breakup, the impact), so each one starts as its
 * moment is on screen however long the voice takes.
 */

export const TPS = 60;

export interface Run {
  obj: SpaceObject;
  body: Body;
  start: Start;
  tr: Trajectory;
  crater: Crater | null;
  /** Energy of what lands (J). */
  energy: number;
}

export interface FallSim {
  runs: Run[];
  tick: number;
  /** Seconds since release. */
  simT: number;
  /** The time curve: ticks → sim seconds (monotone cubic through the keys). */
  keyTicks: number[];
  keyT: number[];
  slopes: number[];
  units: Units;
  ground: Ground;
  answer: string;
}

export interface Built {
  sim: FallSim;
  script: Script<FallSim>;
}

/**
 * The instant replay: how long before contact it starts (video s), and how long it lasts, solo and
 * side by side.
 */
export const REPLAY = { lead: 0.9, solo: 3.6, versus: 4.2 } as const;

/** Fritsch–Carlson slopes: a smooth curve through the keys that never runs backwards. */
function pchipSlopes(x: number[], y: number[]): number[] {
  const n = x.length;
  if (n < 2) return [0];
  const d: number[] = [];
  for (let k = 0; k < n - 1; k++) d.push((y[k + 1] - y[k]) / (x[k + 1] - x[k]));
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] * d[k] <= 0) m[k] = 0;
    else {
      const w1 = 2 * (x[k + 1] - x[k]) + (x[k] - x[k - 1]);
      const w2 = x[k + 1] - x[k] + 2 * (x[k] - x[k - 1]);
      m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
  }
  return m;
}

/** Sim seconds at a tick. */
export function simTimeAt(sim: FallSim, tick: number): number {
  const x = sim.keyTicks;
  const y = sim.keyT;
  const n = x.length;
  if (tick <= x[0]) return y[0];
  if (tick >= x[n - 1]) return y[n - 1];
  let k = 0;
  while (k < n - 2 && tick > x[k + 1]) k++;
  const h = x[k + 1] - x[k];
  const u = (tick - x[k]) / h;
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * y[k] + (u3 - 2 * u2 + u) * h * sim.slopes[k] + (-2 * u3 + 3 * u2) * y[k + 1] + (u3 - u2) * h * sim.slopes[k + 1];
}

class Plan {
  pos = 0;
  readonly ticks: number[] = [0];
  readonly ts: number[] = [0];
  constructor(readonly s: Script<FallSim>) {}

  /** The fall reaches sim time `t` at the current tick. */
  key(t: number) {
    const n = this.ticks.length - 1;
    const tt = Math.max(t, this.ts[n]);
    if (this.ticks[n] === this.pos) this.ts[n] = tt;
    else {
      this.ticks.push(this.pos);
      this.ts.push(tt);
    }
  }

  say(beat: BeatSpec, facts: Facts, to?: number, o: { seconds?: number; acts?: (Act<FallSim> | null)[] } = {}) {
    const ticks = to === undefined ? 0 : Math.round((o.seconds ?? estimateS(beat.maxWords)) * TPS);
    this.s.say(beat, { facts: () => facts, ticks, acts: o.acts });
    this.pos += ticks;
    if (to !== undefined) this.key(to);
  }

  play(seconds: number, to: number, elastic: boolean) {
    const ticks = Math.max(1, Math.round(seconds * TPS));
    this.s.play(ticks, TPS, { elastic });
    this.pos += ticks;
    this.key(to);
  }

  /**
   * The last seconds before landing: fast, easing into the final 1.5 s, which show the last 1.5 s of
   * the fall in real time, or, for anything faster than 270 m/s, its last 400 m in slow motion.
   */
  approach(from: number, to: number, v: number) {
    const last = Math.min(1.5, 400 / Math.max(1, v), to - from);
    if (to - last > from + 1e-6) this.play(2.4, to - last, false);
    this.play(1.5, to, false);
  }
}

/** A moment of the fall a line is about. */
interface Moment {
  t: number;
  kind: 'say' | 'approach' | 'land';
  beat?: BeatSpec;
  facts?: Facts;
  /** Share of the time to the next moment the line itself covers (the rest plays elastically). */
  cover?: number;
  /** Or: sim seconds the line covers (at most up to the next moment). */
  coverS?: number;
  /** For an approach: the speed it lands at (m/s). */
  v?: number;
  /** Nominal seconds for the elastic stretch after the line. */
  gapS?: number;
  acts?: (Act<FallSim> | null)[];
  mark?: string;
}

/** First time a series passes a level (after `from`). */
function firstTime(tr: Trajectory, from: number, test: (i: number) => boolean): number | null {
  for (let i = 0; i < tr.t.length; i++) if (tr.t[i] >= from && test(i)) return tr.t[i];
  return null;
}

/** Time to fall to this altitude (or the end). */
const timeAtAlt = (tr: Trajectory, h: number) => firstTime(tr, 0, (i) => tr.h[i] <= h) ?? tr.t[tr.t.length - 1];

export const endTime = (tr: Trajectory) => tr.t[tr.t.length - 1];

/** When the final approach starts: 3 km up, or 6 s out for anything that fast. */
const approachStart = (tr: Trajectory) => Math.max(0, Math.min(timeAtAlt(tr, 3000), endTime(tr) - 6));

/** How hot it looks, against things people know. */
function hotRef(K: number): string {
  if (K > 5800) return 'the surface of the Sun';
  if (K > 3700) return 'the melting point of tungsten';
  if (K > 1500) return 'molten lava';
  if (K > 800) return 'a kitchen oven, many times over';
  return 'a hot day';
}

/** Seconds a sound takes to come straight down from h. */
function soundDelay(h: number): number {
  let s = 0;
  const n = 60;
  for (let k = 0; k < n; k++) s += h / n / air(h * ((k + 0.5) / n)).a;
  return s;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const COUNT_WORDS: Record<number, string> = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };

/** What the narrator calls it mid-sentence ("the car", "the space station module"). */
const spokenName = (obj: Run['obj']) => (obj.id === 'steel-cube' ? 'steel cube' : lower(obj.name));

/** With its article, for introducing it: "a car", "an anvil". */
export function aName(obj: Run['obj']): string {
  if (obj.id === 'steel-cube') return 'a steel cube as heavy as the Eiffel Tower';
  const n = spokenName(obj);
  return `${/^[aeiou]/.test(n) ? 'an' : 'a'} ${n}`;
}

/** The beats for one fall's events between entry and the ground (shared by both modes). */
function fallMoments(run: Run, u: Units, versus: boolean, tag: string): Moment[] {
  const { tr, obj } = run;
  const name = versus ? obj.short.replace(/^the /, '') : spokenName(obj);
  const out: Moment[] = [];
  const bu = tr.breakup;
  if (bu) {
    const alt = altText(bu.alt, u);
    if (bu.core) {
      const facts = {
        alt,
        name,
        // Several alike survive (a jet's four engines): "its four jet engines".
        core: bu.count > 1 ? `${COUNT_WORDS[bu.count] ?? bu.count} ${bu.core.name}s` : bu.core.name,
        coreMass: massText(bu.core.mass * bu.count, u),
        cause: bu.cause === 'pressure' ? 'the force of the air finally wins' : 'its thin outer skin burns through',
      };
      out.push({
        t: bu.t,
        kind: 'say',
        beat: versus
          ? {
              id: `break${tag}`,
              about: 'The {name} breaks apart at {alt}, and only its {core} keeps falling.',
              maxWords: 14,
              required: ['name'],
              fallback:
                bu.count > 1
                  ? ['The {name} breaks apart at {alt}. Only its {core} keep falling.', 'At {alt}, the {name} comes apart, leaving just its {core}.']
                  : ['The {name} breaks apart at {alt}. Only its {core} keeps falling.', 'At {alt}, the {name} comes apart, leaving just its {core}.'],
            }
          : {
              id: `break${tag}`,
              about: 'At {alt}, {cause} and the {name} tears apart; only the {core} survives and keeps falling.',
              maxWords: 22,
              required: ['alt', 'core'],
              fallback:
                bu.count > 1
                  ? ['At {alt}, {cause}, and the {name} rips apart. Only its {core} survive.', '{alt} up, the {name} can’t take any more and breaks apart. Only its {core} are still falling.']
                  : [
                      'At {alt}, {cause}, and the {name} rips apart. Only the {core} survives.',
                      'At {alt}, the {name} tears itself to pieces. From here on, only the {core} is still falling.',
                      '{alt} up, the {name} can’t take any more and breaks apart. All that’s left is the {core}.',
                    ],
            },
        facts,
        cover: 0.6,
        mark: `break${tag}`,
      });
    } else {
      out.push({
        t: bu.t,
        kind: 'say',
        beat: {
          id: `crush${tag}`,
          about: 'At {alt}, the air pushes on it so hard that the rock cracks and spreads out, flattening like a pancake.',
          maxWords: 20,
          required: ['alt'],
          fallback: [
            'At {alt}, the air hits it so hard that the rock starts to crack and spread out, flattening like a pancake.',
            '{alt} up, the pressure of the air starts crushing the rock flat, like a pancake.',
          ],
        },
        facts: { alt, name },
        cover: 0.9,
        mark: `break${tag}`,
      });
    }
  }
  const ab = tr.airburst;
  if (ab) {
    const cmp = comparison(ab.energy);
    out.push({
      t: ab.t,
      kind: 'say',
      beat: versus
        ? {
            id: `burst${tag}`,
            about: 'The {name} explodes high in the air, at {alt}, with {tnt}.',
            maxWords: 15,
            required: ['name', 'tnt'],
            fallback: ['The {name} explodes high in the air, at {alt}, with the force of {tnt}.', 'At {alt}, the {name} blows apart in midair, releasing {tnt}.'],
          }
        : {
            id: `burst${tag}`,
            about: '{alt} up, it explodes in a blinding flash, releasing as much energy as {tnt}: {times} {ref}.',
            maxWords: 24,
            required: ['alt', 'tnt'],
            fallback: [
              'At {alt}, it explodes in a blinding flash, releasing as much energy as {tnt}. That’s {times} {ref}.',
              '{alt} up, the whole thing blows apart at once, with the force of {tnt}, {times} {ref}.',
            ],
          },
      facts: { alt: altText(ab.alt, u), name, tnt: tntLabel(ab.energy), times: timesLabel(cmp.times), ref: cmp.ref.name },
      cover: 0.25,
      mark: `burst${tag}`,
    });
    if (!versus)
      out.push({
        t: ab.t + 1,
        kind: 'say',
        beat: {
          id: 'shock',
          about: 'The boom from that blast takes {delay} to reach the ground below.',
          maxWords: 16,
          required: ['delay'],
          fallback: ['Down on the ground, the boom from that blast won’t arrive for another {delay}.', 'The shock wave from the blast takes {delay} to reach the ground below.'],
        },
        facts: { delay: durationText(soundDelay(ab.alt)) },
        cover: 0.4,
      });
  }
  if (tr.end === 'burnup') {
    const last = tr.events.find((e) => e.kind === 'burnup');
    const alt = altText(last?.alt ?? tr.h[tr.h.length - 1], u);
    out.push({
      t: endTime(tr),
      kind: 'say',
      beat: versus
        ? {
            id: `gone${tag}`,
            about: 'The {name} burns up completely at {alt}; none of it reaches the ground.',
            maxWords: 14,
            required: ['name'],
            fallback: ['The {name} burns up completely at {alt}. None of it reaches the ground.'],
          }
        : {
            id: `gone${tag}`,
            about: 'By {alt} it has burned away completely, like a shooting star; nothing reaches the ground.',
            maxWords: 18,
            required: ['alt'],
            fallback: [
              'By {alt}, there’s nothing left. It has burned away completely, like a shooting star.',
              'At {alt}, the last of it burns away, like a shooting star. None of it reaches the ground.',
            ],
          },
      facts: { alt, name },
      mark: `gone${tag}`,
    });
  }
  return out;
}

/** Peak heating and when the glow is strong (heat flux above 30% of its peak). */
function heatSpan(tr: Trajectory): { t0: number; t1: number; peak: number; tPeak: number; shock: number; skin: number } | null {
  const ph = findEvent(tr, 'peakHeat');
  if (!ph || !ph.value) return null;
  const level = ph.value * 0.3;
  const t0 = firstTime(tr, 0, (i) => tr.h[i] < 100_000 && tr.heat[i] >= level) ?? ph.t;
  const t1 = firstTime(tr, ph.t, (i) => tr.heat[i] < level) ?? endTime(tr);
  let shock = 0;
  for (let i = 0; i < tr.t.length; i++) if (tr.t[i] <= t1 && tr.phase[i] !== 2) shock = Math.max(shock, tr.Tshock[i]);
  return { t0, t1, peak: ph.value, tPeak: ph.t, shock, skin: tr.maxTs };
}

const rodLesson: BeatSpec = {
  id: 'lesson',
  about: 'No explosive at all, just a heavy rod and a lot of speed: the idea people call Rods from God.',
  maxWords: 21,
  fallback: [
    'No explosives at all, just a heavy rod and a lot of speed. That’s the idea people call Rods from God.',
    'There’s no warhead here, only mass and speed. That’s the idea known as Rods from God.',
  ],
};

function soloScript(run: Run, u: Units, replay: boolean): { script: Script<FallSim>; ticks: number[]; ts: number[]; answer: string } {
  const s = new Script<FallSim>();
  const plan = new Plan(s);
  const { tr, obj, body, start } = run;
  const tEnd = endTime(tr);
  const name = spokenName(obj);
  const mass = massText(body.mass, u);
  const dims = dimsLabel(body.shape);
  const entry = findEvent(tr, 'entry');
  const tEntry = entry?.t ?? 0;
  const moments: Moment[] = [];

  // Release.
  const introFacts = { name, aName: aName(obj), mass, dims, alt: altText(start.mode === 'meteor' ? 200_000 : start.altitude, u), speed: speedText(tr.v[0], u) };
  const intro: BeatSpec =
    start.mode === 'drop'
      ? {
          id: 'intro',
          about: 'This is {aName}, weighing {mass}, hanging {alt} above the Earth, about to be let go.',
          maxWords: 20,
          required: ['alt'],
          fallback: ['This is {aName}, weighing {mass}. We’re about to let it go {alt} above the Earth.', 'Here’s {aName} weighing {mass}, hanging {alt} above the Earth. Let’s drop it.'],
        }
      : start.mode === 'orbit'
        ? {
            id: 'intro',
            about: '{aName} weighing {mass} is in orbit {alt} up, at {speed}; a short engine burn slows it just enough to start falling.',
            maxWords: 24,
            required: ['speed'],
            fallback: [
              '{aName} weighing {mass} is circling the Earth {alt} up, at {speed}. A short engine burn slows it just enough to fall.',
              'This is {aName}, in orbit {alt} up and moving at {speed}. One short burn, and it starts to fall.',
            ],
          }
        : {
            id: 'intro',
            about: '{aName} from deep space, weighing {mass}, is about to hit our atmosphere at {speed}.',
            maxWords: 18,
            required: ['speed'],
            fallback: ['{aName} from deep space, weighing {mass}, is about to hit our atmosphere at {speed}.', 'Out in space, {aName} weighing {mass} is heading straight for us at {speed}.'],
          };
  moments.push({ t: 0, kind: 'say', beat: intro, facts: introFacts, cover: 1 });
  if (tEntry > 25) {
    const vEntry = entry?.v ?? 0;
    moments.push({
      t: Math.min(tEntry * 0.02, 4),
      kind: 'say',
      beat:
        start.mode === 'drop'
          ? {
              id: 'space',
              about: 'With no air up here nothing slows it: after {time} of free fall it is doing {speed}.',
              maxWords: 20,
              required: ['time', 'speed'],
              fallback: [
                'With no air up here, nothing slows it down. After {time} of free fall, it’s already doing {speed}.',
                'There’s no air this high to hold it back. In {time}, gravity alone gets it up to {speed}.',
              ],
            }
          : {
              id: 'space',
              about: 'For the next {time} it glides around the planet, slowly sinking toward the air.',
              maxWords: 16,
              required: ['time'],
              fallback: ['For the next {time}, it glides around the planet, slowly sinking toward the air.', 'It spends {time} coasting around the Earth, slowly losing height.'],
            },
      facts: { time: durationText(tEntry), speed: speedText(vEntry, u) },
      cover: 0.85,
      gapS: 1.2,
    });
  }
  if (entry) {
    const mach =
      tr.mach[
        Math.max(
          0,
          tr.t.findIndex((t) => t >= tEntry),
        )
      ];
    const vTop = findEvent(tr, 'maxSpeed')?.v ?? entry.v;
    // Dropped from about the edge of space it starts in the air's first wisps, barely moving: the
    // story there is how fast it gets before the air takes hold.
    const fromEdge = entry.v < 300;
    moments.push({
      t: tEntry,
      kind: 'say',
      beat: fromEdge
        ? {
            id: 'entry',
            about: 'There is almost no air this high, so nothing holds it back: it keeps speeding up, to {top} at its fastest.',
            maxWords: 20,
            required: ['top'],
            fallback: [
              'There’s almost no air this high, so nothing holds it back. It just keeps speeding up, to {top} at its fastest.',
              'At first it falls through almost empty air, faster and faster, until it’s doing {top}.',
            ],
          }
        : {
            id: 'entry',
            about: 'It reaches the edge of space at {speed}, and for the first time there is air to push against.',
            maxWords: 19,
            required: ['speed'],
            fallback: [
              'It reaches the edge of space at {speed}, and for the first time there’s air to push against.',
              'Now it crosses the edge of space at {speed}. From here on, the air starts fighting back.',
            ],
          },
      facts: { speed: speedText(entry.v, u), top: speedText(vTop, u), mach: Math.round(mach) },
      cover: 0.7,
      gapS: 1,
    });
  }
  const heat = heatSpan(tr);
  // It glows if it gets hot enough to (or melts, or burns away entirely).
  const glows = tr.maxTs > 800 || tr.end === 'burnup' || Boolean(findEvent(tr, 'melt'));
  if (heat && heat.t0 > tEntry) {
    moments.push({
      t: heat.t0,
      kind: 'say',
      beat: glows
        ? {
            id: 'heat',
            about: 'The air in front can’t get out of the way, so it is squeezed and heated to {shock}, hotter than {ref}; the surface reaches {skin}.',
            maxWords: 24,
            required: ['shock', 'skin'],
            fallback: [
              'The air in front can’t get out of the way, so it’s squeezed and heated to {shock}. The surface itself reaches {skin}.',
              'The air ahead is compressed so hard it glows, at {shock}, hotter than {ref}. The surface climbs to {skin}.',
            ],
          }
        : {
            id: 'heat',
            about: 'It is falling too slowly, through air this thin, to really heat up: its surface only reaches {skin}.',
            maxWords: 18,
            required: ['skin'],
            fallback: ['It’s falling too slowly, through air this thin, to really heat up. Its surface only reaches {skin}.'],
          },
      facts: { shock: tempText(heat.shock, u), skin: tempText(heat.skin, u), ref: hotRef(heat.shock) },
      cover: 0.8,
      gapS: 1,
    });
  }
  moments.push(...fallMoments(run, u, false, ''));
  if (tr.impact) {
    const im = tr.impact;
    const vmax = findEvent(tr, 'maxSpeed')?.v ?? im.v;
    const maxG = maxIntactG(tr);
    const tApproach = approachStart(tr);
    const lastT = Math.max(0, ...moments.map((m) => m.t));
    // Once the heating has passed (or partway to the approach, if it glows all the way down).
    const tBrake = Math.min(Math.max(lastT + 0.6 * (tApproach - lastT), heat && heat.t1 < tApproach ? heat.t1 : 0), tApproach - 0.5);
    if (tBrake > lastT + 0.2 && !tr.airburst) {
      const slowed = im.v < 0.5 * vmax;
      moments.push({
        t: tBrake,
        kind: 'say',
        beat: slowed
          ? {
              id: 'brake',
              about: 'The thickening air brakes it hard, at up to {g} times the pull of gravity, until it is down to {speed}.',
              maxWords: 22,
              required: ['speed'],
              fallback: [
                'The thickening air brakes it hard, at up to {g} times the pull of gravity, until it’s down to {speed}.',
                'Lower down, the air is thick enough to fight back. It slows the {name} right down, to {speed}.',
              ],
            }
          : {
              id: 'brake',
              about: 'The air can hardly slow something this heavy: it is still doing {speed}.',
              maxWords: 14,
              required: ['speed'],
              fallback: ['The air can hardly slow something this heavy. It’s still doing {speed}.', 'Even the thick air near the ground barely slows it. It’s still doing {speed}.'],
            },
        facts: {
          // By now it may be only what survived the breakup.
          name: tr.breakup?.core ? (tr.breakup.count > 1 ? `${tr.breakup.core.name}s` : tr.breakup.core.name) : name,
          g: Math.round(maxG),
          speed: speedText(
            slowed
              ? im.v
              : tr.v[
                  Math.max(
                    0,
                    tr.t.findIndex((t) => t >= tBrake),
                  )
                ],
            u,
          ),
        },
        cover: 0.5,
        gapS: 2,
      });
    }
    moments.push({ t: Math.min(Math.max(tApproach, (moments[moments.length - 1]?.t ?? 0) + 0.1), im.t - 0.05), kind: 'approach', mark: 'approach', v: im.v });
    moments.push({ t: im.t, kind: 'land', mark: 'impact' });
  }
  buildMoments(plan, moments, tEnd);
  // After it lands: the energy, the crater, a closing line.
  if (tr.impact) {
    const im = tr.impact;
    const E = run.energy;
    const cmp = comparison(E);
    plan.say(
      {
        id: 'impact',
        about: 'The impact.',
        maxWords: 26,
        required: ['speed', 'tnt'],
        parts: [
          { about: 'the moment it hits the ground at {speed}', maxWords: 10 },
          { about: 'the energy it brings: as much as {tnt}, {times} {ref}', maxWords: 18 },
        ],
        fallback:
          tr.breakup || tr.airburst
            ? [
                'What’s left of it hits the ground at {speed}. | That’s as much energy as {tnt}, {times} {ref}.',
                'What survives slams into the ground at {speed}. | The energy of {tnt}, or {times} {ref}.',
              ]
            : ['It hits the ground at {speed}. | That’s as much energy as {tnt}, {times} {ref}.', 'It slams into the ground at {speed}. | The energy of {tnt}, or {times} {ref}.'],
      },
      { speed: speedText(im.v, u), tnt: tntLabel(E), energy: energyLabel(E), times: timesLabel(cmp.times), ref: cmp.ref.name },
      tEnd,
      { seconds: 0 },
    );
    const cr = run.crater;
    if (cr) {
      const mag = seismicMagnitude(E);
      const big = cr.diameter >= 1.5;
      plan.say(
        mag >= 1.5
          ? {
              id: 'crater',
              about: 'It blasts out a crater {diameter} across and shakes the ground like a magnitude {mag} earthquake.',
              maxWords: 19,
              required: ['diameter', 'mag'],
              fallback: ['It blasts out a crater {diameter} across, and shakes the ground like a magnitude {mag} earthquake.'],
            }
          : big
            ? {
                id: 'crater',
                about: 'It leaves a crater {diameter} across and {depth} deep.',
                maxWords: 13,
                required: ['diameter'],
                fallback: ['It leaves a crater {diameter} across and {depth} deep.', 'It leaves behind a crater {diameter} across.'],
              }
            : {
                id: 'crater',
                about: 'After all that, it leaves only a dent {diameter} across.',
                maxWords: 12,
                required: ['diameter'],
                fallback: ['And after all that, it leaves a dent just {diameter} across.'],
              },
        { diameter: lengthText(cr.diameter, u), depth: lengthText(cr.depth, u), mag: (Math.round(mag * 10) / 10).toFixed(1) },
      );
    }
  }
  // Once more, from another angle.
  if (replay && tr.impact) {
    s.mark('replay');
    s.hold(REPLAY.solo);
  }
  if (obj.group === 'rod' && tr.impact) plan.say(rodLesson, { time: durationText(tEnd) });
  else
    plan.say(
      tr.massLost > 0.05 && tr.end === 'impact'
        ? {
            id: 'recap',
            about: 'The fall took {time} from release to impact, and {lost} of it burned or broke away on the way down.',
            maxWords: 22,
            required: ['time'],
            fallback: ['From release to impact took {time}, and {lost} of it burned or broke away on the way down.', 'The whole fall took {time}, and only {left} of it made it to the ground.'],
          }
        : tr.end === 'burnup'
          ? { id: 'recap', about: 'From release until it vanished took {time}.', maxWords: 10, required: ['time'], fallback: ['From release until it vanished took {time}.'] }
          : { id: 'recap', about: 'From release to impact, the whole fall took {time}.', maxWords: 12, required: ['time'], fallback: ['From release to impact, the whole fall took {time}.'] },
      { time: durationText(tEnd), lost: tr.massLost > 0.99 ? 'nearly all' : `${Math.round(tr.massLost * 100)}%`, left: 1 - tr.massLost < 0.01 ? 'a tiny fraction' : `${Math.round((1 - tr.massLost) * 100)}%` },
    );
  s.mark('outro');
  s.hold(2.6);
  return { script: s, ticks: plan.ticks, ts: plan.ts, answer: '' };
}

/** Largest deceleration while it was still one piece (or a solid fragment). */
function maxIntactG(tr: Trajectory): number {
  let g = 0;
  for (let i = 0; i < tr.g.length; i++) if (tr.phase[i] !== 2) g = Math.max(g, tr.g[i]);
  return g;
}

/** Lay the moments onto the timeline: each line from its moment, covering part of the way to the next. */
function buildMoments(plan: Plan, moments: Moment[], tEnd: number) {
  moments.sort((a, b) => a.t - b.t);
  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    const next = moments[i + 1]?.t ?? tEnd;
    plan.key(m.t);
    if (m.mark) plan.s.mark(m.mark);
    if (m.kind === 'approach') {
      plan.approach(m.t, next, m.v ?? 100);
      continue;
    }
    if (m.kind === 'land' || !m.beat) continue;
    const gap = Math.max(0, next - m.t);
    const cover = m.coverS !== undefined ? Math.min(1, m.coverS / Math.max(1e-6, gap)) : (m.cover ?? 1);
    if (gap <= 0.01) plan.say(m.beat, m.facts ?? {}, undefined, { acts: m.acts });
    else {
      plan.say(m.beat, m.facts ?? {}, m.t + gap * cover, { acts: m.acts });
      if (cover < 1) plan.play(m.gapS ?? 1, next, true);
    }
  }
}

function versusScript(runs: Run[], u: Units, replay: boolean): { script: Script<FallSim>; ticks: number[]; ts: number[]; answer: string } {
  const s = new Script<FallSim>();
  const plan = new Plan(s);
  const names = runs.map((r) => r.obj.short.replace(/^the /, ''));
  const start = runs[0].start;
  const tEnd = Math.max(...runs.map((r) => endTime(r.tr)));
  const moments: Moment[] = [];
  const withA = runs.map((r) => aName(r.obj));
  const list = withA.length === 2 ? `${withA[0]} and ${withA[1]}` : `${withA[0]}, ${withA[1]} and ${withA[2]}`;
  moments.push({
    t: 0,
    kind: 'say',
    beat: {
      id: 'intro',
      about: '{list} are let go together, {alt} up ({how}). Which one hits the ground hardest?',
      maxWords: 26,
      required: ['list'],
      fallback: [
        'We drop {list} from {alt} up, all at the same moment. Which one hits the ground hardest?',
        '{list}, released together {alt} above the Earth. Which one lands with the biggest punch?',
      ],
    },
    facts: { list, alt: altText(start.mode === 'meteor' ? 200_000 : start.altitude, u), how: start.mode === 'drop' ? 'from rest' : start.mode === 'orbit' ? 'out of orbit' : 'as meteors' },
    cover: 1,
  });
  moments.push({
    t: 0.5,
    kind: 'say',
    beat: { id: 'guess', about: 'The viewer is asked to guess which one will hit hardest.', maxWords: 8, fallback: ['Make your guess now.', 'Which one’s your pick? Lock it in.'] },
    facts: {},
    cover: 1,
  });
  const entries = runs.map((r) => findEvent(r.tr, 'entry')?.t ?? 0);
  const tEntry = Math.min(...entries);
  if (tEntry > 25)
    moments.push({
      t: Math.min(4, tEntry * 0.02),
      kind: 'say',
      beat: {
        id: 'space',
        about: 'With no air up here, they all fall exactly the same way for {time}.',
        maxWords: 14,
        required: ['time'],
        fallback: ['With no air up here, they all fall exactly the same way for {time}.'],
      },
      facts: { time: durationText(tEntry) },
      cover: 0.85,
      gapS: 1,
    });
  if (tEntry > 0)
    moments.push({
      t: tEntry,
      kind: 'say',
      beat: {
        id: 'entry',
        about: 'Then they reach the air, and suddenly shape and weight start to matter.',
        maxWords: 14,
        fallback: ['Then they reach the air, and suddenly shape and weight start to matter.', 'Once they hit the air, everything changes. Shape and weight start to matter.'],
      },
      facts: {},
      cover: 0.7,
      gapS: 1,
    });
  runs.forEach((r, k) => moments.push(...fallMoments(r, u, true, String(k))));
  // Each landing: slow down for it, then a line as it hits.
  const order = runs
    .map((r, k) => ({ r, k }))
    .filter((x) => x.r.tr.impact)
    .sort((a, b) => a.r.tr.impact!.t - b.r.tr.impact!.t);
  const ordinal = ['first', 'second', 'third'];
  order.forEach(({ r, k }, n) => {
    const im = r.tr.impact!;
    const prevT = Math.max(0, ...moments.filter((m) => m.t < im.t).map((m) => m.t));
    const tApproach = Math.max(approachStart(r.tr), prevT + 0.1);
    moments.push({ t: Math.min(tApproach, im.t - 0.05), kind: 'approach', mark: `approach${k}`, v: im.v });
    moments.push({
      t: im.t,
      kind: 'say',
      beat: {
        id: `land${k}`,
        about: 'The {name} lands {nth}, hitting at {speed} with the energy of {tnt}.',
        maxWords: 18,
        required: ['name', 'speed'],
        fallback: ['The {name} lands {nth}, hitting at {speed} with the energy of {tnt}.', 'The {name} hits {nth}, at {speed}, with as much energy as {tnt}.'],
      },
      facts: { name: names[k], nth: n === order.length - 1 && n > 0 ? 'last' : ordinal[n], time: durationText(im.t), speed: speedText(im.v, u), tnt: tntLabel(r.energy) },
      // Real time while the line is said, so the others keep falling at their true pace.
      coverS: estimateS(15),
      gapS: 1.5,
      mark: `impact${k}`,
    });
  });
  buildMoments(plan, moments, tEnd);
  // All their landings again, side by side and in step.
  if (replay && order.length) {
    s.mark('replay');
    s.hold(REPLAY.versus);
  }
  // The result.
  const ranked = runs.map((r, k) => ({ r, k })).sort((a, b) => b.r.energy - a.r.energy);
  const win = ranked[0];
  const lose = ranked[ranked.length - 1];
  const ratio = lose.r.energy > 0 ? win.r.energy / lose.r.energy : Infinity;
  s.mark('reveal');
  plan.say(
    lose.r.energy > 0
      ? {
          id: 'result',
          about: 'The {winner} wins, hitting {ratio} times harder than the {loser}.',
          maxWords: 16,
          required: ['winner'],
          fallback: ['The {winner} wins, hitting {ratio} times harder than the {loser}.', 'And the winner is the {winner}. It hit {ratio} times harder than the {loser}.'],
        }
      : {
          id: 'result',
          about: 'The {winner} wins, with the energy of {energy}; the {loser} never even reached the ground.',
          maxWords: 18,
          required: ['winner'],
          fallback: ['The {winner} wins, with the energy of {energy}. The {loser} never even reached the ground.'],
        },
    { winner: names[win.k], loser: names[lose.k], ratio: ratio > 1e6 ? 'a million' : Number(ratio.toPrecision(2)).toLocaleString('en-US'), energy: tntLabel(win.r.energy) },
  );
  s.mark('outro');
  s.hold(2.6);
  return { script: s, ticks: plan.ticks, ts: plan.ts, answer: names[win.k].toUpperCase() };
}

export function buildFall(runs: Run[], u: Units, ground: Ground, replay = false): Built {
  const built = runs.length === 1 ? soloScript(runs[0], u, replay) : versusScript(runs, u, replay);
  const sim: FallSim = { runs, tick: 0, simT: 0, keyTicks: built.ticks, keyT: built.ts, slopes: pchipSlopes(built.ticks, built.ts), units: u, ground, answer: built.answer };
  if (runs.length === 1) sim.answer = tntLabel(runs[0].energy).toUpperCase();
  return { sim, script: built.script };
}

export { craterOf, impactEnergy };
