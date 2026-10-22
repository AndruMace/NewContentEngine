import { z } from 'zod';
import type { AmbientBed, AudioEventInput, DramaScore, Template } from '@sim/engine';
import { loadSound } from '../ambient/assets';
import { SOUNDS, timetable, type Timetable } from '../night-train/track';
import { drawDay, preloadDay } from './view3d';
import { settlements, RING_STEP_DAY, type Settlement } from './settlements';

/**
 * Long-form ambient: a day on a train through storybook country. A first-class compartment (walnut,
 * brass, blue velour) and a big window; outside, rolling green hills, fields and woods, villages with
 * half-timbered cottages, windmills, walled towns with castles and spires on the hilltops, now and
 * then a city far off on a ridge. Sunny (midday, or a golden afternoon) or rain.
 *
 * No simulation as such: init() lays out the loop's timetable (night-train/track.ts, on a ring a
 * whole number of 4800 m so every band of scenery closes on itself) and where the settlements are
 * along it (settlements.ts). Each frame is drawn from t alone.
 */
export const dayTrainSchema = z.object({
  weather: z.enum(['sun', 'rain']).default('sun').meta({ title: 'Weather' }),
  timeOfDay: z.enum(['midday', 'golden']).default('midday').meta({ title: 'Time of day (when sunny: midday or golden afternoon)' }),
  precip: z.number().min(0).max(1).default(0.6).meta({ title: 'Rain intensity' }),
  speed: z.number().min(0).max(1).default(0.5).meta({ title: 'Speed (80–140 km/h)' }),
  track: z.enum(['jointed', 'welded']).default('jointed').meta({ title: 'Track (jointed: clickety-clack; welded: smooth)' }),
  villages: z.number().min(0).max(1).default(0.6).meta({ title: 'Villages and farms' }),
  castles: z.number().min(0).max(1).default(0.5).meta({ title: 'Walled towns, castles and cities' }),
  crossingsPerHour: z.number().min(0).max(20).default(5).meta({ title: 'Level crossings per hour' }),
  bridgesPerHour: z.number().min(0).max(12).default(3).meta({ title: 'Bridges per hour' }),
  tunnelsPerHour: z.number().min(0).max(10).default(1).meta({ title: 'Tunnels per hour' }),
  horn: z.number().min(0).max(1).default(0.35).meta({ title: 'Horn volume' }),
  facing: z.enum(['backward', 'forward']).default('backward').meta({ title: 'Seat (facing backward or forward)' }),
});

export type DayTrainParams = z.infer<typeof dayTrainSchema>;

export interface DayTrainState {
  p: DayTrainParams;
  loopS: number;
  tt: Timetable;
  towns: Settlement[];
  next: number;
  nextTown: number;
}

const BEDS = {
  compartment: 'audio/train-compartment-600.opus',
  rain: 'audio/rain-window-600.opus',
} as const;
const BED_LENGTH_S: Record<string, number> = { [BEDS.compartment]: 600, [BEDS.rain]: 600 };

function beds(p: DayTrainParams): AmbientBed[] {
  const out: AmbientBed[] = [{ sound: BEDS.compartment, gain: 0.95, swell: { depth: 0.08, cycles: [2, 5, 11] } }];
  if (p.weather === 'rain') out.push({ sound: BEDS.rain, gain: 0.2 + 0.4 * p.precip, pan: -0.1, swell: { depth: 0.3, cycles: [3, 7, 13] } });
  return out;
}

function oneShots(p: DayTrainParams): string[] {
  return [...(p.track === 'jointed' ? SOUNDS.click : []), ...SOUNDS.bell, ...(p.horn > 0 ? SOUNDS.horn : []), ...SOUNDS.tunnel, ...SOUNDS.bridge];
}

const KMH = (p: DayTrainParams) => 80 + 60 * p.speed;

