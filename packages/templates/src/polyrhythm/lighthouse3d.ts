/**
 * Lighthouse Sweep (rendering only, plus the layout the sim pans by): lighthouses on rocky islets
 * round a bay at night, each turning its beam a whole number of times per loop. A lighthouse flashes,
 * and rings its note, when its beam swings round to face you (which is how a real lighthouse's flash
 * works); they all face you together at the start and end of the loop.
 *
 * The sea is shaded per pixel: small waves (whole cycles per loop), the sky and moon reflected, a
 * glittering column of light under every lantern, and each beam's light sweeping the water.
 */
import { hexToRgb, lighten, mixRgb, paletteAt, type Ctx2D, type RGB, type Theme } from '@sim/engine';
import { THREE, canvasTexture, draw3D, sceneCache } from '../three-layer';

/** Lighthouses that read on screen. */
export const MAX_LIGHTHOUSES = 9;
const MAX_LH = 12;
const CAM = new THREE.Vector3(0, 2.6, 6.8);
const LOOK = new THREE.Vector3(0, 0.55, -4.5);
const BEAM_LEN = 6;
const MOON_DIR = new THREE.Vector3(-0.45, 0.42, -1).normalize();

export interface LighthouseView {
  cycles: number[];
  p: { loopSeconds: number };
  colorShift: number;
  flash: number[];
}

