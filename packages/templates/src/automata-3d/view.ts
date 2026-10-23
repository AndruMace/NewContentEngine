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

/** Cube detail for a grid this many cells across: the bigger the grid, the smaller each cube on screen. */
export const detailFor = (cells: number): 0 | 1 | 2 => (cells <= 72 ? 2 : cells <= 120 ? 1 : 0);

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
  /** Slot mode: cubes written since the last flush, and whether the buffers were reallocated. */
  private dirty: number[] = [];
  private regrown = false;
  /** First cube changed since the last upload. */
  private from = 0;
  private capacity = 0;
  private readonly geometry: THREE.BufferGeometry;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly material: THREE.Material,
    look: LookId,
    capacity = 4096,
    /** Bevel detail: 2 fully rounded (300 triangles), 1 lighter (108), 0 plain boxes (12) for very many cubes. */
    detail: 0 | 1 | 2 = 2,
    /** Gap between cubes, instead of the look's. */
    gap?: number,
  ) {
    const l = LOOK[look];
    const side = 1 - (gap ?? l.gap);
    this.geometry = detail ? new RoundedBoxGeometry(side, side, side, detail, l.bevel * side) : new THREE.BoxGeometry(side, side, side);
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
    this.write(this.n++, x, y, z, s, r, g, b, glow);
  }

  private write(k: number, x: number, y: number, z: number, s: number, r: number, g: number, b: number, glow: number) {
    if (k >= this.capacity) this.grow(Math.max(k + 1, this.capacity * 2));
    const m = this.matrices;
    const o = k * 16;
    m[o] = s;
    m[o + 5] = s;
    m[o + 10] = s;
    m[o + 12] = x;
    m[o + 13] = y;
    m[o + 14] = z;
    m[o + 15] = 1;
    const c = k * 3;
    this.colors[c] = r;
    this.colors[c + 1] = g;
    this.colors[c + 2] = b;
    this.glows[k] = glow;
  }

  /**
   * Slot mode, for a buffer kept in step with a list elsewhere: write cube k, move one cube over
   * another, set how many are drawn, then `flush()` uploads just the cubes that changed.
   */
  put(k: number, x: number, y: number, z: number, s: number, r: number, g: number, b: number, glow: number) {
    this.write(k, x, y, z, s, r, g, b, glow);
    this.dirty.push(k);
  }

  move(from: number, to: number) {
    this.matrices.copyWithin(to * 16, from * 16, from * 16 + 16);
    this.colors.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.glows[to] = this.glows[from];
    this.dirty.push(to);
  }

  setCount(n: number) {
    this.n = n;
  }

  flush() {
    this.mesh.count = this.n;
    const d = this.dirty;
    if (!d.length && !this.regrown) return;
    const glow = this.geometry.getAttribute('aGlow') as THREE.InstancedBufferAttribute;
    const attrs: [THREE.BufferAttribute, number][] = [
      [this.mesh.instanceMatrix, 16],
      [this.mesh.instanceColor!, 3],
      [glow, 1],
    ];
    for (const [a] of attrs) {
      a.needsUpdate = true;
      a.clearUpdateRanges();
    }
    if (this.regrown || d.length > this.n / 8) {
      for (const [a, w] of attrs) a.addUpdateRange(0, this.n * w);
    } else {
      // Changed cubes as a few runs (gaps under 256 cubes are uploaded rather than split on).
      d.sort((a, b) => a - b);
      let lo = d[0];
      let hi = d[0];
      const emit = () => {
        for (const [a, w] of attrs) a.addUpdateRange(lo * w, (hi - lo + 1) * w);
      };
      for (let q = 1; q < d.length; q++) {
        if (d[q] - hi > 256) {
          emit();
          lo = d[q];
        }
        hi = Math.max(hi, d[q]);
      }
      emit();
    }
    this.dirty.length = 0;
    this.regrown = false;
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
    // All of the old buffers (in slot mode, cubes past the count may hold data too).
    const [m, c, g] = [this.matrices, this.colors, this.glows];
    this.parent.remove(old);
    old.dispose();
    this.mesh = this.build(capacity);
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;
    this.colors = this.mesh.instanceColor!.array as Float32Array;
    this.glows = (this.geometry.getAttribute('aGlow') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.matrices.set(m);
    this.colors.set(c);
    this.glows.set(g);
    this.from = 0;
    this.regrown = true;
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
  /** Pixels the picture is shifted up (to clear text at the bottom). */
  lift: number;
  /** Key light's bearing from the camera's, radians (to the left). */
  keyTurn: number;
  /** Skip ambient occlusion (it needs real geometry; dots have none). */
  noAo: boolean;
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
  return { scene, camera, key, look, cell: 1, lift: 0, keyTurn: 0.8, noAo: false };
}

/** Point the camera from an orbit (azimuth, elevation in radians, distance) round a target. */
export function orbit(st: Stage, target: THREE.Vector3, az: number, el: number, dist: number) {
  const { camera, key } = st;
  camera.position.set(target.x + Math.cos(el) * Math.sin(az) * dist, target.y + Math.sin(el) * dist, target.z + Math.cos(el) * Math.cos(az) * dist);
  camera.near = Math.max(0.5, dist * 0.05);
  camera.far = dist * 6;
  if (st.lift) camera.setViewOffset(1080, 1920, 0, st.lift, 1080, 1920);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  camera.lookAt(target);
  // The key light rides with the camera, up and to the left, so the lit side always faces the viewer.
  key.position.set(target.x + Math.sin(az - st.keyTurn) * dist, target.y + dist * 0.9, target.z + Math.cos(az - st.keyTurn) * dist);
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
  draw3DComposed(ctx, st.scene, st.camera, { exposure: l.exposure, bloom: l.bloom, ao: l.ao && !st.noAo ? { radius: l.ao * st.cell } : undefined });
}

/**
 * Cells drawn as one shaded square dot each instead of a 12-triangle cube: for patterns so big a cell
 * is a few pixels across, where a million cubes would be wasted work. Each dot is lit by its own
 * normal (the way its open faces point), so faceted surfaces still read. Same slot interface as
 * Voxels' (put / move / setCount / flush).
 */
export class Dots {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.BufferGeometry();
  private capacity = 0;
  private n = 0;
  private dirty: number[] = [];
  private regrown = false;
  private pos!: Float32Array;
  private col!: Float32Array;
  private nrm!: Float32Array;
  private size!: Float32Array;
  private glow!: Float32Array;

  constructor(parent: THREE.Object3D, look: LookId, capacity: number) {
    const l = LOOK[look];
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 1 }, uLight: { value: new THREE.Vector3(0, 0, 1) }, uAmbient: { value: 0.32 }, uKey: { value: 0.8 }, uGlowBase: { value: l.glowBase } },
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; attribute float aGlow;
        uniform float uScale;
        varying vec3 vColor; varying vec3 vNormal; varying float vGlow;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.0, uScale * aSize / -mv.z);
          vColor = aColor; vGlow = aGlow;
          vNormal = length(normal) > 0.0 ? normalize(normalMatrix * normal) : vec3(0.0, 0.0, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uLight; uniform float uAmbient; uniform float uKey; uniform float uGlowBase;
        varying vec3 vColor; varying vec3 vNormal; varying float vGlow;
        void main() {
          float lit = uAmbient + uKey * max(0.0, dot(vNormal, uLight));
          gl_FragColor = vec4(vColor * (lit + vGlow + uGlowBase), 1.0);
        }`,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.alloc(capacity);
    parent.add(this.points);
  }

  private alloc(capacity: number) {
    const old = this.capacity ? [this.pos, this.col, this.nrm, this.size, this.glow] : null;
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.nrm = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.glow = new Float32Array(capacity);
    if (old) [this.pos, this.col, this.nrm, this.size, this.glow].forEach((a, q) => a.set(old[q]));
    const attr = (a: Float32Array, w: number) => new THREE.BufferAttribute(a, w).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', attr(this.pos, 3));
    this.geometry.setAttribute('aColor', attr(this.col, 3));
    this.geometry.setAttribute('normal', attr(this.nrm, 3));
    this.geometry.setAttribute('aSize', attr(this.size, 1));
    this.geometry.setAttribute('aGlow', attr(this.glow, 1));
    this.regrown = true;
  }

  /** Dot k at (x, y, z), s cells across, colour (r, g, b), glow, lit as if facing (nx, ny, nz). */
  put(k: number, x: number, y: number, z: number, s: number, r: number, g: number, b: number, glow: number, nx: number, ny: number, nz: number) {
    if (k >= this.capacity) this.alloc(Math.max(k + 1, this.capacity * 2));
    const o = k * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.col[o] = r;
    this.col[o + 1] = g;
    this.col[o + 2] = b;
    this.nrm[o] = nx;
    this.nrm[o + 1] = ny;
    this.nrm[o + 2] = nz;
    this.size[k] = s;
    this.glow[k] = glow;
    this.dirty.push(k);
  }

  move(from: number, to: number) {
    for (const [a, w] of [[this.pos, 3], [this.col, 3], [this.nrm, 3], [this.size, 1], [this.glow, 1]] as [Float32Array, number][]) a.copyWithin(to * w, from * w, from * w + w);
    this.dirty.push(to);
  }

  setCount(n: number) {
    this.n = n;
  }

  /** Upload what changed, and aim the light and size the dots for this camera. */
  flush(camera?: THREE.PerspectiveCamera, light?: THREE.Vector3) {
    this.geometry.setDrawRange(0, this.n);
    if (camera) this.material.uniforms.uScale.value = (1920 / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15;
    if (light) (this.material.uniforms.uLight.value as THREE.Vector3).copy(light);
    const d = this.dirty;
    if (!d.length && !this.regrown) return;
    const attrs = (['position', 'aColor', 'normal', 'aSize', 'aGlow'] as const).map((name) => this.geometry.getAttribute(name) as THREE.BufferAttribute);
    for (const a of attrs) {
      a.needsUpdate = true;
      a.clearUpdateRanges();
    }
    // Many changes: one upload of everything beats sorting them.
    if (this.regrown || d.length > this.n / 8) for (const a of attrs) a.addUpdateRange(0, this.n * a.itemSize);
    else {
      d.sort((a, b) => a - b);
      let lo = d[0];
      let hi = d[0];
      const emit = () => {
        for (const a of attrs) a.addUpdateRange(lo * a.itemSize, (hi - lo + 1) * a.itemSize);
      };
      for (let q = 1; q < d.length; q++) {
        if (d[q] - hi > 256) {
          emit();
          lo = d[q];
        }
        hi = Math.max(hi, d[q]);
      }
      emit();
    }
    this.dirty.length = 0;
    this.regrown = false;
  }
}
