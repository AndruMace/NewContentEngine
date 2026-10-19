/**
 * Orbital Viewport scene: the ship's interior, the planet beyond the viewport, and deep space,
 * built once; each frame sets what moves from t and the cue schedule (see index.ts).
 */
import type { RenderCtx } from '@sim/engine';
import { THREE, draw3DComposed, environmentMap, sceneCache } from '../three-layer';
import { drawGrain } from '../ambient/grain';
import { loadTextureSet } from '../ambient/assets';
import { drift, loopSin } from '../ambient/loop';
import { buildPlanet } from './planet';
import { buildSpace } from './space';
import { CABIN_TINTS, buildShip } from './ship';
import { CAMERA, PLANET, PLANET_FAR, SUN, VIEWPORT, WALL_Z } from './layout';
import type { OrbitalViewportParams, OrbitState } from './index';

export const preloadOrbit = (_p: OrbitalViewportParams) => Promise.all([loadTextureSet('metal_plate_02', '1k'), loadTextureSet('blue_metal_plate', '1k')]).then(() => undefined);

function vignette(rc: RenderCtx) {
  const { ctx, width: W, height: H } = rc;
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 1.0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

const view = sceneCache((s: OrbitState) => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  // Soft reflections so the metal reads (without them it shows only black and highlights).
  scene.environment = environmentMap();
  scene.environmentIntensity = 0.12;
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.05, 12000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();

  const sun = new THREE.Vector3(...SUN).normalize();
  const ship = buildShip(s.p.cabinLight);
  scene.add(ship.group);
  const where = s.p.rings || s.p.planet === 'gas' ? PLANET_FAR : PLANET;
  const planet = buildPlanet({ type: s.p.planet, rings: s.p.rings, moons: s.p.moons, seed: s.look, center: new THREE.Vector3(...where.center), radius: where.radius, sun, tilt: where.tilt });
  scene.add(planet.group);

  // Viewport (u, v in 0..1) → screen (NDC), from where the opening's edges project.
  const ndc = (x: number, y: number) => new THREE.Vector3(x, y, WALL_Z).project(camera);
  const lo = ndc(-VIEWPORT.halfW, VIEWPORT.cy - VIEWPORT.halfH);
  const hi = ndc(VIEWPORT.halfW, VIEWPORT.cy + VIEWPORT.halfH);
  const aperture = (u: number, v: number): [number, number] => [lo.x + (hi.x - lo.x) * u, lo.y + (hi.y - lo.y) * v];
  const space = buildSpace(camera, s.look, aperture);
  scene.add(space.group);

  // Cabin lights in the chosen colour, a soft fill, sunlight through the viewport, planet glow.
  const tint = CABIN_TINTS[s.p.cabinLight];
  const cabin = new THREE.PointLight(tint, 3.5, 0, 2);
  cabin.position.set(0, VIEWPORT.cy + VIEWPORT.halfH + 0.35, WALL_Z + 0.35);
  scene.add(cabin);
  const fill = new THREE.PointLight(tint, 2.0, 0, 2);
  fill.position.set(0, 0.6, 1.2);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(tint.clone().multiplyScalar(0.4), new THREE.Color(0x0a0c10), 0.6));
  // The sun is behind us: only a faint wash reaches the cabin (from the ports behind).
  const sunLight = new THREE.DirectionalLight(0xfff2e0, 0.3);
  sunLight.position.copy(sun).multiplyScalar(20);
  sunLight.target.position.set(0, -0.8, -1.2);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.autoUpdate = false;
  sunLight.shadow.needsUpdate = true;
  const sc = sunLight.shadow.camera;
  sc.left = -5;
  sc.right = 5;
  sc.top = 5;
  sc.bottom = -5;
  sc.near = 1;
  sc.far = 40;
  scene.add(sunLight, sunLight.target);
  const planetGlow = new THREE.DirectionalLight(0x6f8fc8, 0.35);
  planetGlow.position.set(0, -6, -10);
  scene.add(planetGlow);

  return { scene, camera, ship, planet, space, cabin };
});

export function drawOrbit(rc: RenderCtx, s: OrbitState) {
  const v = view(s, rc.theme);
  const L = s.loopS;
  const t = rc.t;
  v.ship.update(t, L);
  v.planet.update(t, L);
  // The cabin light breathes very slightly (air handlers), whole cycles per loop.
  v.cabin.intensity = 3.5 * (0.97 + 0.03 * loopSin(t, L, 1 / 23));
  // A slow sway, as if the ship were drifting on station.
  v.camera.position.set(drift(t, L, 0.012, 1), drift(t, L, 0.008, 2), 0);
  v.camera.lookAt(drift(t, L, 0.02, 3), drift(t, L, 0.012, 4), -1);
  v.camera.aspect = rc.width / rc.height;
  v.camera.updateProjectionMatrix();
  v.camera.updateMatrixWorld();
  v.space.update(t, L, s.meteors);
  draw3DComposed(rc.ctx, v.scene, v.camera, { exposure: 1.0, bloom: { strength: 0.5, radius: 0.5, threshold: 0.85 } });
  vignette(rc);
  drawGrain(rc.ctx, rc.frame, rc.width, rc.height, 0.045);
}
