/**
 * What can be dropped: each object's mass, size and shape (for drag), how it flies (nose-first or
 * tumbling), what its surface is made of (for heating and ablation), how much air pressure it can
 * take before it tears apart, and what is left of it if it does.
 *
 * Masses and sizes are typical real-world figures (a mid-size sedan, an empty jumbo jet, a 20-foot
 * container loaded to 24 t, a US penny). Generic, unbranded.
 */
import * as dm from '@sim/physics/math';

export type Shape = { kind: 'box'; l: number; w: number; h: number } | { kind: 'cyl'; l: number; d: number } | { kind: 'sphere'; d: number } | { kind: 'disc'; d: number; t: number };

/** How the drag coefficient behaves (see drag.ts). */
export type DragKind = 'sphere' | 'bluff' | 'disc' | 'slender';

export interface Material {
  name: string;
  /** Density (kg/m³), specific heat (J/kg·K), conductivity (W/m·K). */
  rho: number;
  cp: number;
  k: number;
  /** Temperature the surface can't rise past: it melts (or chars) and is swept away (K). */
  tAbl: number;
  /** Effective heat of ablation: energy to heat, melt (or char) and remove a kilogram (J/kg). */
  qAbl: number;
  emissivity: number;
}

export const MATERIALS = {
  tungsten: { name: 'tungsten', rho: 19250, cp: 150, k: 120, tAbl: 3695, qAbl: 150 * 3395 + 192e3, emissivity: 0.35 },
  steel: { name: 'steel', rho: 7850, cp: 600, k: 40, tAbl: 1730, qAbl: 600 * 1430 + 270e3, emissivity: 0.8 },
  iron: { name: 'meteoric iron', rho: 7800, cp: 650, k: 40, tAbl: 1800, qAbl: 2.0e6, emissivity: 0.8 },
  stone: { name: 'stony rock', rho: 3300, cp: 800, k: 2.5, tAbl: 1900, qAbl: 2.5e6, emissivity: 0.9 },
  aluminium: { name: 'aluminium', rho: 2700, cp: 1000, k: 200, tAbl: 933, qAbl: 1000 * 633 + 397e3, emissivity: 0.4 },
  titanium: { name: 'titanium', rho: 4500, cp: 600, k: 20, tAbl: 1941, qAbl: 600 * 1641 + 365e3, emissivity: 0.5 },
  zinc: { name: 'zinc', rho: 7140, cp: 390, k: 116, tAbl: 693, qAbl: 390 * 393 + 112e3, emissivity: 0.4 },
  resin: { name: 'resin', rho: 1300, cp: 1500, k: 0.25, tAbl: 650, qAbl: 2.5e6, emissivity: 0.9 },
  // Wood chars rather than melts: the char layer insulates and its gases blow the heat away, so it
  // ablates slowly (early Chinese return capsules used oak heat shields).
  wood: { name: 'wood', rho: 600, cp: 1700, k: 0.15, tAbl: 900, qAbl: 8e6, emissivity: 0.9 },
  tissue: { name: 'flesh', rho: 1050, cp: 3500, k: 0.5, tAbl: 700, qAbl: 4e6, emissivity: 0.9 },
  brick: { name: 'brick', rho: 1900, cp: 850, k: 0.8, tAbl: 1500, qAbl: 2.5e6, emissivity: 0.9 },
} satisfies Record<string, Material>;
export type MaterialId = keyof typeof MATERIALS;

export interface Body {
  /** What it's called once it's all that's left ("the engine block"). */
  name: string;
  mass: number;
  shape: Shape;
  attitude: 'nose' | 'tumble';
  drag: DragKind;
  material: MaterialId;
  /** A thin outer skin over a hollow inside (m): when it has burned through, the object comes apart. */
  shell?: number;
  /** Dynamic pressure that tears it apart (Pa). */
  strength: number;
  /** Average area facing the flow, when the box-of-its-size estimate is far off (a jet's wings). */
  area?: number;
  /** What happens when it breaks up. */
  breakup?: { kind: 'core'; core: Body; count: number; debris: number } | { kind: 'pancake'; fragment: number };
}

export type Group = 'rod' | 'vehicle' | 'classic' | 'space' | 'huge';
export type StartMode = 'drop' | 'orbit' | 'meteor';

export interface SpaceObject {
  id: string;
  name: string;
  /** Short name for split screens and captions ("the bus"). */
  short: string;
  group: Group;
  body: Body;
  /** How it usually starts when the start is left on auto. */
  start: StartMode;
  /** Its real arrival, for a meteor start on auto (speed m/s, degrees below horizontal). */
  entry?: { speed: number; angle: number };
}

