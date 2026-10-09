/**
 * Deterministic math for simulation code.
 *
 * Math.sin/cos/exp/log/hypot are not guaranteed bit-identical across V8 versions (Chrome
 * ships different libm trig implementations than Node, for example), and chaotic sims amplify
 * a 1-ulp difference into a different outcome. These ports of fdlibm use only + - * / and
 * sqrt, which IEEE 754 requires to be exactly rounded, so they give the same bits everywhere.
 * Use them for anything that feeds back into physics; Math.* is fine for pure rendering.
 */

export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

const buf = new DataView(new ArrayBuffer(8));

/** Exact 2^k for integer k in the normal range. */
function pow2i(k: number): number {
  buf.setUint32(0, ((k + 1023) & 0x7ff) << 20);
  buf.setUint32(4, 0);
  return buf.getFloat64(0);
}

// --- sin / cos ---------------------------------------------------------------------------

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;
const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417;
const PIO2_1T = 6.07710050650619224932e-11;

function ksin(x: number): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + v * (S1 + z * r);
}

function kcos(x: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  return 1 - (0.5 * z - z * r);
}

/** Cody-Waite reduction; accurate for |x| up to ~1e5, far beyond what sims use. */
function reduce(x: number): [number, number] {
  const n = Math.floor(x * INV_PIO2 + 0.5);
  return [(x - n * PIO2_1) - n * PIO2_1T, n & 3];
}

export function sin(x: number): number {
  const [y, q] = reduce(x);
  return q === 0 ? ksin(y) : q === 1 ? kcos(y) : q === 2 ? -ksin(y) : -kcos(y);
}

export function cos(x: number): number {
  const [y, q] = reduce(x);
  return q === 0 ? kcos(y) : q === 1 ? -ksin(y) : q === 2 ? -kcos(y) : ksin(y);
}

// --- atan / atan2 ------------------------------------------------------------------------

const ATANHI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.11111104054623557880e-1,
  9.09088713343650656196e-2, -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2,
  4.97687799461593236017e-2, -3.65315727442169155270e-2, 1.62858201153657823623e-2,
];
const PI = 3.1415926535897931160;
const PI_LO = 1.2246467991473531772e-16;

export function atan(x: number): number {
  const sign = x < 0 ? -1 : 1;
  let ax = Math.abs(x);
  if (ax >= 7.378697629483821e19) return sign * (ATANHI[3] + ATANLO[3]);
  let id = -1;
  if (ax < 0.4375) {
    if (ax < 7.450580596923828e-9) return x;
  } else if (ax < 1.1875) {
    if (ax < 0.6875) {
      id = 0;
      ax = (2 * ax - 1) / (2 + ax);
    } else {
      id = 1;
      ax = (ax - 1) / (ax + 1);
    }
  } else if (ax < 2.4375) {
    id = 2;
    ax = (ax - 1.5) / (1 + 1.5 * ax);
  } else {
    id = 3;
    ax = -1 / ax;
  }
  const z = ax * ax;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return sign * (ax - ax * (s1 + s2));
  return sign * (ATANHI[id] - (ax * (s1 + s2) - ATANLO[id] - ax));
}

export function atan2(y: number, x: number): number {
  if (x === 0) return y > 0 ? PI / 2 : y < 0 ? -PI / 2 : 0;
  if (y === 0) return x > 0 ? 0 : PI;
  const z = atan(Math.abs(y / x));
  if (x > 0) return y > 0 ? z : -z;
  return y > 0 ? PI - (z - PI_LO) : z - PI_LO - PI;
}

export function asin(x: number): number {
  return atan2(x, Math.sqrt(1 - x * x));
}

// --- exp / log / pow ---------------------------------------------------------------------

const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;

export function exp(x: number): number {
  if (x > 709.78) return Infinity;
  if (x < -708) return 0;
  const k = Math.floor(x * INV_LN2 + 0.5);
  const hi = x - k * LN2_HI;
  const lo = k * LN2_LO;
  const r = hi - lo;
  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  const y = 1 - (lo - (r * c) / (2 - c) - hi);
  return y * pow2i(k);
}

const LG = [6.666666666666735130e-1, 3.999999999940941908e-1, 2.857142874366239149e-1, 2.222219843214978396e-1, 1.818357216161805012e-1, 1.531383769920937332e-1, 1.479819860511658591e-1];

export function log(x: number): number {
  if (x <= 0) return x === 0 ? -Infinity : NaN;
  if (!Number.isFinite(x)) return x;
  // Split x = m * 2^k with m in [sqrt(2)/2, sqrt(2)).
  buf.setFloat64(0, x);
  let hiWord = buf.getUint32(0);
  let k = 0;
  if (hiWord < 0x00100000) {
    // Subnormal: scale up first.
    buf.setFloat64(0, x * 18014398509481984);
    hiWord = buf.getUint32(0);
    k = -54;
  }
  k += (hiWord >>> 20) - 1023;
  buf.setUint32(0, (hiWord & 0x000fffff) | 0x3ff00000);
  let m = buf.getFloat64(0);
  if (m > Math.SQRT2) {
    m /= 2;
    k++;
  }
  const f = m - 1;
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG[1] + w * (LG[3] + w * LG[5]));
  const t2 = z * (LG[0] + w * (LG[2] + w * (LG[4] + w * LG[6])));
  const R = t2 + t1;
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - (hfsq - (s * (hfsq + R) + k * LN2_LO) - f);
}

/** x^y for x > 0. */
export function pow(x: number, y: number): number {
  return exp(y * log(x));
}
