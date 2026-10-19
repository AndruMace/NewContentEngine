/**
 * The fire: flame sheets, logs with glowing cracks, an ember bed, rising sparks, and the candle
 * flames on the mantel. All animation repeats exactly over the loop:
 *   - flames scroll upwards through noise that is periodic in the scroll direction (the y coordinate is
 *     wrapped onto a circle in noise space), each layer a whole number of cycles per loop;
 *   - crack glow and the ember bed breathe through 4D noise driven by a time circle;
 *   - every spark rises on its own period, a whole number of times per loop.
 */
import { THREE } from '../three-layer';
import { textureMaterial } from '../ambient/assets';
import { BASIC_VERT, FBM4, HASH, NOISE4 } from '../ambient/glsl';
import { perLoop, timeCircle } from '../ambient/loop';
import { FIRE, FIREBOX } from './layout';

const FLAME_FRAG = /* glsl */ `
${NOISE4}
varying vec2 vUv;
uniform float uPhase;   // t / loopS
uniform vec2 uCycles;   // scroll cycles per loop for the two noise layers
uniform float uSeed;
uniform float uBright;
// Noise that scrolls upward and repeats: the vertical coordinate goes round a circle.
float rising(vec2 p, float k, float cycles, float seed) {
  float a = 6.2831853 * (p.y * k - cycles * uPhase);
  return snoise(vec4(p.x * 3.4 * k + seed, 0.6 * k * cos(a), 0.6 * k * sin(a), seed * 1.7));
}
void main() {
  vec2 p = vUv;
  float x = (p.x - 0.5) * 2.0;
  // Turbulence bends the flame sideways, more the higher it goes.
  float bend = rising(p, 0.7, uCycles.x * 0.7, uSeed) * 0.3 * p.y;
  float w = mix(0.9, 0.18, p.y);
  float profile = clamp(1.0 - abs(x + bend) / w, 0.0, 1.0);
  float n = 0.62 * rising(p, 1.0, uCycles.x, uSeed + 3.1) + 0.38 * rising(p, 2.1, uCycles.y, uSeed + 7.3);
  // Heat falls off with height; noise carves it into separate tongues.
  float heat = profile * 1.35 - p.y * 1.05 + n * 0.55;
  float f = smoothstep(0.08, 0.55, heat) * smoothstep(0.0, 0.06, p.y);
  vec3 deep = vec3(0.6, 0.07, 0.01);
  vec3 orange = vec3(1.0, 0.33, 0.04);
  vec3 yellow = vec3(1.0, 0.66, 0.22);
  vec3 col = mix(deep, orange, smoothstep(0.1, 0.5, heat));
  col = mix(col, yellow, smoothstep(0.55, 1.0, heat));
  gl_FragColor = vec4(col * f * uBright, 1.0);
}
`;

const CRACKS_FRAG = /* glsl */ `
${NOISE4}
${FBM4}
varying vec3 vWorld;
uniform vec2 uT;
uniform float uBright;
void main() {
  vec3 p = vWorld * 9.0;
  float n = fbm4(vec4(p, 0.0) + vec4(0.0, 0.0, uT.x, uT.y) * 0.35, 3);
  // Thin bright veins where the noise crosses zero, a deeper glow underneath.
  float vein = smoothstep(0.12, 0.0, abs(n));
  float under = smoothstep(${(FIRE.y + 0.22).toFixed(3)}, ${FIRE.y.toFixed(3)}, vWorld.y);
  float pulse = 0.65 + 0.35 * snoise(vec4(vWorld * 2.0, uT * 0.6));
  vec3 col = vec3(1.0, 0.32, 0.05) * vein * (0.4 + 0.9 * under) * pulse;
  gl_FragColor = vec4(col * uBright, 1.0);
}
`;

const BED_FRAG = /* glsl */ `
${NOISE4}
${FBM4}
varying vec2 vUv;
uniform vec2 uT;
uniform float uBright;
void main() {
  vec2 c = vUv - 0.5;
  float r = length(c * vec2(1.0, 1.6));
  float n = fbm4(vec4(vUv * 11.0, uT * 0.5), 4);
  float glow = smoothstep(0.5, 0.05, r) * smoothstep(-0.25, 0.45, n);
  vec3 col = mix(vec3(0.5, 0.06, 0.0), vec3(1.0, 0.42, 0.08), glow * glow);
  gl_FragColor = vec4(col * glow * uBright, 1.0);
}
`;