const box = (l: number, w: number, h: number): Shape => ({ kind: 'box', l, w, h });

/** A tungsten rod of the given mass, 20 times as long as it is wide (the classic 6 m × 0.3 m design is about 9 t). */
export function rodBody(mass: number, attitude: 'nose' | 'tumble'): Body {
  const d = dm.pow(mass / (MATERIALS.tungsten.rho * 5 * Math.PI), 1 / 3);
  return { name: 'rod', mass, shape: { kind: 'cyl', l: 20 * d, d }, attitude, drag: attitude === 'nose' ? 'slender' : 'bluff', material: 'tungsten', strength: 1e9 };
}

export const OBJECTS: SpaceObject[] = [
  { id: 'tungsten-rod', name: 'Tungsten rod', short: 'the rod', group: 'rod', start: 'orbit', body: rodBody(9000, 'nose') },
  {
    id: 'sedan',
    name: 'Car',
    short: 'the car',
    group: 'vehicle',
    start: 'drop',
    body: {
      name: 'car', mass: 1500, shape: box(4.7, 1.8, 1.45), attitude: 'tumble', drag: 'bluff', material: 'steel', shell: 0.0008, strength: 60e3,
      breakup: { kind: 'core', count: 1, debris: 16, core: { name: 'engine block', mass: 180, shape: box(0.7, 0.6, 0.6), attitude: 'tumble', drag: 'bluff', material: 'steel', strength: 50e6 } },
    },
  },
  {
    id: 'pickup',
    name: 'Pickup truck',
    short: 'the pickup',
    group: 'vehicle',
    start: 'drop',
    body: {
      name: 'pickup truck', mass: 2300, shape: box(5.9, 2.0, 1.9), attitude: 'tumble', drag: 'bluff', material: 'steel', shell: 0.0009, strength: 60e3,
      breakup: { kind: 'core', count: 1, debris: 18, core: { name: 'engine and frame', mass: 320, shape: box(1.0, 0.75, 0.7), attitude: 'tumble', drag: 'bluff', material: 'steel', strength: 50e6 } },
    },
  },
  {
    id: 'school-bus',
    name: 'School bus',
    short: 'the bus',
    group: 'vehicle',
    start: 'drop',
    body: {
      name: 'school bus', mass: 11000, shape: box(12, 2.4, 3.2), attitude: 'tumble', drag: 'bluff', material: 'steel', shell: 0.001, strength: 40e3,
      breakup: { kind: 'core', count: 1, debris: 24, core: { name: 'diesel engine', mass: 1000, shape: box(1.4, 0.9, 1.0), attitude: 'tumble', drag: 'bluff', material: 'steel', strength: 50e6 } },
    },
  },
  { id: 'tank', name: 'Battle tank', short: 'the tank', group: 'vehicle', start: 'drop', body: { name: 'tank', mass: 60000, shape: box(7.9, 3.7, 2.4), attitude: 'tumble', drag: 'bluff', material: 'steel', strength: 5e6 } },
  {
    id: 'jumbo-jet',
    name: 'Jumbo jet',
    short: 'the jet',
    group: 'vehicle',
    start: 'drop',
    body: {
      name: 'jumbo jet', mass: 180000, shape: box(70, 64, 6.5), area: 800, attitude: 'tumble', drag: 'bluff', material: 'aluminium', shell: 0.002, strength: 25e3,
      breakup: { kind: 'core', count: 4, debris: 30, core: { name: 'jet engine', mass: 4300, shape: { kind: 'cyl', l: 4.0, d: 2.4 }, attitude: 'tumble', drag: 'bluff', material: 'titanium', strength: 50e6 } },
    },
  },
  {
    id: 'container',
    name: 'Shipping container',
    short: 'the container',
    group: 'vehicle',
    start: 'drop',
    body: {
      name: 'shipping container', mass: 24000, shape: box(6.06, 2.44, 2.59), attitude: 'tumble', drag: 'bluff', material: 'steel', shell: 0.002, strength: 80e3,
      breakup: { kind: 'core', count: 1, debris: 14, core: { name: 'cargo of steel coils', mass: 18000, shape: box(5.0, 2.0, 1.2), attitude: 'tumble', drag: 'bluff', material: 'steel', strength: 50e6 } },
    },
  },
  { id: 'penny', name: 'Penny', short: 'the penny', group: 'classic', start: 'drop', body: { name: 'penny', mass: 0.0025, shape: { kind: 'disc', d: 0.01905, t: 0.00152 }, attitude: 'tumble', drag: 'disc', material: 'zinc', strength: 100e6 } },
  { id: 'bowling-ball', name: 'Bowling ball', short: 'the bowling ball', group: 'classic', start: 'drop', body: { name: 'bowling ball', mass: 7.26, shape: { kind: 'sphere', d: 0.218 }, attitude: 'tumble', drag: 'sphere', material: 'resin', strength: 20e6 } },
  { id: 'anvil', name: 'Anvil', short: 'the anvil', group: 'classic', start: 'drop', body: { name: 'anvil', mass: 100, shape: box(0.7, 0.25, 0.32), attitude: 'tumble', drag: 'bluff', material: 'steel', strength: 200e6 } },
  {
    id: 'piano',
    name: 'Grand piano',
    short: 'the piano',
    group: 'classic',
    start: 'drop',
    body: {
      name: 'grand piano', mass: 450, shape: box(2.1, 1.5, 1.0), attitude: 'tumble', drag: 'bluff', material: 'wood', strength: 30e3,
      breakup: { kind: 'core', count: 1, debris: 18, core: { name: 'cast-iron frame', mass: 160, shape: box(1.6, 1.2, 0.12), attitude: 'tumble', drag: 'bluff', material: 'steel', strength: 50e6 } },
    },
  },
  {
    id: 'fridge',
    name: 'Refrigerator',
    short: 'the fridge',
    group: 'classic',
    start: 'drop',
    body: {
      name: 'refrigerator', mass: 100, shape: box(1.8, 0.8, 0.7), attitude: 'tumble', drag: 'bluff', material: 'steel', shell: 0.0006, strength: 20e3,
      breakup: { kind: 'core', count: 1, debris: 10, core: { name: 'compressor', mass: 12, shape: box(0.25, 0.2, 0.25), attitude: 'tumble', drag: 'bluff', material: 'steel', strength: 50e6 } },
    },
  },
  { id: 'cow', name: 'Cow', short: 'the cow', group: 'classic', start: 'drop', body: { name: 'cow', mass: 700, shape: box(2.4, 0.8, 1.5), attitude: 'tumble', drag: 'bluff', material: 'tissue', strength: 2e6 } },
  { id: 'iron-meteorite', name: 'Iron meteorite', short: 'the iron meteorite', group: 'space', start: 'meteor', body: { name: 'iron meteoroid', mass: 4100, shape: { kind: 'sphere', d: 1.0 }, attitude: 'tumble', drag: 'sphere', material: 'iron', strength: 50e6, breakup: { kind: 'pancake', fragment: 0.03 } } },
  { id: 'stony-meteorite', name: 'Stony meteorite', short: 'the stony meteorite', group: 'space', start: 'meteor', body: { name: 'stony meteoroid', mass: 47, shape: { kind: 'sphere', d: 0.3 }, attitude: 'tumble', drag: 'sphere', material: 'stone', strength: 2e6, breakup: { kind: 'pancake', fragment: 0.1 } } },
  // Chelyabinsk, 2013: about 19 m across and 12,000 t, at 19 km/s, 18° above the horizon.
  { id: 'asteroid', name: 'Small asteroid', short: 'the asteroid', group: 'space', start: 'meteor', entry: { speed: 19000, angle: 18 }, body: { name: 'asteroid', mass: 1.185e7, shape: { kind: 'sphere', d: 19 }, attitude: 'tumble', drag: 'sphere', material: 'stone', strength: 1e6, breakup: { kind: 'pancake', fragment: 2e-3 } } },
  {
    id: 'satellite',
    name: 'Dead satellite',
    short: 'the satellite',
    group: 'space',
    start: 'orbit',
    body: {
      name: 'satellite', mass: 2000, shape: box(3, 2, 2), attitude: 'tumble', drag: 'bluff', material: 'aluminium', shell: 0.003, strength: 20e3,
      breakup: { kind: 'core', count: 1, debris: 20, core: { name: 'titanium fuel tank', mass: 35, shape: { kind: 'sphere', d: 0.9 }, attitude: 'tumble', drag: 'sphere', material: 'titanium', strength: 50e6 } },
    },
  },
  {
    id: 'station-module',
    name: 'Space station module',
    short: 'the module',
    group: 'space',
    start: 'orbit',
    body: {
      name: 'station module', mass: 20000, shape: { kind: 'cyl', l: 13, d: 4.2 }, attitude: 'tumble', drag: 'bluff', material: 'aluminium', shell: 0.004, strength: 20e3,
      breakup: { kind: 'core', count: 1, debris: 26, core: { name: 'steel docking frame', mass: 1500, shape: box(2.5, 2.5, 0.8), attitude: 'tumble', drag: 'bluff', material: 'steel', strength: 50e6 } },
    },
  },
  { id: 'blue-whale', name: 'Blue whale', short: 'the whale', group: 'huge', start: 'drop', body: { name: 'blue whale', mass: 150000, shape: { kind: 'cyl', l: 25, d: 4 }, attitude: 'tumble', drag: 'bluff', material: 'tissue', strength: 2e6 } },
  {
    id: 'house',
    name: 'House',
    short: 'the house',
    group: 'huge',
    start: 'drop',
    body: {
      name: 'house', mass: 50000, shape: box(12, 10, 7), attitude: 'tumble', drag: 'bluff', material: 'wood', strength: 5e3,
      breakup: { kind: 'core', count: 1, debris: 30, core: { name: 'brick chimney', mass: 4000, shape: box(1.2, 1.2, 6), attitude: 'tumble', drag: 'bluff', material: 'brick', strength: 5e6 } },
    },
  },
  {
    id: 'cruise-ship',
    name: 'Cruise ship',
    short: 'the ship',
    group: 'huge',
    start: 'drop',
    body: {
      name: 'cruise ship', mass: 6e7, shape: box(300, 38, 60), attitude: 'tumble', drag: 'bluff', material: 'steel', shell: 0.015, strength: 50e3,
      breakup: { kind: 'core', count: 10, debris: 30, core: { name: 'hull section', mass: 6e6, shape: box(30, 38, 20), attitude: 'tumble', drag: 'bluff', material: 'steel', strength: 5e6 } },
    },
  },
  // The Eiffel Tower's 7,300 t of iron, melted down into one cube (9.8 m a side).
  { id: 'steel-cube', name: 'Eiffel Tower of steel', short: 'the steel cube', group: 'huge', start: 'drop', body: { name: 'steel cube', mass: 7.3e6, shape: box(9.76, 9.76, 9.76), attitude: 'tumble', drag: 'bluff', material: 'steel', strength: 250e6 } },
];

