/**
 * Lighthouse Sweep (rendering). Ships: one tall lighthouse on a rock at night, its beam sweeping the
 * sea, and a ship per element sailing round it in its own lane (small fast boats inside, slow
 * freighters outside); each ship is lit, and rings, as the beam finds it. The coast scene (coast3d)
 * shares the sea, the towers, the ships and the glows from here.
 *
 * The sea is shaded per pixel: small waves (whole cycles per loop), the sky and moon reflected, a
 * glittering column under every lantern, each beam's light sweeping the water, and the ships' wakes.
 */
import { hexToRgb, lighten, mixRgb, paletteAt, type Ctx2D, type RGB, type Theme } from '@sim/engine';
import { THREE, canvasTexture, draw3D, sceneCache } from '../three-layer';
import { beamAngle, islandScale, outerLane, shipAngle } from './lighthouse';

export const MAX_LAMPS = 6;
export const MAX_BEAMS = 18;
export const MAX_WAKES = 16;
export const MOON_DIR = new THREE.Vector3(-0.5, 0.38, -1).normalize();

export const hash01 = (x: number) => {
  const v = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};
export const linear = (c: RGB) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
export const vec3 = (c: RGB) => {
  const l = linear(c);
  return new THREE.Vector3(l.r, l.g, l.b);
};
export const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
/** Angle a → b, wrapped to (−π, π]. */
export const angleDiff = (a: number, b: number) => {
  const d = (((b - a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI);
  return d - Math.PI;
};
/** Plan-view angle (anticlockwise from +x, seen from above) from one point to another. */
export const planAngle = (fx: number, fz: number, tx: number, tz: number) => Math.atan2(-(tz - fz), tx - fx);

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
  float a = uIntensity * core * fall;
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
#define MAX_LAMPS ${MAX_LAMPS}
#define MAX_BEAMS ${MAX_BEAMS}
#define MAX_WAKES ${MAX_WAKES}
uniform int uLamps, uBeams, uWakes;
uniform vec3 uLamp[MAX_LAMPS];
uniform vec3 uLampCol[MAX_LAMPS];
uniform float uLampFace[MAX_LAMPS];
uniform vec3 uBeamFrom[MAX_BEAMS];
uniform vec2 uBeamDir[MAX_BEAMS];
uniform vec3 uBeamCol[MAX_BEAMS];
uniform float uBeamReach[MAX_BEAMS];
uniform vec2 uBeamShape[MAX_BEAMS];
uniform float uBeamFace[MAX_BEAMS];
uniform vec4 uWake[MAX_WAKES];
uniform vec3 uDeep, uSkyLow, uSkyHigh, uHorizon, uMoonCol, uMoonDir, uFoam;
uniform float uPhase, uFar;
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
  // Wakes: a churned trail and the two arms of a V spreading behind each ship, along its lane.
  float foam = 0.0;
  float rho = length(p);
  float ang = atan(-p.y, p.x);
  for (int i = 0; i < MAX_WAKES; i++) {
    if (i >= uWakes) break;
    vec4 w = uWake[i];
    if (w.z == 0.0) continue;
    float s = mod(w.y - ang, TAU) * w.x;
    float len = 0.6 + 1.6 * w.w;
    if (s > len) continue;
    float off = abs(rho - w.x);
    float fade = 1.0 - s / len;
    float arms = exp(-pow((off - 0.35 * w.w * 0.18 - 0.3 * s) / (0.012 + 0.03 * s), 2.0));
    float trail = exp(-pow(off / (0.02 + 0.07 * w.w + 0.04 * s), 2.0));
    foam += (0.55 * arms + 0.9 * trail * smoothstep(0.0, 0.08, s)) * fade * fade;
  }
  col += uFoam * min(foam, 1.5) * (0.6 + 0.4 * fres);
  for (int i = 0; i < MAX_LAMPS; i++) {
    if (i >= uLamps) break;
    // The lantern's glittering column of light.
    float glint = max(dot(r, normalize(uLamp[i] - vWorld)), 0.0);
    col += uLampCol[i] * (pow(glint, 900.0) * (0.2 + 1.0 * uLampFace[i]) + pow(glint, 80.0) * (0.006 + 0.02 * uLampFace[i]));
  }
  for (int i = 0; i < MAX_BEAMS; i++) {
    if (i >= uBeams) break;
    // The beam runs from the lamp down to where it meets the water (H); past that it's under the sea.
    vec3 O = uBeamFrom[i];
    vec3 H = vec3(O.x + uBeamDir[i].x * uBeamReach[i], 0.0, O.z + uBeamDir[i].y * uBeamReach[i]);
    vec3 D = H - O;
    float lh = length(D);
    D /= lh;
    float R = uBeamShape[i].x;
    float len = uBeamShape[i].y;
    // (Faded while the beam faces the camera: then it's the flare that flashes.)
    float dim = 1.0 - 0.85 * uBeamFace[i];
    // Its reflection: what the water mirrors here is wherever the reflected view ray passes, so this
    // glows where that ray goes through the beam (nearest approach of the ray and the beam's axis,
    // against the cone's width there). The waves' tilt breaks it into a rippled streak.
    vec3 w0 = vWorld - O;
    float b = dot(r, D);
    float dr = dot(r, w0);
    float e = dot(D, w0);
    float t = clamp((e - b * dr) / max(1.0 - b * b, 1e-4), 0.0, lh);
    float s = max(0.0, dot(O + t * D - vWorld, r));
    float miss = length(vWorld + s * r - (O + t * D));
    float rad = max(1.25 * R * t / len, 0.02);
    float fall = (1.0 - smoothstep(0.0, 1.0, t / len)) * smoothstep(0.0, 0.03 * len, t);
    float mirrored = exp(-2.0 * (miss / rad) * (miss / rad)) * fall;
    // (Brighter than true water would give, which at these angles mirrors only a few percent.)
    col += uBeamCol[i] * mirrored * (0.2 + 0.7 * fres) * dim;
    // And the patch of light where it comes down on the water, drawn out along the beam.
    vec2 q = p - H.xz;
    float pa = dot(q, uBeamDir[i]);
    float pp = dot(q, vec2(-uBeamDir[i].y, uBeamDir[i].x));
    float rH = R * lh / len;
    float stretch = min(4.0, lh / max(O.y, 0.1));
    float pool = exp(-(pp / rH) * (pp / rH) - (pa / (rH * stretch)) * (pa / (rH * stretch)));
    col += uBeamCol[i] * pool * (0.06 + 0.2 * fres + 0.18 * foam) * dim;
  }
  float far = length(vWorld.xz - cameraPosition.xz);
  col = mix(col, uHorizon, smoothstep(10.0 * uFar, 40.0 * uFar, far));
  gl_FragColor = vec4(col, 1.0 - smoothstep(30.0 * uFar, 55.0 * uFar, far));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function glowTexture(streak: boolean) {
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
export function rock(seed: number, size: number) {
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

export const rockMaterial = () => new THREE.MeshStandardMaterial({ color: 0x3a3c42, roughness: 0.95, metalness: 0, flatShading: true });
const darkMaterial = () => new THREE.MeshStandardMaterial({ color: 0x1c1e24, roughness: 0.5, metalness: 0.6 });

/**
 * A striped lighthouse (tower, gallery and rail, lantern room, roof), its base at the group's origin.
 * Returns the group, the lantern's material (to brighten) and the lamp's height.
 */
export function buildTower(col: RGB, height: number, radius: number, bands: number) {
  const group = new THREE.Group();
  const dark = darkMaterial();
  const stripe = new THREE.MeshStandardMaterial({ map: stripeTexture(col, bands), roughness: 0.7 });
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.62, radius, height, 40), stripe);
  tower.position.y = height / 2;
  group.add(tower);
  const top = height;
  const gr = radius * 0.95;
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(gr, gr * 0.85, radius * 0.22, 32), dark);
  gallery.position.y = top + radius * 0.08;
  group.add(gallery);
  const rail = new THREE.Mesh(new THREE.TorusGeometry(gr * 0.97, radius * 0.025, 6, 40), dark);
  rail.rotation.x = Math.PI / 2;
  rail.position.y = top + radius * 0.42;
  group.add(rail);
  const lantern = new THREE.MeshStandardMaterial({ color: 0x302a20, emissive: linear([255, 228, 175]), emissiveIntensity: 1.2, roughness: 0.2 });
  const lr = radius * 0.52;
  const room = new THREE.Mesh(new THREE.CylinderGeometry(lr, lr, radius * 0.9, 24), lantern);
  room.position.y = top + radius * 0.65;
  group.add(room);
  const roof = new THREE.Mesh(new THREE.SphereGeometry(lr * 1.15, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), dark);
  roof.position.y = top + radius * 1.1;
  group.add(roof);
  const finial = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.08, radius * 0.5, 8), dark);
  finial.position.y = top + radius * 1.1 + lr * 1.15 + radius * 0.2;
  group.add(finial);
  return { group, lantern, lampY: top + radius * 0.65 };
}

