/**
 * The seabed: sand dunes (or coral gravel on the reef) running off into the dark, rocks half sunk in
 * it, and on the reef coral and a shell. Everything is lit by the WATER kit (sunlight from above,
 * caustics, the floodlight) and fades into the water with distance. Static.
 */
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { THREE } from '../three-layer';
import { model, textureSet } from '../ambient/assets';
import { SEABED_Y, WALL } from './layout';
import { WATER, type WaterUniforms } from './water';
import type { Depth } from './schedule';

const VERT = /* glsl */ `
attribute vec3 color;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vUv = uv;
  vColor = color;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const GROUND_FRAG = /* glsl */ `
${WATER}
varying vec3 vWorld;
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
    albedo = texture2D(uMap, vWorld.yz * uScale).rgb * b.x + texture2D(uMap, vWorld.xz * uScale).rgb * b.y + texture2D(uMap, vWorld.xy * uScale).rgb * b.z;
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

/** Height of the seabed at (x, z): gentle dunes, falling away with distance. */
export function seabedY(x: number, z: number) {
  const d = WALL - z;
  return SEABED_Y + 0.35 * Math.sin(x * 0.45 + z * 0.2) + 0.25 * Math.sin(x * 0.17 - z * 0.33 + 1.3) - 0.035 * Math.max(0, d - 6);
}

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

export function buildSeabed(depth: Depth, U: WaterUniforms, seed: number): THREE.Group {
  const group = new THREE.Group();
  const reef = depth === 'reef';
  const sand = textureSet(reef ? 'coral_gravel' : 'coast_sand_01');
  const rock = textureSet('dark_rock');
  const groundMat = (map: THREE.Texture, scale: number, tri: boolean, tint: number[]) =>
    new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: GROUND_FRAG,
      uniforms: { ...U, uMap: { value: map }, uScale: { value: scale }, uTriplanar: { value: tri ? 1 : 0 }, uTint: { value: new THREE.Vector3(...tint) }, uUseColor: { value: 0 } },
    });

  // The seabed: a big plane bent into dunes, finer near us.
  const g = new THREE.PlaneGeometry(220, 220, 220, 220);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, WALL - 108);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, seabedY(p.getX(i), p.getZ(i)));
  g.computeVertexNormals();
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 220, uv.getY(i) * 220);
  const bedTint = depth === 'abyss' ? [0.55, 0.55, 0.6] : reef ? [1.0, 0.95, 0.85] : [0.75, 0.8, 0.85];
  sand.map.wrapS = sand.map.wrapT = THREE.RepeatWrapping;
  group.add(new THREE.Mesh(g, groundMat(sand.map, reef ? 0.4 : 0.35, false, bedTint)));

  // Rocks, half sunk, scattered ahead (fewer close up so the view stays open).
  const r = rng(seed);
  const rockMat = groundMat(rock.map, 0.6, true, [0.8, 0.82, 0.85]);
  rock.map.wrapS = rock.map.wrapT = THREE.RepeatWrapping;
  for (let i = 0; i < 26; i++) {
    const d = 7 + Math.pow(r(), 0.7) * 45;
    const x = (r() - 0.5) * (8 + d * 1.1);
    const z = WALL - d;
    const size = 0.5 + r() * 2.2 * (0.5 + d / 50);
    const m = new THREE.Mesh(rockGeometry(Math.floor(r() * 1000), size), rockMat);
    m.position.set(x, seabedY(x, z) + size * 0.1, z);
    m.rotation.y = r() * Math.PI * 2;
    group.add(m);
  }

  if (reef) {
    // Coral colonies in a few colours (muted by the water), and a shell on the sand.
    const colors = [0xd8735a, 0xb85a9a, 0xe8b060, 0x7ab0a0, 0xd89090].map((c) => new THREE.Color(c).convertSRGBToLinear());
    const coralMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COLOR_FRAG, uniforms: U });
    for (let i = 0; i < 60; i++) {
      const d = 5 + Math.pow(r(), 0.8) * 30;
      const x = (r() - 0.5) * (6 + d);
      const z = WALL - d;
      const m = new THREE.Mesh(coralGeometry(r, colors[Math.floor(r() * colors.length)]), coralMat);
      m.scale.setScalar(1.5 + r() * 3);
      m.position.set(x, seabedY(x, z) - 0.05, z);
      m.rotation.y = r() * 6.28;
      group.add(m);
    }
    const shell = model('lambis_shell');
    shell.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      mesh.material = groundMat(src.map!, 1, false, [1, 1, 1]);
    });
    shell.scale.setScalar(2.2);
    shell.position.set(-1.6, seabedY(-1.6, WALL - 9) + 0.02, WALL - 9);
    shell.rotation.y = 0.8;
    group.add(shell);
  }
  return group;
}
