/**
 * Space Drop's picture: three scenes drawn over one another, each at its own scale so depth stays
 * precise from orbit to a penny on the sand.
 *
 * - far (kilometres): the sky (black in space, blue low down), stars, the Earth and its glowing limb.
 * - mid (metres, around the landing site): the ground, a patch whose rings get finer toward the
 *   centre so a 7 cm dent and a 200 m crater both show; clouds; smoke trails; the impact (flash,
 *   fireball, flying ejecta, a dust surge, the crater digging itself out).
 * - near (metres, around the object): the object, its glow where the air hits it, the plasma bow
 *   and wake, sparks of molten surface, and debris when it breaks up.
 *
 * Everything is placed in the landing site's frame (x downrange, y up) from the precomputed fall,
 * then shifted so the camera sits at the origin. Rendering only: nothing here touches the sim.
 */
import type { RenderCtx, Rng } from '@sim/engine';
import { THREE, draw3DLayers, sceneCache, studioEnvironment } from '../three-layer';
import { HASH, NOISE4 } from '../ambient/glsl';
import { markAt, type AnyDirector } from '../story';
import { R_EARTH, OMEGA } from './atmosphere';
import { buildModel, debrisGeometry } from './models';
import { sizeOf, type Shape } from './objects';
import { sampleAt, type Sample } from './physics';
import { REPLAY, endTime, type Run } from './script';
import { Wreck, relativeTo, type WreckImpact } from './wreck';
import { simTimeAtVideo, type SpaceDropState } from './index';

const V = () => new THREE.Vector3();

/**
 * How a render looks, apart from the physics: from the seed's visual-only randomness, so two seeds
 * of the same drop show different landings, wrecks, terrain and light with identical numbers.
 */
export interface Look {
  /** Direction to the sun in the landing site's frame. */
  sun: [number, number, number];
  runs: {
    /** Seeds the terrain, clouds, debris and wreck. */
    seed: number;
    /** Where its tumble starts, and how far off broadside-on it lands (rad). */
    tumblePhase: number;
    landTilt: number;
    /** Where the camera's slow swing starts. */
    camPhase: number;
  }[];
}

/** Sun heights (degrees) for the settings that fix one. */
const SUN_HEIGHT = { low: 12, mid: 35, high: 62 } as const;

export function makeLook(rng: Rng, sun: 'auto' | keyof typeof SUN_HEIGHT, n: number): Look {
  const r = rng.fork(0x51d);
  const elev = (sun === 'auto' ? r.range(14, 62) : SUN_HEIGHT[sun]) * (Math.PI / 180);
  // From behind the camera and off to a side: never straight into the lens.
  const az = (-34 + r.range(-70, 70)) * (Math.PI / 180);
  return {
    sun: [Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az)],
    runs: Array.from({ length: n }, () => ({ seed: r.int(1, 999_999), tumblePhase: r.range(0, Math.PI * 2), landTilt: r.range(-0.55, 0.55), camPhase: r.range(0, Math.PI * 2) })),
  };
}

/** A small offset for noise seeds from a big seed. */
const noiseSeed = (seed: number, salt: number) => ((seed * 7 + salt * 13) % 97) * 1.37 + salt;

// ---------------------------------------------------------------------------------------------
// Colour helpers

/** Approximate colour of a glowing body at T kelvin (sRGB 0..1). */
export function blackbody(T: number, out = new THREE.Color()): THREE.Color {
  const t = Math.max(1000, Math.min(40000, T)) / 100;
  const r = t <= 66 ? 1 : Math.min(1, 1.2929 * (t - 60) ** -0.1332);
  const g = t <= 66 ? Math.max(0, Math.min(1, 0.39 * Math.log(t) - 0.6318)) : Math.min(1, 1.1298 * (t - 60) ** -0.0755);
  const b = t >= 66 ? 1 : t <= 19 ? 0 : Math.max(0, Math.min(1, 0.5432 * Math.log(t - 10) - 1.1962));
  return out.setRGB(r, g, b, THREE.SRGBColorSpace);
}

/** How brightly a surface at T kelvin glows (HDR multiplier; dull red at ~800 K). */
const glowOf = (T: number) => Math.min(3.5, Math.max(0, (T - 760) / 1400) ** 2 * 1.1);

/** Plasma brightness from the heat flux at the nose (W/m²). */
const plasmaOf = (heat: number) => Math.max(0, Math.min(1.7, (Math.log10(Math.max(1, heat)) - 4.4) / 3));

