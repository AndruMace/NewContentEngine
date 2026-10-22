/**
 * Shared 3D drawing for the automata: instanced rounded cubes (one draw call for every voxel), each
 * with its own colour, size and glow, lit for one of the looks. Rendering only.
 */
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { paletteAt, type Ctx2D, type Theme } from '@sim/engine';
import { THREE, draw3DComposed, environmentMap } from '../three-layer';
import type { LookId } from './params';

interface Look {
  roughness: number;
  metalness: number;
  envIntensity: number;
  /** Emission every voxel has from its own colour (neon glows), on top of a newborn's flash. */
  glowBase: number;
  /** Gap between neighbouring cubes, as a fraction of a cell. */
  gap: number;
  bevel: number;
  key: number;
  fill: number;
  exposure: number;
  bloom: { strength: number; radius: number; threshold: number };
  /** Ambient occlusion between cubes (cells), or none. */
  ao: number;
}

const LOOK: Record<LookId, Look> = {
  glossy: { roughness: 0.42, metalness: 0.05, envIntensity: 0.22, glowBase: 0, gap: 0.08, bevel: 0.14, key: 1.3, fill: 0.55, exposure: 1.0, bloom: { strength: 0.22, radius: 0.4, threshold: 2.8 }, ao: 1.6 },
  clay: { roughness: 0.9, metalness: 0, envIntensity: 0.3, glowBase: 0, gap: 0.04, bevel: 0.22, key: 1.5, fill: 0.7, exposure: 1.0, bloom: { strength: 0.12, radius: 0.4, threshold: 1.8 }, ao: 2.2 },
  neon: { roughness: 0.45, metalness: 0, envIntensity: 0.15, glowBase: 0.3, gap: 0.16, bevel: 0.1, key: 0.35, fill: 0.15, exposure: 1.0, bloom: { strength: 0.4, radius: 0.35, threshold: 1.1 }, ao: 0 },
};

/** A palette of linear-light colours sampled from the theme (`at(u)` for u in 0..1). */
export class Palette {
  private readonly lut: Float32Array;
  constructor(colors: string[], readonly steps = 64) {
    this.lut = new Float32Array(steps * 3);
    const c = new THREE.Color();
    for (let i = 0; i < steps; i++) {
      const [r, g, b] = paletteAt(colors, i / (steps - 1));
      c.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
      this.lut.set([c.r, c.g, c.b], i * 3);
    }
  }

  /** Writes the colour at u (wrapping when `cycle`) into out[o..o+2]. */
  write(out: Float32Array, o: number, u: number, k = 1, cycle = false) {
    let x = cycle ? u - Math.floor(u) : Math.max(0, Math.min(1, u));
    if (cycle) x = x < 0.5 ? x * 2 : 2 - x * 2;
    const i = Math.round(x * (this.steps - 1)) * 3;
    out[o] = this.lut[i] * k;
    out[o + 1] = this.lut[i + 1] * k;
    out[o + 2] = this.lut[i + 2] * k;
  }
}

/** sRGB hex → linear [r, g, b]. */
export function linear(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/**
 * Instanced voxels. Fill with `begin()`, `push(...)` per cube, `end()` (or `keep(n)` to add to what's
 * there); capacity grows as needed.
 */
export class Voxels {
  mesh: THREE.InstancedMesh;
  private matrices: Float32Array;
  private colors: Float32Array;
  private glows: Float32Array;
  private n = 0;
  /** First cube changed since the last upload. */
  private from = 0;
  private capacity = 0;
  private readonly geometry: THREE.BufferGeometry;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly material: THREE.Material,
    look: LookId,
    capacity = 4096,
    /** Plain boxes (a twelfth of the triangles) for scenes with very many cubes. */
    plain = false,
  ) {
    const l = LOOK[look];
    const side = 1 - l.gap;
    this.geometry = plain ? new THREE.BoxGeometry(side, side, side) : new RoundedBoxGeometry(side, side, side, 2, l.bevel * side);
    this.mesh = this.build(capacity);
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;
    this.colors = this.mesh.instanceColor!.array as Float32Array;
    this.glows = (this.geometry.getAttribute('aGlow') as THREE.InstancedBufferAttribute).array as Float32Array;
  }

  private build(capacity: number): THREE.InstancedMesh {
    this.capacity = capacity;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aGlow', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.parent.add(mesh);
    return mesh;
  }

  begin() {
    this.n = 0;
    this.from = 0;
  }

  /** Keep the first `count` cubes and add after them (only the new ones are uploaded). */
  keep(count: number) {
    this.n = Math.min(this.n, count);
    this.from = this.n;
  }

  /** A cube at (x, y, z) scaled by s, with colour (r, g, b) in linear light and glow g. */
  push(x: number, y: number, z: number, s: number, r: number, g: number, b: number, glow: number) {
    if (this.n >= this.capacity) this.grow(this.capacity * 2);
    const m = this.matrices;
    const o = this.n * 16;
    m[o] = s;
    m[o + 5] = s;
    m[o + 10] = s;
    m[o + 12] = x;
    m[o + 13] = y;
    m[o + 14] = z;
    m[o + 15] = 1;
    const c = this.n * 3;
    this.colors[c] = r;
    this.colors[c + 1] = g;
    this.colors[c + 2] = b;
    this.glows[this.n] = glow;
    this.n++;
  }

  end() {
    const { from, n } = this;
    this.mesh.count = n;
    if (n > from) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(from * 16, (n - from) * 16);
      this.mesh.instanceColor!.needsUpdate = true;
      this.mesh.instanceColor!.clearUpdateRanges();
      this.mesh.instanceColor!.addUpdateRange(from * 3, (n - from) * 3);
      const glow = this.geometry.getAttribute('aGlow') as THREE.InstancedBufferAttribute;
      glow.needsUpdate = true;
      glow.clearUpdateRanges();
      glow.addUpdateRange(from, n - from);
    }
    this.from = n;
  }

  get count() {
    return this.n;
  }

  private grow(capacity: number) {
    const old = this.mesh;
    const [m, c, g, n] = [this.matrices, this.colors, this.glows, this.n];
    this.parent.remove(old);
    old.dispose();
    this.mesh = this.build(capacity);
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;
    this.colors = this.mesh.instanceColor!.array as Float32Array;
    this.glows = (this.geometry.getAttribute('aGlow') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.matrices.set(m.subarray(0, n * 16));
    this.colors.set(c.subarray(0, n * 3));
    this.glows.set(g.subarray(0, n));
    this.from = 0;
  }
}

