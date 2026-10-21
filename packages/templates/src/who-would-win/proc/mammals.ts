/** The four-legged mammals, from the quadruped generator (quad.ts). */
import { rgb } from './builder';
import { BOUND, LATERAL, ROTARY, TROT, quadruped, softPaw } from './quad';
import type { Gait } from './rig';

const HORSE_GAITS: Gait[] = [
  { from: 0, duty: 0.62, offsets: LATERAL, lift: 0.12, bob: 0.02, flex: 0.01 },
  { from: 2.5, duty: 0.45, offsets: TROT, lift: 0.18, bob: 0.04, flex: 0.02 },
  { from: 6, duty: 0.3, offsets: ROTARY, lift: 0.26, bob: 0.06, flex: 0.06 },
];
const CATTLE_GAITS: Gait[] = [
  { from: 0, duty: 0.64, offsets: LATERAL, lift: 0.1, bob: 0.025, flex: 0.01 },
  { from: 4.5, duty: 0.34, offsets: ROTARY, lift: 0.2, bob: 0.07, flex: 0.06 },
];
const DEER_GAITS: Gait[] = [
  { from: 0, duty: 0.62, offsets: LATERAL, lift: 0.14, bob: 0.02, flex: 0.01 },
  { from: 4.5, duty: 0.3, offsets: BOUND, lift: 0.3, bob: 0.08, flex: 0.1 },
];
const DOG_GAITS: Gait[] = [
  { from: 0, duty: 0.6, offsets: LATERAL, lift: 0.1, bob: 0.015, flex: 0.02 },
  { from: 1.8, duty: 0.45, offsets: TROT, lift: 0.14, bob: 0.025, flex: 0.03 },
  { from: 4.5, duty: 0.3, offsets: ROTARY, lift: 0.2, bob: 0.04, flex: 0.16 },
];

const BLACK = rgb('#15110e');
const DARK_HOOF = rgb('#2a2420');

export const HORSE = quadruped({
  seed: 31,
  withers: 1.6,
  length: 1.7,
  chest: [0.29, 0.35],
  tuck: 0.25,
  rump: 1.0,
  neck: { len: 0.8, angle: 0.85, thick: 0.15 },
  head: {
    len: 0.58,
    w: 0.115,
    h: 0.15,
    muzzle: 0.62,
    tilt: 1.0,
    ears: { len: 0.14, w: 0.035, out: 0.25, back: 0.15, color: rgb('#5e3820') },
    muzzleColor: rgb('#4a2e1c'),
    nose: BLACK,
    eye: rgb('#20140c'),
    forelock: rgb('#1d1510'),
  },
  legs: { hoof: true, thick: 0.13, hoofColor: DARK_HOOF },
  tail: { len: 0.75, thick: 0.05, droop: 1.2, hair: 0.14, color: rgb('#1d1510') },
  coat: { base: rgb('#7a4a2a'), back: rgb('#5e3820'), belly: rgb('#8a5a35'), legs: rgb('#6a3f22'), lower: rgb('#211812') },
  jitter: 0.03,
  mane: { color: rgb('#1d1510'), height: 0.16 },
  gaits: HORSE_GAITS,
});

export const UNICORN = quadruped({
  seed: 37,
  withers: 1.6,
  length: 1.7,
  chest: [0.28, 0.34],
  tuck: 0.28,
  rump: 1.0,
  neck: { len: 0.82, angle: 0.9, thick: 0.145 },
  head: {
    len: 0.56,
    w: 0.11,
    h: 0.145,
    muzzle: 0.6,
    tilt: 0.95,
    ears: { len: 0.14, w: 0.035, out: 0.25, back: 0.15, color: rgb('#e4dfee'), inner: rgb('#f2c6d8') },
    horns: 'unicorn',
    hornColor: rgb('#f0d27a'),
    muzzleColor: rgb('#e8c8d0'),
    nose: rgb('#c89aa8'),
    eye: rgb('#3a2a5a'),
    forelock: rgb('#e9d2ff'),
  },
  legs: { hoof: true, thick: 0.13, hoofColor: rgb('#d8b45a') },
  tail: { len: 0.8, thick: 0.05, droop: 1.15, hair: 0.16, color: rgb('#e9d2ff') },
  coat: { base: rgb('#ece8f2'), back: rgb('#dcd6ea'), belly: rgb('#f7f4fa'), legs: rgb('#e6e1ee') },
  jitter: 0.03,
  mane: { color: rgb('#e9d2ff'), height: 0.18 },
  gaits: HORSE_GAITS,
});

