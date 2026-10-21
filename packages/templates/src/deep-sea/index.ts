import { z } from 'zod';
import type { AmbientBed, AudioEventInput, DramaScore, Template } from '@sim/engine';
import { loadSound } from '../ambient/assets';
import { drawSea, preloadSea } from './view3d';
import { SOUNDS, seaSchedule, type SeaSchedule } from './schedule';

/**
 * Long-form ambient: the pilot's seat of a small submarine cruising forward through the ocean, a big
 * acrylic dome in front, the console's green instruments glowing in the dark. Three depths: the
 * twilight zone (lanternfish, squid, a red octopus, a swordfish, now and then a manta, a blue shark,
 * a whale far off, singing), the abyss (anglerfish, a gulper eel, a vampire squid, dumbo octopuses,
 * a sixgill shark, bioluminescent sparkles, all lit by the headlights), or a sunlit reef
 * (shoals of reef fish, sea turtles, rays, a reef shark, light rippling over coral and sand). A few
 * jellyfish everywhere, swimming properly.
 *
 * init() lays out the loop (schedule.ts): how far the submarine travels, which animals live there and
 * how often they pass, the visitors and the sounds. Each frame is drawn from t.
 */
export const deepSeaSchema = z.object({
  depth: z.enum(['twilight', 'abyss', 'reef']).default('twilight').meta({ title: 'Depth (twilight zone, abyss or sunlit reef)' }),
  life: z.number().min(0).max(1).default(0.6).meta({ title: 'Marine life' }),
  whalesPerHour: z.number().min(0).max(12).default(3).meta({ title: 'Whales per hour (not in the abyss)' }),
  floodlight: z.boolean().default(true).meta({ title: "Headlights (the abyss's only light)" }),
  snow: z.number().min(0).max(1).default(0.6).meta({ title: 'Marine snow' }),
  sonarPerHour: z.number().min(0).max(60).default(10).meta({ title: 'Sonar pings per hour' }),
  creaks: z.number().min(0).max(1).default(0.5).meta({ title: 'Hull creaks' }),
  drift: z.number().min(0).max(1).default(0.4).meta({ title: 'Cruising speed' }),
});

export type DeepSeaParams = z.infer<typeof deepSeaSchema>;

export interface DeepSeaState {
  p: DeepSeaParams;
  loopS: number;
  /** Visual-only seed (layout of rocks, coral, snow). */
  look: number;
  sched: SeaSchedule;
  next: number;
}

const BEDS = {
  water: 'audio/deep-water-300.opus',
  hum: 'audio/station-hum-200.opus',
} as const;
const BED_LENGTH_S: Record<string, number> = { [BEDS.water]: 300, [BEDS.hum]: 200 };

/**
 * The water's low rumble and the station's hum, at every depth. (A reef's snapping-shrimp crackle
 * was tried and dropped: real, but far too busy to relax to.)
 */
function beds(_p: DeepSeaParams): AmbientBed[] {
  return [
    { sound: BEDS.water, gain: 0.9, swell: { depth: 0.2, cycles: [2, 6, 11] } },
    { sound: BEDS.hum, gain: 0.45, pan: 0.15, swell: { depth: 0.08, cycles: [3, 9] } },
  ];
}

function oneShots(p: DeepSeaParams): string[] {
  return [...SOUNDS.bubbles, ...(p.creaks > 0 ? SOUNDS.creak : []), ...(p.depth !== 'abyss' && p.whalesPerHour > 0 ? SOUNDS.whale : []), ...(p.sonarPerHour > 0 ? SOUNDS.sonar : [])];
}

const NAME = { twilight: 'the twilight zone', abyss: 'the abyss', reef: 'a sunlit coral reef' } as const;

