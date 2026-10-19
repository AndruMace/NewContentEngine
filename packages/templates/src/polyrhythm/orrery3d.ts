/**
 * Orrery (rendering only): planets circling a sun, each a whole number of laps per loop, slowest on
 * the outside. They ring each time they cross the alignment beam to the sun's right. Either they
 * start lined up on the beam and come back into line at the end (a seamless loop), or they start
 * scattered and align only at the very end.
 *
 * Every planet is its own world: gas giants with belts and storms (some ringed), ice worlds with
 * cracks, earth-like worlds with oceans and clouds, cratered rock, lava and desert, with moons and
 * atmospheres, all painted from noise and tinted by the theme's palette.
 */
import { lighten, mixRgb, paletteAt, type Ctx2D, type RGB, type Theme } from '@sim/engine';
import { THREE, canvasTexture, draw3D, sceneCache } from '../three-layer';
import { hash01, nebulaTexture, planetSurface, ringTexture, sunTexture, type PlanetType } from './planets';

/** Planets that read on screen. */
export const MAX_PLANETS = 8;

export interface OrreryView {
  /** Laps per loop per planet, outermost first (fractional when they start scattered). */
  cycles: number[];
  beatRate: number[];
  /** Seconds held after the loop: set when the planets start scattered and align at the end. */
  holdS: number;
  p: { loopSeconds: number };
  colorShift: number;
  flash: number[];
}

const R_IN = 0.62;
const R_OUT = 2.1;
const SUN_R = 0.3;

/** Orbit radius of planet i (of n), evenly spaced: the first (slowest) is outermost. The drawn orbits
 * are spaced by planet size instead; this is close enough for stereo placement. */
export const orbitRadius = (i: number, n: number) => R_OUT - (i * (R_OUT - R_IN)) / Math.max(1, n - 1);

/**
 * Orbit radii and planet sizes: each gap between orbits is shared out by the size of the two planets
 * either side, so giants get the room they need and neighbours never touch when they line up.
 */
function layoutOrbits(rel: number[]): { radii: number[]; sizes: number[] } {
  const n = rel.length;
  if (n === 1) return { radii: [(R_IN + R_OUT) / 2], sizes: [Math.min(0.2, rel[0] * 0.2)] };
  let need = 0;
  for (let i = 0; i + 1 < n; i++) need += rel[i] + rel[i + 1];
  // Neighbours keep a fifth of their gap clear.
  const k = Math.min(0.2, (R_OUT - R_IN) / (need * 1.25));
  const radii = [R_OUT];
  for (let i = 1; i < n; i++) radii.push(radii[i - 1] - ((R_OUT - R_IN) * (rel[i - 1] + rel[i])) / need);
  return { radii, sizes: rel.map((r) => r * k) };
}

