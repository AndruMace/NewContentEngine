/**
 * The procedural species: anatomy (cross-sections along the body, head, jaw, mane / scutes, legs and
 * paws), colouring and gaits. Model space: metres, +Z forward, +Y up, +X the animal's left.
 */
import { THREE } from '../../three-layer';
import { MeshBuilder, blob, cone, hash, lerpColor, loft, rgb, shade, smoothRings, type Ring, type Skin, type V3 } from './builder';
import type { Gait, LegName, LegSpec, ProcSpec } from './rig';
import { ALPACA, BULL, DEER, DONKEY, FOX, HORSE, HUSKY, STAG, UNICORN, WOLF } from './mammals';
import { BRAWLER, KING, SWORDSMAN } from './bipeds';
import { DRAGON, SPIDER } from './beasts';

const LATERAL: Record<LegName, number> = { LH: 0, LF: 0.25, RH: 0.5, RF: 0.75 };
const ROTARY: Record<LegName, number> = { LH: 0, RH: 0.09, LF: 0.5, RF: 0.6 };

/** Colour by angle round a section: darker along the back, paler on the belly. */
function coat(base: THREE.Color, top: THREE.Color, belly: THREE.Color, noise = 0.07) {
  return (_t: number, a: number, p: V3) => {
    const k = Math.sin(a);
    const c = k > 0 ? lerpColor(base, top, Math.pow(k, 1.5)) : lerpColor(base, belly, Math.pow(-k, 0.8));
    return shade(c, 1, p, noise);
  };
}

/** Linear lookup of a control-ring property at z (for placing things on the body's surface). */
function along(rings: Ring[], z: number) {
  const r = [...rings].sort((a, b) => a.c[2] - b.c[2]);
  if (z <= r[0].c[2]) return r[0];
  for (let i = 0; i < r.length - 1; i++)
    if (z <= r[i + 1].c[2]) {
      const t = (z - r[i].c[2]) / (r[i + 1].c[2] - r[i].c[2]);
      return { c: [0, r[i].c[1] + (r[i + 1].c[1] - r[i].c[1]) * t, z] as V3, w: r[i].w + (r[i + 1].w - r[i].w) * t, h: r[i].h + (r[i + 1].h - r[i].h) * t };
    }
  return r[r.length - 1];
}

const mirror = (l: Omit<LegSpec, 'name'> & { name: LegName }): LegSpec[] => {
  const other: LegName = l.name === 'LF' ? 'RF' : l.name === 'LH' ? 'RH' : l.name === 'RF' ? 'LF' : 'LH';
  const flip = (v: V3): V3 => [-v[0], v[1], v[2]];
  return [l, { ...l, name: other, hip: flip(l.hip), home: flip(l.home), pole: flip(l.pole) }];
};

// ---- lion ------------------------------------------------------------------------------------------

const LION_COAT = rgb('#c49a5c');
const LION_BACK = rgb('#a57a43');
const LION_BELLY = rgb('#e4cda4');
const LION_DARK = rgb('#3b2a1c');
const MANE = rgb('#5e3b20');
const MANE_TIP = rgb('#9a6634');

const LION_RINGS: Ring[] = [
  { c: [0, 0.42, -1.92], w: 0.026, h: 0.026 },
  { c: [0, 0.5, -1.66], w: 0.031, h: 0.031 },
  { c: [0, 0.66, -1.41], w: 0.035, h: 0.035 },
  { c: [0, 0.82, -1.15], w: 0.04, h: 0.04 },
  { c: [0, 0.92, -0.95], w: 0.055, h: 0.06 },
  { c: [0, 0.93, -0.87], w: 0.2, h: 0.22 },
  { c: [0, 0.94, -0.78], w: 0.32, h: 0.36 },
  { c: [0, 0.94, -0.62], w: 0.37, h: 0.41, flat: 0.1 },
  { c: [0, 0.93, -0.4], w: 0.35, h: 0.37, flat: 0.2 },
  { c: [0, 0.92, -0.15], w: 0.32, h: 0.33, flat: 0.3 },
  { c: [0, 0.94, 0.12], w: 0.35, h: 0.41, flat: 0.1 },
  { c: [0, 0.97, 0.38], w: 0.39, h: 0.48, flat: 0.05 },
  { c: [0, 1.01, 0.56], w: 0.37, h: 0.46, ridge: 0.12 },
  { c: [0, 1.06, 0.72], w: 0.27, h: 0.32 },
  { c: [0, 1.12, 0.88], w: 0.2, h: 0.23 },
  { c: [0, 1.18, 1.0], w: 0.17, h: 0.19 },
];

