/**
 * The land outside the window: one grid that stays with the train, rows from the lineside out to the
 * far ridges (closer together near the line), each row wider the farther out it is. The GPU lifts it
 * to the land's height (world.ts) at each vertex's ring position, and each row's vertices snap to the
 * ground's own grid as it slides past, so hills don't crawl through the mesh.
 *
 * Painterly shading: patchwork fields with hedgerows (cells that divide the ring), meadows sprinkled
 * with flowers, woods darker beneath their trees, the ballast and the other line by the track, long
 * hill shadows when the sun is low, the haze; near the line the ground is blurred along the track by
 * the train's speed. Water lies wherever the land dips below it (rivers under the bridges).
 */
import { THREE } from '../three-layer';
import { MAX_FAR, WORLD, type WorldUniforms } from './world';
import { BANDS, STATE_READ } from './plants';

const ROWS = 230;
const COLS = 360;
/** Rows from this far out (m)... */
const D0 = 2.5;
/** ...growing by this factor each row (to about 4.5 km). */
const GROW = 1.0335;
/** Water level (world y). */
export const WATER_Y = -1.25 - 0.9 - 12;

const TERRAIN_VERT = /* glsl */ `
${WORLD}
attribute vec2 aGrid;      // u across the row (-1..1), row distance out (m)
uniform float uHalfW0;     // a row's half width = uHalfW0 + d * uHalfWk
uniform float uHalfWk;
uniform float uCols;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vPD;          // ring position, distance out
varying float vShadow;

void main() {
  float d = aGrid.y;
  float halfW = uHalfW0 + d * uHalfWk;
  float sp = 2.0 * halfW / (uCols - 1.0);
  // Snap to the ground's grid: the vertex stays on the same patch of ground as it slides past.
  float x0 = aGrid.x * halfW;
  // (Columns sit half a step between the ground's grid points, so floor() never wavers on a rounding
  // error: frame 0 and frame L snap alike.)
  float p = floor(ringAt(x0) / sp) * sp;
  float x = worldX(p);
  float y = landY(p, d);
  // The slope, for the light (a step a little wider than the grid, so far hills stay smooth).
  float e = max(1.5, sp * 0.8);
  float hx = landY(p + e, d) - landY(p - e, d);
  float hd = landY(p, d + e) - landY(p, d - e);
  // dy/dx = uDir · dy/dp; dy/dz = -dy/dd.
  vNormal = normalize(vec3(-uDir * hx, 2.0 * e, hd));
  // Hill shadow: march towards the sun over the land (only matters when it's low).
  float sh = 1.0;
  vec2 sxz = normalize(uSunDir.xz + 1e-5);
  float rise = uSunDir.y / max(length(uSunDir.xz), 1e-3);
  if (rise < 1.2 && d > 20.0) {
    float stride = 35.0;
    float dist = 0.0;
    for (int i = 0; i < 6; i++) {
      dist += stride;
      stride *= 1.6;
      float px = x + sxz.x * dist;
      float pz = (TRACK_Z - d) + sxz.y * dist;
      float pd = outAt(pz);
      if (pd < 5.0) break;
      float hy = landY(ringAt(px), pd);
      sh = min(sh, smoothstep(-6.0, 6.0, (y + dist * rise) - hy));
    }
  }
  vShadow = sh;
  vPD = vec2(p, d);
  vec4 w = modelMatrix * vec4(x, y, TRACK_Z - d, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const TERRAIN_FRAG = /* glsl */ `
${WORLD}
${STATE_READ}
uniform vec4 uBand;      // the nearest band of trees: window, cell, first row's distance out, columns
uniform vec2 uBandRows;  // rows, -
uniform sampler2D uTrees; // its trees this frame (plants.ts)
uniform float uTreesH;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vPD;
varying float vShadow;

// A field's colour: mostly pasture in greens; hay and wheat; the odd ploughed field; now and then lavender.
vec3 fieldColour(float p, float d, out float hedge) {
  float h = fieldAt(p, d, hedge);
  float h2 = fract(h * 13.7);
  vec3 col = mix(vec3(0.07, 0.19, 0.03), vec3(0.15, 0.29, 0.04), h2);
  if (h > 0.74) col = mix(vec3(0.42, 0.36, 0.12), vec3(0.52, 0.44, 0.16), h2);
  if (h > 0.91) col = vec3(0.26, 0.18, 0.1);
  if (h > 0.993 && d > 200.0) col = vec3(0.27, 0.23, 0.37);
  return col;
}

