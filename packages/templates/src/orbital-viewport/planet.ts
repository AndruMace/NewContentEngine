/**
 * The planet, its atmosphere, rings and moons.
 *
 * The surface (colour, oceans, height, city lights) is generated once at load into equirectangular
 * textures by a shader pass (bakeTexture). Each frame the planet shader turns the surface (a whole
 * number of turns per loop), lights it from the sun with a soft terminator, adds ocean glint and the
 * night side's city lights, and draws clouds: 4D noise that turns with the planet and slowly
 * reshapes along a time circle, so it loops exactly. Gas giants get flowing bands instead.
 */
import { THREE, bakeTexture } from '../three-layer';
import { FBM4, NOISE4 } from '../ambient/glsl';
import { timeCircle } from '../ambient/loop';
import type { PLANETS } from './index';

export type PlanetType = (typeof PLANETS)[number];
const TYPE_INDEX: Record<PlanetType, number> = { earthlike: 0, ocean: 1, desert: 2, ice: 3, gas: 4 };

/** Equirectangular uv → unit direction (seamless in longitude). */
const SPHERE_DIR = /* glsl */ `
vec3 sphereDir(vec2 uv) {
  float lon = uv.x * 6.2831853;
  float lat = (uv.y - 0.5) * 3.1415927;
  return vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
}
`;

/** Surface colour (rgb) and ocean mask (a). */
const SURFACE_FRAG = /* glsl */ `
${NOISE4}
${FBM4}
${SPHERE_DIR}
varying vec2 vUv;
uniform float uType;
uniform float uSeed;
float ridged(vec4 p) { return 1.0 - abs(snoise(p)); }
void main() {
  vec3 d = sphereDir(vUv);
  float lat = abs(d.y);
  vec4 q = vec4(d * 2.6, uSeed);
  float h = fbm4(q, 7);                          // continents
  float detail = fbm4(q * 5.0 + 3.0, 5);
  float moist = fbm4(vec4(d * 2.3, uSeed + 7.0), 4) * 0.5 + 0.5;
  vec3 col; float ocean = 0.0;
  if (uType < 0.5 || (uType > 0.5 && uType < 1.5)) {
    // Earthlike (or mostly ocean): sea level, beaches, forest/grass/desert by moisture and latitude, ice caps.
    float sea = uType < 0.5 ? 0.02 : 0.32;
    float land = h - sea;
    vec3 deep = vec3(0.012, 0.06, 0.17), shallow = vec3(0.04, 0.19, 0.3);
    vec3 seaCol = mix(deep, shallow, smoothstep(-0.06, 0.0, land));
    float dry = smoothstep(0.55, 0.25, moist) * smoothstep(0.65, 0.2, lat);
    vec3 forest = vec3(0.07, 0.12, 0.05), grass = vec3(0.16, 0.18, 0.08), sand = vec3(0.5, 0.4, 0.26), rock = vec3(0.3, 0.26, 0.22);
    vec3 ground = mix(forest, grass, smoothstep(0.35, 0.7, moist + detail * 0.2));
    ground = mix(ground, sand, dry);
    ground = mix(ground, rock, smoothstep(0.2, 0.45, land + detail * 0.12));
    // A soft coastline (a little wider than one texel) instead of a hard switch.
    float shore = smoothstep(-0.006, 0.006, land);
    col = mix(seaCol, ground, shore);
    ocean = 1.0 - shore;
    float cap = smoothstep(0.78, 0.86, lat + detail * 0.06);
    col = mix(col, vec3(0.86, 0.9, 0.95), cap);
    ocean *= 1.0 - cap;
  } else if (uType < 2.5) {
    // Desert world: ochre plains, darker rocky highlands, dune streaks, small ice caps.
    float dunes = sin((d.x + d.z) * 80.0 + detail * 6.0) * 0.5 + 0.5;
    col = mix(vec3(0.55, 0.32, 0.16), vec3(0.72, 0.5, 0.3), smoothstep(-0.3, 0.4, h));
    col = mix(col, vec3(0.3, 0.17, 0.1), smoothstep(0.25, 0.55, h + detail * 0.2));
    col *= 0.92 + 0.08 * dunes;
    col = mix(col, vec3(0.85, 0.82, 0.78), smoothstep(0.86, 0.92, lat + detail * 0.04));
  } else if (uType < 3.5) {
    // Ice world: blue-white sheets, cracks, a few dark open seas.
    float crack = pow(ridged(vec4(d * 6.0, uSeed + 2.0)), 18.0);
    col = mix(vec3(0.62, 0.72, 0.82), vec3(0.88, 0.92, 0.96), smoothstep(-0.4, 0.5, h + detail * 0.3));
    col = mix(col, vec3(0.25, 0.38, 0.5), crack * 0.7);
    float sea = smoothstep(-0.35, -0.45, h);
    col = mix(col, vec3(0.02, 0.06, 0.12), sea);
    ocean = sea;
  } else {
    // Gas giant: banded by latitude, the bands bent by turbulence, one great storm.
    float y = d.y + fbm4(vec4(d * 3.0, uSeed), 4) * 0.06;
    float band = sin(y * 26.0) * 0.5 + 0.5;
    float band2 = sin(y * 61.0 + 1.3) * 0.5 + 0.5;
    col = mix(vec3(0.62, 0.48, 0.34), vec3(0.86, 0.78, 0.64), band);
    col = mix(col, vec3(0.52, 0.32, 0.2), band2 * 0.35);
    vec3 spotC = normalize(vec3(0.7, -0.35, 0.6));
    float spot = smoothstep(0.18, 0.08, length((d - spotC) * vec3(1.0, 2.2, 1.0)));
    col = mix(col, vec3(0.7, 0.32, 0.2), spot * 0.85);
  }
  gl_FragColor = vec4(col, ocean);
}
`;