function catPaw(w: number, color: THREE.Color) {
  return (b: MeshBuilder) => {
    loft(
      b,
      [
        { c: [0, w * 0.55, -w * 0.9], w: w * 0.7, h: w * 0.5 },
        { c: [0, w * 0.55, 0], w: w, h: w * 0.6, flat: 0.6 },
        { c: [0, w * 0.4, w * 0.9], w: w * 0.85, h: w * 0.45, flat: 0.6 },
      ],
      { sides: 8, seed: 5, color: (_t, _a, p) => shade(color, 1, p, 0.05), capStart: 0.4, capEnd: 0.5 },
    );
    for (let k = 0; k < 4; k++) blob(b, [(k - 1.5) * w * 0.45, w * 0.3, w * 1.15], w * 0.24, w * 0.3, w * 0.28, color.clone().multiplyScalar(0.95));
  };
}

export const LION: ProcSpec = {
  bones: {
    pelvis: [0, 0.93, -0.58],
    spine: [0, 0.91, -0.1],
    chest: [0, 0.96, 0.42],
    neck1: [0, 1.06, 0.78],
    neck2: [0, 1.2, 1.04],
    tail: [
      [0, 0.92, -0.86],
      [0, 0.84, -1.12],
      [0, 0.68, -1.38],
      [0, 0.52, -1.62],
      [0, 0.43, -1.86],
    ],
  },
  rollY: 0.9,
  headScale: 1.3,
  body(b, skin) {
    loft(b, smoothRings(LION_RINGS, 3), { sides: 14, jitter: 0.035, seed: 1, color: coat(LION_COAT, LION_BACK, LION_BELLY), capStart: 0.5, capEnd: 0.2, skin, twist: 0.2 });
    // Tail tuft.
    const tip: V3 = [0, 0.42, -1.96];
    const sk = skin(tip);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      cone(b, [0, 0.42, -1.9], [Math.cos(a) * 0.5, Math.sin(a) * 0.5, -1], 0.13, 0.035, LION_DARK, 4, sk);
    }
  },
  head(b) {
    const face = (_t: number, a: number, p: V3) => {
      const muzzle = Math.max(0, Math.min(1, (p[2] - 0.18) / 0.12)) * Math.max(0, -Math.sin(a) + 0.4);
      return shade(lerpColor(lerpColor(LION_COAT, LION_BACK, Math.max(0, Math.sin(a)) * 0.6), LION_BELLY, muzzle), 1, p, 0.06);
    };
    loft(
      b,
      [
        { c: [0, 0.03, -0.07], w: 0.15, h: 0.16 },
        { c: [0, 0.05, 0.04], w: 0.18, h: 0.17, flat: 0.2 },
        { c: [0, 0.055, 0.14], w: 0.16, h: 0.14, flat: 0.25 },
        { c: [0, 0.02, 0.23], w: 0.12, h: 0.1, flat: 0.2 },
        { c: [0, -0.005, 0.3], w: 0.1, h: 0.08, flat: 0.1 },
        { c: [0, -0.01, 0.345], w: 0.08, h: 0.06 },
      ],
      { sides: 12, jitter: 0.03, seed: 3, color: face, capStart: 0.3, capEnd: 0.35 },
    );
    blob(b, [0, 0.035, 0.36], 0.036, 0.024, 0.02, rgb('#3a2620'));
    for (const s of [1, -1]) {
      blob(b, [s * 0.075, 0.095, 0.17], 0.024, 0.015, 0.014, rgb('#c88f2c'));
      blob(b, [s * 0.078, 0.097, 0.178], 0.01, 0.008, 0.008, rgb('#120c08'));
      blob(b, [s * 0.065, 0.12, 0.16], 0.04, 0.012, 0.03, LION_BACK);
      // Rounded ears, half hidden in the mane.
      blob(b, [s * 0.11, 0.17, -0.01], 0.045, 0.05, 0.022, LION_BACK);
      blob(b, [s * 0.11, 0.168, 0.006], 0.028, 0.032, 0.01, LION_DARK);
      cone(b, [s * 0.05, -0.055, 0.29], [0, -1, 0.15], 0.05, 0.012, rgb('#f1ead8'), 4);
    }
  },
  jawPivot: [0, -0.05, 0.03],
  jaw(b) {
    loft(
      b,
      [
        { c: [0, -0.01, -0.02], w: 0.1, h: 0.05 },
        { c: [0, -0.02, 0.13], w: 0.09, h: 0.045 },
        { c: [0, -0.02, 0.27], w: 0.065, h: 0.035 },
      ],
      { sides: 10, jitter: 0.03, seed: 4, color: (_t, a, p) => shade(lerpColor(LION_COAT, LION_BELLY, Math.max(0, -Math.sin(a)) * 0.5 + 0.2), 1, p, 0.05), capStart: 0.2, capEnd: 0.4 },
    );
    for (const s of [1, -1]) cone(b, [s * 0.042, 0.01, 0.24], [0, 1, 0.1], 0.04, 0.011, rgb('#f1ead8'), 4);
    // Red mouth inside (visible when it opens).
    blob(b, [0, 0.015, 0.12], 0.06, 0.012, 0.12, rgb('#7a2a26'));
  },
  extras: [
    {
      bone: 'neck1',
      build(b) {
        loft(
          b,
          smoothRings(
            [
              { c: [0, -0.06, -0.36], w: 0.27, h: 0.33 },
              { c: [0, -0.01, -0.2], w: 0.35, h: 0.42 },
              { c: [0, 0.04, 0.0], w: 0.38, h: 0.45 },
              { c: [0, 0.1, 0.16], w: 0.34, h: 0.38 },
              { c: [0, 0.14, 0.27], w: 0.22, h: 0.25 },
            ],
            2,
          ),
          {
            sides: 20,
            jitter: 0.17,
            seed: 9,
            color: (t, a, p) => shade(lerpColor(MANE, MANE_TIP, 0.25 + 0.6 * hash(p[0] * 31 + p[1] * 17 + p[2] * 11) * (1 - t * 0.4) + Math.max(0, Math.sin(a)) * 0.2), 1, p, 0.04),
            capStart: 0.3,
            capEnd: 0.1,
            twist: 0.1,
          },
        );
        // Forelock tufts between the ears.
        for (let k = 0; k < 5; k++) cone(b, [(k - 2) * 0.05, 0.22 + hash(k) * 0.03, 0.2], [0, 0.6, 1], 0.1, 0.045, MANE_TIP, 4);
      },
    },
  ],
  legs: [
    ...mirror({
      name: 'LF',
      bone: 'chest',
      hip: [0.17, 0.8, 0.5],
      home: [0.17, 0, 0.6],
      lens: [0.33, 0.31],
      end: { up: 0.11, back: 0.02, segment: true },
      radii: [0.125, 0.085, 0.064],
      pole: [0, 0, -1],
      paw: catPaw(0.085, LION_COAT),
      color: LION_COAT,
    }),
    ...mirror({
      name: 'LH',
      bone: 'pelvis',
      hip: [0.18, 0.82, -0.64],
      home: [0.17, 0, -0.62],
      lens: [0.35, 0.31],
      end: { up: 0.2, back: 0.1, segment: true },
      radii: [0.16, 0.09, 0.06],
      pole: [0, 0, 1],
      paw: catPaw(0.08, LION_COAT),
      color: LION_COAT,
    }),
  ],
  gaits: [
    { from: 0, duty: 0.62, offsets: LATERAL, lift: 0.12, bob: 0.02, flex: 0.02 },
    { from: 4.5, duty: 0.32, offsets: ROTARY, lift: 0.22, bob: 0.06, flex: 0.14 },
  ],
};