// The shadows of the nearest band's trees here: each canopy's shadow lies away from the sun, by its
// height over the sun's elevation, stretched the lower the sun is.
float treeShade(float p, float d) {
  float horiz = length(uSunDir.xz);
  if (uRain > 0.5 || horiz < 1e-3) return 1.0;
  float cotE = horiz / max(uSunDir.y, 0.05);
  vec2 toSun = vec2(uDir * uSunDir.x, -uSunDir.z) / horiz;
  vec2 across = vec2(-toSun.y, toSun.x);
  float W = uBand.x;
  float cell = uBand.y;
  float d0 = uBand.z;
  float cols = uBand.w;
  vec2 q = vec2(p, d) + toSun * 7.5 * cotE;
  if (q.y < d0 - cell || q.y > d0 + (uBandRows.x + 1.0) * cell) return 1.0;
  // The 2 x 2 slots nearest the estimate.
  float c0 = floor(mod(q.x, W) / cell - 0.5);
  float r0 = floor((q.y - d0) / cell - 0.5);
  float shade = 0.0;
  for (int i = 0; i <= 1; i++)
    for (int j = 0; j <= 1; j++) {
      float r = r0 + float(j);
      if (r < 0.0 || r >= uBandRows.x) continue;
      float c = mod(c0 + float(i), cols);
      vec4 s0, s1;
      readTree(uTrees, uTreesH, r * cols + c, s0, s1);
      vec4 t = vec4(s0.xyz, s1.x);
      if (t.z <= 0.0) continue;
      float hc = t.z * (t.w < 0.5 ? 0.58 : 0.52);
      float rc = t.z * (t.w < 0.5 ? 0.33 : t.w < 1.5 ? 0.12 : 0.19);
      vec2 g = vec2(mod(p - t.x + 0.5 * uD, uD) - 0.5 * uD, d - t.y) + toSun * hc * cotE;
      float stretch = sqrt(1.0 + cotE * cotE);
      float e = length(vec2(dot(g, toSun) / stretch, dot(g, across))) / rc;
      shade = max(shade, smoothstep(1.05, 0.55, e));
    }
  return 1.0 - 0.6 * shade;
}

