/**
 * Window glass: rain on the panes (or frost, in snow), lit by the fire and the lightning, with a
 * faint reflection of the room. Drawn over the view outside.
 *
 * Drops live in a grid in metres on the pane. Sitting drops each appear and fade on their own
 * period; running drops slide down their column, a whole number of times per loop, trailing
 * droplets. All of it repeats exactly over the loop.
 */
import { THREE } from '../three-layer';
import { BASIC_VERT, HASH, NOISE4 } from '../ambient/glsl';
import { BACK, WINDOWS } from './layout';

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
uniform float uFire;
uniform float uSide;    // -1 left window, +1 right (the fire is towards -uSide)
uniform float uSnow;

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
  vec2 m = vUv * uSize; // metres on the pane
  float cover = 0.0, glint = 0.0, rim = 0.0;
  // Light comes from the fire's side, a little from below.
  vec2 fireDir = normalize(vec2(-uSide, -0.35));

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
    // Running drops: one per 3 cm column, sliding down a whole number of pane heights per loop.
    float colW = 0.05;
    float cx = floor(m.x / colW);
    float hc = hash12(vec2(cx, 41.0));
    if (hc < 0.05 + 0.2 * uRain) {
      float speed = 0.04 + 0.08 * hash12(vec2(cx, 7.0)); // pane heights per second
      float cyc = max(1.0, floor(speed * uLoop + 0.5));
      float y = 1.0 - fract(hash12(vec2(cx, 3.0)) + cyc * uPhase);   // 1 = top, falling
      float wob = 0.25 * sin(m.y * 40.0 + hc * 20.0) * colW;
      vec2 at = vec2((cx + 0.5) * colW + wob, y * uSize.y);
      vec2 d = (m - at) / 0.035;
      drop(d * vec2(1.0, 0.85), 0.42, fireDir, cover, glint, rim);
      // Its trail: droplets left behind above it, thinning out.
      float above = m.y - at.y;
      if (above > 0.0 && above < 0.25) {
        vec2 tc = vec2((m.x - at.x) / 0.011, m.y / 0.018);
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

  vec3 warm = vec3(1.0, 0.55, 0.25) * (0.35 + 0.65 * uFire);
  vec3 cold = vec3(0.7, 0.78, 1.0);
  // Drops are mostly clear: a dim rim, and a small highlight on the side facing the fire.
  vec3 col = warm * glint * 0.45 + cold * uFlash * (cover * 0.12 + glint * 0.6) + vec3(0.012, 0.013, 0.018) * cover;
  float alpha = cover * 0.18 + rim * 0.3 + glint * 0.5;
  // The room faintly reflected in the dark glass: warm, strongest on the side nearest the fire.
  float towardFire = uSide > 0.0 ? 1.0 - vUv.x : vUv.x;
  vec3 refl = vec3(0.09, 0.045, 0.02) * (0.3 + 0.7 * towardFire) * (0.5 + 0.5 * (1.0 - vUv.y)) * (0.5 + 0.5 * uFire);
  gl_FragColor = vec4(col + refl, max(alpha, 0.1));
}
`;

export interface Glass {
  group: THREE.Group;
  update(o: { t: number; L: number; rain: number; flash: number; fire: number; snow: boolean }): void;
}

export function buildGlass(): Glass {
  const group = new THREE.Group();
  const mats: THREE.ShaderMaterial[] = [];
  for (const w of WINDOWS) {
    const width = w.x1 - w.x0;
    const height = w.y1 - w.y0;
    const side = (w.x0 + w.x1) / 2 < 0 ? -1 : 1;
    const mat = new THREE.ShaderMaterial({
      vertexShader: BASIC_VERT,
      fragmentShader: GLASS_FRAG,
      uniforms: {
        uSize: { value: new THREE.Vector2(width, height) },
        uPhase: { value: 0 },
        uLoop: { value: 1 },
        uRain: { value: 0.6 },
        uFlash: { value: 0 },
        uFire: { value: 1 },
        uSide: { value: side },
        uSnow: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
    });
    // Just outside the mullions, so drops sit on the glass behind the frame.
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
    pane.position.set((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2, BACK - 0.06);
    pane.renderOrder = 3;
    group.add(pane);
    mats.push(mat);
  }
  return {
    group,
    update({ t, L, rain, flash, fire, snow }) {
      for (const m of mats) {
        const u = m.uniforms;
        u.uPhase.value = t / L;
        u.uLoop.value = L;
        u.uRain.value = rain;
        u.uFlash.value = flash;
        u.uFire.value = fire;
        u.uSnow.value = snow ? 1 : 0;
      }
    },
  };
}