/** A beam: an open cone from the lamp along +x, faded along its length. */
export function buildBeam(color: RGB, length: number, radius: number) {
  const geo = new THREE.ConeGeometry(radius, length, 40, 1, true);
  geo.rotateZ(Math.PI / 2);
  geo.translate(length / 2, 0, 0);
  const mat = new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    uniforms: { uColor: { value: vec3(color) }, uIntensity: { value: 0.3 }, uLen: { value: length } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Turned by rotation.y (its plan angle), then tipped down by rotation.z.
  mesh.rotation.order = 'YZX';
  // Drawn after the sea, which (being nearer) would otherwise be sorted over it.
  mesh.renderOrder = 5;
  return { mesh, mat };
}

/** Additive glow sprites that draw over everything (light glares past what's in front of it). */
export function glowSprite(tex: THREE.Texture, color: RGB, opacity = 1) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: linear(color), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, opacity, fog: false }));
  s.renderOrder = 10;
  return s;
}

/** The night sky (stars and a soft moon), lights and fog, from the theme's colours. */
export function nightScene(theme: Theme, fogNear: number, fogFar: number, light = 1) {
  const scene = new THREE.Scene();
  const bg0 = hexToRgb(theme.bg[0]);
  const bg1 = hexToRgb(theme.bg[1]);
  const night = mixRgb(mixRgb(bg0, bg1, 0.5), [8, 14, 30], 0.5);
  const moonCol = mixRgb([215, 225, 255], lighten(hexToRgb(theme.palette[0]), 0.6), 0.15);
  scene.fog = new THREE.Fog(linear(night), fogNear, fogFar);
  scene.add(new THREE.AmbientLight(0x8090b0, 0.3 * light));
  const moon = new THREE.DirectionalLight(linear(moonCol), 0.75 * light);
  moon.position.copy(MOON_DIR).multiplyScalar(20);
  scene.add(moon);
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
  return { scene, night, moonCol, bg0, bg1 };
}

