/**
 * The station's interior around the porthole (static, and dim): the painted steel hull with its
 * plate seams and ribs, the porthole's deep bore with a riveted flange and rim, and two instrument
 * panels whose backlit green dials, strip meters, indicator lamps and sonar scope are the room's
 * main light. A small wall lamp glows low; a console ledge holds a logbook and a mug. Needles,
 * blinking lamps and the sonar sweep move (see view3d).
 */
import { THREE, canvasTexture } from '../three-layer';
import { model, textureMaterial } from '../ambient/assets';
import { PANELS, PORT, WALL } from './layout';

const GLOW = '#7dffb0';

function plate(w: number, h: number, mat: THREE.Material, x: number, y: number, z: number, d = 0.04) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** A round dial face, dark with luminous green ticks and a label (used as map and emissive map). */
function dialFace(label: string, red: boolean) {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = '#06120c';
    g.beginPath();
    g.arc(128, 128, 124, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = GLOW;
    for (let i = 0; i <= 30; i++) {
      const a = Math.PI * 0.75 + (i / 30) * Math.PI * 1.5;
      const big = i % 5 === 0;
      g.lineWidth = big ? 4 : 1.5;
      g.beginPath();
      g.moveTo(128 + Math.cos(a) * (big ? 86 : 96), 128 + Math.sin(a) * (big ? 86 : 96));
      g.lineTo(128 + Math.cos(a) * 106, 128 + Math.sin(a) * 106);
      g.stroke();
    }
    if (red) {
      g.strokeStyle = '#ff7050';
      g.lineWidth = 6;
      g.beginPath();
      g.arc(128, 128, 101, Math.PI * 0.75 + Math.PI * 1.25, Math.PI * 0.75 + Math.PI * 1.5);
      g.stroke();
    }
    g.fillStyle = GLOW;
    g.font = 'bold 24px monospace';
    g.textAlign = 'center';
    g.fillText(label, 128, 186);
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI * 0.75 + (i / 6) * Math.PI * 1.5;
      g.font = '15px monospace';
      g.fillText(String(i * 10), 128 + Math.cos(a) * 68, 134 + Math.sin(a) * 68);
    }
  });
}

/** A strip meter's face: a green arc scale on black, with a label. */
function meterFace(label: string) {
  return canvasTexture(256, 144, (g) => {
    g.fillStyle = '#050f0a';
    g.fillRect(0, 0, 256, 144);
    g.strokeStyle = GLOW;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(128, 150, 110, Math.PI * 1.2, Math.PI * 1.8);
    g.stroke();
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI * 1.2 + (i / 10) * Math.PI * 0.6;
      g.lineWidth = i % 5 === 0 ? 3 : 1.5;
      g.beginPath();
      g.moveTo(128 + Math.cos(a) * 110, 150 + Math.sin(a) * 110);
      g.lineTo(128 + Math.cos(a) * (i % 5 === 0 ? 92 : 100), 150 + Math.sin(a) * (i % 5 === 0 ? 92 : 100));
      g.stroke();
    }
    g.fillStyle = GLOW;
    g.font = 'bold 20px monospace';
    g.textAlign = 'center';
    g.fillText(label, 128, 128);
  });
}

/** Backlit: the face is its own light, faint enough to sit in a dark room. */
const backlit = (tex: THREE.Texture, strength: number) =>
  new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(0xc8ffd8), emissiveIntensity: strength, roughness: 0.35 });

