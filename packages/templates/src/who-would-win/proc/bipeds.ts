/**
 * The human fighters: an upright skinned torso (pelvis → chest → neck), a head with face, hair or hood,
 * crown or beard, two-bone legs and arms placed by IK, and a sword aimed by the pose. Model space:
 * metres, +Z forward (the way they face), +Y up, +X their left.
 */
import { THREE } from '../../three-layer';
import { MeshBuilder, blob, cone, hash, lerpColor, loft, rgb, shade, smoothRings, type Ring, type V3 } from './builder';
import type { Gait, LegSpec, ProcSpec } from './rig';
import { scaleSpec } from './rig';
import { quadHead } from './quad';

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
  /** Other weapons in the right hand: an axe (one- or two-handed), a club. */
  axe?: { blade: THREE.Color; haft: THREE.Color; len: number };
  club?: { wood: THREE.Color; len: number };
  /** A round shield on the left arm. */
  shield?: { face: THREE.Color; rim: THREE.Color; boss: THREE.Color };
  /** Arm thickness and length multipliers (a brawler's thick arms; an ape's long ones). */
  arms?: number;
  armLen?: number;
  /** Its own head instead of a person's (a bull's, an ape's, a troll's), on the neck. */
  headBuild?: (b: MeshBuilder) => void;
  /** An iron helmet with a nose guard. */
  helmet?: THREE.Color;
  /** Bare feet of this colour instead of boots. */
  feet?: THREE.Color;
  /** Shaggy (fur): rougher facets on the torso. */
  shaggy?: number;
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

function bareFoot(color: THREE.Color) {
  return (b: MeshBuilder) => {
    loft(b, [{ c: [0, 0.04, -0.06], w: 0.05, h: 0.04 }, { c: [0, 0.035, 0.05], w: 0.065, h: 0.035, flat: 0.8 }, { c: [0, 0.03, 0.15], w: 0.06, h: 0.03, flat: 0.8 }], { sides: 8, seed: 4, color: (_t, _a, p) => shade(color, 1, p, 0.06), capStart: 0.3, capEnd: 0.5 });
    for (let k = 0; k < 4; k++) blob(b, [(k - 1.5) * 0.028, 0.02, 0.165], 0.015, 0.015, 0.02, color.clone().multiplyScalar(0.9));
  };
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

function axe(o: NonNullable<BipedOpts['axe']>) {
  return (b: MeshBuilder) => {
    loft(b, [{ c: [0, -0.15, 0], w: 0.022, h: 0.022 }, { c: [0, o.len, 0], w: 0.02, h: 0.02 }], { sides: 6, ref: [0, 0, 1], seed: 7, color: (_t, _a, p) => shade(o.haft, 1, p, 0.08), capStart: 0.3, capEnd: 0.3 });
    // The head: a bearded blade, its edge forward.
    const top = o.len - 0.04;
    const pts: V3[] = [
      [0, top, -0.03],
      [0, top, 0.05],
      [0, top + 0.07, 0.2],
      [0, top - 0.2, 0.22],
      [0, top - 0.12, 0.05],
      [0, top - 0.12, -0.03],
    ];
    const edge = o.blade.clone().multiplyScalar(1.15);
    for (const x of [0.012, -0.012]) {
      const q = pts.map((v): V3 => [x, v[1], v[2]]);
      for (let k = 1; k < q.length - 1; k++) (x > 0 ? b.tri(q[0], q[k], q[k + 1], k === 2 ? edge : o.blade) : b.tri(q[0], q[k + 1], q[k], k === 2 ? edge : o.blade));
    }
    blob(b, [0, top - 0.05, -0.02], 0.03, 0.06, 0.035, o.blade.clone().multiplyScalar(0.7));
  };
}

function club(o: NonNullable<BipedOpts['club']>) {
  return (b: MeshBuilder) => {
    loft(
      b,
      smoothRings(
        [
          { c: [0, -0.12, 0], w: 0.035, h: 0.035 },
          { c: [0, 0.2, 0], w: 0.045, h: 0.045 },
          { c: [0, o.len * 0.7, 0.01], w: 0.09, h: 0.085 },
          { c: [0, o.len, 0.02], w: 0.11, h: 0.1 },
        ],
        2,
      ),
      { sides: 8, ref: [0, 0, 1], seed: 13, jitter: 0.12, color: (_t, _a, p) => shade(o.wood, 1, p, 0.12), capStart: 0.3, capEnd: 0.5 },
    );
    for (let k = 0; k < 5; k++) blob(b, [Math.cos(k * 2.4) * 0.08, o.len * (0.62 + 0.07 * k), Math.sin(k * 2.4) * 0.08], 0.03, 0.03, 0.03, o.wood.clone().multiplyScalar(0.8));
  };
}

function shield(o: NonNullable<BipedOpts['shield']>) {
  return (b: MeshBuilder) => {
    // A round board on the forearm, facing forward (+Z), both faces drawn; rim and boss.
    const R = 0.38;
    const c: V3 = [0, 0.05, 0.07];
    const rim: V3[] = [];
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      rim.push([c[0] + Math.cos(a) * R, c[1] + Math.sin(a) * R, c[2]]);
    }
    for (let k = 0; k < 14; k++) {
      const k1 = (k + 1) % 14;
      const col = k % 2 ? o.face : o.face.clone().multiplyScalar(0.8);
      b.tri(c, rim[k], rim[k1], col);
      b.tri(c, rim[k1], rim[k], o.face.clone().multiplyScalar(0.6));
    }
    loft(b, rim.map((p) => ({ c: p, w: 0.018, h: 0.018 })).concat([{ c: rim[0], w: 0.018, h: 0.018 }]), { sides: 4, ref: [0, 0, 1], seed: 17, color: () => o.rim });
    blob(b, [c[0], c[1], c[2] + 0.04], 0.07, 0.07, 0.05, o.boss);
  };
}

