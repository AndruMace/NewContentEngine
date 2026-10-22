/** The dragon (a winged quadruped that flies low) and the giant spider (eight legs, two body parts). */
import { THREE } from '../../three-layer';
import { MeshBuilder, blob, cone, hash, lerpColor, loft, rgb, shade, smoothRings, type V3 } from './builder';
import { ROTARY, LATERAL, quadruped, softPaw } from './quad';
import type { LegName, LegSpec, ProcSpec } from './rig';

const SCALE = rgb('#8a1c22');
const SCALE_DARK = rgb('#5a1016');
const PLATE = rgb('#d9a441');
const BONE = rgb('#e8dcc0');
const MEMBRANE = rgb('#9a2a30');

const base = quadruped({
  seed: 91,
  withers: 1.25,
  length: 1.9,
  chest: [0.36, 0.42],
  tuck: 0.15,
  rump: 0.9,
  hump: 0.1,
  neck: { len: 1.0, angle: 0.75, thick: 0.17 },
  head: {
    len: 0.62,
    w: 0.15,
    h: 0.15,
    muzzle: 0.6,
    tilt: 0.35,
    ears: { len: 0.1, w: 0.03, out: 0.6, back: 0.6, color: SCALE_DARK },
    nose: rgb('#2a0c0e'),
    eye: rgb('#f0c030'),
    fangs: true,
    muzzleColor: SCALE,
  },
  legs: { hoof: false, thick: 0.15, paw: softPaw(0.13, SCALE_DARK, BONE) },
  tail: { len: 2.0, thick: 0.15, droop: 0.35, color: SCALE },
  coat: { base: SCALE, back: SCALE_DARK, belly: PLATE, legs: SCALE, lower: SCALE_DARK },
  jitter: 0.04,
  gaits: [
    { from: 0, duty: 0.65, offsets: LATERAL, lift: 0.12, bob: 0.02, flex: 0.02 },
    { from: 4, duty: 0.35, offsets: ROTARY, lift: 0.2, bob: 0.05, flex: 0.08 },
  ],
});

/** A wing panel: a bony leading edge (arm) with a membrane (or feathers) hanging behind it to the body. */
export function wingPart(len: number, chordIn: number, chordOut: number, fingers: number, edgeC = SCALE_DARK, skinC = MEMBRANE, strut = true, feathers = false) {
  return (b: MeshBuilder) => {
    // Leading edge.
    loft(b, [{ c: [0, 0, 0], w: 0.045, h: 0.05 }, { c: [len, 0.05, 0.05], w: 0.03, h: 0.035 }], { sides: 6, ref: [0, 1, 0], seed: 4, color: (_t, _a, p) => shade(edgeC, 1, p, 0.05), capStart: 0.3, capEnd: 0.3 });
    // Membrane: a fan of triangles from the edge back to the trailing points, both faces drawn.
    const pts: V3[] = [];
    for (let k = 0; k <= fingers; k++) {
      const t = k / fingers;
      // (Feathers: long tips and short notches in turn.)
      const notch = feathers ? (k % 2 ? 0.78 : 1.05) : 0.85 + 0.15 * Math.sin(t * Math.PI * fingers);
      pts.push([t * len, 0.05 * t - 0.02, -(chordIn + (chordOut - chordIn) * t) * notch]);
    }
    // Each span between two fingers: from the leading edge to a sagging middle row (a curved surface, not
    // a board) to the trailing edge, scalloped in between a dragon's finger tips (a bat's wing).
    const lead = (k: number): V3 => [(k / fingers) * len, 0.05 * (k / fingers), 0.02];
    const mid = (k: number): V3 => {
      const l = lead(k);
      const t = pts[k];
      return [(l[0] + t[0]) / 2, (l[1] + t[1]) / 2 - 0.12 * Math.abs(t[2] - l[2]), (l[2] + t[2]) / 2];
    };
    const mixV = (p: V3, q: V3, u: number): V3 => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u];
    for (let k = 0; k < fingers; k++) {
      const [l0, l1, m0, m1, t0, t1] = [lead(k), lead(k + 1), mid(k), mid(k + 1), pts[k], pts[k + 1]];
      const col = shade(feathers ? (k % 2 ? skinC : skinC.clone().multiplyScalar(0.82)) : lerpColor(skinC, edgeC, hash(k) * 0.4), 1, l0, 0.05);
      const inner = col.clone().multiplyScalar(0.9);
      b.tri(l0, m0, m1, col);
      b.tri(l0, m1, l1, col);
      if (feathers) {
        b.tri(m0, t0, t1, inner);
        b.tri(m0, t1, m1, inner);
      } else {
        const sc = mixV(mixV(t0, t1, 0.5), mixV(m0, m1, 0.5), 0.4);
        b.tri(m0, t0, sc, inner);
        b.tri(m0, sc, m1, inner);
        b.tri(m1, sc, t1, inner);
      }
    }
    // Finger struts (a bat's or a dragon's; feathers have none), following the membrane's curve.
    if (strut)
      for (let k = 1; k <= fingers; k++)
        for (const [p, q] of [
          [lead(k), mid(k)],
          [mid(k), pts[k]],
        ] as const)
          cone(b, p, [q[0] - p[0], q[1] - p[1], q[2] - p[2]], Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]), 0.012, edgeC, 3);
  };
}