export const dayTrain: Template<DayTrainParams, DayTrainState> = {
  id: 'day-train',
  name: 'Day Train',
  family: 'kinetic',
  category: 'ambient',
  description: 'Long-form ambient: a day on a train through storybook country, green hills, villages and castles sliding past the window.',
  schema: dayTrainSchema,
  format: { width: 1920, height: 1080, fps: 30 },
  longForm: {
    beds,
    liveParams: ['weather', 'timeOfDay', 'precip'],
    minLoopS: 20 * 60,
    maxLoopS: 60 * 60,
    defaultLoopS: 30 * 60,
    loopStepS: 600,
    reverb: 0.05,
    // A walled town (or a castle) in view.
    thumbnailAt: (s: DayTrainState) => {
      const t = s.towns.find((w) => w.kind === 'town') ?? s.towns.find((w) => w.kind === 'castle');
      return t ? t.t : s.loopS / 3;
    },
    describe: (p: DayTrainParams) =>
      [
        `Inside a first-class compartment on an old-fashioned train: walnut panelling and brass, blue velour seats, a big window.`,
        p.weather === 'rain'
          ? `Rain streaks across the glass; outside, green hills under a grey sky, mist in the valleys.`
          : p.timeOfDay === 'golden'
            ? `A golden afternoon: low warm sun, long shadows over rolling green hills.`
            : `A bright summer day: rolling green hills, patchwork fields and woods under a blue sky with drifting clouds.`,
        `A storybook land slides past: villages of half-timbered and thatched cottages, windmills, walled towns with castles and spires on the hilltops, now and then a city far off on a ridge; stone bridges over rivers, a tunnel, a country station.`,
        `Sound: the rumble and rattle of the carriage${p.track === 'jointed' ? ', the steady clickety-clack of the rails' : ''}${p.horn > 0 ? ', a distant horn' : ''}${p.weather === 'rain' ? ', rain on the window' : ''}.`,
        `About ${Math.round(KMH(p))} km/h, never stopping.`,
      ].join(' '),
    fallbackCopy: (p: DayTrainParams, len: string) => {
      const what = p.weather === 'rain' ? 'Rainy Day Train' : p.timeOfDay === 'golden' ? 'Golden Hour Train' : 'Sunny Train';
      return {
        title: `${what} Ride Through a Fairytale Countryside | Train Sounds for Study & Relaxing | ${len}`,
        description: `${dayTrain.longForm!.describe!(p)}\n\nPut it on to study, read, work or unwind. ${len} of one continuous journey.\n\n#trainsounds #trainride #fantasyambience`,
        tags: ['train sounds', 'train ride', 'train ambience', 'fantasy ambience', 'fairytale village', p.weather === 'rain' ? 'rain on train window' : 'countryside train', 'study ambience', 'relaxing', 'clickety clack'],
        thumbnailText: p.weather === 'rain' ? 'RAINY TRAIN' : 'STORYBOOK TRAIN',
      };
    },
  },
  substeps: 8,
  searchBudget: 1,
  ownMusic: true,
  glowScale: 0,
  defaultCopy: { hook: '', cta: '' },

  preload: (p) => Promise.all([preloadDay(), ...beds(p).map((b) => loadSound(b.sound, BED_LENGTH_S[b.sound])), ...oneShots(p).map((c) => loadSound(c))]).then(() => undefined),

  init({ params, rng, loopS }) {
    const L = loopS || 30 * 60;
    const tt = timetable(
      {
        speed: KMH(params) / 3.6,
        jointed: params.track === 'jointed',
        crossingsPerHour: params.crossingsPerHour,
        tunnelsPerHour: params.tunnelsPerHour,
        bridgesPerHour: params.bridgesPerHour,
        horn: params.horn,
        dir: params.facing === 'forward' ? -1 : 1,
        ringStep: RING_STEP_DAY,
      },
      L,
      rng,
    );
    const towns = settlements(tt, L, { villages: params.villages, castles: params.castles }, rng);
    return { p: params, loopS: L, tt, towns, next: 0, nextTown: 0 };
  },

  step(s, { t, dt, emit }) {
    const cues = s.tt.cues;
    while (s.next < cues.length && cues[s.next].t < t + dt) {
      const c = cues[s.next++];
      emit({ type: c.type, clip: c.clip, vel: c.vel, pan: c.pan, rate: c.rate });
    }
    // Settlements coming level with the window (silent: for the score).
    while (s.nextTown < s.towns.length && s.towns[s.nextTown].t < t + dt) emit({ type: 'town', kind: s.towns[s.nextTown++].kind });
  },

  isDone: () => false,
  hud: () => ({}),
  overlays: () => [],

  render(rc, s) {
    drawDay(rc, s);
  },

  audio(e): AudioEventInput[] {
    if (e.type === 'click' || e.type === 'sample') return [{ kind: 'sample', name: e.clip as string, vel: e.vel as number, rate: e.rate as number, pan: e.pan as number }];
    return [];
  },

  score(events, info): DramaScore {
    // A good loop keeps the towns and villages coming: no long stretch of empty country.
    const ts = events.filter((e) => e.type === 'town').map((e) => e.t);
    let longest = 0;
    for (let i = 1; i < ts.length; i++) longest = Math.max(longest, ts[i] - ts[i - 1]);
    const spread = ts.length > 1 ? Math.max(0, 1 - longest / Math.max(120, info.durationS / 3)) : 0.5;
    return { total: 0.5 + 0.5 * spread, parts: { spread } };
  },
};
