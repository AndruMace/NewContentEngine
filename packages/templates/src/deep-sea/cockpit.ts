/**
 * The submarine's cockpit (static, and dim): the big acrylic dome in its riveted ring, the curved
 * instrument console below it (sonar scope, backlit dials and meters, a depth readout, toggles) with
 * a control handle either side, side walls with pipes, a valve wheel, cable runs, a breaker panel and
 * a fire extinguisher, and an overhead switch panel with a dim red night light. The instruments'
 * green glow is most of the light.
 */
import { THREE } from '../three-layer';
import { model, textureMaterial } from '../ambient/assets';
import { CONSOLE, DOME } from './layout';
import { instrumentKit, type Instruments } from './instruments';
import type { WaterUniforms } from './water';

const GLASS_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const GLASS_FRAG = /* glsl */ `
uniform vec3 uEye;
uniform vec3 uGlowAt;    // where the console's green glow is (it reflects in the dome)
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 v = normalize(uEye - vWorld);
  vec3 n = normalize(vNormal);
  float fres = pow(1.0 - abs(dot(n, v)), 4.0);
  // The thick acrylic shows at its edge; the console's glow reflects low in the dome.
  vec3 r = reflect(-v, n);
  float glow = pow(max(0.0, dot(r, normalize(uGlowAt - vWorld))), 24.0);
  vec3 col = vec3(0.04, 0.06, 0.07) * fres + vec3(0.01, 0.04, 0.02) * glow * fres;
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface Cockpit {
  group: THREE.Group;
  instruments: Instruments;
  /** Where the instruments glow from (for small green lights) and the red night light. */
  glowAt: THREE.Vector3[];
  nightLight: THREE.Vector3;
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

export function buildCockpit(U: WaterUniforms): Cockpit {
  const group = new THREE.Group();
  const hull = textureMaterial('rusty_painted_metal', [1.6, 1.6], { metalness: 0.4, roughness: 0.75, color: 0x5a6a70 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x40484c, metalness: 0.6, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15191b, metalness: 0.4, roughness: 0.6 });
  const brass = new THREE.MeshStandardMaterial({ color: 0x8a6c3c, metalness: 0.7, roughness: 0.4 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.9 });
  const [cx, cy, cz] = DOME.c;
  const R = DOME.r;

  // ---- the front bulkhead and the dome ring ----
  const wall = new THREE.Shape();
  wall.moveTo(-2.4, -0.4);
  wall.lineTo(2.4, -0.4);
  wall.lineTo(2.4, 2.8);
  wall.lineTo(-2.4, 2.8);
  const hole = new THREE.Path();
  hole.absarc(cx, cy, R, 0, Math.PI * 2, true);
  wall.holes.push(hole);
  const wg = new THREE.ShapeGeometry(wall, 72);
  const uv = wg.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.7, uv.getY(i) * 0.7);
  const bulkhead = new THREE.Mesh(wg, hull);
  bulkhead.position.z = cz;
  group.add(bulkhead);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R + 0.05, 0.07, 18, 128), steel);
  ring.position.set(cx, cy, cz + 0.02);
  group.add(ring);
  const flange = new THREE.Mesh(new THREE.RingGeometry(R + 0.1, R + 0.26, 96), steel);
  flange.position.set(cx, cy, cz + 0.01);
  group.add(flange);
  const bolt = new THREE.CylinderGeometry(0.016, 0.016, 0.025, 6);
  bolt.rotateX(Math.PI / 2);
  const nB = 40;
  const bolts = new THREE.InstancedMesh(bolt, brass, nB);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < nB; i++) {
    const a = (i / nB) * Math.PI * 2;
    m4.makeTranslation(cx + Math.cos(a) * (R + 0.18), cy + Math.sin(a) * (R + 0.18), cz + 0.025);
    bolts.setMatrixAt(i, m4);
  }
  group.add(bolts);
  // The acrylic dome itself: a hemisphere bulging forward, nearly invisible but for its edge.
  const domeGeo = new THREE.SphereGeometry(R, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2);
  domeGeo.rotateX(-Math.PI / 2);
  const glassU = { uEye: U.uEye, uGlowAt: { value: new THREE.Vector3(0, CONSOLE.y, CONSOLE.z0 + 0.2) } };
  const dome = new THREE.Mesh(domeGeo, new THREE.ShaderMaterial({ vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, uniforms: glassU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  dome.position.set(cx, cy, cz);
  dome.renderOrder = 20;
  group.add(dome);

  // ---- side walls, angled in towards the dome, and the ceiling ----
  for (const sx of [-1, 1]) {
    const side = box(0.06, 2.6, 1.8, hull, sx * 1.55, 1.1, 0.2);
    side.rotation.y = sx * 0.35;
    group.add(side);
  }
  group.add(box(3.4, 0.06, 1.8, dark, 0, 2.3, 0.2));

  // ---- the console ----
  const kit = instrumentKit(brass, dark);
  // A desk across the bottom of the dome, its face tilted up to the pilot (two wings angled in).
  const desk = new THREE.Group();
  desk.position.set(0, CONSOLE.y, (CONSOLE.z0 + CONSOLE.z1) / 2 - 0.08);
  desk.rotation.x = -1.0;
  group.add(desk);
  const centre = box(0.9, 0.5, 0.05, dark, 0, 0, -0.025);
  desk.add(centre);
  kit.scope(desk, 0, 0.06, 0.13);
  kit.readout(desk, 0, -0.16, 0.34, ['DEPTH  0412 M', 'HDG 274  1.5 KN']);
  kit.dial(desk, -0.3, 0.1, 0.075, 'TRIM', false, 0.1, 0.04, 1 / 31);
  kit.dial(desk, 0.3, 0.1, 0.075, 'AMPS', true, -0.4, 0.05, 1 / 19);
  kit.toggles(desk, -0.38, -0.21, 6, 0.04);
  kit.toggles(desk, 0.18, -0.21, 6, 0.04);
  for (const sx of [-1, 1]) {
    const wing = new THREE.Group();
    wing.position.set(sx * 0.68, 0.02, 0.06);
    wing.rotation.y = -sx * 0.45;
    desk.add(wing);
    wing.add(box(0.5, 0.46, 0.05, dark, 0, 0, -0.025));
    kit.dial(wing, -0.11, 0.1, 0.085, sx < 0 ? 'DEPTH' : 'PRESS', sx > 0, sx < 0 ? 0.4 : -0.3, 0.03, sx < 0 ? 1 / 41 : 1 / 23);
    kit.dial(wing, 0.12, 0.1, 0.085, sx < 0 ? 'O2' : 'CO2', false, sx < 0 ? 0.6 : -0.7, 0.04, sx < 0 ? 1 / 29 : 1 / 37);
    kit.meter(wing, -0.11, -0.08, 0.16, sx < 0 ? 'BATT' : 'BALLAST', 0.1, 0.06, 1 / 17);
    kit.meter(wing, 0.12, -0.08, 0.16, sx < 0 ? 'THRUST' : 'HULL', -0.2, 0.08, 1 / 13);
    kit.lamps(wing, -0.19, -0.19, 9, 0.045);
  }
  // Control handles either side, close to the pilot.
  for (const sx of [-1, 1]) {
    const base = box(0.12, 0.05, 0.12, dark, sx * 0.62, CONSOLE.y - 0.08, CONSOLE.z1 - 0.05);
    group.add(base);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.2, 12), steel);
    stick.position.set(sx * 0.62, CONSOLE.y + 0.04, CONSOLE.z1 - 0.06);
    stick.rotation.x = 0.25;
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.07, 6, 12), rubber);
    grip.position.set(sx * 0.62, CONSOLE.y + 0.15, CONSOLE.z1 - 0.03);
    grip.rotation.x = 0.25;
    const button = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), new THREE.MeshStandardMaterial({ color: 0x601010, emissive: new THREE.Color(0xff3020), emissiveIntensity: 0.15 }));
    button.position.set(sx * 0.62, CONSOLE.y + 0.2, CONSOLE.z1 - 0.02);
    group.add(stick, grip, button);
  }

  // ---- the side walls' equipment ----
  for (const sx of [-1, 1]) {
    const x = sx * 1.32;
    // Pipes running up beside the dome, with brackets.
    for (const dz of [-0.3, -0.18]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.4, 14), sx < 0 ? brass : steel);
      pipe.position.set(x - sx * 0.06, 1.1, dz);
      group.add(pipe);
    }
    for (const y of [0.5, 1.2, 1.9]) group.add(box(0.14, 0.03, 0.2, steel, x - sx * 0.06, y, -0.24));
    // Cable runs.
    for (let k = 0; k < 4; k++) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 2.2, 6), new THREE.MeshStandardMaterial({ color: [0x1a1a1a, 0x5a1010, 0x0e2a50, 0x1a1a1a][k], roughness: 0.8 }));
      c.position.set(x + sx * 0.04, 1.1, 0.05 + k * 0.02);
      group.add(c);
    }
  }
  // Left: a valve wheel and a fire extinguisher. Right: a breaker panel and the pipe work.
  const wheel = new THREE.Group();
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.012, 10, 32), brass));
  for (let k = 0; k < 4; k++) {
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.22, 6), brass);
    spoke.rotation.z = (k * Math.PI) / 4;
    wheel.add(spoke);
  }
  wheel.position.set(-1.22, 1.55, 0.05);
  wheel.rotation.y = 0.35 + Math.PI / 2;
  group.add(wheel);
  const ext = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 20), new THREE.MeshStandardMaterial({ color: 0x8a1410, roughness: 0.4, metalness: 0.2 }));
  ext.position.set(-1.25, 0.55, 0.2);
  group.add(ext);
  const breaker = new THREE.Group();
  breaker.position.set(1.24, 1.45, 0.1);
  breaker.rotation.y = -0.35 - Math.PI / 2;
  breaker.add(box(0.36, 0.5, 0.04, dark, 0, 0, -0.02));
  kit.toggles(breaker, -0.13, 0.15, 7, 0.04);
  kit.toggles(breaker, -0.13, 0.02, 7, 0.04);
  kit.lamps(breaker, -0.13, -0.12, 7, 0.04);
  group.add(breaker);
  const pipes = model('modular_industrial_pipes_01');
  pipes.position.set(1.4, 0.4, 0.4);
  pipes.rotation.y = -Math.PI / 2;
  pipes.scale.setScalar(0.8);
  group.add(pipes);

  // ---- overhead: a switch panel along the top of the ring, and the red night light ----
  const over = new THREE.Group();
  over.position.set(0, cy + R + 0.22, cz + 0.25);
  over.rotation.x = 0.9;
  over.add(box(1.2, 0.22, 0.05, dark, 0, 0, -0.025));
  kit.toggles(over, -0.5, 0.04, 12, 0.045);
  kit.lamps(over, -0.5, -0.06, 12, 0.045);
  group.add(over);
  const night = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), new THREE.MeshStandardMaterial({ color: 0x300808, emissive: new THREE.Color(0xff2010), emissiveIntensity: 0.35 }));
  const nightLight = new THREE.Vector3(0, 2.2, 0.35);
  night.position.copy(nightLight);
  group.add(night);

  return {
    group,
    instruments: kit.out,
    // The console's glow, and a little spill onto the side walls' pipes and panels.
    glowAt: [
      new THREE.Vector3(-0.6, CONSOLE.y + 0.15, CONSOLE.z0 + 0.3),
      new THREE.Vector3(0.6, CONSOLE.y + 0.15, CONSOLE.z0 + 0.3),
      new THREE.Vector3(0, CONSOLE.y + 0.1, CONSOLE.z0 + 0.25),
      new THREE.Vector3(-1.05, 1.45, 0.05),
      new THREE.Vector3(1.05, 1.45, 0.05),
    ],
    nightLight,
  };
}