const hash01 = (x: number) => {
  const v = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

const SPREAD = 2.15;

/**
 * Where lighthouse i (of n) stands: round the far side of the bay (the middle furthest away), every
 * other one set further back so neighbours don't crowd, the first on the left.
 */
export function lighthouseSpot(i: number, n: number): { x: number; z: number } {
  const x = n > 1 ? -SPREAD + (2 * SPREAD * i) / (n - 1) : 0;
  return { x, z: -4.6 - 1.8 * (1 - (x / SPREAD) ** 2) - (i % 2) * 1.3 };
}

/** Stereo position of lighthouse i. */
export const lighthousePan = (i: number, n: number) => lighthouseSpot(i, n).x / SPREAD;

const linear = (c: RGB) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
const vec3 = (c: RGB) => {
  const l = linear(c);
  return new THREE.Vector3(l.r, l.g, l.b);
};
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

const BEAM_VERT = /* glsl */ `
varying float vAlong; varying vec3 vN; varying vec3 vV;
uniform float uLen;
void main() {
  vAlong = position.x / uLen;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uIntensity;
varying float vAlong; varying vec3 vN; varying vec3 vV;
void main() {
  // Soft at the cone's edges (seen edge-on), bright down its middle, fading along its length.
  float core = pow(abs(dot(normalize(vN), normalize(vV))), 1.7);
  float fall = (1.0 - smoothstep(0.0, 1.0, vAlong)) * smoothstep(0.0, 0.03, vAlong);
  float a = uIntensity * core * fall * fall;
  gl_FragColor = vec4(uColor * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SEA_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SEA_FRAG = /* glsl */ `
#define MAX_LH ${MAX_LH}
uniform int uCount;
uniform vec3 uLamp[MAX_LH];
uniform vec2 uBeam[MAX_LH];
uniform vec3 uCol[MAX_LH];
uniform float uFace[MAX_LH];
uniform vec3 uDeep, uSkyLow, uSkyHigh, uHorizon, uMoonCol, uMoonDir;
uniform float uPhase;
varying vec3 vWorld;
const float TAU = 6.2831853;

vec2 slope(vec2 p) {
  // Sums of waves with whole cycles per loop, longer swells under finer chop.
  vec2 g = vec2(0.0);
  vec2 d1 = normalize(vec2(0.3, 1.0)), d2 = normalize(vec2(-0.7, 0.7)), d3 = normalize(vec2(0.9, 0.4)), d4 = normalize(vec2(-0.2, 1.0));
  g += 0.05 * d1 * cos(dot(d1, p) * 2.1 - TAU * 3.0 * uPhase);
  g += 0.04 * d2 * cos(dot(d2, p) * 3.9 + TAU * 4.0 * uPhase);
  g += 0.035 * d3 * cos(dot(d3, p) * 7.3 - TAU * 6.0 * uPhase);
  g += 0.03 * d4 * cos(dot(d4, p) * 13.1 + TAU * 9.0 * uPhase);
  g += 0.02 * vec2(cos(p.x * 21.0 + p.y * 5.0 - TAU * 11.0 * uPhase), cos(p.y * 19.0 - p.x * 4.0 + TAU * 13.0 * uPhase));
  return g;
}

void main() {
  vec2 p = vWorld.xz;
  vec2 g = slope(p);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 r = reflect(-v, n);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 sky = mix(uSkyLow, uSkyHigh, pow(max(r.y, 0.0), 0.5));
  vec3 col = mix(uDeep, sky, fres);
  col += uMoonCol * (pow(max(dot(r, uMoonDir), 0.0), 600.0) * 1.5 + pow(max(dot(r, uMoonDir), 0.0), 40.0) * 0.04);
  for (int i = 0; i < MAX_LH; i++) {
    if (i >= uCount) break;
    vec3 lamp = uLamp[i];
    // The lantern's glittering column of light.
    float glint = max(dot(r, normalize(lamp - vWorld)), 0.0);
    col += uCol[i] * (pow(glint, 900.0) * (0.3 + 1.4 * uFace[i]) + pow(glint, 80.0) * (0.008 + 0.03 * uFace[i]));
    // The beam's light on the water as it sweeps past.
    vec2 d = p - lamp.xz;
    float dist = length(d);
    float along = dot(d / max(dist, 1e-3), uBeam[i]);
    // (Faded while the beam faces the camera: then it's the flare that flashes.)
    float on = exp(-(1.0 - along) / 0.0035) * exp(-dist / 3.0) * smoothstep(0.3, 1.2, dist);
    col += uCol[i] * on * 0.12 * (1.0 - 0.85 * uFace[i]);
  }
  float far = length(vWorld.xz - cameraPosition.xz);
  col = mix(col, uHorizon, smoothstep(10.0, 40.0, far));
  gl_FragColor = vec4(col, 1.0 - smoothstep(30.0, 55.0, far));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function glowTexture(streak: boolean) {
  return canvasTexture(256, 256, (ctx) => {
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.15, 'rgba(255,240,210,0.6)');
    g.addColorStop(0.45, 'rgba(255,220,170,0.12)');
    g.addColorStop(1, 'rgba(255,200,150,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    if (streak) {
      // An anamorphic streak across the flare.
      const s = ctx.createLinearGradient(0, 128, 256, 128);
      s.addColorStop(0, 'rgba(255,240,220,0)');
      s.addColorStop(0.5, 'rgba(255,245,230,0.9)');
      s.addColorStop(1, 'rgba(255,240,220,0)');
      ctx.fillStyle = s;
      ctx.fillRect(0, 124, 256, 8);
    }
  });
}

/** Tower stripes in the lighthouse's colour and white. */
function stripeTexture(col: RGB, bands: number) {
  return canvasTexture(64, 256, (ctx) => {
    for (let b = 0; b < bands; b++) {
      ctx.fillStyle = b % 2 ? `rgb(${col.map(Math.round).join(',')})` : 'rgb(236,232,224)';
      ctx.fillRect(0, (b / bands) * 256, 64, 256 / bands + 1);
    }
  });
}

/** A lumpy rock: an icosphere with its points pushed in and out. */
function rock(seed: number, size: number) {
  const geo = new THREE.IcosahedronGeometry(size, 1);
  const pos = geo.attributes.position;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k);
    const y = pos.getY(k);
    const z = pos.getZ(k);
    const f = 0.75 + 0.5 * hash01(seed + Math.round((x * 7 + y * 13 + z * 17) * 100) * 0.01);
    pos.setXYZ(k, x * f, y * f * 0.7, z * f);
  }
  geo.computeVertexNormals();
  return geo;
}

