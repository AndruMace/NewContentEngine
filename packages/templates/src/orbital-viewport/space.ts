/**
 * Deep space behind the planet: a seeded starfield with a subtle twinkle, a faint galaxy band, and
 * the shooting stars (bright heads with fading tails) from the cue schedule.
 */
import { THREE } from '../three-layer';
import { FBM4, NOISE4 } from '../ambient/glsl';
import { wrap } from '../ambient/loop';
import type { Meteor } from './index';

const STAR_VERT = /* glsl */ `
attribute vec3 aStar;  // size, brightness, twinkle phase
attribute vec3 aColor;
uniform float uPhase;  // 2π · t / loopS
uniform float uLoop;
varying vec3 vCol;
void main() {
  // Each star twinkles a whole number of times per loop (roughly every 3–10 s).
  float cycles = floor(uLoop / (3.0 + aStar.z * 7.0));
  float tw = 0.85 + 0.15 * sin(uPhase * cycles + aStar.z * 40.0);
  vCol = aColor * aStar.y * tw;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aStar.x;
}
`;
const STAR_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vCol * a * a, 1.0);
}
`;

const GALAXY_FRAG = /* glsl */ `
${NOISE4}
${FBM4}
varying vec3 vDir;
uniform float uSeed;
void main() {
  vec3 d = normalize(vDir);
  // A band along a tilted great circle, with darker dust lanes through it.
  vec3 axis = normalize(vec3(0.35, 0.85, 0.4));
  float b = dot(d, axis);
  float band = exp(-b * b * 22.0);
  float glow = fbm4(vec4(d * 3.0, uSeed), 5) * 0.5 + 0.5;
  float dust = smoothstep(0.45, 0.75, fbm4(vec4(d * 7.0, uSeed + 3.0), 4) * 0.5 + 0.5);
  vec3 col = mix(vec3(0.012, 0.012, 0.02), vec3(0.03, 0.025, 0.022), glow) * band * (1.0 - dust * 0.7);
  col += vec3(0.002, 0.0025, 0.004);
  gl_FragColor = vec4(col, 1.0);
}
`;

const METEOR_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uBright;
void main() {
  // vUv.x: 0 at the tail, 1 at the head; vUv.y across.
  float across = 1.0 - abs(vUv.y - 0.5) * 2.0;
  float tail = pow(vUv.x, 2.5);
  float head = smoothstep(0.9, 1.0, vUv.x);
  vec3 col = mix(vec3(0.6, 0.75, 1.0), vec3(1.0, 0.97, 0.9), head) * (tail + head * 1.5) * across * across;
  gl_FragColor = vec4(col * uBright, 1.0);
}
`;

/** Stars and the galaxy far beyond anything else (the far planet is ~1,300 m out). */
const SKY_R = 5000;

export interface Space {
  group: THREE.Group;
  update(t: number, L: number, meteors: Meteor[]): void;
}

/** `aperture`: maps a viewport point (u, v in 0..1) to where it is on screen (NDC), for the meteors. */
export function buildSpace(camera: THREE.PerspectiveCamera, seed: number, aperture: (u: number, v: number) => [number, number]): Space {
  const group = new THREE.Group();
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);

  // Stars: mostly faint, a few bright, a little colour (blue-white to orange).
  const N = 6000;
  const pos = new Float32Array(N * 3);
  const star = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const u = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    pos.set([r * Math.cos(a) * SKY_R, u * SKY_R, r * Math.sin(a) * SKY_R], i * 3);
    const mag = Math.pow(rnd(), 6);
    star.set([1.4 + mag * 3.5, 0.25 + mag * 1.6, rnd()], i * 3);
    const temp = rnd();
    col.set(temp < 0.15 ? [1.0, 0.82, 0.62] : temp > 0.8 ? [0.75, 0.85, 1.0] : [1, 1, 1], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aStar', new THREE.BufferAttribute(star, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const starU = { uPhase: { value: 0 }, uLoop: { value: 1 } };
  const stars = new THREE.Points(geo, new THREE.ShaderMaterial({ vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, uniforms: starU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  stars.frustumCulled = false;
  stars.renderOrder = -2;
  group.add(stars);

  const galaxy = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_R * 1.05, 64, 32),
    new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: GALAXY_FRAG,
      uniforms: { uSeed: { value: (seed % 97) * 0.37 } },
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  galaxy.renderOrder = -3;
  group.add(galaxy);

  // One shooting star at a time (they're spaced well apart), redrawn each frame.
  const meteorU = { uBright: { value: 0 } };
  const meteorGeo = new THREE.BufferGeometry();
  const mPos = new Float32Array(4 * 3);
  meteorGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
  meteorGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), 2));
  meteorGeo.setIndex([0, 1, 2, 2, 1, 3]);
  const meteor = new THREE.Mesh(
    meteorGeo,
    new THREE.ShaderMaterial({ vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: METEOR_FRAG, uniforms: meteorU, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
  );
  meteor.frustumCulled = false;
  meteor.renderOrder = 5;
  meteor.visible = false;
  group.add(meteor);

  const toWorld = (ndc: [number, number], dist: number) => {
    const v = new THREE.Vector3(ndc[0], ndc[1], 0.5).unproject(camera);
    return v.sub(camera.position).normalize().multiplyScalar(dist).add(camera.position);
  };

  return {
    group,
    update(t, L, meteors) {
      starU.uPhase.value = (2 * Math.PI * t) / L;
      starU.uLoop.value = L;
      // The live meteor, if any (age measured round the loop).
      let live: Meteor | null = null;
      let age = 0;
      for (const m of meteors) {
        const a = wrap(t - m.t, L);
        if (a < m.dur) {
          live = m;
          age = a;
          break;
        }
      }
      if (!live) {
        meteor.visible = false;
        return;
      }
      const k = age / live.dur;
      const travel = live.len * 2.2;
      const head: [number, number] = [live.u + Math.cos(live.angle) * travel * k, live.v + Math.sin(live.angle) * travel * k];
      const tailK = Math.max(0, k - 0.45);
      const tail: [number, number] = [live.u + Math.cos(live.angle) * travel * tailK, live.v + Math.sin(live.angle) * travel * tailK];
      const D = 80;
      const h = toWorld(aperture(...head), D);
      const tl = toWorld(aperture(...tail), D);
      const dir = new THREE.Vector3().subVectors(h, tl);
      const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3().subVectors(camera.position, h)).normalize().multiplyScalar(0.06);
      mPos.set([tl.x - side.x, tl.y - side.y, tl.z - side.z, tl.x + side.x, tl.y + side.y, tl.z + side.z, h.x - side.x, h.y - side.y, h.z - side.z, h.x + side.x, h.y + side.y, h.z + side.z]);
      meteorGeo.attributes.position.needsUpdate = true;
      // Flares up and fades.
      meteorU.uBright.value = live.bright * Math.sin(Math.PI * k) * 1.4;
      meteor.visible = true;
    },
  };
}