const smooth = (a: number, b: number, x: number) => {
  const u = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

// ---------------------------------------------------------------------------------------------
// Shaders

const NOISE = NOISE4 + HASH;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uUp;
uniform vec3 uSun;
uniform float uAlt;
void main() {
  vec3 d = normalize(vDir);
  float e = dot(d, uUp);
  float R = 6371000.0;
  float k = R / (R + max(uAlt, 1.0));
  float dip = -sqrt(max(0.0, 1.0 - k * k));
  float dens = exp(-uAlt / 8000.0);
  float thin = exp(-uAlt / 30000.0);
  float above = clamp((e - dip) / max(0.03, 1.0 - dip), 0.0, 1.0);
  vec3 zenith = pow(vec3(0.22, 0.42, 0.85), vec3(2.2)) * pow(dens, 0.45) * 1.1;
  vec3 horizon = mix(pow(vec3(0.05, 0.1, 0.22), vec3(2.2)) * 0.6, pow(vec3(0.68, 0.79, 0.93), vec3(2.2)), pow(thin, 0.6));
  vec3 col = mix(horizon, zenith, pow(above, 0.5));
  // The thin blue line of the atmosphere, seen edge-on from high up.
  col += pow(vec3(0.35, 0.6, 1.0), vec3(2.2)) * exp(-abs(e - dip) * 90.0) * (1.0 - dens) * 0.9;
  float sd = max(dot(d, uSun), 0.0);
  col += vec3(1.0, 0.92, 0.8) * (pow(sd, 3000.0) * 60.0 + pow(sd, 60.0) * (0.08 + 0.4 * dens));
  gl_FragColor = vec4(col, 1.0);
}`;

const STAR_VERT = /* glsl */ `
attribute float aSize;
uniform float uVis;
varying float vA;
void main() {
  vA = uVis * (0.4 + 0.6 * aSize);
  gl_PointSize = 1.2 + 2.2 * aSize;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;
const STAR_FRAG = /* glsl */ `
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c)) * vA;
  gl_FragColor = vec4(vec3(0.9, 0.93, 1.0) * a, 1.0);
}`;

const EARTH_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vP;
varying vec3 vWorld;
void main() {
  vP = normalize(position);
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const EARTH_FRAG = /* glsl */ `
${NOISE}
varying vec3 vN;
varying vec3 vP;
varying vec3 vWorld;
uniform vec3 uSun;
uniform float uType;
uniform float uTime;
uniform float uSeed;
float fbm(vec3 p, int oct) { float s = 0.0, a = 0.5, n = 0.0; for (int i = 0; i < 7; i++) { if (i >= oct) break; s += a * snoise(vec4(p, uSeed)); n += a; p = p * 2.07 + 11.3; a *= 0.5; } return s / n; }
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
void main() {
  vec3 p = vP;
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vWorld);
  // The landing site is at +y; Earth's axis along z (it lands at the equator).
  float site = dot(p, vec3(0.0, 1.0, 0.0));
  float lat = abs(p.z);
  float h = fbm(p * 2.2, 7) + 0.55 * smoothstep(0.96, 0.995, site) - 0.04;
  float detail = fbm(p * 18.0 + 3.0, 5);
  float moist = fbm(p * 1.7 + 7.0, 4) * 0.5 + 0.5;
  // Land colours: near the site, its ground; elsewhere by moisture.
  vec3 desert = lin(vec3(0.78, 0.6, 0.38)), green = lin(vec3(0.22, 0.32, 0.12)), farm = lin(vec3(0.42, 0.44, 0.22)), rock = lin(vec3(0.46, 0.42, 0.38));
  vec3 land = mix(green, desert, smoothstep(0.55, 0.3, moist + detail * 0.15));
  land = mix(land, rock, smoothstep(0.25, 0.5, h + detail * 0.1));
  vec3 here = uType < 0.5 ? desert : uType < 1.5 ? farm : rock;
  land = mix(land, here, smoothstep(0.93, 0.99, site));
  land *= 0.85 + 0.3 * detail;
  vec3 sea = mix(lin(vec3(0.02, 0.07, 0.2)), lin(vec3(0.05, 0.22, 0.33)), smoothstep(-0.08, 0.0, h));
  float shore = smoothstep(-0.005, 0.005, h);
  vec3 col = mix(sea, land, shore);
  float ocean = 1.0 - shore;
  float cap = smoothstep(0.8, 0.9, lat + detail * 0.05);
  col = mix(col, vec3(0.85, 0.9, 0.95), cap);
  // Clouds, drifting slowly; thinner over a desert site.
  float c = fbm(p * 4.0 + vec3(uTime * 0.0004, 0.0, 0.0), 6) + fbm(p * 15.0, 4) * 0.35;
  float cover = 0.45 + 0.2 * float(uType > 0.5) - 0.4 * smoothstep(0.97, 0.995, site) * float(uType < 0.5);
  float cloud = smoothstep(0.6 - 0.22 * cover, 0.78 - 0.22 * cover, c * 0.5 + 0.5);
  col = mix(col, vec3(0.92), cloud * 0.9);
  float ndl = dot(n, uSun);
  float day = smoothstep(-0.1, 0.2, ndl);
  vec3 lit = col * (0.003 + 1.15 * max(ndl, 0.0) * day);
  vec3 hv = normalize(uSun + v);
  lit += vec3(1.0, 0.9, 0.75) * pow(max(dot(n, hv), 0.0), 120.0) * ocean * (1.0 - cloud) * day * 1.4;
  lit *= mix(vec3(1.0, 0.55, 0.35), vec3(1.0), smoothstep(-0.02, 0.3, ndl));
  float rim = pow(1.0 - max(dot(n, v), 0.0), 5.0);
  lit = mix(lit, lin(vec3(0.4, 0.6, 0.98)) * day, clamp(rim * 0.6 + 0.08, 0.0, 1.0) * day);
  gl_FragColor = vec4(lit, 1.0);
}`;

const ATMOS_FRAG = /* glsl */ `
varying vec3 vWorld;
uniform vec3 uSun;
uniform vec3 uCenter;
uniform float uR;
uniform float uFade;
void main() {
  vec3 ray = normalize(vWorld - cameraPosition);
  vec3 oc = uCenter - cameraPosition;
  float along = max(0.0, dot(oc, ray));
  float h = length(oc - ray * along);
  float H = uR * 0.011;
  float glow = h > uR ? exp(-(h - uR) / H) : exp(-(uR - h) / (H * 0.4));
  vec3 p = normalize(cameraPosition + ray * along - uCenter);
  float ndl = dot(p, uSun);
  float day = smoothstep(-0.25, 0.3, ndl);
  vec3 sunset = vec3(1.0, 0.42, 0.18) * smoothstep(0.3, 0.0, abs(ndl + 0.05)) * 0.6;
  gl_FragColor = vec4((vec3(0.18, 0.4, 1.0) * day + sunset) * glow * 1.4 * uFade, 1.0);
}`;

/** Ground height around the site (m): hills that flatten near the impact, the crater, Earth's curve. */
const GROUND_COMMON = /* glsl */ `
${NOISE}
uniform float uType;
uniform float uSeed;
uniform float uFlat;
uniform float uCr;
uniform float uCd;
uniform float uRim;
float fbm2(vec2 q, int oct) { float s = 0.0, a = 0.5, n = 0.0; for (int i = 0; i < 5; i++) { if (i >= oct) break; s += a * snoise(vec4(q, uSeed, 0.5)); n += a; q = q * 2.03 + 7.7; a *= 0.5; } return s / n; }
float hills(vec2 q) {
  if (uType < 0.5) {
    float n = snoise(vec4(q * 0.0003, uSeed, 0.0));
    float ridge = 1.0 - abs(sin((q.x * 0.8 + q.y * 0.6) * 0.0045 + n * 3.0));
    float small = 1.0 - abs(sin((q.x * 0.7 - q.y * 0.7) * 0.03 + n * 5.0));
    return 45.0 * ridge * ridge + 3.0 * small * small + 60.0 * snoise(vec4(q * 0.00007, uSeed + 1.0, 0.0));
  }
  if (uType < 1.5) return 22.0 * snoise(vec4(q * 0.0001, uSeed, 0.0)) + 5.0 * snoise(vec4(q * 0.0007, uSeed + 2.0, 0.0));
  return 260.0 * fbm2(q * 0.00004, 4) + 30.0 * fbm2(q * 0.0004, 3);
}
float craterH(float r) {
  if (uCr <= 0.0) return 0.0;
  float x = r / uCr;
  if (x < 1.0) return -uCd * (1.0 - x * x) + uRim * pow(x, 5.0);
  return uRim * pow(x, -3.0);
}
float heightAt(vec2 q) {
  float r = length(q);
  return hills(q) * smoothstep(uFlat, uFlat * 6.0, r) + craterH(r) - r * r / 12742000.0;
}`;

const GROUND_VERT = /* glsl */ `
${GROUND_COMMON}
uniform vec3 uCam;
varying vec3 vLocal;
varying vec3 vN;
varying float vDist;
void main() {
  vec2 q = position.xz;
  float h = heightAt(q);
  float e = max(0.0005, length(q) * 0.02);
  float hx = heightAt(q + vec2(e, 0.0));
  float hz = heightAt(q + vec2(0.0, e));
  vN = normalize(vec3(-(hx - h) / e, 1.0, -(hz - h) / e));
  vLocal = vec3(q.x, h, q.y);
  vec3 world = vLocal - uCam;
  vDist = length(world);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const GROUND_FRAG = /* glsl */ `
${GROUND_COMMON}
uniform vec3 uSun;
uniform vec3 uFogCol;
uniform float uFogDist;
uniform float uRMax;
uniform float uCrFinal;
uniform float uEject;
uniform float uMelt;
uniform vec3 uMeltCol;
uniform float uCrust;
uniform float uScorch;
uniform vec3 uGlowPos;
uniform vec3 uGlowCol;
uniform vec4 uScar;
uniform float uScarW;
uniform vec4 uGouge[4];
varying vec3 vLocal;
varying vec3 vN;
varying float vDist;
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
void main() {
  vec2 q = vLocal.xz;
  float r = length(q);
  vec3 c0, c1, c2;
  if (uType < 0.5) { c0 = lin(vec3(0.8, 0.63, 0.43)); c1 = lin(vec3(0.9, 0.76, 0.55)); c2 = lin(vec3(0.62, 0.46, 0.31)); }
  else if (uType < 1.5) { c0 = lin(vec3(0.3, 0.38, 0.16)); c1 = lin(vec3(0.5, 0.46, 0.24)); c2 = lin(vec3(0.36, 0.27, 0.17)); }
  else { c0 = lin(vec3(0.48, 0.45, 0.42)); c1 = lin(vec3(0.63, 0.6, 0.56)); c2 = lin(vec3(0.3, 0.28, 0.27)); }
  // Detail at whatever scale the pixel covers: two octaves around it, blended so no seam shows.
  float L = log2(max(vDist, 0.002)) - 2.0;
  float f0 = floor(L);
  float fr = L - f0;
  float s0 = exp2(-f0);
  float n1 = snoise(vec4(q * s0, uSeed, 1.0 + f0 * 0.37));
  float n2 = snoise(vec4(q * s0 * 0.5, uSeed, 1.0 + (f0 + 1.0) * 0.37));
  float n = mix(n1, n2, fr);
  float big = snoise(vec4(q * 0.00012, uSeed, 3.0)) + 0.5 * snoise(vec4(q * 0.0009, uSeed, 4.0)) + 0.25 * snoise(vec4(q * 0.006, uSeed, 6.0));
  vec3 col = mix(c0, c1, smoothstep(-0.8, 0.8, big));
  // Darker patches (gravel plains, scrub, rock) at a few kilometres.
  col = mix(col, c2, smoothstep(0.35, 0.75, snoise(vec4(q * 0.00035, uSeed, 8.0))) * 0.5);
  col = mix(col, c2, smoothstep(0.1, 0.9, n) * 0.45);
  col *= 0.88 + 0.14 * n;
  // A road or two near the site, and scattered scrub: something to judge the scale by.
  float road = min(abs(dot(q, vec2(0.83, 0.56)) - 1800.0), abs(dot(q, vec2(-0.3, 0.95)) + 2600.0 + 40.0 * sin(q.x * 0.002)));
  float roadW = 4.0 + vDist * 0.0006;
  col = mix(col, lin(vec3(0.17, 0.17, 0.18)), (1.0 - smoothstep(roadW, roadW * 1.6, road)) * smoothstep(60000.0, 20000.0, r) * 0.9);
  float scrub = smoothstep(0.72, 0.8, snoise(vec4(q * 0.08, uSeed, 12.0))) * smoothstep(200.0, 40.0, vDist) * float(uType < 1.5);
  col = mix(col, lin(vec3(0.22, 0.24, 0.12)), scrub * 0.7);
  if (uType > 0.5 && uType < 1.5) {
    vec2 cell = floor(q / 280.0);
    float hh = hash12(cell + uSeed);
    vec3 field = mix(lin(vec3(0.62, 0.55, 0.28)), lin(vec3(0.2, 0.34, 0.11)), hh);
    col = mix(col, field, 0.55 * smoothstep(uFlat * 3.0, uFlat * 8.0, r));
  }
  if (uCrFinal > 0.0) {
    float x = r / uCrFinal;
    float inside = 1.0 - smoothstep(0.8, 1.05, x);
    col = mix(col, col * vec3(0.62, 0.58, 0.55), inside * uEject);
    float ang = atan(q.y, q.x);
    float rays = 0.5 + 0.5 * sin(ang * 19.0 + snoise(vec4(q / uCrFinal * 0.8, 5.0, 0.0)) * 4.0);
    float blanket = smoothstep(4.0, 1.0, x) * (1.0 - inside);
    col = mix(col, col * mix(0.72, 1.18, rays), blanket * uEject);
    col = mix(col, col * 0.25, uScorch * smoothstep(2.5, 0.6, x));
    // Crusting over as it cools, until only the cracks between the plates glow.
    float crack = 1.0 - abs(snoise(vec4(q / uCrFinal * 4.0, 9.0, 0.0)));
    float crust = smoothstep(1.0 - uCrust - 0.05, 1.0 - uCrust + 0.05, crack);
    col += uMeltCol * uMelt * inside * (0.55 + 0.45 * n) * 1.3 * crust;
  }
  // Scraped where a wreck slid or toppled, gouged where heavy parts first hit.
  if (uScarW > 0.0) {
    vec2 sa = uScar.xy;
    vec2 sb = uScar.zw - sa;
    float h = clamp(dot(q - sa, sb) / max(dot(sb, sb), 1e-6), 0.0, 1.0);
    float d = length(q - sa - sb * h);
    col = mix(col, col * vec3(0.58, 0.53, 0.48), (1.0 - smoothstep(uScarW * 0.35, uScarW * 0.5, d)) * (0.75 + 0.25 * n));
  }
  for (int i = 0; i < 4; i++) {
    vec4 g = uGouge[i];
    if (g.w <= 0.0) continue;
    float d = length(q - g.xy) / g.z;
    col = mix(col, col * 0.5, (1.0 - smoothstep(0.55, 1.0, d)) * g.w);
    col = mix(col, col * 1.12, smoothstep(0.85, 1.0, d) * (1.0 - smoothstep(1.0, 1.4, d)) * g.w);
  }
  // Small bumps at the pixel's scale, for texture in the light (two octaves, blended like the colour).
  vec2 bump = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    float bs = s0 * (k == 0 ? 0.7 : 0.35);
    float w = 9.0 + (f0 + float(k)) * 0.37;
    float b0 = snoise(vec4(q * bs, uSeed, w));
    float bx = snoise(vec4((q + vec2(0.3 / bs, 0.0)) * bs, uSeed, w));
    float bz = snoise(vec4((q + vec2(0.0, 0.3 / bs)) * bs, uSeed, w));
    bump += vec2(b0 - bx, b0 - bz) * (k == 0 ? 1.0 - fr : fr);
  }
  vec3 nrm = normalize(normalize(vN) + vec3(bump.x, 0.0, bump.y) * 0.6);
  float ndl = max(dot(nrm, uSun), 0.0);
  vec3 lit = col * (ndl * vec3(1.0, 0.95, 0.88) * 1.3 + lin(vec3(0.55, 0.62, 0.75)) * 0.5 * (0.55 + 0.45 * nrm.y));
  // Light from the glowing object or fireball overhead.
  vec3 gd = uGlowPos - vLocal;
  float gl = dot(gd, gd);
  lit += col * uGlowCol * max(dot(nrm, normalize(gd)), 0.0) / (1.0 + gl);
  float fog = 1.0 - exp(-vDist / uFogDist);
  lit = mix(lit, uFogCol, clamp(fog, 0.0, 1.0));
  float alpha = 1.0 - smoothstep(uRMax * 0.5, uRMax, r);
  gl_FragColor = vec4(lit, alpha);
}`;

const CLOUD_VERT = /* glsl */ `
uniform vec3 uCam;
uniform float uH;
varying vec2 vQ;
varying float vDist;
void main() {
  vQ = position.xz;
  float r = length(vQ);
  vec3 world = vec3(vQ.x, uH - r * r / 12742000.0, vQ.y) - uCam;
  vDist = length(world);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;
const CLOUD_FRAG = /* glsl */ `
${NOISE}
uniform float uCover;
uniform float uSeed;
uniform float uNear;
uniform vec3 uSun;
uniform vec3 uFogCol;
uniform float uFogDist;
varying vec2 vQ;
varying float vDist;
void main() {
  vec2 q = vQ * 0.00012;
  float c = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { c += a * snoise(vec4(q, uSeed, 7.0)); q = q * 2.1 + 3.1; a *= 0.5; }
  float d = smoothstep(0.55 - uCover, 0.95 - uCover, c * 0.5 + 0.5);
  float edge = 1.0 - smoothstep(60000.0, 110000.0, length(vQ));
  float alpha = d * edge * uNear * 0.92;
  vec3 col = vec3(0.95) * (0.7 + 0.35 * max(uSun.y, 0.0)) - 0.25 * d * d;
  col = mix(col, uFogCol, clamp(1.0 - exp(-vDist / uFogDist), 0.0, 1.0));
  gl_FragColor = vec4(col, alpha);
}`;

/** The plasma bow ahead of the object: a rim-lit, flickering shell in its own frame (+x = flight direction). */
const PLASMA_VERT = /* glsl */ `
varying vec3 vL;
varying vec3 vN;
varying vec3 vV;
void main() {
  vL = position;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const PLASMA_FRAG = /* glsl */ `
${NOISE}
uniform float uLevel;
uniform vec3 uColor;
uniform float uTime;
varying vec3 vL;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 p = normalize(vL);
  float front = smoothstep(-0.35, 0.95, p.x);
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.4);
  float flick = 0.75 + 0.25 * snoise(vec4(p * 3.0, uTime * 3.0));
  float a = front * (0.3 + 1.4 * rim) * flick * uLevel;
  gl_FragColor = vec4(uColor * a * 3.0, 1.0);
}`;

/** The wake: a long cone streaming back from the object (−x), streaked and flickering. */
const WAKE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const WAKE_FRAG = /* glsl */ `
${NOISE}
uniform float uLevel;
uniform vec3 uHot;
uniform vec3 uCool;
uniform float uTime;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  float u = vUv.y;
  float streak = snoise(vec4(vUv.x * 7.0, u * 5.0 - uTime * 9.0, uTime * 0.7, 0.0)) * 0.5 + 0.5;
  // Brightest along the middle of the column, soft at its edges.
  float face = pow(abs(dot(normalize(vN), normalize(vV))), 2.5);
  float a = pow(1.0 - u, 2.2) * (0.45 + 0.55 * streak) * uLevel * face;
  vec3 c = mix(uHot, uCool, smoothstep(0.0, 0.5, u));
  gl_FragColor = vec4(c * a * 1.4, 1.0);
}`;

/** Points that move by formula: sparks streaming off the object, impact dust, stars. */
const SPARK_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uLen;
uniform float uSize;
uniform float uLevel;
varying float vA;
varying float vHeat;
void main() {
  float life = fract(uTime * (0.6 + aSeed.w) + aSeed.x);
  vec3 side = normalize(vec3(0.0, aSeed.y - 0.5, aSeed.z - 0.5));
  vec3 pos = vec3(-life * uLen * (0.4 + aSeed.w), 0.0, 0.0) + side * (0.3 + life * 1.2) * uSize * 4.0;
  vHeat = 1.0 - life;
  vA = uLevel * (1.0 - life) * step(0.05, uLevel);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = clamp(uSize * 900.0 / -mv.z, 1.5, 22.0);
  gl_Position = projectionMatrix * mv;
}`;
const SPARK_FRAG = /* glsl */ `
varying float vA;
varying float vHeat;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.05, length(c)) * vA;
  vec3 col = mix(vec3(1.0, 0.25, 0.05), vec3(1.0, 0.85, 0.5), vHeat);
  gl_FragColor = vec4(col * a * 3.0, 1.0);
}`;