const view = sceneCache((s: LighthouseView, theme: Theme) => {
  const n = s.cycles.length;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, 1080 / 1920, 0.1, 120);
  const bg0 = hexToRgb(theme.bg[0]);
  const bg1 = hexToRgb(theme.bg[1]);
  const night = mixRgb(mixRgb(bg0, bg1, 0.5), [8, 14, 30], 0.5);
  const moonCol = mixRgb([215, 225, 255], lighten(hexToRgb(theme.palette[0]), 0.6), 0.15);
  scene.fog = new THREE.Fog(linear(night), 12, 40);

  scene.add(new THREE.AmbientLight(0x8090b0, 0.25));
  const moon = new THREE.DirectionalLight(linear(moonCol), 0.7);
  moon.position.copy(MOON_DIR).multiplyScalar(20);
  scene.add(moon);

  // Sky: stars above the horizon and a soft moon.
  const stars = new Float32Array(900 * 3);
  for (let k = 0; k < 900; k++) {
    const a = hash01(k * 1.3) * Math.PI * 2;
    const el = 0.02 + 0.9 * hash01(k * 2.7 + 3) ** 1.5;
    stars.set([Math.cos(a) * Math.cos(el) * 60, Math.sin(el) * 60, Math.sin(a) * Math.cos(el) * 60], k * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(stars, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, transparent: true, opacity: 0.75, depthWrite: false, fog: false })));
  const moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(false), color: linear(moonCol), blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  moonSprite.position.copy(MOON_DIR).multiplyScalar(50);
  moonSprite.scale.setScalar(9);
  scene.add(moonSprite);

  // The sea.
  const sea = new THREE.ShaderMaterial({
    vertexShader: SEA_VERT,
    fragmentShader: SEA_FRAG,
    transparent: true,
    uniforms: {
      uCount: { value: n },
      uLamp: { value: Array.from({ length: MAX_LH }, () => new THREE.Vector3()) },
      uBeam: { value: Array.from({ length: MAX_LH }, () => new THREE.Vector2()) },
      uCol: { value: Array.from({ length: MAX_LH }, () => new THREE.Vector3()) },
      uFace: { value: new Array(MAX_LH).fill(0) },
      uDeep: { value: vec3(shade(night, 0.45)) },
      uSkyLow: { value: vec3(lighten(night, 0.12)) },
      uSkyHigh: { value: vec3(shade(night, 0.7)) },
      uHorizon: { value: vec3(mixRgb(bg0, bg1, 0.35)) },
      uMoonCol: { value: vec3(moonCol) },
      uMoonDir: { value: MOON_DIR.clone() },
      uPhase: { value: 0 },
    },
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), sea);
  water.rotation.x = -Math.PI / 2;
  scene.add(water);

  const rockMat = new THREE.MeshStandardMaterial({ color: 0x3a3c42, roughness: 0.95, metalness: 0, flatShading: true });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c1e24, roughness: 0.5, metalness: 0.6 });
  const flareTex = glowTexture(true);
  const glowTex = glowTexture(false);
  const beamGeo = new THREE.ConeGeometry(0.45, BEAM_LEN, 40, 1, true);
  beamGeo.rotateZ(Math.PI / 2);
  beamGeo.translate(BEAM_LEN / 2, 0, 0);

  const towers = s.cycles.map((_, i) => {
    const col = paletteAt(theme.palette, ((i / Math.max(1, n - 1)) * 0.95 + s.colorShift) % 1);
    const { x, z } = lighthouseSpot(i, n);
    const h = 1.05 + 0.35 * hash01(i + s.colorShift * 10);
    const base = new THREE.Group();
    base.position.set(x, 0, z);
    scene.add(base);
    // The islet.
    for (let k = 0; k < 4; k++) {
      const rr = rock(i * 10 + k, 0.15 + 0.11 * hash01(i * 3 + k));
      const m = new THREE.Mesh(rr, rockMat);
      m.position.set((hash01(i * 7 + k) - 0.5) * 0.45, 0.02, (hash01(i * 11 + k) - 0.5) * 0.3);
      m.rotation.y = hash01(i * 5 + k) * 6;
      base.add(m);
    }
    // The tower, gallery, lantern room and roof.
    const stripe = new THREE.MeshStandardMaterial({ map: stripeTexture(col, 4 + 2 * Math.floor(hash01(i + 4) * 2)), roughness: 0.7 });
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, h, 32), stripe);
    tower.position.y = 0.12 + h / 2;
    base.add(tower);
    const top = 0.12 + h;
    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.14, 0.035, 28), darkMat);
    gallery.position.y = top + 0.015;
    base.add(gallery);
    const lantern = new THREE.MeshStandardMaterial({ color: 0x302a20, emissive: linear(mixRgb([255, 230, 180], col, 0.3)), emissiveIntensity: 1.2, roughness: 0.2 });
    const room = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.15, 20), lantern);
    room.position.y = top + 0.11;
    base.add(room);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.115, 0.11, 20), darkMat);
    roof.position.y = top + 0.24;
    base.add(roof);
    const lampY = top + 0.11;
    const lamp = new THREE.PointLight(linear(mixRgb([255, 225, 170], col, 0.3)), 1.2, 2.2, 1.5);
    lamp.position.y = lampY;
    base.add(lamp);
    // The beam (turning) and its flare (facing the camera, bright when the beam does too).
    const beamColor = mixRgb([255, 240, 205], col, 0.35);
    const beamMat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: { uColor: { value: vec3(beamColor) }, uIntensity: { value: 0.32 }, uLen: { value: BEAM_LEN } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.y = lampY;
    // Tipped a touch toward the sea.
    beam.rotation.order = 'YZX';
    beam.rotation.z = -0.03;
    beam.renderOrder = 5;
    base.add(beam);
    // Glows draw over everything (light glares past the lantern's own glass).
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: flareTex, color: linear(beamColor), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, fog: false }));
    flare.position.set(x, lampY, z);
    // Light draws after the sea (which, being nearer, would otherwise be sorted over it).
    flare.renderOrder = 10;
    scene.add(flare);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: linear(beamColor), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, opacity: 0.5, fog: false }));
    halo.position.set(x, lampY, z);
    halo.scale.setScalar(0.5);
    halo.renderOrder = 10;
    scene.add(halo);
    // Facing the camera is the beam angle where it flashes.
    const toCam = Math.atan2(CAM.z - z, CAM.x - x);
    (sea.uniforms.uLamp.value as THREE.Vector3[])[i].set(x, lampY, z);
    (sea.uniforms.uCol.value as THREE.Vector3[])[i].copy(vec3(beamColor));
    return { beam, beamMat, flare, lantern, toCam, x, z };
  });
  return { scene, camera, sea, towers };
});

