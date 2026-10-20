/**
 * The water outside the dome: its colour by depth and view direction, distance fog, sunlight from
 * above (and the reef's caustics), the submarine's twin headlights, shafts of light, marine snow
 * streaming towards us, the headlights' beams and bubbles venting from the hull. WATER is the shared
 * GLSL every outside shader uses.
 */
import { THREE } from '../three-layer';
import { CAUSTICS, HASH, NOISE4 } from '../ambient/glsl';
import { LAMPS, NOSE_Z, SEABED_Y } from './layout';
import type { Depth } from './schedule';

/** Per depth: water colour looking up and down, fog density, sunlight, shafts, caustics. */
export const ZONES: Record<Depth, { top: number[]; bottom: number[]; density: number; sun: number; sunCol: number[]; rays: number; caustics: number; flood: number }> = {
  twilight: { top: [0.016, 0.06, 0.1], bottom: [0.001, 0.006, 0.014], density: 0.05, sun: 0.22, sunCol: [0.35, 0.65, 0.9], rays: 0.25, caustics: 0, flood: 0.55 },
  abyss: { top: [0.0015, 0.004, 0.009], bottom: [0.0, 0.0005, 0.0015], density: 0.075, sun: 0.0, sunCol: [0.3, 0.5, 0.8], rays: 0, caustics: 0, flood: 1 },
  reef: { top: [0.09, 0.32, 0.38], bottom: [0.012, 0.08, 0.12], density: 0.04, sun: 1.0, sunCol: [0.75, 0.95, 1.0], rays: 0.7, caustics: 1, flood: 0.08 },
};

export const WATER = /* glsl */ `
${HASH}
${NOISE4}
${CAUSTICS}
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uDensity;
uniform float uSun;
uniform vec3 uSunCol;
uniform float uCaust;
uniform float uFloodOn;
uniform vec3 uFloodPos;   // the left headlight
uniform vec3 uFloodPos2;  // the right one
uniform vec3 uFloodDir;   // where both point
uniform vec3 uEye;
uniform vec2 uTC;
uniform float uPhase;
uniform float uLoop;
vec3 waterColor(vec3 dir) { return mix(uBottom, uTop, smoothstep(-0.7, 0.9, dir.y)); }
vec3 fogged(vec3 col, vec3 p) {
  vec3 d = p - uEye;
  float dist = length(d);
  return mix(col, waterColor(d / dist), 1.0 - exp(-dist * uDensity));
}
// How much of the headlights reaches p (two soft cones, falling off with distance).
float lampCone(vec3 p, vec3 at) {
  vec3 d = p - at;
  float dist = length(d);
  float c = dot(d / dist, uFloodDir);
  return smoothstep(0.84, 0.97, c) / (1.0 + 0.03 * dist * dist);
}
float flood(vec3 p) { return uFloodOn * 0.6 * (lampCone(p, uFloodPos) + lampCone(p, uFloodPos2)); }
// Light on a surface at p facing n: sunlight from above (with caustics), the floodlight.
vec3 lightAt(vec3 p, vec3 n) {
  float up = max(0.0, n.y * 0.75 + 0.25);
  // Sunlight dims with depth below the station.
  float sun = uSun * up * exp(-max(0.0, 2.0 - p.y) * 0.04);
  float caus = uCaust > 0.0 ? 0.4 + 1.6 * causticsLoop(p.xz * 0.55 + vec2(p.y * 0.2), uTC) : 1.0;
  vec3 l = uSunCol * sun * caus;
  vec3 toF = normalize(0.5 * (uFloodPos + uFloodPos2) - p);
  l += vec3(1.0, 0.94, 0.82) * flood(p) * max(0.0, dot(n, toF) * 0.8 + 0.2) * 2.4;
  return l;
}
`;

