/**
 * Window glass for the long-form scenes: rain on the panes (or frost, in snow), lit by a light in the
 * room and by flashes outside, with a faint reflection of the room. Drawn over the view outside.
 *
 * Drops live in a grid in metres on the pane. Sitting drops each appear and fade on their own
 * period; running drops slide along their column (down, or swept back on a moving train), a whole
 * number of times per loop, trailing droplets. All of it repeats exactly over the loop.
 */
import { THREE } from '../three-layer';
import { BASIC_VERT, HASH, NOISE4 } from './glsl';

const GLASS_FRAG = /* glsl */ `
${HASH}
${NOISE4}
varying vec2 vUv;
varying vec3 vWorld;
uniform vec2 uSize;     // pane size in metres
uniform float uPhase;   // t / loopS
uniform float uLoop;
uniform float uRain;    // 0..1 how wet
uniform float uFlash;
uniform float uLight;      // 0..1 how bright the room's light is
uniform vec2 uLightDir;    // on the pane, the direction drops are lit from (normalised here)
uniform float uReflectSide; // the room's reflection is strongest towards -x (1), +x (-1), or even (0)
uniform vec3 uLightColor;
uniform vec3 uFlashColor;
uniform vec3 uReflect;
uniform float uSnow;
uniform vec2 uFlow;        // unit direction running drops travel, on the pane
uniform vec2 uRunRange;    // extent of the pane along the flow (min, max of -dot(m, uFlow))
uniform float uRunSpeed;
uniform float uDropScale; // drop size (1: seen from across a room; smaller close up)

// A drop's shading: its rim darkens, its far edge catches light (it's a tiny lens).
void drop(vec2 d, float r, vec2 lightDir, inout float cover, inout float glint, inout float rim) {
  float l = length(d);
  if (l > r) return;
  vec2 n = d / r;
  float h = sqrt(max(0.0, 1.0 - dot(n, n)));
  float edge = smoothstep(r, r * 0.82, l);
  cover = max(cover, edge);
  glint = max(glint, edge * pow(max(0.0, dot(n, lightDir)), 6.0) * (1.0 - h * 0.5));
  rim = max(rim, edge * smoothstep(0.55, 0.95, l / r));
}

void main() {
  vec2 m = vUv * uSize / uDropScale; // metres on the pane (in drop-size units)
  float cover = 0.0, glint = 0.0, rim = 0.0;
  vec2 fireDir = normalize(uLightDir);

  if (uSnow < 0.5) {
    // Sitting drops: a 5 cm grid (larger than life: from across the room real drops vanish), only
    // some cells wet at any time, in a range of sizes.
    vec2 cell = m / 0.05;
    vec2 id = floor(cell);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 c = id + vec2(float(i), float(j));
      float h1 = hash12(c);
      float h2 = hash12(c + 17.3);
      float period = 25.0 + 50.0 * h2;
      float cyc = max(1.0, floor(uLoop / period + 0.5));
      float life = fract(h1 * 7.0 + cyc * uPhase);
      float alive = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.75, 1.0, life));
      if (h2 > 0.05 + 0.2 * uRain || alive <= 0.0) continue;
      vec2 ctr = c + 0.5 + (vec2(hash12(c + 3.1), hash12(c + 5.7)) - 0.5) * 0.7;
      float r = (0.16 + 0.3 * pow(hash12(c + 9.2), 2.0)) * alive;
      drop(cell - ctr, r, fireDir, cover, glint, rim);
    }
    // Running drops: one per 5 cm column, sliding along the flow a whole number of times per loop.
    // Worked out in a frame turned so the flow runs towards -y (for falling drops it is the pane's).
    vec2 r = vec2(dot(m, vec2(-uFlow.y, uFlow.x)), -dot(m, uFlow));
    float colW = 0.05;
    float cx = floor(r.x / colW);
    float hc = hash12(vec2(cx, 41.0));
    if (hc < 0.05 + 0.2 * uRain) {
      float speed = (0.04 + 0.08 * hash12(vec2(cx, 7.0))) * uRunSpeed; // pane lengths per second
      float cyc = max(1.0, floor(speed * uLoop + 0.5));
      float y = 1.0 - fract(hash12(vec2(cx, 3.0)) + cyc * uPhase);   // 1 = start, running
      float wob = 0.25 * sin(r.y * 40.0 + hc * 20.0) * colW;
      vec2 at = vec2((cx + 0.5) * colW + wob, uRunRange.x + y * (uRunRange.y - uRunRange.x));
      vec2 d = (r - at) / 0.035;
      drop(d * vec2(1.0, 0.85), 0.42, fireDir, cover, glint, rim);
      // Its trail: droplets left behind it, thinning out.
      float above = r.y - at.y;
      if (above > 0.0 && above < 0.25) {
        vec2 tc = vec2((r.x - at.x) / 0.011, r.y / 0.018);
        vec2 tid = floor(tc);
        if (abs(tid.x) < 1.0 && hash12(tid + cx) < 0.7 * (1.0 - above / 0.25)) {
          vec2 tctr = tid + 0.5 + vec2(0.0, hash12(tid + 1.3) - 0.5);
          drop((tc - tctr) * vec2(1.0, 0.6), 0.32, fireDir, cover, glint, rim);
        }
      }
    }
  } else {
    // Frost creeping in from the pane's edges.
    vec2 e = min(vUv, 1.0 - vUv) * uSize;
    float edgeDist = min(e.x, e.y);
    float n = snoise(vec4(m * 18.0, 3.0, 1.0)) * 0.5 + 0.5;
    cover = smoothstep(0.12, 0.0, edgeDist - n * 0.06) * 0.6;
    glint = cover * n * 0.2;
  }

  vec3 warm = uLightColor * (0.35 + 0.65 * uLight);
  vec3 cold = uFlashColor;
  // Drops are mostly clear: a dim rim, and a small highlight on the side facing the light.
  vec3 col = warm * glint * 0.45 + cold * uFlash * (cover * 0.12 + glint * 0.6) + vec3(0.012, 0.013, 0.018) * cover;
  float alpha = cover * 0.18 + rim * 0.3 + glint * 0.5;
  // The room faintly reflected in the dark glass, strongest on the side nearest its light.
  float towardFire = uReflectSide > 0.0 ? 1.0 - vUv.x : uReflectSide < 0.0 ? vUv.x : 0.5;
  vec3 refl = uReflect * (0.3 + 0.7 * towardFire) * (0.5 + 0.5 * (1.0 - vUv.y)) * (0.5 + 0.5 * uLight);
  gl_FragColor = vec4(col + refl, max(alpha, 0.1));
}
`;

