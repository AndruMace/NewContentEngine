/**
 * The sky: a dome round the eye. A gradient from the horizon's haze to deep blue overhead, the sun's
 * glow, and painterly cumulus on a layer 1400 m up: soft white tops lit from the sun's side, blue-grey
 * bellies. The clouds belong to the land (ring position p, like everything else), so they drift past
 * as the train goes and come round again after one loop. In rain, a low grey deck with darker scud.
 */
import { THREE } from '../three-layer';
import { WORLD, type WorldUniforms } from './world';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 w = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * w;
  gl_Position.z = gl_Position.w;  // always at the far plane
}
`;

const SKY_FRAG = /* glsl */ `
${WORLD}
uniform float uClouds;
varying vec3 vDir;

// Cloud density on the layer at world point (x, z): ring position along, and across.
float cloud(vec2 xz, float k) {
  float p = ringAt(xz.x);
  float d = outAt(xz.y);
  // Heaped cumulus: a broad shape, its edges broken up a little.
  float n = fbm4(cyl(p, d, k, 31.0), 2) + 0.25 * snoise(cyl(p, d, k * 4.0, 37.0));
  float cover = mix(0.1, 0.62, uClouds);
  return smoothstep(0.62 - cover, 0.78 - cover, n * 0.5 + 0.5);
}

void main() {
  vec3 dir = normalize(vDir);
  float up = max(dir.y, 0.0);
  // The gradient: haze at the horizon, the sky's colour overhead; a little darker below the horizon.
  vec3 col = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.45, pow(up, 0.8)));
  float sun = max(dot(dir, uSunDir), 0.0);
  col += uSunCol * (pow(sun, 8.0) * 0.12 + pow(sun, 64.0) * 0.25) * (1.0 - uRain);
  // The sun's disc (soft-edged), when in view.
  col += uSunCol * 4.0 * smoothstep(0.9993, 0.9997, sun) * (1.0 - uRain);
  if (dir.y > 0.005) {
    float t = (1400.0 - uEye.y) / dir.y;
    vec2 hit = uEye.xz + dir.xz * t;
    float far = smoothstep(24000.0, 6000.0, t);
    float k = uRain > 0.5 ? 1.0 / 900.0 : 1.0 / 2400.0;
    float c = cloud(hit, k) * far;
    // Light through the cloud: thinner towards the sun means a bright edge.
    vec2 toSun = normalize(uSunDir.xz + 1e-4) * 120.0;
    float c2 = cloud(hit + toSun, k);
    float lightness = clamp(1.0 - c2 * 0.9 + 0.2, 0.0, 1.0);
    vec3 belly = mix(uSkyHorizon * 0.75, uSkyTop * 0.5 + uSkyHorizon * 0.35, 0.4);
    vec3 top = uSunCol * 0.42 + uSkyHorizon * 0.35;
    vec3 cc = mix(belly, top, lightness);
    // Silver linings with the sun behind.
    cc += uSunCol * pow(sun, 12.0) * (1.0 - c) * 0.6 * (1.0 - uRain);
    if (uRain > 0.5) {
      // The deck: grey everywhere, darker where it's thick, scud moving below.
      float scud = fbm4(cyl(ringAt(hit.x * 0.6), outAt(hit.y * 0.6), 1.0 / 500.0, 41.0), 3);
      cc = mix(uSkyHorizon * 1.05, uSkyTop * 0.62, smoothstep(-0.2, 0.6, scud));
      c = mix(0.85, 1.0, c) * far + (1.0 - far) * 0.6;
    }
    col = mix(col, cc, c);
  }
  // Towards the horizon everything goes into the haze.
  col = mix(col, uHazeCol, smoothstep(0.07, 0.0, dir.y) * 0.4);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function buildSky(U: WorldUniforms) {
  const u = { ...U, uClouds: { value: 0.4 } };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(6000, 48, 24),
    new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: u, side: THREE.BackSide, depthWrite: false }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return {
    mesh,
    update(eye: THREE.Vector3, clouds: number) {
      mesh.position.copy(eye);
      u.uClouds.value = clouds;
    },
  };
}