export const DRAGON: ProcSpec = {
  ...base,
  headScale: 1,
  body(b, skin) {
    base.body(b, skin);
    // Spines down the back and tail, plates under the neck already come from the belly colour.
    for (let k = 0; k < 22; k++) {
      const t = k / 21;
      // From the head end of the neck back to the tail tip, along the bones.
      const bonesPath: V3[] = [base.bones.neck2, base.bones.neck1, base.bones.chest, base.bones.spine, base.bones.pelvis, ...base.bones.tail];
      const f = t * (bonesPath.length - 1);
      const i = Math.floor(f);
      const u = f - i;
      const a = bonesPath[i];
      const c = bonesPath[Math.min(bonesPath.length - 1, i + 1)];
      const p: V3 = [a[0] + (c[0] - a[0]) * u, a[1] + (c[1] - a[1]) * u, a[2] + (c[2] - a[2]) * u];
      const r = i < 2 ? 0.16 : i < 5 ? 0.4 : 0.15 * (1 - (i - 5) / 5) + 0.03;
      const at: V3 = [0, p[1] + r * 0.95, p[2]];
      cone(b, at, [0, 1, -0.35], 0.12 * (1 - t * 0.6) + 0.04, 0.045 * (1 - t * 0.5), BONE, 3, skin(at));
    }
  },
  head(b) {
    base.head(b);
    // Swept-back horns and a brow ridge.
    for (const s of [1, -1]) {
      cone(b, [s * 0.1, 0.12, 0.05], [s * 0.25, 0.4, -1], 0.32, 0.04, BONE, 5);
      cone(b, [s * 0.13, 0.05, 0.12], [s * 0.6, 0.2, -1], 0.18, 0.025, BONE, 4);
      blob(b, [s * 0.1, 0.12, 0.2], 0.05, 0.025, 0.07, SCALE_DARK);
    }
  },
  wings: {
    bone: 'chest',
    root: [0.25, 0.42, 0.05],
    elbow: [1.2, 0.06, 0.05],
    inner: wingPart(1.2, 0.85, 0.9, 3),
    outer: wingPart(1.4, 0.9, 0.35, 4),
  },
};

// ---- giant spider ----------------------------------------------------------------------------------

const CHITIN = rgb('#25252b');
const CHITIN_HI = rgb('#3a3a44');
const MARK = rgb('#b01e2a');

const spiderLegs: LegSpec[] = [];
const LEG_Z = [0.36, 0.24, 0.12, 0.0];
const HOME_Z = [1.0, 0.45, -0.15, -0.72];
const HOME_X = [0.8, 1.05, 1.05, 0.88];
for (let k = 0; k < 4; k++)
  for (const s of [1, -1] as const) {
    const name: LegName = `${s > 0 ? 'L' : 'R'}${k + 1}`;
    spiderLegs.push({
      name,
      bone: 'chest',
      hip: [s * 0.18, 0.58, LEG_Z[k]],
      home: [s * HOME_X[k], 0, HOME_Z[k]],
      lens: [0.58, 0.62],
      end: { up: 0.08, back: 0, segment: true },
      radii: [0.05, 0.035, 0.022],
      pole: [s * 0.4, 1, 0],
      paw: (b) => blob(b, [0, 0.01, 0], 0.02, 0.015, 0.03, CHITIN),
      color: CHITIN,
      colors: [CHITIN, CHITIN_HI],
    });
  }