/** Standard material plus a per-cube glow (aGlow): emission in the cube's own colour. */
export function voxelMaterial(look: LookId, opts: { opacity?: number } = {}): THREE.MeshStandardMaterial {
  const l = LOOK[look];
  const mat = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, roughness: l.roughness, metalness: l.metalness, envMapIntensity: l.envIntensity });
  if (opts.opacity !== undefined && opts.opacity < 1) {
    mat.transparent = true;
    mat.opacity = opts.opacity;
    mat.depthWrite = false;
  }
  const base = l.glowBase.toFixed(3);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * (vGlow + ${base});`);
  };
  mat.customProgramCacheKey = () => `automata-voxel-${look}`;
  return mat;
}

export interface Stage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  key: THREE.DirectionalLight;
  look: LookId;
  /** World size of a cell (AO radius scales with it). */
  cell: number;
}

/** Scene, camera and lights for a look (the theme's background shows through). */
export function makeStage(theme: Theme, look: LookId): Stage {
  const l = LOOK[look];
  const scene = new THREE.Scene();
  scene.environment = environmentMap();
  const camera = new THREE.PerspectiveCamera(34, 1080 / 1920, 0.5, 5000);
  const accent = new THREE.Color(theme.accent);
  scene.add(new THREE.HemisphereLight(0xffffff, accent.clone().multiplyScalar(0.25), l.fill));
  const key = new THREE.DirectionalLight(0xffffff, l.key);
  scene.add(key);
  scene.add(key.target);
  const rim = new THREE.DirectionalLight(accent, l.key * 0.3);
  rim.position.set(-1, 0.4, -1.2);
  scene.add(rim);
  return { scene, camera, key, look, cell: 1 };
}

/** Point the camera from an orbit (azimuth, elevation in radians, distance) round a target. */
export function orbit(st: Stage, target: THREE.Vector3, az: number, el: number, dist: number) {
  const { camera, key } = st;
  camera.position.set(target.x + Math.cos(el) * Math.sin(az) * dist, target.y + Math.sin(el) * dist, target.z + Math.cos(el) * Math.cos(az) * dist);
  camera.near = Math.max(0.5, dist * 0.05);
  camera.far = dist * 6;
  camera.updateProjectionMatrix();
  camera.lookAt(target);
  // The key light rides with the camera, up and to the left, so the lit side always faces the viewer.
  key.position.set(target.x + Math.sin(az - 0.8) * dist, target.y + dist * 0.9, target.z + Math.cos(az - 0.8) * dist);
  key.target.position.copy(target);
}

/** Distance at which a sphere of radius r fills `fill` of the frame's width (portrait: width is the tight side). */
export function fitDistance(camera: THREE.PerspectiveCamera, r: number, fill = 0.8): number {
  const halfH = THREE.MathUtils.degToRad(camera.fov / 2);
  const halfW = Math.atan(Math.tan(halfH) * camera.aspect);
  return r / Math.sin(halfW) / fill;
}

export function drawStage(ctx: Ctx2D, st: Stage) {
  const l = LOOK[st.look];
  draw3DComposed(ctx, st.scene, st.camera, { exposure: l.exposure, bloom: l.bloom, ao: l.ao ? { radius: l.ao * st.cell } : undefined });
}
