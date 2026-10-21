/**
 * The glowing: the gulper eel (a whip of a body behind a huge mouth, a glowing tail tip), and the
 * abyss's sparkles.
 */
import { THREE } from '../../three-layer';
import { WATER, type WaterUniforms } from '../water';
import type { Depth, Population } from '../schedule';
import { beat, creatureMaterial, face, passState, type Fauna } from './kit';

const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;

// ---- gulper eels -----------------------------------------------------------------------------------------
function eelGeometry() {
  // A long whip of a body (head at +z) behind a balloon of a mouth.
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 30; i++) {
    const u = i / 30;
    const r = u < 0.15 ? 0.09 * Math.sin((u / 0.15) * Math.PI * 0.5 + 0.3) : 0.09 * Math.pow(1 - (u - 0.15) / 0.85, 1.8) + 0.003;
    prof.push(new THREE.Vector2(r, 0.5 - u));
  }
  const g = new THREE.LatheGeometry(prof.reverse(), 10);
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