const css = (c: RGB) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',')})`;
const toColor = (c: RGB) => new THREE.Color(css(c));

/** Size of each type, relative to the room its orbit allows. */
const TYPE_SIZE: Record<PlanetType, number> = { gas: 1, ice: 0.85, earth: 0.8, desert: 0.72, lava: 0.66, rocky: 0.6 };

/**
 * Planet types, outermost first: giants and ice worlds out far, rocky worlds close in, never the same
 * type twice in a row.
 */
function planetTypes(n: number, seed: number): PlanetType[] {
  const outer: PlanetType[] = hash01(seed) > 0.5 ? ['gas', 'ice'] : ['ice', 'gas'];
  const inner: PlanetType[] = ['earth', 'rocky', 'lava', 'desert'];
  const rot = Math.floor(hash01(seed + 1) * inner.length);
  const types: PlanetType[] = [];
  for (let i = 0; i < n; i++) {
    const far = n > 2 && i < Math.ceil(n * 0.4);
    types.push(far ? outer[i % 2] : inner[(i + rot) % inner.length]);
  }
  return types;
}

/** Rim glow on the day side (atmospheres). */
function atmosphereMaterial(col: RGB) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: toColor(col) }, uStrength: { value: 1.3 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vS;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        vS = normalize(-wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uStrength;
      varying vec3 vN; varying vec3 vV; varying vec3 vS;
      void main() {
        vec3 n = normalize(vN);
        float rim = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 2.4);
        float day = smoothstep(-0.35, 0.55, dot(n, normalize(vS)));
        gl_FragColor = vec4(uColor * rim * day * uStrength, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

function glowTexture(stops: [number, string][]) {
  return canvasTexture(256, 256, (ctx) => {
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    for (const [at, c] of stops) g.addColorStop(at, c);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  });
}

/** Faint rays around the sun. */
function coronaTexture() {
  return canvasTexture(512, 512, (ctx) => {
    const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 256);
    g.addColorStop(0, 'rgba(255,220,160,0.5)');
    g.addColorStop(0.2, 'rgba(255,170,90,0.18)');
    g.addColorStop(1, 'rgba(255,120,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 36; k++) {
      const a = (k / 36) * Math.PI * 2 + hash01(k) * 0.15;
      const len = 120 + 130 * hash01(k + 50);
      const rg = ctx.createLinearGradient(256, 256, 256 + Math.cos(a) * len, 256 + Math.sin(a) * len);
      rg.addColorStop(0, 'rgba(255,220,170,0.22)');
      rg.addColorStop(1, 'rgba(255,200,140,0)');
      ctx.strokeStyle = rg;
      ctx.lineWidth = 2 + 4 * hash01(k + 9);
      ctx.beginPath();
      ctx.moveTo(256, 256);
      ctx.lineTo(256 + Math.cos(a) * len, 256 + Math.sin(a) * len);
      ctx.stroke();
    }
  });
}

function starfield(count: number, size: number, opacity: number, seed: number) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    const u = hash01(seed + k * 1.7) * 2 - 1;
    const a = hash01(seed + k * 2.9 + 1) * Math.PI * 2;
    const r = Math.sqrt(1 - u * u) * 40;
    pos.set([r * Math.cos(a), u * 40, r * Math.sin(a)], k * 3);
    const warm = hash01(seed + k * 4.1);
    col.set(warm > 0.8 ? [1, 0.85, 0.7] : warm < 0.25 ? [0.75, 0.85, 1] : [1, 1, 1], k * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ size, vertexColors: true, transparent: true, opacity, depthWrite: false }));
}

interface Planet {
  holder: THREE.Group;
  body: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  clouds: THREE.Mesh | null;
  moons: { pivot: THREE.Group; laps: number }[];
  orbitMat: THREE.MeshBasicMaterial;
  r: number;
  spin: number;
  baseEmissive: number;
}

const view = sceneCache((s: OrreryView, theme: Theme) => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, 1080 / 1920, 0.1, 100);
  const seed = s.colorShift * 97 + s.cycles.length;

  scene.add(new THREE.AmbientLight(0xffffff, 0.1));
  scene.add(new THREE.PointLight(0xfff0d8, 3.4, 0, 0));

  // Backdrop: stars and a couple of faint nebulae in the theme's colours, far behind the system.
  scene.add(starfield(1400, 0.07, 0.6, seed), starfield(160, 0.16, 0.95, seed + 500));
  for (let k = 0; k < 3; k++) {
    const neb = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: nebulaTexture(paletteAt(theme.palette, (s.colorShift + k * 0.33) % 1), seed + k * 7.7), blending: THREE.AdditiveBlending, transparent: true, opacity: 0.2, depthWrite: false }),
    );
    neb.position.set((k - 1) * 9 + 3 * (hash01(seed + k) - 0.5), -16 - 3 * k, -14 + 4 * hash01(seed + k * 3));
    neb.scale.setScalar(20 + 8 * hash01(seed + k * 5));
    neb.material.rotation = hash01(seed + k * 9) * Math.PI * 2;
    scene.add(neb);
  }

  // The sun: a granulated surface, a hot glow and a faint rayed corona.
  const sunTex = sunTexture();
  const sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 64, 40), new THREE.MeshBasicMaterial({ map: sunTex }));
  scene.add(sun);
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture([
        [0, 'rgba(255,245,210,1)'],
        [0.22, 'rgba(255,205,120,0.6)'],
        [0.55, 'rgba(255,150,70,0.14)'],
        [1, 'rgba(255,120,60,0)'],
      ]),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  glow.scale.setScalar(SUN_R * 4.4);
  scene.add(glow);
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: coronaTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5 }));
  corona.scale.setScalar(SUN_R * 10);
  scene.add(corona);

  // The alignment beam: where the planets line up, and where each rings as it passes.
  const beamLen = R_OUT + 0.35 - SUN_R;
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(new THREE.PlaneGeometry(beamLen, 0.035), beamMat);
  beam.rotation.x = -Math.PI / 2;
  beam.position.x = SUN_R + beamLen / 2;
  scene.add(beam);

  const n = s.cycles.length;
  const types = planetTypes(n, seed);
  const ringedAt = types.map((type, i) => (type === 'gas' && hash01(seed + i * 13.7 + 1) > 0.3) || (type === 'ice' && hash01(seed + i * 13.7 + 2) > 0.7));
  // Ringed planets count their rings in the room they need.
  const { radii, sizes } = layoutOrbits(types.map((type, i) => TYPE_SIZE[type] * (0.95 + 0.1 * hash01(seed + i * 13.7 + 3)) * (ringedAt[i] ? 1.45 : 1)));
  const sphere = new THREE.SphereGeometry(1, 64, 40);
  const moonSurface = planetSurface('rocky', [170, 170, 175], [120, 120, 125], seed + 0.5);
  const moonMat = new THREE.MeshStandardMaterial({ map: moonSurface.map, bumpMap: moonSurface.bump, bumpScale: 2, roughness: 1 });

  const planets: Planet[] = s.cycles.map((_, i) => {
    const col = paletteAt(theme.palette, ((i / Math.max(1, n - 1)) * 0.95 + s.colorShift) % 1);
    const col2 = paletteAt(theme.palette, ((i / Math.max(1, n - 1)) * 0.95 + s.colorShift + 0.37) % 1);
    const r = radii[i];
    const type = types[i];
    const pSeed = seed + i * 13.7;
    const ringed = ringedAt[i];

    const orbitMat = new THREE.MeshBasicMaterial({ color: toColor(lighten(col, 0.2)), transparent: true, opacity: 0.2, depthWrite: false });
    const orbit = new THREE.Mesh(new THREE.TorusGeometry(r, 0.006, 6, 240), orbitMat);
    orbit.rotation.x = Math.PI / 2;
    scene.add(orbit);

    // A ringed planet's room covers most of its rings (they reach twice the body's radius).
    const size = sizes[i] / (ringed ? 1.8 : 1);
    const surf = planetSurface(type, col, col2, pSeed);
    const baseEmissive = surf.emissive ? 1.6 : 0;
    const mat = new THREE.MeshStandardMaterial({
      map: surf.map,
      bumpMap: surf.bump ?? null,
      bumpScale: surf.bump ? 3 : 1,
      roughness: surf.roughness,
      metalness: 0,
      emissive: surf.emissive ? new THREE.Color(0xffffff) : toColor(lighten(col, 0.4)),
      emissiveMap: surf.emissive ?? null,
      emissiveIntensity: baseEmissive,
    });
    const holder = new THREE.Group();
    const tilt = new THREE.Group();
    tilt.rotation.z = 0.5 * (hash01(pSeed + 4) - 0.5);
    tilt.rotation.x = 0.3 * (hash01(pSeed + 5) - 0.5);
    holder.add(tilt);
    const body = new THREE.Mesh(sphere, mat);
    body.scale.setScalar(size);
    tilt.add(body);

    let clouds: THREE.Mesh | null = null;
    if (surf.clouds) {
      clouds = new THREE.Mesh(sphere, new THREE.MeshStandardMaterial({ map: surf.clouds, transparent: true, roughness: 1, depthWrite: false }));
      clouds.scale.setScalar(size * 1.025);
      tilt.add(clouds);
    }
    if (surf.atmosphere) {
      const atmo = new THREE.Mesh(sphere, atmosphereMaterial(surf.atmosphere));
      atmo.scale.setScalar(size * 1.1);
      tilt.add(atmo);
    }
    if (ringed) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(size * 1.3, size * 2, 96),
        // Unlit, so the rings read from either side.
        new THREE.MeshBasicMaterial({ map: ringTexture(mixRgb(col, col2, 0.3), pSeed), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.85 }),
      );
      ring.rotation.x = -Math.PI / 2 + 0.35;
      tilt.add(ring);
    }

    // Moons: gas giants get two, earth-like worlds one, others sometimes one.
    const moonCount = type === 'gas' ? 2 : type === 'earth' || hash01(pSeed + 6) > 0.7 ? 1 : 0;
    const moons = Array.from({ length: moonCount }, (_, j) => {
      const pivot = new THREE.Group();
      pivot.rotation.x = 0.25 * (hash01(pSeed + 7 + j) - 0.5);
      const moon = new THREE.Mesh(sphere, moonMat);
      moon.scale.setScalar(Math.max(0.012, size * (0.16 + 0.08 * hash01(pSeed + 8 + j))));
      moon.position.x = size * ((ringed ? 2.6 : 1.7) + 0.55 * j);
      pivot.add(moon);
      holder.add(pivot);
      // Whole laps per loop, so the moons are back where they started at the end.
      return { pivot, laps: 4 + 3 * j + (i % 3) };
    });

    scene.add(holder);
    return { holder, body, mat, clouds, moons, orbitMat, r, spin: 2 + (i % 3), baseEmissive };
  });
  return { scene, camera, planets, beamMat, glow, corona, sun };
});

export function drawOrrery(ctx: Ctx2D, theme: Theme, s: OrreryView, t: number) {
  const v = view(s, theme);
  const T = s.p.loopSeconds;
  const u = t / T;
  // Scattered starts reach the beam together at the end; aligned ones start (and end) on it.
  const laps = s.holdS ? s.beatRate : s.cycles;
  const lineUp = s.holdS ? 1 : 0;
  let lit = 0;
  v.planets.forEach((p, i) => {
    const a = 2 * Math.PI * laps[i] * (u - lineUp);
    p.holder.position.set(p.r * Math.cos(a), 0, -p.r * Math.sin(a));
    // Whole turns per loop for spin, clouds and moons, so a seamless loop stays seamless.
    p.body.rotation.y = 2 * Math.PI * p.spin * u;
    if (p.clouds) p.clouds.rotation.y = 2 * Math.PI * (p.spin + 1) * u;
    for (const m of p.moons) m.pivot.rotation.y = 2 * Math.PI * m.laps * u;
    p.mat.emissiveIntensity = p.baseEmissive + (p.baseEmissive ? 1.2 : 0.55) * s.flash[i];
    p.orbitMat.opacity = 0.18 + 0.5 * s.flash[i];
    lit += s.flash[i] / v.planets.length;
  });
  v.sun.rotation.y = 2 * Math.PI * u;
  v.beamMat.opacity = 0.12 + 0.6 * lit;
  v.glow.scale.setScalar(SUN_R * (4.4 + 2 * lit));
  v.corona.material.rotation = 0.15 * Math.sin(2 * Math.PI * u);
  // Looking down at the plane from about 50°, drifting slightly.
  const az = 0.07 * Math.sin(2 * Math.PI * u);
  const el = 0.87;
  const dist = 11.2;
  v.camera.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
  v.camera.lookAt(0, 0.35, 0);
  draw3D(ctx, v.scene, v.camera);
}
