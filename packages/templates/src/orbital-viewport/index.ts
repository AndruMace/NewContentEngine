import { z } from 'zod';
import type { AmbientBed, AudioEventInput, DramaScore, Template } from '@sim/engine';
import { Rng } from '@sim/engine';
import { scheduleTimes } from '../ambient/loop';
import { loadSound } from '../ambient/assets';
import { drawOrbit, preloadOrbit } from './view3d';

/**
 * Long-form ambient: looking out of a spaceship's viewport at a large planet turning slowly below,
 * clouds drifting, the occasional shooting star.
 *
 * As with Cabin Storm, init() lays out a seeded schedule of cues for the whole loop (shooting stars,
 * console chirps, the hum), step() emits them, and every frame is drawn from t and that schedule.
 * The planet and its clouds turn a whole number of times per loop, so the loop repeats seamlessly.
 */
export const PLANETS = ['earthlike', 'ocean', 'desert', 'ice', 'gas'] as const;
export const CABIN_LIGHTS = ['cool', 'amber', 'red'] as const;

export const orbitalViewportSchema = z.object({
  planet: z.enum(PLANETS).default('earthlike').meta({ title: 'Planet' }),
  rings: z.boolean().default(false).meta({ title: 'Rings' }),
  moons: z.number().int().min(0).max(2).default(1).meta({ title: 'Moons' }),
  shootingStarsPerHour: z.number().min(0).max(90).default(20).meta({ title: 'Shooting stars per hour' }),
  cabinLight: z.enum(CABIN_LIGHTS).default('cool').meta({ title: 'Cabin lighting' }),
  hum: z.number().min(0).max(1).default(0.5).meta({ title: 'Ship hum volume' }),
});

export type OrbitalViewportParams = z.infer<typeof orbitalViewportSchema>;

export interface Meteor {
  t: number;
  /** Seconds it takes to cross. */
  dur: number;
  /** Start in viewport coordinates (0..1 across, 0..1 up) and travel direction (radians). */
  u: number;
  v: number;
  angle: number;
  /** Streak length as a fraction of the viewport width. */
  len: number;
  bright: number;
}

type Cue = { t: number; type: 'meteor'; meteor: number } | { t: number; type: 'chirp'; notes: number[]; vel: number; pan: number } | { t: number; type: 'hum'; vel: number };

export interface OrbitState {
  p: OrbitalViewportParams;
  loopS: number;
  meteors: Meteor[];
  cues: Cue[];
  next: number;
  /** Visual-only seed for the planet's surface, clouds and stars. */
  look: number;
}

const ROOMTONE = 'audio/ship-roomtone-120.opus';
/** The hum: one overlapping stretch of the synth's room tone every 4 s. */
const HUM_EVERY_S = 4;
/** Soft console blips, a few notes of a pentatonic scale high up. */
const CHIRP_NOTES = [84, 86, 88, 91, 93, 96];

function schedule(p: OrbitalViewportParams, L: number, rng: Rng): Pick<OrbitState, 'meteors' | 'cues'> {
  const meteors: Meteor[] = scheduleTimes(rng, L, p.shootingStarsPerHour / 3600, 20).map((t) => ({
    t,
    dur: rng.range(0.5, 1.3),
    u: rng.range(0.1, 0.9),
    v: rng.range(0.45, 0.95),
    // Mostly falling towards the planet, from either side.
    angle: (rng.chance(0.5) ? -1 : 1) * rng.range(0.35, 0.95) - Math.PI / 2,
    len: rng.range(0.06, 0.16),
    bright: rng.range(0.4, 1),
  }));
  const cues: Cue[] = meteors.map((_, i) => ({ t: meteors[i].t, type: 'meteor', meteor: i }));
  for (let t = 0; t < L; t += HUM_EVERY_S) cues.push({ t, type: 'hum', vel: 0.15 + 0.5 * p.hum });
  // A blip is one to three quick notes; none starts near the loop's end, so it never wraps mid-blip.
  for (const t of scheduleTimes(rng, L - 2, 1 / 50, 15)) {
    const n = rng.int(1, 3);
    const vel = rng.range(0.03, 0.06);
    const pan = rng.range(-0.6, 0.6);
    for (let k = 0; k < n; k++) cues.push({ t: t + k * 0.11, type: 'chirp', notes: [rng.pick(CHIRP_NOTES)], vel, pan });
  }
  cues.sort((a, b) => a.t - b.t);
  return { meteors, cues };
}

const beds = (p: OrbitalViewportParams): AmbientBed[] => [{ sound: ROOMTONE, gain: 0.5 + 0.3 * p.hum, swell: { depth: 0.1, cycles: [3, 8] } }];

