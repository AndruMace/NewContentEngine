/**
 * The human fighters: an upright skinned torso (pelvis → chest → neck), a head with face, hair or hood,
 * crown or beard, two-bone legs and arms placed by IK, and a sword aimed by the pose. Model space:
 * metres, +Z forward (the way they face), +Y up, +X their left.
 */
import { THREE } from '../../three-layer';
import { MeshBuilder, blob, cone, hash, lerpColor, loft, rgb, shade, smoothRings, type Ring, type V3 } from './builder';
import type { Gait, LegSpec, ProcSpec } from './rig';

const BIPED_GAITS: Gait[] = [
  { from: 0, duty: 0.6, offsets: { LL: 0, RL: 0.5, LA: 0.5, RA: 0 }, lift: 0.12, bob: 0.03, flex: 0 },
  { from: 3, duty: 0.38, offsets: { LL: 0, RL: 0.5, LA: 0.5, RA: 0 }, lift: 0.24, bob: 0.06, flex: 0 },
];

export interface BipedOpts {
  seed: number;
  /** Shoulder half-width and chest depth (half). */
  build: number;
  skin: THREE.Color;
  /** Torso colours by height: shirt above the belt, the belt, legs below. */
  shirt: THREE.Color;
  shirtTrim?: THREE.Color;
  belt: THREE.Color;
  pants: THREE.Color;
  boots: THREE.Color;
  /** Sleeves (upper arm, forearm). */
  sleeves: [THREE.Color, THREE.Color];
  hair?: THREE.Color;
  hood?: THREE.Color;
  beard?: THREE.Color;
  crown?: boolean;
  cape?: THREE.Color;
  sword?: { blade: THREE.Color; guard: THREE.Color; len: number };
  /** Arm thickness multiplier (a brawler's). */
  arms?: number;
}

function boot(color: THREE.Color) {
  return (b: MeshBuilder) =>
    loft(
      b,
      [
        { c: [0, 0.05, -0.06], w: 0.05, h: 0.05 },
        { c: [0, 0.045, 0.04], w: 0.055, h: 0.045, flat: 0.8 },
        { c: [0, 0.035, 0.15], w: 0.045, h: 0.035, flat: 0.8 },
      ],
      { sides: 8, seed: 3, color: (_t, _a, p) => shade(color, 1, p, 0.05), capStart: 0.3, capEnd: 0.5 },
    );
}

function fist(skin: THREE.Color, size: number) {
  return (b: MeshBuilder) => {
    blob(b, [0, 0, 0.01], 0.045 * size, 0.05 * size, 0.045 * size, skin);
    blob(b, [0, -0.01, 0.045 * size], 0.04 * size, 0.035 * size, 0.025 * size, skin.clone().multiplyScalar(0.95));
  };
}

function sword(o: NonNullable<BipedOpts['sword']>) {
  return (b: MeshBuilder) => {
    const grip = rgb('#3a2618');
    loft(b, [{ c: [0, -0.1, 0], w: 0.018, h: 0.018 }, { c: [0, 0.05, 0], w: 0.018, h: 0.018 }], { sides: 6, ref: [0, 0, 1], seed: 1, color: () => grip, capStart: 0.5, capEnd: 0 });
    blob(b, [0, -0.11, 0], 0.03, 0.025, 0.03, o.guard);
    // Cross-guard.
    loft(b, [{ c: [-0.11, 0.06, 0], w: 0.02, h: 0.02 }, { c: [0.11, 0.06, 0], w: 0.02, h: 0.02 }], { sides: 6, ref: [0, 1, 0], seed: 2, color: () => o.guard, capStart: 0.4, capEnd: 0.4 });
    // Blade: flat, with a ridge, tapering to a point.
    loft(
      b,
      [
        { c: [0, 0.07, 0], w: 0.035, h: 0.008, ridge: 0.6 },
        { c: [0, 0.07 + o.len * 0.8, 0], w: 0.03, h: 0.007, ridge: 0.6 },
      ],
      { sides: 6, ref: [0, 0, 1], seed: 3, color: (_t, a) => o.blade.clone().multiplyScalar(0.85 + 0.25 * Math.abs(Math.cos(a))), capStart: 0, capEnd: 0 },
    );
    cone(b, [0, 0.07 + o.len * 0.8, 0], [0, 1, 0], o.len * 0.2, 0.03, o.blade, 4);
  };
}

