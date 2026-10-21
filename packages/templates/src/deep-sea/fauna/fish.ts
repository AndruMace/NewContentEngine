/**
 * Fish: shoals (lanternfish with their rows of light organs; colourful reef fish), sharks (a blue
 * shark in open water, a reef shark over the reef, a sixgill cruising the abyss, its eyes shining in
 * the headlights), the swordfish hunting in the twilight zone, and
 * the anglerfish with its glowing lure.
 * Shoals are instanced meshes: every fish keeps its place in the shoal and wanders round it a little
 * (whole cycles per loop), turned the way the shoal swims.
 */
import { THREE } from '../../three-layer';
import { WATER, type WaterUniforms } from '../water';
import type { Depth, Population } from '../schedule';
import { beat, creatureMaterial, face, passState, type Fauna } from './kit';

/** A fish's body, head at +z, about 1 long: a lens with a forked tail and a little dorsal fin. */
export function fishGeometry(deep = 1) {
  const body = new THREE.SphereGeometry(0.5, 16, 10);
  body.scale(0.2, 0.36 * deep, 1.0);
  const fins = new THREE.BufferGeometry();
  fins.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        // tail
        0, 0, -0.42, 0, 0.24 * deep, -0.74, 0, 0, -0.6,
        0, 0, -0.42, 0, 0, -0.6, 0, -0.24 * deep, -0.74,
        // dorsal fin
        0, 0.17 * deep, 0.1, 0, 0.3 * deep, -0.05, 0, 0.16 * deep, -0.2,
      ],
      3,
    ),
  );
  fins.computeVertexNormals();
  return merge([body.toNonIndexed(), fins]);
}

/** A shark, nose at +z, 1 long: a tapering body, a tall dorsal fin, pectorals and a sickle tail. */
function sharkGeometry() {
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 20; i++) {
    const u = i / 20;
    const r = Math.sin(Math.PI * Math.pow(u, 0.62)) * 0.085 * (1 - 0.75 * u * u);
    prof.push(new THREE.Vector2(Math.max(0.004, r), 0.5 - u));
  }
  const body = new THREE.LatheGeometry(prof.reverse(), 14);
  body.rotateX(Math.PI / 2);
  body.scale(0.85, 1.0, 1);
  const tri = (a: number[], b: number[], c: number[]) => [...a, ...b, ...c];
  const fins = new THREE.BufferGeometry();
  fins.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        ...tri([0, 0.07, 0.12], [0, 0.2, -0.02], [0, 0.065, -0.06]), // dorsal
        ...tri([0.06, -0.03, 0.15], [0.24, -0.09, 0.02], [0.05, -0.04, 0.05]), // pectorals
        ...tri([-0.06, -0.03, 0.15], [-0.24, -0.09, 0.02], [-0.05, -0.04, 0.05]),
        ...tri([0, 0.0, -0.44], [0, 0.2, -0.6], [0, 0.0, -0.5]), // tail, upper lobe larger
        ...tri([0, 0.0, -0.44], [0, 0.0, -0.5], [0, -0.11, -0.55]),
      ],
      3,
    ),
  );
  fins.computeVertexNormals();
  return merge([body.toNonIndexed(), fins]);
}

/**
 * A swordfish, nose at +z, about 1.3 long with its bill: a stout body tapering to a thin tail stock,
 * the long flat sword, a tall sickle of a dorsal fin, long low pectorals and a crescent tail.
 */
function swordfishGeometry() {
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 22; i++) {
    const u = i / 22;
    const r = Math.sin(Math.PI * Math.pow(u, 0.55)) * 0.075 * (1 - 0.8 * u * u) + 0.006;
    prof.push(new THREE.Vector2(r, 0.42 - u * 0.92));
  }
  const body = new THREE.LatheGeometry(prof.reverse(), 14);
  body.rotateX(Math.PI / 2);
  body.scale(0.85, 1.0, 1);
  const sword = new THREE.ConeGeometry(0.014, 0.44, 8);
  sword.rotateX(Math.PI / 2);
  sword.scale(1.7, 0.45, 1);
  sword.translate(0, 0.005, 0.42 + 0.22);
  const tri = (a: number[], b: number[], c: number[]) => [...a, ...b, ...c];
  const fins = new THREE.BufferGeometry();
  fins.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        ...tri([0, 0.066, 0.28], [0, 0.26, 0.07], [0, 0.07, 0.17]), // dorsal sickle
        ...tri([0, 0.07, 0.17], [0, 0.26, 0.07], [0, 0.068, 0.12]),
        ...tri([0.055, -0.045, 0.25], [0.24, -0.15, 0.02], [0.06, -0.05, 0.17]), // pectorals
        ...tri([-0.055, -0.045, 0.25], [-0.24, -0.15, 0.02], [-0.06, -0.05, 0.17]),
        ...tri([0, 0.008, -0.48], [0, 0.26, -0.66], [0, 0.0, -0.55]), // crescent tail
        ...tri([0, -0.008, -0.48], [0, 0.0, -0.55], [0, -0.26, -0.66]),
      ],
      3,
    ),
  );
  fins.computeVertexNormals();
  return merge([body.toNonIndexed(), sword.toNonIndexed(), fins]);
}

