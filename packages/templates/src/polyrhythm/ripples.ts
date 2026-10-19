/**
 * Drops over still water (rendering only, plus the landing timing the sim shares): a ring of drops
 * hangs from a circular rail above a pond. Each drop swells at its tip (its size shows how close it
 * is to falling), lets go, falls, and lands with its note: a splash crown, a little rebound jet and
 * a ripple. The surface is shaded per pixel from every live ripple (a crisp leading ring with a few
 * fading rings behind), reflecting a light behind the scene so the ripples catch it the way real
 * water does.
 *
 * The landings are shifted a moment into the loop: the video opens with every drop in the air
 * together and ends as they all let go together, so it loops seamlessly. Everything is worked out
 * from the landing times (the previous loop's included), so any frame can be drawn on its own.
 */
import { hexToRgb, lighten, mixRgb, type Ctx2D, type RGB, type Theme } from '@sim/engine';
import { THREE, draw3D, environmentMap, sceneCache } from '../three-layer';

/** The drops hang in a ring this big (world units) around the middle of the pond. */
const RING_R = 1.9;
/** Height of the rail the drops hang from, and how far its tips reach down. */
const RAIL_Y = 1.05;
const TIP = 0.07;
/** Ripples tracked at once (long lifetimes keep the youngest; the oldest are faint by then). */
const MAX_DROPS = 256;
/** Drops the water shader can colour (the count slider's maximum). */
const MAX_EL = 32;
/** Splash droplets per landing (the last one rides the top of the rebound jet). */
const CROWN = 8;
const SPLASH_S = 0.45;
const JET_S = [0.07, 0.45] as const;
const G = 9.8;
/**
 * Where the light sits (direction from the water): high behind the scene, so its mirror image on
 * calm water falls below the frame and only ripples tilted toward it catch glints.
 */
const LIGHT_DIR = new THREE.Vector3(0.04, 1.9, -1).normalize();

export interface RippleView {
  notesPerLoop: number[];
  /** rippleLife: seconds a ripple spreads before it has faded away. */
  p: { loopSeconds: number; rippleLife: number };
  flash: number[];
  /** When in the loop every drop lands together. */
  syncS: number;
}

/** Where drop i (of n) lands on the water (world x, z): round the ring, the first at the back. */
export function rippleSpot(i: number, n: number): { x: number; z: number } {
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
  return { x: RING_R * Math.cos(a), z: RING_R * Math.sin(a) };
}

/** Stereo position of drop i: its left–right place on the ring. */
export const ripplePan = (i: number, n: number) => rippleSpot(i, n).x / RING_R;

/** Drop size and fall for n drops: a full drop hangs below its tip and falls from there. */
function dropGeometry(n: number) {
  const spacing = (2 * Math.PI * RING_R) / Math.max(1, n);
  const rMax = Math.min(0.075, 0.36 * spacing);
  const dropTop = RAIL_Y - TIP - 0.012;
  const fallFrom = dropTop - rMax * 1.35;
  return { rMax, dropTop, fallFrom, freeFall: Math.sqrt((2 * fallFrom) / G) };
}

/** Seconds a drop with period P takes to fall (fast drops are flicked off rather than dropped). */
const fallTime = (P: number, freeFall: number) => Math.min(freeFall, 0.6 * P);

/**
 * When in the loop the drops all land together: a little before the quickest one would have finished
 * falling, so the loop opens (and ends) with every drop in the air.
 */
export function rippleSyncS(notesPerLoop: number[], loopSeconds: number): number {
  const { freeFall } = dropGeometry(notesPerLoop.length);
  return 0.8 * Math.min(...notesPerLoop.map((m) => fallTime(loopSeconds / m, freeFall)));
}

/** A palette colour as linear RGB (what shaders and materials work in). */
const linear = (c: RGB) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
const vec3 = (c: RGB) => {
  const l = linear(c);
  return new THREE.Vector3(l.r, l.g, l.b);
};
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

