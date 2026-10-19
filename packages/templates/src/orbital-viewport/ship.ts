/**
 * The ship's interior around the viewport: a panelled metal wall with a rounded window and a bevelled
 * frame, struts either side, strip lights above, the glass (faint scratches and a reflection of the
 * cabin light), and a console below with telemetry screens and indicator lights. Everything that moves
 * here (screen traces, indicators) runs on whole-cycle periods, so it loops.
 */
import { THREE } from '../three-layer';
import { textureMaterial } from '../ambient/assets';
import { HASH, NOISE4 } from '../ambient/glsl';
import { VIEWPORT, WALL_Z } from './layout';

const SCREEN_FRAG = /* glsl */ `
${HASH}
varying vec2 vUv;
uniform float uPhase;   // 2π · t / loopS
uniform vec3 uTint;
uniform float uKind;
void main() {
  vec2 p = vUv;
  float grid = (smoothstep(0.02, 0.0, abs(fract(p.x * 8.0) - 0.5) - 0.48) + smoothstep(0.02, 0.0, abs(fract(p.y * 5.0) - 0.5) - 0.48)) * 0.05;
  float trace = 0.0;
  if (uKind < 0.5) {
    // An orbit trace: a sine wave scrolling (whole cycles per loop).
    float y = 0.5 + 0.28 * sin(p.x * 12.566 + uPhase * 90.0) * (0.7 + 0.3 * sin(uPhase * 7.0));
    trace = smoothstep(0.025, 0.0, abs(p.y - y));
  } else {
    // A slow sweep over a few blips.
    vec2 c = p - 0.5;
    float a = atan(c.y, c.x);
    float sweep = fract((a / 6.2831853) - uPhase * 15.0 / 6.2831853);
    float ring = smoothstep(0.012, 0.0, abs(length(c) - 0.33)) + smoothstep(0.012, 0.0, abs(length(c) - 0.18));
    trace = smoothstep(0.85, 1.0, sweep) * smoothstep(0.45, 0.0, length(c)) * 0.6 + ring * 0.4;
  }
  float scan = 0.9 + 0.1 * sin(p.y * 400.0);
  gl_FragColor = vec4(uTint * (0.012 + grid + trace * 1.4) * scan, 1.0);
}
`;

const GLASS_FRAG = /* glsl */ `
${NOISE4}
varying vec2 vUv;
uniform vec3 uLight;
void main() {
  // Faint scratches and smudges, and the cabin light reflected toward the top of the glass.
  float scratch = smoothstep(0.985, 1.0, abs(snoise(vec4(vUv * vec2(3.0, 90.0), 1.0, 2.0)))) * 0.5;
  float smudge = smoothstep(0.2, 0.8, snoise(vec4(vUv * 3.0, 4.0, 1.0)) * 0.5 + 0.5) * 0.25;
  float refl = smoothstep(0.55, 1.0, vUv.y) * 0.6 + smoothstep(0.4, 0.0, vUv.y) * 0.15;
  vec3 col = uLight * (0.015 * refl + 0.02 * (scratch + smudge));
  gl_FragColor = vec4(col, 1.0);
}
`;

function roundedRect(shape: THREE.Shape | THREE.Path, cx: number, cy: number, hw: number, hh: number, r: number) {
  shape.moveTo(cx - hw + r, cy - hh);
  shape.lineTo(cx + hw - r, cy - hh);
  shape.quadraticCurveTo(cx + hw, cy - hh, cx + hw, cy - hh + r);
  shape.lineTo(cx + hw, cy + hh - r);
  shape.quadraticCurveTo(cx + hw, cy + hh, cx + hw - r, cy + hh);
  shape.lineTo(cx - hw + r, cy + hh);
  shape.quadraticCurveTo(cx - hw, cy + hh, cx - hw, cy + hh - r);
  shape.lineTo(cx - hw, cy - hh + r);
  shape.quadraticCurveTo(cx - hw, cy - hh, cx - hw + r, cy - hh);
}

export interface Ship {
  group: THREE.Group;
  /** Where the viewport's corners are on screen is worked out from these. */
  update(t: number, L: number): void;
}

export const CABIN_TINTS = {
  cool: new THREE.Color(0.55, 0.75, 1.0),
  amber: new THREE.Color(1.0, 0.68, 0.38),
  red: new THREE.Color(1.0, 0.18, 0.12),
};