const DONKEY_COAT = { base: rgb('#8d8d92'), back: rgb('#76767c'), belly: rgb('#d9d4cc') };
export const DONKEY = quadruped({
  seed: 41,
  withers: 1.25,
  length: 1.3,
  chest: [0.25, 0.3],
  tuck: 0.15,
  rump: 1.0,
  neck: { len: 0.55, angle: 0.75, thick: 0.13 },
  head: {
    len: 0.55,
    w: 0.12,
    h: 0.15,
    muzzle: 0.72,
    tilt: 0.95,
    ears: { len: 0.32, w: 0.05, out: 0.35, back: 0.1, color: rgb('#6c6c72'), inner: rgb('#d9d4cc') },
    muzzleColor: rgb('#e2ddd4'),
    nose: rgb('#3c3a3a'),
    eye: rgb('#1a1412'),
  },
  legs: { hoof: true, thick: 0.11, hoofColor: DARK_HOOF },
  tail: { len: 0.6, thick: 0.03, droop: 1.35, color: rgb('#7a7a80'), tip: rgb('#2a2a2e') },
  coat: {
    ...DONKEY_COAT,
    lower: rgb('#9a9aa0'),
    // A dark stripe down the spine and a cross over the shoulders.
    mark: (p, a) => (Math.sin(a) > 0.93 || (p[2] > 0.36 && p[2] < 0.47 && Math.sin(a) > 0.2 && p[1] > 0.95) ? rgb('#45454a') : null),
  },
  jitter: 0.05,
  mane: { color: rgb('#3e3e42'), height: 0.09, upright: true },
  gaits: HORSE_GAITS,
});

export const BULL = quadruped({
  seed: 43,
  withers: 1.55,
  length: 1.9,
  chest: [0.4, 0.46],
  tuck: 0.05,
  rump: 0.9,
  hump: 0.35,
  neck: { len: 0.45, angle: 0.3, thick: 0.26, dewlap: 0.35 },
  head: {
    len: 0.5,
    w: 0.2,
    h: 0.2,
    muzzle: 0.85,
    tilt: 0.75,
    ears: { len: 0.14, w: 0.05, out: 1.6, back: 0.3, color: rgb('#1d1d20'), inner: rgb('#5a4a44') },
    horns: 'bull',
    hornColor: rgb('#e6dcc2'),
    muzzleColor: rgb('#3a3030'),
    nose: rgb('#241e1e'),
    eye: rgb('#120c0a'),
  },
  legs: { hoof: true, thick: 0.19, hoofColor: DARK_HOOF },
  tail: { len: 0.8, thick: 0.04, droop: 1.4, color: rgb('#1d1d20'), tip: BLACK },
  coat: { base: rgb('#2a2a2d'), back: rgb('#1e1e21'), belly: rgb('#38322f') },
  jitter: 0.04,
  gaits: CATTLE_GAITS,
});

const deerCoat = (base: string, back: string) => ({
  base: rgb(base),
  back: rgb(back),
  belly: rgb('#ece2cc'),
  // A white rump patch.
  mark: (p: [number, number, number], a: number) => (p[2] < -0.5 && Math.cos(a) * Math.cos(a) < 0.55 && Math.sin(a) > -0.6 ? rgb('#f1ebde') : null),
});

export const STAG = quadruped({
  seed: 47,
  withers: 1.3,
  length: 1.35,
  chest: [0.21, 0.3],
  tuck: 0.35,
  rump: 0.95,
  neck: { len: 0.62, angle: 0.95, thick: 0.11 },
  head: {
    len: 0.45,
    w: 0.1,
    h: 0.12,
    muzzle: 0.55,
    tilt: 0.75,
    ears: { len: 0.2, w: 0.06, out: 0.75, back: 0.25, color: rgb('#6e4e30'), inner: rgb('#e8dcc4') },
    horns: 'antlers',
    hornColor: rgb('#d8c6a4'),
    muzzleColor: rgb('#3a2a20'),
    nose: rgb('#1a1410'),
    eye: rgb('#120c08'),
  },
  legs: { hoof: true, thick: 0.095, hoofColor: DARK_HOOF },
  tail: { len: 0.18, thick: 0.05, droop: 0.9, color: rgb('#6e4e30'), tip: rgb('#f2ece2') },
  coat: deerCoat('#8a6440', '#6a4a2e'),
  jitter: 0.04,
  gaits: DEER_GAITS,
});

export const DEER = quadruped({
  seed: 53,
  withers: 1.0,
  length: 1.05,
  chest: [0.16, 0.24],
  tuck: 0.4,
  rump: 0.95,
  neck: { len: 0.5, angle: 1.0, thick: 0.08 },
  head: {
    len: 0.36,
    w: 0.08,
    h: 0.1,
    muzzle: 0.55,
    tilt: 0.7,
    ears: { len: 0.17, w: 0.055, out: 0.7, back: 0.2, color: rgb('#8a5a30'), inner: rgb('#eadcc6') },
    muzzleColor: rgb('#3a2a20'),
    nose: rgb('#1a1410'),
    eye: rgb('#120c08'),
  },
  legs: { hoof: true, thick: 0.065, hoofColor: DARK_HOOF },
  tail: { len: 0.15, thick: 0.04, droop: 0.8, color: rgb('#8a5a30'), tip: rgb('#f2ece2') },
  coat: deerCoat('#a8703c', '#8a5a30'),
  jitter: 0.03,
  gaits: DEER_GAITS,
});