/** Dust thrown up by the impact: a ground-hugging surge ring and a rising plume, in physical time. */
const DUST_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uPsi;
uniform float uR;
uniform float uSpeed;
varying float vA;
varying float vShade;
void main() {
  float ang = aSeed.x * 6.2831853;
  float plume = step(0.62, aSeed.y);
  float tau = uPsi / max(0.05, uR / uSpeed);
  float grow = 1.0 - exp(-tau * (0.6 + aSeed.z));
  float rad = plume > 0.5 ? uR * (0.2 + 0.9 * aSeed.z) * (0.3 + grow) : uR * (0.7 + 4.5 * grow * (0.5 + aSeed.z));
  float up = plume > 0.5 ? uR * (0.3 + 3.5 * grow * aSeed.w) : uR * (0.1 + 0.6 * grow * aSeed.w);
  vec3 pos = vec3(cos(ang) * rad, up, sin(ang) * rad);
  float size = uR * (0.35 + 0.9 * grow) * (0.6 + aSeed.w);
  vA = smoothstep(0.0, 0.08, uPsi) * exp(-uPsi / max(0.5, 4.0 * uR / uSpeed)) * 0.2;
  vShade = 0.65 + 0.35 * aSeed.w;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = clamp(size * 1100.0 / -mv.z, 1.0, 380.0);
  gl_Position = projectionMatrix * mv;
}`;
const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
varying float vShade;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c)) * vA;
  gl_FragColor = vec4(uColor * vShade * 1.7, a);
}`;

/**
 * The ejecta curtain: an inverted cone of dirt thrown out of a growing crater, standing on its rim
 * (a unit open cylinder: y 0..1 is stretched to uH, the radius widened from uRb at the rim to uRt).
 */
const CURTAIN_VERT = /* glsl */ `
uniform float uRb;
uniform float uRt;
uniform float uH;
varying vec3 vP;
varying float vY;
void main() {
  vY = position.y;
  float rad = mix(uRb, uRt, position.y);
  vec3 p = vec3(position.x * rad, position.y * uH, position.z * rad);
  vP = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const CURTAIN_FRAG = /* glsl */ `
${NOISE}
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying vec3 vP;
varying float vY;
void main() {
  float ang = atan(vP.z, vP.x);
  // Streaky: rays of thrown dirt, ragged at the top.
  float rays = snoise(vec4(cos(ang) * 6.0, sin(ang) * 6.0, vY * 2.0, uTime * 0.3)) * 0.5 + 0.5;
  float a = uAlpha * pow(1.0 - vY, 0.8) * smoothstep(0.15, 0.7, rays + 0.25 * (1.0 - vY));
  gl_FragColor = vec4(uColor * (0.55 + 0.45 * rays), a);
}`;

/** The shock wave's dust: a low wall of it racing out over the ground (a unit open cylinder). */
const SKIRT_FRAG = /* glsl */ `
${NOISE}
uniform vec3 uColor;
uniform float uAlpha;
varying vec3 vP;
varying float vY;
void main() {
  float ang = atan(vP.z, vP.x);
  float n = snoise(vec4(cos(ang) * 9.0, sin(ang) * 9.0, vY * 3.0, 1.0)) * 0.5 + 0.5;
  gl_FragColor = vec4(uColor * (0.7 + 0.3 * n), uAlpha * pow(1.0 - vY, 1.6) * (0.5 + 0.5 * n));
}`;

/** A condensation dome: the shock front, seen only at its edges. */
const DOME_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const DOME_FRAG = /* glsl */ `
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
void main() {
  float edge = pow(1.0 - abs(dot(vN, vV)), 3.0);
  gl_FragColor = vec4(vec3(1.0), uAlpha * edge);
}`;

/** A rising column for the biggest impacts: a stem of dust under a billowing cap. */
const COLUMN_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uPsi;
uniform float uH;
uniform float uR;
varying float vA;
varying float vShade;
void main() {
  float hc = uH * (1.0 - exp(-uPsi / 3.0));
  float rc = uR * (0.35 + 0.65 * (1.0 - exp(-uPsi / 2.5)));
  vec3 pos;
  float size;
  if (aSeed.y < 0.4) {
    float f = aSeed.x;
    float a = aSeed.z * 6.2831853;
    float rs = rc * 0.3 * (0.55 + 0.45 * f) * sqrt(aSeed.w);
    pos = vec3(cos(a) * rs, hc * f, sin(a) * rs);
    size = rc * 0.3;
  } else {
    vec3 d = normalize(vec3(aSeed.x - 0.5, aSeed.z - 0.45, aSeed.w - 0.5) + 1e-4);
    pos = vec3(d.x * rc, hc + d.y * rc * 0.55, d.z * rc) * (0.7 + 0.3 * aSeed.y);
    size = rc * 0.45;
  }
  size *= 0.6 + 0.8 * aSeed.w;
  vA = smoothstep(0.0, 0.4, uPsi) * (1.0 - smoothstep(9.0, 26.0, uPsi)) * 0.2;
  vShade = 0.5 + 0.3 * aSeed.y;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = clamp(size * 1100.0 / -mv.z, 1.0, 380.0);
  gl_Position = projectionMatrix * mv;
}`;

/** Smoke from a wrecked engine bay: puffs leave the source, rise, spread and drift on the wind. */
const SMOKE_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uPsi;
uniform vec3 uSrc;
uniform vec3 uWind;
uniform float uSize;
varying float vA;
varying float vShade;
void main() {
  float life = 9.0;
  float age = mod(uPsi + aSeed.x * life, life);
  float on = step(age, uPsi);
  vec3 pos = uSrc + vec3(aSeed.y - 0.5, 0.0, aSeed.z - 0.5) * uSize * (0.15 + 0.05 * age)
    + vec3(0.0, uSize * (0.22 * age + 0.015 * age * age), 0.0) + uWind * age;
  float size = uSize * (0.12 + 0.1 * age) * (0.7 + 0.6 * aSeed.w);
  vA = on * smoothstep(0.0, 0.5, age) * (1.0 - smoothstep(life * 0.45, life, age)) * smoothstep(0.0, 1.5, uPsi) * 0.3;
  vShade = 0.22 + 0.2 * aSeed.w;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = clamp(size * 1100.0 / -mv.z, 1.0, 380.0);
  gl_Position = projectionMatrix * mv;
}`;

/** A ball of fire (or of glowing dust in an airburst), boiling, cooling from white to dark smoke. */
const FIRE_FRAG = /* glsl */ `
${NOISE}
uniform float uHeat;
uniform float uTime;
uniform float uAlpha;
varying vec3 vL;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 p = normalize(vL);
  float n = snoise(vec4(p * 2.5 + 1.0, uTime * 0.8)) * 0.5 + 0.5;
  float rim = abs(dot(normalize(vN), normalize(vV)));
  float h = uHeat * (0.6 + 0.6 * n) * (0.4 + 0.6 * rim);
  vec3 hot = mix(vec3(0.9, 0.2, 0.02), vec3(1.0, 0.85, 0.55), smoothstep(0.4, 1.2, h));
  vec3 smoke = vec3(0.09, 0.08, 0.075) * (0.6 + 0.6 * n);
  vec3 col = mix(smoke, hot * (1.0 + 3.0 * h), smoothstep(0.05, 0.4, h));
  gl_FragColor = vec4(col, uAlpha * smoothstep(0.0, 0.5, rim + 0.3));
}`;

/** A smoke trail left in the air along the path, widening and fading with age. */
const TRAIL_VERT = /* glsl */ `
attribute vec3 aTangent;
attribute float aSide;
attribute float aT;
attribute float aWarm;
uniform vec3 uCam;
uniform float uSimT;
uniform float uW0;
uniform float uClear;
varying float vA;
varying float vWarm;
void main() {
  float age = uSimT - aT;
  vec3 world = position - uCam;
  vec3 side = normalize(cross(aTangent, normalize(world)));
  float w = uW0 + max(age, 0.0) * 1.2;
  world += side * aSide * w;
  vA = step(0.0, age) * exp(-max(age, 0.0) / 240.0) * smoothstep(0.0, 1.5, age + 0.6);
  // The blast clears the smoke over the impact site.
  vA *= smoothstep(uClear, uClear * 3.0, length(position));
  vWarm = aWarm * exp(-max(age, 0.0) / 1.5);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;
const TRAIL_FRAG = /* glsl */ `
uniform vec3 uSmoke;
varying float vA;
varying float vWarm;
void main() {
  vec3 col = mix(uSmoke, vec3(1.0, 0.5, 0.15) * 3.0, clamp(vWarm, 0.0, 1.0));
  gl_FragColor = vec4(col, vA * 0.22);
}`;

// ---------------------------------------------------------------------------------------------
// Building blocks

/** A ground patch: rings from `r0` to `rMax`, each 6% wider than the last, so detail is even on screen. */
function patchGeometry(r0: number, rMax: number): THREE.BufferGeometry {
  const seg = 160;
  const rings: number[] = [0];
  for (let r = r0; r < rMax; r *= 1.06) rings.push(r);
  rings.push(rMax);
  const pos: number[] = [];
  const idx: number[] = [];
  pos.push(0, 0, 0);
  for (let i = 1; i < rings.length; i++)
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * rings[i], 0, Math.sin(a) * rings[i]);
    }
  for (let j = 0; j < seg; j++) idx.push(0, 1 + ((j + 1) % seg), 1 + j);
  for (let i = 1; i < rings.length - 1; i++)
    for (let j = 0; j < seg; j++) {
      const a = 1 + (i - 1) * seg + j;
      const b = 1 + (i - 1) * seg + ((j + 1) % seg);
      const c = 1 + i * seg + j;
      const d = 1 + i * seg + ((j + 1) % seg);
      idx.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** Shared uniforms that make an object's surface glow where the air hits it, and char. */
interface HeatUniforms {
  uHeat: { value: number };
  uHeatColor: { value: THREE.Color };
  uFlow: { value: THREE.Vector3 };
  uChar: { value: number };
}

function heatify(group: THREE.Object3D, u: HeatUniforms) {
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, u);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uHeat;\nuniform vec3 uHeatColor;\nuniform vec3 uFlow;\nuniform float uChar;')
          .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= 1.0 - uChar * 0.7;')
          .replace(
            '#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\n float facing = max(dot(normal, uFlow), 0.0);\n totalEmissiveRadiance += uHeatColor * uHeat * (0.04 + pow(facing, 3.0) * 1.4);',
          );
      };
      mat.customProgramCacheKey = () => 'space-drop-heat';
      mat.needsUpdate = true;
    }
  });
}

const rng = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

