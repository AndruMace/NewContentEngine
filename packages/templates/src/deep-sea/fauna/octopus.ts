/**
 * Octopuses: in the twilight zone a red octopus jetting by mantle first, its arms snapping together
 * on each stroke and trailing open as it glides; in the abyss the dumbo octopus, hovering upright on
 * its flapping ear fins, the web between its arms opening and closing like an umbrella.
 *
 * The arms (and the dumbo's web) are one mesh the GPU shapes: each arm leaves the head in a cone
 * that opens with uSpread, its tip curling in a wave that runs out along it.
 */
import { THREE } from '../../three-layer';
import type { WaterUniforms } from '../water';
import type { Depth, Population } from '../schedule';
import { jet } from './cephalopods';
import { CREATURE_FRAG, beat, creatureMaterial, face, passState, type Fauna } from './kit';

const ARMS_VERT = /* glsl */ `
attribute vec4 aArm;     // angle round the head, along (0 base .. 1 tip), angle round the arm, thickness (0 for the web)
uniform float uSpread;   // 0 trailing together .. 1 opened wide
uniform float uLen;
uniform float uWave;
uniform float uCurl;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  float a = aArm.x;
  float u = aArm.y;
  // The cone the arms leave the head in (from straight back to wide open), each arm curling a little
  // more towards its tip, in a wave running out along it.
  float th = mix(0.1, 1.35, uSpread) + uCurl * u * u * (0.6 + 0.4 * sin(uWave - u * 5.0 + a * 3.0));
  float sway = 0.07 * u * u * sin(uWave * 0.7 - u * 4.0 + a * 1.7);
  vec3 R = vec3(cos(a), sin(a), 0.0);
  vec3 T = vec3(-sin(a), cos(a), 0.0);
  vec3 p = R * (0.045 + uLen * u * sin(th)) + T * uLen * sway + vec3(0.0, 0.0, -0.03 - uLen * u * cos(th));
  // Round the arm (its outward side faces away from the cone's axis).
  vec3 out1 = normalize(R * cos(th) + vec3(0.0, 0.0, sin(th)));
  vec3 n = cos(aArm.z) * out1 + sin(aArm.z) * T;
  p += n * (0.032 * pow(1.0 - u, 1.3) + 0.003) * aArm.w;
  vec3 nn = aArm.w > 0.5 ? n : out1;
  vLocal = p;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * nn);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Eight arms (tubes of `seg` rings) and, if `web` > 0, a web between them out to that far along. */
function armsGeometry(web: number) {
  const segs = 18;
  const round = 6;
  const pos: number[] = [];
  const arm: number[] = [];
  const idx: number[] = [];
  const vert = (a: number, u: number, phi: number, w: number) => {
    arm.push(a, u, phi, w);
    pos.push(0, 0, 0);
    return pos.length / 3 - 1;
  };
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const base = pos.length / 3;
    for (let i = 0; i <= segs; i++) for (let j = 0; j < round; j++) vert(a, i / segs, (j / round) * Math.PI * 2, 1);
    for (let i = 0; i < segs; i++)
      for (let j = 0; j < round; j++) {
        const q = base + i * round;
        const [a0, a1, b0, b1] = [q + j, q + ((j + 1) % round), q + round + j, q + round + ((j + 1) % round)];
        idx.push(a0, b0, a1, a1, b0, b1);
      }
  }
  if (web > 0) {
    // The web: a skirt round the cone, scalloped between the arms (it reaches less far there).
    const ring = 64;
    const rows = 8;
    const base = pos.length / 3;
    for (let i = 0; i <= rows; i++)
      for (let j = 0; j <= ring; j++) {
        const a = (j / ring) * Math.PI * 2 + Math.PI / 8;
        const scallop = 1 - 0.3 * Math.pow(Math.abs(Math.sin(((a - Math.PI / 8) * 8) / 2)), 1.5);
        vert(a, (i / rows) * web * scallop, 0, 0);
      }
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < ring; j++) {
        const q = base + i * (ring + 1) + j;
        idx.push(q, q + ring + 1, q + 1, q + 1, q + ring + 1, q + ring + 2);
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aArm', new THREE.Float32BufferAttribute(arm, 4));
  g.setIndex(idx);
  return g;
}

/** The head and mantle (mantle towards +z, the head where the arms begin at z = 0), about 0.3 long. */
function headGeometry(dumbo: boolean) {
  const prof: THREE.Vector2[] = [];
  const len = dumbo ? 0.2 : 0.26;
  for (let i = 0; i <= 20; i++) {
    const u = i / 20;
    // A bulbous mantle, then the head, a little narrower, where the eyes and arms are.
    const mantle = (dumbo ? 0.085 : 0.075) * Math.sin(Math.PI * Math.pow(Math.min(1, u / 0.72), 0.75));
    const head = u > 0.55 ? (dumbo ? 0.06 : 0.05) + 0.008 * Math.sin((Math.PI * (u - 0.55)) / 0.45) : 0;
    prof.push(new THREE.Vector2(Math.max(0.003, mantle, head), len * (1 - u)));
  }
  const g = new THREE.LatheGeometry(prof.reverse(), 18);
  g.rotateX(Math.PI / 2);
  return g;
}

export function buildOctopuses(U: WaterUniforms, _depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const dumbo = pop.species === 'dumbo';
  const armsGeo = armsGeometry(dumbo ? 0.55 : 0.12);
  const headGeo = headGeometry(dumbo);
  const eyeGeo = new THREE.SphereGeometry(0.016, 10, 8);
  const finGeo = new THREE.CircleGeometry(1, 20);
  finGeo.scale(0.06, 0.035, 1);
  finGeo.translate(0.06, 0, 0);
  const look = dumbo
    ? { back: [0.8, 0.5, 0.45], belly: [0.95, 0.75, 0.68], sheen: 0.35, glow: 0.08, glowCol: [0.9, 0.5, 0.45] }
    : { back: [0.62, 0.16, 0.1], belly: [0.82, 0.45, 0.35], pattern: 2 as const, patCol: [0.95, 0.65, 0.5], patScale: 40, sheen: 0.45 };
  const eyeMat = creatureMaterial(U, { back: [0.03, 0.03, 0.03], belly: [0.05, 0.05, 0.04], sheen: 1 });
  const octos = pop.slots.map((slot) => {
    const body = creatureMaterial(U, look);
    const arms = creatureMaterial(U, look);
    arms.vertexShader = ARMS_VERT;
    arms.fragmentShader = CREATURE_FRAG;
    arms.side = THREE.DoubleSide;
    Object.assign(arms.uniforms, { uSpread: { value: 0.3 }, uLen: { value: dumbo ? 0.2 : 0.42 }, uWave: { value: 0 }, uCurl: { value: dumbo ? 0.5 : 0.9 } });
    const g = new THREE.Group();
    const head = new THREE.Mesh(headGeo, body);
    g.add(head, new THREE.Mesh(armsGeo, arms));
    for (const x of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(x * (dumbo ? 0.05 : 0.055), 0.02, 0.03);
      g.add(eye);
    }
    // The dumbo's ear fins, on pivots either side of the mantle.
    const fins = dumbo
      ? [-1, 1].map((x) => {
          const pivot = new THREE.Object3D();
          pivot.position.set(x * 0.06, 0, 0.13);
          const fin = new THREE.Mesh(finGeo, body);
          if (x < 0) fin.rotation.z = Math.PI;
          pivot.add(fin);
          g.add(pivot);
          return { pivot, side: x };
        })
      : [];
    if (dumbo) body.side = THREE.DoubleSide;
    group.add(g);
    return { slot, g, head, arms, fins };
  });
  const up = new THREE.Vector3(0, 1, 0);
  return {
    group,
    update(t, L, s) {
      for (const { slot, g, head, arms, fins } of octos) {
        const ps = dumbo
          ? passState(pop, slot, s, D, v, { clear: 1.9, spread: 2, yMin: -2, yMax: 1.5, speed: [0.03, 0.08] })
          : passState(pop, slot, s, D, v, { clear: 2.2, spread: 2.5, yMin: -2.5, yMax: 2, speed: [0.18, 0.3] });
        g.visible = ps.visible;
        if (!ps.visible) continue;
        const au = arms.uniforms;
        au.uWave.value = beat(dumbo ? 0.25 : 0.4, t, L) + ps.h(12) * 6.28;
        if (dumbo) {
          // Upright, leaning into where it drifts; the web opens and closes slowly, the fins flap.
          g.position.copy(ps.pos);
          const pulse = Math.sin(beat(0.12, t, L) + ps.h(13) * 6.28);
          g.position.y += 0.08 * pulse;
          face(g, ps.heading.clone().multiplyScalar(0.6).add(up).normalize());
          g.rotateZ(0.3 * Math.sin(beat(0.04, t, L) + ps.h(14) * 6.28));
          g.scale.setScalar(1.4 + 0.8 * ps.h(10));
          au.uSpread.value = 0.62 + 0.22 * pulse;
          const flap = beat(0.45, t, L) + ps.h(15) * 6.28;
          for (const f of fins) f.pivot.rotation.y = -f.side * (0.2 + 0.55 * Math.sin(flap));
          head.scale.set(1, 1, 1 + 0.04 * pulse);
        } else {
          // Jetting mantle first: a squeeze drives it on, the arms snap together, then trail open.
          const j = jet(ps.tau, 0.22, 0.6, ps.h(13));
          g.position.copy(ps.pos).addScaledVector(ps.heading, j.surge);
          face(g, ps.heading);
          g.rotateZ(0.2 * Math.sin(beat(0.05, t, L) + ps.h(14) * 6.28));
          g.scale.setScalar(1.3 + 0.7 * ps.h(10));
          au.uSpread.value = 0.08 + 0.27 * (1 - j.squeeze) * (0.5 + 0.5 * j.glide);
          head.scale.set(1 - 0.18 * j.squeeze, 1 - 0.18 * j.squeeze, 1 + 0.08 * j.squeeze);
          // Colour shifts as it goes (paler as it glides).
          const f = 0.85 + 0.15 * Math.sin(beat(0.2, t, L) + ps.h(16) * 6.28);
          for (const m of [head.material as THREE.ShaderMaterial, arms]) m.uniforms.uBack.value.set(0.62 * f, 0.16 * f, 0.1 * f);
        }
      }
    },
  };
}
