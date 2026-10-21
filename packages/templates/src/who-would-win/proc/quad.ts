/**
 * A generator for four-legged mammals: body, neck, head, legs, tail, mane and horns from a handful of
 * measurements, with gaits to match. Horses, cattle, deer, camelids and dogs all come out of it (see
 * mammals.ts). Model space: metres, +Z forward, +Y up, +X the animal's left.
 */
import { THREE } from '../../three-layer';
import { MeshBuilder, blob, cone, hash, lerpColor, loft, shade, smoothRings, type Ring, type Skin, type V3 } from './builder';
import type { Gait, LegName, LegSpec, ProcSpec } from './rig';

export const LATERAL: Record<LegName, number> = { LH: 0, LF: 0.25, RH: 0.5, RF: 0.75 };
export const TROT: Record<LegName, number> = { LF: 0, RH: 0.02, RF: 0.5, LH: 0.52 };
export const ROTARY: Record<LegName, number> = { LH: 0, RH: 0.09, LF: 0.5, RF: 0.6 };
/** A bound: both hind feet, then both front (deer, small dogs at speed). */
export const BOUND: Record<LegName, number> = { LH: 0, RH: 0.04, LF: 0.5, RF: 0.54 };

export interface HeadOpts {
  len: number;
  w: number;
  h: number;
  /** Muzzle width as a fraction of the head's (a horse's ~0.6, a bull's 0.85, a dog's 0.5). */
  muzzle: number;
  /** Resting tilt of the head on the neck (rad, + nose down). */
  tilt: number;
  ears: { len: number; w: number; out: number; back: number; color?: THREE.Color; inner?: THREE.Color };
  horns?: 'bull' | 'antlers' | 'unicorn' | 'rhino';
  /** An elephant's trunk (hanging from the muzzle, curling out at the tip), tusks and fan ears. */
  trunk?: { len: number; thick: number };
  tusks?: number;
  fanEars?: { w: number; h: number; color: THREE.Color };
  hornColor?: THREE.Color;
  muzzleColor?: THREE.Color;
  nose: THREE.Color;
  eye: THREE.Color;
  /** Teeth showing when the jaw opens (canines for dogs). */
  fangs?: boolean;
  /** Face markings (a husky's mask, a fox's white cheeks): a colour for a point of the head, or null. */
  mark?: (p: V3, a: number) => THREE.Color | null;
  /** A tuft of mane between the ears (horses). */
  forelock?: THREE.Color;
}

