/**
 * The night outside the window, as shader planes at several distances (a "2.5D" diorama): sky, hills
 * with town lights, tree lines and farmhouses, the fields and the next track, then the trackside
 * (catenary poles, crossings, bridges, tunnels, station platforms) and rain or snow at three depths.
 *
 * Everything outside is fixed to the ground: a plane shows the ground at its distance, at along-track
 * position X + s (s, the distance travelled, wrapped to the ring), so perspective gives the parallax
 * by itself. Patterns repeat over the ring D (cells that divide it, noise wrapped onto a circle), so
 * the view at s = D is the view at s = 0. Near things move hundreds of pixels a frame: those shaders
 * average a few positions over the shutter time (motion blur), so poles sweep past instead of strobing.
 */
import { THREE } from '../three-layer';
import { BASIC_VERT, FBM4, HASH, LOOP_NOISE1, NOISE4 } from '../ambient/glsl';
import { CAMERA, GROUND_Y, WALL } from './layout';

/** Feature kinds as the shaders know them. */
export const KIND = { station: 1, crossing: 2, bridge: 3, tunnel: 4 } as const;
/** Features passed to the shaders at once (the ones near the window). */
export const MAX_FEATURES = 4;
const EYE_Y = CAMERA.pos[1];

const COMMON = /* glsl */ `
${HASH}
${NOISE4}
${FBM4}
${LOOP_NOISE1}
varying vec2 vUv;
varying vec3 vWorld;
uniform float uS;        // distance travelled, wrapped to [0, D)
uniform float uD;        // ring length (m)
uniform float uBlur;     // metres moved during the shutter
uniform float uPhase;    // t / loopS
uniform float uLoop;
uniform float uWeather;  // 0 rain, 1 clear, 2 snow
uniform float uPrecip;   // 0..1
uniform float uTown;     // 0..1 how many lights
uniform float uWin;      // 0..1 our window's light falling outside
uniform vec4 uFeat[${MAX_FEATURES}]; // kind, start, end (m, relative to the window: x on the planes), seed
uniform vec2 uTC;        // time circle (clouds)

// Along-track position (m) of plane x, and a hash per cell of size c that repeats over the ring.
float along(float x) { return x + uS; }
float cellId(float a, float c) { return mod(floor(a / c), uD / c); }
float cellHash(float a, float c, float salt) { return hash12(vec2(cellId(a, c), salt)); }
// Inside a feature of this kind at x? Returns 0..1 (soft by e metres at its ends); local = x - start.
float feature(float x, float kind, float e, out float local, out float len, out float seed) {
  float best = 0.0; local = 0.0; len = 0.0; seed = 0.0;
  for (int i = 0; i < ${MAX_FEATURES}; i++) {
    vec4 f = uFeat[i];
    if (abs(f.x - kind) > 0.5) continue;
    float m = smoothstep(f.y - e, f.y + e, x) * (1.0 - smoothstep(f.z - e, f.z + e, x));
    if (m > best) { best = m; local = x - f.y; len = f.z - f.y; seed = f.w; }
  }
  return best;
}
float featureMask(float x, float kind, float e) { float l, n, s; return feature(x, kind, e, l, n, s); }
// Moonlight by weather: clear nights are moonlit, rain is dark, snow glows.
float moon() { return uWeather > 1.5 ? 0.7 : uWeather > 0.5 ? 1.0 : 0.25; }
vec3 skyTint() { return uWeather > 1.5 ? vec3(0.034, 0.036, 0.044) : uWeather > 0.5 ? vec3(0.010, 0.014, 0.030) : vec3(0.019, 0.020, 0.026); }
`;