/** The sea's material and the uniform arrays the scenes fill each frame. */
export function seaMaterial(night: RGB, moonCol: RGB, horizon: RGB, deep = 0.45) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SEA_VERT,
    fragmentShader: SEA_FRAG,
    transparent: true,
    uniforms: {
      uLamps: { value: 0 },
      uBeams: { value: 0 },
      uWakes: { value: 0 },
      uLamp: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Vector3()) },
      uLampCol: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Vector3()) },
      uLampFace: { value: new Array(MAX_LAMPS).fill(0) },
      uBeamFrom: { value: Array.from({ length: MAX_BEAMS }, () => new THREE.Vector3()) },
      uBeamDir: { value: Array.from({ length: MAX_BEAMS }, () => new THREE.Vector2()) },
      uBeamCol: { value: Array.from({ length: MAX_BEAMS }, () => new THREE.Vector3()) },
      uBeamReach: { value: new Array(MAX_BEAMS).fill(1) },
      /** Each beam's cone: its radius at the far end and its length. */
      uBeamShape: { value: Array.from({ length: MAX_BEAMS }, () => new THREE.Vector2(1, 1)) },
      uBeamFace: { value: new Array(MAX_BEAMS).fill(0) },
      uWake: { value: Array.from({ length: MAX_WAKES }, () => new THREE.Vector4()) },
      uDeep: { value: vec3(shade(night, deep)) },
      uSkyLow: { value: vec3(lighten(night, 0.12)) },
      uSkyHigh: { value: vec3(shade(night, 0.7)) },
      uHorizon: { value: vec3(horizon) },
      uMoonCol: { value: vec3(moonCol) },
      uMoonDir: { value: MOON_DIR.clone() },
      uFoam: { value: vec3(mixRgb(moonCol, [150, 165, 185], 0.5)).multiplyScalar(0.22) },
      uPhase: { value: 0 },
      // Scales how far off the sea fades into the haze (for a camera pulled further back).
      uFar: { value: 1 },
    },
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), mat);
  water.rotation.x = -Math.PI / 2;
  return { mat, water };
}