// ---- grizzly ---------------------------------------------------------------------------------------

const FUR = rgb('#6b4a2c');
const FUR_TIP = rgb('#93714b');
const FUR_DARK = rgb('#3d2817');
const MUZZLE = rgb('#9b7a56');

const BEAR_RINGS: Ring[] = [
  { c: [0, 0.84, -1.0], w: 0.05, h: 0.05 },
  { c: [0, 0.88, -0.95], w: 0.15, h: 0.15 },
  { c: [0, 0.9, -0.87], w: 0.34, h: 0.38 },
  { c: [0, 0.92, -0.7], w: 0.46, h: 0.5, flat: 0.05 },
  { c: [0, 0.92, -0.4], w: 0.5, h: 0.5 },
  { c: [0, 0.9, -0.1], w: 0.52, h: 0.5 },
  { c: [0, 0.96, 0.2], w: 0.5, h: 0.52 },
  { c: [0, 1.06, 0.42], w: 0.46, h: 0.55, ridge: 0.18 },
  { c: [0, 1.02, 0.6], w: 0.36, h: 0.42 },
  { c: [0, 0.98, 0.78], w: 0.28, h: 0.32 },
  { c: [0, 0.97, 0.93], w: 0.24, h: 0.27 },
];

function bearPaw(len: number, w: number) {
  return (b: MeshBuilder) => {
    loft(
      b,
      [
        { c: [0, w * 0.45, -len * 0.5], w: w * 0.8, h: w * 0.45 },
        { c: [0, w * 0.5, 0], w: w, h: w * 0.5, flat: 0.7 },
        { c: [0, w * 0.4, len * 0.45], w: w * 1.05, h: w * 0.42, flat: 0.7 },
      ],
      { sides: 8, jitter: 0.06, seed: 6, color: (_t, _a, p) => shade(FUR_DARK, 1, p, 0.06), capStart: 0.4, capEnd: 0.45 },
    );
    for (let k = 0; k < 5; k++) cone(b, [(k - 2) * w * 0.38, w * 0.3, len * 0.55], [0, -0.35, 1], w * 0.55, w * 0.07, rgb('#e2d6bf'), 4);
  };
}

