/**
 * Day Train's world, shared by every shader outside the window: where things are along the ring of
 * track, the lie of the land (one height function, used by the terrain, the trees and the buildings
 * alike, so everything sits on the same ground), the sun, the sky's light and the haze.
 *
 * Along the track a point at world x is at ring position p = uS + uDir · x (uS, the distance
 * travelled; uDir mirrors the world when the train runs the other way across the window). Across it
 * is d metres out from our track. The land is noise sampled on a cylinder round the ring (around:
 * p, along its axis: d), so it closes on itself after one loop, D metres, and never visibly repeats
 * within it.
 */
import { THREE } from '../three-layer';
import { FBM4, HASH, NOISE4 } from '../ambient/glsl';
import { CAMERA, GROUND_Y } from '../night-train/layout';

/** Our track's centre line (world z); the window looks out towards -z. */
export const TRACK_Z = 0.4;
/** Far features (towns on hills, castles, cities, river valleys) the land is shaped for at once. */
export const MAX_FAR = 6;
/** Near features (stations, crossings, tunnels) that shape the ground by the line. */
export const MAX_NEAR = 4;
/** Villages and farms near the window (trees keep out of them). */
export const MAX_VIL = 12;
/** How far along the track (m, either way) far features stay in the land's list. */
export const FAR_RANGE = 5400;

export const FAR_KIND = { hill: 1, valley: 2 } as const;
export const NEAR_KIND = { station: 1, crossing: 2, bridge: 3, tunnel: 4 } as const;