// ---- the sonar scope: a phosphor screen with a sweep, rings and a few echoes ------------------------------
const SCOPE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const SCOPE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uSweep;   // sweep angle (radians)
uniform float uGlow;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  // Phosphor: brightest just behind the sweep, fading round the circle.
  float behind = mod(uSweep - a, 6.28318);
  float trail = exp(-behind / 0.5);
  float rings = smoothstep(0.02, 0.0, abs(fract(r * 4.0) - 0.5) - 0.48) * 0.25;
  float cross = (smoothstep(0.008, 0.0, abs(p.x)) + smoothstep(0.008, 0.0, abs(p.y))) * 0.15;
  // Echoes: fixed specks that light as the sweep passes them.
  float echo = 0.0;
  for (int i = 0; i < 7; i++) {
    vec2 e = vec2(hash(vec2(float(i), 1.0)), hash(vec2(float(i), 2.0))) * 1.4 - 0.7;
    float ea = atan(e.y, e.x);
    float age = mod(uSweep - ea, 6.28318);
    echo += smoothstep(0.05, 0.0, length(p - e)) * exp(-age / 2.5);
  }
  vec3 col = vec3(0.2, 1.0, 0.5) * (0.015 + trail * 0.3 * smoothstep(1.0, 0.15, r) + rings * 0.5 + cross * 0.5 + echo * 0.8);
  col *= smoothstep(1.0, 0.94, r);
  gl_FragColor = vec4(col * uGlow, 1.0);
}
`;

export interface Needle {
  pivot: THREE.Object3D;
  base: number;
  amp: number;
  /** Rough wanders per second (made whole cycles per loop). */
  hz: number;
}

export interface Station {
  group: THREE.Group;
  needles: Needle[];
  /** Indicator lamps that blink, and the sonar's sweep uniform. */
  blinkers: { mat: THREE.MeshStandardMaterial; hz: number; on: number }[];
  scope: { uSweep: { value: number }; uGlow: { value: number } };
  lampAt: THREE.Vector3;
  lampGlass: THREE.MeshStandardMaterial;
  /** Where the instruments' green glow comes from (for small lights). */
  glowAt: THREE.Vector3[];
}

export function buildStation(): Station {
  const group = new THREE.Group();
  const hull = textureMaterial('rusty_painted_metal', [1.4, 1.4], { metalness: 0.4, roughness: 0.75, color: 0x7a8a90 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x4c5458, metalness: 0.6, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1e20, metalness: 0.4, roughness: 0.6 });
  const brass = new THREE.MeshStandardMaterial({ color: 0x8a6c3c, metalness: 0.7, roughness: 0.4 });
  const needleMat = new THREE.MeshStandardMaterial({ color: 0x402010, emissive: new THREE.Color(0xffa050), emissiveIntensity: 0.5 });

  // The hull face with the porthole's hole.
  const wall = new THREE.Shape();
  wall.moveTo(-3, -0.5);
  wall.lineTo(3, -0.5);
  wall.lineTo(3, 3.2);
  wall.lineTo(-3, 3.2);
  const hole = new THREE.Path();
  hole.absarc(PORT.x, PORT.y, PORT.r, 0, Math.PI * 2, true);
  wall.holes.push(hole);
  const wg = new THREE.ShapeGeometry(wall, 64);
  const uv = wg.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.7, uv.getY(i) * 0.7);
  const wm = new THREE.Mesh(wg, hull);
  wm.position.z = WALL;
  wm.receiveShadow = true;
  group.add(wm);
  for (const x of [-2.0, 2.0]) group.add(plate(0.14, 3.7, steel, x, 1.35, WALL + 0.04));
  group.add(plate(6, 0.1, steel, 0, 2.85, WALL + 0.03));
  group.add(plate(6, 0.1, steel, 0, 0.0, WALL + 0.03));

  // The bore, flange, rivets and rim.
  const boreMat = steel.clone();
  boreMat.side = THREE.BackSide;
  const bore = new THREE.Mesh(new THREE.CylinderGeometry(PORT.r, PORT.r, PORT.depth, 72, 1, true), boreMat);
  bore.rotation.x = Math.PI / 2;
  bore.position.set(PORT.x, PORT.y, WALL - PORT.depth / 2);
  group.add(bore);
  const flange = new THREE.Mesh(new THREE.RingGeometry(PORT.r + 0.02, PORT.r + 0.2, 72), steel);
  flange.position.set(PORT.x, PORT.y, WALL + 0.012);
  group.add(flange);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(PORT.r + 0.025, 0.04, 16, 112), brass);
  rim.position.set(PORT.x, PORT.y, WALL + 0.03);
  group.add(rim);
  const rivet = new THREE.SphereGeometry(0.02, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  rivet.rotateX(Math.PI / 2);
  const nR = 32;
  const rivets = new THREE.InstancedMesh(rivet, brass, nR);
  const m = new THREE.Matrix4();
  for (let i = 0; i < nR; i++) {
    const a = (i / nR) * Math.PI * 2;
    m.makeTranslation(PORT.x + Math.cos(a) * (PORT.r + 0.13), PORT.y + Math.sin(a) * (PORT.r + 0.13), WALL + 0.015);
    rivets.setMatrixAt(i, m);
  }
  group.add(rivets);

  // The console ledge below, with a logbook and a mug.
  const ledge = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.05, 0.42), steel);
  ledge.position.set(0, 0.35, WALL + 0.21);
  ledge.castShadow = ledge.receiveShadow = true;
  group.add(ledge);
  const book = plate(0.26, 0.035, new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.9 }), -0.5, 0.392, WALL + 0.22, 0.34);
  book.rotation.y = 0.15;
  group.add(book);
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.038, 0.1, 24), new THREE.MeshStandardMaterial({ color: 0x6a2a20, roughness: 0.6 }));
  mug.position.set(0.45, 0.425, WALL + 0.2);
  group.add(mug);

  // ---- instrument panels: dark steel boards either side of the porthole ----
  const needles: Needle[] = [];
  const blinkers: Station['blinkers'] = [];
  const glowAt: THREE.Vector3[] = [];
  const dial = (x: number, y: number, r: number, label: string, red: boolean, base: number, amp: number, hz: number) => {
    const face = new THREE.Mesh(new THREE.CircleGeometry(r, 48), backlit(dialFace(label, red), 0.55));
    face.position.set(x, y, WALL + 0.065);
    group.add(face);
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(r + 0.004, 0.011, 10, 48), brass);
    bezel.position.set(x, y, WALL + 0.066);
    group.add(bezel);
    const nd = new THREE.Mesh(new THREE.BoxGeometry(0.005, r * 0.85, 0.003), needleMat);
    nd.geometry.translate(0, r * 0.38, 0);
    const pivot = new THREE.Object3D();
    pivot.position.set(x, y, WALL + 0.07);
    pivot.add(nd);
    group.add(pivot);
    needles.push({ pivot, base, amp, hz });
  };
  const meter = (x: number, y: number, label: string, base: number, amp: number, hz: number) => {
    const w = 0.18;
    const h = 0.1;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), backlit(meterFace(label), 0.5));
    face.position.set(x, y, WALL + 0.065);
    group.add(face);
    group.add(plate(w + 0.025, h + 0.025, dark, x, y, WALL + 0.055, 0.015));
    const nd = new THREE.Mesh(new THREE.BoxGeometry(0.003, h * 0.85, 0.002), needleMat);
    nd.geometry.translate(0, h * 0.42, 0);
    const pivot = new THREE.Object3D();
    pivot.position.set(x, y - h * 0.5, WALL + 0.07);
    pivot.add(nd);
    group.add(pivot);
    needles.push({ pivot, base, amp, hz });
  };
  const lamps = (x: number, y: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const amber = i % 3 === 2;
      const mat = new THREE.MeshStandardMaterial({ color: 0x102010, emissive: new THREE.Color(amber ? 0xffa030 : 0x50ff90), emissiveIntensity: 0.6 });
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.009, 12, 8), mat);
      l.position.set(x + i * 0.036, y, WALL + 0.068);
      group.add(l);
      // A couple blink slowly; the rest stay on.
      blinkers.push({ mat, hz: i === 1 ? 0.5 : i === 4 ? 0.21 : 0, on: 0.6 });
    }
  };
  for (const [x0, x1] of [PANELS.left, PANELS.right]) group.add(plate(x1 - x0, 1.45, dark, (x0 + x1) / 2, 1.38, WALL + 0.03, 0.05));

  // Left: depth and pressure dials, two meters, a row of lamps.
  const lx = (PANELS.left[0] + PANELS.left[1]) / 2;
  dial(lx, 1.86, 0.105, 'DEPTH', false, 0.4, 0.02, 1 / 41);
  dial(lx, 1.52, 0.105, 'PRESS', true, -0.3, 0.06, 1 / 23);
  meter(lx, 1.18, 'O2  %', 0.15, 0.05, 1 / 17);
  meter(lx, 0.98, 'CO2', -0.4, 0.04, 1 / 29);
  lamps(lx - 0.145, 0.8, 9);
  glowAt.push(new THREE.Vector3(lx, 1.4, WALL + 0.25));
  // Right: the sonar scope, a heading dial, a ballast meter, lamps.
  const rx = (PANELS.right[0] + PANELS.right[1]) / 2;
  const scope = { uSweep: { value: 0 }, uGlow: { value: 0.5 } };
  const screen = new THREE.Mesh(new THREE.CircleGeometry(0.14, 64), new THREE.ShaderMaterial({ vertexShader: SCOPE_VERT, fragmentShader: SCOPE_FRAG, uniforms: scope }));
  screen.position.set(rx, 1.76, WALL + 0.065);
  group.add(screen);
  const hood = new THREE.Mesh(new THREE.TorusGeometry(0.148, 0.018, 12, 64), dark);
  hood.position.set(rx, 1.76, WALL + 0.07);
  group.add(hood);
  dial(rx - 0.11, 1.4, 0.08, 'HDG', false, 0.9, 0.03, 1 / 37);
  dial(rx + 0.11, 1.4, 0.08, 'TEMP', false, -0.6, 0.01, 1 / 53);
  meter(rx, 1.1, 'BALLAST', 0.05, 0.08, 1 / 31);
  lamps(rx - 0.145, 0.86, 9);
  glowAt.push(new THREE.Vector3(rx, 1.5, WALL + 0.25));

  // A small wall lamp above the left panel, turned right down.
  const lamp = model('industrial_wall_lamp');
  lamp.position.set(-1.45, 2.4, WALL + 0.02);
  group.add(lamp);
  const lampGlass = new THREE.MeshStandardMaterial({ color: 0x302010, emissive: new THREE.Color(0xffb070), emissiveIntensity: 0.18 });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 10), lampGlass);
  bulb.position.set(-1.45, 2.31, WALL + 0.18);
  group.add(bulb);
  const pipes = model('modular_industrial_pipes_01');
  pipes.position.set(1.95, 1.2, WALL + 0.12);
  pipes.rotation.y = -Math.PI / 2;
  group.add(pipes);

  return { group, needles, blinkers, scope, lampAt: new THREE.Vector3(-1.45, 2.29, WALL + 0.3), lampGlass, glowAt };
}