export function biped(o: BipedOpts): ProcSpec {
  const w = o.build;
  const torso: Ring[] = [
    { c: [0, 0.8, 0], w: 0.12, h: 0.09 },
    { c: [0, 0.9, 0], w: 0.17 * w, h: 0.115 },
    { c: [0, 1.03, 0], w: 0.155 * w, h: 0.105 },
    { c: [0, 1.2, 0.005], w: 0.185 * w, h: 0.12 },
    { c: [0, 1.34, 0.01], w: 0.21 * w, h: 0.13 },
    { c: [0, 1.44, 0], w: 0.215 * w, h: 0.11 },
    { c: [0, 1.5, 0], w: 0.09, h: 0.07 },
    { c: [0, 1.59, 0.01], w: 0.055, h: 0.055 },
  ];
  const torsoColor = (_t: number, a: number, p: V3) => {
    const y = p[1];
    const c = y < 0.93 ? o.pants : y < 0.99 ? o.belt : y > 1.47 ? o.skin : o.shirtTrim && (y > 1.4 || Math.abs(p[0]) < 0.02) && Math.sin(a) > 0 ? o.shirtTrim : o.shirt;
    return shade(c, 1, p, 0.05);
  };
  const legs: LegSpec[] = [];
  for (const s of [1, -1] as const) {
    legs.push({
      name: s > 0 ? 'LL' : 'RL',
      bone: 'pelvis',
      hip: [s * 0.095, 0.9, 0],
      home: [s * 0.12, 0, 0.03],
      lens: [0.44, 0.43],
      end: { up: 0.07, back: 0.03, segment: false },
      radii: [0.085 * w, 0.06 * w, 0.045],
      pole: [0, 0, 1],
      paw: boot(o.boots),
      color: o.pants,
      colors: [o.pants, o.boots],
    });
  }
  const arm = o.arms ?? 1;
  for (const s of [1, -1] as const) {
    legs.push({
      name: s > 0 ? 'LA' : 'RA',
      bone: 'chest',
      hip: [s * 0.215 * w, 1.42, 0],
      home: [s * 0.25 * w, 0.95, 0.04],
      lens: [0.29, 0.27],
      end: { up: 0, back: 0, segment: false },
      radii: [0.05 * arm, 0.042 * arm, 0.035 * arm],
      pole: [0, -0.2, -1],
      paw: fist(o.skin, arm),
      color: o.sleeves[0],
      colors: o.sleeves,
      arm: { swing: 0.22 },
    });
  }
  const head = (b: MeshBuilder) => {
    // Skull, lofted up from the neck, the face toward +Z.
    loft(
      b,
      smoothRings(
        [
          { c: [0, 0.0, 0.01], w: 0.06, h: 0.065 },
          { c: [0, 0.06, 0.02], w: 0.085, h: 0.095 },
          { c: [0, 0.13, 0.015], w: 0.095, h: 0.105 },
          { c: [0, 0.2, 0.005], w: 0.09, h: 0.1 },
          { c: [0, 0.25, 0], w: 0.055, h: 0.06 },
        ],
        2,
      ),
      { sides: 12, ref: [0, 0, 1], seed: o.seed, color: (_t, _a, p) => shade(o.skin, 1, p, 0.03), capStart: 0.2, capEnd: 0.5 },
    );
    cone(b, [0, 0.11, 0.1], [0, -0.4, 1], 0.04, 0.018, o.skin.clone().multiplyScalar(0.95), 4);
    for (const s of [1, -1]) {
      blob(b, [s * 0.035, 0.135, 0.09], 0.012, 0.008, 0.006, rgb('#f2eee6'));
      blob(b, [s * 0.035, 0.135, 0.095], 0.006, 0.006, 0.004, rgb('#20160e'));
      blob(b, [s * 0.035, 0.16, 0.09], 0.02, 0.006, 0.01, o.hair ?? o.beard ?? rgb('#3a2a1e'));
      blob(b, [s * 0.095, 0.12, 0.0], 0.012, 0.025, 0.02, o.skin);
    }
    blob(b, [0, 0.075, 0.095], 0.022, 0.006, 0.006, rgb('#7a3a32'));
    if (o.hair) loft(b, [{ c: [0, 0.16, -0.01], w: 0.1, h: 0.105 }, { c: [0, 0.23, -0.005], w: 0.09, h: 0.095 }, { c: [0, 0.27, 0], w: 0.04, h: 0.045 }], { sides: 12, ref: [0, 0, 1], seed: o.seed + 1, jitter: 0.12, color: () => o.hair!, capEnd: 0.4 });
    if (o.beard) {
      for (let k = 0; k < 9; k++) {
        const a = (k / 8 - 0.5) * 2.2;
        cone(b, [Math.sin(a) * 0.075, 0.08, Math.cos(a) * 0.07 + 0.01], [Math.sin(a) * 0.3, -1, 0.35], 0.09 + hash(k) * 0.04, 0.03, o.beard, 3);
      }
    }
    if (o.hood) {
      loft(
        b,
        [
          { c: [0, 0.02, -0.02], w: 0.12, h: 0.12 },
          { c: [0, 0.14, -0.02], w: 0.125, h: 0.125 },
          { c: [0, 0.25, -0.04], w: 0.1, h: 0.1 },
          { c: [0, 0.31, -0.1], w: 0.03, h: 0.03 },
        ],
        { sides: 10, ref: [0, 0, 1], seed: o.seed + 2, jitter: 0.05, color: (_t, a, p) => shade(Math.sin(a) > 0.55 && p[1] < 0.24 ? o.hood!.clone().multiplyScalar(0.5) : o.hood!, 1, p, 0.05), capEnd: 0.6 },
      );
    }
    if (o.crown) {
      const gold = rgb('#e6b83a');
      loft(b, [{ c: [0, 0.22, 0], w: 0.1, h: 0.105 }, { c: [0, 0.26, 0], w: 0.1, h: 0.105 }], { sides: 12, ref: [0, 0, 1], seed: 5, color: () => gold });
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        cone(b, [Math.sin(a) * 0.095, 0.26, Math.cos(a) * 0.1], [0, 1, 0], 0.06, 0.02, gold, 4);
        if (k === 0) blob(b, [0, 0.245, 0.105], 0.012, 0.012, 0.008, rgb('#c0283a'));
      }
    }
  };
  const extras: ProcSpec['extras'] = [];
  if (o.cape) {
    const cape = o.cape;
    extras.push({
      bone: 'chest',
      build(b) {
        // A cloak hanging down the back from the shoulders (in chest space: the chest bone sits at y 1.33).
        loft(
          b,
          [
            { c: [0, 0.12, -0.14], w: 0.22, h: 0.025 },
            { c: [0, -0.2, -0.17], w: 0.27, h: 0.025 },
            { c: [0, -0.6, -0.2], w: 0.31, h: 0.025 },
            { c: [0, -0.95, -0.24], w: 0.33, h: 0.02 },
          ],
          { sides: 8, ref: [0, 0, 1], seed: 9, jitter: 0.04, color: (t, _a, p) => shade(lerpColor(cape, cape.clone().multiplyScalar(0.7), t), 1, p, 0.05), capStart: 0, capEnd: 0 },
        );
        blob(b, [0, 0.13, 0.0], 0.15, 0.03, 0.15, rgb('#f2eee6'));
      },
    });
  }
  return {
    bones: { pelvis: [0, 0.95, 0], spine: [0, 1.13, 0], chest: [0, 1.33, 0], neck1: [0, 1.52, 0], neck2: [0, 1.6, 0], tail: [] },
    rollY: 0.9,
    headScale: 1.15,
    body(b, skin) {
      loft(b, smoothRings(torso, 2), { sides: 12, ref: [0, 0, 1], jitter: 0.02, seed: o.seed, color: torsoColor, capStart: 0.3, capEnd: 0.1, skin });
    },
    head,
    jawPivot: [0, 0.07, 0.05],
    jaw(b) {
      blob(b, [0, -0.005, 0.03], 0.035, 0.012, 0.02, o.beard ?? o.skin);
    },
    extras,
    legs,
    props: o.sword ? [{ name: 'sword', limb: 'RA', build: sword(o.sword) }] : [],
    gaits: BIPED_GAITS,
  };
}