export const WORLD = /* glsl */ `
${HASH}
${NOISE4}
${FBM4}
uniform float uS;         // distance travelled, wrapped to [0, D)
uniform float uD;         // ring length (m)
uniform float uDir;       // +1: the train runs to the right across the window
uniform float uPhase;     // t / loopS
uniform float uLoop;
uniform vec2 uTC;         // time circle (slow animation that repeats every loop)
uniform vec3 uEye;
uniform vec3 uSunDir;     // towards the sun
uniform vec3 uSunCol;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uHazeCol;
uniform float uHaze;      // haze density (1/m)
uniform float uRain;      // 0 sunny .. 1 overcast and wet
uniform float uBlur;      // metres the train moves during the shutter
uniform vec4 uFar[${MAX_FAR}];   // kind, along (m from the window), out (m), radius
uniform vec4 uFar2[${MAX_FAR}];  // height (m), seed, -, -
uniform vec4 uNear[${MAX_NEAR}]; // kind, start, end (m along from the window), seed
uniform vec4 uVil[${MAX_VIL}];   // villages and farms: along (m from the window), out, radius, -

const float GROUND_Y = ${GROUND_Y.toFixed(3)};
const float TRACK_Z = ${TRACK_Z.toFixed(3)};
const float TAU = 6.28318530718;

// Ring position of world x, and back.
float ringAt(float x) { return uS + uDir * x; }
float worldX(float p) { float r = mod(p - uS + 0.5 * uD, uD) - 0.5 * uD; return uDir * r; }
// Distance out from our track of world z, and back.
float outAt(float z) { return TRACK_Z - z; }

// A point for noise at ring position p, d metres out, k noise units per metre (the cylinder).
vec4 cyl(float p, float d, float k, float seed) {
  float a = TAU * p / uD;
  float R = k * uD / TAU;
  return vec4(R * cos(a), R * sin(a), d * k, seed);
}

// The rolling land before features: a valley floor by the line, hills behind, ridges far off.
float landBase(float p, float d) {
  float big = fbm4(cyl(p, d, 1.0 / 900.0, 1.3), 3);
  float mid = fbm4(cyl(p, d, 1.0 / 230.0, 7.7), 2);
  float sml = snoise(cyl(p, d, 1.0 / 60.0, 3.1));
  float ridge = 1.0 - abs(fbm4(cyl(p, d, 1.0 / 1700.0, 11.0), 2));
  return 95.0 * smoothstep(30.0, 700.0, d) * (0.75 * big + 0.3)
       + 20.0 * smoothstep(15.0, 220.0, d) * mid
       + 1.6 * smoothstep(8.0, 60.0, d) * sml
       + 190.0 * smoothstep(1300.0, 3800.0, d) * ridge * ridge;
}

// The land's broad shape alone (its largest hills and ridges): what a hill for a town rises from.
float landLow(float p, float d) {
  float big = snoise(cyl(p, d, 1.0 / 900.0, 1.3));
  float ridge = 1.0 - abs(snoise(cyl(p, d, 1.0 / 1700.0, 11.0)));
  return 95.0 * smoothstep(30.0, 700.0, d) * (0.75 * 0.55 * big + 0.3) + 190.0 * smoothstep(1300.0, 3800.0, d) * ridge * ridge * 0.6;
}

// Where a river crosses under a bridge and winds away (m along, at d metres out).
float riverAlong(vec4 f, vec4 f2, float d) { return f.y + 70.0 * sin(d / 260.0 + f2.y * 6.0) + 25.0 * sin(d / 97.0 + f2.y * 13.0); }

// Height of the land (world y) at ring position p, d metres out.
float landY(float p, float d) {
  float rel = mod(p - uS + 0.5 * uD, uD) - 0.5 * uD;
  float h = landBase(p, d);
  for (int i = 0; i < ${MAX_FAR}; i++) {
    vec4 f = uFar[i];
    vec4 f2 = uFar2[i];
    if (f.x < 0.5) continue;
    if (f.x < 1.5) {
      // A hill for a town or castle: a broad top its height above the land round it, its shoulders
      // easing into the land.
      float r = length(vec2(rel - f.y, d - f.z));
      if (r < f.w) {
        float g = smoothstep(f.w, f.w * 0.35, r);
        float top = landLow(uS + f.y, f.z) + f2.x;
        h = mix(h, top + 0.06 * (h - top), g);
      }
    } else {
      // A river valley, widening away from the line.
      float w = f.w + d * 0.1;
      float g = exp(-pow((rel - riverAlong(f, f2, d)) / w, 2.0));
      h = mix(h, -17.0, g);
    }
  }
  float bridge = 0.0;
  for (int i = 0; i < ${MAX_NEAR}; i++) {
    vec4 f = uNear[i];
    if (f.x < 0.5) continue;
    float m = smoothstep(f.y - 90.0, f.y - 20.0, rel) * (1.0 - smoothstep(f.z + 20.0, f.z + 90.0, rel));
    // A tunnel goes under a hill; stations and crossings sit on level ground; on a bridge the
    // ground falls away just past the other line.
    if (f.x > 3.5) h = max(h, 34.0 * m * smoothstep(260.0, 50.0, d));
    else if (f.x > 2.5) bridge = max(bridge, smoothstep(f.y - 6.0, f.y + 2.0, rel) * (1.0 - smoothstep(f.z - 2.0, f.z + 6.0, rel)));
    else h = mix(h, 0.0, m * smoothstep(140.0, 50.0, d));
  }
  // The embankment: ballast by the line, the ground a little below it beyond.
  float ground = GROUND_Y - 0.9 + h;
  return mix(GROUND_Y - 0.25, ground, smoothstep(mix(5.0, 5.6, bridge), mix(13.0, 6.4, bridge), d));
}

// The patchwork of fields: fields about 120 m across (cells that divide the ring), edges warped a
// little. Returns the field's hash; hedge is 1 on the hedgerow between fields.
float fieldAt(float p, float d, out float hedge) {
  float wp = p + 18.0 * snoise(cyl(p, d, 1.0 / 140.0, 51.0));
  float wd = d + 18.0 * snoise(cyl(p, d, 1.0 / 140.0, 57.0));
  float c = 120.0;
  float ip = mod(floor(wp / c), uD / c);
  float id = floor(wd / c);
  vec2 f = vec2(fract(wp / c), fract(wd / c));
  vec2 e = min(f, 1.0 - f) * c;
  hedge = 1.0 - smoothstep(1.2, 3.2, min(e.x, e.y));
  return hash12(vec2(ip, id));
}

// Woodland: where there are woods (0..1), from the same land.
float woods(float p, float d) {
  float n = fbm4(cyl(p, d, 1.0 / 420.0, 21.0), 2);
  return smoothstep(0.12, 0.38, n);
}

// The haze between the eye and a point: towards the sky's colour by the horizon, warmer towards the sun.
vec3 hazed(vec3 col, vec3 world) {
  vec3 v = world - uEye;
  float dist = length(v);
  vec3 dir = v / max(dist, 1e-3);
  float f = 1.0 - exp(-dist * uHaze);
  float glow = pow(max(dot(dir, uSunDir), 0.0), 6.0) * (1.0 - uRain);
  vec3 hz = mix(uHazeCol, uSunCol * 0.55, glow * 0.6);
  return mix(col, hz, f);
}

// Soft painterly light on a surface: sunlight wrapped round by \`wrap\` (shadow 0..1), the sky's
// light from above.
vec3 litWrap(vec3 albedo, vec3 n, float shadow, float ao, float wrap) {
  float w = clamp((dot(n, uSunDir) + wrap) / (1.0 + wrap), 0.0, 1.0);
  vec3 sun = uSunCol * w * shadow;
  vec3 sky = mix(uSkyHorizon, uSkyTop, 0.5 + 0.5 * n.y) * 0.45 * ao;
  // Warm light bounced off the sunlit grass onto walls and the undersides of things.
  vec3 bounce = vec3(0.32, 0.36, 0.16) * uSunCol * 0.12 * (0.5 - 0.5 * n.y) * ao;
  return albedo * (sun + sky + bounce);
}
vec3 lit(vec3 albedo, vec3 n, float shadow, float ao) { return litWrap(albedo, n, shadow, ao, 0.3); }
`;