export type ShipKind = 'launch' | 'sail' | 'trawler' | 'freighter';

/**
 * A small ship, bow along +x, waterline at y = 0: a pointed hull in its colour, then by kind a
 * cabin, a sail, a wheelhouse and mast, or a bridge, containers and funnel. Materials it returns are
 * its own (lit per ship).
 */
export function buildShip(kind: ShipKind, length: number, width: number, col: RGB, seed: number) {
  const group = new THREE.Group();
  const L = length;
  const W = width;
  const H = L * (kind === 'freighter' ? 0.16 : 0.2);
  const hullShape = new THREE.Shape();
  const bow = kind === 'freighter' ? W * 0.9 : W * 1.3;
  hullShape.moveTo(-L / 2, -W / 2);
  hullShape.lineTo(L / 2 - bow, -W / 2);
  hullShape.quadraticCurveTo(L / 2 - bow * 0.25, -W / 2, L / 2, 0);
  hullShape.quadraticCurveTo(L / 2 - bow * 0.25, W / 2, L / 2 - bow, W / 2);
  hullShape.lineTo(-L / 2, W / 2);
  hullShape.closePath();
  const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: H, bevelEnabled: true, bevelThickness: H * 0.12, bevelSize: W * 0.06, bevelSegments: 2, curveSegments: 8 });
  hullGeo.rotateX(-Math.PI / 2);
  hullGeo.translate(0, -H * 0.35, 0);
  const paint = new THREE.MeshStandardMaterial({ color: linear(col), roughness: 0.55, metalness: 0.1, emissive: linear(col), emissiveIntensity: 0 });
  group.add(new THREE.Mesh(hullGeo, paint));
  const deckTop = H * 0.65 + H * 0.12;
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.6, emissive: linear([255, 214, 150]), emissiveIntensity: 0.12 });
  const dark = darkMaterial();
  const box = (w: number, h: number, d: number, x: number, y: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y + h / 2, 0);
    group.add(m);
    return m;
  };
  let lightY = deckTop;
  let lightX = 0;
  switch (kind) {
    case 'launch': {
      box(L * 0.32, H * 0.9, W * 0.7, -L * 0.1, deckTop, white);
      lightY = deckTop + H * 0.9;
      lightX = -L * 0.1;
      break;
    }
    case 'sail': {
      const mastH = L * 1.05;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.025, W * 0.035, mastH, 6), dark);
      mast.position.set(L * 0.08, deckTop + mastH / 2, 0);
      group.add(mast);
      const sail = new THREE.Shape();
      sail.moveTo(0, 0);
      sail.lineTo(-L * 0.5, 0);
      sail.lineTo(0, mastH * 0.92);
      sail.closePath();
      const jib = new THREE.Shape();
      jib.moveTo(0, 0);
      jib.lineTo(L * 0.36, 0);
      jib.lineTo(0, mastH * 0.8);
      jib.closePath();
      const sailMat = new THREE.MeshStandardMaterial({ color: 0xf2eee4, roughness: 0.8, side: THREE.DoubleSide, emissive: linear([255, 230, 190]), emissiveIntensity: 0.05 });
      for (const sh of [sail, jib]) {
        const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), sailMat);
        m.position.set(L * 0.08, deckTop + mastH * 0.05, 0);
        group.add(m);
      }
      lightY = deckTop + mastH;
      lightX = L * 0.08;
      return { group, paint, white: sailMat, lightY, lightX };
    }
    case 'trawler': {
      box(L * 0.26, H * 1.2, W * 0.66, L * 0.12, deckTop, white);
      const mastH = L * 0.55;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.03, W * 0.04, mastH, 6), dark);
      mast.position.set(-L * 0.2, deckTop + mastH / 2, 0);
      group.add(mast);
      const boom = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.02, W * 0.02, L * 0.4, 5), dark);
      boom.rotation.z = Math.PI / 2 - 0.5;
      boom.position.set(-L * 0.33, deckTop + mastH * 0.55, 0);
      group.add(boom);
      lightY = deckTop + mastH;
      lightX = -L * 0.2;
      break;
    }
    case 'freighter': {
      // Bridge aft, containers forward in a few colours, a funnel.
      box(L * 0.14, H * 1.9, W * 0.86, -L * 0.36, deckTop, white);
      const funnel = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.13, W * 0.16, H * 1.1, 10), dark);
      funnel.position.set(-L * 0.44, deckTop + H * 2.1, 0);
      group.add(funnel);
      const boxes = 4;
      for (let b = 0; b < boxes; b++) {
        const tint = mixRgb(col, [[150, 60, 50], [40, 90, 140], [190, 150, 60], [70, 110, 80]][Math.floor(hash01(seed * 7 + b) * 4)] as RGB, 0.6);
        const cm = new THREE.MeshStandardMaterial({ color: linear(tint), roughness: 0.7 });
        box(L * 0.13, H * (0.9 + 0.6 * hash01(seed + b)), W * 0.8, -L * 0.2 + b * L * 0.15, deckTop, cm);
      }
      lightY = deckTop + H * 1.9;
      lightX = -L * 0.36;
      break;
    }
  }
  return { group, paint, white, lightY, lightX };
}