export const BEAR: ProcSpec = {
  bones: {
    pelvis: [0, 0.91, -0.62],
    spine: [0, 0.92, -0.15],
    chest: [0, 1.0, 0.36],
    neck1: [0, 0.99, 0.72],
    neck2: [0, 0.98, 0.96],
    tail: [
      [0, 0.9, -0.9],
      [0, 0.86, -0.98],
    ],
  },
  rollY: 0.9,
  headScale: 1.3,
  body(b, skin) {
    loft(b, smoothRings(BEAR_RINGS, 3), {
      sides: 16,
      jitter: 0.09,
      seed: 2,
      // Grizzled: paler tips over the hump and back, dark legs and belly.
      color: (t, a, p) => {
        const hump = Math.max(0, 1 - Math.abs(p[2] - 0.35) / 0.6) * Math.max(0, Math.sin(a));
        const c = coat(FUR, lerpColor(FUR, FUR_TIP, 0.5 + hump * 0.5), FUR_DARK, 0.1)(t, a, p);
        return hash(p[0] * 50 + p[2] * 70) > 0.85 ? c.multiplyScalar(1.15) : c;
      },
      capStart: 0.5,
      capEnd: 0.2,
      skin,
      twist: 0.15,
    });
  },
  head(b) {
    const face = (_t: number, a: number, p: V3) => {
      const m = Math.max(0, Math.min(1, (p[2] - 0.16) / 0.1));
      return shade(lerpColor(lerpColor(FUR, FUR_TIP, Math.max(0, Math.sin(a)) * 0.5), MUZZLE, m), 1, p, 0.07);
    };
    loft(
      b,
      [
        { c: [0, 0.04, -0.09], w: 0.2, h: 0.2 },
        { c: [0, 0.07, 0.04], w: 0.23, h: 0.21, flat: 0.15 },
        { c: [0, 0.05, 0.15], w: 0.19, h: 0.16, flat: 0.2 },
        { c: [0, 0.0, 0.24], w: 0.12, h: 0.1, flat: 0.15 },
        { c: [0, -0.01, 0.33], w: 0.1, h: 0.085 },
        { c: [0, -0.01, 0.39], w: 0.08, h: 0.07 },
      ],
      { sides: 12, jitter: 0.05, seed: 7, color: face, capStart: 0.3, capEnd: 0.35 },
    );
    blob(b, [0, 0.035, 0.4], 0.045, 0.03, 0.025, rgb('#1c1410'));
    for (const s of [1, -1]) {
      blob(b, [s * 0.085, 0.105, 0.13], 0.016, 0.013, 0.012, rgb('#140d08'));
      blob(b, [s * 0.15, 0.2, 0.0], 0.06, 0.06, 0.035, FUR_DARK);
      blob(b, [s * 0.15, 0.2, 0.02], 0.035, 0.035, 0.02, rgb('#5a3d26'));
      cone(b, [s * 0.05, -0.06, 0.34], [0, -1, 0.1], 0.045, 0.012, rgb('#efe6d2'), 4);
    }
  },
  jawPivot: [0, -0.06, 0.04],
  jaw(b) {
    loft(
      b,
      [
        { c: [0, -0.01, -0.03], w: 0.12, h: 0.05 },
        { c: [0, -0.02, 0.15], w: 0.1, h: 0.045 },
        { c: [0, -0.02, 0.31], w: 0.07, h: 0.035 },
      ],
      { sides: 10, jitter: 0.04, seed: 8, color: (_t, _a, p) => shade(MUZZLE, 0.9, p, 0.05), capStart: 0.2, capEnd: 0.4 },
    );
    for (const s of [1, -1]) cone(b, [s * 0.045, 0.01, 0.28], [0, 1, 0.1], 0.04, 0.011, rgb('#efe6d2'), 4);
    blob(b, [0, 0.015, 0.13], 0.065, 0.012, 0.13, rgb('#6a2422'));
  },
  legs: [
    ...mirror({
      name: 'LF',
      bone: 'chest',
      hip: [0.22, 0.8, 0.38],
      home: [0.22, 0, 0.46],
      lens: [0.38, 0.34],
      end: { up: 0.08, back: 0.1, segment: false },
      radii: [0.16, 0.12, 0.1],
      pole: [0, 0, -1],
      paw: bearPaw(0.26, 0.12),
      color: FUR_DARK,
    }),
    ...mirror({
      name: 'LH',
      bone: 'pelvis',
      hip: [0.23, 0.8, -0.66],
      home: [0.22, 0, -0.6],
      lens: [0.39, 0.34],
      end: { up: 0.08, back: 0.13, segment: false },
      radii: [0.18, 0.12, 0.1],
      pole: [0, 0, 1],
      paw: bearPaw(0.3, 0.12),
      color: FUR_DARK,
    }),
  ],
  gaits: [
    { from: 0, duty: 0.65, offsets: LATERAL, lift: 0.1, bob: 0.03, flex: 0.02 },
    { from: 4, duty: 0.38, offsets: ROTARY, lift: 0.2, bob: 0.07, flex: 0.12 },
  ],
};

