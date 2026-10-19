/**
 * Shared 3D drawing for templates: one WebGL renderer (browsers cap live WebGL contexts) that
 * renders a template's three.js scene onto a transparent canvas, which is then drawn into the
 * normal 2D frame. Bloom, overlays and the theme background all work as for 2D templates.
 *
 * Rendering only: simulation never touches three.js, so seed search and the Node/Chrome
 * determinism check are unaffected.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { VIDEO_HEIGHT, VIDEO_WIDTH, type Ctx2D, type Theme } from '@sim/engine';

interface Shared {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  env: THREE.Texture;
}

let shared: Shared | null = null;

/** Size the shared renderer to the frame being drawn (Shorts are 1080×1920, long-form 1920×1080). */
function fit(ctx: Ctx2D): Shared {
  const sh = get();
  const { width, height } = ctx.canvas;
  if (sh.canvas.width !== width || sh.canvas.height !== height) sh.renderer.setSize(width, height, false);
  return sh;
}

function get(): Shared {
  if (shared) return shared;
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: VIDEO_WIDTH, height: VIDEO_HEIGHT }) : new OffscreenCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const renderer = new THREE.WebGLRenderer({ canvas: canvas as HTMLCanvasElement, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(VIDEO_WIDTH, VIDEO_HEIGHT, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  shared = { renderer, canvas, env };
  return shared;
}

/** Studio-style reflections for glossy materials (assign to scene.environment). */
export const environmentMap = () => get().env;

/** Render the scene and draw it over the current 2D frame (optionally at another exposure / tone map). */
export function draw3D(ctx: Ctx2D, scene: THREE.Scene, camera: THREE.Camera, opts: { exposure?: number; toneMapping?: THREE.ToneMapping } = {}) {
  const { renderer, canvas } = fit(ctx);
  const exposure = renderer.toneMappingExposure;
  const toneMapping = renderer.toneMapping;
  if (opts.exposure !== undefined) renderer.toneMappingExposure = opts.exposure;
  if (opts.toneMapping !== undefined) renderer.toneMapping = opts.toneMapping;
  renderer.render(scene, camera);
  renderer.toneMappingExposure = exposure;
  renderer.toneMapping = toneMapping;
  ctx.drawImage(canvas as CanvasImageSource, 0, 0, canvas.width, canvas.height);
}

/**
 * Render a fragment shader once into a texture (e.g. a planet's surface map, generated at load).
 * The shader gets `vUv` (0..1 over the texture). Linear float data is kept (HalfFloat).
 */
export function bakeTexture(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, width: number, height: number): THREE.Texture {
  const { renderer } = get();
  const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true, wrapS: THREE.RepeatWrapping });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new THREE.ShaderMaterial({ vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader, uniforms });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  scene.add(quad);
  const prev = renderer.getRenderTarget();
  const tone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(target);
  // In strips, each finished before the next is sent: one draw over millions of pixels of heavy noise
  // is a single long GPU job, the kind a GPU watchdog kills (on the software renderer it came out black).
  const strips = Math.max(1, Math.ceil((width * height) / 262_144));
  const rows = Math.ceil(height / strips);
  target.scissorTest = true;
  const gl = renderer.getContext();
  for (let y = 0; y < height; y += rows) {
    target.scissor.set(0, y, width, Math.min(rows, height - y));
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    gl.finish();
  }
  target.scissorTest = false;
  renderer.setRenderTarget(prev);
  renderer.toneMapping = tone;
  quad.geometry.dispose();
  mat.dispose();
  return target.texture;
}

/**
 * A studio environment of our own for reflections: a dark room lit by a few large softboxes, so
 * metal reflects soft highlights on black (a product-photo look) rather than a bright white room.
 * Built once per call site and cached by key.
 */
const studioEnvs = new Map<string, THREE.Texture>();
export function studioEnvironment(key: string, build: (scene: THREE.Scene) => void): THREE.Texture {
  const cached = studioEnvs.get(key);
  if (cached) return cached;
  const { renderer } = get();
  const scene = new THREE.Scene();
  build(scene);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  studioEnvs.set(key, tex);
  return tex;
}

interface Composed {
  composer: EffectComposer;
  ao: GTAOPass | null;
  bokeh: BokehPass | null;
  bloom: UnrealBloomPass | null;
  camera: THREE.Camera;
}
const composers = new WeakMap<THREE.Scene, Composed>();

