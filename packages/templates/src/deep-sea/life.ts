/**
 * Sea life: jellyfish (pulsing bells trailing tentacles), fish schools, a whale far off in the fog,
 * an anglerfish with its glowing lure, and bioluminescent sparkles in the abyss. Every position is a
 * function of t: closed paths with whole laps per loop, or scheduled passes (schedule.ts). Pulses,
 * wiggles and blinks run a whole number of cycles per loop.
 */
import { THREE } from '../three-layer';
import { WATER, type WaterUniforms } from './water';
import { passAt, pathAt, type Depth, type SeaSchedule } from './schedule';

// ---- jellyfish ----------------------------------------------------------------------------------------
const JELLY_VERT = /* glsl */ `
uniform float uPulse;   // 0..1 how contracted the bell is
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vLocal = position;
  vec3 p = position;
  // Contracting: the bell narrows and lengthens a little, most at its rim.
  float rim = smoothstep(0.0, -0.6, p.y);
  p.xz *= 1.0 - 0.18 * uPulse * (0.4 + 0.6 * rim);
  p.y *= 1.0 + 0.1 * uPulse;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const JELLY_FRAG = /* glsl */ `
${WATER}
uniform vec3 uColor;
uniform float uGlow;    // bioluminescence (abyss)
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vec3 v = normalize(uEye - vWorld);
  float fres = pow(1.0 - abs(dot(normalize(vNormal), v)), 2.2);
  // Translucent: mostly its rim catches light, with faint radial canals inside.
  float canals = 0.5 + 0.5 * cos(atan(vLocal.z, vLocal.x) * 8.0);
  vec3 lit = lightAt(vWorld, vec3(0.0, 1.0, 0.0)) + vec3(0.02, 0.03, 0.04);
  vec3 col = uColor * (fres * 0.9 + 0.12 + 0.12 * canals) * lit;
  col += uColor * uGlow * (fres * 0.6 + 0.1 * canals) * (0.6 + 0.4 * smoothstep(0.0, -0.5, vLocal.y));
  gl_FragColor = vec4(col * exp(-length(vWorld - uEye) * uDensity), 1.0);
}
`;
const TENTACLE_VERT = /* glsl */ `
attribute vec2 aT;      // along (0 top .. 1 tip), which tentacle
uniform float uWave;    // phase of the wave down the tentacles
varying vec3 vWorld;
varying float vAlong;
void main() {
  vAlong = aT.x;
  vec3 p = position;
  float k = aT.x;
  p.x += 0.08 * k * sin(uWave + k * 5.0 + aT.y * 1.7);
  p.z += 0.08 * k * cos(uWave * 0.8 + k * 4.0 + aT.y * 2.3);
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const TENTACLE_FRAG = /* glsl */ `
${WATER}
uniform vec3 uColor;
uniform float uGlow;
varying vec3 vWorld;
varying float vAlong;
void main() {
  vec3 lit = lightAt(vWorld, vec3(0.0, 1.0, 0.0)) * 0.6 + vec3(0.02, 0.03, 0.04) + uGlow * 0.4;
  vec3 col = uColor * lit * 0.5 * (1.0 - vAlong * 0.8);
  gl_FragColor = vec4(col * exp(-length(vWorld - uEye) * uDensity), 1.0);
}
`;

function jellyBell() {
  // A dome, slightly flattened, open underneath.
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI * 0.55;
    pts.push(new THREE.Vector2(Math.sin(a) * 1.0, Math.cos(a) * 0.75 - 0.15 - (i > 13 ? (i - 13) * 0.04 : 0)));
  }
  return new THREE.LatheGeometry(pts, 40);
}

