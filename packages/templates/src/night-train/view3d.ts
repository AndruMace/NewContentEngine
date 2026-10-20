/**
 * Night Train scene: the compartment, the night outside, rain on the glass and the lamp's reflection
 * in it, built once; each frame sets what moves from t alone: how far the train has come (track.ts),
 * which features are passing, the lights they throw into the compartment, and the little bumps of
 * the wheels over the joints.
 */
import type { RenderCtx } from '@sim/engine';
import { THREE, draw3DComposed, sceneCache } from '../three-layer';
import { drawGrain } from '../ambient/grain';
import { buildRainGlass } from '../ambient/glass';
import { loadModel, loadTextureSet } from '../ambient/assets';
import { drift, loopSin, timeCircle } from '../ambient/loop';
import { buildCompartment } from './compartment';
import { KIND, MAX_FEATURES, buildLandscape } from './landscape';
import { distanceAt, ringPos, speedAt } from './track';
import { CAMERA, CEILING, GROUND_Y, WALL, WINDOW } from './layout';
import type { NightTrainState } from './index';

export const preloadTrain = () =>
  Promise.all([
    loadTextureSet('velour_velvet', '1k'),
    loadTextureSet('black_walnut_veneer_01', '2k'),
    loadTextureSet('dirty_carpet', '1k'),
    loadTextureSet('metal_plate_02', '1k'),
    loadModel('throw_pillows_01'),
    loadModel('vintage_suitcase'),
  ]).then(() => undefined);

const WEATHER = { rain: 0, clear: 1, snow: 2 } as const;

function vignette(rc: RenderCtx) {
  const { ctx, width: W, height: H } = rc;
  const g = ctx.createRadialGradient(W / 2, H * 0.48, H * 0.38, W / 2, H * 0.48, H * 1.0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

const view = sceneCache((s: NightTrainState) => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.03, 8000);

  const room = buildCompartment();
  scene.add(room.group);
  const land = buildLandscape();
  scene.add(land.group);

  // Rain on the glass, pushed back along the window by the train's speed (it runs left and down).
  const cx = (WINDOW.x0 + WINDOW.x1) / 2;
  const cy = (WINDOW.y0 + WINDOW.y1) / 2;
  const glass = buildRainGlass({
    panes: [{ center: [cx, cy, WALL - 0.03], width: WINDOW.x1 - WINDOW.x0, height: WINDOW.y1 - WINDOW.y0, lightDir: [-1, -0.6], reflectSide: 1 }],
    flow: [-0.86, -0.51],
    runSpeed: 3.5,
    dropScale: 0.45,
    lightColor: [1.0, 0.62, 0.32],
  });
  scene.add(glass.group);
  land.reflection.position.set(cx, cy, WALL - 0.025);
  land.reflection.scale.set(WINDOW.x1 - WINDOW.x0, WINDOW.y1 - WINDOW.y0, 1);
  scene.add(land.reflection);

  // The lamp: the room's main light, warm, with a static shadow (nothing in the room moves).
  const lamp = new THREE.PointLight(0xffa860, 1.0, 0, 2);
  lamp.position.copy(room.lampAt);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.autoUpdate = false;
  lamp.shadow.needsUpdate = true;
  lamp.shadow.bias = -0.002;
  lamp.shadow.radius = 4;
  scene.add(lamp);
  // Warm light off the walls and ceiling (no shadow), and a dim reading light over the berth.
  const fill = new THREE.PointLight(0xc89070, 0.6, 0, 2);
  fill.position.set(0.3, CEILING - 0.25, 0.9);
  scene.add(fill);
  // The wall sconces either side of the window: a soft glow each, no shadows.
  const sconceLights = room.sconces.map((p) => {
    const l = new THREE.PointLight(0xffb070, 0.28, 0, 2);
    l.position.copy(p);
    scene.add(l);
    return l;
  });
  scene.add(new THREE.HemisphereLight(0x23283a, 0x1a120c, 0.18));
  // Moonlight through the window: cool, faint, throwing the frame's shadow on the table and berth.
  const moon = new THREE.DirectionalLight(0xa8b8e0, 0.35);
  moon.position.set(-3, 4, WALL - 6);
  moon.target.position.set(0, 0.5, 0.5);
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024, 1024);
  moon.shadow.autoUpdate = false;
  moon.shadow.needsUpdate = true;
  const sc = moon.shadow.camera;
  sc.left = -3;
  sc.right = 3;
  sc.top = 3;
  sc.bottom = -3;
  sc.near = 0.5;
  sc.far = 20;
  scene.add(moon, moon.target);
  // Lights passing outside (station lamps, tunnel lamps, the crossing's red), sweeping through the room.
  const passing = new THREE.PointLight(0xffe0b0, 0, 0, 2);
  scene.add(passing);
  const red = new THREE.PointLight(0xff2010, 0, 0, 2);
  scene.add(red);

  return { scene, camera, room, land, glass, lamp, fill, sconceLights, moon, passing, red };
});

