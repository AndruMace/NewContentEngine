/**
 * Squid in small groups, jetting in bursts (a pulse of the mantle drives each one forward, then it
 * coasts), fins rippling, arms and two long tentacles trailing, colour flickering as they go; and in
 * the abyss the vampire squid: dark red, its webbed arms opening and closing like a cloak, blue light
 * organs glowing at its arm tips.
 */
import { THREE } from '../../three-layer';
import { WATER, type WaterUniforms } from '../water';
import type { Depth, Population } from '../schedule';
import { beat, creatureMaterial, face, passState, type Fauna } from './kit';

const ARMS_VERT = /* glsl */ `
attribute vec2 aT;       // along (0 at the head .. 1 at the tip), which arm
uniform float uWave;
uniform float uSpread;   // how far the arms splay (0 together .. 1 open)
varying vec3 vWorld;
varying float vAlong;
void main() {
  vAlong = aT.x;
  vec3 p = position;
  float k = aT.x;
  float a = aT.y * 0.785;
  p.x += cos(a) * k * 0.06 * uSpread + 0.015 * k * sin(uWave - k * 5.0 + aT.y);
  p.y += sin(a) * k * 0.06 * uSpread + 0.015 * k * cos(uWave * 0.9 - k * 4.0 + aT.y);
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const ARMS_FRAG = /* glsl */ `
${WATER}
uniform vec3 uColor;
varying vec3 vWorld;
varying float vAlong;
void main() {
  vec3 col = uColor * (lightAt(vWorld, vec3(0.0, 1.0, 0.0)) + vec3(0.01, 0.015, 0.02)) * (1.0 - 0.5 * vAlong);
  gl_FragColor = vec4(fogged(col, vWorld), 1.0);
}
`;
const GLOW_VERT = /* glsl */ `
uniform float uSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * 900.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGlow;
void main() {
  float d = length(gl_PointCoord - 0.5);
  gl_FragColor = vec4(uColor * (smoothstep(0.5, 0.0, d) * 0.3 + smoothstep(0.15, 0.0, d) * 1.5) * uGlow, 1.0);
}
`;

/** A squid's mantle (tip at +z, it jets tip-first), with diamond fins at the tip; about 0.3 long. */
function mantleGeometry() {
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 14; i++) {
    const u = i / 14;
    prof.push(new THREE.Vector2(Math.max(0.002, 0.035 * Math.sin(Math.PI * (0.15 + 0.85 * Math.pow(u, 0.7))) * (1 - 0.35 * u)), 0.3 * (1 - u)));
  }
  const body = new THREE.LatheGeometry(prof.reverse(), 12);
  body.rotateX(Math.PI / 2);
  const fins = new THREE.BufferGeometry();
  fins.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.3, 0.07, 0, 0.22, 0, 0, 0.14, 0, 0, 0.3, -0.07, 0, 0.22, 0, 0, 0.14], 3));
  fins.computeVertexNormals();
  const g = new THREE.BufferGeometry();
  const parts = [body.toNonIndexed(), fins];
  const cat = (name: string) => parts.flatMap((q) => [...(q.getAttribute(name).array as Float32Array)]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(cat('position'), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(cat('normal'), 3));
  return g;
}

/** Arms hanging back from the head (at z = 0, towards -z): eight short, two long tentacles. */
function armsGeometry(short: number, long: number) {
  const pos: number[] = [];
  const at: number[] = [];
  const segs = 10;
  for (let k = 0; k < 10; k++) {
    const len = k < 8 ? short : long;
    const a = (k / 8) * Math.PI * 2;
    for (let i = 0; i < segs; i++) {
      for (const j of [i, i + 1]) {
        const u = j / segs;
        pos.push(Math.cos(a) * 0.012, Math.sin(a) * 0.012, -u * len);
        at.push(u, k);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(at, 2));
  return g;
}

/**
 * Jetting: bursts of speed with a glide between. `surge` is how far ahead of (or behind) its steady
 * cruise the animal is after tau seconds (m, along its heading): the steady part, step·hz m/s, is in
 * its pass's own speed, so its closest approach stays where the pass put it.
 */
export function jet(tau: number, hz: number, step: number, ph: number) {
  const n = hz * tau + ph;
  const f = n - Math.floor(n);
  const push = f < 0.3 ? Math.sin((f / 0.3) * (Math.PI / 2)) : 1;
  const glide = f < 0.3 ? 0 : (f - 0.3) / 0.7;
  return { surge: step * (push * 0.8 + glide * 0.2 - f), squeeze: f < 0.3 ? Math.sin((f / 0.3) * Math.PI) : 0, glide };
}

export function buildSquid(U: WaterUniforms, depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const vampire = pop.species === 'vampire';
  const mantleGeo = mantleGeometry();
  const armsGeo = armsGeometry(vampire ? 0.16 : 0.1, vampire ? 0.2 : 0.35);
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
  const groups = pop.slots.map((slot) => {
    const n = vampire ? 1 : 4;
    const members = Array.from({ length: n }, (_, i) => {
      const mat = vampire
        ? creatureMaterial(U, { back: [0.22, 0.04, 0.05], belly: [0.3, 0.06, 0.07], sheen: 0.2, glow: 0.2, glowCol: [0.6, 0.1, 0.15] })
        : creatureMaterial(U, { back: [0.7, 0.32, 0.25], belly: [0.9, 0.7, 0.6], sheen: 0.5, glow: depth === 'abyss' ? 0.4 : 0, glowCol: [0.5, 0.8, 1.0] });
      const au = { ...U, uWave: { value: 0 }, uSpread: { value: 0.3 }, uColor: { value: new THREE.Vector3(...(vampire ? [0.25, 0.05, 0.06] : [0.7, 0.35, 0.28])) } };
      const g = new THREE.Group();
      g.add(new THREE.Mesh(mantleGeo, mat), new THREE.LineSegments(armsGeo, new THREE.ShaderMaterial({ vertexShader: ARMS_VERT, fragmentShader: ARMS_FRAG, uniforms: au })));
      // The vampire squid's light organs: two by the fins and one at each arm tip.
      let glowU: { uColor: { value: THREE.Vector3 }; uGlow: { value: number }; uSize: { value: number } } | null = null;
      if (vampire) {
        const pts: number[] = [0.04, 0, 0.24, -0.04, 0, 0.24];
        for (let k = 0; k < 8; k++) pts.push(Math.cos((k / 8) * 6.28) * 0.06, Math.sin((k / 8) * 6.28) * 0.06, -0.16);
        glowU = { uColor: { value: new THREE.Vector3(0.35, 0.7, 1.0) }, uGlow: { value: 1 }, uSize: { value: 0.025 } };
        g.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), new THREE.ShaderMaterial({ vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, uniforms: glowU, ...add })));
      }
      group.add(g);
      return { g, mat, au, glowU, off: [(i % 2) * 0.6 - 0.3, (i - 1.5) * 0.25, (i % 3) * 0.4 - 0.4] };
    });
    return { slot, members };
  });
  return {
    group,
    update(t, L, s) {
      for (const { slot, members } of groups) {
        const ps = passState(pop, slot, s, D, v, { clear: 2.3, spread: 2.5, yMin: -2.5, yMax: 2.5, speed: vampire ? [0.04, 0.1] : [0.2, 0.3] });
        members.forEach((m, i) => {
          m.g.visible = ps.visible;
          if (!ps.visible) return;
          const j = jet(ps.tau, vampire ? 0.12 : 0.45 + 0.1 * i, vampire ? 0.15 : 0.35, ps.h(20 + i));
          const p = ps.pos.clone().addScaledVector(ps.heading, j.surge);
          m.g.position.set(p.x + m.off[0], p.y + m.off[1], p.z + m.off[2]);
          face(m.g, ps.heading);
          m.g.scale.setScalar(vampire ? 1.6 + ps.h(10) : 0.9 + 0.5 * ps.h(10 + i));
          // The mantle squeezes on each jet; the arms draw together, then splay as it glides.
          m.g.scale.x *= 1 - 0.15 * j.squeeze;
          m.au.uSpread.value = vampire ? 0.6 + 0.4 * Math.sin(beat(0.08, t, L) + ps.h(12) * 6.28) : 0.15 + 0.5 * (1 - j.squeeze);
          m.au.uWave.value = beat(0.8, t, L) + i;
          // Chromatophores: colour flickering slowly across the body.
          if (!vampire) {
            const f = 0.75 + 0.25 * Math.sin(beat(0.3, t, L) + i * 2.1 + ps.h(13) * 6.28);
            m.mat.uniforms.uBack.value.set(0.7 * f, 0.32 * f, 0.25 * f);
          }
          if (m.glowU) m.glowU.uGlow.value = 0.6 + 0.4 * Math.sin(beat(0.15, t, L) + ps.h(14) * 6.28);
        });
      }
    },
  };
}