function tentacles(n: number, segs: number, len: number) {
  const pos: number[] = [];
  const at: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const r = 0.75;
    const lk = len * (0.6 + 0.4 * ((k * 7) % 5) / 5);
    for (let i = 0; i < segs; i++) {
      for (const j of [i, i + 1]) {
        const u = j / segs;
        pos.push(Math.cos(a) * r * (1 - u * 0.5), -0.2 - u * lk, Math.sin(a) * r * (1 - u * 0.5));
        at.push(u, k);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(at, 2));
  return g;
}

// ---- fish ---------------------------------------------------------------------------------------------
const FISH_VERT = /* glsl */ `
uniform float uSwim;    // tail-beat phase (whole cycles per loop)
varying vec3 vWorld;
varying vec3 vNormal;
varying float vSide;
void main() {
  vec3 p = position;
  // Body along +z (head at +z): the tail sweeps side to side, more towards the tail.
  float tail = smoothstep(0.1, -0.5, p.z);
  p.x += 0.12 * tail * sin(uSwim + float(gl_InstanceID) * 1.7 - p.z * 4.0);
  vSide = p.x;
  vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const FISH_FRAG = /* glsl */ `
${WATER}
uniform vec3 uColor;
uniform vec3 uBelly;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  // Silvery: a sheen where the body faces up to the light, darker back, pale belly.
  vec3 albedo = mix(uBelly, uColor, smoothstep(-0.3, 0.6, n.y));
  vec3 lit = lightAt(vWorld, n) + vec3(0.006, 0.01, 0.014);
  float sheen = pow(max(0.0, dot(reflect(-v, n), vec3(0.0, 1.0, 0.0))), 12.0);
  vec3 col = albedo * lit + uSunCol * uSun * sheen * 0.5;
  gl_FragColor = vec4(fogged(col, vWorld), 1.0);
}
`;

function fishGeometry() {
  // A lens-shaped body (head at +z) with a forked tail fin.
  const body = new THREE.SphereGeometry(0.5, 14, 8);
  body.scale(0.22, 0.42, 1.0);
  const tail = new THREE.BufferGeometry();
  tail.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.42, 0, 0.22, -0.72, 0, 0, -0.6, 0, 0, -0.42, 0, 0, -0.6, 0, -0.22, -0.72], 3));
  tail.computeVertexNormals();
  const g = new THREE.BufferGeometry();
  const a = body.toNonIndexed();
  const pos = [...(a.getAttribute('position').array as Float32Array), ...(tail.getAttribute('position').array as Float32Array)];
  const nor = [...(a.getAttribute('normal').array as Float32Array), ...(tail.getAttribute('normal').array as Float32Array)];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

// ---- the whale and the anglerfish ---------------------------------------------------------------------
const SIL_FRAG = /* glsl */ `
${WATER}
uniform vec3 uColor;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 col = uColor * (lightAt(vWorld, n) + vec3(0.003, 0.005, 0.008));
  gl_FragColor = vec4(fogged(col, vWorld), 1.0);
}
`;
const SIL_VERT = /* glsl */ `
uniform float uBend;    // body undulation
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 p = position;
  // A slow up-and-down beat towards the flukes (the body lies along +z).
  p.y += uBend * smoothstep(0.0, -1.0, p.z / 7.0) * (p.z * p.z) * 0.012;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

function whaleGeometry() {
  // A humpback's shape, nose at +z: a long tapering body, long pectoral fins, flukes.
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    const r = Math.sin(Math.PI * Math.pow(u, 0.7)) * 1.6 * (1 - 0.6 * u * u * u);
    prof.push(new THREE.Vector2(Math.max(0.02, r), 7 - u * 14));
  }
  const body = new THREE.LatheGeometry(prof, 20);
  body.rotateX(Math.PI / 2);
  body.scale(1, 0.8, 1);
  const fin = new THREE.BoxGeometry(4.5, 0.12, 1.1);
  const finL = fin.clone();
  finL.rotateZ(-0.35);
  finL.translate(-2.8, -0.6, 3.2);
  const finR = fin.clone();
  finR.rotateZ(0.35);
  finR.translate(2.8, -0.6, 3.2);
  const flukes = new THREE.BoxGeometry(4.6, 0.1, 1.4);
  flukes.translate(0, 0, -7.2);
  const parts = [body, finL, finR, flukes].map((g) => g.toNonIndexed());
  const g = new THREE.BufferGeometry();
  const cat = (name: string) => parts.flatMap((p) => [...(p.getAttribute(name).array as Float32Array)]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(cat('position'), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(cat('normal'), 3));
  return g;
}