// ---- crocodile -------------------------------------------------------------------------------------

const CROC_TOP = rgb('#3d4826');
const CROC_SIDE = rgb('#56602f');
const CROC_BELLY = rgb('#bdb37d');
const SCUTE = rgb('#2b3318');
const TOOTH = rgb('#ebe4c3');

const CROC_RINGS: Ring[] = [
  { c: [0, 0.21, -2.78], w: 0.015, h: 0.035 },
  { c: [0, 0.22, -2.42], w: 0.03, h: 0.07 },
  { c: [0, 0.24, -2.02], w: 0.05, h: 0.1 },
  { c: [0, 0.26, -1.6], w: 0.08, h: 0.13 },
  { c: [0, 0.28, -1.2], w: 0.12, h: 0.15 },
  { c: [0, 0.3, -0.86], w: 0.2, h: 0.17, flat: 0.3 },
  { c: [0, 0.31, -0.6], w: 0.28, h: 0.18, flat: 0.5 },
  { c: [0, 0.31, -0.3], w: 0.34, h: 0.19, flat: 0.55 },
  { c: [0, 0.31, 0.0], w: 0.36, h: 0.2, flat: 0.55 },
  { c: [0, 0.31, 0.3], w: 0.32, h: 0.18, flat: 0.5 },
  { c: [0, 0.31, 0.55], w: 0.24, h: 0.15, flat: 0.4 },
  { c: [0, 0.31, 0.76], w: 0.2, h: 0.13, flat: 0.3 },
];