export const orbitalViewport: Template<OrbitalViewportParams, OrbitState> = {
  id: 'orbital-viewport',
  name: 'Orbital Viewport',
  family: 'kinetic',
  description: 'Long-form ambient: a spaceship viewport over a large planet, clouds drifting, the occasional shooting star.',
  schema: orbitalViewportSchema,
  format: { width: 1920, height: 1080, fps: 30 },
  longForm: {
    beds,
    minLoopS: 20 * 60,
    maxLoopS: 60 * 60,
    defaultLoopS: 30 * 60,
    // The room-tone bed is 2 minutes; whole 10-minute steps keep the choice the same as Cabin Storm.
    loopStepS: 600,
    reverb: 0.25,
    describe: (p: OrbitalViewportParams) => {
      const names: Record<string, string> = { earthlike: 'an Earth-like planet', ocean: 'an ocean world', desert: 'a desert planet', ice: 'an ice world', gas: 'a gas giant' };
      return [
        `Looking out of a spaceship's viewport at ${names[p.planet] ?? 'a planet'} turning slowly below${p.rings ? ', with rings' : ''}, clouds drifting.`,
        p.moons ? `${p.moons} moon${p.moons === 1 ? '' : 's'} in the sky.` : '',
        p.shootingStarsPerHour > 0 ? 'Now and then a shooting star.' : '',
        `${p.cabinLight} cabin lighting, quiet consoles.`,
        "Sound: the ship's low hum and room tone, with the odd soft console blip.",
      ]
        .filter(Boolean)
        .join(' ');
    },
    fallbackCopy: (p: OrbitalViewportParams, len: string) => ({
      title: `Spaceship Ambience | Orbiting a Planet | Deep Space Sounds for Sleep & Focus | ${len}`,
      description: `${orbitalViewport.longForm!.describe!(p)}\n\nPut it on to fall asleep, study or focus. ${len} of one continuous, calm scene.\n\n#spaceambience #sleepsounds #studymusic`,
      tags: ['spaceship ambience', 'space ambience', 'sleep sounds', 'study ambience', 'white noise', 'planet view', 'sci-fi ambience', 'focus sounds'],
      thumbnailText: 'ORBIT',
    }),
    thumbnailAt: (s: OrbitState) => {
      const best = s.meteors.reduce<Meteor | null>((a, b) => (!a || b.bright > a.bright ? b : a), null);
      return best ? best.t + best.dur * 0.45 : s.loopS / 3;
    },
  },
  substeps: 1,
  searchBudget: 1,
  ownMusic: true,
  glowScale: 0,
  defaultCopy: { hook: '', cta: '' },

  preload: (p) => Promise.all([preloadOrbit(p), loadSound(ROOMTONE, 120)]).then(() => undefined),

  init({ params, rng, loopS }) {
    const L = loopS || 30 * 60;
    const look = rng.int(1, 1_000_000);
    return { p: params, loopS: L, look, ...schedule(params, L, rng), next: 0 };
  },

  step(s, { t, dt, emit }) {
    while (s.next < s.cues.length && s.cues[s.next].t < t + dt) {
      const c = s.cues[s.next++];
      if (c.type === 'meteor') emit({ type: 'meteor', meteor: c.meteor });
      else if (c.type === 'hum') emit({ type: 'hum', vel: c.vel });
      else emit({ type: 'chirp', notes: c.notes, vel: c.vel, pan: c.pan });
    }
  },

  isDone: () => false,
  hud: () => ({}),
  overlays: () => [],

  render(rc, s) {
    drawOrbit(rc, s);
  },

  audio(e): AudioEventInput[] {
    switch (e.type) {
      case 'hum':
        // Ventilation rumble and a faint mains hum (the synth's industrial room tone).
        return [{ kind: 'sfx', name: 'ambience', vel: e.vel as number, pitch: 0.5 }];
      case 'chirp':
        return (e.notes as number[]).map((midi) => ({ kind: 'note', midi, vel: e.vel as number, voice: 'glass', dur: 0.35, pan: e.pan as number }));
      default:
        // Shooting stars are silent: it's space.
        return [];
    }
  },

  score(events, info): DramaScore {
    const meteors = events.filter((e) => e.type === 'meteor').map((e) => e.t);
    let longestGap = 0;
    for (let i = 1; i < meteors.length; i++) longestGap = Math.max(longestGap, meteors[i] - meteors[i - 1]);
    const spread = meteors.length > 1 ? Math.max(0, 1 - longestGap / Math.max(60, info.durationS / 4)) : 0.5;
    return { total: 0.5 + 0.5 * spread, parts: { spread } };
  },
};
