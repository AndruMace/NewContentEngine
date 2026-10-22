import { z } from 'zod';
import type { AmbientBed, AudioEventInput, DramaScore, Template } from '@sim/engine';
import { loadSound } from '../ambient/assets';
import { drawTrain, preloadTrain } from './view3d';
import { SOUNDS, timetable, type Feature, type Timetable } from './track';

/**
 * Long-form ambient: a night in a sleeper compartment. The train never stops; the countryside slides
 * past the window (hills with town lights, farms, trees), with now and then a station it slows
 * through, a level crossing, a bridge or a tunnel, in rain, snow or a clear moonlit night.
 *
 * There is no simulation as such: init() lays out the loop's timetable (track.ts): the train's speed
 * profile over a ring of track exactly one loop long, the features along it, and every wheel click.
 * step() emits the sounds on time and each frame is drawn from t alone.
 */
export const nightTrainSchema = z.object({
  weather: z.enum(['rain', 'clear', 'snow']).default('rain').meta({ title: 'Weather' }),
  precip: z.number().min(0).max(1).default(0.6).meta({ title: 'Rain or snow intensity' }),
  speed: z.number().min(0).max(1).default(0.5).meta({ title: 'Speed (80–140 km/h)' }),
  track: z.enum(['jointed', 'welded']).default('jointed').meta({ title: 'Track (jointed: clickety-clack; welded: smooth)' }),
  townLights: z.number().min(0).max(1).default(0.5).meta({ title: 'Town and farm lights' }),
  crossingsPerHour: z.number().min(0).max(20).default(6).meta({ title: 'Level crossings per hour' }),
  bridgesPerHour: z.number().min(0).max(12).default(3).meta({ title: 'Bridges per hour' }),
  tunnelsPerHour: z.number().min(0).max(10).default(2).meta({ title: 'Tunnels per hour' }),
  horn: z.number().min(0).max(1).default(0.5).meta({ title: 'Horn volume' }),
  lamp: z.number().min(0).max(1).default(0.5).meta({ title: 'Lamp brightness' }),
  facing: z.enum(['backward', 'forward']).default('backward').meta({ title: 'Seat (facing backward or forward)' }),
});

export type NightTrainParams = z.infer<typeof nightTrainSchema>;

export interface NightTrainState {
  p: NightTrainParams;
  loopS: number;
  tt: Timetable;
  next: number;
}

const BEDS = {
  compartment: 'audio/train-compartment-600.opus',
  rain: 'audio/rain-window-600.opus',
  wind: 'audio/wind-howl-60.opus',
} as const;
const BED_LENGTH_S: Record<string, number> = { [BEDS.compartment]: 600, [BEDS.rain]: 600, [BEDS.wind]: 60 };

/** The compartment's rumble always; rain on the glass when it rains, wind past the carriage in snow. */
function beds(p: NightTrainParams): AmbientBed[] {
  const out: AmbientBed[] = [{ sound: BEDS.compartment, gain: 0.95, swell: { depth: 0.08, cycles: [2, 5, 11] } }];
  if (p.weather === 'rain') out.push({ sound: BEDS.rain, gain: 0.2 + 0.4 * p.precip, pan: -0.1, swell: { depth: 0.3, cycles: [3, 7, 13] } });
  if (p.weather === 'snow') out.push({ sound: BEDS.wind, gain: 0.1 + 0.25 * p.precip, pan: 0.2, swell: { depth: 0.5, cycles: [4, 9, 17] } });
  return out;
}

/** One-shots this setting can play. */
function oneShots(p: NightTrainParams): string[] {
  return [...(p.track === 'jointed' ? SOUNDS.click : []), ...SOUNDS.bell, ...(p.horn > 0 ? SOUNDS.horn : []), ...SOUNDS.tunnel, ...SOUNDS.bridge];
}

const KMH = (p: NightTrainParams) => 80 + 60 * p.speed;