const SPARK_VERT = /* glsl */ `
attribute vec4 aSpark; // period (s), phase (0..1), drift seed, size
uniform float uT;
uniform float uScale;
varying float vLife;
void main() {
  float life = fract(uT / aSpark.x + aSpark.y);
  vLife = life;
  float h = life * (0.55 + 0.6 * fract(aSpark.z * 7.13));
  vec3 p = position;
  p.y += h;
  p.x += sin(life * 9.0 + aSpark.z * 40.0) * 0.05 * life + (fract(aSpark.z * 3.7) - 0.5) * 0.2 * life;
  p.z += cos(life * 7.0 + aSpark.z * 23.0) * 0.03 * life;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSpark.w * uScale / -mv.z;
}
`;

const SPARK_FRAG = /* glsl */ `
varying float vLife;
uniform float uBright;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = smoothstep(0.5, 0.0, length(c));
  float fade = smoothstep(0.0, 0.08, vLife) * (1.0 - smoothstep(0.55, 1.0, vLife));
  vec3 col = mix(vec3(1.0, 0.75, 0.35), vec3(0.9, 0.18, 0.02), vLife);
  gl_FragColor = vec4(col * d * fade * uBright * 1.1, 1.0);
}
`;

const CANDLE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uFlicker;
void main() {
  vec2 p = vUv - vec2(0.5, 0.0);
  p.x /= 0.32;
  float h = vUv.y;
  float d = length(vec2(p.x, (h - 0.35) * 1.1)) - (0.35 - 0.25 * h);
  float f = smoothstep(0.08, -0.12, d) * smoothstep(0.0, 0.08, h);
  vec3 col = mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.95, 0.8), smoothstep(0.2, 0.9, f) * (1.0 - h));
  gl_FragColor = vec4(col * f * uFlicker * 1.6, 1.0);
}
`;

const additive = (frag: string, uniforms: Record<string, THREE.IUniform>, vert = BASIC_VERT) =>
  new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });

/** A flame sheet's settings: position offset, size, and how fast its two noise layers scroll. */
interface Sheet {
  dx: number;
  dz: number;
  w: number;
  h: number;
  speed: [number, number];
  seed: number;
  bright: number;
}

export interface Fire {
  group: THREE.Group;
  update(t: number, L: number, size: number, flicker: number): void;
}

export function buildFire(camera: THREE.Vector3, candles: THREE.Vector3[]): Fire {
  const group = new THREE.Group();
  const base = new THREE.Vector3(FIRE.x, FIRE.y, FIRE.z);

  // ---- Grate and logs -----------------------------------------------------------------------
  const iron = new THREE.MeshStandardMaterial({ color: 0x1a1612, roughness: 0.6, metalness: 0.7 });
  for (const dz of [-0.08, 0.1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.025, 0.025), iron);
    bar.position.set(FIRE.x, FIRE.y + 0.06, FIRE.z + dz);
    group.add(bar);
  }
  for (const dx of [-0.36, 0.36]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.08, 0.3), iron);
    leg.position.set(FIRE.x + dx, FIRE.y + 0.04, FIRE.z);
    group.add(leg);
  }
  const bark = textureMaterial('bark_brown_02', [1, 1], { color: 0x6a5444 });
  const charred = new THREE.MeshStandardMaterial({ color: 0x15100c, roughness: 0.95 });
  const crackUniforms = { uT: { value: new THREE.Vector2() }, uBright: { value: 1 } };
  const cracks = additive(CRACKS_FRAG, crackUniforms);
  const logs: [number, number, number, number, number, number][] = [
    // x, y, z (offsets), yaw, pitch, length
    [-0.05, 0.13, -0.05, 0.25, 0.05, 0.72],
    [0.08, 0.13, 0.09, -0.35, -0.04, 0.66],
    [0.0, 0.25, 0.02, 0.05, 0.18, 0.6],
  ];
  for (const [x, y, z, yaw, pitch, len] of logs) {
    const g = new THREE.CylinderGeometry(0.075, 0.085, len, 16, 1);
    g.rotateZ(Math.PI / 2);
    const log = new THREE.Mesh(g, [bark, charred, charred]);
    log.position.set(FIRE.x + x, FIRE.y + y, FIRE.z + z);
    log.rotation.set(0, yaw, pitch);
    log.castShadow = true;
    group.add(log);
    const glow = new THREE.Mesh(g, cracks);
    glow.position.copy(log.position);
    glow.rotation.copy(log.rotation);
    glow.scale.setScalar(1.004);
    group.add(glow);
  }

  // ---- Ember bed ------------------------------------------------------------------------------------
  const bedUniforms = { uT: { value: new THREE.Vector2() }, uBright: { value: 1 } };
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.5), additive(BED_FRAG, bedUniforms));
  bed.rotation.x = -Math.PI / 2;
  bed.position.set(FIRE.x, FIREBOX.bottom + 0.004, FIRE.z);
  group.add(bed);

  // ---- Flame sheets, each turned to face the camera -----------------------------------------------
  const sheets: Sheet[] = [
    { dx: 0.0, dz: 0.02, w: 0.6, h: 0.72, speed: [1.25, 2.1], seed: 1.3, bright: 0.7 },
    { dx: -0.2, dz: -0.04, w: 0.4, h: 0.5, speed: [1.5, 2.6], seed: 4.7, bright: 0.55 },
    { dx: 0.21, dz: 0.05, w: 0.42, h: 0.55, speed: [1.4, 2.3], seed: 8.2, bright: 0.55 },
    { dx: -0.04, dz: -0.1, w: 0.5, h: 0.85, speed: [1.1, 1.9], seed: 17.4, bright: 0.4 },
  ];
  const flameMats: THREE.ShaderMaterial[] = [];
  const flameMeshes: THREE.Mesh[] = [];
  for (const sh of sheets) {
    const m = additive(FLAME_FRAG, { uPhase: { value: 0 }, uCycles: { value: new THREE.Vector2() }, uSeed: { value: sh.seed }, uBright: { value: sh.bright } });
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(FIRE.x + sh.dx, FIRE.y + 0.1, FIRE.z + sh.dz);
    mesh.rotation.y = Math.atan2(camera.x - mesh.position.x, camera.z - mesh.position.z);
    mesh.renderOrder = 2;
    group.add(mesh);
    flameMats.push(m);
    flameMeshes.push(mesh);
  }

  // ---- Sparks -----------------------------------------------------------------------------------------
  const N = 22;
  const pos = new Float32Array(N * 3);
  const spark = new Float32Array(N * 4);
  let seed = 9;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < N; i++) {
    pos.set([FIRE.x + (rnd() - 0.5) * 0.4, FIRE.y + 0.2, FIRE.z + (rnd() - 0.5) * 0.2], i * 3);
    spark.set([2.5 + rnd() * 4, rnd(), rnd(), 0.8 + rnd() * 0.9], i * 4);
  }
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const sparkAttr = new THREE.BufferAttribute(spark, 4);
  sparkGeo.setAttribute('aSpark', sparkAttr);
  const sparkMat = new THREE.ShaderMaterial({
    vertexShader: SPARK_VERT,
    fragmentShader: SPARK_FRAG,
    uniforms: { uT: { value: 0 }, uScale: { value: 16 }, uBright: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  group.add(sparks);
  let sparkLoop = 0;

  // ---- Candle flames ----------------------------------------------------------------------------------
  const candleMats = candles.map((c, i) => {
    const m = additive(CANDLE_FRAG, { uFlicker: { value: 1 } });
    const geo = new THREE.PlaneGeometry(0.04, 0.075);
    geo.translate(0, 0.0375, 0);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.copy(c);
    mesh.rotation.y = Math.atan2(camera.x - c.x, camera.z - c.z);
    group.add(mesh);
    return { m, mesh, seed: i * 1.37 };
  });

  return {
    group,
    update(t, L, size, flicker) {
      // Spark periods rounded to whole cycles per loop (once per loop length).
      if (sparkLoop !== L) {
        for (let i = 0; i < N; i++) spark[i * 4] = L / Math.max(1, Math.round(L / spark[i * 4]));
        sparkAttr.needsUpdate = true;
        sparkLoop = L;
      }
      const grow = 0.55 + 0.6 * size;
      sheets.forEach((sh, i) => {
        const u = flameMats[i].uniforms;
        u.uPhase.value = t / L;
        (u.uCycles.value as THREE.Vector2).set(perLoop(sh.speed[0], L) * L, perLoop(sh.speed[1], L) * L);
        u.uBright.value = sh.bright * (0.85 + 0.25 * flicker);
        flameMeshes[i].scale.set(sh.w * grow, sh.h * grow * (0.9 + 0.15 * flicker), 1);
      });
      const tc = timeCircle(t, L, 0.25);
      (crackUniforms.uT.value as THREE.Vector2).set(tc[0], tc[1]);
      crackUniforms.uBright.value = (0.7 + 0.5 * size) * (0.85 + 0.2 * flicker);
      (bedUniforms.uT.value as THREE.Vector2).set(tc[0], tc[1]);
      bedUniforms.uBright.value = (0.6 + 0.5 * size) * (0.9 + 0.15 * flicker);
      sparkMat.uniforms.uT.value = t;
      sparkMat.uniforms.uBright.value = 0.5 + 0.6 * size;
      for (const c of candleMats) {
        const k = 0.9 + 0.06 * Math.sin(2 * Math.PI * perLoop(6.3, L) * t + c.seed) + 0.04 * Math.sin(2 * Math.PI * perLoop(11.7, L) * t + c.seed * 3);
        c.m.uniforms.uFlicker.value = k;
        c.mesh.scale.set(1, k, 1);
      }
    },
  };
}