/**
 * A bluntnose sixgill, nose at +z, 1 long: stout, a broad blunt head, one small dorsal fin set far
 * back, and a long upper tail lobe.
 */
const sixgillR = (u: number) => Math.sin(Math.PI * Math.pow(u, 0.6)) * 0.095 * (1 - 0.75 * u * u) + 0.004;
/** Where a sixgill's eyes are (on its skin, either side of the head). */
const SIXGILL_EYE = (() => {
  const r = sixgillR(0.09) * 1.06;
  return [r * 1.05 * 0.8, r * 0.85 * 0.6, 0.5 - 0.09 * 0.95];
})();

function sixgillGeometry() {
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 22; i++) {
    const u = i / 22;
    prof.push(new THREE.Vector2(sixgillR(u), 0.5 - u * 0.95));
  }
  const body = new THREE.LatheGeometry(prof.reverse(), 16);
  body.rotateX(Math.PI / 2);
  body.scale(1.05, 0.85, 1);
  const tri = (a: number[], b: number[], c: number[]) => [...a, ...b, ...c];
  const fins = new THREE.BufferGeometry();
  fins.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        ...tri([0, 0.028, -0.15], [0, 0.1, -0.26], [0, 0.022, -0.27]), // dorsal, far back
        ...tri([0.07, -0.04, 0.2], [0.22, -0.1, 0.06], [0.06, -0.05, 0.1]), // pectorals
        ...tri([-0.07, -0.04, 0.2], [-0.22, -0.1, 0.06], [-0.06, -0.05, 0.1]),
        ...tri([0.025, -0.03, -0.12], [0.09, -0.07, -0.2], [0.02, -0.025, -0.2]), // pelvics
        ...tri([-0.025, -0.03, -0.12], [-0.09, -0.07, -0.2], [-0.02, -0.025, -0.2]),
        ...tri([0, 0.015, -0.4], [0, 0.09, -0.68], [0, -0.01, -0.5]), // long upper tail lobe
        ...tri([0, -0.01, -0.42], [0, -0.01, -0.5], [0, -0.06, -0.5]),
      ],
      3,
    ),
  );
  fins.computeVertexNormals();
  return merge([body.toNonIndexed(), fins]);
}

