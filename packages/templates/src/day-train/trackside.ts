/**
 * What passes close to the window, too fast to see sharp: drawn on planes along the line, each
 * averaging a few positions over the shutter time (motion blur, as on the Night Train), so things
 * sweep past instead of strobing.
 *
 *   8.5 m: a level crossing's white gate, a station's lamp posts.
 *   a station's platform: stone slabs from the edge back to its fence (only at a station).
 *   2.4 m: a tunnel's walls (only inside one).
 *   and rain at three depths (Night Train's sheets).
 */
import { THREE } from '../three-layer';
import { BASIC_VERT } from '../ambient/glsl';
import { precipFrag } from '../night-train/landscape';
import { MAX_NEAR, NEAR_KIND, TRACK_Z, WORLD, type WorldUniforms } from './world';

const COMMON = /* glsl */ `
${WORLD}
uniform float uPrecip;
varying vec2 vUv;
varying vec3 vWorld;
float along(float x) { return ringAt(x); }
// Inside a near feature of this kind at relative position rel? 0..1 (soft by e m); local = rel - start.
float feature(float rel, float kind, float e, out float local, out float len, out float seed) {
  float best = 0.0; local = 0.0; len = 0.0; seed = 0.0;
  for (int i = 0; i < ${MAX_NEAR}; i++) {
    vec4 f = uNear[i];
    if (abs(f.x - kind) > 0.5) continue;
    float m = smoothstep(f.y - e, f.y + e, rel) * (1.0 - smoothstep(f.z - e, f.z + e, rel));
    if (m > best) { best = m; local = rel - f.y; len = f.z - f.y; seed = f.w; }
  }
  return best;
}
float featureMask(float rel, float kind, float e) { float l, n, s; return feature(rel, kind, e, l, n, s); }
`;

const POLES_FRAG = /* glsl */ `
${COMMON}
// Colour and coverage at plane x, height y above the rails.
vec4 nearAt(float x, float y) {
  float a = along(x);
  float rel = uDir * x;
  vec4 o = vec4(0.0);
  float local, len, seed;
  float st = feature(rel, ${NEAR_KIND.station}.0, 0.3, local, len, seed);
  // A level crossing's gate: white rails on posts, by the lane.
  float cr = feature(rel, ${NEAR_KIND.crossing}.0, 0.05, local, len, seed);
  if (cr > 0.0) {
    float gx = local - len * 0.5;
    float post = step(abs(gx - 4.0), 0.12) * step(y, 1.6) + step(abs(gx + 4.0), 0.12) * step(y, 1.6);
    float rails = (step(abs(y - 1.35), 0.06) + step(abs(y - 0.8), 0.05)) * step(abs(gx), 4.0);
    float brace = step(abs((gx + 4.0) * 0.18 - y + 0.8), 0.05) * step(0.0, gx + 4.0) * step(gx, 0.0) * step(0.8, y) * step(y, 1.35);
    o = mix(o, vec4(lit(vec3(0.85, 0.84, 0.8), vec3(0.0, 0.3, 1.0), 1.0, 1.0), 1.0), clamp(post + rails + brace, 0.0, 1.0));
  }
  // A station: lamp posts every 20 m with lantern heads, and the platform's stone edge.
  if (st > 0.0) {
    float lx = mod(local, 20.0) - 10.0;
    float post = step(abs(lx), 0.07) * step(y, 3.4);
    float head = step(abs(lx), 0.22) * step(abs(y - 3.55), 0.22);
    vec3 iron = lit(vec3(0.1, 0.16, 0.12), vec3(0.0, 0.2, 1.0), 1.0, 1.0);
    o = mix(o, vec4(iron, 1.0), max(post, head) * st);
  }
  return o;
}
void main() {
  float y = vWorld.y - GROUND_Y;
  // Empty but at a crossing or a station.
  float rel = uDir * vWorld.x;
  if (featureMask(rel, ${NEAR_KIND.crossing}.0, 6.0) + featureMask(rel, ${NEAR_KIND.station}.0, 2.0) < 0.001) discard;
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 8; k++) {
    vec4 c = nearAt(vWorld.x + uBlur * (float(k) / 7.0 - 0.5), y);
    acc += vec4(c.rgb * c.a, c.a);
  }
  acc /= 8.0;
  if (acc.a < 0.004) discard;
  gl_FragColor = vec4(hazed(acc.rgb / acc.a, vWorld), acc.a);
}
`;