export interface Pane {
  /** Centre of the pane (world), and its size in metres. The pane faces +z. */
  center: [number, number, number];
  width: number;
  height: number;
  /** Direction on the pane the drops are lit from (normalised in the shader). */
  lightDir: [number, number];
  /** Where the room's reflection is strongest: 1 towards -x, -1 towards +x, 0 even. */
  reflectSide: number;
}

export interface RainGlassOptions {
  panes: Pane[];
  /** The room light's colour on the drops, the flash colour, and the room's reflection. */
  lightColor?: [number, number, number];
  flashColor?: [number, number, number];
  reflect?: [number, number, number];
  /** Direction running drops travel on the pane (default straight down). */
  flow?: [number, number];
  /** How fast running drops travel (1: gravity on a window). */
  runSpeed?: number;
  /** Drop size (1: right for a window across a room; smaller for one close by). */
  dropScale?: number;
}

export interface Glass {
  group: THREE.Group;
  update(o: { t: number; L: number; rain: number; flash: number; light: number; snow: boolean }): void;
}

export function buildRainGlass(opts: RainGlassOptions): Glass {
  const group = new THREE.Group();
  const mats: THREE.ShaderMaterial[] = [];
  const [fx, fy] = opts.flow ?? [0, -1];
  const ds = opts.dropScale ?? 1;
  for (const w of opts.panes) {
    const { width, height } = w;
    // The pane's extent along the flow, from its corners (in pane metres, origin bottom-left).
    const along = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ].map(([x, y]) => -(x * fx + y * fy) / ds);
    const mat = new THREE.ShaderMaterial({
      vertexShader: BASIC_VERT,
      fragmentShader: GLASS_FRAG,
      uniforms: {
        uSize: { value: new THREE.Vector2(width, height) },
        uPhase: { value: 0 },
        uLoop: { value: 1 },
        uRain: { value: 0.6 },
        uFlash: { value: 0 },
        uLight: { value: 1 },
        uLightDir: { value: new THREE.Vector2(...w.lightDir) },
        uReflectSide: { value: w.reflectSide },
        uLightColor: { value: new THREE.Vector3(...(opts.lightColor ?? [1.0, 0.55, 0.25])) },
        uFlashColor: { value: new THREE.Vector3(...(opts.flashColor ?? [0.7, 0.78, 1.0])) },
        uReflect: { value: new THREE.Vector3(...(opts.reflect ?? [0.09, 0.045, 0.02])) },
        uSnow: { value: 0 },
        uFlow: { value: new THREE.Vector2(fx, fy) },
        uRunRange: { value: new THREE.Vector2(Math.min(...along), Math.max(...along)) },
        uRunSpeed: { value: opts.runSpeed ?? 1 },
        uDropScale: { value: ds },
      },
      transparent: true,
      depthWrite: false,
    });
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
    pane.position.set(...w.center);
    pane.renderOrder = 3;
    group.add(pane);
    mats.push(mat);
  }
  return {
    group,
    update({ t, L, rain, flash, light, snow }) {
      for (const m of mats) {
        const u = m.uniforms;
        u.uPhase.value = t / L;
        u.uLoop.value = L;
        u.uRain.value = rain;
        u.uFlash.value = flash;
        u.uLight.value = light;
        u.uSnow.value = snow ? 1 : 0;
      }
    },
  };
}
