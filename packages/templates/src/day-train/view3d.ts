/**
 * Day Train scene: the compartment (Night Train's, furnished as a day coach), the land outside with
 * its sky, woods and settlements, rain on the glass, built once; each frame sets how far the train
 * has come, which features shape the land near the window, and the little bumps of the wheels.
 */
import type { RenderCtx } from '@sim/engine';
import { THREE, draw3DComposed, sceneCache } from '../three-layer';
import { drawGrain } from '../ambient/grain';
import { buildRainGlass } from '../ambient/glass';
import { loadModel, loadTextureSet } from '../ambient/assets';
import { drift, loopSin, timeCircle } from '../ambient/loop';
import { buildCompartment } from '../night-train/compartment';
import { jolt } from '../night-train/view3d';
import { distanceAt, ringPos, speedAt } from '../night-train/track';
import { CAMERA, CEILING, WALL, WINDOW } from '../night-train/layout';
import { LIGHTS, setFeatures, setLight, worldUniforms, type Mode } from './world';
import { buildSky } from './sky';
import { buildTerrain } from './terrain';
import { buildTrees } from './plants';
import { farShapes, nearShapes, villageShapes } from './settlements';
import { buildTowns } from './towns';
import { buildTrackside } from './trackside';
import type { DayTrainState } from './index';

export const preloadDay = () =>
  Promise.all([
    loadTextureSet('velour_velvet', '1k'),
    loadTextureSet('black_walnut_veneer_01', '2k'),
    loadTextureSet('dirty_carpet', '1k'),
    loadTextureSet('metal_plate_02', '1k'),
    loadModel('vintage_suitcase'),
  ]).then(() => undefined);

const modeOf = (s: DayTrainState): Mode => (s.p.weather === 'rain' ? 'rain' : s.p.timeOfDay);

const view = sceneCache((s: DayTrainState) => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.03, 9000);
  const U = worldUniforms();
  const dir = s.p.facing === 'forward' ? -1 : 1;

  const room = buildCompartment({ cloth: 0x22324c, curtain: 0x2a3a58, seat: 'bench' });
  scene.add(room.group);
  const sky = buildSky(U);
  scene.add(sky.mesh);
  const trees = buildTrees(U);
  scene.add(trees.group);
  const land = buildTerrain(U, trees.states[0]);
  scene.add(land.group);
  const towns = buildTowns(U, s.towns, s.tt.motion.D);
  scene.add(towns.group);
  const side = buildTrackside(U);
  scene.add(side.group);

  // Rain on the glass, blown back along the window by the train's speed (as on the Night Train).
  const cx = (WINDOW.x0 + WINDOW.x1) / 2;
  const cy = (WINDOW.y0 + WINDOW.y1) / 2;
  const down = Math.min(1, Math.max(0.15, 9 / s.tt.motion.v));
  const flowLen = Math.hypot(1, down);
  const glass = buildRainGlass({
    panes: [{ center: [cx, cy, WALL - 0.03], width: WINDOW.x1 - WINDOW.x0, height: WINDOW.y1 - WINDOW.y0, lightDir: [1, 0.6], reflectSide: 1 }],
    flow: [-dir / flowLen, -down / flowLen],
    runSpeed: 6,
    runDensity: 2.5,
    creep: 0.03,
    dropScale: 0.45,
    lightColor: [0.9, 0.93, 1.0],
  });
  scene.add(glass.group);

  // Daylight in the room: the sun through the window (its frame's shadow on the table and seat),
  // the sky's light from the glass, a little bounce; the lamps are only lit in tunnels and rain.
  const sun = new THREE.DirectionalLight(0xfff0d8, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  sun.shadow.bias = -0.0015;
  sun.shadow.radius = 3;
  const sc = sun.shadow.camera;
  sc.left = -3;
  sc.right = 3;
  sc.top = 3;
  sc.bottom = -3;
  sc.near = 0.5;
  sc.far = 30;
  sun.target.position.set(0, 0.6, 0.3);
  scene.add(sun, sun.target);
  const skyFill = new THREE.PointLight(0xc8daf0, 1, 0, 2);
  skyFill.position.set(cx, cy, WALL - 0.5);
  scene.add(skyFill);
  const bounce = new THREE.HemisphereLight(0xb8c8e0, 0x6a5040, 0.35);
  scene.add(bounce);
  const lamp = new THREE.PointLight(0xffa860, 0, 0, 2);
  lamp.position.copy(room.lampAt);
  scene.add(lamp);
  const ceiling = new THREE.PointLight(0xffe0b0, 0, 0, 2);
  ceiling.position.set(0, CEILING - 0.2, (WALL + 1.4) / 2);
  scene.add(ceiling);

  return { scene, camera, U, room, sky, land, trees, towns, side, glass, sun, skyFill, bounce, lamp, ceiling, dir, mode: '' as Mode | '' };
});