function seeds(n: number, seed: number): THREE.BufferAttribute {
  const r = rng(seed);
  const a = new Float32Array(n * 4);
  for (let i = 0; i < a.length; i++) a[i] = r();
  return new THREE.BufferAttribute(a, 4);
}

function pointsCloud(n: number, seed: number, mat: THREE.ShaderMaterial): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aSeed', seeds(n, seed));
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  return p;
}

const radial = (() => {
  let tex: THREE.Texture | null = null;
  return () => {
    if (tex) return tex;
    const c = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: 128, height: 128 }) : new OffscreenCanvas(128, 128);
    const x = c.getContext('2d') as CanvasRenderingContext2D;
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.2, 'rgba(255,240,210,0.7)');
    g.addColorStop(0.5, 'rgba(255,170,90,0.18)');
    g.addColorStop(1, 'rgba(255,120,40,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
    tex = new THREE.CanvasTexture(c as HTMLCanvasElement);
    return tex;
  };
})();

// ---------------------------------------------------------------------------------------------
// Per-run visuals

interface Vis {
  run: Run;
  k: number;
  /** Size of the intact object (m). */
  size: number;
  holder: THREE.Group;
  spin: THREE.Group;
  intact: THREE.Group;
  core: THREE.Group | null;
  frag: THREE.Group | null;
  heatU: HeatUniforms;
  plasma: THREE.Mesh;
  wake: THREE.Mesh;
  sparks: THREE.Points;
  light: THREE.PointLight;
  /** A soft glow around the hot nose (the bloom of a blinding point). */
  flare: THREE.Sprite;
  debris: THREE.InstancedMesh | null;
  /** Mid scene: ground, clouds, impact, trail. */
  ground: THREE.Mesh;
  clouds: THREE.Mesh;
  impact: THREE.Group;
  flash: THREE.Sprite;
  fire: THREE.Mesh;
  ejecta: THREE.InstancedMesh;
  ejectaLaunch: { x: number; z: number; vr: number; vy: number; ang: number; s: number; spin: number }[];
  dust: THREE.Points;
  ring: THREE.Mesh;
  dome: THREE.Mesh;
  curtain: THREE.Mesh;
  column: THREE.Points;
  smoke: THREE.Points;
  /** What lies on the ground after a slow landing (crushed, if it crushes). */
  wreck: Wreck | null;
  /** Points on each model's surface (spin frame), to find its lowest point as it comes down. */
  hull: { intact: Float32Array; core: Float32Array | null; frag: Float32Array | null };
  burst: THREE.Group;
  trail: THREE.Mesh | null;
  /** Running maximum of the surface temperature seen so far (for charring), by sim time. */
  tSite: number;
  thSite: number;
  tumbleAxis: THREE.Vector3;
  /** Where its tumble starts, and how far off broadside-on it lands (rad); where the camera swing starts. */
  tumblePhase: number;
  landTilt: number;
  camPhase: number;
}

