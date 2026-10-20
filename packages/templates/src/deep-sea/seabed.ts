/**
 * The seabed: sand dunes (or coral gravel on the reef) running off into the dark, rocks half sunk in
 * it, and on the reef coral and shells. Everything is lit by the WATER kit (sunlight from above,
 * caustics, the floodlight) and fades into the water with distance.
 *
 * The station drifts sideways, so the seabed slides past: its dunes are computed on the GPU at ring
 * position x + s (waves with a whole number of cycles over the drift D, so it repeats), and rocks,
 * coral and shells are recycled through slots (schedule.ts), each pass a different shape and size.
 */
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { THREE } from '../three-layer';
import { model, textureSet } from '../ambient/assets';
import { SEABED_Y, WALL } from './layout';
import { WATER, type WaterUniforms } from './water';
import { hash2, slotPass, slotX, type Depth } from './schedule';

const VERT = /* glsl */ `
attribute vec3 color;
varying vec3 vWorld;
varying vec3 vLocal;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vUv = uv;
  vColor = color;
  vLocal = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const GROUND_FRAG = /* glsl */ `
${WATER}
varying vec3 vWorld;
varying vec3 vLocal;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
uniform sampler2D uMap;
uniform float uScale;      // texture repeats per metre (triplanar) or UV scale
uniform float uTriplanar;
uniform vec3 uTint;
uniform float uUseColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo;
  if (uTriplanar > 0.5) {
    vec3 b = pow(abs(n), vec3(4.0));
    b /= b.x + b.y + b.z;
    // In the object's own space, so the texture rides with a rock as it slides past.
    albedo = texture2D(uMap, vLocal.yz * uScale).rgb * b.x + texture2D(uMap, vLocal.xz * uScale).rgb * b.y + texture2D(uMap, vLocal.xy * uScale).rgb * b.z;
  } else albedo = texture2D(uMap, vUv * uScale).rgb;
  // (sRGB textures are decoded to linear by the GPU when sampled.)
  albedo = albedo * uTint * (uUseColor > 0.5 ? vColor : vec3(1.0));
  vec3 col = albedo * (lightAt(vWorld, n) + vec3(0.004, 0.008, 0.012));
  gl_FragColor = vec4(fogged(col, vWorld), 1.0);
}
`;

const COLOR_FRAG = /* glsl */ `
${WATER}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 col = vColor * (lightAt(vWorld, n) + vec3(0.004, 0.008, 0.012));
  gl_FragColor = vec4(fogged(col, vWorld), 1.0);
}
`;

/** Visual-only randomness. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296);
}

/** Smooth value noise in 3D (visual only: rock shapes). */
function vnoise(x: number, y: number, z: number, seed: number) {
  const h = (i: number, j: number, k: number) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1440662683) ^ Math.imul(seed, 2246822519);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const f = (v: number) => v * v * (3 - 2 * v);
  const [u, v, w] = [f(x - xi), f(y - yi), f(z - zi)];
  let out = 0;
  for (let k = 0; k < 2; k++)
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) out += h(xi + i, yi + j, zi + k) * (i ? u : 1 - u) * (j ? v : 1 - v) * (k ? w : 1 - w);
  return out;
}

/** Wavenumbers along x for the dunes: whole cycles over the drift D (≈ 0.45 and 0.17 rad/m). */
export const duneK = (D: number): [number, number] => [0.45, 0.17].map((k) => (2 * Math.PI * Math.max(1, Math.round((k * D) / (2 * Math.PI)))) / D) as [number, number];

/** Height of the seabed at ring position x (along the drift) and z: gentle dunes falling away. */
export function seabedY(x: number, z: number, k: [number, number]) {
  const d = WALL - z;
  return SEABED_Y + 0.35 * Math.sin(x * k[0] + z * 0.2) + 0.25 * Math.sin(x * k[1] - z * 0.33 + 1.3) - 0.035 * Math.max(0, d - 6);
}

/** The same dunes on the GPU (the seabed mesh slides under the station). */
const SEABED_VERT = /* glsl */ `
uniform float uS;
uniform vec2 uK;
varying vec3 vWorld;
varying vec3 vLocal;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vec3 p = position;
  float xr = p.x + uS;
  float d = ${WALL.toFixed(3)} - p.z;
  float a1 = xr * uK.x + p.z * 0.2;
  float a2 = xr * uK.y - p.z * 0.33 + 1.3;
  p.y = ${SEABED_Y.toFixed(3)} + 0.35 * sin(a1) + 0.25 * sin(a2) - 0.035 * max(0.0, d - 6.0);
  float dx = 0.35 * uK.x * cos(a1) + 0.25 * uK.y * cos(a2);
  float dz = 0.35 * 0.2 * cos(a1) - 0.25 * 0.33 * cos(a2) + (d > 6.0 ? 0.035 : 0.0);
  vNormal = normalize(vec3(-dx, 1.0, -dz));
  vUv = vec2(xr, -p.z);
  vColor = vec3(1.0);
  vLocal = p;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