export function drawDay(rc: RenderCtx, s: DayTrainState) {
  const v = view(s, rc.theme);
  const L = s.loopS;
  const t = rc.t;
  const { motion, clicks } = s.tt;
  const dist = distanceAt(motion, t);
  const sNow = ringPos(dist, motion.D);
  const speed = speedAt(motion, t);
  const mode = modeOf(s);
  const light = LIGHTS[mode];
  const U = v.U;

  U.uS.value = sNow;
  U.uD.value = motion.D;
  U.uDir.value = v.dir;
  U.uPhase.value = t / L;
  U.uLoop.value = L;
  const tc = timeCircle(t, L, 0.01);
  U.uTC.value.set(tc[0], tc[1]);
  U.uBlur.value = speed / 60;
  setLight(U, light);
  const near = nearShapes(s.tt, dist);
  setFeatures(U, farShapes(s.towns, s.tt, dist), near, villageShapes(s.towns, dist, motion.D));
  // How far into a tunnel the window is (0..1): the room goes dark but for its lamps.
  let tunnel = 0;
  for (const f of near) if (f.kind === 4) tunnel = Math.max(tunnel, Math.min(1, Math.max(0, Math.min(-f.rel0, f.rel1) / 4 + 0.5)));

  // The room's light follows the weather (and its sun's shadow is redrawn when the weather changes).
  const sunny = mode !== 'rain';
  if (v.mode !== mode) {
    v.mode = mode;
    v.sun.position.set(...light.sunDir).multiplyScalar(12).add(v.sun.target.position);
    v.sun.shadow.needsUpdate = true;
  }
  v.sun.color.setRGB(...light.sunCol).multiplyScalar(1 / Math.max(...light.sunCol));
  const outside = 1 - tunnel;
  v.sun.intensity = (sunny ? (mode === 'golden' ? 2.6 : 2.2) : 0) * outside;
  v.skyFill.color.setRGB(...light.skyHorizon);
  v.skyFill.intensity = (sunny ? 1.6 : 1.1) * outside;
  v.bounce.intensity = (sunny ? 0.35 : 0.3) * (0.15 + 0.85 * outside);
  const lampOn = Math.max(sunny ? 0 : 0.35, 0.55 * tunnel);
  v.ceiling.intensity = 0.5 * tunnel;
  v.lamp.intensity = 0.6 * lampOn;
  v.room.shade.emissiveIntensity = 0.3 * lampOn;
  v.room.sconceGlass.emissiveIntensity = 0.12 * lampOn;

  v.side.update({ rain: sunny ? 0 : s.p.precip, v: speed, tunnel });
  v.glass.group.visible = !sunny;
  v.glass.update({ t, L, rain: sunny ? 0 : s.p.precip, flash: 0, light: 0.6, snow: false });

  // The carriage sways a little and jolts on the joints.
  const j = jolt(clicks, t, L);
  const sway = drift(t, L, 0.006, 1);
  const [px, py, pz] = CAMERA.pos;
  v.camera.position.set(px + sway, py + drift(t, L, 0.003, 2) + 0.0009 * j, pz);
  const [tx, ty, tz] = CAMERA.target;
  v.camera.lookAt(tx + sway * 0.5, ty + 0.0006 * j, tz);
  v.camera.aspect = rc.width / rc.height;
  v.camera.updateProjectionMatrix();
  v.camera.updateMatrixWorld();
  U.uEye.value.copy(v.camera.position);
  v.sky.update(v.camera.position, light.clouds);
  v.trees.update((2 * Math.PI * Math.round(L / 6) * t) / L);
  v.towns.update(dist, (2 * Math.PI * Math.round(L / 9) * t) / L, (2 * Math.PI * Math.round(L * 0.9) * t) / L);
  for (const [i, c] of v.room.curtains.entries()) c.rotation.x = 0.02 * loopSin(t, L, 1 / 7.3, i * 1.7) + 0.004 * j;

  v.trees.place();
  draw3DComposed(rc.ctx, v.scene, v.camera, { exposure: 1.0, bloom: { strength: 0.25, radius: 0.5, threshold: 1.6 } });
  drawGrain(rc.ctx, rc.frame, rc.width, rc.height, 0.035);
}
