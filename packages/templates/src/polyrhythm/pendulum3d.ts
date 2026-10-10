/**
 * 3D pendulum-wave apparatus (rendering only): a frame with a row of pendulums receding from the
 * camera. String lengths follow real physics (period ∝ √length), so slower pendulums hang longer.
 */
import { lighten, paletteAt, type Ctx2D, type Theme } from '@sim/engine';
import { THREE, draw3D, environmentMap, sceneCache } from '../three-layer';

/** The polyrhythm state fields the scene reads (the scene is cached per state object). */
export interface PendulumView3D {
  /** Full swings per loop per pendulum, slowest first. */
  cycles: number[];
  p: { loopSeconds: number };
  colorShift: number;
  flash: number[];
}

const ROW = 3.2; // length of the row (z)
const L_MAX = 1.55; // longest string
const TOP = 1.15; // height of the bar
const AMP = 0.42; // swing amplitude (radians)

const view = sceneCache((s: PendulumView3D, theme: Theme) => {
  const scene = new THREE.Scene();
  scene.environment = environmentMap();
  scene.environmentIntensity = 0.35;
  const camera = new THREE.PerspectiveCamera(40, 1080 / 1920, 0.05, 50);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a24, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(2.5, 4, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 0.5, far: 12 });
  sun.shadow.bias = -0.001;
  scene.add(sun);

  const metal = new THREE.MeshStandardMaterial({ color: 0xc8ccd6, metalness: 0.9, roughness: 0.28 });
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, ROW + 0.5, 24), metal);
  bar.rotation.x = Math.PI / 2;
  bar.position.y = TOP;
  bar.castShadow = true;
  scene.add(bar);
  const floorY = TOP - L_MAX - 0.35;
  for (const z of [-(ROW + 0.4) / 2, (ROW + 0.4) / 2]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, TOP - floorY, 20), metal);
    post.position.set(0, (TOP + floorY) / 2, z);
    post.castShadow = true;
    scene.add(post);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.35 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = floorY;
  floor.receiveShadow = true;
  scene.add(floor);

  const n = s.cycles.length;
  const strMat = new THREE.MeshBasicMaterial({ color: 0xdfe6ff, transparent: true, opacity: 0.55 });
  const stringGeo = new THREE.CylinderGeometry(0.004, 0.004, 1, 6);
  stringGeo.translate(0, -0.5, 0); // pivot at the top
  const bobGeo = new THREE.SphereGeometry(1, 40, 28);
  const slowest = Math.min(...s.cycles);
  const pendulums = s.cycles.map((rate, i) => {
    const z = -ROW / 2 + (i * ROW) / Math.max(1, n - 1);
    const len = L_MAX * (slowest / rate) ** 2;
    const pivot = new THREE.Group();
    pivot.position.set(0, TOP, z);
    const str = new THREE.Mesh(stringGeo, strMat);
    str.scale.set(1, len, 1);
    pivot.add(str);
    const col = paletteAt(theme.palette, ((i / Math.max(1, n - 1)) * 0.95 + s.colorShift) % 1);
    const color = new THREE.Color(`rgb(${col.map((c) => Math.round(c)).join(',')})`);
    const bobMat = new THREE.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.22, clearcoat: 0.8, emissive: new THREE.Color(`rgb(${lighten(col, 0.3).map((c) => Math.round(c)).join(',')})`), emissiveIntensity: 0 });
    const bob = new THREE.Mesh(bobGeo, bobMat);
    bob.scale.setScalar(Math.min(0.075, (ROW / n) * 0.38));
    bob.position.y = -len;
    bob.castShadow = true;
    pivot.add(bob);
    scene.add(pivot);
    return { pivot, bobMat };
  });
  return { scene, camera, pendulums };
});

export function drawPendulums3D(ctx: Ctx2D, theme: Theme, s: PendulumView3D, t: number) {
  const v = view(s, theme);
  v.pendulums.forEach((p, i) => {
    p.pivot.rotation.z = AMP * Math.cos((2 * Math.PI * s.cycles[i] * t) / s.p.loopSeconds);
    p.bobMat.emissiveIntensity = 0.35 * s.flash[i];
  });
  // Three-quarter view down the row, drifting slightly.
  const az = 0.38 + 0.05 * Math.sin(t * 0.25);
  const dist = 6.3;
  v.camera.position.set(Math.sin(az) * dist, 1.6, Math.cos(az) * dist);
  v.camera.lookAt(0, 0.5, -0.3);
  draw3D(ctx, v.scene, v.camera);
}