export interface ShipsView {
  cycles: number[];
  laps: number[];
  lanes: number[];
  beamTurns: number;
  p: { loopSeconds: number; shipSpread: number };
  colorShift: number;
  flash: number[];
}

/** Ships mode camera: high over the bay, the lighthouse a little below the middle of the frame. */
const CAM = new THREE.Vector3(0, 5.2, 6.1);
const LOOK = new THREE.Vector3(0, 1.35, -0.4);
const TOWER_H = 1.5;
const TOWER_R = 0.19;
/** How narrowly the beam lights a ship (radians). */
const LIT_WIDTH = 0.07;

const shipsView = sceneCache((s: ShipsView, theme: Theme) => {
  const n = s.laps.length;
  // Seen from above the water reflects little sky, so the scene is lit a little more.
  // A bigger circle: the camera pulls back by as much (so the circle fills the frame the same), and
  // the island, tower and ships grow a little to stay readable.
  const spread = s.p.shipSpread;
  const grow = islandScale(spread);
  const reach = outerLane(spread) + 0.8 * grow;
  const { scene, night, moonCol, bg0, bg1 } = nightScene(theme, 14 * spread, 45 * spread, 1.8);
  const camera = new THREE.PerspectiveCamera(50, 1080 / 1920, 0.1, 120);
  const sea = seaMaterial(night, moonCol, mixRgb(bg0, bg1, 0.35), 1.1);
  sea.mat.uniforms.uFar.value = spread;
  scene.add(sea.water);

  // The island: a heap of rocks with the tower and the keeper's cottage on top.
  const rockMat = rockMaterial();
  const island = new THREE.Group();
  scene.add(island);
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2 + hash01(k) * 0.4;
    const rr = 0.32 + 0.22 * hash01(k * 3.1);
    const m = new THREE.Mesh(rock(k * 13 + 1, 0.13 + 0.1 * hash01(k * 5.3)), rockMat);
    m.position.set(Math.cos(a) * rr, 0.02, -Math.sin(a) * rr);
    m.rotation.y = hash01(k * 7) * 6;
    island.add(m);
  }
  const mound = new THREE.Mesh(rock(99, 0.42), rockMat);
  mound.scale.set(1, 0.55, 1);
  mound.position.y = 0.05;
  island.add(mound);
  const red = mixRgb([178, 36, 36], hexToRgb(theme.palette[0]), 0.2);
  const tower = buildTower(red, TOWER_H, TOWER_R, 6);
  tower.group.position.y = 0.14;
  island.add(tower.group);
  island.scale.setScalar(grow);
  const lampY = (0.14 + tower.lampY) * grow;
  const cottage = new THREE.Group();
  const wall = new THREE.MeshStandardMaterial({ color: 0xd9d3c4, roughness: 0.8, emissive: linear([255, 200, 130]), emissiveIntensity: 0.05 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.26), wall);
  body.position.y = 0.1;
  cottage.add(body);
  const roofGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.46, 3, 1);
  roofGeo.rotateZ(Math.PI / 2);
  const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color: 0x5a2a24, roughness: 0.7 }));
  roof.position.y = 0.26;
  roof.scale.set(1, 0.6, 0.85);
  cottage.add(roof);
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.07), new THREE.MeshBasicMaterial({ color: linear([255, 200, 120]) }));
  pane.position.set(0.08, 0.11, 0.131);
  cottage.add(pane);
  cottage.position.set(0.27, 0.08, 0.15);
  cottage.rotation.y = -0.5;
  cottage.scale.setScalar(0.62);
  island.add(cottage);
  const lamp = new THREE.PointLight(linear([255, 225, 170]), 2.2, 3.5 * grow, 1.4);
  lamp.position.y = lampY;
  scene.add(lamp);

  const beamColor = mixRgb([255, 240, 205], hexToRgb(theme.palette[0]), 0.12);
  const beamLen = reach * 1.45;
  const beamR = 0.42 * grow;
  const beam = buildBeam(beamColor, beamLen, beamR);
  beam.mesh.position.y = lampY;
  beam.mesh.rotation.z = -Math.atan2(lampY, reach);
  scene.add(beam.mesh);
  const flareTex = glowTexture(true);
  const glowTex = glowTexture(false);
  const flare = glowSprite(flareTex, beamColor);
  flare.position.set(0, lampY, 0);
  scene.add(flare);
  const halo = glowSprite(glowTex, beamColor, 0.5);
  halo.position.set(0, lampY, 0);
  halo.scale.setScalar(0.5 * grow);
  scene.add(halo);
  const toCam = planAngle(0, 0, CAM.x, CAM.z);

  const u = sea.mat.uniforms;
  u.uLamps.value = 1;
  (u.uLamp.value as THREE.Vector3[])[0].set(0, lampY, 0);
  (u.uLampCol.value as THREE.Vector3[])[0].copy(vec3(beamColor));
  u.uBeams.value = 1;
  (u.uBeamFrom.value as THREE.Vector3[])[0].set(0, lampY, 0);
  (u.uBeamCol.value as THREE.Vector3[])[0].copy(vec3(beamColor));
  (u.uBeamReach.value as number[])[0] = reach;
  (u.uBeamShape.value as THREE.Vector2[])[0].set(beamR, beamLen);
  u.uWakes.value = n;

  // The ships: small quick boats in the inner lanes, sailing boats, trawlers, freighters outside.
  const spacing = n > 1 ? (s.lanes.reduce((a, b) => Math.max(a, b), 0) - s.lanes.reduce((a, b) => Math.min(a, b), Infinity)) / (n - 1) : 1;
  const ships = s.laps.map((laps, i) => {
    const f = (s.lanes[i] - Math.min(...s.lanes)) / Math.max(1e-6, Math.max(...s.lanes) - Math.min(...s.lanes));
    const kind: ShipKind = f < 0.25 ? 'launch' : f < 0.5 ? 'sail' : f < 0.75 ? 'trawler' : 'freighter';
    const len = (0.2 + 0.26 * f) * grow;
    const width = Math.min(len * (kind === 'freighter' ? 0.2 : 0.3), 0.8 * spacing);
    const col = paletteAt(theme.palette, ((i / Math.max(1, n - 1)) * 0.95 + s.colorShift) % 1);
    const ship = buildShip(kind, len, width, col, i);
    const holder = new THREE.Group();
    holder.rotation.order = 'YXZ';
    holder.add(ship.group);
    scene.add(holder);
    const glow = glowSprite(glowTex, lighten(col, 0.3), 0);
    glow.renderOrder = 9;
    scene.add(glow);
    // A masthead light that catches the eye even when the hull is dark.
    const mast = glowSprite(glowTex, [255, 236, 200], 0.8);
    mast.scale.setScalar(0.11 * grow);
    scene.add(mast);
    (u.uWake.value as THREE.Vector4[])[i].set(s.lanes[i], 0, laps > 0 ? 1 : 0, len);
    return { holder, ship, glow, mast, col, len, laps, lane: s.lanes[i] };
  });
  return { scene, camera, sea: sea.mat, beam, flare, lampY, toCam, tower, ships, spread, grow };
});

