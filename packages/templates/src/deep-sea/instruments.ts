/**
 * Instruments for the submarine's cockpit: backlit dials and strip meters with luminous green
 * markings and amber needles, indicator lamps (some blinking slowly), a phosphor sonar scope with
 * its sweep and echoes, and a green readout. Each goes onto a panel (any THREE.Object3D, its +z
 * facing the pilot); needles, lamps and the sweep move in view3d (whole cycles per loop).
 */
import { THREE, canvasTexture } from '../three-layer';

const GLOW = '#7dffb0';

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

/** A green LCD readout: rows of text. */
function readoutFace(rows: string[]) {
  return canvasTexture(512, 128, (g) => {
    g.fillStyle = '#030a06';
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = GLOW;
    g.font = 'bold 34px monospace';
    rows.forEach((r, i) => g.fillText(r, 18, 48 + i * 46));
  });
}

/** Backlit: the face is its own light, faint enough to sit in a dark room. */
const backlit = (tex: THREE.Texture, strength: number) =>
  new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(0xc8ffd8), emissiveIntensity: strength, roughness: 0.35 });

const SCOPE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const SCOPE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uSweep;
uniform float uGlow;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  float behind = mod(uSweep - a, 6.28318);
  float trail = exp(-behind / 0.5);
  float rings = smoothstep(0.02, 0.0, abs(fract(r * 4.0) - 0.5) - 0.48) * 0.25;
  float cross = (smoothstep(0.008, 0.0, abs(p.x)) + smoothstep(0.008, 0.0, abs(p.y))) * 0.15;
  float echo = 0.0;
  for (int i = 0; i < 7; i++) {
    vec2 e = vec2(hash(vec2(float(i), 1.0)), hash(vec2(float(i), 2.0))) * 1.4 - 0.7;
    float age = mod(uSweep - atan(e.y, e.x), 6.28318);
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

export interface Instruments {
  needles: Needle[];
  blinkers: { mat: THREE.MeshStandardMaterial; hz: number; on: number }[];
  scopes: { uSweep: { value: number }; uGlow: { value: number } }[];
}

export function instrumentKit(brass: THREE.Material, dark: THREE.Material) {
  const needleMat = new THREE.MeshStandardMaterial({ color: 0x402010, emissive: new THREE.Color(0xffa050), emissiveIntensity: 0.5 });
  const out: Instruments = { needles: [], blinkers: [], scopes: [] };
  const D = 0.012; // face proud of the panel
  return {
    out,
    dial(parent: THREE.Object3D, x: number, y: number, r: number, label: string, red: boolean, base: number, amp: number, hz: number) {
      const face = new THREE.Mesh(new THREE.CircleGeometry(r, 48), backlit(dialFace(label, red), 0.55));
      face.position.set(x, y, D);
      const bezel = new THREE.Mesh(new THREE.TorusGeometry(r + 0.004, 0.009, 10, 48), brass);
      bezel.position.set(x, y, D + 0.002);
      const nd = new THREE.Mesh(new THREE.BoxGeometry(0.004, r * 0.85, 0.002), needleMat);
      nd.geometry.translate(0, r * 0.38, 0);
      const pivot = new THREE.Object3D();
      pivot.position.set(x, y, D + 0.004);
      pivot.add(nd);
      parent.add(face, bezel, pivot);
      out.needles.push({ pivot, base, amp, hz });
    },
    meter(parent: THREE.Object3D, x: number, y: number, w: number, label: string, base: number, amp: number, hz: number) {
      const h = w * 0.56;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), backlit(meterFace(label), 0.5));
      face.position.set(x, y, D);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, h + 0.02, 0.01), dark);
      frame.position.set(x, y, D - 0.006);
      const nd = new THREE.Mesh(new THREE.BoxGeometry(0.003, h * 0.85, 0.002), needleMat);
      nd.geometry.translate(0, h * 0.42, 0);
      const pivot = new THREE.Object3D();
      pivot.position.set(x, y - h * 0.5, D + 0.004);
      pivot.add(nd);
      parent.add(face, frame, pivot);
      out.needles.push({ pivot, base, amp, hz });
    },
    lamps(parent: THREE.Object3D, x: number, y: number, n: number, gap = 0.034) {
      for (let i = 0; i < n; i++) {
        const amber = i % 3 === 2;
        const mat = new THREE.MeshStandardMaterial({ color: 0x102010, emissive: new THREE.Color(amber ? 0xffa030 : 0x50ff90), emissiveIntensity: 0.6 });
        const l = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), mat);
        l.position.set(x + i * gap, y, D);
        parent.add(l);
        out.blinkers.push({ mat, hz: i === 1 ? 0.5 : i === 4 ? 0.21 : 0, on: 0.6 });
      }
    },
    scope(parent: THREE.Object3D, x: number, y: number, r: number) {
      const u = { uSweep: { value: 0 }, uGlow: { value: 0.5 } };
      const screen = new THREE.Mesh(new THREE.CircleGeometry(r, 64), new THREE.ShaderMaterial({ vertexShader: SCOPE_VERT, fragmentShader: SCOPE_FRAG, uniforms: u }));
      screen.position.set(x, y, D);
      const hood = new THREE.Mesh(new THREE.TorusGeometry(r + 0.008, 0.016, 12, 64), dark);
      hood.position.set(x, y, D + 0.004);
      parent.add(screen, hood);
      out.scopes.push(u);
    },
    readout(parent: THREE.Object3D, x: number, y: number, w: number, rows: string[]) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), backlit(readoutFace(rows), 0.45));
      face.position.set(x, y, D);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, w / 4 + 0.02, 0.01), dark);
      frame.position.set(x, y, D - 0.006);
      parent.add(face, frame);
    },
    /** A row of toggle switches (some up, some down) with little guards. */
    toggles(parent: THREE.Object3D, x: number, y: number, n: number, gap = 0.045) {
      const metal = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, metalness: 0.8, roughness: 0.3 });
      const cap = new THREE.MeshStandardMaterial({ color: 0x8a1a12, roughness: 0.5 });
      for (let i = 0; i < n; i++) {
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.008, 12), metal);
        base.rotation.x = Math.PI / 2;
        base.position.set(x + i * gap, y, D);
        const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.03, 8), metal);
        lever.position.set(x + i * gap, y, D + 0.012);
        lever.rotation.x = (i * 7) % 3 === 0 ? -0.6 : 0.6;
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 6), i % 4 === 0 ? cap : metal);
        tip.position.set(x + i * gap, y + Math.sin(lever.rotation.x) * -0.014, D + 0.024);
        parent.add(base, lever, tip);
      }
    },
  };
}
