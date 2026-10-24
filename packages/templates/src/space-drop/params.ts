import { z } from 'zod';
import { storyParams } from '../story';
import { OBJECTS, OBJECT_IDS } from './objects';

export const SPACE_DROP_MODES = ['solo', 'versus'] as const;

const NAMES = Object.fromEntries(OBJECTS.map((o) => [o.id, o.name]));
const pick = (title: string, def: string, modes: string[]) => z.enum(OBJECT_IDS).default(def).meta({ title, optionLabels: NAMES, modes });

export const spaceDropSchema = z.object({
  mode: z.enum(SPACE_DROP_MODES).default('solo').meta({ title: 'Mode', optionLabels: { solo: 'Solo: one object, release to crater', versus: 'Versus: 2–3 dropped together, side by side' } }),
  ...storyParams(50),
  object: pick('Object', 'tungsten-rod', ['solo']),
  versusA: pick('Object 1', 'tungsten-rod', ['versus']),
  versusB: pick('Object 2', 'bowling-ball', ['versus']),
  versusC: z.enum(['none', ...OBJECT_IDS]).default('none').meta({ title: 'Object 3', optionLabels: { none: 'None', ...NAMES }, modes: ['versus'] }),
  rodTonnes: z.number().min(0.01).max(1000).default(9).meta({ title: 'Tungsten rod mass (tonnes; 9 t is the classic 6 m × 0.3 m rod)', step: 0.01 }),
  rodFlight: z.enum(['nose', 'tumble']).default('nose').meta({ title: 'Tungsten rod flies', optionLabels: { nose: 'Point-first (fins keep it straight)', tumble: 'Tumbling end over end' } }),
  start: z.enum(['auto', 'drop', 'orbit', 'meteor']).default('auto').meta({
    title: 'How it starts falling',
    optionLabels: { auto: 'Auto (each object’s usual way)', drop: 'Dropped from rest above the ground', orbit: 'De-orbited from a circular orbit', meteor: 'Arrives from deep space, as a meteor' },
  }),
  orbitAltitude: z.number().min(160).max(2000).default(300).meta({ title: 'Orbit altitude when de-orbited (km; the space station flies at about 400)', step: 10 }),
  dropAltitude: z.number().min(100).max(2000).default(100).meta({ title: 'Drop altitude when dropped from rest (km; the edge of space is 100)', step: 10 }),
  entryAngle: z.number().min(2).max(60).default(4).meta({ title: 'Entry angle below horizontal at 120 km (°; real re-entries from orbit are 1–5°)', step: 0.5 }),
  meteorSpeed: z.number().min(11.2).max(72).default(17).meta({ title: 'Meteor speed at 120 km (km/s; 11.2 to 72 is possible)', step: 0.1 }),
  meteorAngle: z.number().min(5).max(90).default(45).meta({ title: 'Meteor angle below horizontal (°)', step: 1 }),
  ground: z.enum(['sand', 'soil', 'rock']).default('sand').meta({ title: 'Lands on', optionLabels: { sand: 'Desert sand', soil: 'Farmland', rock: 'Granite' } }),
  units: z.enum(['metric', 'imperial']).default('metric').meta({ title: 'Units', optionLabels: { metric: 'Metric (km/h, °C)', imperial: 'US (mph, °F)' } }),
  ladder: z.boolean().default(true).meta({ title: 'Altitude ladder (atmosphere layers, landmarks)' }),
});

export type SpaceDropParams = z.infer<typeof spaceDropSchema>;
