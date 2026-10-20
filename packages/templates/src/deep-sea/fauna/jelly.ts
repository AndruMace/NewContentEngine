/**
 * Jellyfish: few of them, swimming properly. Each pulse is a quick contraction and a slow relaxation;
 * the contraction pushes the bell along its own axis, which tilts and turns slowly, so a jellyfish
 * climbs in steps along a wandering curve, sinking a little between pulses and spinning gently. Its
 * tentacles and frilly oral arms trail behind, rippling with each pulse and lagging when it moves.
 */
import { THREE } from '../../three-layer';
import { WATER, type WaterUniforms } from '../water';
import type { Depth, Population } from '../schedule';
import { beat, passState, type Fauna } from './kit';

/** One jellyfish's swimming over a pass: offset from its pass position (m), how contracted it is, its axis. */
export function jellySwim(j: { seed: number; pulseHz: number }, tau: number) {
  const r = (k: number) => {
    const x = Math.sin(j.seed * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const ph0 = r(1);
  const n = j.pulseHz * tau + ph0;
  const phase = n - Math.floor(n);
  // Contraction: sharp (first fifth of the cycle), then a slow relaxation.
  const pulse = phase < 0.2 ? Math.sin((phase / 0.2) * (Math.PI / 2)) : 1 - smooth(0.2, 0.55, phase);
  // Its axis tilts and turns slowly.
  const axisAt = (tt: number) => {
    const tilt = 0.25 + 0.3 * Math.sin(0.05 * tt + r(2) * 6.28);
    const turn = r(3) * 6.28 + 0.035 * tt;
    return [Math.sin(tilt) * Math.cos(turn), Math.cos(tilt), Math.sin(tilt) * Math.sin(turn)];
  };
  // Each pulse pushes it 12–18 cm along its axis at that moment; the push lasts into the relaxation.
  const step = 0.12 + 0.06 * r(4);
  const pos = [0, 0, 0];
  const done = Math.floor(n);
  for (let k = Math.floor(ph0); k < done; k++) {
    const a = axisAt((k + 0.25 - ph0) / j.pulseHz);
    for (let i = 0; i < 3; i++) pos[i] += a[i] * step;
  }
  const a = axisAt(tau);
  const push = smooth(0.03, 0.5, phase);
  for (let i = 0; i < 3; i++) pos[i] += a[i] * step * push;
  // Sinking slowly between pulses.
  pos[1] -= 0.025 * tau;
  return { pos, pulse, axis: a, spin: r(5) * 6.28 + 0.08 * tau };
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const BELL_VERT = /* glsl */ `
uniform float uPulse;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vLocal = position;
  vec3 p = position;
  float rim = smoothstep(0.0, -0.6, p.y);
  p.xz *= 1.0 - 0.22 * uPulse * (0.35 + 0.65 * rim);
  p.y *= 1.0 + 0.12 * uPulse;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const BELL_FRAG = /* glsl */ `
${WATER}
uniform vec3 uColor;
uniform float uGlow;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vec3 v = normalize(uEye - vWorld);
  float fres = pow(1.0 - abs(dot(normalize(vNormal), v)), 2.2);
  float a = atan(vLocal.z, vLocal.x);
  float canals = 0.5 + 0.5 * cos(a * 8.0);
  // The gonads: four soft horseshoes seen through the bell.
  float gonads = smoothstep(0.2, 0.0, abs(length(vLocal.xz) - 0.35)) * (0.5 + 0.5 * cos(a * 4.0)) * step(0.1, vLocal.y);
  vec3 lit = lightAt(vWorld, vec3(0.0, 1.0, 0.0)) + vec3(0.02, 0.03, 0.04);
  vec3 col = uColor * (fres * 0.9 + 0.1 + 0.1 * canals + 0.4 * gonads) * lit;
  col += uColor * uGlow * (fres * 0.6 + 0.12 * canals + 0.3 * gonads) * (0.6 + 0.4 * smoothstep(0.0, -0.5, vLocal.y));
  gl_FragColor = vec4(col * exp(-length(vWorld - uEye) * uDensity), 1.0);
}
`;
const TENTACLE_VERT = /* glsl */ `
attribute vec2 aT;      // along (0 top .. 1 tip), which strand
uniform float uWave;
uniform vec3 uLag;      // how the strands trail (local, metres per unit length)
uniform float uFrill;   // 1 for the oral arms (thicker ripples)
varying vec3 vWorld;
varying float vAlong;
void main() {
  vAlong = aT.x;
  vec3 p = position;
  float k = aT.x;
  float amp = mix(0.06, 0.12, uFrill);
  p.x += amp * k * sin(uWave * (1.0 + uFrill * 0.5) - k * 6.0 + aT.y * 1.7);
  p.z += amp * k * cos(uWave * 0.8 - k * 5.0 + aT.y * 2.3);
  p += uLag * k * k;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const TENTACLE_FRAG = /* glsl */ `
${WATER}
uniform vec3 uColor;
uniform float uGlow;
uniform float uFrill;
varying vec3 vWorld;
varying float vAlong;
void main() {
  vec3 lit = lightAt(vWorld, vec3(0.0, 1.0, 0.0)) * 0.6 + vec3(0.02, 0.03, 0.04) + uGlow * 0.4;
  vec3 col = uColor * lit * mix(0.45, 0.8, uFrill) * (1.0 - vAlong * 0.8);
  gl_FragColor = vec4(col * exp(-length(vWorld - uEye) * uDensity), 1.0);
}
`;

function bellGeometry() {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 18; i++) {
    const a = (i / 18) * Math.PI * 0.56;
    // A scalloped margin at the rim.
    pts.push(new THREE.Vector2(Math.sin(a), Math.cos(a) * 0.72 - 0.12 - (i > 15 ? (i - 15) * 0.035 : 0)));
  }
  return new THREE.LatheGeometry(pts, 48);
}

/** Strands hanging from the bell: `n` round the rim (tentacles) or near the centre (oral arms). */
function strands(n: number, segs: number, len: number, r0: number) {
  const pos: number[] = [];
  const at: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const lk = len * (0.6 + 0.4 * (((k * 7) % 5) / 5));
    for (let i = 0; i < segs; i++) {
      for (const j of [i, i + 1]) {
        const u = j / segs;
        pos.push(Math.cos(a) * r0 * (1 - u * 0.5), -0.2 - u * lk, Math.sin(a) * r0 * (1 - u * 0.5));
        at.push(u, k);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(at, 2));
  return g;
}

export function buildJellies(U: WaterUniforms, depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
  const glow = depth === 'abyss' ? 1 : depth === 'twilight' ? 0.25 : 0;
  const bellGeo = bellGeometry();
  const tentGeo = strands(16, 20, 2.6, 0.75);
  const armGeo = strands(4, 14, 1.2, 0.18);
  const jellies = pop.slots.map((slot) => {
    const bu = { ...U, uPulse: { value: 0 }, uColor: { value: new THREE.Vector3(1, 1, 1) }, uGlow: { value: glow } };
    const bell = new THREE.Mesh(bellGeo, new THREE.ShaderMaterial({ vertexShader: BELL_VERT, fragmentShader: BELL_FRAG, uniforms: bu, ...add, side: THREE.DoubleSide }));
    const tu = { ...U, uWave: { value: 0 }, uColor: bu.uColor, uGlow: bu.uGlow, uLag: { value: new THREE.Vector3() }, uFrill: { value: 0 } };
    const au = { ...U, uWave: tu.uWave, uColor: bu.uColor, uGlow: bu.uGlow, uLag: tu.uLag, uFrill: { value: 1 } };
    const tent = new THREE.LineSegments(tentGeo, new THREE.ShaderMaterial({ vertexShader: TENTACLE_VERT, fragmentShader: TENTACLE_FRAG, uniforms: tu, ...add }));
    const arms = new THREE.LineSegments(armGeo, new THREE.ShaderMaterial({ vertexShader: TENTACLE_VERT, fragmentShader: TENTACLE_FRAG, uniforms: au, ...add }));
    const g = new THREE.Group();
    g.add(bell, tent, arms);
    group.add(g);
    return { slot, g, bu, tu };
  });
  const up = new THREE.Vector3(0, 1, 0);
  return {
    group,
    update(t, L, s) {
      for (const { slot, g, bu, tu } of jellies) {
        // Jellyfish barely swim across: they drift, and their pulses do the rest.
        const ps = passState(pop, slot, s, D, v, { clear: 2.0, spread: 3, yMin: -3, yMax: 3, speed: [0.01, 0.04] });
        g.visible = ps.visible;
        if (!ps.visible) continue;
        const size = 0.16 + 0.24 * ps.h(10);
        const hz = 0.25 + 0.2 * ps.h(11);
        const sw = jellySwim({ seed: slot.seed + ps.pass * 31, pulseHz: hz }, ps.tau);
        g.position.set(ps.pos.x + sw.pos[0], ps.pos.y + sw.pos[1], ps.pos.z + sw.pos[2]);
        g.scale.setScalar(size);
        // Its bell points along its swimming axis, spinning slowly about it.
        g.quaternion.setFromUnitVectors(up, new THREE.Vector3(...sw.axis));
        g.rotateY(sw.spin);
        bu.uPulse.value = sw.pulse;
        // The ripple runs down the strands once per pulse (a whole number per loop overall).
        tu.uWave.value = beat(hz, t, L) * 1.0 + ps.h(12) * 6.28;
        // Strands lag behind the bell's last push, a little.
        tu.uLag.value.set(-sw.axis[0] * 0.3, 0.1 * sw.pulse, -sw.axis[2] * 0.3);
        const hue = ps.h(13);
        const c = new THREE.Color().setHSL(depth === 'abyss' ? 0.5 + 0.25 * hue : depth === 'reef' ? 0.9 + 0.1 * hue : 0.55 + 0.12 * hue, 0.6, 0.7);
        bu.uColor.value.set(c.r, c.g, c.b);
      }
    },
  };
}
