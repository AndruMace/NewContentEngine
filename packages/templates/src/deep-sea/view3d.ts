/**
 * Deep Sea Submarine scene: the cockpit and its dome, and the water outside (seabed, life, snow,
 * light), built once per setting; each frame moves the submarine on (the world flows towards us),
 * the animals, the bubbles and the instruments, from t alone.
 */
import type { RenderCtx } from '@sim/engine';
import { THREE, draw3DComposed, sceneCache } from '../three-layer';
import { drawGrain } from '../ambient/grain';
import { loadModel, loadTextureSet } from '../ambient/assets';
import { drift, loopSin, timeCircle } from '../ambient/loop';
import { buildCockpit } from './cockpit';
import { ZONES, buildWater, waterUniforms } from './water';
import { buildSeabed } from './seabed';
import { buildLife } from './life';
import { passAt } from './schedule';
import { CAMERA, DOME } from './layout';
import type { DeepSeaParams, DeepSeaState } from './index';

export const preloadSea = (p: DeepSeaParams) =>
  Promise.all([
    loadTextureSet('rusty_painted_metal', '1k'),
    loadTextureSet(p.depth === 'reef' ? 'coral_gravel' : 'coast_sand_01', '2k'),
    loadTextureSet('dark_rock', '1k'),
    loadModel('modular_industrial_pipes_01'),
    ...(p.depth === 'reef' ? [loadModel('lambis_shell')] : []),
  ]).then(() => undefined);

function vignette(rc: RenderCtx) {
  const { ctx, width: W, height: H } = rc;
  const g = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.4, W / 2, H * 0.45, H * 1.0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.5)');
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

  const cockpit = buildCockpit(U);
  scene.add(cockpit.group);
  const water = buildWater(depth, U, { seed: s.look });
  scene.add(water.group);
  const seabed = buildSeabed(depth, U, s.look, s.sched.D);
  scene.add(seabed.group);
  const life = buildLife(depth, U, s.sched, s.look);
  scene.add(life.group);

  // Inside it is dark: the instruments' green glow, a red night light overhead, and the sea's own
  // light coming in through the dome.
  const glows = cockpit.glowAt.map((p, i) => {
    const g = new THREE.PointLight(0x50ff98, i < 3 ? 0.16 : 0.05, 0, 2);
    g.position.copy(p);
    scene.add(g);
    return g;
  });
  const night = new THREE.PointLight(0xff2010, 0.08, 0, 2);
  night.position.copy(cockpit.nightLight);
  scene.add(night);
  const z = ZONES[depth];
  const seaGlow = new THREE.PointLight(new THREE.Color(...z.top.map((c) => Math.min(1, c * 6))), depth === 'reef' ? 0.5 : depth === 'twilight' ? 0.18 : 0.04, 0, 2);
  seaGlow.position.set(DOME.c[0], DOME.c[1] + 0.4, DOME.c[2] - 1.2);
  scene.add(seaGlow);
  scene.add(new THREE.HemisphereLight(0x1c2630, 0x0c0a08, 0.03));

  return { scene, camera, U, cockpit, water, seabed, life, glows };
});

export function drawSea(rc: RenderCtx, s: DeepSeaState) {
  const v = view(s, rc.theme);
  const L = s.loopS;
  const t = rc.t;
  const tc = timeCircle(t, L, 0.05);
  v.U.uTC.value.set(tc[0], tc[1]);
  v.U.uPhase.value = t / L;
  v.U.uLoop.value = L;

  // The submarine cruises forward at v: the world flows towards us by s (exactly D per loop).
  const travelled = s.sched.v * t;
  v.seabed.update(travelled);
  v.life.update(t, L, travelled);
  const b = s.sched.bubbles.find((p) => passAt(p, t));
  v.U.uFloodOn.value = s.p.floodlight ? ZONES[s.p.depth].flood : 0;
  v.water.update({ t, L, s: travelled, v: s.sched.v, bubbleT: b ? t - b.t0 : -1, bubbleEmitS: b ? b.t1 - b.t0 - 8 : 1, bubbleFrom: b ? b.from : [0, 0, 0], snow: s.p.snow, flood: s.p.floodlight });

  // Instruments: needles wander, lamps blink slowly, the sonar sweeps (whole cycles per loop).
  const ins = v.cockpit.instruments;
  ins.needles.forEach((n, i) => {
    n.pivot.rotation.z = -n.base + n.amp * loopSin(t, L, n.hz, i * 1.3) + n.amp * 0.3 * loopSin(t, L, n.hz * 5.3, i);
  });
  for (const bl of ins.blinkers) bl.mat.emissiveIntensity = bl.hz ? bl.on * (0.25 + 0.75 * Math.max(0, loopSin(t, L, bl.hz))) : bl.on;
  for (const sc of ins.scopes) sc.uSweep.value = (2 * Math.PI * Math.round(L / 6) * (t / L)) % (2 * Math.PI);
  for (const [i, g] of v.glows.entries()) g.intensity = (i < 3 ? 0.16 : 0.05) * (0.95 + 0.05 * loopSin(t, L, 1 / 11, i));

  // Underway: the submarine pitches and rolls very gently.
  const [px, py, pz] = CAMERA.pos;
  const roll = drift(t, L, 0.012, 5);
  v.camera.position.set(px + drift(t, L, 0.008, 1), py + drift(t, L, 0.01, 2), pz);
  v.camera.up.set(Math.sin(roll), Math.cos(roll), 0);
  v.camera.lookAt(CAMERA.target[0] + drift(t, L, 0.03, 3), CAMERA.target[1] + drift(t, L, 0.04, 4), CAMERA.target[2]);
  v.camera.aspect = rc.width / rc.height;
  v.camera.updateProjectionMatrix();
  v.camera.updateMatrixWorld();

  draw3DComposed(rc.ctx, v.scene, v.camera, { exposure: 1.1, bloom: { strength: 0.45, radius: 0.5, threshold: 0.75 } });
  vignette(rc);
  drawGrain(rc.ctx, rc.frame, rc.width, rc.height, 0.05);
}
