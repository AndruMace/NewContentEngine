/**
 * Third-party files for the long-form templates (assets/ambient, all CC0, listed in manifest.json):
 * textures, glTF models and recordings, loaded once before rendering (Template.preload) and then
 * looked up synchronously while drawing. Browser only: headless runs never touch them.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { THREE } from '../three-layer';

let base = 'assets/';
/** Where assets/ambient is served from (the render page and the Playground serve it at different URLs). */
export function setAssetBase(url: string) {
  base = url.endsWith('/') ? url : `${url}/`;
}

const textures = new Map<string, THREE.Texture>();
const models = new Map<string, THREE.Group>();
const sounds = new Map<string, AudioBuffer>();
const pending = new Map<string, Promise<unknown>>();

function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = pending.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    pending.set(key, p);
    p.catch(() => pending.delete(key));
  }
  return p;
}

export interface TextureSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** Poly Haven "arm": ambient occlusion (R), roughness (G), metalness (B). */
  arm: THREE.Texture;
}

/** A Poly Haven texture set: textures/<id>/<id>_{diff,nor_gl,arm}_<res>.jpg. */
export async function loadTextureSet(id: string, res: '1k' | '2k') {
  const loader = new THREE.TextureLoader();
  await Promise.all(
    (['diff', 'nor_gl', 'arm'] as const).map((kind) => {
      const path = `textures/${id}/${id}_${kind}_${res}.jpg`;
      return once(path, async () => {
        const tex = await loader.loadAsync(base + path);
        tex.colorSpace = kind === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 8;
        textures.set(`${id}:${kind}`, tex);
      });
    }),
  );
}

/** A loaded texture set, with its own repeat (the three maps share it). Throws if not preloaded. */
export function textureSet(id: string, repeat: [number, number] = [1, 1]): TextureSet {
  const get = (kind: string) => {
    const t = textures.get(`${id}:${kind}`);
    if (!t) throw new Error(`Texture not loaded: ${id} (${kind})`);
    const c = t.clone();
    c.repeat.set(repeat[0], repeat[1]);
    c.needsUpdate = true;
    return c;
  };
  return { map: get('diff'), normalMap: get('nor_gl'), arm: get('arm') };
}

/** A physically based material from a texture set (AO, roughness and metalness from the packed map). */
export function textureMaterial(id: string, repeat: [number, number] = [1, 1], extra: THREE.MeshStandardMaterialParameters = {}) {
  const t = textureSet(id, repeat);
  return new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, aoMap: t.arm, roughnessMap: t.arm, metalnessMap: t.arm, roughness: 1, metalness: 1, ...extra });
}

/** A Poly Haven model: models/<id>/<id>_1k.gltf. */
export function loadModel(id: string) {
  const path = `models/${id}/${id}_1k.gltf`;
  return once(path, async () => {
    const gltf = await new GLTFLoader().loadAsync(base + path);
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = m.receiveShadow = true;
    });
    models.set(id, gltf.scene);
  });
}

/** A fresh copy of a loaded model (shares geometry and materials). Throws if not preloaded. */
export function model(id: string): THREE.Group {
  const m = models.get(id);
  if (!m) throw new Error(`Model not loaded: ${id}`);
  return m.clone(true);
}

/**
 * A recording, decoded once (AudioBuffers can be shared between audio contexts). `durationS` trims
 * or pads to an exact length: a bed must be exactly as long as its loop, whatever the decoder adds.
 */
export function loadSound(path: string, durationS?: number) {
  return once(path, async () => {
    const bytes = await (await fetch(base + path)).arrayBuffer();
    const ctx = new OfflineAudioContext(2, 1, 48000);
    let buf = await ctx.decodeAudioData(bytes);
    if (durationS !== undefined) {
      const n = Math.round(durationS * 48000);
      if (buf.length !== n) {
        const exact = ctx.createBuffer(buf.numberOfChannels, n, 48000);
        for (let c = 0; c < buf.numberOfChannels; c++) exact.copyToChannel(buf.getChannelData(c).subarray(0, n), c);
        buf = exact;
      }
    }
    sounds.set(path, buf);
  });
}

/** Every recording loaded so far, for the offline audio render. */
export const loadedSounds = (): Map<string, AudioBuffer> => sounds;