void main() {
  float p = vPD.x;
  float d = vPD.y;
  vec3 n = normalize(vNormal);
  float hedge;
  vec3 col = fieldColour(p, d, hedge);
  // Meadow texture: broad tonal drifts and finer clumps (blurred along the track near the line).
  float drift = snoise(cyl(p, d, 1.0 / 35.0, 61.0));
  float fine = 0.0;
  float blur = clamp(uBlur * 18.0 / max(d, 1.0), 0.0, 1.0);
  for (int i = 0; i < 4; i++) fine += snoise(cyl(p + (float(i) - 1.5) * uBlur * 0.35, d, 1.0 / 2.5, 67.0));
  fine *= 0.25 * (1.0 - blur * 0.8) * smoothstep(400.0, 40.0, d);
  // Painterly: broad patches of lighter and darker green, warmer on the tops of the rises.
  float patch2 = snoise(cyl(p, d, 1.0 / 90.0, 63.0));
  col *= 0.88 + 0.16 * drift + 0.12 * patch2 + 0.1 * fine;
  col = mix(col, col * vec3(1.25, 1.12, 0.7), smoothstep(0.85, 1.0, n.y) * 0.25 * (0.5 + 0.5 * patch2));
  // Flowers in the meadows (only near enough to see them).
  float fl = snoise(cyl(p, d, 1.0 / 1.6, 71.0));
  float flowers = smoothstep(0.78, 0.9, fl) * smoothstep(160.0, 40.0, d) * smoothstep(25.0, 40.0, d) * (1.0 - blur) * step(0.3, snoise(cyl(p, d, 1.0 / 50.0, 73.0)));
  col = mix(col, mix(vec3(0.95, 0.85, 0.3), vec3(0.95, 0.95, 0.9), step(0.0, snoise(cyl(p, d, 1.0 / 30.0, 79.0)))), flowers * 0.8);
  // Hedgerows between the fields: dark, bumpy.
  col = mix(col, vec3(0.07, 0.17, 0.05) * (0.8 + 0.4 * fine), hedge * smoothstep(1500.0, 300.0, d) * 0.85);
  // Under the woods: dark green canopy shade.
  float wd = woods(p, d) * smoothstep(24.0, 40.0, d);
  col = mix(col, vec3(0.06, 0.15, 0.05), wd * 0.6);
  // The hills under towns and castles are pasture.
  float rel = mod(p - uS + 0.5 * uD, uD) - 0.5 * uD;
  for (int i = 0; i < ${MAX_FAR}; i++) {
    vec4 f = uFar[i];
    if (f.x < 0.5 || f.x > 1.5) continue;
    float g = smoothstep(f.w * 1.05, f.w * 0.6, length(vec2(rel - f.y, d - f.z)));
    col = mix(col, vec3(0.12, 0.27, 0.045) * (0.9 + 0.12 * drift), g);
  }
  // Steep ground shows earth and rock.
  col = mix(col, vec3(0.38, 0.34, 0.28), smoothstep(0.66, 0.45, n.y) * 0.6);
  // A lane from each level crossing, winding away over the fields.
  for (int i = 0; i < 4; i++) {
    vec4 f = uNear[i];
    if (abs(f.x - 2.0) > 0.5) continue;
    float rel = mod(p - uS + 0.5 * uD, uD) - 0.5 * uD;
    float lane = rel - 0.5 * (f.y + f.z) - 18.0 * sin(d / 70.0 + f.w * 6.0) * smoothstep(10.0, 60.0, d);
    col = mix(col, vec3(0.42, 0.36, 0.26) * (0.9 + 0.1 * fine), (1.0 - smoothstep(1.6, 2.4, abs(lane))) * smoothstep(5.5, 8.0, d));
  }
  // By the line: grass verge, then ballast and the other line's rails, blurred along the track.
  float ballast = 1.0 - smoothstep(5.2, 6.6, d);
  vec3 stones = vec3(0.3, 0.26, 0.21) * (0.85 + 0.15 * fine);
  col = mix(col, stones, ballast);
  float rails = (1.0 - smoothstep(0.04, 0.09, abs(d - 3.75))) + (1.0 - smoothstep(0.04, 0.09, abs(d - 5.18)));
  col = mix(col, vec3(0.55, 0.52, 0.5), rails * ballast * 0.8);
  // Wet in rain: darker, a little shinier.
  col *= 1.0 - 0.18 * uRain;
  vec3 c = litWrap(col, n, vShadow * treeShade(p, d), 0.85 + 0.15 * n.y, 0.08);
  // Low mist in the valleys when it rains.
  float mist = uRain * smoothstep(-3.0, -14.0, vWorld.y - GROUND_Y) * 0.5;
  c = mix(c, uHazeCol, mist);
  gl_FragColor = vec4(hazed(c, vWorld), 1.0);
}
`;

const WATER_FRAG = /* glsl */ `
${WORLD}
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vec3 v = normalize(vWorld - uEye);
  float p = ringAt(vWorld.x);
  float d = outAt(vWorld.z);
  // Ripples (slowly moving, whole cycles per loop) tilt the reflection.
  vec2 rip = vec2(snoise(vec4(p * 0.08, d * 0.08, uTC * 3.0)), snoise(vec4(p * 0.08 + 9.0, d * 0.08, uTC * 3.0)));
  vec3 n = normalize(vec3(rip.x * 0.08, 1.0, rip.y * 0.08));
  vec3 r = reflect(v, n);
  vec3 sky = mix(uSkyHorizon, uSkyTop, pow(max(r.y, 0.0), 0.55));
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(-v, n), 0.0), 5.0);
  vec3 col = mix(vec3(0.05, 0.12, 0.1), sky, fres);
  col += uSunCol * pow(max(dot(r, uSunDir), 0.0), 220.0) * 2.0 * (1.0 - uRain);
  gl_FragColor = vec4(hazed(col, vWorld), 1.0);
}
`;

const WATER_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** trees: the nearest band's state texture (where its trees are this frame), for their shadows. */
export function buildTerrain(U: WorldUniforms, trees: { texture: THREE.Texture; height: number }) {
  const group = new THREE.Group();
  const grid: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    const d = D0 * Math.pow(GROW, r);
    for (let c = 0; c < COLS; c++) grid.push((c / (COLS - 1)) * 2 - 1, d);
  }
  for (let r = 0; r < ROWS - 1; r++)
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c;
      idx.push(a, a + 1, a + COLS, a + 1, a + COLS + 1, a + COLS);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(grid.length * 1.5), 3));
  g.setAttribute('aGrid', new THREE.Float32BufferAttribute(grid, 2));
  g.setIndex(idx);
  const b = BANDS[0];
  const u = {
    ...U,
    uHalfW0: { value: 40 },
    uHalfWk: { value: 1.35 },
    uCols: { value: COLS },
    uBand: { value: new THREE.Vector4(b.W, b.cell, b.d0, b.W / b.cell) },
    uBandRows: { value: new THREE.Vector2(Math.floor((b.d1 - b.d0) / b.cell), 0) },
    uTrees: { value: trees.texture },
    uTreesH: { value: trees.height },
  };
  const land = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG, uniforms: u }));
  land.frustumCulled = false;
  group.add(land);

  const water = new THREE.Mesh(new THREE.PlaneGeometry(14000, 6000), new THREE.ShaderMaterial({ vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, uniforms: U }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, WATER_Y, -3000);
  group.add(water);
  return { group };
}