function merge(parts: THREE.BufferGeometry[]) {
  const g = new THREE.BufferGeometry();
  const cat = (name: string) => parts.flatMap((p) => [...(p.getAttribute(name).array as Float32Array)]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(cat('position'), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(cat('normal'), 3));
  return g;
}

/** Reef fish colours: [back, belly, stripe?] (muted a little by the water anyway). */
const REEF_LOOKS: { back: number[]; belly: number[]; stripe?: number[] }[] = [
  { back: [0.95, 0.78, 0.1], belly: [1.0, 0.9, 0.4] }, // yellow tang
  { back: [0.15, 0.35, 0.9], belly: [0.5, 0.7, 1.0] }, // blue chromis
  { back: [0.85, 0.85, 0.6], belly: [0.95, 0.95, 0.85], stripe: [0.08, 0.08, 0.1] }, // sergeant major
  { back: [1.0, 0.45, 0.4], belly: [1.0, 0.7, 0.6] }, // anthias
  { back: [0.4, 0.75, 0.75], belly: [0.85, 0.95, 0.9] }, // silver-green
];

export function buildShoals(U: WaterUniforms, depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const reef = pop.species === 'reefSchool';
  const N = reef ? 46 : 56;
  const geo = fishGeometry(reef ? 1.5 : 0.9);
  const shoals = pop.slots.map((slot) => {
    const mat = reef
      ? creatureMaterial(U, { back: [1, 1, 1], belly: [1, 1, 1], mode: 1, amp: 0.13, k: 5, pattern: 1, patCol: [0.08, 0.08, 0.1], patScale: 5, sheen: 0.4 })
      : creatureMaterial(U, { back: [0.04, 0.05, 0.07], belly: [0.45, 0.5, 0.56], mode: 1, amp: 0.12, k: 5, pattern: 3, patScale: 9, glow: depth === 'abyss' ? 0.9 : 0.3, glowCol: [0.35, 0.85, 1.0], sheen: 0.6 });
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.frustumCulled = false;
    group.add(mesh);
    let seed = slot.seed >>> 0 || 1;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const fish = Array.from({ length: N }, () => ({
      off: [(rnd() - 0.5) * 2.6, (rnd() - 0.5) * 1.0, (rnd() - 0.5) * 1.8],
      wander: [1 + Math.floor(rnd() * 40), 1 + Math.floor(rnd() * 40), 1 + Math.floor(rnd() * 40)],
      ph: [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28],
    }));
    return { slot, mesh, mat, fish };
  });
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const look = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);
  return {
    group,
    update(t, L, s) {
      for (const { slot, mesh, mat, fish } of shoals) {
        const ps = passState(pop, slot, s, D, v, { clear: 3, spread: 4, yMin: -3.5, yMax: 3, speed: [0.3, 0.8] });
        mesh.visible = ps.visible;
        if (!ps.visible) continue;
        const size = reef ? 0.14 + 0.1 * ps.h(10) : 0.1 + 0.06 * ps.h(10);
        const spread = reef ? 1.2 + ps.h(11) : 1.6 + ps.h(11);
        if (reef) {
          const lk = REEF_LOOKS[Math.floor(ps.h(12) * REEF_LOOKS.length)];
          mat.uniforms.uBack.value.set(...lk.back);
          mat.uniforms.uBelly.value.set(...lk.belly);
          mat.uniforms.uPattern.value = lk.stripe ? 1 : 0;
        }
        mat.uniforms.uBeat.value = beat(reef ? 3 : 4, t, L);
        const w = (2 * Math.PI * t) / L;
        fish.forEach((f, i) => {
          // Its place in the shoal, breathing in and out a little; a slight turn of its own.
          const k = (j: number) => f.off[j] * spread * (1 + 0.2 * Math.sin(f.wander[j] * w + f.ph[j]));
          const p = new THREE.Vector3(ps.pos.x + k(0), ps.pos.y + k(1), ps.pos.z + k(2));
          const dir = ps.heading.clone().add(new THREE.Vector3(0.15 * Math.sin(f.wander[0] * w * 3 + f.ph[1]), 0.05 * Math.sin(f.wander[1] * w * 2), 0.15 * Math.cos(f.wander[2] * w * 3 + f.ph[0]))).normalize();
          look.lookAt(p.clone().add(dir), p, up);
          q.setFromRotationMatrix(look);
          m4.compose(p, q, new THREE.Vector3().setScalar(size));
          mesh.setMatrixAt(i, m4);
        });
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}

// Eyeshine: a shark's eyes throw the headlights back (only where the lights reach them).
const EYE_VERT = /* glsl */ `
uniform float uSize;
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * 900.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const EYE_FRAG = /* glsl */ `
${WATER}
varying vec3 vWorld;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float lit = 0.15 + 5.0 * flood(vWorld);
  gl_FragColor = vec4(vec3(0.45, 1.0, 0.6) * (smoothstep(0.5, 0.0, d) * 0.25 + smoothstep(0.16, 0.0, d)) * lit * exp(-length(vWorld - uEye) * uDensity * 0.7), 1.0);
}
`;

export function buildSharks(U: WaterUniforms, _depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const reef = pop.species === 'reefShark';
  const sixgill = pop.species === 'sixgill';
  const geo = sixgill ? sixgillGeometry() : sharkGeometry();
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
  const [ex, ey, ez] = SIXGILL_EYE;
  const eyeGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([ex, ey, ez, -ex, ey, ez], 3));
  const eyeMat = new THREE.ShaderMaterial({ vertexShader: EYE_VERT, fragmentShader: EYE_FRAG, uniforms: { ...U, uSize: { value: 0.06 } }, ...add });
  const sharks = pop.slots.map((slot) => {
    const mat = sixgill
      ? creatureMaterial(U, { back: [0.07, 0.065, 0.06], belly: [0.13, 0.12, 0.11], mode: 1, amp: 0.06, k: 2.5, sheen: 0.3 })
      : reef
        ? creatureMaterial(U, { back: [0.32, 0.31, 0.28], belly: [0.85, 0.85, 0.82], mode: 1, amp: 0.07, k: 3, sheen: 0.3 })
        : creatureMaterial(U, { back: [0.12, 0.22, 0.42], belly: [0.82, 0.85, 0.9], mode: 1, amp: 0.07, k: 3, sheen: 0.4 });
    const mesh = new THREE.Mesh(geo, mat);
    if (sixgill) mesh.add(new THREE.Points(eyeGeo, eyeMat));
    group.add(mesh);
    return { slot, mesh, mat };
  });
  return {
    group,
    update(t, L, s) {
      for (const { slot, mesh, mat } of sharks) {
        const ps = sixgill
          ? passState(pop, slot, s, D, v, { clear: 3, spread: 3, yMin: -3, yMax: 1.5, speed: [0.3, 0.55] })
          : passState(pop, slot, s, D, v, { clear: 3.5, spread: 5, yMin: -4, yMax: 2, speed: [0.5, 1.0] });
        mesh.visible = ps.visible;
        if (!ps.visible) continue;
        mesh.position.copy(ps.pos);
        face(mesh, ps.heading);
        mesh.scale.setScalar(sixgill ? 3.2 + 1.2 * ps.h(10) : reef ? 1.5 + 0.7 * ps.h(10) : 2.2 + ps.h(10));
        // A sixgill cruises with slow, lazy sweeps of its tail.
        mat.uniforms.uBeat.value = beat(sixgill ? 0.35 : 0.7, t, L) + ps.h(11) * 6.28;
      }
    },
  };
}

export function buildSwordfish(U: WaterUniforms, _depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const geo = swordfishGeometry();
  const fish = pop.slots.map((slot) => {
    const mat = creatureMaterial(U, { back: [0.1, 0.09, 0.15], belly: [0.72, 0.74, 0.78], mode: 1, amp: 0.045, k: 3, sheen: 0.6 });
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
    return { slot, mesh, mat };
  });
  return {
    group,
    update(t, L, s) {
      for (const { slot, mesh, mat } of fish) {
        // It crosses our path well ahead, at speed.
        const ps = passState(pop, slot, s, D, v, { clear: 3.5, spread: 1.5, yMin: -2.5, yMax: 2, speed: [0.9, 1.4], crossAt: [9, 16] });
        mesh.visible = ps.visible;
        if (!ps.visible) continue;
        mesh.position.copy(ps.pos);
        face(mesh, ps.heading);
        mesh.scale.setScalar(2.3 + 1.1 * ps.h(10));
        mat.uniforms.uBeat.value = beat(1.0, t, L) + ps.h(11) * 6.28;
      }
    },
  };
}

const LURE_VERT = /* glsl */ `
uniform float uSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * 900.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const LURE_FRAG = /* glsl */ `
uniform float uGlow;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  vec3 col = vec3(0.55, 0.95, 1.0) * (smoothstep(0.5, 0.0, d) * 0.4 + smoothstep(0.12, 0.0, d) * 2.0) * uGlow;
  gl_FragColor = vec4(col, 1.0);
}
`;

export function buildAnglers(U: WaterUniforms, _depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const body = new THREE.SphereGeometry(1, 18, 12);
  body.scale(0.16, 0.14, 0.22);
  const jaw = new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45);
  jaw.scale(0.15, 0.1, 0.16);
  jaw.translate(0, -0.03, 0.1);
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
  const anglers = pop.slots.map((slot) => {
    const mat = creatureMaterial(U, { back: [0.1, 0.08, 0.08], belly: [0.16, 0.12, 0.11], mode: 1, amp: 0.05, k: 4, sheen: 0.2 });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(body, mat), new THREE.Mesh(jaw, mat));
    // The lure on its stalk, arched over the head.
    const stalk = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.004, 4, 16, Math.PI * 0.6), mat);
    stalk.position.set(0, 0.12, 0.12);
    stalk.rotation.set(0, Math.PI / 2, Math.PI * 0.15);
    g.add(stalk);
    const lureU = { uGlow: { value: 1 }, uSize: { value: 0.09 } };
    const lure = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0.24, 0.32], 3)), new THREE.ShaderMaterial({ vertexShader: LURE_VERT, fragmentShader: LURE_FRAG, uniforms: lureU, ...add }));
    g.add(lure);
    group.add(g);
    return { slot, g, mat, lureU };
  });
  return {
    group,
    update(t, L, s) {
      for (const { slot, g, mat, lureU } of anglers) {
        const ps = passState(pop, slot, s, D, v, { clear: 2.2, spread: 2, yMin: -2.5, yMax: 1.5, speed: [0.05, 0.2] });
        g.visible = ps.visible;
        if (!ps.visible) continue;
        g.position.copy(ps.pos);
        g.position.y += 0.06 * Math.sin(beat(0.25, t, L) + ps.h(10) * 6.28);
        face(g, ps.heading);
        g.scale.setScalar(1 + 0.8 * ps.h(11));
        mat.uniforms.uBeat.value = beat(1.2, t, L);
        // The lure pulses softly, now and then dimming.
        lureU.uGlow.value = 0.7 + 0.3 * Math.sin(beat(0.6, t, L) + ps.h(12) * 6.28);
      }
    },
  };
}