export function drawLighthouses(ctx: Ctx2D, theme: Theme, s: LighthouseView, t: number) {
  const v = view(s, theme);
  const u = t / s.p.loopSeconds;
  v.sea.uniforms.uPhase.value = u;
  v.towers.forEach((tw, i) => {
    // Clockwise seen from above, facing the camera at every whole turn.
    const a = tw.toCam - 2 * Math.PI * s.cycles[i] * u;
    tw.beam.rotation.y = -a;
    (v.sea.uniforms.uBeam.value as THREE.Vector2[])[i].set(Math.cos(a), Math.sin(a));
    // How squarely the beam faces the camera: a sharp flash as it sweeps past.
    const face = Math.max(0, Math.cos(a - tw.toCam)) ** 70;
    (v.sea.uniforms.uFace.value as number[])[i] = face;
    const fl = s.flash[i];
    tw.flare.scale.set(0.3 + 1.9 * face + 0.3 * fl, 0.3 + 1.0 * face + 0.3 * fl, 1);
    tw.flare.material.opacity = 0.2 + 0.8 * Math.min(1, face + 0.5 * fl);
    // Facing the camera the beam is seen end-on: let the flare carry the flash instead of its volume.
    const wide = Math.max(0, Math.cos(a - tw.toCam)) ** 6;
    tw.beamMat.uniforms.uIntensity.value = (0.32 + 0.2 * fl) * (1 - 0.85 * wide);
    tw.lantern.emissiveIntensity = 1.2 + 2 * Math.max(face, fl);
  });
  // A slow drift, whole cycles per loop so the loop stays seamless.
  const w = 2 * Math.PI * u;
  v.camera.position.set(CAM.x + 0.25 * Math.sin(w), CAM.y + 0.06 * Math.sin(2 * w), CAM.z);
  v.camera.lookAt(LOOK);
  draw3D(ctx, v.scene, v.camera);
}
