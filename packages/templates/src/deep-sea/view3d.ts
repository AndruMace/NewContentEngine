/**
 * Deep Sea Observatory scene: the station's interior, the porthole's glass beaded with condensation,
 * and the water outside (seabed, life, snow, light), built once per setting; each frame moves the
 * creatures, the bubbles and the gauge needles from t alone.
 */
import type { RenderCtx } from '@sim/engine';
import { THREE, draw3DComposed, sceneCache } from '../three-layer';
import { drawGrain } from '../ambient/grain';
import { buildRainGlass } from '../ambient/glass';
import { loadModel, loadTextureSet } from '../ambient/assets';
import { drift, loopSin, timeCircle } from '../ambient/loop';
import { buildStation } from './station';
import { ZONES, buildWater, waterUniforms } from './water';
import { buildSeabed } from './seabed';
import { buildLife } from './life';
import { passAt } from './schedule';
import { CAMERA, PORT, WALL } from './layout';
import type { DeepSeaParams, DeepSeaState } from './index';

export const preloadSea = (p: DeepSeaParams) =>
  Promise.all([
    loadTextureSet('rusty_painted_metal', '1k'),
    loadTextureSet(p.depth === 'reef' ? 'coral_gravel' : 'coast_sand_01', '2k'),
    loadTextureSet('dark_rock', '1k'),
    loadModel('industrial_wall_lamp'),
    loadModel('modular_industrial_pipes_01'),
    ...(p.depth === 'reef' ? [loadModel('lambis_shell')] : []),
  ]).then(() => undefined);

function vignette(rc: RenderCtx) {
  const { ctx, width: W, height: H } = rc;
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.36, W / 2, H / 2, H * 0.95);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

const view = sceneCache((s: DeepSeaState) => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.03, 1000);
  const eye = new THREE.Vector3(...CAMERA.pos);
  const depth = s.p.depth;
  const U = waterUniforms(depth, eye);

  const station = buildStation();
  scene.add(station.group);
  const water = buildWater(depth, U, { seed: s.look });
  scene.add(water.group);
  const seabed = buildSeabed(depth, U, s.look, s.sched.D);
  scene.add(seabed.group);
  const life = buildLife(depth, U, s.sched, s.look);
  scene.add(life.group);

  // Condensation on the inside of the glass: tiny beads, barely running.
  const glass = buildRainGlass({
    panes: [{ center: [PORT.x, PORT.y, WALL - PORT.depth * 0.75], width: PORT.r * 2, height: PORT.r * 2, lightDir: [-1, 0.6], reflectSide: 1 }],
    runSpeed: 0.12,
    dropScale: 0.3,
    lightColor: [1.0, 0.75, 0.45],
    reflect: [0.02, 0.016, 0.012],
  });
  scene.add(glass.group);

  // The station's lights: the wall lamp (warm, with a static shadow), a dim fill, a cool glow from
  // the water through the porthole.
  // Very dim inside: a small warm lamp turned right down, and the instruments' green glow.
  const lamp = new THREE.PointLight(0xffb070, 0.12, 0, 2);
  lamp.position.copy(station.lampAt);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.autoUpdate = false;
  lamp.shadow.needsUpdate = true;
  lamp.shadow.bias = -0.002;
  lamp.shadow.radius = 4;
  scene.add(lamp);
  const glows = station.glowAt.map((p) => {
    const g = new THREE.PointLight(0x50ff98, 0.22, 0, 2);
    g.position.copy(p);
    scene.add(g);
    return g;
  });
  const z = ZONES[depth];
  const seaGlow = new THREE.PointLight(new THREE.Color(...z.top.map((c) => Math.min(1, c * 6))), depth === 'reef' ? 0.3 : depth === 'twilight' ? 0.2 : 0.05, 0, 2);
  seaGlow.position.set(PORT.x, PORT.y, WALL - 1.6);
  scene.add(seaGlow);
  scene.add(new THREE.HemisphereLight(0x1c2630, 0x0c0a08, 0.04));

  return { scene, camera, U, station, water, seabed, life, glass, lamp, glows };
});

export function drawSea(rc: RenderCtx, s: DeepSeaState) {
  const v = view(s, rc.theme);
  const L = s.loopS;
  const t = rc.t;
  const tc = timeCircle(t, L, 0.05);
  v.U.uTC.value.set(tc[0], tc[1]);
  v.U.uPhase.value = t / L;
  v.U.uLoop.value = L;

  // The station drifts sideways at v: the world slides left by s (exactly D per loop).
  const drifted = s.sched.v * t;
  v.seabed.update(drifted);
  v.life.update(t, L, drifted);
  // Bubbles: the stream running now, if any.
  const b = s.sched.bubbles.find((p) => passAt(p, t));
  // The floodlight and the snow are read every frame (the preview changes them live).
  v.U.uFloodOn.value = s.p.floodlight ? ZONES[s.p.depth].flood : 0;
  v.water.update({ t, L, s: drifted, v: s.sched.v, bubbleT: b ? t - b.t0 : -1, bubbleEmitS: b ? b.t1 - b.t0 - 8 : 1, bubbleFrom: b ? b.from : [0, 0, 0], snow: s.p.snow, flood: s.p.floodlight });
  v.glass.update({ t, L, rain: 0.35, flash: 0, light: 0.6, snow: false });

  // Needles wander a little, lamps blink slowly, the sonar sweeps (all whole cycles per loop).
  const deep = { twilight: 0.1, abyss: 1.1, reef: -1.0 }[s.p.depth];
  v.station.needles.forEach((n, i) => {
    n.pivot.rotation.z = -(n.base + (i === 0 ? deep : 0)) + n.amp * loopSin(t, L, n.hz, i * 1.3) + n.amp * 0.3 * loopSin(t, L, n.hz * 5.3, i);
  });
  for (const bl of v.station.blinkers) bl.mat.emissiveIntensity = bl.hz ? bl.on * (0.25 + 0.75 * Math.max(0, loopSin(t, L, bl.hz))) : bl.on;
  v.station.scope.uSweep.value = (2 * Math.PI * Math.round(L / 6) * (t / L)) % (2 * Math.PI);
  v.lamp.intensity = 0.12 * (0.97 + 0.03 * loopSin(t, L, 1 / 13));

  // The station is anchored; the camera breathes only very slightly.
  const [px, py, pz] = CAMERA.pos;
  v.camera.position.set(px + drift(t, L, 0.004, 1), py + drift(t, L, 0.003, 2), pz);
  v.camera.lookAt(CAMERA.target[0] + drift(t, L, 0.006, 3), CAMERA.target[1] + drift(t, L, 0.004, 4), CAMERA.target[2]);
  v.camera.aspect = rc.width / rc.height;
  v.camera.updateProjectionMatrix();
  v.camera.updateMatrixWorld();

  draw3DComposed(rc.ctx, v.scene, v.camera, { exposure: 1.1, bloom: { strength: 0.45, radius: 0.5, threshold: 0.75 } });
  vignette(rc);
  drawGrain(rc.ctx, rc.frame, rc.width, rc.height, 0.05);
}