export const deepSea: Template<DeepSeaParams, DeepSeaState> = {
  id: 'deep-sea',
  name: 'Deep Sea Submarine',
  family: 'kinetic',
  description: 'Long-form ambient: a submarine cockpit cruising through the deep, a big glass dome, sea life passing in the dark.',
  schema: deepSeaSchema,
  format: { width: 1920, height: 1080, fps: 30 },
  longForm: {
    beds,
    // Read per frame; depth, life, speed and the sounds are in the scene and its schedule.
    liveParams: ['floodlight', 'snow'],
    minLoopS: 20 * 60,
    maxLoopS: 60 * 60,
    defaultLoopS: 30 * 60,
    // The water bed is 5 minutes and the hum 200 s: whole 10-minute steps suit both.
    loopStepS: 600,
    reverb: 0.35,
    thumbnailAt: (s: DeepSeaState) => {
      const w = s.sched.whales[0];
      return w ? (w.t0 + w.t1) / 2 : s.loopS / 4;
    },
    describe: (p: DeepSeaParams) =>
      [
        `From the pilot's seat of a small submarine cruising slowly forward through ${NAME[p.depth]}, looking out through a big glass dome.`,
        p.depth === 'twilight'
          ? `Dim blue water and marine snow streaming past; shoals of lanternfish, squid and a red octopus jetting by, a swordfish on the hunt, the odd manta ray or blue shark${p.whalesPerHour > 0 ? ', and now and then a whale far off in the gloom, singing' : ''}.`
          : p.depth === 'abyss'
            ? `Near-black water lit only by the submarine's headlights: anglerfish, a gulper eel, a vampire squid, dumbo octopuses flapping their ear fins, a sixgill shark cruising through the beams, its eyes shining, tiny flashes of bioluminescence.`
            : `Sunlight rippling over sand and coral, shafts of light from the surface, shoals of reef fish, sea turtles, rays gliding past, a reef shark.`,
        `A few jellyfish pulse by. Inside it is almost dark: green-lit dials and meters, a glowing sonar screen.`,
        `Sound: deep underwater ambience and the submarine's low hum${p.creaks > 0 ? ', the hull creaking now and then' : ''}, bubbles venting${p.depth !== 'abyss' && p.whalesPerHour > 0 ? ', humpback whale song' : ''}${p.sonarPerHour > 0 ? ', a soft sonar ping' : ''}.`,
      ].join(' '),
    fallbackCopy: (p: DeepSeaParams, len: string) => {
      const scene = p.depth === 'reef' ? 'Coral Reef' : p.depth === 'abyss' ? 'Deep Abyss' : 'Deep Ocean';
      return {
        title: `${scene} Submarine Ambience | Underwater Cockpit, ${p.depth === 'abyss' ? 'Deep Sea' : 'Whale'} Sounds for Sleep | ${len}`,
        description: `${deepSea.longForm!.describe!(p)}\n\nPut it on to fall asleep, study, read or focus. ${len} of one continuous, calm scene.\n\n#underwatersounds #oceanambience #sleepsounds`,
        tags: ['underwater ambience', 'deep sea sounds', 'ocean sounds', p.depth === 'reef' ? 'coral reef' : 'whale sounds', 'submarine ambience', 'sleep sounds', 'study ambience', 'relaxing sounds'],
        thumbnailText: p.depth === 'abyss' ? 'THE ABYSS' : p.depth === 'reef' ? 'CORAL REEF' : 'DEEP OCEAN',
      };
    },
  },
  substeps: 1,
  searchBudget: 1,
  ownMusic: true,
  glowScale: 0,
  defaultCopy: { hook: '', cta: '' },

  preload: (p) => Promise.all([preloadSea(p), ...beds(p).map((b) => loadSound(b.sound, BED_LENGTH_S[b.sound])), ...oneShots(p).map((c) => loadSound(c))]).then(() => undefined),

  init({ params, rng, loopS }) {
    const L = loopS || 30 * 60;
    const look = rng.int(1, 1_000_000);
    const sched = seaSchedule(
      // Cruising speed 0.3–1.5 m/s (about half a knot to three knots).
      { depth: params.depth, life: params.life, whalesPerHour: params.whalesPerHour, sonarPerHour: params.sonarPerHour, creaks: params.creaks, speed: 0.3 + 1.2 * params.drift },
      L,
      rng,
    );
    return { p: params, loopS: L, look, sched, next: 0 };
  },

  step(s, { t, dt, emit }) {
    const cues = s.sched.cues;
    while (s.next < cues.length && cues[s.next].t < t + dt) {
      const c = cues[s.next++];
      emit({ type: 'sample', clip: c.clip, vel: c.vel, pan: c.pan, rate: c.rate });
    }
  },

  isDone: () => false,
  hud: () => ({}),
  overlays: () => [],

  render(rc, s) {
    drawSea(rc, s);
  },

  audio(e): AudioEventInput[] {
    if (e.type === 'sample') return [{ kind: 'sample', name: e.clip as string, vel: e.vel as number, rate: e.rate as number, pan: e.pan as number }];
    return [];
  },

  score(events, info): DramaScore {
    const ts = events.filter((e) => e.type === 'sample').map((e) => e.t);
    let longest = 0;
    for (let i = 1; i < ts.length; i++) longest = Math.max(longest, ts[i] - ts[i - 1]);
    const spread = ts.length > 1 ? Math.max(0, 1 - longest / Math.max(120, info.durationS / 3)) : 0.3;
    return { total: 0.5 + 0.5 * spread, parts: { spread } };
  },
};