const crocSkin = (_t: number, a: number, p: V3) => {
  // Dark bands across the back and tail.
  const band = p[2] < 0 && Math.sin(p[2] * 9) > 0.55 ? 0.72 : 1;
  const c = coat(CROC_SIDE, CROC_TOP, CROC_BELLY, 0.06)(_t, a, p);
  return Math.sin(a) > -0.2 ? c.multiplyScalar(band) : c;
};

function crocFoot(len: number) {
  return (b: MeshBuilder) => {
    loft(
      b,
      [
        { c: [0, 0.02, -len * 0.4], w: 0.045, h: 0.025 },
        { c: [0, 0.02, len * 0.2], w: 0.06, h: 0.02, flat: 0.5 },
      ],
      { sides: 6, seed: 12, color: (_t, _a, p) => shade(CROC_SIDE, 0.9, p, 0.05), capStart: 0.3, capEnd: 0.2 },
    );
    for (let k = 0; k < 4; k++) {
      const a = (k - 1.5) * 0.45;
      cone(b, [Math.sin(a) * 0.04, 0.015, len * 0.2], [Math.sin(a), -0.15, Math.cos(a)], len * 0.55, 0.014, CROC_SIDE, 4, undefined, rgb('#2a2416'));
    }
  };
}

export const CROC: ProcSpec = {
  bones: {
    pelvis: [0, 0.31, -0.6],
    spine: [0, 0.31, -0.15],
    chest: [0, 0.31, 0.3],
    neck1: [0, 0.31, 0.58],
    neck2: [0, 0.31, 0.78],
    tail: [
      [0, 0.3, -0.92],
      [0, 0.29, -1.26],
      [0, 0.27, -1.6],
      [0, 0.25, -1.95],
      [0, 0.23, -2.3],
      [0, 0.21, -2.62],
    ],
  },
  rollY: 0.3,
  body(b, skin) {
    loft(b, smoothRings(CROC_RINGS, 3), { sides: 14, jitter: 0.04, seed: 3, color: crocSkin, capStart: 0.6, capEnd: 0.2, skin, twist: 0 });
    // Scutes: rows of armoured ridges down the back, a double crest along the tail.
    for (let z = -0.62; z <= 0.62; z += 0.09) {
      const r = along(CROC_RINGS, z);
      for (const x of [-0.13, -0.05, 0.05, 0.13]) {
        const y = r.c[1] + r.h * Math.sqrt(Math.max(0, 1 - (x / r.w) ** 2)) - 0.005;
        const base: V3 = [x, y, z];
        cone(b, base, [x * 0.6, 1, 0], 0.035 + hash(z * 9 + x) * 0.01, 0.028, SCUTE, 4, skin(base));
      }
    }
    for (let z = -0.85; z >= -2.45; z -= 0.08) {
      const r = along(CROC_RINGS, z);
      const hgt = 0.06 * Math.min(1, (z + 2.6) / 1);
      for (const s of z > -1.7 ? [1, -1] : [0]) {
        const base: V3 = [s * r.w * 0.55, r.c[1] + r.h * 0.85, z];
        cone(b, base, [s * 0.15, 1, -0.2], hgt, 0.03, SCUTE, 3, skin(base));
      }
    }
  },
  head(b) {
    const top = (_t: number, a: number, p: V3) => shade(Math.sin(a) > -0.3 ? lerpColor(CROC_SIDE, CROC_TOP, Math.max(0, Math.sin(a))) : CROC_BELLY, 1, p, 0.06);
    loft(
      b,
      [
        { c: [0, 0.02, -0.06], w: 0.19, h: 0.12, flat: 0.6 },
        { c: [0, 0.035, 0.1], w: 0.19, h: 0.11, flat: 0.6 },
        { c: [0, 0.02, 0.26], w: 0.15, h: 0.08, flat: 0.6 },
        { c: [0, 0.0, 0.46], w: 0.11, h: 0.055, flat: 0.6 },
        { c: [0, -0.005, 0.63], w: 0.09, h: 0.045, flat: 0.6 },
        { c: [0, -0.005, 0.72], w: 0.09, h: 0.045, flat: 0.5 },
      ],
      { sides: 12, jitter: 0.03, seed: 10, color: top, capStart: 0.2, capEnd: 0.35 },
    );
    blob(b, [0, 0.04, 0.7], 0.035, 0.018, 0.022, rgb('#262a14'));
    for (const s of [1, -1]) {
      blob(b, [s * 0.075, 0.105, 0.1], 0.035, 0.03, 0.04, CROC_TOP);
      blob(b, [s * 0.08, 0.125, 0.12], 0.016, 0.012, 0.016, rgb('#c8a838'));
      blob(b, [s * 0.082, 0.128, 0.128], 0.004, 0.009, 0.006, rgb('#100c04'));
      // Upper teeth along the edge, pointing down.
      for (let z = 0.08; z <= 0.68; z += 0.055) {
        const w = z < 0.26 ? 0.17 : z < 0.46 ? 0.13 : 0.09;
        cone(b, [s * (w - 0.012), -0.035, z], [s * 0.15, -1, 0], 0.035 + (z > 0.6 ? 0.012 : 0), 0.009, TOOTH, 3);
      }
    }
  },
  jawPivot: [0, -0.055, -0.02],
  jaw(b) {
    loft(
      b,
      [
        { c: [0, 0, -0.02], w: 0.17, h: 0.05, flat: 0.3 },
        { c: [0, 0, 0.25], w: 0.13, h: 0.04, flat: 0.3 },
        { c: [0, 0.005, 0.5], w: 0.09, h: 0.032, flat: 0.3 },
        { c: [0, 0.008, 0.71], w: 0.08, h: 0.026 },
      ],
      { sides: 10, jitter: 0.03, seed: 11, color: (_t, a, p) => shade(Math.sin(a) > 0 ? CROC_SIDE : CROC_BELLY, 1, p, 0.05), capStart: 0.2, capEnd: 0.3 },
    );
    blob(b, [0, 0.03, 0.3], 0.1, 0.01, 0.28, rgb('#c8a37a'));
    for (const s of [1, -1])
      for (let z = 0.1; z <= 0.68; z += 0.06) {
        const w = z < 0.25 ? 0.15 : z < 0.5 ? 0.115 : 0.08;
        cone(b, [s * (w - 0.015), 0.03, z], [s * 0.1, 1, 0], 0.03, 0.008, TOOTH, 3);
      }
  },
  legs: [
    ...mirror({
      name: 'LF',
      bone: 'chest',
      hip: [0.22, 0.27, 0.32],
      home: [0.48, 0, 0.44],
      lens: [0.2, 0.19],
      end: { up: 0.04, back: 0.04, segment: false },
      radii: [0.075, 0.055, 0.045],
      pole: [1, 0.7, 0],
      paw: crocFoot(0.13),
      color: CROC_SIDE,
    }),
    ...mirror({
      name: 'LH',
      bone: 'pelvis',
      hip: [0.24, 0.27, -0.62],
      home: [0.52, 0, -0.72],
      lens: [0.25, 0.22],
      end: { up: 0.04, back: 0.05, segment: false },
      radii: [0.095, 0.065, 0.05],
      pole: [1, 0.7, 0],
      paw: crocFoot(0.16),
      color: CROC_SIDE,
    }),
  ],
  gaits: [{ from: 0, duty: 0.7, offsets: { LF: 0, RH: 0.05, RF: 0.5, LH: 0.55 }, lift: 0.07, bob: 0.008, flex: 0 }],
};

export const SPECIES = { lion: LION, bear: BEAR, croc: CROC, horse: HORSE, unicorn: UNICORN, donkey: DONKEY, bull: BULL, stag: STAG, deer: DEER, alpaca: ALPACA, wolf: WOLF, husky: HUSKY, fox: FOX, swordsman: SWORDSMAN, king: KING, brawler: BRAWLER, dragon: DRAGON, spider: SPIDER } as const;
export type SpeciesId = keyof typeof SPECIES;
export type { Skin };
