/**
 * The soft-bodied and the glowing: comb jellies (translucent, their eight comb rows rippling with
 * rainbow light), siphonophores (long chains of glassy bells drifting like a string of lights), the
 * gulper eel (a whip of a body behind a huge mouth, a glowing tail tip), and the abyss's sparkles.
 */
import { THREE } from '../../three-layer';
import { WATER, type WaterUniforms } from '../water';
import type { Depth, Population } from '../schedule';
import { beat, creatureMaterial, face, passState, type Fauna } from './kit';

const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;

// ---- comb jellies ----------------------------------------------------------------------------------------
const COMB_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vLocal = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const COMB_FRAG = /* glsl */ `
${WATER}
uniform float uRipple;   // phase of the waves running down the comb rows
uniform float uGlow;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 0.667, 0.333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
void main() {
  vec3 v = normalize(uEye - vWorld);
  float fres = pow(1.0 - abs(dot(normalize(vNormal), v)), 2.0);
  float a = atan(vLocal.z, vLocal.x);
  float row = smoothstep(0.05, 0.0, abs(fract(a * 8.0 / 6.28318) - 0.5) - 0.45);
  // The cilia scatter light into a rainbow that runs down each row.
  vec3 rainbow = hue(vLocal.y * 2.5 - uRipple + a * 0.3);
  vec3 lit = lightAt(vWorld, normalize(vNormal)) + vec3(0.03);
  // Glassy body (just its edge), and the rows' shimmer only where a wave of light is passing down.
  float wave = 0.4 + 0.6 * pow(0.5 + 0.5 * sin(vLocal.y * 9.0 - uRipple * 2.0), 3.0);
  vec3 col = vec3(0.6, 0.75, 0.85) * fres * 0.2 * lit + mix(vec3(0.7), rainbow, 0.7) * row * wave * (lit * 0.8 + uGlow * 0.35);
  gl_FragColor = vec4(col * exp(-length(vWorld - uEye) * uDensity), 1.0);
}
`;

export function buildCombs(U: WaterUniforms, depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(1, 32, 20);
  geo.scale(0.6, 1, 0.6);
  const glow = depth === 'abyss' ? 0.6 : 0.1;
  const clusters = pop.slots.map((slot) => {
    const u = { ...U, uRipple: { value: 0 }, uGlow: { value: glow } };
    const mat = new THREE.ShaderMaterial({ vertexShader: COMB_VERT, fragmentShader: COMB_FRAG, uniforms: u, ...add, side: THREE.DoubleSide });
    const members = Array.from({ length: 3 }, (_, i) => {
      const m = new THREE.Mesh(geo, mat);
      group.add(m);
      return { m, off: [Math.sin(i * 2.4) * 1.2, (i - 1) * 0.7, Math.cos(i * 2.4) * 1.0] };
    });
    return { slot, u, members };
  });
  return {
    group,
    update(t, L, s) {
      for (const { slot, u, members } of clusters) {
        const ps = passState(pop, slot, s, D, v, { clear: 1.8, spread: 2.5, yMin: -2.5, yMax: 2.5, speed: [0.01, 0.05] });
        u.uRipple.value = beat(0.7, t, L);
        members.forEach(({ m, off }, i) => {
          m.visible = ps.visible;
          if (!ps.visible) return;
          const bob = (k: number) => 0.15 * Math.sin(beat(0.05 + 0.02 * k, t, L) + i * 2 + ps.h(20 + k) * 6.28);
          m.position.set(ps.pos.x + off[0] + bob(0), ps.pos.y + off[1] + bob(1), ps.pos.z + off[2] + bob(2));
          m.scale.setScalar(0.1 + 0.16 * ps.h(10 + i));
          m.rotation.set(0.3 * Math.sin(beat(0.03, t, L) + i), beat(0.02, t, L) + i, 0.2);
        });
      }
    },
  };
}