export const nightTrain: Template<NightTrainParams, NightTrainState> = {
  id: 'night-train',
  name: 'Night Train',
  family: 'kinetic',
  category: 'ambient',
  description: 'Long-form ambient: a sleeper compartment at night, the countryside sliding past the window, rain on the glass.',
  schema: nightTrainSchema,
  format: { width: 1920, height: 1080, fps: 30 },
  longForm: {
    beds,
    // Read per frame (and by the beds); speed, track and the features are in the timetable.
    liveParams: ['weather', 'precip', 'townLights', 'lamp'],
    minLoopS: 20 * 60,
    maxLoopS: 60 * 60,
    defaultLoopS: 30 * 60,
    loopStepS: 600,
    reverb: 0.05,
    // Mid-way along the first station: lamps passing, the platform lit.
    thumbnailAt: (s: NightTrainState) => {
      const st = s.tt.features.find((f) => f.kind === 'station');
      return st ? (st.t0 + st.t1) / 2 : s.loopS / 3;
    },
    describe: (p: NightTrainParams) =>
      [
        `Inside an old-fashioned sleeper compartment on a night train: walnut panelling and brass, velour curtains, a fringed lamp glowing low on the table by a big window.`,
        p.weather === 'rain'
          ? `Rain streaks across the glass as the dark countryside slides past${p.precip > 0.7 ? ', a heavy downpour' : ''}.`
          : p.weather === 'snow'
            ? 'Snow streams past the window over moonlit white fields.'
            : 'A clear night: moonlight on the fields and hills, stars above.',
        `Town and farm lights in the distance; now and then a station, a level crossing with its bell, a bridge or a tunnel.`,
        `Sound: the real rumble and rattle of a sleeper carriage${p.track === 'jointed' ? ', the steady clickety-clack of the rails' : ''}${p.horn > 0 ? ', a distant horn' : ''}${p.weather === 'rain' ? ', rain on the window' : ''}.`,
        `About ${Math.round(KMH(p))} km/h, never stopping.`,
      ].join(' '),
    fallbackCopy: (p: NightTrainParams, len: string) => {
      const what = p.weather === 'rain' ? 'Rainy Night Train' : p.weather === 'snow' ? 'Snowy Night Train' : 'Night Train';
      return {
        title: `${what} Ambience | Sleeper Cabin, ${p.weather === 'rain' ? 'Rain & ' : ''}Train Sounds for Sleep | ${len}`,
        description: `${nightTrain.longForm!.describe!(p)}\n\nPut it on to fall asleep, study, read or work. ${len} of one continuous journey.\n\n#trainsounds #${p.weather === 'rain' ? 'rainsounds' : 'nighttrain'} #sleepsounds`,
        tags: ['train sounds', 'night train', 'train ambience', 'sleeper train', p.weather === 'rain' ? 'rain on train window' : p.weather === 'snow' ? 'snowy train ride' : 'train ride at night', 'sleep sounds', 'study ambience', 'clickety clack'],
        thumbnailText: p.weather === 'snow' ? 'SNOW TRAIN' : 'NIGHT TRAIN',
      };
    },
  },
  // Wheel clicks land within a few milliseconds (events take their substep's time).
  substeps: 8,
  searchBudget: 1,
  ownMusic: true,
  glowScale: 0,
  defaultCopy: { hook: '', cta: '' },

  preload: (p) =>
    Promise.all([preloadTrain(), ...beds(p).map((b) => loadSound(b.sound, BED_LENGTH_S[b.sound])), ...oneShots(p).map((c) => loadSound(c))]).then(() => undefined),

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
      },
      L,
      rng,
    );
    return { p: params, loopS: L, tt, next: 0 };
  },

  step(s, { t, dt, emit }) {
    const cues = s.tt.cues;
    while (s.next < cues.length && cues[s.next].t < t + dt) {
      const c = cues[s.next++];
      emit({ type: c.type, clip: c.clip, vel: c.vel, pan: c.pan, rate: c.rate });
    }
  },

  isDone: () => false,
  hud: () => ({}),
  overlays: () => [],

  render(rc, s) {
    drawTrain(rc, s);
  },

  audio(e): AudioEventInput[] {
    if (e.type === 'click' || e.type === 'sample') return [{ kind: 'sample', name: e.clip as string, vel: e.vel as number, rate: e.rate as number, pan: e.pan as number }];
    return [];
  },

  score(events, info): DramaScore {
    // A good loop has things passing the window regularly, no long empty stretches.
    const ts = events.filter((e) => e.type === 'sample').map((e) => e.t);
    let longest = 0;
    for (let i = 1; i < ts.length; i++) longest = Math.max(longest, ts[i] - ts[i - 1]);
    const spread = ts.length > 1 ? Math.max(0, 1 - longest / Math.max(120, info.durationS / 3)) : 0.3;
    return { total: 0.5 + 0.5 * spread, parts: { spread } };
  },
};

export type { Feature };