/** Alternating tetrapod: legs 1 and 3 of one side move with 2 and 4 of the other. */
const TETRAPOD: Record<LegName, number> = { L1: 0, R2: 0.02, L3: 0, R4: 0.02, R1: 0.5, L2: 0.52, R3: 0.5, L4: 0.52 };

export const SPIDER: ProcSpec = {
  bones: {
    pelvis: [0, 0.56, -0.18],
    spine: [0, 0.57, 0.05],
    chest: [0, 0.58, 0.2],
    neck1: [0, 0.57, 0.4],
    neck2: [0, 0.54, 0.48],
    tail: [
      [0, 0.62, -0.45],
      [0, 0.64, -0.75],
      [0, 0.58, -1.0],
    ],
  },
  rollY: 0.55,
  body(b, skin) {
    const hairy = (_t: number, a: number, p: V3) => shade(lerpColor(CHITIN, CHITIN_HI, Math.max(0, Math.sin(a)) * 0.5), 1, p, 0.12);
    // Cephalothorax.
    loft(
      b,
      smoothRings(
        [
          { c: [0, 0.57, -0.2], w: 0.1, h: 0.08 },
          { c: [0, 0.58, -0.05], w: 0.24, h: 0.15, flat: 0.3 },
          { c: [0, 0.6, 0.2], w: 0.27, h: 0.17, flat: 0.3 },
          { c: [0, 0.58, 0.42], w: 0.17, h: 0.13, flat: 0.2 },
          { c: [0, 0.55, 0.5], w: 0.1, h: 0.09 },
        ],
        2,
      ),
      { sides: 12, jitter: 0.06, seed: 93, color: hairy, capStart: 0.3, capEnd: 0.3, skin },
    );
    // Abdomen: big and round, with a red hourglass on top.
    loft(
      b,
      smoothRings(
        [
          { c: [0, 0.6, -0.22], w: 0.12, h: 0.1 },
          { c: [0, 0.66, -0.4], w: 0.38, h: 0.34 },
          { c: [0, 0.68, -0.7], w: 0.45, h: 0.4 },
          { c: [0, 0.62, -1.0], w: 0.34, h: 0.3 },
          { c: [0, 0.56, -1.15], w: 0.12, h: 0.12 },
        ],
        2,
      ),
      {
        sides: 14,
        jitter: 0.07,
        seed: 95,
        color: (t, a, p) => (Math.sin(a) > 0.8 && Math.abs(Math.abs(p[2] + 0.7) - 0.06) < 0.13 && Math.abs(p[0]) < 0.12 + Math.abs(p[2] + 0.7) * 0.6 ? MARK : hairy(t, a, p)),
        capStart: 0.3,
        capEnd: 0.4,
        skin,
      },
    );
  },
  head(b) {
    // Eyes: two big, a ring of small ones, glinting red.
    const eye = rgb('#d42a30');
    for (const s of [1, -1]) {
      blob(b, [s * 0.04, 0.07, 0.0], 0.03, 0.03, 0.025, eye);
      blob(b, [s * 0.09, 0.08, -0.03], 0.018, 0.018, 0.015, eye);
      blob(b, [s * 0.11, 0.06, -0.07], 0.014, 0.014, 0.012, eye);
      blob(b, [s * 0.06, 0.1, -0.06], 0.014, 0.014, 0.012, eye);
      // Pedipalps.
      cone(b, [s * 0.06, -0.02, 0.02], [s * 0.2, -0.4, 1], 0.16, 0.022, CHITIN_HI, 5);
    }
  },
  jawPivot: [0, -0.02, 0.02],
  jaw(b) {
    // Fangs (chelicerae) hanging down, dark with pale tips.
    for (const s of [1, -1]) {
      cone(b, [s * 0.045, 0, 0], [s * 0.1, -1, 0.35], 0.16, 0.035, CHITIN_HI, 5, undefined, rgb('#e6d8b8'));
    }
  },
  legs: spiderLegs,
  gaits: [
    { from: 0, duty: 0.55, offsets: TETRAPOD, lift: 0.15, bob: 0.015, flex: 0 },
    { from: 4, duty: 0.45, offsets: TETRAPOD, lift: 0.22, bob: 0.03, flex: 0 },
  ],
};

export { THREE };
