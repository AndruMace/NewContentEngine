import { z } from 'zod';
import type { AmbientBed, AudioEventInput, DramaScore, Template } from '@sim/engine';
import { Rng } from '@sim/engine';
import { scheduleTimes, wrap } from '../ambient/loop';
import { clipPicker } from '../ambient/pool';
import { drawCabin, preloadCabin } from './view3d';
import { loadSound } from '../ambient/assets';

/**
 * Long-form ambient: inside a log cabin, a crackling fire, a thunderstorm through big windows.
 *
 * There is no simulation as such: init() lays out a seeded schedule of cues for the whole master
 * loop (lightning and its thunder), step() emits them on time, and every
 * frame is drawn from t and that schedule alone. All cue times live in [0, loopS): a thunderclap
 * that would land after the end wraps to the start, so the loop repeats seamlessly.
 */
export const cabinStormSchema = z.object({
  storm: z.number().min(0).max(1).default(0.6).meta({ title: 'Storm intensity' }),
  lightningPerHour: z.number().min(0).max(120).default(30).meta({ title: 'Lightning strikes per hour' }),
  thunder: z.number().min(0).max(1).default(0.7).meta({ title: 'Thunder volume' }),
  fire: z.number().min(0).max(1).default(0.7).meta({ title: 'Fire size' }),
  precipitation: z.enum(['rain', 'snow']).default('rain').meta({ title: 'Rain or snow' }),
  rainSound: z.enum(['window', 'steady']).default('window').meta({ title: 'Rain sound (rain on the window, or steady rain)' }),
});

export type CabinStormParams = z.infer<typeof cabinStormSchema>;

export interface Strike {
  t: number;
  /** 0..1, how bright the flash is (brightness is capped in the view). */
  strength: number;
  /** Seconds between the flash and its thunder (≈ 3 s per km). */
  delay: number;
  /** Where along the windows the bolt is, 0..1. */
  x: number;
  /** Start times of the flash's pulses, relative to t (at most 2, so never more than 2 flashes a second). */
  pulses: number[];
}

type Cue =
  | { t: number; type: 'lightning'; strike: number }
  | { t: number; type: 'thunder'; strike: number; vel: number; clip: string; rate: number; pan: number };

export interface CabinState {
  p: CabinStormParams;
  loopS: number;
  strikes: Strike[];
  cues: Cue[];
  next: number;
}

/** Minimum time between strikes, so flashes never come in bursts. */
const MIN_STRIKE_GAP_S = 12;
/** Recorded beds (see scripts/build-ambient-audio.ts): rain on the window, the fire, wind gusts. */
const SOUNDS = {
  rainWindow: 'audio/rain-window-600.opus',
  rainSteady: 'audio/rain-steady-600.opus',
  fire: 'audio/fire-hearth-600.opus',
  wind: 'audio/wind-howl-60.opus',
} as const;
const SOUND_LENGTH_S: Record<string, number> = {
  [SOUNDS.rainWindow]: 600,
  [SOUNDS.rainSteady]: 600,
  [SOUNDS.fire]: 600,
  [SOUNDS.wind]: 60,
};

/** The beds a setting plays: rain (unless it's snowing), the fire, and wind (stronger in snow). */
function beds(p: CabinStormParams): AmbientBed[] {
  const snow = p.precipitation === 'snow';
  const out: AmbientBed[] = [];
  if (!snow) out.push({ sound: p.rainSound === 'steady' ? SOUNDS.rainSteady : SOUNDS.rainWindow, gain: 0.55 + 0.5 * p.storm, swell: { depth: 0.25, cycles: [3, 7, 13] } });
  out.push({ sound: SOUNDS.fire, gain: 0.45 + 0.6 * p.fire, pan: -0.1, swell: { depth: 0.15, cycles: [5, 11] } });
  out.push({ sound: SOUNDS.wind, gain: (snow ? 0.35 : 0.15) + (snow ? 0.45 : 0.35) * p.storm, pan: 0.3, swell: { depth: 0.6, cycles: [2, 9, 17] } });
  return out;
}
/** Thunder one-shots: close claps (a sharp crack, then rumble) and distant rolls. */
const THUNDER = {
  close: [1, 2, 3, 4, 5, 6].map((i) => `audio/thunder-close-${i}.opus`),
  far: [1, 2, 3, 4, 5].map((i) => `audio/thunder-far-${i}.opus`),
};
/** Thunder within this many seconds of its flash (≈ 2 km) is a close clap. */
const CLOSE_DELAY_S = 6;

function schedule(p: CabinStormParams, L: number, rng: Rng): Pick<CabinState, 'strikes' | 'cues'> {
  const strikes: Strike[] = scheduleTimes(rng, L, p.lightningPerHour / 3600, MIN_STRIKE_GAP_S).map((t) => {
    const distanceKm = rng.range(0.6, 7);
    const strength = Math.min(1, (0.35 + rng.next() * 0.65) * (1.2 - distanceKm / 10));
    return { t, strength, delay: distanceKm * 2.9, x: rng.next(), pulses: rng.chance(0.45) ? [0, rng.range(0.18, 0.35)] : [0] };
  });
  const cues: Cue[] = [];
  const pickClose = clipPicker(rng, THUNDER.close);
  const pickFar = clipPicker(rng, THUNDER.far);
  strikes.forEach((s, i) => {
    cues.push({ t: s.t, type: 'lightning', strike: i });
    const near = s.delay < CLOSE_DELAY_S;
    cues.push({
      t: wrap(s.t + s.delay, L),
      type: 'thunder',
      strike: i,
      vel: (0.45 + 0.55 * s.strength) * (0.15 + 0.85 * p.thunder),
      clip: near ? pickClose() : pickFar(),
      rate: rng.range(0.92, 1.06),
      pan: (s.x - 0.5) * 1.2,
    });
  });
  cues.sort((a, b) => a.t - b.t);
  return { strikes, cues };
}