function rockGeometry(seed: number, size: number) {
  const g = new THREE.IcosahedronGeometry(1, 4);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
    const k = 0.65 + 0.5 * vnoise(v.x * 1.6 + seed, v.y * 1.6, v.z * 1.6, seed) + 0.15 * vnoise(v.x * 5, v.y * 5, v.z * 5 + seed, seed + 1);
    v.multiplyScalar(k * size);
    v.y *= 0.6;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** A branching coral: tapering cylinders forking upwards, one colour per colony. */
function coralGeometry(r: () => number, color: THREE.Color) {
  const parts: THREE.BufferGeometry[] = [];
  const grow = (base: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, depth: number) => {
    const g = new THREE.CylinderGeometry(rad * 0.7, rad, len, 7, 1);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    g.translate(base.x, base.y, base.z);
    parts.push(g);
    if (depth <= 0) return;
    const tip = base.clone().addScaledVector(dir, len);
    const kids = 2 + Math.floor(r() * 2);
    for (let k = 0; k < kids; k++) {
      const d = dir.clone().add(new THREE.Vector3(r() - 0.5, r() * 0.4, r() - 0.5).multiplyScalar(1.2)).normalize();
      grow(tip, d, len * (0.65 + r() * 0.2), rad * 0.7, depth - 1);
    }
  };
  grow(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 0.25 + r() * 0.15, 0.04, 3);
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  const c = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < c.length; i += 3) {
    c[i] = color.r;
    c[i + 1] = color.g;
    c[i + 2] = color.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

export interface Seabed {
  group: THREE.Group;
  /** How far the station has drifted (m). */
  update(s: number): void;
}

/** A recycled thing on the seabed: which slot, its window, and how to set it up for a pass. */
interface Item {
  obj: THREE.Object3D;
  slot: number;
  W: number;
  pass: number;
  setup(k: number): { d: number; scale: number; ry: number; lift: number };
  d: number;
  lift: number;
}

export function buildSeabed(depth: Depth, U: WaterUniforms, seed: number, D: number): Seabed {
  const group = new THREE.Group();
  const reef = depth === 'reef';
  const sand = textureSet(reef ? 'coral_gravel' : 'coast_sand_01');
  const rock = textureSet('dark_rock');
  const k = duneK(D);
  const groundMat = (map: THREE.Texture, scale: number, tri: boolean, tint: number[], vert = VERT, extra: Record<string, THREE.IUniform> = {}) =>
    new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: GROUND_FRAG,
      uniforms: { ...U, uMap: { value: map }, uScale: { value: scale }, uTriplanar: { value: tri ? 1 : 0 }, uTint: { value: new THREE.Vector3(...tint) }, uUseColor: { value: 0 }, ...extra },
    });

  // The seabed: a big flat grid the GPU bends into dunes at ring position x + s. Texture scales
  // (0.35, 0.4 repeats per metre) repeat a whole number of times over D (a multiple of 60 m).
  const g = new THREE.PlaneGeometry(220, 220, 220, 220);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, WALL - 108);
  const bedTint = depth === 'abyss' ? [0.55, 0.55, 0.6] : reef ? [1.0, 0.95, 0.85] : [0.75, 0.8, 0.85];
  sand.map.wrapS = sand.map.wrapT = THREE.RepeatWrapping;
  const bedU = { uS: { value: 0 }, uK: { value: new THREE.Vector2(k[0], k[1]) } };
  const bed = new THREE.Mesh(g, groundMat(sand.map, reef ? 0.4 : 0.35, false, bedTint, SEABED_VERT, bedU));
  bed.frustumCulled = false;
  group.add(bed);

  const items: Item[] = [];
  const add = (obj: THREE.Object3D, slot: number, W: number, setup: Item['setup']) => {
    group.add(obj);
    items.push({ obj, slot, W, pass: -1, setup, d: 10, lift: 0 });
  };

  // Rocks: 30 slots on a 60 m window, eight shapes; each pass a new shape, size, depth and turn.
  const r = rng(seed);
  const rockMat = groundMat(rock.map, 0.6, true, [0.8, 0.82, 0.85]);
  rock.map.wrapS = rock.map.wrapT = THREE.RepeatWrapping;
  const rockGeos = Array.from({ length: 8 }, (_, i) => rockGeometry(Math.floor(r() * 1000) + i, 1));
  for (let i = 0; i < 30; i++) {
    const mesh = new THREE.Mesh(rockGeos[0], rockMat);
    add(mesh, (i + r() * 0.8) / 30, 60, (kk) => {
      const h = (salt: number) => hash2(seed + i * 977 + salt, kk);
      mesh.geometry = rockGeos[Math.floor(h(1) * rockGeos.length)];
      const d = 7 + Math.pow(h(2), 0.7) * 40;
      const size = 0.5 + h(3) * 2.2 * (0.5 + d / 50);
      return { d, scale: size, ry: h(4) * Math.PI * 2, lift: size * 0.1 };
    });
  }

  if (reef) {
    // Coral: 60 slots on a 40 m window, ten colony shapes in five colours.
    const colors = [0xd8735a, 0xb85a9a, 0xe8b060, 0x7ab0a0, 0xd89090].map((c) => new THREE.Color(c).convertSRGBToLinear());
    const coralMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COLOR_FRAG, uniforms: U });
    const coralGeos = Array.from({ length: 10 }, (_, i) => coralGeometry(r, colors[i % colors.length]));
    for (let i = 0; i < 60; i++) {
      const mesh = new THREE.Mesh(coralGeos[0], coralMat);
      add(mesh, (i + r() * 0.8) / 60, 40, (kk) => {
        const h = (salt: number) => hash2(seed + i * 613 + salt, kk + 7);
        mesh.geometry = coralGeos[Math.floor(h(1) * coralGeos.length)];
        return { d: 5 + Math.pow(h(2), 0.8) * 28, scale: 1.5 + h(3) * 3, ry: h(4) * 6.28, lift: -0.05 };
      });
    }
    // A few shells on the sand.
    const shell = model('lambis_shell');
    shell.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      mesh.material = groundMat(src.map!, 1, false, [1, 1, 1]);
    });
    for (let i = 0; i < 3; i++) {
      const sh = shell.clone(true);
      add(sh, i / 3 + r() * 0.2, 60, (kk) => {
        const h = (salt: number) => hash2(seed + i * 31 + salt, kk + 3);
        return { d: 6 + h(1) * 8, scale: 1.8 + h(2), ry: h(3) * 6.28, lift: 0.02 };
      });
    }
  }

  return {
    group,
    update(s) {
      bedU.uS.value = s;
      for (const it of items) {
        const x = slotX(it.slot, it.W, s);
        const kk = slotPass(it.slot, it.W, s, D);
        if (kk !== it.pass) {
          const o = it.setup(kk);
          it.obj.scale.setScalar(o.scale);
          it.obj.rotation.y = o.ry;
          it.d = o.d;
          it.lift = o.lift;
          it.pass = kk;
        }
        // Only what could be in view (the porthole sees about ±0.45 of the distance to either side).
        const z = WALL - it.d;
        it.obj.visible = Math.abs(x) < 4 + it.d * 0.6;
        if (it.obj.visible) it.obj.position.set(x, seabedY(x + s, z, k) + it.lift, z);
      }
    },
  };
}