export function waterUniforms(depth: Depth, eye: THREE.Vector3) {
  const z = ZONES[depth];
  const fp = new THREE.Vector3(...LAMPS.pos[0]);
  const fp2 = new THREE.Vector3(...LAMPS.pos[1]);
  return {
    uTop: { value: new THREE.Vector3(...z.top) },
    uBottom: { value: new THREE.Vector3(...z.bottom) },
    uDensity: { value: z.density },
    uSun: { value: z.sun },
    uSunCol: { value: new THREE.Vector3(...z.sunCol) },
    uCaust: { value: z.caustics },
    uFloodOn: { value: 0 },
    uFloodPos: { value: fp },
    uFloodPos2: { value: fp2 },
    uFloodDir: { value: new THREE.Vector3(...LAMPS.aim).sub(fp.clone().add(fp2).multiplyScalar(0.5)).normalize() },
    uEye: { value: eye.clone() },
    uTC: { value: new THREE.Vector2() },
    uPhase: { value: 0 },
    uLoop: { value: 1 },
  };
}
export type WaterUniforms = ReturnType<typeof waterUniforms>;

const VERT = /* glsl */ `
varying vec3 vWorld;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// ---- the open water behind everything --------------------------------------------------------------
const BACK_FRAG = /* glsl */ `
${WATER}
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld - uEye);
  vec3 col = waterColor(d);
  // Faint suspended haze, drifting.
  col *= 0.92 + 0.08 * snoise(vec4(d * 6.0, uTC * 0.3));
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---- shafts of light from the surface (additive, slanted sheets) -------------------------------------
const RAYS_FRAG = /* glsl */ `
${WATER}
varying vec3 vWorld;
varying vec2 vUv;
uniform float uStrength;
uniform float uSeed;
void main() {
  // Bands across the sheet, slowly shifting (on the time circle), fading at its ends and sides.
  float n = snoise(vec4(vUv.x * 7.0, uSeed, uTC * 0.6));
  float bands = pow(max(0.0, n), 2.0) * 0.8 + pow(max(0.0, snoise(vec4(vUv.x * 19.0, uSeed + 4.0, uTC))), 3.0) * 0.4;
  float fade = smoothstep(0.0, 0.35, vUv.y) * smoothstep(0.0, 0.15, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
  vec3 col = uSunCol * bands * fade * uStrength;
  // Added light, so the fog only dims it with distance.
  gl_FragColor = vec4(col * exp(-length(vWorld - uEye) * uDensity), 1.0);
}
`;

// ---- marine snow (points falling a whole number of times per loop) ------------------------------------
const SNOW_VERT = /* glsl */ `
${WATER}
attribute vec4 aSnow;   // speed (cycles/loop), phase, size, drift
uniform vec3 uBox0;
uniform vec3 uBox1;
uniform float uS;       // how far we have travelled (m): the snow streams towards us
varying float vLight;
varying vec3 vWorld;
void main() {
  vec3 size = uBox1 - uBox0;
  vec3 p = position;
  p.y = uBox0.y + mod(p.y - uBox0.y - aSnow.x * size.y * uPhase - aSnow.y * size.y, size.y);
  p.z = uBox0.z + mod(p.z - uBox0.z + uS, size.z);
  p.x += 0.25 * sin(6.28318 * (floor(aSnow.w * 4.0) + 1.0) * uPhase + aSnow.y * 20.0);
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vLight = 0.08 + flood(w.xyz) * 4.0 + uSun * 0.35;
  vec4 mv = viewMatrix * w;
  gl_PointSize = aSnow.z * 900.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const SNOW_FRAG = /* glsl */ `