const PLATFORM_FRAG = /* glsl */ `
${COMMON}
void main() {
  float rel = uDir * vWorld.x;
  float st = featureMask(rel, ${NEAR_KIND.station}.0, 0.4);
  if (st < 0.004) discard;
  float d = outAt(vWorld.z);
  // Paving slabs (blurred along the line), a pale edge, flower tubs now and then by the fence.
  float slab = 0.0;
  for (int k = 0; k < 6; k++) {
    float a = along(vWorld.x + uBlur * (float(k) / 5.0 - 0.5));
    slab += hash12(vec2(floor(a / 1.2), floor(d / 1.2)));
  }
  slab /= 6.0;
  vec3 stone = vec3(0.26, 0.24, 0.21) * (0.88 + 0.18 * slab);
  stone = mix(stone, vec3(0.42, 0.39, 0.33), 1.0 - smoothstep(2.6, 2.9, d));
  vec3 c = lit(stone * (1.0 - 0.15 * uRain), vec3(0.0, 1.0, 0.0), 1.0, 1.0);
  gl_FragColor = vec4(hazed(c, vWorld), st);
}
`;

const TUNNEL_FRAG = /* glsl */ `
${COMMON}
void main() {
  float rel = uDir * vWorld.x;
  float tun = featureMask(rel, ${NEAR_KIND.tunnel}.0, 2.0);
  if (tun < 0.004) discard;
  // Rough dark stone, streaked by the speed.
  float a = along(vWorld.x);
  float rough = 0.0;
  for (int k = 0; k < 6; k++) rough += hash12(vec2(floor((a + uBlur * (float(k) / 5.0 - 0.5)) * 2.0), floor(vWorld.y * 3.0)));
  rough /= 6.0;
  vec3 wall = vec3(0.012, 0.011, 0.01) * (0.6 + 0.6 * rough);
  gl_FragColor = vec4(wall, tun);
}
`;

export function buildTrackside(U: WorldUniforms) {
  const group = new THREE.Group();
  const u = { ...U, uPrecip: { value: 0.5 } };
  const blend = { transparent: true, depthWrite: false } as const;
  const plane = (frag: string, d: number, w: number, y0: number, y1: number, order: number, extra: Record<string, THREE.IUniform> = {}, opts: THREE.ShaderMaterialParameters = blend) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, y1 - y0), new THREE.ShaderMaterial({ vertexShader: BASIC_VERT, fragmentShader: frag, uniforms: { ...u, ...extra }, ...opts }));
    m.position.set(0, (y0 + y1) / 2, TRACK_Z - d);
    m.renderOrder = order;
    group.add(m);
    return m;
  };
  const G = -1.25;
  plane(POLES_FRAG, 8.5, 28, G - 0.5, G + 8, 4);
  plane(TUNNEL_FRAG, 2.4, 9, G - 1, G + 6, 5);
  // The platform: level with the carriage floor, from the edge (2.6 m out) to 9 m.
  const platform = new THREE.Mesh(new THREE.PlaneGeometry(40, 6.6), new THREE.ShaderMaterial({ vertexShader: BASIC_VERT, fragmentShader: PLATFORM_FRAG, uniforms: u, ...blend }));
  platform.rotation.x = -Math.PI / 2;
  platform.position.set(0, G + 0.9, TRACK_Z - 5.9);
  platform.renderOrder = 2;
  group.add(platform);

  // Rain at three depths (Night Train's sheets).
  const sheets = [
    { d: 0.7 + 1.4, w: 5, h: 4, cell: 0.08, tint: [0.05, 0.055, 0.06] },
    { d: 4 + 1.4, w: 12, h: 9, cell: 0.2, tint: [0.06, 0.065, 0.07] },
    { d: 12 + 1.4, w: 30, h: 16, cell: 0.4, tint: [0.05, 0.055, 0.06] },
  ];
  const precip = sheets.map((sh) => {
    const pu = { uV: { value: 0 }, uFall: { value: 8 }, uCellW: { value: sh.cell }, uLight: { value: 1 }, uTint: { value: new THREE.Vector3(...sh.tint) } };
    const m = plane(precipFrag(COMMON), sh.d, sh.w, 1.27 - sh.h / 2, 1.27 + sh.h / 2, 6, pu, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    return { pu, m };
  });
  return {
    group,
    update(o: { rain: number; v: number; tunnel: number }) {
      u.uPrecip.value = o.rain;
      for (const p of precip) {
        p.m.visible = o.rain > 0;
        p.pu.uV.value = o.v;
        p.pu.uLight.value = 1 - o.tunnel;
      }
    },
  };
}