/** A gorilla's head: a crested skull, a heavy brow, a flat broad muzzle, small ears. */
export function apeHead(fur: THREE.Color, face: THREE.Color) {
  return (b: MeshBuilder) => {
    loft(
      b,
      smoothRings(
        [
          { c: [0, -0.02, -0.02], w: 0.1, h: 0.09 },
          { c: [0, 0.06, 0.0], w: 0.13, h: 0.12 },
          { c: [0, 0.15, -0.01], w: 0.12, h: 0.12, ridge: 0.4 },
          { c: [0, 0.25, -0.03], w: 0.07, h: 0.06, ridge: 0.6 },
        ],
        2,
      ),
      { sides: 12, ref: [0, 0, 1], seed: 51, jitter: 0.06, color: (_t, _a, p) => shade(fur, 1, p, 0.08), capStart: 0.2, capEnd: 0.6 },
    );
    // Face: muzzle and brow ridge.
    loft(b, [{ c: [0, 0.04, 0.06], w: 0.09, h: 0.07 }, { c: [0, 0.03, 0.14], w: 0.085, h: 0.065, flat: 0.3 }], { sides: 10, seed: 52, color: (_t, _a, p) => shade(face, 1, p, 0.05), capStart: 0.1, capEnd: 0.4 });
    blob(b, [0, 0.13, 0.1], 0.1, 0.025, 0.035, face.clone().multiplyScalar(0.8));
    for (const s of [1, -1]) {
      blob(b, [s * 0.04, 0.1, 0.115], 0.014, 0.01, 0.006, rgb('#2a1608'));
      blob(b, [s * 0.025, 0.06, 0.165], 0.012, 0.01, 0.01, rgb('#141010'));
      blob(b, [s * 0.11, 0.09, -0.01], 0.015, 0.025, 0.02, face);
    }
  };
}

