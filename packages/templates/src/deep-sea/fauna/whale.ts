/**
 * A humpback whale passing far off in the fog, singing (schedule.ts passes): a silhouette with long
 * pectoral fins, its body beating slowly up and down towards the flukes.
 */
import { THREE } from '../../three-layer';
import { WATER, type WaterUniforms } from '../water';
import { passAt, type Pass } from '../schedule';
import type { Fauna } from './kit';

const SIL_FRAG = /* glsl */ `
${WATER}
uniform vec3 uColor;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 col = uColor * (lightAt(vWorld, n) + vec3(0.003, 0.005, 0.008));
  gl_FragColor = vec4(fogged(col, vWorld), 1.0);
}
`;
const SIL_VERT = /* glsl */ `
uniform float uBend;    // body undulation
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 p = position;
  // A slow up-and-down beat towards the flukes (the body lies along +z).
  p.y += uBend * smoothstep(0.0, -1.0, p.z / 7.0) * (p.z * p.z) * 0.012;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

function whaleGeometry() {
  // A humpback's shape, nose at +z: a long tapering body, long pectoral fins, flukes.
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    const r = Math.sin(Math.PI * Math.pow(u, 0.7)) * 1.6 * (1 - 0.6 * u * u * u);
    prof.push(new THREE.Vector2(Math.max(0.02, r), 7 - u * 14));
  }
  const body = new THREE.LatheGeometry(prof, 20);
  body.rotateX(Math.PI / 2);
  body.scale(1, 0.8, 1);
  const fin = new THREE.BoxGeometry(4.5, 0.12, 1.1);
  const finL = fin.clone();
  finL.rotateZ(-0.35);
  finL.translate(-2.8, -0.6, 3.2);
  const finR = fin.clone();
  finR.rotateZ(0.35);
  finR.translate(2.8, -0.6, 3.2);
  const flukes = new THREE.BoxGeometry(4.6, 0.1, 1.4);
  flukes.translate(0, 0, -7.2);
  const parts = [body, finL, finR, flukes].map((g) => g.toNonIndexed());
  const g = new THREE.BufferGeometry();
  const cat = (name: string) => parts.flatMap((p) => [...(p.getAttribute(name).array as Float32Array)]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(cat('position'), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(cat('normal'), 3));
  return g;
}

export function buildWhales(U: WaterUniforms, passes: Pass[]): Fauna {
  const group = new THREE.Group();
  const mat = new THREE.ShaderMaterial({ vertexShader: SIL_VERT, fragmentShader: SIL_FRAG, uniforms: { ...U, uColor: { value: new THREE.Vector3(0.35, 0.38, 0.42) }, uBend: { value: 0 } } });
  const whale = new THREE.Mesh(whaleGeometry(), mat);
  whale.visible = false;
  group.add(whale);
  return {
    group,
    update(t, L) {
      const w = passes.map((p) => ({ p, at: passAt(p, t) })).find((x) => x.at);
      whale.visible = !!w;
      if (!w?.at) return;
      whale.position.set(...w.at);
      const ahead = passAt(w.p, Math.min(w.p.t1, t + 1)) ?? w.at;
      const dir = new THREE.Vector3(ahead[0] - w.at[0], ahead[1] - w.at[1], ahead[2] - w.at[2]);
      if (dir.lengthSq() > 1e-6) whale.lookAt(whale.position.clone().add(dir));
      mat.uniforms.uBend.value = Math.sin((2 * Math.PI * Math.round(L / 9) * t) / L) * 3;
    },
  };
}