/**
 * The camera's jolt from the wheels: a short damped shake after each click (sorted click times). The
 * clicks just before the loop's end shake the start too (as they will when it repeats).
 */
function jolt(clicks: number[], t: number, L: number) {
  return bump(clicks, t) + bump(clicks, t + L);
}

function bump(clicks: number[], t: number) {
  if (!clicks.length) return 0;
  // Last click at or before t.
  let lo = 0;
  let hi = clicks.length - 1;
  if (clicks[0] > t) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (clicks[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  let y = 0;
  for (let i = lo; i >= 0 && t - clicks[i] < 0.35; i--) {
    const a = t - clicks[i];
    y += Math.exp(-a / 0.05) * Math.sin(2 * Math.PI * 11 * a);
  }
  return y;
}

export function drawTrain(rc: RenderCtx, s: NightTrainState) {
  const v = view(s, rc.theme);
  const L = s.loopS;
  const t = rc.t;
  const { motion, features, clicks } = s.tt;
  const dist = distanceAt(motion, t);
  const sNow = ringPos(dist, motion.D);
  const speed = speedAt(motion, t);
  const weather = WEATHER[s.p.weather];

  // The features near the window, as positions relative to it (m along the track).
  const near: { kind: number; rel0: number; rel1: number; seed: number }[] = [];
  let tunnel = 0;
  let crossing = 0;
  let stationLamp: number | null = null;
  let tunnelLamp: number | null = null;
  for (const f of features) {
    let rel0 = f.s0 - dist;
    if (rel0 > motion.D / 2) rel0 -= motion.D;
    if (rel0 < -motion.D / 2) rel0 += motion.D;
    const rel1 = rel0 + (f.s1 - f.s0);
    if (rel1 < -400 || rel0 > 400) continue;
    near.push({ kind: KIND[f.kind], rel0, rel1, seed: (f.seed % 997) / 997 });
    const inside = Math.min(1, Math.max(0, Math.min(-rel0, rel1) / 4 + 0.5));
    if (f.kind === 'tunnel') {
      tunnel = Math.max(tunnel, inside);
      if (inside > 0) {
        // The nearest of the lamps every 25 m along the tunnel.
        const k = Math.round((sNow - 12.5) / 25);
        tunnelLamp = k * 25 + 12.5 - sNow;
      }
    }
    if (f.kind === 'crossing') crossing = Math.max(crossing, Math.exp(-Math.pow((rel0 + rel1) / 2 / 25, 2)));
    if (f.kind === 'station' && rel1 > -10 && rel0 < 10) {
      // Station lamps every 20 m: the one nearest the window.
      const k = Math.floor(-rel0 / 20);
      const xs = [k - 1, k, k + 1].map((j) => rel0 + (j + 0.5) * 20).filter((x) => x > rel0 && x < rel1);
      for (const x of xs) if (stationLamp === null || Math.abs(x) < Math.abs(stationLamp)) stationLamp = x;
    }
  }
  near.sort((a, b) => Math.abs(a.rel0 + a.rel1) - Math.abs(b.rel0 + b.rel1));
  near.length = Math.min(near.length, MAX_FEATURES);

  const lampOn = 0.45 + 0.55 * s.p.lamp;
  // The lamp dips very slightly on the bigger jolts (a loose contact in an old carriage).
  const j = jolt(clicks, t, L);
  const lampLevel = lampOn * (0.985 + 0.015 * Math.max(-1, Math.min(1, j)));
  v.lamp.intensity = 1.0 * lampLevel;
  v.fill.intensity = 0.6 * lampLevel;
  v.room.shade.emissiveIntensity = 0.32 * lampLevel;
  v.room.sconceGlass.emissiveIntensity = 0.2 * lampLevel;
  for (const l of v.sconceLights) l.intensity = 0.28 * lampLevel;
  const moonLight = (weather === 1 ? 0.35 : weather === 2 ? 0.25 : 0.06) * (1 - tunnel);
  v.moon.intensity = moonLight;

  // A lamp sweeping past: brightest level with the window, fading as it goes.
  if (stationLamp !== null) {
    v.passing.color.setHex(0xffe0b0);
    v.passing.position.set(stationLamp, GROUND_Y + 3.1, WALL - 3.2);
    v.passing.intensity = 3.5 * Math.exp(-Math.pow(stationLamp / 3, 2));
  } else if (tunnelLamp !== null) {
    v.passing.color.setHex(0xff9a40);
    v.passing.position.set(tunnelLamp, GROUND_Y + 2.6, WALL - 3.2);
    v.passing.intensity = 2.0 * tunnel * Math.exp(-Math.pow(tunnelLamp / 3.5, 2));
  } else v.passing.intensity = 0;
  // The crossing's alternating red lamps glow faintly on the frame and table (whole cycles per loop).
  const blink = 0.5 + 0.5 * Math.cos(2 * Math.PI * Math.round(L) * (t / L));
  v.red.position.set(-0.5, GROUND_Y + 2.1, WALL - 3);
  v.red.intensity = 0.6 * crossing * (0.4 + 0.6 * blink);

  const tc = timeCircle(t, L, 0.004);
  v.land.update({
    s: sNow,
    D: motion.D,
    v: speed,
    t,
    L,
    weather,
    precip: s.p.precip,
    town: s.p.townLights,
    win: lampLevel,
    features: near,
    tc,
    // Darker outside (tunnels, rain) and the glass shows more of the room.
    reflect: (0.35 + 0.5 * tunnel + (weather === 0 ? 0.15 : 0)) * lampLevel,
    tunnel,
  });
  v.glass.update({ t, L, rain: weather === 0 ? s.p.precip : 0, flash: 0, light: lampLevel, snow: weather === 2 });

  // Where the lamp's reflection sits on the glass: the lamp mirrored in the window, seen from the eye.
  const eye = new THREE.Vector3(CAMERA.pos[0], CAMERA.pos[1], CAMERA.pos[2]);
  const lamp = v.room.lampAt;
  const mirrored = new THREE.Vector3(lamp.x, lamp.y, 2 * WALL - lamp.z);
  const k = (eye.z - WALL) / (eye.z - mirrored.z);
  const r = v.land.reflection.material as THREE.ShaderMaterial;
  (r.uniforms.uLampAt.value as THREE.Vector2).set(eye.x + (mirrored.x - eye.x) * k, eye.y + (mirrored.y - eye.y) * k);

  // The carriage sways a little (slow, whole cycles per loop) and jolts on the joints.
  const sway = drift(t, L, 0.006, 1);
  const [px, py, pz] = CAMERA.pos;
  v.camera.position.set(px + sway, py + drift(t, L, 0.003, 2) + 0.0009 * j, pz);
  const [tx, ty, tz] = CAMERA.target;
  v.camera.lookAt(tx + sway * 0.5, ty + 0.0006 * j, tz);
  v.camera.aspect = rc.width / rc.height;
  v.camera.updateProjectionMatrix();
  v.camera.updateMatrixWorld();
  for (const [i, c] of v.room.curtains.entries()) c.rotation.x = 0.02 * loopSin(t, L, 1 / 7.3, i * 1.7) + 0.004 * j;

  draw3DComposed(rc.ctx, v.scene, v.camera, { exposure: 1.05, bloom: { strength: 0.35, radius: 0.45, threshold: 0.85 } });
  vignette(rc);
  drawGrain(rc.ctx, rc.frame, rc.width, rc.height, 0.05);
}