export const cabinStorm: Template<CabinStormParams, CabinState> = {
  id: 'cabin-storm',
  name: 'Cabin Storm',
  family: 'kinetic',
  description: 'Long-form ambient: a log cabin with a crackling fireplace and a thunderstorm outside the windows.',
  schema: cabinStormSchema,
  format: { width: 1920, height: 1080, fps: 30 },
  longForm: {
    beds,
    // Lightning and thunder are in the timetable; these are read per frame (and by the beds).
    liveParams: ['storm', 'fire', 'precipitation', 'rainSound'],
    minLoopS: 20 * 60,
    maxLoopS: 60 * 60,
    defaultLoopS: 30 * 60,
    // The rain and fire beds are 10-minute loops.
    loopStepS: 600,
    describe: (p: CabinStormParams) =>
      [
        `Inside a log cabin at night: a stone fireplace with a crackling fire (${p.fire > 0.6 ? 'a big fire' : 'a gentle fire'}), between two big windows.`,
        p.precipitation === 'snow'
          ? `Outside it is snowing${p.storm > 0.6 ? ' hard, wind gusting' : ''}.`
          : `Outside, ${p.storm > 0.7 ? 'a heavy' : p.storm > 0.4 ? 'a steady' : 'a light'} rainstorm, rain running down the glass.`,
        p.lightningPerHour > 0 ? `Lightning about ${Math.round(p.lightningPerHour)} times an hour, with thunder.` : 'No thunder.',
        'Sound: real recordings of the fire, rain on the windows, wind and thunder.',
      ].join(' '),
    fallbackCopy: (p: CabinStormParams, len: string) => {
      const snow = p.precipitation === 'snow';
      return {
        title: snow ? `Cozy Cabin in a Snowstorm | Crackling Fire & Wind Sounds for Sleep | ${len}` : `Cozy Cabin Thunderstorm | Crackling Fire & Rain Sounds for Sleep | ${len}`,
        description: `${cabinStorm.longForm!.describe!(p)}\n\nPut it on to fall asleep, study, read or work. ${len} of one continuous, calm scene.\n\n#${snow ? 'snowstorm' : 'rainsounds'} #fireplace #sleepsounds`,
        tags: snow
          ? ['snowstorm sounds', 'cozy cabin', 'fireplace sounds', 'crackling fire', 'wind sounds', 'sleep sounds', 'study ambience', 'winter ambience']
          : ['rain sounds', 'thunderstorm sounds', 'cozy cabin', 'fireplace sounds', 'crackling fire', 'rain for sleeping', 'sleep sounds', 'study ambience'],
        thumbnailText: snow ? 'SNOWY CABIN' : 'STORMY NIGHT',
      };
    },
    thumbnailAt: (s: CabinState) => {
      const best = s.strikes.reduce<Strike | null>((a, b) => (!a || b.strength > a.strength ? b : a), null);
      return best ? best.t + 0.04 : s.loopS / 2;
    },
  },
  substeps: 1,
  searchBudget: 1,
  ownMusic: true,
  glowScale: 0,
  defaultCopy: { hook: '', cta: '' },

  preload: (p) =>
    Promise.all([
      preloadCabin(),
      ...beds(p).map((b) => loadSound(b.sound, SOUND_LENGTH_S[b.sound])),
      ...(p.lightningPerHour > 0 ? [...THUNDER.close, ...THUNDER.far].map((clip) => loadSound(clip)) : []),
    ]).then(() => undefined),

  init({ params, rng, loopS }) {
    const L = loopS || 30 * 60;
    return { p: params, loopS: L, ...schedule(params, L, rng), next: 0 };
  },

  step(s, { t, dt, emit }) {
    while (s.next < s.cues.length && s.cues[s.next].t < t + dt) {
      const c = s.cues[s.next++];
      if (c.type === 'lightning') emit({ type: 'lightning', strike: c.strike, strength: s.strikes[c.strike].strength });
      else emit({ type: 'thunder', strike: c.strike, vel: c.vel, clip: c.clip, rate: c.rate, pan: c.pan });

    }
  },

  // The Runner ends long-form runs at loopS.
  isDone: () => false,
  hud: () => ({}),
  overlays: () => [],

  render(rc, s) {
    drawCabin(rc, s);
  },

  audio(e): AudioEventInput[] {
    switch (e.type) {
      case 'thunder':
        return [{ kind: 'sample', name: e.clip as string, vel: e.vel as number, rate: e.rate as number, pan: e.pan as number }];
      default:
        return [];
    }
  },

  score(events, info): DramaScore {
    // Nothing to win: a loop is good when lightning is spread out (no long dead stretches).
    const strikes = events.filter((e) => e.type === 'lightning').map((e) => e.t);
    let longestGap = 0;
    for (let i = 1; i < strikes.length; i++) longestGap = Math.max(longestGap, strikes[i] - strikes[i - 1]);
    const spread = strikes.length > 1 ? Math.max(0, 1 - longestGap / Math.max(60, info.durationS / 4)) : 0.5;
    return { total: 0.5 + 0.5 * spread, parts: { spread } };
  },
};