export interface QuadOpts {
  seed: number;
  /** Height of the top of the shoulders, and rump-to-chest length. */
  withers: number;
  length: number;
  /** Chest half-width and half-depth. */
  chest: [number, number];
  /** How much the belly tucks up (0 barrel, 1 greyhound). */
  tuck: number;
  /** Rump size relative to the chest. */
  rump: number;
  /** Raised ridge over the shoulders (a bull's hump), as a fraction of the chest depth. */
  hump?: number;
  neck: { len: number; angle: number; thick: number; dewlap?: number };
  head: HeadOpts;
  legs: { hoof: boolean; thick: number; hoofColor?: THREE.Color; paw?: (b: MeshBuilder) => void; upper?: number; columns?: boolean };
  tail: { len: number; thick: number; droop: number; hair?: number; bushy?: number; up?: number; color?: THREE.Color; tip?: THREE.Color };
  coat: { base: THREE.Color; back: THREE.Color; belly: THREE.Color; legs?: THREE.Color; lower?: THREE.Color; mark?: (p: V3, a: number) => THREE.Color | null };
  /** Fur roughness (radial jitter of the facets). */
  jitter: number;
  mane?: { color: THREE.Color; height: number; upright?: boolean };
  gaits: Gait[];
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

function coatColor(c: QuadOpts['coat'], noise: number) {
  return (_t: number, a: number, p: V3) => {
    const m = c.mark?.(p, a);
    if (m) return shade(m, 1, p, noise * 0.6);
    const k = Math.sin(a);
    const col = k > 0 ? lerpColor(c.base, c.back, Math.pow(k, 1.4)) : lerpColor(c.base, c.belly, Math.pow(-k, 0.8));
    return shade(col, 1, p, noise);
  };
}

/** A hoof: a short flared cylinder, dark, with the fetlock's hair above. */
export function hoofPaw(r: number, color: THREE.Color) {
  return (b: MeshBuilder) => {
    loft(
      b,
      [
        { c: [0, 0.0, r * 0.15], w: r * 1.05, h: r * 1.15 },
        { c: [0, r * 0.9, 0], w: r * 0.85, h: r * 0.9 },
        { c: [0, r * 1.3, -r * 0.1], w: r * 0.75, h: r * 0.8 },
      ],
      { sides: 8, ref: [0, 0, 1], seed: 21, color: (_t, _a, p) => shade(color, 1, p, 0.05), capStart: 0.05, capEnd: 0.2 },
    );
  };
}

/** A dog's or cat's paw: a pad with four toes. */
export function softPaw(w: number, color: THREE.Color, claw?: THREE.Color) {
  return (b: MeshBuilder) => {
    loft(
      b,
      [
        { c: [0, w * 0.55, -w * 0.8], w: w * 0.7, h: w * 0.5 },
        { c: [0, w * 0.55, 0], w: w, h: w * 0.6, flat: 0.6 },
        { c: [0, w * 0.4, w * 0.8], w: w * 0.85, h: w * 0.45, flat: 0.6 },
      ],
      { sides: 8, seed: 5, color: (_t, _a, p) => shade(color, 1, p, 0.05), capStart: 0.4, capEnd: 0.5 },
    );
    for (let k = 0; k < 4; k++) {
      blob(b, [(k - 1.5) * w * 0.45, w * 0.3, w * 1.05], w * 0.24, w * 0.3, w * 0.28, color.clone().multiplyScalar(0.95));
      if (claw) cone(b, [(k - 1.5) * w * 0.45, w * 0.2, w * 1.25], [0, -0.4, 1], w * 0.35, w * 0.06, claw, 3);
    }
  };
}

function buildHead(b: MeshBuilder, o: HeadOpts, coat: QuadOpts['coat'], seed: number) {
  const { len, w, h } = o;
  const face = (_t: number, a: number, p: V3) => {
    const m = o.mark?.(p, a);
    if (m) return shade(m, 1, p, 0.04);
    const front = Math.max(0, Math.min(1, (p[2] - len * 0.6) / (len * 0.3)));
    const base = lerpColor(coat.base, coat.back, Math.max(0, Math.sin(a)) * 0.5);
    return shade(o.muzzleColor ? lerpColor(base, o.muzzleColor, front) : base, 1, p, 0.05);
  };
  loft(
    b,
    smoothRings(
      [
        { c: [0, 0, -0.06], w: w * 0.8, h: h * 0.85 },
        { c: [0, h * 0.12, len * 0.15], w, h },
        { c: [0, h * 0.06, len * 0.42], w: w * 0.85, h: h * 0.82, flat: 0.15 },
        { c: [0, -h * 0.08, len * 0.72], w: w * o.muzzle, h: h * 0.62, flat: 0.2 },
        { c: [0, -h * 0.14, len], w: w * o.muzzle * 0.85, h: h * 0.48, flat: 0.15 },
      ],
      2,
    ),
    { sides: 12, jitter: 0.03, seed, color: face, capStart: 0.3, capEnd: 0.3 },
  );
  blob(b, [0, -h * 0.05, len + h * 0.12], w * o.muzzle * 0.55, h * 0.22, h * 0.12, o.nose);
  for (const s of [1, -1]) {
    blob(b, [s * w * 0.82, h * 0.42, len * 0.3], w * 0.18, h * 0.13, w * 0.15, o.eye);
    blob(b, [s * w * 0.88, h * 0.43, len * 0.33], w * 0.08, h * 0.07, w * 0.07, new THREE.Color('#0b0806'));
    // Ears: a cone with a paler lining.
    const e = o.ears;
    const base: V3 = [s * w * 0.62, h * 0.85, len * 0.05];
    const dir: V3 = [s * e.out, 1, -e.back];
    cone(b, base, dir, e.len, e.w, e.color ?? coat.back, 5);
    if (e.inner) cone(b, add(base, [0, 0.01, 0.012]), dir, e.len * 0.8, e.w * 0.55, e.inner, 4);
    if (o.fangs) cone(b, [s * w * o.muzzle * 0.55, -h * 0.45, len * 0.85], [0, -1, 0.1], h * 0.28, w * 0.06, new THREE.Color('#f1ead8'), 4);
    const hc = o.hornColor ?? new THREE.Color('#e8dcc0');
    if (o.horns === 'bull') {
      // Out sideways, curving forward and up: a chain of cones.
      let at: V3 = [s * w * 0.75, h * 0.8, len * 0.12];
      const dirs: V3[] = [[s * 1, 0.1, 0.1], [s * 0.8, 0.45, 0.45], [s * 0.2, 0.9, 0.6]];
      dirs.forEach((d, k) => {
        const l = w * 0.9 * (1 - k * 0.15);
        cone(b, at, d, l * 1.15, w * (0.17 - k * 0.04), k === 2 ? hc.clone().multiplyScalar(0.55) : hc, 6);
        const n = Math.hypot(...d);
        at = add(at, mul(d, l / n));
      });
    } else if (o.horns === 'antlers') {
      // A main beam sweeping up and back, with tines forward.
      let at: V3 = [s * w * 0.5, h * 0.95, len * 0.1];
      const beam: V3[] = [[s * 0.5, 1, -0.25], [s * 0.35, 1, 0.05], [s * 0.2, 1, -0.2], [s * 0.15, 1, 0.1]];
      beam.forEach((d, k) => {
        const l = 0.2 - k * 0.02;
        cone(b, at, d, l * 1.2, 0.035 - k * 0.006, hc, 5);
        const n = Math.hypot(...d);
        const next = add(at, mul(d, l / n));
        // Tine.
        cone(b, add(at, mul(d, l * 0.5 / n)), [s * 0.2, 0.7, 1], 0.13 - k * 0.015, 0.018, hc, 4);
        at = next;
      });
    } else if (o.horns === 'rhino' && s === 1) {
      // Two horns on the nose, the front one long and swept up.
      cone(b, [0, h * 0.2, len * 0.82], [0, 1, 0.35], len * 0.55, w * 0.42, hc, 7, undefined, hc.clone().multiplyScalar(0.7));
      cone(b, [0, h * 0.42, len * 0.55], [0, 1, 0.15], len * 0.22, w * 0.3, hc, 6);
    } else if (o.horns === 'unicorn') {
      // Spiralled: three cones twisting into one.
      cone(b, [0, h * 0.95, len * 0.32], [0, 1, 0.75], 0.55, 0.05, o.hornColor ?? new THREE.Color('#f3dc8a'), 6, undefined, new THREE.Color('#fff6cf'));
    }
  }
  if (o.forelock) for (let k = 0; k < 4; k++) cone(b, [(k - 1.5) * w * 0.25, h * 0.95, len * 0.12], [0, 0.4, 1], h * 0.6, w * 0.15, o.forelock, 3);
  const skinC = coat.base;
  if (o.trunk) {
    const { len: tl, thick } = o.trunk;
    const pts: V3[] = [
      [0, -h * 0.1, len * 0.95],
      [0, -h * 0.35 - tl * 0.12, len + tl * 0.12],
      [0, -h * 0.35 - tl * 0.45, len + tl * 0.16],
      [0, -h * 0.35 - tl * 0.75, len + tl * 0.12],
      [0, -h * 0.35 - tl * 0.92, len + tl * 0.22],
      [0, -h * 0.35 - tl * 0.98, len + tl * 0.34],
    ];
    loft(
      b,
      pts.map((c, k) => ({ c, w: thick * (1 - 0.55 * (k / 5)), h: thick * (1 - 0.55 * (k / 5)) })),
      { sides: 9, ref: [0, 0, 1], jitter: 0.04, seed: seed + 11, color: (t, _a, p) => shade(skinC.clone().multiplyScalar(0.95 - 0.1 * Math.abs(Math.sin(t * 40))), 1, p, 0.04), capStart: 0.2, capEnd: 0.3 },
    );
  }
  if (o.tusks) {
    const ivory = new THREE.Color('#efe6cc');
    for (const s of [1, -1]) {
      let at: V3 = [s * w * 0.45, -h * 0.3, len * 0.72];
      const dirs: V3[] = [[s * 0.15, -0.45, 1], [s * 0.1, 0.05, 1], [s * 0.02, 0.55, 1]];
      dirs.forEach((d, k) => {
        const l = o.tusks! / 3;
        cone(b, at, d, l * 1.15, w * (0.12 - k * 0.03), ivory, 6);
        at = add(at, mul(d, l / Math.hypot(...d)));
      });
    }
  }
  if (o.fanEars) {
    const { w: ew, h: eh, color } = o.fanEars;
    for (const s of [1, -1]) {
      // A broad flap behind the cheek, both faces drawn.
      const c: V3 = [s * w * 0.95, h * 0.15, len * 0.02];
      const rim: V3[] = [];
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const r = 1 + 0.12 * Math.sin(a * 3 + s);
        rim.push([c[0] + s * 0.05 * Math.cos(a), c[1] + Math.sin(a) * eh * 0.5 * r - eh * 0.12, c[2] - ew * 0.5 + Math.cos(a) * ew * 0.5 * r]);
      }
      const inner = color.clone().multiplyScalar(1.1);
      for (let k = 0; k < 10; k++) {
        const k1 = (k + 1) % 10;
        b.tri(c, rim[k], rim[k1], color);
        b.tri(c, rim[k1], rim[k], inner);
      }
    }
  }
}