export const SWORDSMAN = biped({
  seed: 81,
  build: 1,
  skin: rgb('#d6a581'),
  shirt: rgb('#6a4630'),
  shirtTrim: rgb('#3e2a1c'),
  belt: rgb('#2a1c12'),
  pants: rgb('#3a3a40'),
  boots: rgb('#2a1c12'),
  sleeves: [rgb('#4a3020'), rgb('#3e2a1c')],
  hood: rgb('#3f4a3a'),
  sword: { blade: rgb('#c8ccd4'), guard: rgb('#5a4a30'), len: 0.85 },
});

export const KING = biped({
  seed: 83,
  build: 1.05,
  skin: rgb('#e0b292'),
  shirt: rgb('#2c3c7a'),
  shirtTrim: rgb('#e0b040'),
  belt: rgb('#6a4a1c'),
  pants: rgb('#2a2a34'),
  boots: rgb('#1a1418'),
  sleeves: [rgb('#2c3c7a'), rgb('#2c3c7a')],
  hair: rgb('#e8e4dc'),
  beard: rgb('#ece8e0'),
  crown: true,
  cape: rgb('#a01c28'),
  sword: { blade: rgb('#f0cc5a'), guard: rgb('#e6b83a'), len: 0.8 },
});

export const BRAWLER = biped({
  seed: 89,
  build: 1.12,
  skin: rgb('#c48a62'),
  shirt: rgb('#e8e4d8'),
  belt: rgb('#1c1c20'),
  pants: rgb('#3a4a64'),
  boots: rgb('#2a2a2e'),
  sleeves: [rgb('#c48a62'), rgb('#c48a62')],
  hair: rgb('#1e1814'),
  arms: 1.35,
});