/** A troll's head: lumpy, a long drooping nose, small deep eyes, lower tusks, long pointed ears. */
export function trollHead(skin: THREE.Color, hair: THREE.Color) {
  return (b: MeshBuilder) => {
    loft(
      b,
      smoothRings(
        [
          { c: [0, -0.02, 0.0], w: 0.1, h: 0.09 },
          { c: [0, 0.07, 0.02], w: 0.13, h: 0.12 },
          { c: [0, 0.17, 0.0], w: 0.12, h: 0.11 },
          { c: [0, 0.24, -0.02], w: 0.07, h: 0.06 },
        ],
        2,
      ),
      { sides: 12, ref: [0, 0, 1], seed: 61, jitter: 0.12, color: (_t, _a, p) => shade(skin, 1, p, 0.1), capStart: 0.2, capEnd: 0.5 },
    );
    cone(b, [0, 0.11, 0.1], [0, -0.55, 1], 0.14, 0.04, skin.clone().multiplyScalar(0.92), 6);
    blob(b, [0, 0.15, 0.1], 0.11, 0.022, 0.03, skin.clone().multiplyScalar(0.8));
    for (const s of [1, -1]) {
      blob(b, [s * 0.045, 0.125, 0.105], 0.012, 0.008, 0.006, rgb('#d8c040'));
      cone(b, [s * 0.05, 0.0, 0.1], [s * 0.1, 1, 0.3], 0.07, 0.016, rgb('#e8dfc4'), 4);
      cone(b, [s * 0.12, 0.12, 0.0], [s * 1, 0.25, -0.35], 0.16, 0.035, skin, 4);
    }
    for (let k = 0; k < 7; k++) cone(b, [(k - 3) * 0.03, 0.22, -0.04 - Math.abs(k - 3) * 0.01], [(k - 3) * 0.1, 0.6, -1], 0.14, 0.03, hair, 3);
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
      paw: o.feet ? bareFoot(o.feet) : boot(o.boots),
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
      home: [s * 0.25 * w, 1.42 - 0.47 * (o.armLen ?? 1), 0.04],
      lens: [0.29 * (o.armLen ?? 1), 0.27 * (o.armLen ?? 1)],
      end: { up: 0, back: 0, segment: false },
      radii: [0.05 * arm, 0.042 * arm, 0.035 * arm],
      pole: [0, -0.2, -1],
      paw: fist(o.skin, arm),
      color: o.sleeves[0],
      colors: o.sleeves,
      arm: { swing: 0.22 },
    });
  }
  const head = o.headBuild ?? ((b: MeshBuilder) => {
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
    if (o.helmet) {
      const iron = o.helmet;
      loft(b, [{ c: [0, 0.14, -0.005], w: 0.105, h: 0.11 }, { c: [0, 0.22, -0.005], w: 0.098, h: 0.1 }, { c: [0, 0.29, 0], w: 0.05, h: 0.05 }], { sides: 12, ref: [0, 0, 1], seed: 6, color: (_t, a, p) => shade(iron, 0.9 + 0.2 * Math.abs(Math.cos(a)), p, 0.04), capEnd: 0.5 });
      loft(b, [{ c: [0, 0.145, -0.005], w: 0.11, h: 0.115 }, { c: [0, 0.165, -0.005], w: 0.11, h: 0.115 }], { sides: 12, ref: [0, 0, 1], seed: 7, color: () => iron.clone().multiplyScalar(0.75) });
      blob(b, [0, 0.12, 0.112], 0.012, 0.05, 0.01, iron);
    }
  });
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
      loft(b, smoothRings(torso, 2), { sides: 12, ref: [0, 0, 1], jitter: o.shaggy ?? 0.02, seed: o.seed, color: torsoColor, capStart: 0.3, capEnd: 0.1, skin });
    },
    head,
    jawPivot: [0, 0.07, 0.05],
    jaw(b) {
      blob(b, [0, -0.005, 0.03], 0.035, 0.012, 0.02, o.beard ?? o.skin);
    },
    extras,
    legs,
    // (Whatever is in the right hand is its weapon, posed as 'sword'.)
    props: [
      ...(o.sword ? [{ name: 'sword', limb: 'RA', build: sword(o.sword) }] : []),
      ...(o.axe ? [{ name: 'sword', limb: 'RA', build: axe(o.axe) }] : []),
      ...(o.club ? [{ name: 'sword', limb: 'RA', build: club(o.club) }] : []),
      ...(o.shield ? [{ name: 'shield', limb: 'LA', build: shield(o.shield) }] : []),
    ],
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

