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

/** Render the scene and draw it over the current 2D frame. */
export function draw3D(ctx: Ctx2D, scene: THREE.Scene, camera: THREE.Camera) {
  const { renderer, canvas } = get();
  renderer.render(scene, camera);
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
