/**
 * The shared kit for Deep Sea Submarine's animals: one creature shader (countershaded skin, optional
 * stripes, spots, light organs or a shell pattern, glow; lit by the water's light and fading into
 * its fog; swimming by tail beat, wing flap or body wave), and where an animal is on its pass.
 *
 * A pass (schedule.ts) carries an animal from the fog ahead to behind the cockpit as the submarine
 * moves; on top of that the animal swims (across, a little along), turned to face where it swims.
 * Its closest approach is kept clear of the dome. Everything is a function of t.
 */
import { THREE } from '../../three-layer';
import { WATER, type WaterUniforms } from '../water';
import { Z_NEAR, hash2, slotPass, slotProgress, slotZ, type Population } from '../schedule';
import { CAMERA } from '../layout';

export interface Fauna {
  group: THREE.Group;
  /** t, the loop length, and how far the submarine has travelled (m). */
  update(t: number, L: number, s: number): void;
}

/** A beat of roughly `hz` that runs a whole number of cycles per loop (radians). */
export const beat = (hz: number, t: number, L: number) => (2 * Math.PI * Math.max(1, Math.round(hz * L)) * t) / L;

export const CREATURE_VERT = /* glsl */ `
uniform float uMode;   // 0 rigid, 1 tail beat (body along +z, tail at -z), 2 wing flap (wings along x), 3 body wave
uniform float uAmp;
uniform float uBeat;   // beat phase (radians)
uniform float uK;      // waves per unit length
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vec3 p = position;
  float inst = 0.0;
#ifdef USE_INSTANCING
  inst = float(gl_InstanceID);
#endif
  if (uMode > 0.5 && uMode < 1.5) {
    float tail = smoothstep(0.15, -0.5, p.z);
    p.x += uAmp * tail * sin(uBeat + inst * 1.7 - p.z * uK);
  } else if (uMode > 1.5 && uMode < 2.5) {
    float w = pow(abs(p.x), 1.4);
    p.y += uAmp * w * sin(uBeat - abs(p.x) * uK);
  } else if (uMode > 2.5) {
    p.x += uAmp * smoothstep(0.35, -1.0, p.z) * sin(uBeat + p.z * uK + inst);
  }
  vLocal = position;
#ifdef USE_INSTANCING
  mat4 m = modelMatrix * instanceMatrix;
#else
  mat4 m = modelMatrix;
#endif
  vec4 w = m * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(m) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const CREATURE_FRAG = /* glsl */ `