export const OBJECT_IDS = OBJECTS.map((o) => o.id) as [string, ...string[]];
export const objectById = (id: string): SpaceObject => OBJECTS.find((o) => o.id === id) ?? OBJECTS[0];

/** Surface area (m²). */
export function surfaceArea(s: Shape): number {
  switch (s.kind) {
    case 'box':
      return 2 * (s.l * s.w + s.l * s.h + s.w * s.h);
    case 'cyl':
      return Math.PI * s.d * s.l + (Math.PI * s.d * s.d) / 2;
    case 'sphere':
      return Math.PI * s.d * s.d;
    case 'disc':
      return (Math.PI * s.d * s.d) / 2 + Math.PI * s.d * s.t;
  }
}

/** Its longest dimension (m), for framing it on screen. */
export function sizeOf(s: Shape): number {
  switch (s.kind) {
    case 'box':
      return Math.max(s.l, s.w, s.h);
    case 'cyl':
      return Math.max(s.l, s.d);
    case 'sphere':
      return s.d;
    case 'disc':
      return s.d;
  }
}

/** Smallest dimension (m): how deep heat can soak in from both sides. */
export function thinnest(s: Shape): number {
  switch (s.kind) {
    case 'box':
      return Math.min(s.l, s.w, s.h);
    case 'cyl':
      return Math.min(s.l, s.d);
    case 'sphere':
      return s.d;
    case 'disc':
      return s.t;
  }
}

/** The shape scaled by `k` in every direction (it melts away evenly). */
export function scaleShape(s: Shape, k: number): Shape {
  switch (s.kind) {
    case 'box':
      return { kind: 'box', l: s.l * k, w: s.w * k, h: s.h * k };
    case 'cyl':
      return { kind: 'cyl', l: s.l * k, d: s.d * k };
    case 'sphere':
      return { kind: 'sphere', d: s.d * k };
    case 'disc':
      return { kind: 'disc', d: s.d * k, t: s.t * k };
  }
}

/** A mass for display: "2.5 g", "180 kg", "24 t", "12,000 t". */
export function massLabel(kg: number): string {
  if (kg < 1) return `${+(kg * 1000).toPrecision(2)} g`;
  if (kg < 1000) return `${+kg.toPrecision(3)} kg`;
  const t = kg / 1000;
  return `${t < 100 ? +t.toPrecision(2) : Math.round(t).toLocaleString('en-US')} t`;
}
