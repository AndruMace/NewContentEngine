/**
 * Lighthouse coast (rendering): a bay at night seen from the water, its two arms of land running off
 * into the distance with a headland for each lighthouse, and one ship riding at anchor in the middle.
 * Every lighthouse is striped in its own colour and sweeps the ship with its own group of 1–3 beams
 * (its flash code); the ship lights up in that colour each time a beam crosses it.
 */
import { lighten, mixRgb, paletteAt, type Ctx2D, type RGB, type Theme } from '@sim/engine';
import { THREE, draw3D, sceneCache } from '../three-layer';
import { COAST_CAM, COAST_SHIP, VIEW_SLOPE, coastSpot, groupGapU } from './lighthouse';
import { angleDiff, buildBeam, buildShip, buildTower, glowSprite, glowTexture, hash01, linear, nightScene, planAngle, rock, rockMaterial, seaMaterial, vec3 } from './lighthouse3d';

export interface CoastView {
  /** Each lighthouse's turns per loop and flashes per group. */
  cycles: number[];
  codes: number[];
  p: { loopSeconds: number };
  colorShift: number;
  flash: number[];
}

const LOOK = new THREE.Vector3(0, 0.45, -8);
/** How high on the ship the beams are aimed. */
const AIM_Y = 0.35;
/** How narrowly a beam lights the ship (radians). */
const LIT_WIDTH = 0.045;

/** Distance from the camera, in plan (sets how big things far away are drawn). */
const depth = (z: number) => COAST_CAM.z - z;

/** A smooth maximum (for blending land shapes together). */
const smax = (a: number, b: number, k = 3) => Math.log(Math.exp(k * a) + Math.exp(k * b)) / k;

/** Value noise, for the hills. */
function noise(x: number, z: number) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const h = (a: number, b: number) => hash01(a * 57.1 + b * 113.7);
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const top = h(xi, zi) + (h(xi + 1, zi) - h(xi, zi)) * sx;
  const bot = h(xi, zi + 1) + (h(xi + 1, zi + 1) - h(xi, zi + 1)) * sx;
  return top + (bot - top) * sz;
}

/**
 * The land: how far inland a point is (negative out at sea). Each arm's shore keeps a steady share of
 * the view across, ends a little past its furthest lighthouse, and pushes a headland out to each of its
 * lighthouses.
 */
function landShape(n: number) {
  const spots = Array.from({ length: n }, (_, i) => coastSpot(i, n));
  const ends = [-1, 1].map((side) => Math.min(...spots.filter((s) => s.side === side).map((s) => s.z), -4) - 2.5 - 2 * hash01(side + 5));
  const shore = (z: number) => 0.98 * VIEW_SLOPE * depth(z);
  const capsules = spots.map((s) => {
    const ax = s.side * (shore(s.z - 0.6) + 0.6);
    const az = s.z - 0.6;
    const bx = s.x - s.side * (0.12 + 0.012 * depth(s.z));
    return { ax, az, bx, bz: s.z, r: 0.3 + 0.03 * depth(s.z) };
  });
  return (x: number, z: number) => {
    const side = x < 0 ? -1 : 1;
    let d = side * x - shore(z) - Math.max(0, ends[side < 0 ? 0 : 1] - z) * 1.3;
    for (const c of capsules) {
      const vx = c.bx - c.ax;
      const vz = c.bz - c.az;
      const t = Math.max(0, Math.min(1, ((x - c.ax) * vx + (z - c.az) * vz) / (vx * vx + vz * vz)));
      const dc = c.r - Math.hypot(x - c.ax - t * vx, z - c.az - t * vz);
      d = smax(d, dc);
    }
    return d;
  };
}

/** Ground height from how far inland it is: a low cliff at the shore, rolling hills behind. */
function heightAt(d: number, x: number, z: number) {
  if (d < 0) return -0.5 * Math.min(1, -d / 0.5);
  const hills = noise(x * 0.35, z * 0.35) * 0.9 + noise(x * 1.3, z * 1.3) * 0.18;
  return 0.32 * Math.min(1, d / 0.25) ** 0.6 + Math.min(1, d / 3) * hills * (0.4 + 0.02 * depth(z));
}