// ---- siphonophores --------------------------------------------------------------------------------------
const BEAD_FRAG = /* glsl */ `
${WATER}
uniform vec3 uColor;
uniform float uGlow;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vec3 v = normalize(uEye - vWorld);
  float fres = pow(1.0 - abs(dot(normalize(vNormal), v)), 2.0);
  vec3 lit = lightAt(vWorld, normalize(vNormal)) + vec3(0.02);
  vec3 col = uColor * (fres * 0.5 * lit + uGlow * (0.15 + fres * 0.5));
  gl_FragColor = vec4(col * exp(-length(vWorld - uEye) * uDensity * 0.8), 1.0);
}
`;
const BEAD_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vLocal = position;
  mat4 m = modelMatrix * instanceMatrix;
  vec4 w = m * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(m) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export function buildSiphonophores(U: WaterUniforms, depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const N = 46;
  const geo = new THREE.SphereGeometry(1, 12, 8);
  const chains = pop.slots.map((slot) => {
    const u = { ...U, uColor: { value: new THREE.Vector3(...(depth === 'abyss' ? [0.35, 0.6, 1.0] : [0.6, 0.8, 0.95])) }, uGlow: { value: depth === 'abyss' ? 0.8 : 0.2 } };
    const mesh = new THREE.InstancedMesh(geo, new THREE.ShaderMaterial({ vertexShader: BEAD_VERT, fragmentShader: BEAD_FRAG, uniforms: u, ...add }), N);
    mesh.frustumCulled = false;
    group.add(mesh);
    return { slot, mesh };
  });
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  return {
    group,
    update(t, L, s) {
      for (const { slot, mesh } of chains) {
        const ps = passState(pop, slot, s, D, v, { clear: 3, spread: 4, yMin: -2, yMax: 3, speed: [0.03, 0.08] });
        mesh.visible = ps.visible;
        if (!ps.visible) continue;
        const len = 7 + 7 * ps.h(10);
        // The chain trails behind its swimming bells, in a slow travelling wave.
        const dir = ps.heading.clone().multiplyScalar(-1);
        const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
        for (let i = 0; i < N; i++) {
          const f = i / (N - 1);
          const w = beat(0.05, t, L) - f * 4 + ps.h(11) * 6.28;
          const p = ps.pos.clone().addScaledVector(dir, f * len).addScaledVector(side, 0.6 * f * Math.sin(w)).add(new THREE.Vector3(0, 0.4 * f * Math.cos(w * 0.7) - f * 0.8, 0));
          // Bigger swimming bells at the front, then the long string of smaller ones.
          const r = i < 6 ? 0.07 : 0.025 + 0.02 * ((i * 7) % 3) / 2;
          m4.compose(p, q, new THREE.Vector3(r, r * 1.3, r));
          mesh.setMatrixAt(i, m4);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}

// ---- gulper eels -----------------------------------------------------------------------------------------
function eelGeometry() {
  // A long whip of a body (head at +z) behind a balloon of a mouth.
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 30; i++) {
    const u = i / 30;
    const r = u < 0.15 ? 0.09 * Math.sin((u / 0.15) * Math.PI * 0.5 + 0.3) : 0.09 * Math.pow(1 - (u - 0.15) / 0.85, 1.8) + 0.003;
    prof.push(new THREE.Vector2(r, 0.5 - u));
  }
  const g = new THREE.LatheGeometry(prof, 10);
  g.rotateX(Math.PI / 2);
  g.scale(1, 0.85, 1);
  return g;
}

const TIP_VERT = /* glsl */ `
uniform float uSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * 900.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const TIP_FRAG = /* glsl */ `
uniform float uGlow;
void main() {
  float d = length(gl_PointCoord - 0.5);
  gl_FragColor = vec4(vec3(1.0, 0.35, 0.55) * (smoothstep(0.5, 0.0, d) * 0.3 + smoothstep(0.14, 0.0, d) * 1.6) * uGlow, 1.0);
}
`;

export function buildEels(U: WaterUniforms, _depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const geo = eelGeometry();
  const eels = pop.slots.map((slot) => {
    const mat = creatureMaterial(U, { back: [0.08, 0.07, 0.08], belly: [0.12, 0.1, 0.11], mode: 3, amp: 0.1, k: 7, sheen: 0.3 });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geo, mat));
    const tipU = { uGlow: { value: 1 }, uSize: { value: 0.035 } };
    g.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.5], 3)), new THREE.ShaderMaterial({ vertexShader: TIP_VERT, fragmentShader: TIP_FRAG, uniforms: tipU, ...add })));
    group.add(g);
    return { slot, g, mat, tipU };
  });
  return {
    group,
    update(t, L, s) {
      for (const { slot, g, mat, tipU } of eels) {
        const ps = passState(pop, slot, s, D, v, { clear: 2.3, spread: 2.5, yMin: -2.5, yMax: 2, speed: [0.1, 0.3] });
        g.visible = ps.visible;
        if (!ps.visible) continue;
        g.position.copy(ps.pos);
        face(g, ps.heading);
        g.scale.setScalar(1.4 + 0.8 * ps.h(10));
        mat.uniforms.uBeat.value = beat(0.4, t, L) + ps.h(11) * 6.28;
        tipU.uGlow.value = 0.5 + 0.5 * Math.max(0, Math.sin(beat(0.2, t, L) + ps.h(12) * 6.28));
      }
    },
  };
}

// ---- sparkles (abyss) --------------------------------------------------------------------------------------
const SPARK_VERT = /* glsl */ `
attribute vec3 aSpark;   // blink cycles per loop, phase, size
uniform float uPhase;
uniform float uS;        // the travel: sparkles come towards us through a 40 m deep box
varying float vOn;
void main() {
  float s = sin(6.28318 * aSpark.x * uPhase + aSpark.y * 6.28318);
  vOn = pow(max(0.0, s), 10.0);
  vec3 p = position;
  p.z = -36.0 + mod(p.z + 36.0 + uS, 40.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSpark.z * 900.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const SPARK_FRAG = /* glsl */ `
varying float vOn;
void main() {
  float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(vec3(0.3, 0.85, 1.0) * a * a * vOn * 0.9, 1.0);
}
`;

export function buildSparkles(seed: number): Fauna {
  const group = new THREE.Group();
  const n = 320;
  const pos = new Float32Array(n * 3);
  const at = new Float32Array(n * 3);
  let s = seed >>> 0 || 7;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const rates: number[] = [];
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (rnd() - 0.5) * 24;
    pos[i * 3 + 1] = -4 + rnd() * 9;
    pos[i * 3 + 2] = -36 + rnd() * 40;
    at[i * 3 + 1] = rnd();
    at[i * 3 + 2] = 0.012 + 0.02 * rnd();
    rates.push(6 + rnd() * 20);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const attr = new THREE.BufferAttribute(at, 3);
  g.setAttribute('aSpark', attr);
  const u = { uPhase: { value: 0 }, uS: { value: 0 } };
  const pts = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, uniforms: u, ...add }));
  pts.frustumCulled = false;
  group.add(pts);
  let forL = -1;
  return {
    group,
    update(t, L, sTravel) {
      if (forL !== L) {
        rates.forEach((r, i) => attr.setX(i, Math.max(1, Math.round(L / r))));
        attr.needsUpdate = true;
        forL = L;
      }
      u.uPhase.value = t / L;
      u.uS.value = sTravel;
    },
  };
}