/** Quadruped head on its own (a minotaur wears a bull's). */
export function quadHead(o: HeadOpts, coat: QuadOpts['coat'], seed: number) {
  return (b: MeshBuilder) => buildHead(b, o, coat, seed);
}

export function quadruped(o: QuadOpts): ProcSpec {
  const L = o.length;
  const [cw, ch] = o.chest;
  const top = (z: number) => o.withers - (z < 0 ? (-z / (L / 2)) * o.withers * 0.04 : 0);
  const ring = (z: number, w: number, h: number, extra: Partial<Ring> = {}): Ring => ({ c: [0, top(z) - h, z], w, h, ...extra });
  const rumpR = o.rump;
  const neckBase: V3 = [0, top(L / 2) - ch * 0.55, L / 2 - 0.02];
  const nd: V3 = [0, Math.sin(o.neck.angle), Math.cos(o.neck.angle)];
  const nk = (s: number): V3 => add(neckBase, mul(nd, s * o.neck.len));
  const bodyRings: Ring[] = [
    ring(-L / 2 - 0.04, cw * rumpR * 0.55, ch * rumpR * 0.6),
    ring(-L * 0.42, cw * rumpR * 0.92, ch * rumpR * 0.95, { flat: 0.1 }),
    ring(-L * 0.24, cw * rumpR, ch * rumpR, { flat: 0.1 }),
    ring(0, cw * 0.92, ch * (1 - o.tuck * 0.3), { flat: 0.15 + o.tuck * 0.2 }),
    ring(L * 0.25, cw, ch, { flat: 0.05 }),
    ring(L * 0.42, cw * 0.95, ch * 1.02, { ridge: o.hump ?? 0.05 }),
    { c: nk(0.12), w: o.neck.thick * 1.15, h: o.neck.thick * 1.45, pear: -(o.neck.dewlap ?? 0) },
    { c: nk(0.45), w: o.neck.thick, h: o.neck.thick * 1.25, pear: -(o.neck.dewlap ?? 0) * 0.6 },
    { c: nk(0.8), w: o.neck.thick * 0.82, h: o.neck.thick * 1.05 },
    { c: nk(1), w: o.neck.thick * 0.75, h: o.neck.thick * 0.95 },
  ];
  // Tail: from just inside the rump, back and down.
  const tailStart: V3 = [0, top(-L / 2) - ch * rumpR * 0.35, -L / 2 + 0.04];
  const td: V3 = [0, -Math.sin(o.tail.droop), -Math.cos(o.tail.droop)];
  const tailPts: V3[] = [];
  for (let k = 0; k <= 5; k++) {
    const s = k / 5;
    // Curling tails (a husky's) rise over the back towards the tip.
    const up = (o.tail.up ?? 0) * s * s;
    tailPts.push(add(add(tailStart, mul(td, s * o.tail.len)), [0, up * o.tail.len, up * o.tail.len * 1.1]));
  }
  const tailRings: Ring[] = tailPts.map((c, k) => {
    const s = k / 5;
    const bush = (o.tail.bushy ?? 0) * Math.sin(Math.PI * Math.min(1, s * 1.1));
    const hair = (o.tail.hair ?? 0) * s;
    const r = o.tail.thick * (1 - 0.55 * s) + bush + hair;
    return { c, w: r, h: r * (o.tail.hair ? 0.7 : 1) };
  });
  const hipY = top(-L * 0.3) - ch * rumpR * 0.75;
  const shY = top(L * 0.38) - ch * 0.8;
  const bones: ProcSpec['bones'] = {
    pelvis: [0, top(-L * 0.25) - ch * rumpR, -L * 0.25],
    spine: [0, top(0) - ch, 0],
    chest: [0, top(L * 0.28) - ch, L * 0.28],
    neck1: nk(0.45),
    neck2: nk(1),
    tail: [1, 2, 3, 4, 5].map((k) => tailPts[k]),
  };
  const legColor = o.coat.legs ?? o.coat.base;
  const lower = o.coat.lower ?? legColor;
  const hoofC = o.legs.hoofColor ?? new THREE.Color('#2a2420');
  const t = o.legs.thick;
  const paw = o.legs.hoof ? hoofPaw(t * (o.legs.columns ? 0.85 : 0.55), hoofC) : (o.legs.paw ?? softPaw(t * 0.75, lower));
  const mkLeg = (name: LegName, front: boolean, side: 1 | -1): LegSpec => {
    const hy = front ? shY : hipY;
    const x = side * (front ? cw * 0.55 : cw * rumpR * 0.58);
    const endUp = (o.legs.hoof ? 0.3 : 0.16) * hy;
    return {
      name,
      bone: front ? 'chest' : 'pelvis',
      hip: [x, hy, front ? L * 0.36 : -L * 0.3],
      home: [x * 0.92, 0, front ? L * 0.42 : -L * 0.34],
      lens: o.legs.columns ? [0.465 * hy, 0.44 * hy] : front ? [0.38 * hy, 0.38 * hy] : [0.4 * hy, 0.38 * hy],
      // (Columns stand straight down onto a foot: no long pastern or hock.)
      end: o.legs.columns ? { up: 0.1 * hy, back: 0.01, segment: false } : { up: endUp, back: front ? 0.02 : (o.legs.hoof ? 0.12 : 0.08) * hy, segment: true },
      // (An elephant's legs are columns.)
      radii: o.legs.columns ? [t * 1.1, t * 0.9, t * 0.5] : front ? [t * (o.legs.upper ?? 1), t * 0.6, t * 0.42] : [t * 1.3 * (o.legs.upper ?? 1), t * 0.65, t * 0.42],
      pole: [0, 0, front ? -1 : 1],
      paw,
      color: legColor,
      colors: [legColor, lower],
    };
  };
  const coat = coatColor(o.coat, o.jitter * 1.2);
  return {
    bones,
    rollY: o.withers * 0.6,
    headTilt: o.head.tilt,
    body(b, skin) {
      loft(b, smoothRings(bodyRings, 3), { sides: 14, jitter: o.jitter, seed: o.seed, color: coat, capStart: 0.5, capEnd: 0.2, skin, twist: 0.2 });
      const tc = o.tail.color ?? o.coat.back;
      loft(b, smoothRings(tailRings, 2), {
        sides: o.tail.hair || o.tail.bushy ? 9 : 7,
        jitter: o.tail.hair || o.tail.bushy ? 0.18 : 0.04,
        seed: o.seed + 7,
        color: (s, a, p) => shade(o.tail.tip && s > 0.75 ? o.tail.tip : tc, 1, p, 0.08),
        capStart: 0.2,
        capEnd: 0.6,
        skin,
      });
      if (o.mane) {
        // Hair along the top of the neck (flat-cut and upright for a donkey).
        for (let k = 1; k <= 10; k++) {
          const s = k / 11;
          const c = nk(s);
          const up: V3 = [0, Math.cos(o.neck.angle), -Math.sin(o.neck.angle)];
          const r = o.neck.thick * (1.2 - 0.4 * s);
          const base = add(c, mul(up, r * 0.9));
          const dir: V3 = o.mane.upright ? up : add(up, [0, -0.3, -0.6]);
          for (const x of [-0.03, 0.03]) cone(b, add(base, [x, 0, 0]), add(dir, [x * 4, 0, 0]), o.mane.height * (0.8 + 0.4 * hash(k + x)), 0.045, o.mane.color, 3, skin(base));
        }
      }
    },
    head: (b) => buildHead(b, o.head, o.coat, o.seed + 3),
    jawPivot: [0, -o.head.h * 0.4, o.head.len * 0.15],
    jaw(b) {
      const { len, w, h, muzzle } = o.head;
      loft(
        b,
        [
          { c: [0, -h * 0.05, -0.02], w: w * 0.7, h: h * 0.3 },
          { c: [0, -h * 0.08, len * 0.45], w: w * muzzle * 0.85, h: h * 0.25 },
          { c: [0, -h * 0.06, len * 0.82], w: w * muzzle * 0.65, h: h * 0.18 },
        ],
        { sides: 10, jitter: 0.03, seed: o.seed + 5, color: (_t, a, p) => shade(Math.sin(a) > 0 ? (o.head.muzzleColor ?? o.coat.base) : o.coat.belly, 1, p, 0.05), capStart: 0.2, capEnd: 0.4 },
      );
      blob(b, [0, h * 0.05, len * 0.45], w * muzzle * 0.6, h * 0.05, len * 0.35, new THREE.Color('#6e2a26'));
      if (o.head.fangs) for (const s of [1, -1]) cone(b, [s * w * muzzle * 0.5, h * 0.05, len * 0.75], [0, 1, 0.1], h * 0.22, w * 0.05, new THREE.Color('#f1ead8'), 4);
    },
    legs: [mkLeg('LF', true, 1), mkLeg('RF', true, -1), mkLeg('LH', false, 1), mkLeg('RH', false, -1)],
    gaits: o.gaits,
  };
}