function terrain(n: number) {
  const land = landShape(n);
  const X0 = -14;
  const X1 = 14;
  const Z0 = -30;
  const Z1 = 6.5;
  const nx = 220;
  const nz = 280;
  const geo = new THREE.PlaneGeometry(X1 - X0, Z1 - Z0, nx, nz);
  geo.rotateX(-Math.PI / 2);
  geo.translate((X0 + X1) / 2, 0, (Z0 + Z1) / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const rockC = new THREE.Color().setRGB(0.075, 0.075, 0.085, THREE.SRGBColorSpace);
  const grass = new THREE.Color().setRGB(0.07, 0.1, 0.07, THREE.SRGBColorSpace);
  const c = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k);
    const z = pos.getZ(k);
    const d = land(x, z);
    pos.setY(k, heightAt(d, x, z));
    c.copy(rockC).lerp(grass, Math.min(1, Math.max(0, (d - 0.25) / 0.6)) * (0.6 + 0.4 * noise(x * 2, z * 2)));
    colors.set([c.r, c.g, c.b], k * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
  return { mesh, groundAt: (x: number, z: number) => heightAt(land(x, z), x, z) };
}

const coastView = sceneCache((s: CoastView, theme: Theme) => {
  const n = s.cycles.length;
  const { scene, night, moonCol, bg0, bg1 } = nightScene(theme, 16, 48);
  const camera = new THREE.PerspectiveCamera(46, 1080 / 1920, 0.1, 120);
  const sea = seaMaterial(night, moonCol, mixRgb(bg0, bg1, 0.35));
  scene.add(sea.water);
  const land = terrain(n);
  scene.add(land.mesh);
  const su = sea.mat.uniforms;
  const flareTex = glowTexture(true);
  const glowTex = glowTexture(false);
  const rockMat = rockMaterial();

  // The ship at anchor, broadside on.
  const shipCol: RGB = [58, 62, 74];
  const ship = buildShip('freighter', 1.9, 0.36, shipCol, 3);
  const shipHolder = new THREE.Group();
  shipHolder.rotation.order = 'YXZ';
  shipHolder.position.set(COAST_SHIP.x, 0, COAST_SHIP.z);
  shipHolder.rotation.y = 0.25;
  shipHolder.add(ship.group);
  scene.add(shipHolder);
  const shipGlow = glowSprite(glowTex, [255, 240, 210], 0);
  shipGlow.position.set(COAST_SHIP.x, 0.35, COAST_SHIP.z);
  scene.add(shipGlow);
  const shipLight = new THREE.PointLight(0xffffff, 0, 3, 1.5);
  shipLight.position.set(COAST_SHIP.x, 0.9, COAST_SHIP.z + 0.4);
  scene.add(shipLight);

  let beamIx = 0;
  const lights = s.cycles.map((turns, i) => {
    const col = paletteAt(theme.palette, ((i / Math.max(1, n - 1)) * 0.95 + s.colorShift) % 1);
    const { x, z } = coastSpot(i, n);
    const ground = land.groundAt(x, z);
    // Far towers are drawn a little larger than true scale, so every light reads.
    const k = 1 + 0.03 * (depth(z) - 7);
    const tower = buildTower(col, 1.15 * k, 0.2 * k, 6);
    tower.group.position.set(x, ground - 0.02, z);
    scene.add(tower.group);
    for (let r = 0; r < 3; r++) {
      const m = new THREE.Mesh(rock(i * 9 + r, (0.12 + 0.08 * hash01(i * 4 + r)) * k), rockMat);
      const a = (r / 3) * Math.PI * 2 + hash01(i + r);
      m.position.set(x + Math.cos(a) * 0.22 * k, ground, z - Math.sin(a) * 0.22 * k);
      scene.add(m);
    }
    const lampY = ground + tower.lampY;
    const lamp = new THREE.PointLight(linear(mixRgb([255, 225, 170], col, 0.3)), 1.2, 2.4, 1.5);
    lamp.position.set(x, lampY, z);
    scene.add(lamp);
    const beamColor = mixRgb([255, 240, 205], col, 0.45);
    const toShip = planAngle(x, z, COAST_SHIP.x, COAST_SHIP.z);
    const dist = Math.hypot(COAST_SHIP.x - x, COAST_SHIP.z - z);
    const tilt = Math.atan2(lampY - AIM_Y, dist);
    const reach = lampY / Math.tan(tilt);
    // One beam per flash of the code, the rest trailing the first round the turn.
    const step = 2 * Math.PI * turns * groupGapU(turns, s.codes[i], s.p.loopSeconds);
    const beams = Array.from({ length: s.codes[i] }, (_, j) => {
      const len = dist * 1.45;
      const radius = 0.12 + 0.05 * dist;
      const b = buildBeam(beamColor, len, radius);
      b.mesh.position.set(x, lampY, z);
      b.mesh.rotation.z = -tilt;
      scene.add(b.mesh);
      const ix = beamIx++;
      (su.uBeamFrom.value as THREE.Vector3[])[ix].set(x, lampY, z);
      // Several lights share the bay, so each lights the water more softly than the single one.
      (su.uBeamCol.value as THREE.Vector3[])[ix].copy(vec3(beamColor)).multiplyScalar(0.35);
      (su.uBeamReach.value as number[])[ix] = reach;
      (su.uBeamShape.value as THREE.Vector2[])[ix].set(radius, len);
      return { ...b, ix, offset: j * step };
    });
    const flare = glowSprite(flareTex, beamColor);
    flare.position.set(x, lampY, z);
    scene.add(flare);
    const halo = glowSprite(glowTex, beamColor, 0.5);
    halo.position.set(x, lampY, z);
    halo.scale.setScalar(0.35 * k);
    scene.add(halo);
    (su.uLamp.value as THREE.Vector3[])[i].set(x, lampY, z);
    (su.uLampCol.value as THREE.Vector3[])[i].copy(vec3(beamColor));
    return { turns, col, beamColor, beams, flare, lantern: tower.lantern, toShip, toCam: planAngle(x, z, COAST_CAM.x, COAST_CAM.z), k };
  });
  su.uLamps.value = n;
  su.uBeams.value = beamIx;
  su.uWakes.value = 0;
  return { scene, camera, sea: sea.mat, lights, ship, shipHolder, shipGlow, shipLight };
});

export function drawCoast(ctx: Ctx2D, theme: Theme, s: CoastView, t: number) {
  const v = coastView(s, theme);
  const u = t / s.p.loopSeconds;
  const su = v.sea.uniforms;
  su.uPhase.value = u;
  let lit = 0;
  let litCol: RGB = [0, 0, 0];
  let flashSum = 0;
  let flashCol: RGB = [0, 0, 0];
  v.lights.forEach((L, i) => {
    // Clockwise; the leading beam crosses the ship at every whole turn, the others just after.
    const a0 = L.toShip - 2 * Math.PI * L.turns * u;
    let face = 0;
    for (const b of L.beams) {
      const a = a0 + b.offset;
      b.mesh.rotation.y = a;
      (su.uBeamDir.value as THREE.Vector2[])[b.ix].set(Math.cos(a), -Math.sin(a));
      const f = Math.max(0, Math.cos(a - L.toCam));
      (su.uBeamFace.value as number[])[b.ix] = f ** 70;
      b.mat.uniforms.uIntensity.value = 0.3 * (1 - 0.85 * f ** 6);
      face = Math.max(face, f ** 70);
      const on = Math.exp(-((angleDiff(a, L.toShip) / LIT_WIDTH) ** 2));
      lit += on;
      litCol = litCol.map((c, k) => c + on * L.beamColor[k]) as RGB;
    }
    (su.uLampFace.value as number[])[i] = face;
    const fl = s.flash[i];
    flashSum += fl;
    flashCol = flashCol.map((c, k) => c + fl * L.col[k]) as RGB;
    L.flare.scale.set((0.25 + 1.6 * face + 0.25 * fl) * L.k, (0.25 + 0.8 * face + 0.25 * fl) * L.k, 1);
    L.flare.material.opacity = 0.25 + 0.75 * Math.min(1, face + 0.5 * fl);
    L.lantern.emissiveIntensity = 1.3 + 2 * Math.max(face, fl);
  });
  // The ship: lit white-gold by any beam on it, glowing in the colours of the lights that just found it.
  const beamTint: RGB = lit > 0 ? (litCol.map((c) => c / lit) as RGB) : [255, 240, 210];
  const glowTint: RGB = flashSum > 0 ? (flashCol.map((c) => c / flashSum) as RGB) : beamTint;
  v.ship.paint.emissive.copy(linear(beamTint));
  v.ship.paint.emissiveIntensity = Math.min(1.2, 0.9 * lit);
  v.ship.white.emissiveIntensity = 0.12 + Math.min(1.6, 1.2 * lit + 0.3 * flashSum);
  v.shipGlow.material.color.copy(linear(lighten(glowTint, 0.3)));
  v.shipGlow.material.opacity = Math.min(0.75, 0.35 * flashSum + 0.3 * lit);
  v.shipGlow.scale.setScalar(1.2 + 0.7 * Math.min(2, flashSum) + 0.5 * Math.min(1.5, lit));
  v.shipLight.color.copy(linear(beamTint));
  v.shipLight.intensity = 1.6 * Math.min(1.5, lit);
  const w = 2 * Math.PI * u;
  v.shipHolder.rotation.x = 0.04 * Math.sin(3 * w);
  v.shipHolder.rotation.z = 0.025 * Math.sin(5 * w + 1);
  // A slow drift, whole cycles per loop so the loop stays seamless.
  v.camera.position.set(COAST_CAM.x + 0.25 * Math.sin(w), COAST_CAM.y + 0.06 * Math.sin(2 * w), COAST_CAM.z);
  v.camera.lookAt(LOOK);
  draw3D(ctx, v.scene, v.camera);
}