export function buildShip(light: keyof typeof CABIN_TINTS): Ship {
  const group = new THREE.Group();
  const tint = CABIN_TINTS[light];
  const { halfW: hw, halfH: hh, radius: r, cy } = VIEWPORT;

  // Wall with the viewport cut out.
  const wallShape = new THREE.Shape();
  wallShape.moveTo(-8, -5);
  wallShape.lineTo(8, -5);
  wallShape.lineTo(8, 5);
  wallShape.lineTo(-8, 5);
  wallShape.lineTo(-8, -5);
  const hole = new THREE.Path();
  roundedRect(hole, 0, cy, hw, hh, r);
  wallShape.holes.push(hole);
  const panelMat = textureMaterial('metal_plate_02', [5, 3], { color: 0x5a6068, metalness: 0.6 });
  const wall = new THREE.Mesh(new THREE.ShapeGeometry(wallShape), panelMat);
  wall.position.z = WALL_Z;
  wall.receiveShadow = true;
  group.add(wall);

  // Bezel: a thick, bevelled frame around the opening.
  const bezelShape = new THREE.Shape();
  roundedRect(bezelShape, 0, cy, hw + 0.16, hh + 0.16, r + 0.12);
  const bezelHole = new THREE.Path();
  roundedRect(bezelHole, 0, cy, hw, hh, r);
  bezelShape.holes.push(bezelHole);
  const bezelGeo = new THREE.ExtrudeGeometry(bezelShape, { depth: 0.22, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 4, curveSegments: 24 });
  const bezelMat = textureMaterial('blue_metal_plate', [3, 3], { color: 0x3a4048, metalness: 0.8 });
  const bezel = new THREE.Mesh(bezelGeo, bezelMat);
  bezel.position.z = WALL_Z - 0.2;
  bezel.castShadow = bezel.receiveShadow = true;
  group.add(bezel);

  // Struts either side, and a header above with a strip light.
  for (const side of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.22, 4, 0.3), bezelMat);
    strut.position.set(side * (hw + 0.55), cy, WALL_Z + 0.1);
    strut.castShadow = strut.receiveShadow = true;
    group.add(strut);
  }
  const strip = new THREE.Mesh(new THREE.BoxGeometry(2 * hw, 0.025, 0.02), new THREE.MeshBasicMaterial({ color: tint.clone().multiplyScalar(1.6) }));
  strip.position.set(0, cy + hh + 0.24, WALL_Z + 0.05);
  group.add(strip);

  // The glass.
  const glassShape = new THREE.Shape();
  roundedRect(glassShape, 0, cy, hw, hh, r);
  const glassGeo = new THREE.ShapeGeometry(glassShape);
  // ShapeGeometry uv is in shape units: normalise to 0..1 over the opening.
  const uv = glassGeo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + hw) / (2 * hw), (uv.getY(i) - cy + hh) / (2 * hh));
  const glass = new THREE.Mesh(
    glassGeo,
    new THREE.ShaderMaterial({ vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: GLASS_FRAG, uniforms: { uLight: { value: tint } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  glass.position.z = WALL_Z - 0.1;
  glass.renderOrder = 6;
  group.add(glass);

  // The console: a low ledge just under the viewport, two small monitors at its ends, and a row of
  // indicator lights along its front edge.
  const deskMat = textureMaterial('metal_plate_02', [3, 0.5], { color: 0x3a3e44, metalness: 0.7 });
  const desk = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.3, 0.55), deskMat);
  desk.position.set(0, -0.86, -1.55);
  desk.rotation.x = 0.3;
  desk.castShadow = desk.receiveShadow = true;
  group.add(desk);
  const screens: THREE.ShaderMaterial[] = [];
  for (const [x, kind] of [[-1.0, 0], [1.0, 1]] as const) {
    const m = new THREE.ShaderMaterial({ vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: SCREEN_FRAG, uniforms: { uPhase: { value: 0 }, uTint: { value: tint }, uKind: { value: kind } } });
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.22, 0.05), bezelMat);
    housing.position.set(x, -0.6, -1.85);
    housing.rotation.set(-0.15, -Math.sign(x) * 0.35, 0);
    group.add(housing);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.31, 0.17), m);
    scr.position.copy(housing.position);
    scr.rotation.copy(housing.rotation);
    scr.translateZ(0.027);
    group.add(scr);
    screens.push(m);
  }
  const lamps: { mat: THREE.MeshBasicMaterial; cycles: number; phase: number; base: THREE.Color }[] = [];
  let seed = 5;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const palette = [tint, new THREE.Color(0.3, 1.0, 0.45), new THREE.Color(1.0, 0.75, 0.2)];
  for (let i = 0; i < 22; i++) {
    const base = palette[Math.floor(rnd() * palette.length)];
    const mat = new THREE.MeshBasicMaterial({ color: base });
    const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.011, 12), mat);
    lamp.position.set(-0.84 + i * 0.08, -0.78, -1.27);
    lamp.rotation.x = -0.3;
    group.add(lamp);
    lamps.push({ mat, cycles: 0, phase: rnd() * Math.PI * 2, base: base.clone().multiplyScalar(0.6 + rnd()) });
  }

  return {
    group,
    update(t, L) {
      const phase = (2 * Math.PI * t) / L;
      for (const s of screens) s.uniforms.uPhase.value = phase;
      lamps.forEach((l, i) => {
        // Each lamp pulses a whole number of times per loop (every 2–20 s); a few stay steady.
        const cycles = i % 4 === 0 ? 0 : Math.max(1, Math.round(L / (2 + (i * 7) % 18)));
        const k = cycles ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(phase * cycles + l.phase)) : 1;
        l.mat.color.copy(l.base).multiplyScalar(k);
      });
    },
  };
}