export const ALPACA = quadruped({
  seed: 59,
  withers: 1.0,
  length: 1.0,
  chest: [0.25, 0.31],
  tuck: 0,
  rump: 1.0,
  neck: { len: 0.75, angle: 1.2, thick: 0.12 },
  head: {
    len: 0.26,
    w: 0.09,
    h: 0.11,
    muzzle: 0.75,
    tilt: 0.3,
    ears: { len: 0.15, w: 0.03, out: 0.15, back: -0.15, color: rgb('#dccfb4') },
    muzzleColor: rgb('#cdbb98'),
    nose: rgb('#3a2e24'),
    eye: rgb('#100a06'),
  },
  legs: { hoof: false, thick: 0.065, upper: 1.9, paw: softPaw(0.06, rgb('#3a2e24')) },
  tail: { len: 0.2, thick: 0.07, droop: 0.3, bushy: 0.03, color: rgb('#e8dcc4') },
  coat: { base: rgb('#e8dcc4'), back: rgb('#ddd0b4'), belly: rgb('#efe6d6'), legs: rgb('#e2d4b8'), lower: rgb('#cdbb98') },
  jitter: 0.14,
  gaits: [
    { from: 0, duty: 0.62, offsets: LATERAL, lift: 0.1, bob: 0.02, flex: 0.01 },
    { from: 3, duty: 0.35, offsets: ROTARY, lift: 0.2, bob: 0.05, flex: 0.05 },
  ],
});

export const WOLF = quadruped({
  seed: 61,
  withers: 0.85,
  length: 1.0,
  chest: [0.17, 0.25],
  tuck: 0.45,
  rump: 0.85,
  neck: { len: 0.3, angle: 0.5, thick: 0.12 },
  head: {
    len: 0.38,
    w: 0.11,
    h: 0.11,
    muzzle: 0.45,
    tilt: 0.25,
    ears: { len: 0.12, w: 0.045, out: 0.25, back: 0.15, color: rgb('#5d6066'), inner: rgb('#d8d0c4') },
    muzzleColor: rgb('#c8c4bc'),
    nose: BLACK,
    eye: rgb('#c8a038'),
    fangs: true,
  },
  legs: { hoof: false, thick: 0.07 },
  tail: { len: 0.55, thick: 0.05, droop: 0.95, bushy: 0.06, color: rgb('#6a6d73'), tip: rgb('#2a2a2e') },
  coat: { base: rgb('#8b8f96'), back: rgb('#5a5d63'), belly: rgb('#dcd8d0'), legs: rgb('#9a9a9e'), lower: rgb('#c8c4bc') },
  jitter: 0.1,
  gaits: DOG_GAITS,
});

const HUSKY_DARK = rgb('#363b44');
const SNOW = rgb('#f2f2f2');
export const HUSKY = quadruped({
  seed: 67,
  withers: 0.62,
  length: 0.78,
  chest: [0.15, 0.2],
  tuck: 0.3,
  rump: 0.9,
  neck: { len: 0.25, angle: 0.6, thick: 0.11 },
  head: {
    len: 0.3,
    w: 0.1,
    h: 0.1,
    muzzle: 0.5,
    tilt: 0.25,
    ears: { len: 0.1, w: 0.045, out: 0.2, back: 0.05, color: HUSKY_DARK, inner: SNOW },
    muzzleColor: SNOW,
    nose: BLACK,
    eye: rgb('#7ab8e8'),
    fangs: true,
    // The mask: white face below the eyes and a white brow.
    mark: (p, a) => (Math.sin(a) < 0.3 || p[2] > 0.18 ? SNOW : null),
  },
  legs: { hoof: false, thick: 0.06 },
  tail: { len: 0.4, thick: 0.045, droop: -0.5, bushy: 0.05, up: 0.7, color: HUSKY_DARK, tip: SNOW },
  coat: { base: rgb('#4a505a'), back: HUSKY_DARK, belly: SNOW, legs: SNOW, lower: SNOW },
  jitter: 0.1,
  gaits: DOG_GAITS,
});

export const FOX = quadruped({
  seed: 71,
  withers: 0.4,
  length: 0.55,
  chest: [0.09, 0.13],
  tuck: 0.4,
  rump: 0.9,
  neck: { len: 0.18, angle: 0.5, thick: 0.065 },
  head: {
    len: 0.2,
    w: 0.065,
    h: 0.06,
    muzzle: 0.38,
    tilt: 0.2,
    ears: { len: 0.1, w: 0.035, out: 0.2, back: 0.1, color: rgb('#2a1a12'), inner: rgb('#f2ece2') },
    muzzleColor: rgb('#e8e0d4'),
    nose: BLACK,
    eye: rgb('#d0a030'),
    fangs: true,
    mark: (_p, a) => (Math.sin(a) < -0.15 ? rgb('#f4efe6') : null),
  },
  legs: { hoof: false, thick: 0.04 },
  tail: { len: 0.45, thick: 0.04, droop: 0.5, bushy: 0.075, color: rgb('#c95b26'), tip: rgb('#f4f0ea') },
  coat: { base: rgb('#d0612a'), back: rgb('#b44f1f'), belly: rgb('#f2ece2'), legs: rgb('#7a3a1c'), lower: rgb('#1f1814') },
  jitter: 0.08,
  gaits: DOG_GAITS,
});
