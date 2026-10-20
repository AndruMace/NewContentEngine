/**
 * Cabin Storm scene: builds the room, fire and storm once, then each frame sets what moves from t and
 * the cue schedule alone (see index.ts). Everything that moves repeats exactly over the loop.
 *
 * The room and its lights never move, so their shadows are rendered once (shadow autoUpdate off);
 * only the lightning light's shadow is redone, when a strike comes from a new direction.
 */
import type { RenderCtx } from '@sim/engine';
import { THREE, draw3DComposed, sceneCache } from '../three-layer';
import { drawGrain } from '../ambient/grain';
import { loadModel, loadTextureSet } from '../ambient/assets';
import { drift, loopSin, wrap } from '../ambient/loop';
import { buildRoom } from './room';
import { buildFire } from './fire';
import { buildOutside } from './outside';
import { buildRainGlass } from '../ambient/glass';
import { BACK, CAMERA, FIRE, WINDOWS } from './layout';
import type { CabinState } from './index';

export const preloadCabin = () =>
  Promise.all([
    loadTextureSet('rough_wood', '2k'),
    loadTextureSet('wood_floor_worn', '2k'),
    loadTextureSet('rustic_stone_wall_02', '2k'),
    loadTextureSet('bark_brown_02', '1k'),
    loadTextureSet('caban', '1k'),
    ...['Rockingchair_01', 'ArmChair_01', 'WoodenTable_01', 'Lantern_01'].map(loadModel),
  ]).then(() => undefined);

/** Brightest a flash may get (fraction of full), so lightning never glares in a dark room. */
const FLASH_CAP = 0.7;

export function flashAt(s: CabinState, t: number): { amount: number; strike: number } {
  let amount = 0;
  let strike = -1;
  s.strikes.forEach((st, i) => {
    const age = wrap(t - st.t, s.loopS);
    if (age > 1.2) return;
    for (const p of st.pulses) {
      const d = age - p;
      if (d < 0) continue;
      const a = st.strength * Math.exp(-d * 7) * (d < 0.03 ? d / 0.03 : 1);
      if (a > amount) {
        amount = a;
        strike = i;
      }
    }
  });
  return { amount: Math.min(FLASH_CAP, amount), strike };
}

/** Darkened corners: draws the eye to the fire and hides the frame's edges. */
function vignette(rc: RenderCtx) {
  const { ctx, width: W, height: H } = rc;
  const g = ctx.createRadialGradient(W / 2, H * 0.55, H * 0.35, W / 2, H * 0.55, H * 0.95);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function staticShadow(light: THREE.PointLight | THREE.DirectionalLight, size: number) {
  light.castShadow = true;
  light.shadow.mapSize.set(size, size);
  light.shadow.autoUpdate = false;
  light.shadow.needsUpdate = true;
}

const view = sceneCache((s: CabinState) => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020306);
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.05, 200);

  const room = buildRoom();
  scene.add(room.group);
  const fire = buildFire(new THREE.Vector3(...CAMERA.pos), room.candles);
  scene.add(fire.group);
  const outside = buildOutside();
  scene.add(outside.group);
  // The fire is between the windows: each pane's drops are lit from the fire's side, a little from
  // below. Just outside the mullions, so drops sit on the glass behind the frame.
  const glass = buildRainGlass({
    panes: WINDOWS.map((w) => {
      const side = (w.x0 + w.x1) / 2 < 0 ? -1 : 1;
      return { center: [(w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2, BACK - 0.06], width: w.x1 - w.x0, height: w.y1 - w.y0, lightDir: [-side, -0.35], reflectSide: side };
    }),
  });
  scene.add(glass.group);

  // Lightning: a cold light from behind the back wall, coming in through the windows (the logs
  // shadow it, so it falls on the floor in window shapes). Its shadow is redone only when a strike
  // comes from the other side.
  const flashLight = new THREE.DirectionalLight(0xb8c8ff, 0);
  staticShadow(flashLight, 2048);
  const sc = flashLight.shadow.camera;
  sc.left = -10;
  sc.right = 10;
  sc.top = 10;
  sc.bottom = -10;
  sc.near = 1;
  sc.far = 50;
  flashLight.shadow.bias = -0.0005;
  scene.add(flashLight);
  scene.add(flashLight.target);

  const fireLight = new THREE.PointLight(0xff8a3c, 11, 0, 2);
  fireLight.position.set(FIRE.x, FIRE.y + 0.55, FIRE.z + 0.3);
  staticShadow(fireLight, 1024);
  fireLight.shadow.bias = -0.002;
  fireLight.shadow.radius = 4;
  scene.add(fireLight);
  // Warm bounce off the hearth and floor (no shadow), so the room isn't lit by a single point.
  const bounce = new THREE.PointLight(0xff9a5a, 9, 0, 2);
  bounce.position.set(0, 1.1, BACK + 2.6);
  scene.add(bounce);
  // Soft warm fill from the room behind the camera (light off the floor and far walls).
  const fill = new THREE.PointLight(0xc48a60, 6, 0, 2);
  fill.position.set(0, 2.4, 3.2);
  scene.add(fill);
  const lantern = new THREE.PointLight(0xffb070, 0.8, 0, 2);
  lantern.position.copy(room.lantern);
  scene.add(lantern);
  scene.add(new THREE.HemisphereLight(0x2a3450, 0x1c120c, 0.25));

  return { scene, camera, fireLight, bounce, lantern, fire, outside, glass, flashLight, flashSide: 0 };
});

