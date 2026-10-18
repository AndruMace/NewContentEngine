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
import { VIDEO_HEIGHT, VIDEO_WIDTH, type Ctx2D, type Theme } from '@sim/engine';

interface Shared {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  env: THREE.Texture;
}

let shared: Shared | null = null;

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
  const { renderer, canvas } = get();
  const exposure = renderer.toneMappingExposure;
  const toneMapping = renderer.toneMapping;
  if (opts.exposure !== undefined) renderer.toneMappingExposure = opts.exposure;
  if (opts.toneMapping !== undefined) renderer.toneMapping = opts.toneMapping;
  renderer.render(scene, camera);
  renderer.toneMappingExposure = exposure;
  renderer.toneMapping = toneMapping;
  ctx.drawImage(canvas as CanvasImageSource, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
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
  opts: { exposure?: number; toneMapping?: THREE.ToneMapping; ao?: { radius: number; scale?: number }; dof?: { focus: number; aperture: number; maxblur: number } } = {},
) {
  const { renderer, canvas } = get();
  let c = composers.get(scene);
  if (!c || c.camera !== camera) {
    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(1);
    composer.setSize(VIDEO_WIDTH, VIDEO_HEIGHT);
    composer.addPass(new RenderPass(scene, camera));
    let ao: GTAOPass | null = null;
    if (opts.ao) {
      ao = new GTAOPass(scene, camera, VIDEO_WIDTH, VIDEO_HEIGHT);
      ao.output = GTAOPass.OUTPUT.Default;
      composer.addPass(ao);
    }
    let bokeh: BokehPass | null = null;
    if (opts.dof) {
      bokeh = new BokehPass(scene, camera, { focus: opts.dof.focus, aperture: opts.dof.aperture, maxblur: opts.dof.maxblur });
      composer.addPass(bokeh);
    }
    composer.addPass(new OutputPass());
    c = { composer, ao, bokeh, camera };
    composers.set(scene, c);
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
  ctx.drawImage(canvas as CanvasImageSource, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
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