/**
 * Render through a post-processing chain (ambient occlusion, depth of field, then tone mapping in
 * the output pass) and draw it over the current 2D frame. One composer per scene, reused.
 */
export function draw3DComposed(
  ctx: Ctx2D,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  opts: {
    exposure?: number;
    toneMapping?: THREE.ToneMapping;
    ao?: { radius: number; scale?: number };
    dof?: { focus: number; aperture: number; maxblur: number };
    /** Glow around bright things (flames, lightning), in linear light before tone mapping. */
    bloom?: { strength: number; radius: number; threshold: number };
  } = {},
) {
  const { renderer, canvas } = fit(ctx);
  let c = composers.get(scene);
  if (!c || c.camera !== camera) {
    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(1);
    composer.setSize(canvas.width, canvas.height);
    composer.addPass(new RenderPass(scene, camera));
    let ao: GTAOPass | null = null;
    if (opts.ao) {
      ao = new GTAOPass(scene, camera, canvas.width, canvas.height);
      ao.output = GTAOPass.OUTPUT.Default;
      composer.addPass(ao);
    }
    let bokeh: BokehPass | null = null;
    if (opts.dof) {
      bokeh = new BokehPass(scene, camera, { focus: opts.dof.focus, aperture: opts.dof.aperture, maxblur: opts.dof.maxblur });
      composer.addPass(bokeh);
    }
    let bloom: UnrealBloomPass | null = null;
    if (opts.bloom) {
      bloom = new UnrealBloomPass(new THREE.Vector2(canvas.width / 2, canvas.height / 2), opts.bloom.strength, opts.bloom.radius, opts.bloom.threshold);
      composer.addPass(bloom);
    }
    composer.addPass(new OutputPass());
    c = { composer, ao, bokeh, bloom, camera };
    composers.set(scene, c);
  }
  if (c.bloom && opts.bloom) {
    c.bloom.strength = opts.bloom.strength;
    c.bloom.radius = opts.bloom.radius;
    c.bloom.threshold = opts.bloom.threshold;
  }
  if (c.ao && opts.ao) c.ao.updateGtaoMaterial({ radius: opts.ao.radius, scale: opts.ao.scale ?? 1, thickness: opts.ao.radius });
  if (c.bokeh && opts.dof) {
    const u = c.bokeh.uniforms as Record<string, { value: number }>;
    u.focus.value = opts.dof.focus;
    u.aperture.value = opts.dof.aperture;
    u.maxblur.value = opts.dof.maxblur;
  }
  const exposure = renderer.toneMappingExposure;
  const toneMapping = renderer.toneMapping;
  if (opts.exposure !== undefined) renderer.toneMappingExposure = opts.exposure;
  if (opts.toneMapping !== undefined) renderer.toneMapping = opts.toneMapping;
  c.composer.render();
  renderer.toneMappingExposure = exposure;
  renderer.toneMapping = toneMapping;
  ctx.drawImage(canvas as CanvasImageSource, 0, 0, canvas.width, canvas.height);
}

/**
 * One live scene per template module: building a scene for a new run disposes the previous run's
 * GPU resources (the Playground restarts runs constantly).
 */
export function sceneCache<S extends object, T extends { scene: THREE.Scene }>(build: (s: S, theme: Theme) => T): (s: S, theme: Theme) => T {
  let owner: S | null = null;
  let value: T | null = null;
  return (s: S, theme: Theme) => {
    if (owner === s && value) return value;
    if (value) disposeScene(value.scene);
    owner = s;
    value = build(s, theme);
    return value;
  };
}

function disposeScene(scene: THREE.Scene) {
  composers.get(scene)?.composer.dispose();
  composers.delete(scene);
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
}

/** A texture drawn with the 2D canvas API (flags, stripes, gradients). */
export function canvasTexture(w: number, h: number, draw: (ctx: Ctx2D) => void): THREE.Texture {
  const c: HTMLCanvasElement | OffscreenCanvas = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : new OffscreenCanvas(w, h);
  draw(c.getContext('2d') as Ctx2D);
  const tex = new THREE.CanvasTexture(c as HTMLCanvasElement);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export { THREE };