export type Mode = 'midday' | 'golden' | 'rain';

export interface Light {
  sunDir: [number, number, number];
  sunCol: [number, number, number];
  skyTop: [number, number, number];
  skyHorizon: [number, number, number];
  hazeCol: [number, number, number];
  haze: number;
  rain: number;
  /** Cloud cover 0..1 (rain: a full deck). */
  clouds: number;
}

const norm = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const mul = (c: [number, number, number], k: number): [number, number, number] => [c[0] * k, c[1] * k, c[2] * k];

/** The light of each kind of day (linear colours). The sun is out beyond the window, to the right. */
export const LIGHTS: Record<Mode, Light> = {
  midday: {
    sunDir: norm([0.35, 0.82, -0.45]),
    sunCol: mul([1.0, 0.95, 0.86], 1.75),
    skyTop: [0.07, 0.2, 0.6],
    skyHorizon: [0.4, 0.56, 0.82],
    hazeCol: [0.58, 0.7, 0.88],
    haze: 0.0002,
    rain: 0,
    clouds: 0.42,
  },
  golden: {
    sunDir: norm([0.9, 0.18, -0.42]),
    sunCol: mul([1.0, 0.7, 0.42], 2.2),
    skyTop: [0.2, 0.3, 0.58],
    skyHorizon: [0.98, 0.74, 0.5],
    hazeCol: [0.86, 0.68, 0.54],
    haze: 0.00028,
    rain: 0,
    clouds: 0.34,
  },
  rain: {
    sunDir: norm([0.2, 0.9, -0.4]),
    sunCol: mul([0.55, 0.58, 0.6], 0.42),
    skyTop: [0.34, 0.38, 0.43],
    skyHorizon: [0.48, 0.52, 0.55],
    hazeCol: [0.47, 0.51, 0.55],
    haze: 0.0009,
    rain: 1,
    clouds: 1,
  },
};

const EYE = new THREE.Vector3(...CAMERA.pos);

/** The world's uniforms (one set, shared by every outside material). */
export function worldUniforms() {
  const v3 = () => new THREE.Vector3();
  return {
    uS: { value: 0 },
    uD: { value: 1 },
    uDir: { value: 1 },
    uPhase: { value: 0 },
    uLoop: { value: 1 },
    uTC: { value: new THREE.Vector2() },
    uEye: { value: EYE.clone() },
    uSunDir: { value: v3() },
    uSunCol: { value: v3() },
    uSkyTop: { value: v3() },
    uSkyHorizon: { value: v3() },
    uHazeCol: { value: v3() },
    uHaze: { value: 0.0003 },
    uRain: { value: 0 },
    uBlur: { value: 0 },
    uFar: { value: Array.from({ length: MAX_FAR }, () => new THREE.Vector4()) },
    uFar2: { value: Array.from({ length: MAX_FAR }, () => new THREE.Vector4()) },
    uNear: { value: Array.from({ length: MAX_NEAR }, () => new THREE.Vector4()) },
    uVil: { value: Array.from({ length: MAX_VIL }, () => new THREE.Vector4()) },
  };
}
export type WorldUniforms = ReturnType<typeof worldUniforms>;

export function setLight(U: WorldUniforms, l: Light) {
  U.uSunDir.value.set(...l.sunDir);
  U.uSunCol.value.set(...l.sunCol);
  U.uSkyTop.value.set(...l.skyTop);
  U.uSkyHorizon.value.set(...l.skyHorizon);
  U.uHazeCol.value.set(...l.hazeCol);
  U.uHaze.value = l.haze;
  U.uRain.value = l.rain;
}

/** A far feature as the land sees it: kind, along (m from the window), out, radius; height, seed. */
export interface FarShape {
  kind: number;
  along: number;
  out: number;
  radius: number;
  height: number;
  seed: number;
}
/** A near feature: kind, start and end (m along from the window), seed. */
export interface NearShape {
  kind: number;
  rel0: number;
  rel1: number;
  seed: number;
}

export function setFeatures(U: WorldUniforms, far: FarShape[], near: NearShape[], villages: [number, number, number][]) {
  U.uVil.value.forEach((v, i) => {
    const f = villages[i];
    if (f) v.set(f[0], f[1], f[2], 0);
    else v.set(0, 0, -1, 0);
  });
  U.uFar.value.forEach((v, i) => {
    const f = far[i];
    if (f) v.set(f.kind, f.along, f.out, f.radius);
    else v.set(0, 0, 0, 1);
  });
  U.uFar2.value.forEach((v, i) => {
    const f = far[i];
    if (f) v.set(f.height, f.seed, 0, 0);
    else v.set(0, 0, 0, 0);
  });
  U.uNear.value.forEach((v, i) => {
    const f = near[i];
    if (f) v.set(f.kind, f.rel0, f.rel1, f.seed);
    else v.set(0, 0, 0, 0);
  });
}