const LURE_FRAG = /* glsl */ `
uniform float uGlow;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  vec3 col = vec3(0.55, 0.95, 1.0) * (smoothstep(0.5, 0.0, d) * 0.4 + smoothstep(0.12, 0.0, d) * 2.0) * uGlow;
  gl_FragColor = vec4(col, 1.0);
}
`;
const POINT_VERT = /* glsl */ `
uniform float uSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * 900.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

// ---- bioluminescent sparkles ----------------------------------------------------------------------------
const SPARK_VERT = /* glsl */ `
attribute vec3 aSpark;   // blink cycles per loop, phase, size
uniform float uPhase;
varying float vOn;
void main() {
  float s = sin(6.28318 * aSpark.x * uPhase + aSpark.y * 6.28318);
  vOn = pow(max(0.0, s), 10.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSpark.z * 900.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const SPARK_FRAG = /* glsl */ `
varying float vOn;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c));
  gl_FragColor = vec4(vec3(0.3, 0.85, 1.0) * a * a * vOn * 0.9, 1.0);
}
`;

export interface Life {
  group: THREE.Group;
  update(t: number, L: number): void;
}

export function buildLife(depth: Depth, U: WaterUniforms, sched: SeaSchedule, seed: number): Life {
  const group = new THREE.Group();
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
  const glow = depth === 'abyss' ? 1 : depth === 'twilight' ? 0.25 : 0;

  // Jellyfish.
  const bellGeo = jellyBell();
  const jellies = sched.jellies.map((j) => {
    const color = new THREE.Color().setHSL(depth === 'abyss' ? 0.5 + 0.25 * j.hue : depth === 'reef' ? 0.9 + 0.1 * j.hue : 0.55 + 0.1 * j.hue, 0.6, 0.7);
    const bu = { ...U, uPulse: { value: 0 }, uColor: { value: new THREE.Vector3(color.r, color.g, color.b) }, uGlow: { value: glow } };
    const bell = new THREE.Mesh(bellGeo, new THREE.ShaderMaterial({ vertexShader: JELLY_VERT, fragmentShader: JELLY_FRAG, uniforms: bu, ...add, side: THREE.DoubleSide }));
    const tu = { ...U, uWave: { value: 0 }, uColor: bu.uColor, uGlow: bu.uGlow };
    const tent = new THREE.LineSegments(tentacles(14, 18, 2.2 + j.hue * 1.5), new THREE.ShaderMaterial({ vertexShader: TENTACLE_VERT, fragmentShader: TENTACLE_FRAG, uniforms: tu, ...add }));
    const g = new THREE.Group();
    g.add(bell, tent);
    g.scale.setScalar(j.size);
    group.add(g);
    return { j, g, bu, tu };
  });

  // Fish schools.
  const fishGeo = fishGeometry();
  const schools = sched.schools.map((sc, si) => {
    const reef = depth === 'reef';
    const fu = {
      ...U,
      uSwim: { value: 0 },
      uColor: { value: new THREE.Vector3(...(reef ? [[0.9, 0.7, 0.2], [0.25, 0.45, 0.9], [0.85, 0.85, 0.9]][si % 3] : [0.55, 0.62, 0.7])) },
      uBelly: { value: new THREE.Vector3(...(reef ? [0.95, 0.95, 0.9] : [0.8, 0.85, 0.9])) },
    };
    const mesh = new THREE.InstancedMesh(fishGeo, new THREE.ShaderMaterial({ vertexShader: FISH_VERT, fragmentShader: FISH_FRAG, uniforms: fu }), sc.count);
    mesh.frustumCulled = false;
    group.add(mesh);
    // Each fish's place in the school, and its own slow wander (whole cycles per loop).
    let s = sc.seed >>> 0 || 1;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const fish = Array.from({ length: sc.count }, () => ({
      off: [(rnd() - 0.5) * 2.4, (rnd() - 0.5) * 0.9, (rnd() - 0.5) * 1.6],
      wander: [1 + Math.floor(rnd() * 20), 1 + Math.floor(rnd() * 20), 1 + Math.floor(rnd() * 20)],
      ph: [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28],
    }));
    return { sc, mesh, fu, fish };
  });

  // Whales (far, in the fog), and anglerfish with their lures.
  const whaleMat = new THREE.ShaderMaterial({ vertexShader: SIL_VERT, fragmentShader: SIL_FRAG, uniforms: { ...U, uColor: { value: new THREE.Vector3(0.35, 0.38, 0.42) }, uBend: { value: 0 } } });
  const whale = new THREE.Mesh(whaleGeometry(), whaleMat);
  whale.visible = false;
  group.add(whale);
  const anglerMat = new THREE.ShaderMaterial({ vertexShader: SIL_VERT, fragmentShader: SIL_FRAG, uniforms: { ...U, uColor: { value: new THREE.Vector3(0.12, 0.1, 0.1) }, uBend: { value: 0 } } });
  const anglerBody = new THREE.SphereGeometry(1, 16, 10);
  anglerBody.scale(0.16, 0.13, 0.22);
  const angler = new THREE.Mesh(anglerBody, anglerMat);
  const lureU = { uGlow: { value: 0 }, uSize: { value: 0.09 } };
  const lure = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0.22, 0.3], 3)), new THREE.ShaderMaterial({ vertexShader: POINT_VERT, fragmentShader: LURE_FRAG, uniforms: lureU, ...add }));
  angler.add(lure);
  angler.visible = false;
  group.add(angler);

  // Sparkles in the abyss: tiny lights blinking now and then.
  let sparkU: { uPhase: { value: number } } | null = null;
  if (depth === 'abyss') {
    const n = 260;
    const pos = new Float32Array(n * 3);
    const at = new Float32Array(n * 3);
    let s = seed >>> 0 || 7;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) {
      const d = 3 + rnd() * 18;
      pos[i * 3] = (rnd() - 0.5) * (2 + d);
      pos[i * 3 + 1] = -3 + rnd() * 7;
      pos[i * 3 + 2] = -1.2 - d;
      at[i * 3] = 0; // cycles set when L is known
      at[i * 3 + 1] = rnd();
      at[i * 3 + 2] = 0.012 + 0.02 * rnd();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const attr = new THREE.BufferAttribute(at, 3);
    g.setAttribute('aSpark', attr);
    sparkU = { uPhase: { value: 0 } };
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, uniforms: sparkU, ...add }));
    pts.frustumCulled = false;
    group.add(pts);
    (pts.userData as { attr: THREE.BufferAttribute; rnd: () => number }).attr = attr;
    pts.userData.forL = -1;
    pts.userData.rates = Array.from({ length: n }, () => 6 + rnd() * 20);
    group.userData.sparks = pts;
  }

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const look = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);

  return {
    group,
    update(t, L) {
      const ph = t / L;
      for (const { j, g, bu, tu } of jellies) {
        const [x, y, z] = pathAt(j.path, t, L);
        g.position.set(x, y, z);
        // A sharp contraction, a slow relaxation.
        const c = 0.5 + 0.5 * Math.sin(2 * Math.PI * j.pulses * ph);
        bu.uPulse.value = Math.pow(c, 3);
        tu.uWave.value = 2 * Math.PI * j.pulses * ph;
        // Tilt a little into its drift.
        const [x2, , z2] = pathAt(j.path, t + 2, L);
        g.rotation.z = Math.max(-0.3, Math.min(0.3, -(x2 - x) * 0.4));
        g.rotation.x = Math.max(-0.3, Math.min(0.3, (z2 - z) * 0.4));
      }
      for (const { sc, mesh, fu, fish } of schools) {
        fu.uSwim.value = 2 * Math.PI * Math.round(L * 2.5) * ph;
        const at = (tt: number, f: (typeof fish)[number]) => {
          const c = pathAt(sc.path, tt, L);
          const w = (2 * Math.PI * tt) / L;
          const k = (i: number) => c[i] + f.off[i] * (1 + 0.25 * Math.sin(f.wander[i] * w + f.ph[i]));
          return new THREE.Vector3(k(0), k(1), k(2));
        };
        fish.forEach((f, i) => {
          const p = at(t, f);
          const p2 = at(t + 0.4, f);
          look.lookAt(p2, p, up);
          q.setFromRotationMatrix(look);
          m4.compose(p, q, new THREE.Vector3().setScalar(sc.size));
          mesh.setMatrixAt(i, m4);
        });
        mesh.instanceMatrix.needsUpdate = true;
      }
      // The whale passing, if one is.
      const w = sched.whales.map((p) => ({ p, at: passAt(p, t) })).find((x) => x.at);
      whale.visible = !!w;
      if (w?.at) {
        whale.position.set(...w.at);
        const ahead = passAt(w.p, Math.min(w.p.t1, t + 1)) ?? w.at;
        const dir = new THREE.Vector3(ahead[0] - w.at[0], ahead[1] - w.at[1], ahead[2] - w.at[2]);
        if (dir.lengthSq() > 1e-6) whale.lookAt(whale.position.clone().add(dir));
        whaleMat.uniforms.uBend.value = Math.sin(2 * Math.PI * Math.round(L / 9) * ph) * 3;
      }
      const a = sched.anglers.map((p) => ({ p, at: passAt(p, t) })).find((x) => x.at);
      angler.visible = !!a;
      if (a?.at) {
        angler.position.set(...a.at);
        const ahead = passAt(a.p, Math.min(a.p.t1, t + 1)) ?? a.at;
        angler.lookAt(new THREE.Vector3(...ahead));
        angler.position.y += 0.05 * Math.sin(2 * Math.PI * Math.round(L / 4) * ph);
        const u = (t - a.p.t0) / (a.p.t1 - a.p.t0);
        lureU.uGlow.value = Math.min(1, u * 6, (1 - u) * 6) * (0.75 + 0.25 * Math.sin(2 * Math.PI * Math.round(L / 1.7) * ph));
      }
      const sp = group.userData.sparks as THREE.Points | undefined;
      if (sp && sparkU) {
        if (sp.userData.forL !== L) {
          const attr = sp.userData.attr as THREE.BufferAttribute;
          // Each blinks every 6–26 s: whole cycles per loop.
          (sp.userData.rates as number[]).forEach((r, i) => attr.setX(i, Math.max(1, Math.round(L / r))));
          attr.needsUpdate = true;
          sp.userData.forL = L;
        }
        sparkU.uPhase.value = ph;
      }
    },
  };
}
