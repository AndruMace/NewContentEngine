/**
 * Orrery (rendering only): planets circling a sun, each a whole number of laps per loop, slowest on
 * the outside. They start lined up on a beam to the sun's right and ring each time they cross it;
 * at the end of the loop every planet is back on the beam (the planets align).
 */
import { lighten, paletteAt, type Ctx2D, type RGB, type Theme } from '@sim/engine';
import { THREE, canvasTexture, draw3D, sceneCache } from '../three-layer';

/** Planets that read on screen. */
export const MAX_PLANETS = 8;

export interface OrreryView {
  /** Laps per loop per planet, outermost first. */
  cycles: number[];
  p: { loopSeconds: number };
  colorShift: number;
  flash: number[];
}

const R_IN = 0.7;
const R_OUT = 2.1;
const SUN_R = 0.34;

/** Orbit radius of planet i (of n): the first (slowest) is outermost. */
export const orbitRadius = (i: number, n: number) => R_OUT - (i * (R_OUT - R_IN)) / Math.max(1, n - 1);

/** A repeatable 0..1 per planet (sizes, bands, rings): visual only. */
const hash01 = (x: number) => {
  const v = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

const css = (c: RGB) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',')})`;
const toColor = (c: RGB) => new THREE.Color(css(c));

/** Gas-giant bands in shades of the planet's colour. */
function bandTexture(col: RGB, seed: number) {
  return canvasTexture(256, 128, (ctx) => {
    const bands = 5 + Math.floor(hash01(seed) * 9);
    for (let b = 0; b < bands; b++) {
      const y0 = (b / bands) * 128;
      const shade = 0.75 + 0.5 * hash01(seed + b * 3.1);
      ctx.fillStyle = css([col[0] * shade, col[1] * shade, col[2] * shade]);
      ctx.fillRect(0, y0, 256, 128 / bands + 1);
    }
    // A soft storm spot on some.
    if (hash01(seed + 9) > 0.55) {
      ctx.fillStyle = css(lighten(col, 0.35));
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.ellipse(70 + 120 * hash01(seed + 4), 40 + 50 * hash01(seed + 5), 18, 9, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function glowTexture() {
  return canvasTexture(256, 256, (ctx) => {
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,240,200,1)');
    g.addColorStop(0.25, 'rgba(255,200,120,0.55)');
    g.addColorStop(0.6, 'rgba(255,150,80,0.12)');
    g.addColorStop(1, 'rgba(255,120,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  });
}

const view = sceneCache((s: OrreryView, theme: Theme) => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, 1080 / 1920, 0.1, 100);

  scene.add(new THREE.AmbientLight(0xffffff, 0.12));
  const sunLight = new THREE.PointLight(0xfff0d8, 3.2, 0, 0);
  scene.add(sunLight);

  const sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 48, 32), new THREE.MeshBasicMaterial({ color: 0xffe2a8 }));
  scene.add(sun);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(SUN_R * 6.5);
  scene.add(glow);

  // Starfield on a far sphere.
  const stars = new Float32Array(900 * 3);
  for (let k = 0; k < 900; k++) {
    const u = hash01(k * 1.7) * 2 - 1;
    const a = hash01(k * 2.9 + 1) * Math.PI * 2;
    const r = Math.sqrt(1 - u * u) * 40;
    stars.set([r * Math.cos(a), u * 40, r * Math.sin(a)], k * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(stars, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.7, depthWrite: false })));

  // The alignment beam: where every planet starts, and where each rings as it passes.
  const beamLen = R_OUT + 0.35 - SUN_R;
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(new THREE.PlaneGeometry(beamLen, 0.035), beamMat);
  beam.rotation.x = -Math.PI / 2;
  beam.position.x = SUN_R + beamLen / 2;
  scene.add(beam);

  const n = s.cycles.length;
  const sphere = new THREE.SphereGeometry(1, 48, 32);
  const planets = s.cycles.map((_, i) => {
    const col = paletteAt(theme.palette, ((i / Math.max(1, n - 1)) * 0.95 + s.colorShift) % 1);
    const r = orbitRadius(i, n);
    const orbitMat = new THREE.MeshBasicMaterial({ color: toColor(lighten(col, 0.2)), transparent: true, opacity: 0.25, depthWrite: false });
    const orbit = new THREE.Mesh(new THREE.TorusGeometry(r, 0.007, 6, 240), orbitMat);
    orbit.rotation.x = Math.PI / 2;
    scene.add(orbit);

    // Outer planets run a little bigger, like gas giants; none so big that neighbours touch when aligned.
    const room = Math.min(0.12, 0.42 * ((R_OUT - R_IN) / Math.max(1, n - 1)));
    const size = room * (0.72 + 0.16 * (1 - i / Math.max(1, n - 1)) + 0.12 * hash01(i + s.colorShift * 10));
    const mat = new THREE.MeshStandardMaterial({ map: bandTexture(col, i * 13.7 + 2), roughness: 0.85, metalness: 0, emissive: toColor(lighten(col, 0.4)), emissiveIntensity: 0 });
    const body = new THREE.Mesh(sphere, mat);
    body.scale.setScalar(size);
    body.rotation.z = 0.3 * (hash01(i * 5.1) - 0.5);
    const holder = new THREE.Group();
    holder.add(body);
    if (size > 0.8 * room && hash01(i * 3.3 + 7) > 0.4) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(size * 1.45, size * 2.3, 72),
        new THREE.MeshBasicMaterial({ color: toColor(lighten(col, 0.35)), transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2 + 0.45;
      holder.add(ring);
    }
    scene.add(holder);
    return { holder, body, mat, orbitMat, r };
  });
  return { scene, camera, planets, beamMat, glow };
});

export function drawOrrery(ctx: Ctx2D, theme: Theme, s: OrreryView, t: number) {
  const v = view(s, theme);
  const T = s.p.loopSeconds;
  let lit = 0;
  v.planets.forEach((p, i) => {
    const a = (2 * Math.PI * s.cycles[i] * t) / T;
    p.holder.position.set(p.r * Math.cos(a), 0, -p.r * Math.sin(a));
    p.body.rotation.y = t * (0.4 + 0.3 * hash01(i));
    p.mat.emissiveIntensity = 0.7 * s.flash[i];
    p.orbitMat.opacity = 0.22 + 0.5 * s.flash[i];
    lit += s.flash[i] / v.planets.length;
  });
  v.beamMat.opacity = 0.12 + 0.6 * lit;
  v.glow.scale.setScalar(SUN_R * (6.5 + 2 * lit));
  // Looking down at the plane from about 50°, drifting slightly.
  const az = 0.07 * Math.sin((2 * Math.PI * t) / T);
  const el = 0.87;
  const dist = 11.2;
  v.camera.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
  v.camera.lookAt(0, 0.35, 0);
  draw3D(ctx, v.scene, v.camera);
}