const GORILLA_FUR = rgb('#2a2726');
const GORILLA_SKIN = rgb('#3c3532');
/** A silverback: broad, long-armed, short-legged, grey saddle; it knuckle-walks (poses.ts). */
export const GORILLA: ProcSpec = {
  ...biped({
  seed: 101,
  build: 1.75,
  skin: GORILLA_SKIN,
  shirt: GORILLA_FUR,
  shirtTrim: rgb('#8e8a86'),
  belt: GORILLA_FUR,
  pants: GORILLA_FUR,
  boots: GORILLA_SKIN,
  feet: GORILLA_SKIN,
  sleeves: [GORILLA_FUR, GORILLA_FUR],
  arms: 2.2,
  armLen: 1.5,
  headBuild: apeHead(GORILLA_FUR, GORILLA_SKIN),
  shaggy: 0.1,
  }),
  headScale: 1.5,
};

const MINO_FUR = rgb('#4a3424');
/** A bull-headed giant with a two-handed axe. */
export const MINOTAUR = scaleSpec(
  biped({
    seed: 103,
    build: 1.4,
    skin: rgb('#8a5e44'),
    shirt: rgb('#8a5e44'),
    shirtTrim: rgb('#6a4430'),
    belt: rgb('#3a2414'),
    pants: MINO_FUR,
    boots: rgb('#1c1612'),
    feet: rgb('#1c1612'),
    sleeves: [rgb('#8a5e44'), rgb('#8a5e44')],
    arms: 1.6,
    axe: { blade: rgb('#9aa0a8'), haft: rgb('#4a3018'), len: 1.0 },
    headBuild: quadHead(
      {
        len: 0.4,
        w: 0.16,
        h: 0.16,
        muzzle: 0.85,
        tilt: 0.2,
        ears: { len: 0.1, w: 0.03, out: 1, back: 0.2, color: MINO_FUR },
        horns: 'bull',
        hornColor: rgb('#e8dcc0'),
        muzzleColor: rgb('#2e2018'),
        nose: rgb('#140e0a'),
        eye: rgb('#7a1010'),
      },
      { base: MINO_FUR, back: rgb('#36261a'), belly: MINO_FUR },
      107,
    ),
    shaggy: 0.05,
  }),
  1.2,
);

const TROLL_SKIN = rgb('#6f7a5c');
/** A hulking troll with a club: grey-green, mossy, slow. */
export const TROLL = scaleSpec(
  biped({
    seed: 109,
    build: 1.6,
    skin: TROLL_SKIN,
    shirt: TROLL_SKIN,
    shirtTrim: rgb('#5d6a4a'),
    belt: rgb('#4a3a28'),
    pants: rgb('#5a4a34'),
    boots: TROLL_SKIN,
    feet: rgb('#5f6a4e'),
    sleeves: [TROLL_SKIN, TROLL_SKIN],
    arms: 2,
    armLen: 1.25,
    club: { wood: rgb('#5a4028'), len: 1.15 },
    headBuild: trollHead(TROLL_SKIN, rgb('#3a3a2a')),
    shaggy: 0.08,
  }),
  1.32,
);

/** A shield-bearing warrior: round shield, axe, iron helmet, braided beard. */
export const VIKING = biped({
  seed: 113,
  build: 1.12,
  skin: rgb('#e0b494'),
  shirt: rgb('#6a7a8a'),
  shirtTrim: rgb('#3a4048'),
  belt: rgb('#3a2414'),
  pants: rgb('#5a4a3a'),
  boots: rgb('#3a2a1c'),
  sleeves: [rgb('#7a5a3a'), rgb('#6a7a8a')],
  beard: rgb('#c88a3a'),
  hair: rgb('#c88a3a'),
  helmet: rgb('#8a8e94'),
  axe: { blade: rgb('#b8bec6'), haft: rgb('#5a3a1e'), len: 0.75 },
  shield: { face: rgb('#a83a2a'), rim: rgb('#6a6e74'), boss: rgb('#9a9ea4') },
});