export function drawCabin(rc: RenderCtx, s: CabinState) {
  const v = view(s, rc.theme);
  const L = s.loopS;
  const t = rc.t;
  const flick = 0.82 + 0.1 * loopSin(t, L, 1.3) + 0.06 * loopSin(t, L, 3.7, 1) + 0.04 * loopSin(t, L, 8.3, 2);
  v.fireLight.intensity = 11 * (0.5 + 0.5 * s.p.fire) * flick;
  v.bounce.intensity = 9 * (0.5 + 0.5 * s.p.fire) * (0.85 + 0.15 * flick);
  v.lantern.intensity = 0.8 * (0.95 + 0.05 * loopSin(t, L, 5.1, 0.5));
  v.fire.update(t, L, s.p.fire, (flick - 0.82) / 0.2);

  const flash = flashAt(s, t);
  const snow = s.p.precipitation === 'snow';
  const strike = flash.strike >= 0 ? s.strikes[flash.strike] : null;
  if (strike) {
    // From behind whichever window the bolt is seen through.
    const side = strike.x < 0.5 ? -1 : 1;
    if (side !== v.flashSide) {
      v.flashLight.position.set(side * 9, 10, BACK - 14);
      v.flashLight.target.position.set(side * 1.5, 0, 1.5);
      v.flashLight.target.updateMatrixWorld();
      v.flashLight.shadow.needsUpdate = true;
      v.flashSide = side;
    }
  }
  v.flashLight.intensity = flash.amount * 2.6;
  v.outside.update({ t, L, flash: flash.amount, strike: flash.strike, strikeX: strike?.x ?? 0.5, boltVisible: !!strike && strike.strength > 0.55, storm: s.p.storm, snow });
  v.glass.update({ t, L, rain: s.p.storm, flash: flash.amount, light: (0.5 + 0.5 * s.p.fire) * flick, snow });

  const [px, py, pz] = CAMERA.pos;
  v.camera.position.set(px + drift(t, L, 0.02, 1), py + drift(t, L, 0.01, 2), pz);
  v.camera.lookAt(CAMERA.target[0] + drift(t, L, 0.03, 3), CAMERA.target[1], CAMERA.target[2]);
  v.camera.aspect = rc.width / rc.height;
  v.camera.updateProjectionMatrix();
  draw3DComposed(rc.ctx, v.scene, v.camera, { exposure: 1.0, bloom: { strength: 0.45, radius: 0.55, threshold: 0.9 } });
  vignette(rc);
  drawGrain(rc.ctx, rc.frame, rc.width, rc.height);
}