const WATER_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const WATER_FRAG = /* glsl */ `
#define MAX_DROPS ${MAX_DROPS}
#define MAX_EL ${MAX_EL}
uniform vec4 uDrops[MAX_DROPS]; // x, z, age (s), element
uniform int uCount;
uniform vec3 uColors[MAX_EL];
uniform vec3 uFalling[MAX_EL]; // x, z, how close the next drop is (0..1)
uniform int uLanes;
uniform vec3 uDeep;
uniform vec3 uSkyLow;
uniform vec3 uSkyHigh;
uniform vec3 uHorizon;
uniform vec3 uLightCol;
uniform vec3 uLightDir;
uniform float uPhase; // 0..1 over the loop
uniform float uLife;  // seconds a ripple lasts
varying vec3 vWorld;

const float SPEED = 0.55;
const float AMP = 0.011;
const float K0 = 50.0;   // wavenumber of fresh ripples (wavelength ~0.13)

// One ripple's height at distance r, age a: a crisp leading ring with a few rings behind it that
// die away quickly, widening and fading as it travels.
float wave(float r, float a) {
  float x = r - SPEED * a;
  float sig = 0.03 + 0.03 * a;
  float trail = 0.03 + 0.03 * a;
  float env = exp(-x * x / (2.0 * sig * sig)) / (1.0 + exp(-x / trail - 1.0));
  // Fades over its lifetime, the last stretch eased to nothing so it never pops out.
  float fade = exp(-a * 2.4 / uLife) * smoothstep(uLife, 0.7 * uLife, a);
  return AMP * env * fade * inversesqrt(1.0 + 5.0 * r) * cos(K0 / (1.0 + 0.3 * a) * x);
}

void main() {
  vec2 p = vWorld.xz;
  vec2 grad = vec2(0.0);
  vec3 glow = vec3(0.0);

  // A faint slow swell so the surface isn't glassy-flat: whole cycles per loop.
  const float TAU = 6.2831853;
  vec2 d1 = normalize(vec2(0.8, 0.6)), d2 = normalize(vec2(-0.5, 0.85)), d3 = normalize(vec2(0.1, -1.0));
  grad += 0.006 * d1 * cos(dot(d1, p) * 3.7 - TAU * 3.0 * uPhase);
  grad += 0.005 * d2 * cos(dot(d2, p) * 5.9 - TAU * 4.0 * uPhase);
  grad += 0.0035 * d3 * cos(dot(d3, p) * 9.1 + TAU * 5.0 * uPhase);

  for (int i = 0; i < MAX_DROPS; i++) {
    if (i >= uCount) break;
    vec4 d = uDrops[i];
    vec2 dp = p - d.xy;
    float r = length(dp) + 1e-4;
    float a = d.z;
    vec3 col = uColors[int(d.w)];
    // Impact: a small crater that fills back in, and a flash of the drop's colour.
    if (a < 0.4 && r < 0.3) {
      float cr = 0.09 + 0.12 * a;
      float b = 0.05 * exp(-a / 0.12);
      grad += b * (2.0 * r / (cr * cr)) * exp(-r * r / (cr * cr)) * dp / r;
      glow += col * 1.4 * exp(-r * r / 0.006) * exp(-a / 0.13);
    }
    float x = r - SPEED * a;
    float reach = 0.03 + 0.03 * a;
    if (x > 4.0 * reach || x < -6.0 * reach) continue;
    const float E = 0.003;
    float h = wave(r, a);
    grad += (wave(r + E, a) - wave(max(r - E, 0.0), a)) / (2.0 * E) * dp / r;
    // The crests carry the drop's colour.
    glow += col * max(0.0, h) * 55.0;
  }

  // Anticipation: the next drop's colour gathers on the water under it as it falls.
  for (int i = 0; i < MAX_EL; i++) {
    if (i >= uLanes) break;
    vec3 f = uFalling[i];
    if (f.z <= 0.0) continue;
    vec2 dp = p - f.xy;
    glow += uColors[i] * 0.3 * f.z * f.z * exp(-dot(dp, dp) / 0.01);
  }

  vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 refl = reflect(-v, n);
  float up = max(refl.y, 0.0);
  vec3 sky = mix(uSkyLow, uSkyHigh, pow(up, 0.45));
  float sl = max(dot(refl, uLightDir), 0.0);
  // Sharp glints where ripples tilt toward the light, over a faint sheen.
  vec3 spec = uLightCol * (pow(sl, 1600.0) * 5.0 + pow(sl, 400.0) * 0.04 + pow(sl, 40.0) * 0.003);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 col = mix(uDeep, sky, fres) + spec * (0.35 + fres) + glow;

  // Fade into the background at the horizon.
  float dist = length(vWorld.xz - cameraPosition.xz);
  col = mix(col, uHorizon, smoothstep(12.0, 38.0, dist));
  gl_FragColor = vec4(col, 1.0 - smoothstep(26.0, 46.0, dist));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const view = sceneCache((s: RippleView, theme: Theme) => {
  const n = s.notesPerLoop.length;
  const scene = new THREE.Scene();
  scene.environment = environmentMap();
  scene.environmentIntensity = 0.8;
  const camera = new THREE.PerspectiveCamera(58, 1080 / 1920, 0.05, 200);

  const bg0 = hexToRgb(theme.bg[0]);
  const bg1 = hexToRgb(theme.bg[1]);
  const bgMid = mixRgb(bg0, bg1, 0.5);
  const tint = hexToRgb(theme.palette[Math.floor(theme.palette.length / 2)]);
  const lightCol = mixRgb([255, 244, 225], lighten(tint, 0.5), 0.25);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const sun = new THREE.DirectionalLight(linear(lightCol), 2.4);
  sun.position.copy(LIGHT_DIR).multiplyScalar(10);
  scene.add(sun);
  // A soft light from the camera's side so the rail and drops read against the dark.
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(1, 3, 6);
  scene.add(fill);

  const colors = Array.from({ length: MAX_EL }, () => new THREE.Vector3());
  const water = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: true,
    uniforms: {
      uDrops: { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector4()) },
      uCount: { value: 0 },
      uColors: { value: colors },
      uFalling: { value: Array.from({ length: MAX_EL }, () => new THREE.Vector3()) },
      uLanes: { value: n },
      uDeep: { value: vec3(mixRgb(shade(bgMid, 0.55), shade(tint, 0.25), 0.25)) },
      uSkyLow: { value: vec3(mixRgb(lighten(bgMid, 0.07), tint, 0.1)) },
      uSkyHigh: { value: vec3(shade(bg0, 0.8)) },
      uHorizon: { value: vec3(mixRgb(bg0, bg1, 0.2)) },
      uLightCol: { value: vec3(lightCol) },
      uLightDir: { value: LIGHT_DIR.clone() },
      uPhase: { value: 0 },
      uLife: { value: 2.8 },
    },
  });
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), water);
  surface.rotation.x = -Math.PI / 2;
  scene.add(surface);

  // The rail: a polished hoop on four posts standing in the water (each halfway between two drops),
  // a drip tip over each drop's spot.
  const metal = new THREE.MeshStandardMaterial({ color: 0x4c515c, metalness: 0.85, roughness: 0.42, envMapIntensity: 0.5 });
  const rail = new THREE.Mesh(new THREE.TorusGeometry(RING_R, 0.022, 12, 200), metal);
  rail.rotation.x = Math.PI / 2;
  rail.position.y = RAIL_Y;
  scene.add(rail);
  for (let k = 0; k < 4; k++) {
    const between = Math.round((((Math.PI / 4 + (k * Math.PI) / 2) / (2 * Math.PI)) * n) - 0.5) + 0.5;
    const a = -Math.PI / 2 + (2 * Math.PI * between) / n;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, RAIL_Y + 0.4, 16), metal);
    post.position.set(RING_R * Math.cos(a), (RAIL_Y - 0.4) / 2, RING_R * Math.sin(a));
    scene.add(post);
  }
  const tipGeo = new THREE.ConeGeometry(0.02, TIP, 16);
  tipGeo.rotateX(Math.PI); // point down
  const tips = Array.from({ length: n }, (_, i) => {
    const mat = new THREE.MeshStandardMaterial({ color: 0x4c515c, metalness: 0.85, roughness: 0.4, envMapIntensity: 0.5, emissiveIntensity: 0 });
    const tip = new THREE.Mesh(tipGeo, mat);
    const { x, z } = rippleSpot(i, n);
    tip.position.set(x, RAIL_Y - TIP / 2 - 0.012, z);
    scene.add(tip);
    return mat;
  });

  // Two glassy drops per spot: the one swelling on the tip and the one falling.
  const dropGeo = new THREE.SphereGeometry(1, 32, 20);
  const dropMat = () => new THREE.MeshStandardMaterial({ roughness: 0.04, metalness: 0.1, transparent: true, envMapIntensity: 1.6 });
  const drops = Array.from({ length: n }, () => {
    const hang = new THREE.Mesh(dropGeo, dropMat());
    const fall = new THREE.Mesh(dropGeo, dropMat());
    hang.visible = fall.visible = false;
    scene.add(hang, fall);
    return { hang, fall };
  });
  const bitMat = new THREE.MeshStandardMaterial({ roughness: 0.05, metalness: 0.1, envMapIntensity: 1.6 });
  const crown = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), bitMat, n * 3 * CROWN);
  const jets = new THREE.InstancedMesh(new THREE.CapsuleGeometry(1, 1, 6, 12), bitMat, n * 3);
  crown.frustumCulled = false;
  jets.frustumCulled = false;
  scene.add(crown, jets);
  return { scene, camera, water, colors, tips, drops, crown, jets };
});

const tmp = new THREE.Object3D();
const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

function tintDrop(mesh: THREE.Mesh, col: RGB, glow: number, opacity: number) {
  const mat = mesh.material as THREE.MeshStandardMaterial;
  mat.color.copy(linear(lighten(col, 0.15)));
  mat.emissive.copy(linear(col)).multiplyScalar(glow);
  mat.opacity = opacity;
}

export function drawRipples(ctx: Ctx2D, theme: Theme, s: RippleView, t: number, color: (i: number) => RGB) {
  const v = view(s, theme);
  const n = s.notesPerLoop.length;
  const T = s.p.loopSeconds;
  const u = v.water.uniforms;
  u.uPhase.value = t / T;
  const life = s.p.rippleLife;
  u.uLife.value = life;
  const { rMax, dropTop, fallFrom, freeFall } = dropGeometry(n);
  // Whole wobbles per loop, so the loop stays seamless.
  const wobbleHz = Math.round(7 * T) / T;

  const live: { x: number; z: number; age: number; i: number }[] = [];
  for (let i = 0; i < n; i++) {
    const { x, z } = rippleSpot(i, n);
    const m = s.notesPerLoop[i];
    const P = T / m;
    // Landing j is at syncS + j·P (any j: the pattern repeats every loop).
    const landing = (j: number) => s.syncS + j * P;
    const fall = fallTime(P, freeFall);
    const col = color(i);
    v.colors[i].copy(vec3(lighten(col, 0.15)));

    // Ripples from landings still spreading (the last loop's too).
    for (let j = Math.ceil((t - life - s.syncS) / P - 1e-9); landing(j) <= t + 1e-9; j++) live.push({ x, z, age: t - landing(j), i });

    // The swelling drop: the one that falls next, growing from a bead to full size by its release,
    // with a wobble as it gets heavy. Its size is the drop's timer.
    const { hang, fall: falling } = v.drops[i];
    const jh = Math.floor((t + fall - s.syncS) / P + 1e-9) + 1;
    {
      const release = landing(jh) - fall;
      const start = landing(jh - 1) - fall;
      const g = Math.max(0, Math.min(1, (t - start) / (release - start)));
      const r = rMax * (0.22 + 0.78 * g);
      const wobble = g > 0.8 ? 0.06 * ((g - 0.8) / 0.2) * Math.sin(2 * Math.PI * wobbleHz * t) : 0;
      const stretch = 1 + 0.35 * g * g + wobble;
      hang.visible = true;
      hang.scale.set(r * (1 - wobble * 0.5), r * stretch, r * (1 - wobble * 0.5));
      hang.position.set(x, dropTop - r * stretch, z);
      tintDrop(hang, col, 0.35 + 0.35 * g, 0.95);
    }
    v.tips[i].emissive.copy(linear(col));
    v.tips[i].emissiveIntensity = 0.25 + 1.2 * s.flash[i];

    // The falling drop: from release to landing, accelerating.
    const jn = Math.ceil((t - s.syncS) / P - 1e-9);
    const left = landing(jn) - t;
    falling.visible = left <= fall;
    const near = falling.visible ? 1 - left / fall : 0;
    (u.uFalling.value as THREE.Vector3[])[i].set(x, z, near);
    if (falling.visible) {
      const a = (2 * (fallFrom - rMax)) / (fall * fall);
      const speed = a * (fall - left);
      falling.position.set(x, rMax + 0.5 * a * left * left, z);
      // Stretched a little along the fall as it speeds up.
      falling.scale.set(rMax * 0.92, rMax * (1.15 + 0.02 * speed), rMax * 0.92);
      tintDrop(falling, col, 0.6, 1);
    }
  }
  live.sort((a, b) => a.age - b.age);
  const count = Math.min(MAX_DROPS, live.length);
  for (let k = 0; k < count; k++) (u.uDrops.value as THREE.Vector4[])[k].set(live[k].x, live[k].z, live[k].age, live[k].i);
  u.uCount.value = count;

  // Splash crowns and rebound jets from recent landings.
  let ci = 0;
  let ji = 0;
  for (const drop of live) {
    if (drop.age > JET_S[1]) continue;
    const col = linear(lighten(color(drop.i), 0.3));
    if (drop.age < SPLASH_S && ci + CROWN <= v.crown.count) {
      for (let k = 0; k < CROWN - 1; k++) {
        // Droplets thrown out and up in a ring, falling back under gravity.
        const ang = (2 * Math.PI * k) / (CROWN - 1) + drop.i * 0.7;
        const out = 0.3 * drop.age * (0.8 + 0.4 * ((k * 0.618) % 1));
        const vy = 1.2 + 0.4 * ((k * 0.371) % 1);
        const y = vy * drop.age - 0.5 * G * drop.age * drop.age;
        if (y < 0) {
          v.crown.setMatrixAt(ci++, hidden);
          continue;
        }
        tmp.position.set(drop.x + Math.cos(ang) * (0.05 + out), y, drop.z + Math.sin(ang) * (0.05 + out));
        tmp.scale.setScalar(0.013 * (1 - (0.4 * drop.age) / SPLASH_S));
        tmp.updateMatrix();
        v.crown.setColorAt(ci, col);
        v.crown.setMatrixAt(ci++, tmp.matrix);
      }
    }
    if (drop.age > JET_S[0] && ji < v.jets.count) {
      // The rebound (Worthington) jet: a column that rises from the crater and sinks back.
      const f = (drop.age - JET_S[0]) / (JET_S[1] - JET_S[0]);
      const h = 0.26 * Math.sin(Math.PI * f);
      const w = 0.02 * (1 - 0.3 * f);
      tmp.position.set(drop.x, h / 2, drop.z);
      // The capsule is 3 units tall (a unit of body between unit-radius caps).
      tmp.scale.set(w, Math.max(0.001, h / 3), w);
      tmp.updateMatrix();
      v.jets.setColorAt(ji, col);
      v.jets.setMatrixAt(ji++, tmp.matrix);
      // A droplet pinches off the top and rides a little higher before falling back.
      if (ci < v.crown.count) {
        tmp.position.set(drop.x, h + 0.035 * Math.sin(Math.PI * Math.min(1, f * 1.2)), drop.z);
        tmp.scale.setScalar(0.022);
        tmp.updateMatrix();
        v.crown.setColorAt(ci, col);
        v.crown.setMatrixAt(ci++, tmp.matrix);
      }
    }
  }
  for (let k = ci; k < v.crown.count; k++) v.crown.setMatrixAt(k, hidden);
  for (let k = ji; k < v.jets.count; k++) v.jets.setMatrixAt(k, hidden);
  v.crown.instanceMatrix.needsUpdate = true;
  v.jets.instanceMatrix.needsUpdate = true;
  if (v.crown.instanceColor) v.crown.instanceColor.needsUpdate = true;
  if (v.jets.instanceColor) v.jets.instanceColor.needsUpdate = true;

  // Looking down across the pond into the ring.
  const pitch = 0.42;
  const dist = 7.3;
  v.camera.position.set(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist);
  v.camera.lookAt(0, 0.45, -0.4);
  draw3D(ctx, v.scene, v.camera);
}