${WATER}
varying float vLight;
varying vec3 vWorld;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.1, length(c));
  vec3 col = vec3(0.75, 0.8, 0.82) * vLight * a;
  float fogK = exp(-length(vWorld - uEye) * uDensity);
  gl_FragColor = vec4(col * fogK, 1.0);
}
`;

// ---- the floodlight's beam through the water (additive) ----------------------------------------------
const BEAM_FRAG = /* glsl */ `
${WATER}
varying vec3 vWorld;
void main() {
  // Light scattered by the water in the beams: none right at the lamps (they're under the dome's
  // rim), building up a metre or two out, then fading with distance.
  float near = smoothstep(0.8, 3.5, length(vWorld - 0.5 * (uFloodPos + uFloodPos2)));
  vec3 col = vec3(0.6, 0.62, 0.6) * flood(vWorld) * 0.07 * near;
  gl_FragColor = vec4(col * exp(-length(vWorld - uEye) * uDensity * 0.5), 1.0);
}
`;

// ---- bubbles from the vent (one stream at a time) -------------------------------------------------------
const BUBBLE_VERT = /* glsl */ `
${WATER}
attribute vec3 aBubble;   // emit fraction, size, wobble phase
uniform float uT;         // seconds since the stream started (-1: none)
uniform float uEmitS;     // how long it emits
uniform vec3 uFrom;
uniform float uV;         // our speed: bubbles stream back past the dome as they rise
varying float vAlpha;
varying vec3 vWorld;
void main() {
  float age = uT - aBubble.x * uEmitS;
  vAlpha = uT < 0.0 || age < 0.0 || age > 8.0 ? 0.0 : smoothstep(0.0, 0.3, age) * smoothstep(8.0, 6.5, age);
  vec3 p = uFrom + vec3(0.12 * sin(age * 5.0 + aBubble.z * 6.28) + (aBubble.z - 0.5) * 0.3, age * (0.7 + aBubble.y * 2.0), -0.1 * aBubble.z + uV * age);
  vec4 w = vec4(p, 1.0);
  vWorld = p;
  vec4 mv = viewMatrix * w;
  gl_PointSize = (0.02 + aBubble.y * 0.05) * 900.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const BUBBLE_FRAG = /* glsl */ `
${WATER}
varying float vAlpha;
varying vec3 vWorld;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  // A bright rim and a highlight: a bubble catches the light round its edge.
  float rim = smoothstep(0.5, 0.42, r) * smoothstep(0.28, 0.44, r);
  float spec = smoothstep(0.12, 0.0, length(c - vec2(-0.14, -0.14)));
  vec3 l = 0.15 + uSunCol * uSun + vec3(1.0) * flood(vWorld) * 3.0 + vec3(1.0, 0.8, 0.6) * 0.25;
  gl_FragColor = vec4(l * (rim * 0.5 + spec) * vAlpha, 1.0);
}
`;

export interface Water {
  group: THREE.Group;
  /** snow: 0..1 how much marine snow shows; flood: whether the headlights' beams show. */
  update(o: { t: number; L: number; s: number; v: number; bubbleT: number; bubbleEmitS: number; bubbleFrom: [number, number, number]; snow: number; flood: boolean }): void;
}

export function buildWater(depth: Depth, U: WaterUniforms, opts: { seed: number }): Water {
  const group = new THREE.Group();
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;

  const back = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: BACK_FRAG, uniforms: U, side: THREE.BackSide, depthWrite: false }));
  back.renderOrder = -10;
  group.add(back);

  // Shafts of sunlight: slanted sheets coming down from the surface (none in the abyss).
  const z = ZONES[depth];
  if (z.rays > 0) {
    for (let i = 0; i < 6; i++) {
      const u = { ...U, uStrength: { value: z.rays * (0.5 + 0.5 * ((i * 37) % 10) / 10) }, uSeed: { value: i * 3.1 + opts.seed * 0.001 } };
      const m = new THREE.Mesh(new THREE.PlaneGeometry(14, 30), new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: RAYS_FRAG, uniforms: u, ...add, side: THREE.DoubleSide }));
      m.position.set(-10 + i * 4, 8, NOSE_Z - 7 - i * 4);
      m.rotation.set(0, 0.3 * (i % 2 ? 1 : -1), 0.25);
      m.renderOrder = 4;
      group.add(m);
    }
  }

  // Marine snow in front of the porthole: denser close up, falling slowly. Built at its densest;
  // the setting draws a share of it (the particles are in random order, so any share is even).
  const n = 9000;
  const shown = (snow: number) => Math.round(2000 + 7000 * snow);
  const pos = new Float32Array(n * 3);
  const attr = new Float32Array(n * 4);
  let s = opts.seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  // 20 m deep, just beyond the dome: the travel per loop is a whole number of these, so the snow
  // comes round exactly.
  const box0 = new THREE.Vector3(-9, SEABED_Y, NOSE_Z - 20.15);
  const box1 = new THREE.Vector3(9, 7, NOSE_Z - 0.15);
  for (let i = 0; i < n; i++) {
    const zz = rnd();
    pos[i * 3] = box0.x + (box1.x - box0.x) * rnd();
    pos[i * 3 + 1] = box0.y + (box1.y - box0.y) * rnd();
    pos[i * 3 + 2] = box1.z + (box0.z - box1.z) * zz * zz;
    // Falls about 2–8 cm a second: whole box heights per loop are set in the shader from cycles.
    attr[i * 4] = 0; // set below once L is known
    attr[i * 4 + 1] = rnd();
    attr[i * 4 + 2] = 0.006 + 0.016 * rnd() * rnd();
    attr[i * 4 + 3] = rnd();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const snowAttr = new THREE.BufferAttribute(attr, 4);
  geo.setAttribute('aSnow', snowAttr);
  const snowU = { ...U, uBox0: { value: box0 }, uBox1: { value: box1 }, uS: { value: 0 } };
  const snow = new THREE.Points(geo, new THREE.ShaderMaterial({ vertexShader: SNOW_VERT, fragmentShader: SNOW_FRAG, uniforms: snowU, ...add }));
  snow.frustumCulled = false;
  snow.renderOrder = 6;
  group.add(snow);
  let snowFor = -1;

  // The headlights' beams: long cones through the water ahead (shown when the lights are on).
  const beams: THREE.Mesh[] = [];
  if (z.flood > 0) {
    const to = new THREE.Vector3(...LAMPS.aim);
    for (const at of LAMPS.pos) {
      const from = new THREE.Vector3(...at);
      const len = from.distanceTo(to) * 1.5;
      // Wider than the light itself: the shader's soft cone sets the beam's edge, not the mesh.
      const cone = new THREE.Mesh(new THREE.ConeGeometry(len * 0.75, len, 48, 1, true), new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: BEAM_FRAG, uniforms: U, ...add, side: THREE.DoubleSide }));
      // The cone's apex at the lamp, opening ahead.
      const dir = to.clone().sub(from).normalize();
      cone.position.copy(from).addScaledVector(dir, len / 2);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      cone.renderOrder = 5;
      group.add(cone);
      beams.push(cone);
    }
  }

  // Bubbles: 90 per stream.
  const nb = 90;
  const bpos = new Float32Array(nb * 3);
  const battr = new Float32Array(nb * 3);
  for (let i = 0; i < nb; i++) {
    battr[i * 3] = i / nb;
    battr[i * 3 + 1] = rnd();
    battr[i * 3 + 2] = rnd();
  }
  const bgeo = new THREE.BufferGeometry();
  bgeo.setAttribute('position', new THREE.BufferAttribute(bpos, 3));
  bgeo.setAttribute('aBubble', new THREE.BufferAttribute(battr, 3));
  const bubbleU = { ...U, uT: { value: -1 }, uEmitS: { value: 6 }, uFrom: { value: new THREE.Vector3() }, uV: { value: 0 } };
  const bubbles = new THREE.Points(bgeo, new THREE.ShaderMaterial({ vertexShader: BUBBLE_VERT, fragmentShader: BUBBLE_FRAG, uniforms: bubbleU, ...add }));
  bubbles.frustumCulled = false;
  bubbles.renderOrder = 7;
  group.add(bubbles);

  return {
    group,
    update({ t, L, s, v, bubbleT, bubbleEmitS, bubbleFrom, snow: snowAmount, flood }) {
      geo.setDrawRange(0, shown(snowAmount));
      for (const b of beams) b.visible = flood;
      snowU.uS.value = s;
      bubbleU.uV.value = v;
      if (snowFor !== L) {
        // Whole box heights per loop at 2–8 cm/s.
        const h = box1.y - box0.y;
        for (let i = 0; i < n; i++) attr[i * 4] = Math.max(1, Math.round(((0.02 + 0.06 * attr[i * 4 + 3]) * L) / h));
        snowAttr.needsUpdate = true;
        snowFor = L;
      }
      bubbleU.uT.value = bubbleT;
      bubbleU.uEmitS.value = bubbleEmitS;
      bubbleU.uFrom.value.set(...bubbleFrom);
    },
  };
}