export function drawLighthouse(ctx: Ctx2D, theme: Theme, s: ShipsView, t: number) {
  const v = shipsView(s, theme);
  const T = s.p.loopSeconds;
  const u = t / T;
  const su = v.sea.uniforms;
  su.uPhase.value = u;
  const a = beamAngle(s.beamTurns, u);
  v.beam.mesh.rotation.y = a;
  (su.uBeamDir.value as THREE.Vector2[])[0].set(Math.cos(a), -Math.sin(a));
  // Facing the camera, the beam is seen end-on: a sharp flare instead of its volume.
  const face = Math.max(0, Math.cos(a - v.toCam)) ** 70;
  const wide = Math.max(0, Math.cos(a - v.toCam)) ** 6;
  (su.uBeamFace.value as number[])[0] = face;
  (su.uLampFace.value as number[])[0] = face;
  v.beam.mat.uniforms.uIntensity.value = 0.34 * (1 - 0.85 * wide);
  v.flare.scale.set((0.35 + 1.3 * face) * v.grow, (0.35 + 0.7 * face) * v.grow, 1);
  v.flare.material.opacity = 0.25 + 0.75 * face;
  v.tower.lantern.emissiveIntensity = 1.3 + 2 * face;
  v.ships.forEach((sh, i) => {
    const phi = shipAngle(sh.laps, u);
    const x = sh.lane * Math.cos(phi);
    const z = -sh.lane * Math.sin(phi);
    // A gentle roll and pitch (whole cycles per loop).
    const w = 2 * Math.PI * u;
    sh.holder.position.set(x, 0, z);
    sh.holder.rotation.set(0.05 * Math.sin(w * (3 + (i % 3)) + i), phi + Math.PI / 2, 0.035 * Math.sin(w * (4 + (i % 2)) + 2 * i));
    (su.uWake.value as THREE.Vector4[])[i].y = phi;
    // Lit as the beam passes over it, then glowing in its colour as it rings.
    const lit = Math.exp(-((angleDiff(a, phi) / LIT_WIDTH) ** 2));
    const fl = s.flash[i];
    sh.ship.paint.emissive.copy(linear(mixRgb(sh.col, [255, 244, 220], lit / Math.max(1e-3, lit + fl))));
    sh.ship.paint.emissiveIntensity = 1.4 * lit + 0.9 * fl;
    sh.ship.white.emissiveIntensity = 0.12 + 1.6 * lit + 0.6 * fl;
    const top = new THREE.Vector3(sh.ship.lightX, sh.ship.lightY, 0).applyEuler(sh.holder.rotation).add(sh.holder.position);
    sh.mast.position.copy(top);
    sh.glow.position.set(x, sh.len * 0.2, z);
    sh.glow.scale.setScalar(sh.len * (0.9 + 1.3 * fl + 0.5 * lit));
    sh.glow.material.opacity = Math.min(0.85, 0.75 * fl + 0.35 * lit);
  });
  // A slow drift, whole cycles per loop so the loop stays seamless.
  const w = 2 * Math.PI * u;
  v.camera.position.set(CAM.x + 0.3 * Math.sin(w), CAM.y + 0.08 * Math.sin(2 * w), CAM.z).multiplyScalar(v.spread);
  v.camera.lookAt(LOOK.clone().multiplyScalar(v.spread));
  draw3D(ctx, v.scene, v.camera);
}