${WATER}
uniform vec3 uBack;
uniform vec3 uBelly;
uniform float uPattern;  // 0 plain, 1 stripes, 2 spots, 3 light organs, 4 shell plates
uniform vec3 uPatCol;
uniform float uPatScale;
uniform vec3 uGlowCol;
uniform float uGlow;     // edge glow (bioluminescence)
uniform float uSheen;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  // Countershaded: dark back, pale belly.
  vec3 albedo = mix(uBelly, uBack, smoothstep(-0.4, 0.45, n.y));
  float organs = 0.0;
  if (uPattern > 0.5 && uPattern < 1.5) {
    albedo = mix(albedo, uPatCol, step(0.6, fract(vLocal.z * uPatScale)));
  } else if (uPattern > 1.5 && uPattern < 2.5) {
    vec3 c = vLocal * uPatScale;
    vec3 id = floor(c);
    float h = hash12(id.xz + id.y * 7.0);
    float d = length(fract(c) - 0.5 - (vec3(hash12(id.xy), hash12(id.yz), hash12(id.zx)) - 0.5) * 0.4);
    albedo = mix(albedo, uPatCol, smoothstep(0.24, 0.16, d) * step(0.4, h));
  } else if (uPattern > 2.5 && uPattern < 3.5) {
    // A row of light organs along the belly.
    float row = smoothstep(0.06, 0.0, abs(vLocal.y + 0.12)) * step(0.0, -n.y + 0.3);
    organs = row * smoothstep(0.3, 0.0, abs(fract(vLocal.z * uPatScale) - 0.5));
  } else if (uPattern > 3.5) {
    vec2 c = vLocal.xz * uPatScale;
    vec2 g = abs(fract(c + vec2(0.5 * floor(c.y), 0.0)) - 0.5);
    albedo = mix(albedo * 0.55, albedo, smoothstep(0.42, 0.36, max(g.x, g.y)));
  }
  // The water's own soft light from all round (more where it's bright above).
  vec3 lit = lightAt(vWorld, n) + uTop * 0.9 + vec3(0.004, 0.007, 0.01);
  float spec = pow(max(0.0, dot(reflect(-v, n), vec3(0.0, 1.0, 0.0))), 16.0);
  vec3 col = albedo * lit + (uSunCol * uSun + vec3(0.05)) * spec * uSheen;
  float fres = pow(1.0 - abs(dot(n, v)), 2.5);
  vec3 glow = uGlowCol * (uGlow * fres * 0.5 + organs * 1.6 * max(uGlow, 0.25));
  gl_FragColor = vec4(fogged(col, vWorld) + glow * exp(-length(vWorld - uEye) * uDensity * 0.7), 1.0);
}
`;

export interface CreatureLook {
  back: number[];
  belly: number[];
  mode?: 0 | 1 | 2 | 3;
  amp?: number;
  k?: number;
  pattern?: 0 | 1 | 2 | 3 | 4;
  patCol?: number[];
  patScale?: number;
  glow?: number;
  glowCol?: number[];
  sheen?: number;
}

export function creatureMaterial(U: WaterUniforms, look: CreatureLook) {
  const v3 = (c?: number[]) => new THREE.Vector3(...(c ?? [0, 0, 0]));
  return new THREE.ShaderMaterial({
    vertexShader: CREATURE_VERT,
    fragmentShader: CREATURE_FRAG,
    uniforms: {
      ...U,
      uMode: { value: look.mode ?? 0 },
      uAmp: { value: look.amp ?? 0 },
      uBeat: { value: 0 },
      uK: { value: look.k ?? 4 },
      uBack: { value: v3(look.back) },
      uBelly: { value: v3(look.belly) },
      uPattern: { value: look.pattern ?? 0 },
      uPatCol: { value: v3(look.patCol) },
      uPatScale: { value: look.patScale ?? 4 },
      uGlowCol: { value: v3(look.glowCol ?? [0.4, 0.9, 1.0]) },
      uGlow: { value: look.glow ?? 0 },
      uSheen: { value: look.sheen ?? 0.3 },
    },
    side: THREE.DoubleSide,
  });
}

/** Where a slot's animal is this frame: its pass, how far through it, and its own swimming. */
export interface PassState {
  pass: number;
  /** 0..1 through the window, and seconds since the pass began. */
  u: number;
  tau: number;
  /** Position (m) and the direction it swims (unit, in the water). */
  pos: THREE.Vector3;
  heading: THREE.Vector3;
  /** Per-pass randomness (0..1) for anything else (size, colour…). */
  h(salt: number): number;
  visible: boolean;
}

export interface SwimStyle {
  /** Closest approach to the cockpit's centre line (m): min and extra spread. */
  clear: number;
  spread: number;
  /** Height band around the cockpit (m, below/above eye level). */
  yMin: number;
  yMax: number;
  /** Own swimming speed (m/s) across (any heading) and along the travel. */
  speed: [number, number];
  /**
   * Cross our path this far ahead instead (m, min and max), swimming across it: for fast swimmers,
   * which would otherwise only be in view far off in the fog. `spread` is then how far off the centre
   * line it crosses.
   */
  crossAt?: [number, number];
}

const EYE_Y = CAMERA.pos[1];

/**
 * Where a slot's animal is: carried towards us by the travel, swimming on its own heading, passing
 * the cockpit no closer than `clear` (to the side, or above or below the dome).
 */
export function passState(pop: Population, slot: { phase: number; seed: number }, s: number, D: number, v: number, style: SwimStyle): PassState {
  const W = pop.W;
  const pass = slotPass(slot.phase, W, s, D);
  const u = slotProgress(slot.phase, W, s);
  const tau = (u * W) / v;
  const h = (salt: number) => hash2(slot.seed + salt * 7919, pass);
  // Its own swimming: a heading in the water (mostly across our path), at a cruising speed.
  const ang = style.crossAt ? (h(1) < 0.5 ? 0 : Math.PI) + (h(8) - 0.5) * 0.8 : h(1) * Math.PI * 2;
  const sp = style.speed[0] + h(2) * (style.speed[1] - style.speed[0]);
  const climb = (h(3) - 0.5) * 0.25;
  // Along the travel it may drift towards us, but hardly away: an animal swimming away would still be
  // in view when its slot wraps (it must be behind us by then).
  const vzMin = -(Z_NEAR - 4) / (W / v);
  const heading = new THREE.Vector3(Math.cos(ang), climb, Math.sin(ang) * 0.6).normalize();
  if (heading.z * sp < vzMin) {
    heading.z = vzMin / sp;
    heading.normalize();
  }
  // When it comes level with us (z = 0), or reaches its crossing ahead, and where it is then: clear of
  // the dome.
  const zt = slotZ(slot.phase, W, s);
  const vz = Math.max(vzMin, heading.z * sp);
  const zc = style.crossAt ? -(style.crossAt[0] + h(9) * (style.crossAt[1] - style.crossAt[0])) : 0;
  const tauC = Math.max(0, (W - Z_NEAR + zc) / Math.max(0.05, v + vz));
  const side = h(4) < 0.5 ? -1 : 1;
  const r = style.clear + h(5) * style.spread;
  const yc = EYE_Y + style.yMin + h(6) * (style.yMax - style.yMin);
  // Above or below the dome is clear too; otherwise go round the side.
  const xc = style.crossAt ? (h(7) - 0.5) * 2 * style.spread : Math.abs(yc - EYE_Y) > style.clear ? (h(7) - 0.5) * 2 * r : side * r;
  const dt = tau - tauC;
  const pos = new THREE.Vector3(xc + heading.x * sp * dt, yc + heading.y * sp * dt, zt + vz * tau);
  return { pass, u, tau, pos, heading, h, visible: pos.z < 6 && pos.z > -75 && Math.abs(pos.x) < 60 };
}

/** Turn an object so its +z faces `heading` (with its back up). */
export function face(o: THREE.Object3D, heading: THREE.Vector3) {
  o.lookAt(o.position.clone().add(heading));
}