// ---- sky: no parallax (it's at infinity) ------------------------------------------------------------
const SKY_FRAG = /* glsl */ `
${COMMON}
uniform vec2 uMoonAt;   // the moon's position on this plane (m)
void main() {
  float e = (vWorld.y - ${EYE_Y.toFixed(3)}) / 3000.0;          // elevation (radians, roughly)
  vec3 col = skyTint() * (1.0 - 0.55 * smoothstep(0.0, 0.25, e));
  // Clouds: a heavy deck in rain and snow, a few moonlit wisps on a clear night.
  float c = fbm4(vec4(vWorld.xy * vec2(0.0016, 0.0035), uTC * 0.5), 5) * 0.5 + 0.5;
  float cover = uWeather > 0.5 && uWeather < 1.5 ? smoothstep(0.55, 0.85, c) * 0.6 : smoothstep(0.25, 0.7, c);
  vec3 cloudCol = uWeather > 1.5 ? vec3(0.045, 0.046, 0.052) : uWeather > 0.5 ? vec3(0.035, 0.040, 0.055) : vec3(0.020, 0.021, 0.026);
  // Stars on a clear night, twinkling a whole number of times per loop.
  if (uWeather > 0.5 && uWeather < 1.5) {
    vec2 g = vWorld.xy / 9.0;
    vec2 id = floor(g);
    float h = hash12(id);
    if (h > 0.86) {
      vec2 p = fract(g) - 0.5 - (vec2(hash12(id + 3.7), hash12(id + 8.1)) - 0.5) * 0.6;
      float tw = 0.75 + 0.25 * sin(6.28318 * floor(uLoop / (3.0 + 6.0 * h)) * uPhase + h * 50.0);
      col += vec3(0.75, 0.8, 1.0) * smoothstep(0.09, 0.0, length(p)) * (h - 0.86) * 4.0 * tw * smoothstep(0.0, 0.05, e);
    }
  }
  // The moon (behind thin cloud in rain), and its halo.
  float dm = length(vWorld.xy - uMoonAt);
  float disc = smoothstep(26.0, 23.0, dm);
  float halo = exp(-dm / 260.0) * 0.06 + exp(-dm / 60.0) * 0.08;
  float seen = uWeather > 0.5 && uWeather < 1.5 ? 1.0 - 0.7 * cover : 0.0;
  col += vec3(0.85, 0.88, 0.95) * disc * seen + vec3(0.5, 0.55, 0.7) * halo * moon();
  col = mix(col, cloudCol * (0.6 + 0.4 * moon()) + vec3(0.04, 0.045, 0.06) * halo * 2.0, cover * (uWeather > 0.5 && uWeather < 1.5 ? 0.7 : 0.9));
  // Town glow low on the horizon (light pollution under the cloud).
  col += vec3(0.05, 0.03, 0.012) * uTown * exp(-max(e, 0.0) / 0.02) * (uWeather > 0.5 && uWeather < 1.5 ? 0.4 : 1.0);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---- hills: a far silhouette with towns ---------------------------------------------------------------
const HILLS_FRAG = /* glsl */ `
${COMMON}
void main() {
  float a = along(vWorld.x);
  float y = vWorld.y - ${GROUND_Y.toFixed(3)};
  float h = 30.0 + 120.0 * (loopFbm1(a, uD, 1.0 / 900.0, 3.0, 5) * 0.5 + 0.5);
  if (y > h + 1.0) discard;
  float edge = smoothstep(h + 1.0, h - 1.0, y);
  vec3 col = uWeather > 1.5 ? vec3(0.040, 0.045, 0.058) * (0.6 + 0.4 * smoothstep(0.0, h, y)) : uWeather > 0.5 ? vec3(0.010, 0.012, 0.020) : vec3(0.007, 0.008, 0.010);
  // The ridge catches the moon.
  col += vec3(0.02, 0.022, 0.03) * moon() * smoothstep(h - 6.0, h, y) * (uWeather > 0.5 ? 1.0 : 0.3);
  // Towns: clusters of lights on the hillsides, where the (looping) noise says there is a town.
  float town = smoothstep(0.15, 0.55, loopNoise1(a, uD, 1.0 / 2500.0, 11.0)) * uTown;
  vec2 g = vec2(a / 26.0, y / 9.0);
  vec2 id = vec2(cellId(a, 26.0), floor(g.y));
  float hh = hash12(id + 4.2);
  if (hh < town * 0.55 && y < h - 4.0) {
    vec2 p = vec2(fract(g.x), fract(g.y)) - 0.5 - (vec2(hash12(id + 1.3), hash12(id + 2.9)) - 0.5) * 0.7;
    vec3 lc = mix(vec3(1.0, 0.62, 0.28), vec3(0.95, 0.9, 0.8), hash12(id + 7.7));
    col += lc * smoothstep(0.12, 0.0, length(p * vec2(1.0, 2.6))) * (0.25 + 0.5 * hash12(id + 5.5));
  }
  // Haze in rain and snow.
  col = mix(col, skyTint() * 0.9, uWeather > 0.5 && uWeather < 1.5 ? 0.15 : 0.45);
  gl_FragColor = vec4(col, edge);
}
`;

// ---- middle distance: tree lines, hedges and farmhouses ----------------------------------------------
const MID_FRAG = /* glsl */ `
${COMMON}
void main() {
  float a = along(vWorld.x);
  float y = vWorld.y - ${GROUND_Y.toFixed(3)};
  float forest = smoothstep(0.0, 0.45, loopNoise1(a, uD, 1.0 / 420.0, 21.0));
  float tops = loopFbm1(a, uD, 1.0 / 9.0, 23.0, 4) * 0.5 + 0.5;
  float h = mix(0.8 + 0.6 * tops, 7.0 + 9.0 * tops, forest);
  float tree = smoothstep(h + 0.25, h - 0.25, y);
  vec3 col = vec3(0.004, 0.005, 0.006);
  if (uWeather > 1.5) col = mix(vec3(0.010, 0.011, 0.014), vec3(0.03, 0.033, 0.042), smoothstep(h - 2.0, h, y) * 0.5);
  float alpha = tree;
  // Farmhouses in the open: a block with a roof, two or three lit windows, sometimes a yard light.
  float cell = 200.0;
  float hc = cellHash(a, cell, 31.0);
  if (hc < 0.45 * (1.0 - forest) * (0.4 + uTown)) {
    float c0 = (floor(a / cell) + 0.3 + 0.4 * hash12(vec2(cellId(a, cell), 32.0))) * cell;
    float dx = a - c0;
    float w = 9.0 + 6.0 * hash12(vec2(cellId(a, cell), 33.0));
    float wall = 4.5;
    float roof = wall + 3.5 * (1.0 - abs(dx) / (w * 0.55));
    if (abs(dx) < w * 0.5 && y < max(wall, roof)) {
      alpha = 1.0;
      col = vec3(0.006, 0.006, 0.007) + (uWeather > 1.5 && y > wall ? vec3(0.03, 0.032, 0.04) : vec3(0.0));
      // Windows: a row of small warm rectangles, some dark.
      float wx = fract((dx + w * 0.5) / 2.6);
      float wid = floor((dx + w * 0.5) / 2.6);
      float lit = step(0.35, hash12(vec2(cellId(a, cell) * 7.0 + wid, 34.0)));
      if (y > 1.4 && y < 2.6 && wx > 0.3 && wx < 0.7) col += vec3(0.55, 0.32, 0.12) * lit;
    }
    // Yard light on a pole beside some of them.
    float yard = step(0.4, hc / 0.45);
    float dl = length(vec2(a - (c0 + w * 0.7), y - 5.0));
    col += vec3(1.0, 0.8, 0.55) * (smoothstep(0.5, 0.0, dl) * 0.8 + exp(-dl / 3.0) * 0.06) * yard;
    alpha = max(alpha, step(dl, 0.5) * yard);
  }
  if (alpha < 0.01) discard;
  col = mix(col, skyTint() * 0.8, uWeather > 0.5 && uWeather < 1.5 ? 0.06 : 0.25);
  gl_FragColor = vec4(col, alpha);
}
`;

// ---- the ground: fields, the next track, a river under bridges ------------------------------------------
const GROUND_FRAG = /* glsl */ `
${COMMON}
vec3 groundAt(float x, float dz) {
  float a = along(x);
  // Fields: patches of slightly different darkness, ploughed rows parallel to the track.
  float plot = cellHash(a, 40.0, floor(dz / 35.0) + 50.0);
  float rows = 0.5 + 0.5 * sin(dz * 2.2 + plot * 10.0);
  vec3 col = vec3(0.006, 0.006, 0.005) * (0.6 + 0.5 * plot) * (0.85 + 0.15 * rows);
  if (uWeather > 1.5) col = vec3(0.075, 0.08, 0.095) * (0.75 + 0.25 * plot) * (0.9 + 0.1 * rows) * moon();
  else if (uWeather > 0.5) col += vec3(0.004, 0.005, 0.008) * moon();
  // Ballast by our track, then the other line's rails (they catch light).
  if (dz < 2.4) col = vec3(0.012, 0.012, 0.012) * (0.7 + 0.3 * hash12(vec2(floor(a * 6.0), floor(dz * 6.0))));
  float rails = smoothstep(0.035, 0.0, abs(dz - 3.6)) + smoothstep(0.035, 0.0, abs(dz - 5.0));
  col += vec3(0.06, 0.065, 0.075) * rails * (0.3 + moon()) ;
  return col;
}
void main() {
  float dz = ${WALL.toFixed(3)} - vWorld.z;
  // Motion blur along the track (more samples near, where it moves fastest).
  vec3 col = vec3(0.0);
  for (int k = 0; k < 6; k++) col += groundAt(vWorld.x + uBlur * (float(k) / 5.0 - 0.5), dz);
  col /= 6.0;
  // A river under a bridge: dark water with the sky's light on it.
  float bridge = featureMask(vWorld.x, ${KIND.bridge}.0, 6.0);
  if (bridge > 0.0) {
    vec3 water = skyTint() * 0.6 + vec3(0.008, 0.009, 0.012) * moon() * (0.5 + 0.5 * sin(dz * 0.8 + vWorld.x * 0.05));
    col = mix(col, water, bridge * smoothstep(1.0, 4.0, dz));
  }
  // Our window's light on the ground just outside.
  col += vec3(0.05, 0.03, 0.012) * uWin * exp(-dz / 2.5) * exp(-abs(vWorld.x) / 2.0);
  // Into the night: the far ground fades to the sky's colour at the horizon.
  col = mix(col, skyTint(), smoothstep(80.0, 900.0, dz) * 0.85);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---- a station platform (only where there is one) ------------------------------------------------------
const PLATFORM_FRAG = /* glsl */ `
${COMMON}
vec4 platformAt(float x, float dz) {
  float local, len, seed;
  float m = feature(x, ${KIND.station}.0, 0.4, local, len, seed);
  if (m <= 0.0) return vec4(0.0);
  float a = along(x);
  // Paving slabs, the yellow line by the edge, pools of light under the lamps (every 20 m).
  vec2 slab = vec2(fract(a / 1.2), fract(dz / 1.2));
  float joint = step(0.96, max(slab.x, slab.y));
  vec3 col = vec3(0.05, 0.048, 0.045) * (0.85 + 0.15 * hash12(vec2(floor(a / 1.2), floor(dz / 1.2)))) * (1.0 - 0.4 * joint);
  if (uWeather > 1.5) col = vec3(0.10, 0.10, 0.11);
  float lampX = (floor(local / 20.0) + 0.5) * 20.0;
  float pool = exp(-pow(length(vec2(local - lampX, (dz - 4.8) * 1.3)) / 4.0, 2.0));
  col *= 0.35 + 1.6 * pool;
  col += vec3(0.25, 0.2, 0.05) * smoothstep(0.08, 0.0, abs(dz - 1.75)) * (0.3 + pool);
  // Wet paving shines.
  if (uWeather < 0.5) col += vec3(0.08, 0.07, 0.05) * pool * pool * uPrecip;
  // Edge drop: darker below the lip.
  col *= smoothstep(1.35, 1.5, dz);
  return vec4(col, m);
}
void main() {
  float dz = ${WALL.toFixed(3)} - vWorld.z;
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 6; k++) acc += platformAt(vWorld.x + uBlur * (float(k) / 5.0 - 0.5), dz);
  acc /= 6.0;
  if (acc.a < 0.01) discard;
  gl_FragColor = vec4(acc.rgb / acc.a, acc.a);
}
`;

// ---- trackside, near (3.2 m): poles and wires, crossings, bridge trusses, tunnel walls, station lamps ---
const NEAR_FRAG = /* glsl */ `
${COMMON}
// Colour and coverage of the trackside at plane x, height y above the rails.
vec4 nearAt(float x, float y) {
  float a = along(x);
  vec4 o = vec4(0.0);
  float local, len, seed;
  // Tunnel: walls all round, lamps every 25 m, darker towards the portals' outside.
  float tun = feature(x, ${KIND.tunnel}.0, 1.5, local, len, seed);
  if (tun > 0.0) {
    float rough = 0.6 + 0.4 * hash12(vec2(floor(a * 2.0), floor(y * 2.0)));
    vec3 wall = vec3(0.006, 0.0055, 0.005) * rough;
    float lamp = length(vec2(fract(a / 25.0) - 0.5, (y - 2.6) / 25.0 * 4.0)) * 25.0;
    wall += vec3(1.0, 0.55, 0.2) * (smoothstep(0.3, 0.0, lamp) * 1.5 + exp(-lamp / 0.7) * 0.04);
    wall += vec3(0.012, 0.008, 0.004) * uWin * exp(-abs(x) / 2.0) * rough;
    o = vec4(wall, tun);
  }
  // Catenary poles every 50 m (not in tunnels), with the wires hanging between them.
  float px = mod(a, 50.0);
  float pole = step(abs(px - 25.0), 0.13) * step(y, 6.4);
  // A small bracket a third of the way up (signal cable box).
  float arm = step(abs(y - 2.2), 0.09) * step(abs(px - 25.0 - 0.18), 0.12);
  float u = (px - 25.0) / 25.0;
  float wireY = 5.55 + 0.35 * u * u;
  float wire = smoothstep(0.022, 0.0, abs(y - wireY)) + smoothstep(0.012, 0.0, abs(y - 6.05));
  vec3 poleCol = vec3(0.008, 0.008, 0.009) + vec3(0.02, 0.013, 0.006) * uWin * exp(-abs(x) / 2.0);
  if (tun < 0.99) {
    float cov = max(pole, arm);
    o = mix(o, vec4(poleCol, 1.0), cov * (1.0 - tun));
    o.rgb += vec3(0.05, 0.055, 0.065) * wire * moon() * (1.0 - tun);
    o.a = max(o.a, wire * 0.6 * (1.0 - tun));
  }
  // Bridge: a steel truss: top and bottom chords, and diagonals every 5 m.
  float br = feature(x, ${KIND.bridge}.0, 0.3, local, len, seed);
  if (br > 0.0) {
    float bx = mod(a, 5.0);
    float diag = min(abs(bx - y * 5.0 / 4.2), abs(5.0 - bx - y * 5.0 / 4.2));
    float truss = max(step(diag, 0.18) * step(y, 4.2), max(step(abs(y - 4.2), 0.18), step(abs(y - 0.3), 0.25)));
    truss = max(truss, step(abs(bx - 0.0), 0.15) * step(y, 4.2));
    vec3 steel = vec3(0.008, 0.008, 0.009) + vec3(0.016, 0.01, 0.005) * uWin * exp(-abs(x) / 2.0);
    o = mix(o, vec4(steel, 1.0), truss * br);
  }
  // Level crossing: the barrier post with two red lamps flashing in turn, the arm down across the road.
  float cr = feature(x, ${KIND.crossing}.0, 0.05, local, len, seed);
  if (cr > 0.0) {
    float post = step(abs(local - len * 0.5 + 2.2), 0.08) * step(y, 2.3);
    float armBar = step(abs(y - 1.3), 0.05) * step(local - len * 0.5 + 2.2, 0.0) * step(-6.0, local - len * 0.5 + 2.2);
    float stripes = step(0.5, fract((local) / 0.6));
    vec3 armCol = mix(vec3(0.25, 0.03, 0.02), vec3(0.3, 0.3, 0.3), stripes) * 0.4;
    o = mix(o, vec4(0.012, 0.012, 0.012, 1.0), post);
    o = mix(o, vec4(armCol, 1.0), armBar);
    // Lamps alternate once a second (whole cycles per loop): soft, small, never a flash of the room.
    float ph = fract(floor(uLoop * 1.0 + 0.5) * uPhase);
    for (int i = 0; i < 2; i++) {
      float on = i == 0 ? step(ph, 0.5) : step(0.5, ph);
      vec2 lp = vec2(local - len * 0.5 + 2.2 + (float(i) - 0.5) * 0.5, y - 2.1);
      float d = length(lp);
      o.rgb += vec3(1.0, 0.12, 0.05) * on * (smoothstep(0.12, 0.0, d) * 2.0 + exp(-d / 0.6) * 0.15);
      o.a = max(o.a, on * smoothstep(0.9, 0.0, d));
    }
  }
  // Station: lamp posts every 20 m, their heads glowing, and the canopy's edge.
  float st = feature(x, ${KIND.station}.0, 0.3, local, len, seed);
  if (st > 0.0) {
    float lx = mod(local, 20.0) - 10.0;
    float post = step(abs(lx), 0.06) * step(y, 3.1);
    float head = length(vec2(lx, (y - 3.1) * 1.6));
    o = mix(o, vec4(0.02, 0.02, 0.02, 1.0), post * st);
    vec3 lampC = mix(vec3(1.0, 0.85, 0.6), vec3(0.85, 0.9, 1.0), step(0.5, hash11(seed)));
    o.rgb += lampC * st * (smoothstep(0.22, 0.0, head) * 2.5 + exp(-head / 1.2) * 0.12);
    o.a = max(o.a, st * smoothstep(0.5, 0.0, head));
  }
  return o;
}
void main() {
  float y = vWorld.y - ${GROUND_Y.toFixed(3)};
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 8; k++) {
    vec4 c = nearAt(vWorld.x + uBlur * (float(k) / 7.0 - 0.5), y);
    acc += vec4(c.rgb * c.a, c.a);
  }
  acc /= 8.0;
  if (acc.a < 0.004) discard;
  gl_FragColor = vec4(acc.rgb / acc.a, acc.a);
}
`;

// ---- trackside, farther (14 m): bushes and trees, the station building, the crossing's road light ------
const SIDE_FRAG = /* glsl */ `
${COMMON}
vec4 sideAt(float x, float y) {
  float a = along(x);
  float local, len, seed;
  float st = feature(x, ${KIND.station}.0, 2.0, local, len, seed);
  float cr = featureMask(x, ${KIND.crossing}.0, 4.0);
  float br = featureMask(x, ${KIND.bridge}.0, 4.0);
  float tun = featureMask(x, ${KIND.tunnel}.0, 2.0);
  // Bushes and trees along the line, with gaps; cleared at stations, crossings and bridges.
  float clump = smoothstep(-0.1, 0.4, loopNoise1(a, uD, 1.0 / 60.0, 41.0));
  float h = (1.2 + 7.0 * clump) * (0.7 + 0.3 * (loopFbm1(a, uD, 1.0 / 2.5, 43.0, 3) * 0.5 + 0.5));
  h *= (1.0 - st) * (1.0 - cr) * (1.0 - br);
  vec4 o = vec4(vec3(0.003, 0.004, 0.004), smoothstep(h + 0.2, h - 0.2, y));
  if (uWeather > 1.5) o.rgb += vec3(0.02, 0.022, 0.028) * smoothstep(h - 1.0, h, y);
  // The station building: a long low block with a canopy, its windows lit.
  if (st > 0.0) {
    float bx = local - len * 0.3;
    float bw = len * 0.4;
    if (bx > 0.0 && bx < bw && y < 6.5) {
      vec3 c = vec3(0.012, 0.011, 0.011);
      float wx = fract(bx / 3.0);
      float lit = step(0.3, hash12(vec2(floor(bx / 3.0), seed)));
      float pane = step(1.2, y) * step(y, 2.4) * step(0.32, wx) * step(wx, 0.68);
      // Window bars split each into four.
      float bars = step(0.06, abs(wx - 0.5)) * step(0.05, abs(y - 1.8));
      c = mix(c, vec3(0.30, 0.19, 0.08) * (0.8 + 0.4 * hash12(vec2(floor(bx / 3.0), seed + 1.0))), lit * pane * bars);
      o = mix(o, vec4(c, 1.0), st);
    }
    // Canopy over the platform: a dark band with lights under it.
    float can = step(abs(y - 4.0), 0.15);
    o = mix(o, vec4(0.01, 0.01, 0.01, 1.0), can * st);
    float under = smoothstep(0.12, 0.0, abs(y - 3.8)) * step(0.85, fract(local / 6.0));
    o.rgb += vec3(0.9, 0.85, 0.7) * under * 0.6 * st;
    o.a = max(o.a, under * st);
  }
  // The road at a crossing, lit by a street lamp.
  if (cr > 0.0) {
    o.rgb += vec3(1.0, 0.75, 0.4) * cr * exp(-pow((y - 5.5) / 0.4, 2.0)) * 0.6;
    o.a = max(o.a, cr * exp(-pow((y - 5.5) / 0.4, 2.0)));
  }
  o.a *= 1.0 - tun;
  return o;
}
void main() {
  float y = vWorld.y - ${GROUND_Y.toFixed(3)};
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 6; k++) {
    vec4 c = sideAt(vWorld.x + uBlur * (float(k) / 5.0 - 0.5), y);
    acc += vec4(c.rgb * c.a, c.a);
  }
  acc /= 6.0;
  if (acc.a < 0.004) discard;
  gl_FragColor = vec4(acc.rgb / acc.a, acc.a);
}
`;

// ---- rain or snow, three sheets (added on top) --------------------------------------------------------
const PRECIP_FRAG = /* glsl */ `
${COMMON}
uniform float uV;       // train speed (m/s)
uniform float uFall;    // fall speed (m/s)
uniform float uCellW;   // column width (m), divides the ring
uniform float uLight;   // how lit this sheet is
uniform vec3 uTint;
void main() {
  vec2 p = vec2(along(vWorld.x), vWorld.y);
  // Relative to the window the drops move back at the train's speed and fall: in the shutter time
  // they draw a streak along (-v, -fall).
  vec2 vel = vec2(-uV, -uFall);
  float shutter = 1.0 / 60.0;
  vec2 dir = normalize(vel);
  float len = length(vel) * shutter + 0.01;
  float acc = 0.0;
  float base = floor(p.x / uCellW);
  // A streak reaches back over several columns at speed (it trails to the right of its head).
  for (int j = -9; j <= 1; j++) {
    float cx = base + float(j);
    float id = mod(cx, uD / uCellW);
    float r = hash12(vec2(id, 3.0));
    if (r > 0.25 + 0.75 * uPrecip) continue;
    // Each column's drops fall a whole number of 4 m cells per loop, so the sheet repeats.
    float cyc = floor(uFall * (0.85 + 0.3 * r) / 4.0 * uLoop + 0.5);
    float y = p.y + fract(cyc * uPhase + r * 7.0) * 4.0;
    float cy = floor(y / 4.0);
    float h2 = hash12(vec2(id, cy + 11.0));
    if (h2 > 0.6) continue;
    vec2 head = vec2((cx + 0.5 + (h2 - 0.3) * 0.8) * uCellW, (cy + hash12(vec2(id, cy))) * 4.0 - (y - p.y));
    vec2 d = p - head;
    float behind = dot(d, -dir);
    float across = abs(dot(d, vec2(-dir.y, dir.x)));
    float w = uFall > 2.0 ? 0.004 + 0.002 * h2 : 0.008 + 0.006 * h2;
    acc += smoothstep(w, 0.0, across) * step(0.0, behind) * smoothstep(len, len * 0.6, behind);
  }
  vec3 col = uTint * uLight * acc * (uFall > 2.0 ? 1.0 : 1.3);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---- what the window reflects: the lamp, and the warm room behind us -------------------------------------
const REFLECT_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
uniform vec2 uLampAt;    // where the lamp's reflection sits on the glass (world x, y)
uniform float uAmount;   // 0..1, stronger when it's darker outside
void main() {
  float d = length((vWorld.xy - uLampAt) * vec2(1.0, 1.4));
  vec3 col = vec3(1.0, 0.62, 0.3) * (exp(-d / 0.035) * 0.5 + exp(-d / 0.18) * 0.05);
  col += vec3(0.05, 0.028, 0.012) * smoothstep(1.4, 0.7, vWorld.y) * 0.6;
  gl_FragColor = vec4(col * uAmount, 1.0);
}
`;

export interface Landscape {
  group: THREE.Group;
  reflection: THREE.Mesh;
  update(o: {
    s: number;
    D: number;
    v: number;
    t: number;
    L: number;
    weather: 0 | 1 | 2;
    precip: number;
    town: number;
    win: number;
    features: { kind: number; rel0: number; rel1: number; seed: number }[];
    tc: [number, number];
    reflect: number;
    /** 0..1 how far into a tunnel (no rain or snow in there). */
    tunnel: number;
  }): void;
}

export function buildLandscape(): Landscape {
  const group = new THREE.Group();
  const common = {
    uS: { value: 0 },
    uD: { value: 1 },
    uBlur: { value: 0 },
    uPhase: { value: 0 },
    uLoop: { value: 1 },
    uWeather: { value: 0 },
    uPrecip: { value: 0.5 },
    uTown: { value: 0.5 },
    uWin: { value: 1 },
    uFeat: { value: Array.from({ length: MAX_FEATURES }, () => new THREE.Vector4()) },
    uTC: { value: new THREE.Vector2() },
  };
  const mat = (frag: string, extra: Record<string, THREE.IUniform> = {}, opts: THREE.ShaderMaterialParameters = {}) =>
    new THREE.ShaderMaterial({ vertexShader: BASIC_VERT, fragmentShader: frag, uniforms: { ...common, ...extra }, ...opts });
  const vplane = (frag: string, d: number, w: number, h: number, extra: Record<string, THREE.IUniform> = {}, opts: THREE.ShaderMaterialParameters = {}) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat(frag, extra, opts));
    m.position.set(0, GROUND_Y + h / 2, WALL - d);
    group.add(m);
    return m;
  };
  const blend = { transparent: true, depthWrite: false } as const;

  const skyU = { uMoonAt: { value: new THREE.Vector2(-420, EYE_Y + 330) } };
  const sky = vplane(SKY_FRAG, 3000, 6000, 3200, skyU);
  sky.position.y = EYE_Y + 900;
  vplane(HILLS_FRAG, 1500, 3200, 160, {}, blend).renderOrder = 1;
  vplane(MID_FRAG, 220, 520, 24, {}, blend).renderOrder = 2;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(3400, 1500), mat(GROUND_FRAG));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, GROUND_Y, WALL - 750);
  group.add(ground);
  const platform = new THREE.Mesh(new THREE.PlaneGeometry(24, 6), mat(PLATFORM_FRAG, {}, blend));
  platform.rotation.x = -Math.PI / 2;
  platform.position.set(0, GROUND_Y + 0.95, WALL - 4.5);
  platform.renderOrder = 3;
  group.add(platform);
  vplane(SIDE_FRAG, 14, 40, 12, {}, blend).renderOrder = 4;
  vplane(NEAR_FRAG, 3.2, 14, 9, {}, blend).renderOrder = 5;

  // Rain or snow: just outside, a few metres off, and farther (columns that divide the ring).
  const sheets = [
    { d: 0.7, w: 4, h: 4, cell: 0.08, tint: [0.03, 0.024, 0.018], light: 1.0 },
    { d: 4, w: 12, h: 9, cell: 0.2, tint: [0.016, 0.016, 0.019], light: 1.0 },
    { d: 12, w: 30, h: 16, cell: 0.4, tint: [0.012, 0.013, 0.016], light: 1.0 },
  ];
  const precip = sheets.map((sh) => {
    const u = { uV: { value: 0 }, uFall: { value: 8 }, uCellW: { value: sh.cell }, uLight: { value: sh.light }, uTint: { value: new THREE.Vector3(...sh.tint) } };
    const m = vplane(PRECIP_FRAG, sh.d, sh.w, sh.h, u, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    m.position.y = EYE_Y;
    m.renderOrder = 6;
    return { u, m, light: sh.light };
  });

  const reflU = { uLampAt: { value: new THREE.Vector2() }, uAmount: { value: 1 } };
  const reflection = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({ vertexShader: BASIC_VERT, fragmentShader: REFLECT_FRAG, uniforms: reflU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  reflection.renderOrder = 8;

  return {
    group,
    reflection,
    update(o) {
      common.uS.value = o.s;
      common.uD.value = o.D;
      common.uBlur.value = o.v / 60;
      common.uPhase.value = o.t / o.L;
      common.uLoop.value = o.L;
      common.uWeather.value = o.weather;
      common.uPrecip.value = o.precip;
      common.uTown.value = o.town;
      common.uWin.value = o.win;
      common.uTC.value.set(o.tc[0], o.tc[1]);
      common.uFeat.value.forEach((v, i) => {
        const f = o.features[i];
        if (f) v.set(f.kind, f.rel0, f.rel1, f.seed);
        else v.set(0, 0, 0, 0);
      });
      for (const p of precip) {
        p.m.visible = o.weather !== 1 && o.precip > 0;
        p.u.uV.value = o.v;
        p.u.uFall.value = o.weather === 2 ? 1.2 : 8;
        p.u.uLight.value = p.light * (1 - o.tunnel);
      }
      reflU.uAmount.value = o.reflect;
    },
  };
}