function makeVis(run: Run, k: number, look: Look['runs'][number], sun: THREE.Vector3, mid: THREE.Scene, near: THREE.Scene): Vis {
  const { tr, obj, body } = run;
  const size = sizeOf(body.shape);
  const holder = new THREE.Group();
  const spin = new THREE.Group();
  holder.add(spin);
  const heatU: HeatUniforms = { uHeat: { value: 0 }, uHeatColor: { value: new THREE.Color() }, uFlow: { value: new THREE.Vector3(1, 0, 0) }, uChar: { value: 0 } };
  const intact = buildModel(obj.id, body.shape);
  heatify(intact, heatU);
  spin.add(intact);
  let core: THREE.Group | null = null;
  if (tr.breakup?.core) {
    core = buildModel(obj.id, tr.breakup.core.shape, tr.breakup.core.name);
    heatify(core, heatU);
    core.visible = false;
    spin.add(core);
  }
  let frag: THREE.Group | null = null;
  if (tr.airburst && tr.impact) {
    // Built at its real size.
    frag = buildModel('stony-meteorite', tr.impact.shape, 'fragment');
    heatify(frag, heatU);
    frag.visible = false;
    spin.add(frag);
  }
  // Plasma bow and wake (unit sizes; scaled each frame).
  const plasma = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 24),
    new THREE.ShaderMaterial({
      vertexShader: PLASMA_VERT,
      fragmentShader: PLASMA_FRAG,
      uniforms: { uLevel: { value: 0 }, uColor: { value: new THREE.Color() }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  holder.add(plasma);
  const wakeGeo = new THREE.CylinderGeometry(1, 0.55, 1, 40, 1, true).translate(0, -0.5, 0).rotateZ(-Math.PI / 2);
  // uv.y runs 0 at the object to 1 at the tail.
  const uv = wakeGeo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const wake = new THREE.Mesh(
    wakeGeo,
    new THREE.ShaderMaterial({
      vertexShader: WAKE_VERT,
      fragmentShader: WAKE_FRAG,
      uniforms: { uLevel: { value: 0 }, uHot: { value: new THREE.Color() }, uCool: { value: new THREE.Color() }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  holder.add(wake);
  const sparks = pointsCloud(
    260,
    17 + k,
    new THREE.ShaderMaterial({
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      uniforms: { uTime: { value: 0 }, uLen: { value: 1 }, uSize: { value: 0.01 }, uLevel: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  holder.add(sparks);
  const light = new THREE.PointLight(0xff8040, 0, 0, 2);
  holder.add(light);
  const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: radial(), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  holder.add(flare);
  let debris: THREE.InstancedMesh | null = null;
  if (tr.breakup) {
    const n = tr.breakup.debris;
    debris = new THREE.InstancedMesh(debrisGeometry(), new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.6, metalness: 0.4, emissive: 0xff5a1a, emissiveIntensity: 0 }), n);
    debris.visible = false;
    debris.frustumCulled = false;
    holder.add(debris);
  }
  near.add(holder);

  // The ground: fine enough at the centre to show the crater (or the dent).
  const crR = run.crater ? run.crater.diameter / 2 : size;
  const r0 = Math.max(0.0004, Math.min(crR, size) / 30);
  const groundU = {
    uType: { value: 0 },
    uSeed: { value: noiseSeed(look.seed, 3) },
    uFlat: { value: Math.max(40, crR * 6, size * 20) },
    uCr: { value: 0 },
    uCd: { value: 0 },
    uRim: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uSun: { value: sun },
    uFogCol: { value: new THREE.Color() },
    uFogDist: { value: 60000 },
    uRMax: { value: 240000 },
    uCrFinal: { value: 0 },
    uEject: { value: 0 },
    uMelt: { value: 0 },
    uMeltCol: { value: new THREE.Color(1, 0.32, 0.06) },
    uCrust: { value: 1 },
    uScorch: { value: 0 },
    uGlowPos: { value: new THREE.Vector3() },
    uGlowCol: { value: new THREE.Color(0, 0, 0) },
    uScar: { value: new THREE.Vector4() },
    uScarW: { value: 0 },
    uGouge: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
  };
  const ground = new THREE.Mesh(
    patchGeometry(r0, 240000),
    new THREE.ShaderMaterial({ vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG, uniforms: groundU, transparent: true, depthWrite: true }),
  );
  ground.frustumCulled = false;
  ground.renderOrder = 0;
  mid.add(ground);
  const clouds = new THREE.Mesh(
    patchGeometry(400, 115000),
    new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: {
        uCam: groundU.uCam,
        uH: { value: 2600 },
        uCover: { value: 0.2 },
        uSeed: { value: noiseSeed(look.seed, 8) },
        uNear: { value: 1 },
        uSun: { value: sun },
        uFogCol: groundU.uFogCol,
        uFogDist: groundU.uFogDist,
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  clouds.frustumCulled = false;
  clouds.renderOrder = 2;
  mid.add(clouds);

  // The impact, at the site.
  const impact = new THREE.Group();
  mid.add(impact);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: radial(), color: 0xffffff, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
  flash.renderOrder = 5;
  impact.add(flash);
  const fire = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 32),
    new THREE.ShaderMaterial({
      vertexShader: PLASMA_VERT,
      fragmentShader: FIRE_FRAG,
      uniforms: { uHeat: { value: 1 }, uTime: { value: 0 }, uAlpha: { value: 0 } },
      transparent: true,
      depthWrite: false,
    }),
  );
  fire.renderOrder = 4;
  impact.add(fire);
  const nEj = 240;
  const groundCol = run.crater ? 0x8a7350 : 0x777777;
  const ejecta = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: groundCol, roughness: 0.95 }), nEj);
  ejecta.frustumCulled = false;
  impact.add(ejecta);
  const r = rng(look.seed);
  const ejectaLaunch = Array.from({ length: nEj }, () => {
    const x = 0.25 + 0.75 * r();
    return { x, z: 0, vr: x ** -1.4, vy: 0.8 + 0.5 * r(), ang: r() * Math.PI * 2, s: 0.02 + 0.06 * r() ** 2, spin: r() * 10 };
  });
  const dust = pointsCloud(
    420,
    55 + k,
    new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: { uPsi: { value: 0 }, uR: { value: 1 }, uSpeed: { value: 50 }, uColor: { value: new THREE.Color() } },
      transparent: true,
      depthWrite: false,
    }),
  );
  dust.renderOrder = 3;
  impact.add(dust);
  // The shock wave: a wall of dust racing over the ground, and (big ones) a faint condensation dome.
  const wall = () => new THREE.CylinderGeometry(1, 1, 1, 96, 6, true).translate(0, 0.5, 0);
  const ring = new THREE.Mesh(
    wall(),
    new THREE.ShaderMaterial({
      vertexShader: CURTAIN_VERT,
      fragmentShader: SKIRT_FRAG,
      uniforms: { uRb: { value: 1 }, uRt: { value: 1 }, uH: { value: 1 }, uColor: { value: new THREE.Color() }, uAlpha: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  ring.renderOrder = 3;
  impact.add(ring);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.ShaderMaterial({ vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, uniforms: { uAlpha: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  dome.renderOrder = 4;
  impact.add(dome);
  // The ejecta curtain standing on the growing crater's rim.
  const curtain = new THREE.Mesh(
    wall(),
    new THREE.ShaderMaterial({
      vertexShader: CURTAIN_VERT,
      fragmentShader: CURTAIN_FRAG,
      uniforms: { uRb: { value: 1 }, uRt: { value: 2 }, uH: { value: 1 }, uColor: { value: new THREE.Color() }, uAlpha: { value: 0 }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  curtain.renderOrder = 3;
  impact.add(curtain);
  const column = pointsCloud(
    300,
    91 + k,
    new THREE.ShaderMaterial({
      vertexShader: COLUMN_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: { uPsi: { value: 0 }, uH: { value: 1 }, uR: { value: 1 }, uColor: { value: new THREE.Color() } },
      transparent: true,
      depthWrite: false,
    }),
  );
  column.renderOrder = 3;
  impact.add(column);
  // Smoke from a wrecked engine bay, drifting downwind.
  const windA = r() * Math.PI * 2;
  const smoke = pointsCloud(
    160,
    77 + k,
    new THREE.ShaderMaterial({
      vertexShader: SMOKE_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: {
        uPsi: { value: 0 },
        uSrc: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector3(Math.cos(windA), 0, Math.sin(windA)).multiplyScalar(0.6 + 0.6 * r()) },
        uSize: { value: size },
        uColor: { value: new THREE.Color(0.3, 0.3, 0.3) },
      },
      transparent: true,
      depthWrite: false,
    }),
  );
  smoke.renderOrder = 3;
  impact.add(smoke);
  impact.traverse((o) => (o.frustumCulled = false));
  // A slow landing leaves the object (or what's left of it) wrecked in its dent.
  let wreck: Wreck | null = null;
  if (tr.impact && tr.impact.v < 600) {
    const last = tr.breakup?.core ?? (tr.airburst ? null : body);
    const model = last === body ? buildModel(obj.id, body.shape) : last ? buildModel(obj.id, last.shape, last.name) : frag ? buildModel('stony-meteorite', tr.impact.shape, 'fragment') : null;
    if (model) {
      heatify(model, heatU);
      wreck = new Wreck(model, tr.impact.body.name, look.seed, sizeOf(tr.impact.shape));
      mid.add(wreck.group);
    }
  }
  const burst = new THREE.Group();
  const burstFire = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 32),
    new THREE.ShaderMaterial({
      vertexShader: PLASMA_VERT,
      fragmentShader: FIRE_FRAG,
      uniforms: { uHeat: { value: 1 }, uTime: { value: 0 }, uAlpha: { value: 0 } },
      transparent: true,
      depthWrite: false,
    }),
  );
  burst.add(burstFire);
  const burstFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: radial(), color: 0xffffff, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
  burst.add(burstFlash);
  burst.visible = false;
  mid.add(burst);

  const thSite = tr.impact?.th ?? tr.th[tr.th.length - 1];
  const vis: Vis = {
    run,
    k,
    size,
    holder,
    spin,
    intact,
    core,
    frag,
    heatU,
    plasma,
    wake,
    sparks,
    light,
    flare,
    debris,
    ground,
    clouds,
    impact,
    flash,
    fire,
    ejecta,
    ejectaLaunch,
    dust,
    ring,
    dome,
    curtain,
    column,
    smoke,
    wreck,
    hull: { intact: hullOf(intact, spin), core: core && hullOf(core, spin), frag: frag && hullOf(frag, spin) },
    burst,
    trail: null,
    tSite: endTime(tr),
    thSite,
    tumbleAxis: new THREE.Vector3(0.3 + 0.4 * r(), 1, 0.5 * r() - 0.25).normalize(),
    tumblePhase: look.tumblePhase,
    landTilt: look.landTilt,
    camPhase: look.camPhase,
  };
  vis.trail = buildTrail(vis);
  if (vis.trail) mid.add(vis.trail);
  return vis;
}

/** Position on the landing site's frame (m) for a sample: the site turns with the Earth. */
function sitePos(v: Vis, s: Sample, out: THREE.Vector3): THREE.Vector3 {
  const site = v.thSite - OMEGA * (v.tSite - s.t);
  const phi = s.th - site;
  return out.set(s.r * Math.sin(phi), s.r * Math.cos(phi) - R_EARTH, 0);
}

/** Direction of flight through the air, in the site's frame. */
function flightDir(v: Vis, s: Sample, out: THREE.Vector3): THREE.Vector3 {
  const site = v.thSite - OMEGA * (v.tSite - s.t);
  const phi = s.th - site;
  const ex = Math.cos(phi);
  const ey = -Math.sin(phi);
  const ux = Math.sin(phi);
  const uy = Math.cos(phi);
  out.set(s.vh * ex - s.vd * ux, s.vh * ey - s.vd * uy, 0);
  return out.lengthSq() > 1e-9 ? out.normalize() : out.set(0, -1, 0);
}

/** How wide the object is across the flow (m), for its trail. */
function trailWidth(v: Vis): number {
  const s = v.run.body.shape;
  return v.run.body.attitude === 'nose' && s.kind === 'cyl' ? s.d * 2 : v.size;
}

/** The smoke (and, while fresh, glowing) trail along the stretch of the path that was hot. */
function buildTrail(v: Vis): THREE.Mesh | null {
  const tr = v.run.tr;
  const idx: number[] = [];
  let peak = 0;
  for (let i = 0; i < tr.t.length; i++) peak = Math.max(peak, tr.heat[i]);
  if (peak < 2e5) return null;
  for (let i = 0; i < tr.t.length; i++) if (tr.heat[i] > peak * 0.04 && tr.h[i] < 120000) idx.push(i);
  if (idx.length < 4) return null;
  const n = Math.min(400, idx.length);
  const pos: number[] = [];
  const tan: number[] = [];
  const side: number[] = [];
  const at: number[] = [];
  const warm: number[] = [];
  const index: number[] = [];
  const p = V();
  const q = V();
  for (let j = 0; j < n; j++) {
    const i = idx[Math.floor((j / (n - 1)) * (idx.length - 1))];
    const s = sampleAt(tr, tr.t[i]);
    sitePos(v, s, p);
    flightDir(v, s, q);
    for (const sd of [-1, 1]) {
      pos.push(p.x, p.y, p.z);
      tan.push(q.x, q.y, q.z);
      side.push(sd);
      at.push(tr.t[i]);
      warm.push(Math.min(1, tr.heat[i] / peak));
    }
    if (j > 0) {
      const a = (j - 1) * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aTangent', new THREE.Float32BufferAttribute(tan, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(at, 1));
  g.setAttribute('aWarm', new THREE.Float32BufferAttribute(warm, 1));
  g.setIndex(index);
  const m = new THREE.Mesh(
    g,
    new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uSimT: { value: 0 },
        uW0: { value: Math.min(v.size, trailWidth(v)) * 0.8 },
        uClear: { value: 0 },
        uSmoke: { value: new THREE.Color(0.5, 0.48, 0.46) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  m.frustumCulled = false;
  m.renderOrder = 1;
  return m;
}

// ---------------------------------------------------------------------------------------------
// The scene

interface View {
  scene: THREE.Scene;
  far: THREE.Scene;
  mid: THREE.Scene;
  near: THREE.Scene;
  camFar: THREE.PerspectiveCamera;
  camMid: THREE.PerspectiveCamera;
  camNear: THREE.PerspectiveCamera;
  sky: THREE.Mesh;
  stars: THREE.Points;
  earth: THREE.Mesh;
  atmos: THREE.Mesh;
  vis: Vis[];
  sunNear: THREE.DirectionalLight;
  hemiNear: THREE.HemisphereLight;
  sunMid: THREE.DirectionalLight;
  hemiMid: THREE.HemisphereLight;
  sun: THREE.Vector3;
  key: object;
  /** For the time-warp readout: last frame's video and sim times. */
}

const GROUND_TYPE = { sand: 0, soil: 1, rock: 2 } as const;

const view = sceneCache((s: SpaceDropState) => {
  const scene = new THREE.Scene();
  const far = new THREE.Scene();
  const mid = new THREE.Scene();
  const near = new THREE.Scene();
  const SUN = new THREE.Vector3(...s.look.sun).normalize();
  // Reflections only need the sun roughly right: one environment per band of sun height.
  const band = SUN.y < 0.37 ? 0 : SUN.y < 0.74 ? 1 : 2;
  const env = studioEnvironment(`space-drop-${band}`, (sc) => {
    sc.background = new THREE.Color(0x05070c);
    const sunBall = new THREE.Mesh(new THREE.SphereGeometry(2, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(30, 28, 24) }));
    const e = [0.2, 0.6, 1.1][band];
    sunBall.position.set(-0.56 * Math.cos(e), Math.sin(e), 0.83 * Math.cos(e)).multiplyScalar(20);
    sc.add(sunBall);
    const ground = new THREE.Mesh(
      new THREE.SphereGeometry(30, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.12, 0.16, 0.24), side: THREE.BackSide }),
    );
    sc.add(ground);
  });
  near.environment = env;
  mid.environment = env;
  near.environmentIntensity = 0.5;

  const camFar = new THREE.PerspectiveCamera(50, 9 / 16, 0.05, 300000);
  const camMid = new THREE.PerspectiveCamera(50, 9 / 16, 0.1, 500000);
  const camNear = new THREE.PerspectiveCamera(50, 9 / 16, 0.01, 1000);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(200000, 64, 32),
    new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { uUp: { value: new THREE.Vector3(0, 1, 0) }, uSun: { value: SUN }, uAlt: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  sky.renderOrder = -3;
  sky.frustumCulled = false;
  far.add(sky);
  const nStars = 4000;
  const starPos = new Float32Array(nStars * 3);
  const starSize = new Float32Array(nStars);
  const r = rng(77);
  for (let i = 0; i < nStars; i++) {
    const u = r() * 2 - 1;
    const a = r() * Math.PI * 2;
    const q = Math.sqrt(1 - u * u);
    starPos.set([Math.cos(a) * q * 180000, u * 180000, Math.sin(a) * q * 180000], i * 3);
    starSize[i] = r() ** 3;
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  sg.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));
  const stars = new THREE.Points(
    sg,
    new THREE.ShaderMaterial({ vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, uniforms: { uVis: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  stars.renderOrder = -2;
  stars.frustumCulled = false;
  far.add(stars);
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH / 1000, 256, 160),
    new THREE.ShaderMaterial({
      vertexShader: EARTH_VERT,
      fragmentShader: EARTH_FRAG,
      uniforms: { uSun: { value: SUN }, uType: { value: GROUND_TYPE[s.p.ground] }, uTime: { value: 0 }, uSeed: { value: 4.2 } },
    }),
  );
  earth.frustumCulled = false;
  far.add(earth);
  const atmos = new THREE.Mesh(
    new THREE.SphereGeometry((R_EARTH / 1000) * 1.03, 160, 100),
    new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: ATMOS_FRAG,
      uniforms: { uSun: { value: SUN }, uCenter: { value: new THREE.Vector3() }, uR: { value: R_EARTH / 1000 }, uFade: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    }),
  );
  atmos.frustumCulled = false;
  far.add(atmos);

  const sunNear = new THREE.DirectionalLight(0xfff1dc, 3.2);
  near.add(sunNear, sunNear.target);
  const hemiNear = new THREE.HemisphereLight(0x8fb4ff, 0x302820, 0.2);
  near.add(hemiNear);
  const sunMid = new THREE.DirectionalLight(0xfff1dc, 2.6);
  mid.add(sunMid, sunMid.target);
  const hemiMid = new THREE.HemisphereLight(0x9cc0ff, 0x4a3c2c, 0.8);
  mid.add(hemiMid);

  const vis = s.sim.runs.map((run, k) => makeVis(run, k, s.look.runs[k], SUN, mid, near));
  for (const v of vis) (v.ground.material as THREE.ShaderMaterial).uniforms.uType.value = GROUND_TYPE[s.p.ground];
  for (const v of vis) ((v.clouds.material as THREE.ShaderMaterial).uniforms.uCover.value as number) = s.p.ground === 'sand' ? 0.05 : s.p.ground === 'soil' ? 0.28 : 0.16;
  // `scene` only carries ownership for disposal: everything hangs off it.
  scene.add(far, mid, near);
  // A low sun is warmer and weaker.
  const warm = smooth(0.45, 0.12, SUN.y);
  for (const l of [sunNear, sunMid]) {
    l.color.set(0xfff1dc).lerp(new THREE.Color(0xffb070), warm);
    l.intensity *= 1 - 0.3 * warm;
  }
  return { scene, far, mid, near, camFar, camMid, camNear, sky, stars, earth, atmos, vis, sunNear, hemiNear, sunMid, hemiMid, sun: SUN, key: {} } as View;
});

// ---------------------------------------------------------------------------------------------
// Per frame

const tmp = { a: V(), b: V(), c: V(), d: V(), e: V(), f: V(), up: V(), side: V(), q: new THREE.Quaternion(), m: new THREE.Matrix4(), col: new THREE.Color(), col2: new THREE.Color() };

/**
 * Radius (m) of an impact's blast wave t s on, taking a twentieth of the energy into the air: Sedov–
 * Taylor while it's strong (R ∝ (E t²/ρ)^⅕), then moving at the speed of sound.
 */
export function shockRadius(E: number, t: number): number {
  if (t <= 0) return 0;
  const k = ((0.05 * E) / 1.2) ** 0.2;
  const ts = ((0.4 * k) / 408) ** (1 / 0.6);
  return t < ts ? k * t ** 0.4 : k * ts ** 0.4 + 340 * (t - ts);
}

/** When the blast wave reaches a distance (s after impact). */
export function shockArrival(E: number, d: number): number {
  let lo = 0;
  let hi = 1;
  while (shockRadius(E, hi) < d && hi < 1e4) hi *= 2;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (shockRadius(E, m) < d) lo = m;
    else hi = m;
  }
  return hi;
}

/** Physical seconds into the impact, from video seconds since it: slow motion at first. */
export function impactClock(tau: number): number {
  if (tau <= 0) return 0;
  const slow = 0.12;
  const ramp = 1.6;
  return tau < ramp ? slow * tau : slow * ramp + (tau - ramp) * 0.75;
}

interface Pose {
  /** Object's position and flight direction (site frame), its sample, its current size. */
  O: THREE.Vector3;
  dir: THREE.Vector3;
  smp: Sample;
  size: number;
  /** Its width across the flow (a rod flying point-first is far thinner than it is long). */
  width: number;
  shape: Shape;
}

function poseOf(v: Vis, simT: number): Pose {
  const tr = v.run.tr;
  const smp = sampleAt(tr, Math.min(simT, endTime(tr)));
  const O = sitePos(v, smp, V());
  const dir = flightDir(v, smp, V());
  let shape: Shape = v.run.body.shape;
  if (smp.phase === 1 && tr.breakup?.core) shape = tr.breakup.core.shape;
  if (smp.phase === 3 && tr.impact) shape = tr.impact.shape;
  let size = sizeOf(shape) * (smp.phase === 0 ? smp.k : 1);
  if (smp.phase === 2) size = Math.max(size, smp.L);
  const width = smp.phase === 0 && v.run.body.attitude === 'nose' && shape.kind === 'cyl' ? shape.d * 1.6 : size;
  return { O, dir, smp, size: Math.max(size, 0.004), width: Math.max(width, 0.004), shape };
}

/** Camera for one object at video time t: where it is and what it looks at (site frame). */
function cameraFor(v: Vis, pose: Pose, d: AnyDirector, t: number, tag: string, out: { pos: THREE.Vector3; look: THREE.Vector3; shake: number }, zoomOut = 1, replay = false) {
  const { O, dir, smp } = pose;
  const up = tmp.up
    .copy(O)
    .add(tmp.a.set(0, R_EARTH, 0))
    .normalize();
  const side = tmp.side.crossVectors(dir, up);
  if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
  side.normalize();
  const size = pose.size;
  const glowRoom = 1 + 1.4 * plasmaOf(smp.heat) * (pose.width / size);
  const alt = smp.h;
  // Seen from beside its path, looking a little down so the horizon (and how high it is) stays in
  // frame, swinging slowly round; tilting further down as it nears the ground, to watch it rush up.
  const yaw = 0.35 * Math.sin(v.camPhase + t * 0.09);
  const low = smooth(30000, 4000, alt);
  const dist = size * (2.4 + 1.2 * glowRoom) * (1 + 0.5 * low) * zoomOut;
  const across = tmp.e.crossVectors(up, side).normalize();
  const h = tmp.f.copy(side).multiplyScalar(Math.cos(yaw)).addScaledVector(across, Math.sin(yaw)).normalize();
  const tilt = lerp(0.1, 0.8, low);
  const view = h.multiplyScalar(Math.cos(tilt)).addScaledVector(up, -Math.sin(tilt));
  const chase = tmp.b.copy(O).addScaledVector(view, -dist);
  const look = tmp.c.copy(O).addScaledVector(dir, size * 0.3 * (1 - low));
  // Burst: pull back to take in the expanding cloud.
  const tb = markAt(d, `burst${tag}`);
  if (t > tb && v.run.tr.airburst) {
    const u = smooth(0, 1.2, t - tb) * (1 - smooth(3.5, 7, t - tb));
    const L = Math.max(size, sizeOf(v.run.body.shape) * 7);
    chase
      .sub(O)
      .normalize()
      .multiplyScalar(lerp(dist, L * 6, u))
      .add(O);
  }
  out.pos.copy(chase);
  out.look.copy(look);
  out.shake = size * 0.015 * Math.min(1.5, plasmaOf(smp.heat)) * (1 - low * 0.5);
  // The last moments: from the ground, looking up the incoming path at the site.
  const ta = markAt(d, `approach${tag}`);
  const ti = markAt(d, `impact${tag}`);
  const cr = v.run.crater;
  const crD = cr ? cr.diameter : size;
  const zf = Math.max(1, zoomOut * 0.7);
  // Far enough back to see it come in (clear of the readouts) and what it throws up; less so for
  // big things (a jet is 70 m across, but its wreck still has to read).
  const reach = size < 12 ? size : 12 * Math.sqrt(size / 12);
  // Never closer than a few metres or lower than eye height, unless it's tiny (a penny).
  const Dg = Math.max(9 * reach, crD * 7, Math.min(3, size * 16)) * zf;
  const lowH = Math.min(1.6, size * 3);
  // The replay: from the other side, lower and closer.
  const ground = replay ? tmp.d.set(-Dg * 0.5, Math.max(lowH * 0.6, Dg * 0.04), Dg * 0.62) : tmp.d.set(Dg * 0.45, Math.max(lowH, Dg * 0.07), Dg);
  if (t > ta + 1.0 && v.run.tr.impact) {
    const u = smooth(ta + 1.0, ta + 1.6, t);
    // Aim between the incoming object and the site.
    const target = tmp.e.copy(O).lerp(tmp.f.set(0, size * 0.5, 0), t >= ti ? 1 : 0.35);
    out.pos.lerp(ground, u);
    out.look.lerp(target, u);
    out.shake = 0;
  }
  if (t >= ti) {
    const tau = t - ti;
    const psi = impactClock(tau);
    // The ground shakes when the shock wave gets here, harder the closer and bigger it is.
    const E = v.run.energy;
    const arrive = shockArrival(E, Dg);
    const felt = Math.min(1, Math.max(0.1, Math.cbrt(E / 4.184e6) / (Dg / 12)));
    out.shake = psi >= arrive ? Dg * 0.012 * felt * Math.exp(-(psi - arrive) * 3) * smooth(arrive, arrive + 0.02, psi) : 0;
    // Crane up over the crater once the dust starts to settle.
    const u = smooth(3.2, 6.5, tau);
    const aerial = tmp.e.set(crD * 1.2, Math.max(crD * 2.6, size * 5, Math.min(6, size * 40)), crD * 1.9 + size * 3).multiplyScalar(zf);
    out.pos.copy(ground).lerp(aerial, u);
    out.look.set(0, 0, 0).lerp(tmp.f.set(0, -crD * 0.1, 0), u);
  }
}

function placeCamera(cam: THREE.PerspectiveCamera, pos: THREE.Vector3, look: THREE.Vector3, up: THREE.Vector3, aspect: number, nearP: number, farP: number, scale: number) {
  cam.aspect = aspect;
  cam.near = nearP;
  cam.far = farP;
  cam.position.set(0, 0, 0);
  cam.up.copy(up);
  cam.lookAt(tmp.a.copy(look).sub(pos).multiplyScalar(scale));
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
}

/** Seconds the tumble takes to settle once it comes in to land. */
const SETTLE = 1.4;

/**
 * How far it has tumbled by video time t. Coming in to land (from the approach mark `ta`) the tumble
 * eases to a stop, so how it will hit is known a moment ahead (its wreck is worked out from that),
 * turning as it does to come down more or less broadside-on (end-on hides the crush).
 */
function spinAngle(v: Vis, t: number, ta: number): number {
  const rate = 0.45 + 0.25 * v.k;
  if (!(t > ta)) return v.tumblePhase + t * rate;
  const u = Math.min(1, (t - ta) / SETTLE);
  const final = v.tumblePhase + (ta + SETTLE / 2) * rate;
  // The nearest broadside-on attitude (either face down), give or take its tilt.
  const turn = ((((Math.PI / 2 + v.landTilt - final) % Math.PI) + Math.PI * 1.5) % Math.PI) - Math.PI / 2;
  return v.tumblePhase + (ta + SETTLE * (u - (u * u) / 2)) * rate + turn * u * u * (3 - 2 * u);
}

/** The object's attitude: the holder points +x along the flight, the spin turns it by `angle`. */
function spinPose(v: Vis, smp: Sample, dir: THREE.Vector3, angle: number, holderQ: THREE.Quaternion, spinQ: THREE.Quaternion, spinS: THREE.Vector3) {
  holderQ.setFromUnitVectors(hullV.p.set(1, 0, 0), dir);
  const nose = v.run.body.attitude === 'nose' && smp.phase === 0;
  if (nose) spinQ.identity();
  else spinQ.setFromAxisAngle(v.tumbleAxis, angle);
  // A rock crushed flat: squash along the flight, spread across it.
  if (smp.phase === 2 && smp.L > 0) {
    const L0 = sizeOf(v.run.body.shape);
    const w = smp.L / L0;
    spinS.set(1 / Math.sqrt(w), w, w);
    spinQ.identity();
  } else if (smp.phase === 0) spinS.setScalar(Math.max(0.05, smp.k));
  else spinS.setScalar(1);
}

const hullV = { up: V(), p: V(), q: new THREE.Quaternion() };

/** Points over a model's surface, in the frame of `frame` (an ancestor). */
function hullOf(model: THREE.Object3D, frame: THREE.Object3D): Float32Array {
  const pts: number[] = [];
  const M = new THREE.Matrix4();
  const p = V();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    relativeTo(mesh, frame, M);
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const step = Math.max(1, Math.floor(pos.count / 200));
    for (let i = 0; i < pos.count; i += step) {
      p.fromBufferAttribute(pos, i).applyMatrix4(M);
      pts.push(p.x, p.y, p.z);
    }
  });
  return new Float32Array(pts);
}

/** Lowest point of a hull (along `up`) once turned by q and scaled by s. */
function lowest(hull: Float32Array, q: THREE.Quaternion, s: THREE.Vector3, up: THREE.Vector3): number {
  let m = Infinity;
  const p = hullV.p;
  for (let i = 0; i < hull.length; i += 3)
    m = Math.min(
      m,
      p
        .set(hull[i] * s.x, hull[i + 1] * s.y, hull[i + 2] * s.z)
        .applyQuaternion(q)
        .dot(up),
    );
  return Number.isFinite(m) ? m : 0;
}

/** How it lies the instant it touches down (settled since `ta`, or as it was at `ti`), for its wreck. */
function wreckImpact(v: Vis, ta: number, ti: number): WreckImpact {
  const tr = v.run.tr;
  const smp = sampleAt(tr, endTime(tr));
  const dir = flightDir(v, smp, V());
  const hq = new THREE.Quaternion();
  const sq = new THREE.Quaternion();
  const ss = V();
  spinPose(v, smp, dir, spinAngle(v, Number.isFinite(ta) ? Infinity : ti, ta), hq, sq, ss);
  const im = tr.impact!;
  const cr = v.run.crater;
  return {
    q: hq.multiply(sq),
    scale: ss,
    v: im.v,
    vh: new THREE.Vector3(dir.x * im.v, 0, dir.z * im.v),
    mass: im.mass,
    size: sizeOf(im.shape),
    crater: cr ? { R: cr.diameter / 2, depth: cr.depth, rim: cr.depth * 0.18 } : { R: 0, depth: 0, rim: 0 },
  };
}

function updateVis(v: Vis, pose: Pose, cam: THREE.Vector3, d: AnyDirector, t: number, tag: string, viewV: View) {
  const { smp, O, dir } = pose;
  const camDist = cam.distanceTo(O);
  const tr = v.run.tr;
  const ti = markAt(d, `impact${tag}`);
  const landed = t >= ti || smp.t >= endTime(tr) - 1e-6;
  const gone = tr.end === 'burnup' && smp.t >= endTime(tr) - 1e-6;
  // Object.
  v.holder.position.copy(O).sub(cam);
  v.holder.visible = !(landed && tr.impact) && !gone;
  if (gone) v.holder.visible = false;
  v.intact.visible = smp.phase === 0 || smp.phase === 2;
  if (v.core) v.core.visible = smp.phase === 1;
  if (v.frag) v.frag.visible = smp.phase === 3;
  spinPose(v, smp, dir, spinAngle(v, t, markAt(d, `approach${tag}`)), v.holder.quaternion, v.spin.quaternion, v.spin.scale);
  // Lifted so that its lowest point, not its middle, meets the ground.
  const hull = smp.phase === 1 && v.hull.core ? v.hull.core : smp.phase === 3 && v.hull.frag ? v.hull.frag : v.hull.intact;
  const up = hullV.up
    .copy(O)
    .add(hullV.p.set(0, R_EARTH, 0))
    .normalize();
  v.holder.position.addScaledVector(up, -lowest(hull, hullV.q.copy(v.holder.quaternion).multiply(v.spin.quaternion), v.spin.scale, up));
  // Glow where the air hits it.
  const glow = glowOf(smp.Ts);
  v.heatU.uHeat.value = glow;
  blackbody(smp.Ts, v.heatU.uHeatColor.value).convertSRGBToLinear();
  // The flow direction in view space (the shader compares view-space normals with it).
  v.heatU.uFlow.value.copy(dir).transformDirection(viewV.camNear.matrixWorldInverse);
  v.heatU.uChar.value = Math.min(1, Math.max(0, (peakTsBefore(tr, smp.t) - 650) / 900)) * 0.85;
  // Plasma.
  const P = plasmaOf(smp.heat) * (smp.phase === 2 ? 1.3 : 1);
  const size = pose.size;
  const pm = v.plasma.material as THREE.ShaderMaterial;
  pm.uniforms.uLevel.value = Math.min(P, 1.2) * 0.9;
  pm.uniforms.uTime.value = t;
  const shockT = Math.max(1500, Math.min(16000, smp.Tshock));
  // Glowing air reads orange-yellow on re-entry (ablated metal adds to it), white-blue at meteor speeds.
  blackbody(1400 + shockT * 0.42, pm.uniforms.uColor.value).convertSRGBToLinear();
  const wid = pose.width;
  const nosePos = (size / 2) * (wid < size * 0.5 ? 1 : 0);
  if (nosePos > 0) {
    // A slender body flying point-first: a narrow sheath along its whole length, hottest at the tip.
    v.plasma.scale.set(size * 0.56, wid * 0.75, wid * 0.75);
    v.plasma.position.set(size * 0.04, 0, 0);
  } else {
    v.plasma.scale.set(wid * 0.55, wid * 0.62, wid * 0.62);
    v.plasma.position.set(wid * 0.12, 0, 0);
  }
  v.plasma.visible = P > 0.01;
  const wm = v.wake.material as THREE.ShaderMaterial;
  wm.uniforms.uLevel.value = Math.pow(Math.min(P, 1.5), 1.6) * 0.55;
  wm.uniforms.uTime.value = t;
  wm.uniforms.uHot.value.copy(pm.uniforms.uColor.value);
  blackbody(1100 + shockT * 0.2, wm.uniforms.uCool.value).convertSRGBToLinear();
  const wakeLen = size * 1.2 + wid * (4 + 30 * Math.min(1.4, P));
  v.wake.scale.set(wakeLen, wid * 0.5, wid * 0.5);
  v.wake.position.set(nosePos * 0.8, 0, 0);
  v.wake.visible = P > 0.01;
  // Sparks while the surface melts away (or right after a breakup).
  const ablating = smp.Ts >= 0.97 * materialMelt(v, smp) && P > 0.2;
  const tbk = markAt(d, `break${tag}`);
  const sm = v.sparks.material as THREE.ShaderMaterial;
  sm.uniforms.uTime.value = t;
  sm.uniforms.uLen.value = wakeLen * 0.8;
  sm.uniforms.uSize.value = wid * 0.03;
  sm.uniforms.uLevel.value = (ablating ? Math.min(1, P) : 0) + 1.2 * Math.max(0, 1 - Math.max(0, t - tbk) / 2.5) * (t > tbk ? 1 : 0);
  v.flare.position.set(nosePos + wid * 0.25, 0, 0);
  // Never so big it swallows the frame (it's the camera's glare, not a thing).
  v.flare.scale.setScalar(Math.min(wid * (3 + 9 * Math.min(P, 1.5)), camDist * 0.35));
  (v.flare.material as THREE.SpriteMaterial).color.copy(pm.uniforms.uColor.value).multiplyScalar(Math.min(1.2, P));
  (v.flare.material as THREE.SpriteMaterial).opacity = Math.min(1, P);
  v.flare.visible = P > 0.05;
  v.light.color.copy(pm.uniforms.uColor.value);
  v.light.intensity = P * wid * wid * 8;
  v.light.position.set(nosePos + wid * 0.8, 0, 0);
  // Debris from a breakup: thrown out, then falling behind (it's lighter for its size).
  if (v.debris) {
    const tb = markAt(d, `break${tag}`);
    const since = t - tb;
    v.debris.visible = since > 0 && since < 7 && !landed;
    if (v.debris.visible) {
      const r = rng(31 + v.k);
      const L0 = sizeOf(v.run.body.shape);
      const em = v.debris.material as THREE.MeshStandardMaterial;
      em.emissiveIntensity = 2.5 * Math.exp(-since / 1.6) * Math.min(1, P + 0.3);
      for (let i = 0; i < v.debris.count; i++) {
        const out = tmp.a.set(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
        const sp = L0 * (0.4 + r() * 1.4);
        const lag = L0 * (0.6 + r() * 2.5);
        const sz = L0 * (0.03 + 0.09 * r() ** 2);
        const p = tmp.b
          .copy(out)
          .multiplyScalar(sp * (1 - Math.exp(-since * 1.5)))
          .add(tmp.c.set(-lag * since * since * 0.5, 0, 0));
        tmp.m.compose(p, tmp.q.setFromAxisAngle(out, since * (2 + 6 * r())), tmp.d.setScalar(sz * Math.max(0, 1 - since / 7)));
        v.debris.setMatrixAt(i, tmp.m);
      }
      v.debris.instanceMatrix.needsUpdate = true;
    }
  }
}

/** Highest surface temperature reached up to a time (it chars and stays charred). */
function peakTsBefore(tr: Run['tr'], t: number): number {
  let m = 0;
  for (let i = 0; i < tr.t.length && tr.t[i] <= t; i += Math.max(1, Math.floor(tr.t.length / 400))) m = Math.max(m, tr.Ts[i]);
  return m;
}

function materialMelt(v: Vis, s: Sample): number {
  const tr = v.run.tr;
  const body = s.phase === 1 && tr.breakup?.core ? tr.breakup.core : v.run.body;
  return MELT[body.material] ?? 1800;
}
const MELT: Record<string, number> = { tungsten: 3695, steel: 1730, iron: 1800, stone: 1900, aluminium: 933, titanium: 1941, zinc: 693, resin: 650, wood: 900, tissue: 700, brick: 1500 };

/** The site's ground, clouds, trail and impact for one object, seen from `cam` (site frame). */
function updateGround(v: Vis, cam: THREE.Vector3, camAlt: number, simT: number, d: AnyDirector, t: number, tag: string, ground: string, glowFrom: { pos: THREE.Vector3; col: THREE.Color }) {
  const gm = v.ground.material as THREE.ShaderMaterial;
  const u = gm.uniforms;
  u.uCam.value.copy(cam);
  const visible = camAlt < 160000;
  v.ground.visible = visible;
  v.clouds.visible = visible && camAlt < 90000;
  // Haze: thick near the ground, fading as you climb.
  const fogDist = lerp(45000, 400000, smooth(0, 60000, camAlt));
  u.uFogDist.value = fogDist;
  (u.uFogCol.value as THREE.Color)
    .setRGB(0.55, 0.66, 0.82)
    .convertSRGBToLinear()
    .multiplyScalar(lerp(1, 0.25, smooth(10000, 80000, camAlt)));
  // Fade the patch in as the camera comes down (above it, the sphere shows the ground).
  u.uRMax.value = lerp(240000, 120000, smooth(40000, 140000, camAlt));
  const cr = v.run.crater;
  const ti = markAt(d, `impact${tag}`);
  const psi = impactClock(t - ti);
  // Hot: fast enough to melt and vaporise (fireball, glowing debris, a molten floor).
  const vImp = v.run.tr.impact?.v ?? 0;
  const fast = vImp > 2000;
  const meltTau = Math.min(6, Math.max(1.5, vImp / 1500));
  let grow = 0;
  if (cr && t >= ti) {
    const R = cr.diameter / 2;
    const form = Math.max(0.05, 0.9 * Math.sqrt(cr.diameter / 9.81));
    grow = 1 - Math.exp(-psi / (form * 0.35));
    u.uCr.value = R * (0.25 + 0.75 * grow);
    u.uCd.value = cr.depth * grow;
    u.uRim.value = cr.depth * 0.18 * grow;
    u.uCrFinal.value = R;
    u.uEject.value = grow;
    // The melt glows white-orange, cools through dark red and crusts over.
    const cool = Math.exp(-psi / meltTau);
    u.uMelt.value = fast ? (0.35 + 0.65 * cool) * smooth(0, 0.05, psi) * (1 - smooth(meltTau * 2, meltTau * 4, psi)) : 0;
    blackbody(650 + 1500 * cool, u.uMeltCol.value as THREE.Color).convertSRGBToLinear();
    u.uScorch.value = fast ? Math.min(0.9, Math.min(1, psi * 3) * 0.6 + 0.3 * (1 - cool)) : 0;
    u.uCrust.value = 1.1 * cool * cool;
  } else {
    u.uCr.value = 0;
    u.uCrFinal.value = 0;
    u.uEject.value = 0;
    u.uMelt.value = 0;
    u.uScorch.value = 0;
  }
  u.uGlowPos.value.copy(glowFrom.pos);
  u.uGlowCol.value.copy(glowFrom.col);
  const cmU = (v.clouds.material as THREE.ShaderMaterial).uniforms;
  cmU.uNear.value = smooth(40, 500, Math.abs(camAlt - 2600));
  if (v.trail) {
    const tu = (v.trail.material as THREE.ShaderMaterial).uniforms;
    tu.uCam.value.copy(cam);
    // The fall's clock stops at the impact; the smoke keeps ageing with the impact's.
    tu.uSimT.value = simT + impactClock(t - ti);
    tu.uClear.value = t >= ti && cr ? Math.max(cr.diameter * 3, v.size * 4) * Math.min(1, impactClock(t - ti) * 4) : 0;
    v.trail.visible = visible;
  }
  // The impact itself (drawn too small to see until then, so its shaders are ready when it comes).
  const imp = v.run.tr.impact;
  v.impact.position.set(0, 0, 0).sub(cam);
  v.impact.visible = Boolean(imp);
  v.impact.scale.setScalar(t >= ti ? 1 : 1e-6);
  if (imp && cr && t >= ti) {
    const E = v.run.energy;
    const R = Math.max(cr.diameter / 2, 0.01);
    // Fireball and flash scale with the energy (only fast impacts vaporise enough to burn).
    const fb = fast ? Math.max(R * 0.8, 0.05 * Math.cbrt(E / 4.184e12) ** 1.2 * 1000) : R * 0.4;
    const fl = Math.exp(-psi / 0.06) * smooth(0, 0.004, psi);
    v.flash.scale.setScalar(fb * (fast ? 4 : 2) * (0.5 + fl));
    v.flash.position.set(0, fb * 0.3, 0);
    (v.flash.material as THREE.SpriteMaterial).opacity = Math.min(1, fl * (fast ? 1.2 : 0.5));
    const fm = (v.fire.material as THREE.ShaderMaterial).uniforms;
    const fgrow = 1 - Math.exp(-psi / 0.12);
    v.fire.visible = fast;
    v.fire.scale.setScalar(fb * (0.25 + fgrow) * (1 + psi * 0.05));
    v.fire.position.set(0, fb * (0.25 + psi * 0.15), 0);
    fm.uHeat.value = Math.exp(-psi / 1.2) * 1.4;
    fm.uTime.value = t;
    fm.uAlpha.value = Math.min(1, 1.1 * Math.exp(-Math.max(0, psi - 0.6) / 1.6));
    // Ejecta: thrown out on ballistic paths at speeds that fall off away from the centre.
    const vScale = Math.sqrt(9.81 * R) * 1.6;
    for (let i = 0; i < v.ejectaLaunch.length; i++) {
      const e = v.ejectaLaunch[i];
      const sp = Math.min(vScale * e.vr, (imp.v || 1) * 0.3);
      const vr = sp * Math.cos(0.8);
      const vy = sp * Math.sin(0.8) * e.vy;
      const T = (2 * vy) / 9.81;
      const tt = Math.min(psi, T);
      const r0 = e.x * R;
      const rr = r0 + vr * tt;
      const y = Math.max(0, vy * tt - 4.905 * tt * tt);
      const sz = R * e.s * (psi > 0 ? 1 : 0);
      tmp.m.compose(
        tmp.a.set(Math.cos(e.ang) * rr, y + sz * 0.5, Math.sin(e.ang) * rr),
        tmp.q.setFromAxisAngle(tmp.b.set(Math.sin(e.spin), 0.5, Math.cos(e.spin)).normalize(), tt * e.spin),
        tmp.c.setScalar(sz),
      );
      v.ejecta.setMatrixAt(i, tmp.m);
    }
    v.ejecta.instanceMatrix.needsUpdate = true;
    const em = v.ejecta.material as THREE.MeshStandardMaterial;
    em.color.copy(dustColour(ground, tmp.col)).multiplyScalar(0.8);
    // Thrown out molten and glowing from a hot impact, cooling as they fly.
    if (fast) blackbody(600 + 1600 * Math.exp(-psi / 1.5), em.emissive).convertSRGBToLinear();
    em.emissiveIntensity = fast ? 2 * Math.exp(-psi / 2) : 0;
    // The ejecta curtain: rises from the rim as the crater opens, then thins and falls back.
    const form = Math.max(0.05, 0.9 * Math.sqrt(cr.diameter / 9.81));
    const Rcur = R * (0.25 + 0.75 * grow);
    const cu = (v.curtain.material as THREE.ShaderMaterial).uniforms;
    const hc = 1.4 * R * Math.sqrt(Math.min(1, psi / form));
    cu.uRb.value = Rcur;
    cu.uRt.value = Rcur + hc;
    cu.uH.value = Math.max(1e-3, hc);
    cu.uAlpha.value = cr.diameter >= 2.5 ? 0.6 * smooth(0, 0.15 * form, psi) * (1 - smooth(0.6 * form, 2.2 * form, psi)) : 0;
    cu.uTime.value = psi;
    dustColour(ground, cu.uColor.value).multiplyScalar(0.75);
    // A rising column over the biggest.
    const co = (v.column.material as THREE.ShaderMaterial).uniforms;
    v.column.visible = E >= 1e12;
    co.uPsi.value = psi;
    co.uH.value = 600 * (E / 4.184e12) ** 0.25;
    co.uR.value = co.uH.value * 0.35;
    dustColour(ground, co.uColor.value).multiplyScalar(fast ? 0.45 : 0.7);
    const du = (v.dust.material as THREE.ShaderMaterial).uniforms;
    du.uPsi.value = psi;
    du.uR.value = R;
    du.uSpeed.value = Math.max(2, Math.min(vScale * 1.2, 400));
    dustColour(ground, du.uColor.value);
    // The shock wave racing outward: dust kicked up along its foot, a faint dome on big ones.
    const Rs = Math.max(R * 1.2, shockRadius(E, psi));
    const ru = (v.ring.material as THREE.ShaderMaterial).uniforms;
    ru.uRb.value = Rs;
    ru.uRt.value = Rs * 1.02;
    ru.uH.value = Math.max(0.3, Math.min(Rs * 0.08, 60));
    ru.uAlpha.value = E > 1e9 ? 0.45 * Math.exp(-psi / 3) * smooth(0, 0.02, psi) : 0;
    dustColour(ground, ru.uColor.value);
    v.dome.scale.setScalar(Rs);
    (v.dome.material as THREE.ShaderMaterial).uniforms.uAlpha.value = E > 1e10 ? 0.16 * Math.exp(-psi / 0.15) * smooth(0, 0.01, psi) : 0;
  }
  // The wreck: worked out while it comes in to land, shown from the moment it touches.
  if (v.wreck) {
    const w = v.wreck;
    w.group.position.set(0, 0, 0).sub(cam);
    const ta = markAt(d, `approach${tag}`);
    if (Number.isFinite(ta) || Number.isFinite(ti)) w.prepare(() => wreckImpact(v, ta, ti));
    if (imp && cr && t >= ti) w.update(psi, grow, dustColour(ground, tmp.col2));
    else {
      if (Number.isFinite(ta)) w.work(6);
      w.warm();
    }
  }
  // What it leaves on the ground, and smoke from a wrecked engine.
  const landed = Boolean(v.wreck && imp && cr && t >= ti);
  u.uScarW.value = landed ? v.wreck!.scar(u.uScar.value) : 0;
  if (landed) v.wreck!.gouges(psi, u.uGouge.value);
  else for (const g of u.uGouge.value as THREE.Vector4[]) g.w = 0;
  // (Drawn throughout, invisible until it starts, so its shader is ready.)
  const sm = (v.smoke.material as THREE.ShaderMaterial).uniforms;
  v.smoke.visible = Boolean(v.wreck);
  sm.uPsi.value = landed && v.wreck!.smokeSource(sm.uSrc.value) ? Math.max(0, psi - 0.3) : 0;
  // An airburst's fireball, high above.
  const tb = markAt(d, `burst${tag}`);
  const ab = v.run.tr.airburst;
  if (ab && Number.isFinite(tb)) {
    const since = t - tb;
    v.burst.visible = since > 0 && since < 25;
    const smp = sampleAt(v.run.tr, ab.t);
    sitePos(v, smp, tmp.a);
    v.burst.position.copy(tmp.a).sub(cam);
    const L = sizeOf(v.run.body.shape) * 7;
    const fire = v.burst.children[0] as THREE.Mesh;
    const fm = (fire.material as THREE.ShaderMaterial).uniforms;
    const grow = 1 - Math.exp(-since / 0.8);
    fire.scale.set(L * (1.5 + 8 * grow), L * (1 + 4 * grow), L * (1 + 4 * grow));
    fm.uHeat.value = 1.6 * Math.exp(-since / 2.2);
    fm.uTime.value = t;
    fm.uAlpha.value = Math.min(1, 1.3 * Math.exp(-since / 12));
    const fl = v.burst.children[1] as THREE.Sprite;
    fl.scale.setScalar(L * 60 * Math.exp(-since / 0.5));
    (fl.material as THREE.SpriteMaterial).opacity = Math.exp(-since / 0.4);
  } else v.burst.visible = false;
}

function dustColour(ground: string, out: THREE.Color): THREE.Color {
  return out.set(ground === 'sand' ? 0xc8a878 : ground === 'soil' ? 0x7a6650 : 0x9a948c).convertSRGBToLinear();
}

/** Sim time from the state (between ticks, as the Director paints it). */
const simTOf = (s: SpaceDropState) => s.sim.simT;

export function drawSpaceDrop(rc: RenderCtx, s: SpaceDropState) {
  const v = view(s, rc.theme);
  const { ctx, width: W, height: H, t } = rc;
  const n = v.vis.length;
  const colW = W / n;
  // The instant replay: each column back to just before its own landing, all in step.
  const r0 = markAt(s.dir, 'replay');
  const replaying = t >= r0 && t < r0 + (n === 1 ? REPLAY.solo : REPLAY.versus);
  for (let k = 0; k < n; k++) {
    const vis = v.vis[k];
    const tag = n === 1 ? '' : String(k);
    const tiK = markAt(s.dir, `impact${tag}`);
    const again = replaying && Number.isFinite(tiK);
    const t = again ? tiK - REPLAY.lead + (rc.t - r0) : rc.t;
    const simT = again ? simTimeAtVideo(s, t) : simTOf(s);
    // Only this column's object and site.
    v.vis.forEach((o, j) => {
      const on = j === k;
      o.holder.visible = on;
      o.ground.visible = on;
      o.clouds.visible = on;
      o.impact.visible = on;
      o.burst.visible = on;
      if (o.trail) o.trail.visible = on;
      if (o.wreck && !on) o.wreck.group.visible = false;
    });
    const pose = poseOf(vis, simT);
    const camOut = { pos: V(), look: V(), shake: 0 };
    // A narrow column needs the camera further back to fit the object across it.
    cameraFor(vis, pose, s.dir, t, tag, camOut, Math.max(1, 9 / 16 / (colW / H)) * (n > 1 ? 0.75 : 1), again);
    // Shake: a quick deterministic jitter.
    if (camOut.shake > 0) camOut.pos.add(tmp.a.set(Math.sin(t * 61.3 + k), Math.sin(t * 47.1 + 2 * k), Math.sin(t * 53.7)).multiplyScalar(camOut.shake));
    const cam = camOut.pos;
    const camAlt =
      cam
        .clone()
        .add(tmp.a.set(0, R_EARTH, 0))
        .length() - R_EARTH;
    const up = tmp.up
      .copy(cam)
      .add(tmp.a.set(0, R_EARTH, 0))
      .normalize();
    const aspect = colW / H;
    const dist = cam.distanceTo(camOut.look);
    placeCamera(v.camNear, cam, camOut.look, up, aspect, Math.max(0.0005, dist * 0.02), Math.max(10, dist * 400), 1);
    placeCamera(v.camMid, cam, camOut.look, up, aspect, Math.max(0.0005, Math.min(camAlt * 0.3, dist * 0.5)), 600000, 1);
    placeCamera(v.camFar, cam, camOut.look, up, aspect, 0.05, 300000, 1);
    updateVis(vis, pose, cam, s.dir, t, tag, v);
    // Light the ground from a glowing object or fireball.
    const glow = { pos: pose.O.clone(), col: new THREE.Color(0, 0, 0) };
    const P = plasmaOf(pose.smp.heat);
    const down = t >= tiK || pose.smp.t >= endTime(vis.run.tr) - 1e-6;
    if (P > 0.05 && !down)
      blackbody(pose.smp.Tshock, glow.col)
        .convertSRGBToLinear()
        .multiplyScalar(P * pose.width * pose.width * 300);
    updateGround(vis, cam, camAlt, simT, s.dir, t, tag, s.p.ground, glow);
    // Far scene in km, camera at the origin.
    const camKm = tmp.b.copy(cam).multiplyScalar(0.001);
    v.earth.position.set(0, -R_EARTH / 1000, 0).sub(camKm);
    (v.atmos.material as THREE.ShaderMaterial).uniforms.uCenter.value.copy(v.earth.position);
    v.atmos.position.copy(v.earth.position);
    (v.atmos.material as THREE.ShaderMaterial).uniforms.uFade.value = smooth(5000, 60000, camAlt);
    const skyU = (v.sky.material as THREE.ShaderMaterial).uniforms;
    skyU.uUp.value.copy(up);
    skyU.uAlt.value = camAlt;
    (v.stars.material as THREE.ShaderMaterial).uniforms.uVis.value = smooth(25000, 70000, camAlt);
    (v.earth.material as THREE.ShaderMaterial).uniforms.uTime.value = simT;
    // Lights: harsh sun in space, softened by sky light low down.
    const dens = Math.exp(-camAlt / 8000);
    v.sunNear.position.copy(v.sun).multiplyScalar(100);
    v.sunNear.target.position.set(0, 0, 0);
    v.hemiNear.intensity = 0.12 + 0.9 * dens;
    v.hemiNear.color.setRGB(0.55, 0.7, 1).lerp(tmp.col.setRGB(0.08, 0.1, 0.16), 1 - dens);
    v.sunMid.position.copy(v.sun).multiplyScalar(100);
    v.sunMid.target.position.set(0, 0, 0);
    v.near.environmentIntensity = 0.25 + 0.5 * dens;
    draw3DLayers(
      ctx,
      v.key,
      [
        { scene: v.far, camera: v.camFar },
        { scene: v.mid, camera: v.camMid },
        { scene: v.near, camera: v.camNear },
      ],
      { exposure: 1.0, bloom: { strength: 0.7, radius: 0.55, threshold: 0.82 }, dest: n === 1 ? undefined : { x: k * colW, y: 0, w: colW, h: H } },
    );
  }
}