/** City lights (r) on land, in clusters along coasts and lowlands; height (g). */
const LIGHTS_FRAG = /* glsl */ `
${NOISE4}
${FBM4}
${SPHERE_DIR}
varying vec2 vUv;
uniform float uSeed;
uniform float uLand;
void main() {
  vec3 d = sphereDir(vUv);
  float h = fbm4(vec4(d * 2.6, uSeed), 7);
  float land = smoothstep(uLand, uLand + 0.03, h) * smoothstep(0.8, 0.6, abs(d.y));
  float towns = fbm4(vec4(d * 14.0, uSeed + 11.0), 3);
  // Sparse clusters of towns along lowlands and coasts, each a scatter of bright dots.
  float lights = land * smoothstep(0.42, 0.7, towns) * smoothstep(0.45, uLand + 0.05, h);
  float dots = smoothstep(0.6, 0.95, snoise(vec4(d * 140.0, uSeed + 3.0)));
  gl_FragColor = vec4(lights * dots * 0.6, h, 0.0, 1.0);
}
`;

const PLANET_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vLocal;
void main() {
  vLocal = normalize(position);
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const PLANET_FRAG = /* glsl */ `
${NOISE4}
${FBM4}
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vLocal;
uniform sampler2D uSurface;
uniform sampler2D uLights;
uniform vec3 uSun;
uniform float uSpin;       // surface rotation (radians)
uniform vec2 uT;           // time circle, for clouds reshaping
uniform float uType;
uniform float uClouds;     // cloud amount
uniform float uSeed;
uniform float uAlbedo;    // bright worlds (ice, gas) are scaled down so they don't blow out
vec3 spin(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
vec2 equirect(vec3 d) { return vec2(fract(atan(d.z, d.x) / 6.2831853), asin(clamp(d.y, -1.0, 1.0)) / 3.1415927 + 0.5); }
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 d = spin(vLocal, uSpin);
  vec2 uv = equirect(d);
  // Seam-safe derivatives: where longitude wraps (u jumps 1 → 0) the plain derivative is huge and the
  // lookup drops to the blurriest mip, drawing a line. Use whichever of u or u shifted by half a turn
  // varies less.
  vec2 duvx = dFdx(uv), duvy = dFdy(uv);
  float ux = fract(uv.x + 0.5);
  vec2 dax = vec2(dFdx(ux), duvx.y), day_ = vec2(dFdy(ux), duvy.y);
  if (abs(dax.x) < abs(duvx.x)) duvx = dax;
  if (abs(day_.x) < abs(duvy.x)) duvy = day_;
  vec4 surf = textureGrad(uSurface, uv, duvx, duvy);
  float city = textureGrad(uLights, uv, duvx, duvy).r;
  float ndl = dot(n, uSun);
  float day = smoothstep(-0.08, 0.22, ndl);
  // Clouds: turn with the surface, and reshape slowly (the time circle loops).
  float cloud = 0.0;
  if (uType < 3.5) {
    // Weather systems (large), broken cloud within them (small), and streaks along the latitudes.
    float big = fbm4(vec4(d * 4.0 + vec3(uSeed), 0.0) + vec4(0.0, 0.0, uT * 0.18), 4);
    float small = fbm4(vec4(d * 16.0 + vec3(uSeed * 2.0), 1.0) + vec4(0.0, 0.0, uT * 0.3), 4);
    float streak = fbm4(vec4(d * vec3(3.0, 12.0, 3.0), uSeed + 4.0) + vec4(0.0, 0.0, uT * 0.12), 3);
    float c = big + small * 0.45 + streak * 0.25;
    cloud = smoothstep(0.22 - uClouds * 0.3, 0.55, c);
    cloud *= smoothstep(1.0, 0.6, abs(d.y)) * 0.6 + 0.4;
  } else {
    // Gas giant: the bands drift against each other.
    float flow = fbm4(vec4(d * vec3(2.0, 18.0, 2.0), uSeed) + vec4(uT * 0.25, 0.0, 0.0), 4);
    surf.rgb *= 0.9 + 0.2 * flow;
  }
  vec3 albedo = mix(surf.rgb, vec3(0.92, 0.93, 0.95), cloud * 0.92);
  vec3 lit = albedo * uAlbedo * (0.02 + 1.1 * day * max(ndl, 0.0) + 0.15 * day);
  // Sun glint off open water (not through cloud).
  vec3 h = normalize(uSun + v);
  float glint = pow(max(dot(n, h), 0.0), 120.0) * surf.a * (1.0 - cloud) * day;
  lit += vec3(1.0, 0.9, 0.75) * glint * 1.6;
  // Near the terminator the light reddens.
  lit *= mix(vec3(1.0, 0.55, 0.35), vec3(1.0), smoothstep(-0.02, 0.3, ndl));
  // City lights on the night side, dimmed by cloud.
  float night = 1.0 - smoothstep(-0.12, 0.05, ndl);
  lit += vec3(1.0, 0.72, 0.38) * city * night * (1.0 - cloud * 0.85) * 1.4;
  // Haze toward the limb on the day side.
  // Blue haze over the day side (the atmosphere scattering sunlight), thicker toward the limb.
  float rim = pow(1.0 - max(dot(n, v), 0.0), 7.0);
  lit += vec3(0.05, 0.09, 0.17) * day * max(ndl, 0.0) * (0.6 + 0.4 * rim);
  lit = mix(lit, vec3(0.35, 0.55, 0.95) * day, rim * 0.45 * day);
  gl_FragColor = vec4(lit, 1.0);
}
`;

const ATMOS_FRAG = /* glsl */ `
varying vec3 vN;
varying vec3 vWorld;
uniform vec3 uSun;
uniform vec3 uColor;
uniform vec3 uCenter;
uniform float uR;
void main() {
  // How close does this sight line pass the planet's centre? The glow peaks at the true horizon
  // (h = R), fades out into space above it and quickly into the planet's face below.
  vec3 ray = normalize(vWorld - cameraPosition);
  vec3 oc = uCenter - cameraPosition;
  float along = dot(oc, ray);
  float h = length(oc - ray * along);
  float H = uR * 0.012;
  float glow = h > uR ? exp(-(h - uR) / H) : exp(-(uR - h) / (H * 0.5));
  // Lit where the sun is: use the horizon point's direction from the centre.
  vec3 p = normalize(cameraPosition + ray * along - uCenter);
  float ndl = dot(p, uSun);
  float day = smoothstep(-0.2, 0.3, ndl);
  vec3 sunset = vec3(1.0, 0.42, 0.18) * smoothstep(0.3, 0.0, abs(ndl + 0.05)) * 0.8;
  gl_FragColor = vec4((uColor * day + sunset) * glow * 1.6, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
${NOISE4}
varying vec3 vWorld;
varying vec2 vUv;
uniform vec3 uCenter;
uniform float uR;
uniform float uInner;
uniform float uOuter;
uniform vec3 uSun;
uniform float uSeed;
void main() {
  float r = length(vWorld - uCenter) / uR;
  float x = (r - uInner) / (uOuter - uInner);
  if (x < 0.0 || x > 1.0) discard;
  float bands = 0.55 + 0.45 * snoise(vec4(x * 40.0, uSeed, 0.0, 0.0));
  float gaps = smoothstep(0.02, 0.06, abs(x - 0.62)) * smoothstep(0.01, 0.03, abs(x - 0.31));
  float dens = bands * gaps * smoothstep(0.0, 0.04, x) * smoothstep(1.0, 0.9, x);
  // In the planet's shadow? (does the ray toward the sun hit the planet)
  vec3 o = vWorld - uCenter;
  float b = dot(o, uSun);
  float c = dot(o, o) - uR * uR;
  float shadow = (b < 0.0 && b * b - c > 0.0) ? 0.08 : 1.0;
  vec3 col = mix(vec3(0.55, 0.48, 0.4), vec3(0.85, 0.8, 0.72), bands) * shadow;
  gl_FragColor = vec4(col * 0.7, dens * 0.8);
}
`;

const MOON_FRAG = /* glsl */ `
${NOISE4}
${FBM4}
varying vec3 vN;
varying vec3 vLocal;
uniform vec3 uSun;
uniform float uSeed;
void main() {
  vec3 n = normalize(vN);
  float m = fbm4(vec4(vLocal * 3.0, uSeed), 5);
  float craters = smoothstep(0.55, 0.7, snoise(vec4(vLocal * 9.0, uSeed + 5.0)));
  vec3 albedo = vec3(0.42, 0.4, 0.38) * (0.75 + 0.35 * m) * (1.0 - craters * 0.25);
  float ndl = max(dot(n, uSun), 0.0);
  gl_FragColor = vec4(albedo * (0.01 + 1.3 * ndl), 1.0);
}
`;

export interface PlanetOpts {
  type: PlanetType;
  rings: boolean;
  moons: number;
  seed: number;
  center: THREE.Vector3;
  radius: number;
  sun: THREE.Vector3;
  /** Tilt of the spin axis (radians, toward the camera). */
  tilt: number;
}

export interface Planet {
  group: THREE.Group;
  update(t: number, L: number): void;
}

export function buildPlanet(o: PlanetOpts): Planet {
  const group = new THREE.Group();
  const type = TYPE_INDEX[o.type];
  const seed = (o.seed % 997) * 0.731;
  const surface = bakeTexture(SURFACE_FRAG, { uType: { value: type }, uSeed: { value: seed } }, 4096, 2048);
  const landLevel = o.type === 'ocean' ? 0.32 : o.type === 'earthlike' ? 0.02 : 9.0;
  const lights = bakeTexture(LIGHTS_FRAG, { uSeed: { value: seed }, uLand: { value: landLevel } }, 4096, 2048);

  // The planet spins about its own (tilted) y axis: the group carries the tilt, the shader the spin.
  const body = new THREE.Group();
  body.position.copy(o.center);
  body.rotation.x = o.tilt;
  group.add(body);

  const uniforms = {
    uSurface: { value: surface },
    uLights: { value: lights },
    uSun: { value: o.sun.clone().normalize() },
    uSpin: { value: 0 },
    uT: { value: new THREE.Vector2() },
    uType: { value: type },
    uClouds: { value: o.type === 'desert' ? 0.15 : o.type === 'ice' ? 0.35 : 0.6 },
    uSeed: { value: seed },
    uAlbedo: { value: o.type === 'ice' ? 0.6 : o.type === 'gas' ? 0.55 : 1 },
  };
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(o.radius, 160, 120), new THREE.ShaderMaterial({ vertexShader: PLANET_VERT, fragmentShader: PLANET_FRAG, uniforms }));
  body.add(sphere);

  const atmosColor = o.type === 'desert' ? new THREE.Color(0.75, 0.5, 0.35) : o.type === 'gas' ? new THREE.Color(0.7, 0.6, 0.45) : new THREE.Color(0.3, 0.55, 1.0);
  const atmos = new THREE.Mesh(
    new THREE.SphereGeometry(o.radius * 1.035, 160, 120),
    new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: ATMOS_FRAG,
      uniforms: { uSun: uniforms.uSun, uColor: { value: atmosColor }, uCenter: { value: o.center }, uR: { value: o.radius } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  atmos.position.copy(o.center);
  group.add(atmos);

  if (o.rings) {
    const inner = 1.35;
    const outer = 2.3;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(o.radius * inner, o.radius * outer, 256, 1),
      new THREE.ShaderMaterial({
        vertexShader: 'varying vec3 vWorld; varying vec2 vUv; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: RING_FRAG,
        uniforms: { uCenter: { value: o.center }, uR: { value: o.radius }, uInner: { value: inner }, uOuter: { value: outer }, uSun: uniforms.uSun, uSeed: { value: seed } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2 + o.tilt;
    ring.position.copy(o.center);
    group.add(ring);
  }

  // Moons hang in the sky above the planet (our orbit and theirs barely change the view over a loop):
  // each at its own spot, drifting on a small ellipse once per loop, lit from the sun (so a phase shows).
  const moonSpots = [
    { dir: new THREE.Vector3(-0.42, 0.34, -1), size: 0.035, drift: 0.012 },
    { dir: new THREE.Vector3(0.5, 0.42, -1), size: 0.018, drift: 0.008 },
  ];
  const moons = moonSpots.slice(0, o.moons).map((spot, i) => {
    const dist = 1500;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(dist * spot.size, 64, 48),
      new THREE.ShaderMaterial({ vertexShader: PLANET_VERT, fragmentShader: MOON_FRAG, uniforms: { uSun: uniforms.uSun, uSeed: { value: seed + 13 * (i + 1) } } }),
    );
    m.renderOrder = -1;
    group.add(m);
    return { mesh: m, base: spot.dir.clone().normalize().multiplyScalar(dist), drift: dist * spot.drift, phase: 1.1 + i * 2.4 };
  });

  return {
    group,
    update(t, L) {
      // One turn per half hour of loop (at least one per loop), so a loop always closes on whole turns.
      const turns = Math.max(1, Math.round(L / 1800));
      uniforms.uSpin.value = (2 * Math.PI * turns * t) / L;
      const tc = timeCircle(t, L, 0.6);
      (uniforms.uT.value as THREE.Vector2).set(tc[0], tc[1]);
      moons.forEach((m, i) => {
        const a = m.phase + ((i % 2 ? -1 : 1) * 2 * Math.PI * t) / L;
        m.mesh.position.set(m.base.x + Math.cos(a) * m.drift, m.base.y + Math.sin(a) * m.drift * 0.5, m.base.z);
      });
    },
  };
}
