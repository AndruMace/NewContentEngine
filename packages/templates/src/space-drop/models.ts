/**
 * Every object, modelled in code at its real size (metres): long axis along +x, up +y, centred on
 * its middle. Rendering only.
 */
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { THREE, canvasTexture } from '../three-layer';
import type { Shape } from './objects';

type M = THREE.MeshStandardMaterial;
const mat = (color: number, roughness = 0.6, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}): M => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, parent?: THREE.Object3D): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  o.receiveShadow = true;
  parent?.add(o);
  return o;
}

const rbox = (l: number, h: number, w: number, r: number) => new RoundedBoxGeometry(l, h, w, 3, Math.min(r, l / 2.01, h / 2.01, w / 2.01));
/** A cylinder along x. */
function xcyl(r: number, l: number, seg = 32, r2 = r): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r2, r, l, seg).rotateZ(-Math.PI / 2);
}
/** A cylinder along z (wheels). */
const zcyl = (r: number, w: number, seg = 28) => new THREE.CylinderGeometry(r, r, w, seg).rotateX(Math.PI / 2);

/** Deterministic pseudo-random numbers for model details. */
function rand(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const glass = () => mat(0x111820, 0.08, 0.6, { envMapIntensity: 1.5 });
const tyre = () => mat(0x161616, 0.85);
const chrome = () => mat(0xd8dde2, 0.18, 1);

/** What a part does when it hits the ground (see wreck.ts): tears off and is thrown, or shatters. */
export type Detach = 'wheel' | 'trim' | 'heavy';
function detach<T extends THREE.Object3D>(o: T, kind: Detach): T {
  o.userData.detach = kind;
  return o;
}
function glassy(o: THREE.Mesh): THREE.Mesh {
  o.userData.glass = true;
  return o;
}
/** Where a wrecked engine bay smokes from. */
function smokes(parent: THREE.Object3D, x: number, y: number, z = 0) {
  const o = new THREE.Object3D();
  o.userData.smoke = true;
  o.position.set(x, y, z);
  parent.add(o);
}

/** A group of parts that tears off together. */
function part(parent: THREE.Object3D, kind: Detach, x = 0, y = 0, z = 0): THREE.Group {
  const p = detach(new THREE.Group(), kind);
  p.position.set(x, y, z);
  parent.add(p);
  return p;
}

function wheels(g: THREE.Group, xs: number[], y: number, z: number, r: number, w: number) {
  const t = tyre();
  const hub = mat(0x9aa0a6, 0.35, 0.9);
  for (const x of xs)
    for (const s of [-1, 1]) {
      const wheel = part(g, 'wheel', x, y, s * z);
      mesh(zcyl(r, w), t, 0, 0, 0, wheel);
      mesh(zcyl(r * 0.55, w * 1.04), hub, 0, 0, 0, wheel);
    }
}

function rod(shape: Shape): THREE.Group {
  const g = new THREE.Group();
  if (shape.kind !== 'cyl') return g;
  const r = shape.d / 2;
  const L = shape.l;
  const nose = Math.min(L * 0.18, shape.d * 2.5);
  const m = mat(0x8c8f94, 0.32, 1);
  mesh(xcyl(r, L - nose, 48), m, -nose / 2, 0, 0, g);
  // A blunted cone at the front (+x), fins at the back.
  mesh(new THREE.ConeGeometry(r, nose, 48).rotateZ(-Math.PI / 2), m, L / 2 - nose / 2, 0, 0, g);
  const fin = mat(0x6d7075, 0.4, 1);
  for (let k = 0; k < 4; k++) {
    const f = mesh(new THREE.BoxGeometry(L * 0.12, shape.d * 0.9, shape.d * 0.06), fin, -L / 2 + L * 0.07, 0, 0, g);
    f.rotation.x = (k * Math.PI) / 2;
    f.geometry.translate(0, shape.d * 0.45, 0);
  }
  // Bands, so it reads as machined rather than a plain bar.
  const band = mat(0x55585c, 0.5, 1);
  for (const u of [-0.25, 0.05, 0.3]) mesh(xcyl(r * 1.015, L * 0.012, 48), band, u * L, 0, 0, g);
  return g;
}

function car(paint: number, pickup = false): THREE.Group {
  const g = new THREE.Group();
  const p = mat(paint, 0.28, 0.55, { envMapIntensity: 1.2 });
  const L = pickup ? 5.9 : 4.7;
  const W = pickup ? 2.0 : 1.8;
  const H = pickup ? 1.9 : 1.45;
  const wr = pickup ? 0.42 : 0.33;
  const bodyH = H * 0.48;
  mesh(rbox(L, bodyH, W, 0.18), p, 0, -H / 2 + wr + bodyH / 2 - 0.08, 0, g);
  if (pickup) {
    mesh(rbox(L * 0.36, H * 0.42, W * 0.96, 0.15), p, L * 0.12, -H / 2 + wr + bodyH + H * 0.21 - 0.12, 0, g);
    glassy(mesh(new THREE.BoxGeometry(L * 0.34, H * 0.28, W * 0.97), glass(), L * 0.12, -H / 2 + wr + bodyH + H * 0.22 - 0.1, 0, g));
    // The bed: an open box at the back.
    const bed = mat(0x2a2a2a, 0.8);
    mesh(new THREE.BoxGeometry(L * 0.42, 0.06, W * 0.9), bed, -L * 0.27, -H / 2 + wr + bodyH - 0.06, 0, g);
  } else {
    const cab = mesh(rbox(L * 0.52, H * 0.4, W * 0.92, 0.2), p, -L * 0.04, -H / 2 + wr + bodyH + H * 0.18 - 0.12, 0, g);
    cab.scale.set(1, 1, 1);
    glassy(mesh(new THREE.BoxGeometry(L * 0.5, H * 0.3, W * 0.93), glass(), -L * 0.04, -H / 2 + wr + bodyH + H * 0.17 - 0.1, 0, g));
  }
  const lamp = mat(0xfff4d6, 0.2, 0, { emissive: 0x332a18 });
  for (const s of [-1, 1]) detach(mesh(new THREE.BoxGeometry(0.06, 0.12, 0.32), lamp, L / 2 - 0.02, -H / 2 + wr + bodyH * 0.65, s * W * 0.33, g), 'trim');
  const red = mat(0x7a0d0d, 0.3, 0, { emissive: 0x220000 });
  for (const s of [-1, 1]) detach(mesh(new THREE.BoxGeometry(0.06, 0.12, 0.3), red, -L / 2 + 0.02, -H / 2 + wr + bodyH * 0.65, s * W * 0.34, g), 'trim');
  detach(mesh(new THREE.BoxGeometry(0.12, 0.16, W * 0.95), chrome(), L / 2 + 0.02, -H / 2 + wr + 0.08, 0, g), 'trim');
  wheels(g, [L * 0.32, -L * 0.32], -H / 2 + wr, W / 2 - 0.12, wr, 0.24);
  smokes(g, L * 0.36, -H / 2 + wr + bodyH * 0.7);
  return g;
}

function bus(): THREE.Group {
  const g = new THREE.Group();
  const L = 12;
  const H = 3.2;
  const W = 2.4;
  const yellow = mat(0xf2b10c, 0.45, 0.15);
  mesh(rbox(L, H - 0.5, W, 0.25), yellow, 0, 0.25, 0, g);
  const win = canvasTexture(1024, 64, (c) => {
    c.fillStyle = '#f2b10c';
    c.fillRect(0, 0, 1024, 64);
    c.fillStyle = '#111820';
    for (let k = 0; k < 12; k++) c.fillRect(30 + k * 82, 6, 66, 52);
  });
  const side = mat(0xffffff, 0.3, 0.2, { map: win });
  for (const s of [-1, 1]) {
    const w = mesh(new THREE.PlaneGeometry(L * 0.86, 0.85), side, -0.3, 0.85, s * (W / 2 + 0.005), g);
    if (s < 0) w.rotation.y = Math.PI;
  }
  const black = mat(0x151515, 0.6);
  for (const y of [-0.35, 0.2]) for (const s of [-1, 1]) mesh(new THREE.BoxGeometry(L * 0.98, 0.07, 0.03), black, 0, y, s * (W / 2 + 0.01), g);
  detach(mesh(new THREE.BoxGeometry(0.2, 0.3, W * 1.02), black, L / 2 + 0.05, -0.9, 0, g), 'trim');
  detach(mesh(new THREE.BoxGeometry(0.2, 0.3, W * 1.02), black, -L / 2 - 0.05, -0.9, 0, g), 'trim');
  glassy(mesh(new THREE.BoxGeometry(0.04, 1.0, W * 0.85), glass(), L / 2 + 0.005, 0.85, 0, g));
  wheels(g, [L * 0.33, -L * 0.28], -H / 2 + 0.5, W / 2 - 0.2, 0.5, 0.35);
  smokes(g, L / 2 - 0.9, -0.2);
  return g;
}

function tank(): THREE.Group {
  const g = new THREE.Group();
  const olive = mat(0x5b6136, 0.75, 0.25);
  const dark = mat(0x2b2b26, 0.85, 0.3);
  // Hull with a sloped glacis.
  const hull = new THREE.Shape();
  hull.moveTo(-3.95, -0.4);
  hull.lineTo(3.4, -0.4);
  hull.lineTo(3.95, 0.25);
  hull.lineTo(2.6, 0.6);
  hull.lineTo(-3.9, 0.6);
  hull.closePath();
  const hg = new THREE.ExtrudeGeometry(hull, { depth: 3.5, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2 }).translate(0, 0, -1.75);
  mesh(hg, olive, 0, -0.1, 0, g);
  // Tracks and road wheels.
  for (const s of [-1, 1]) {
    const track = part(g, 'heavy', 0, -0.75, s * 1.55);
    mesh(rbox(7.6, 0.95, 0.65, 0.3), dark, 0, 0, 0, track);
    for (let k = 0; k < 7; k++) mesh(zcyl(0.38, 0.7), mat(0x3a3a33, 0.7, 0.4), -2.9 + k * 0.97, -0.03, 0, track);
  }
  // Turret and gun.
  const turret = part(g, 'heavy', -0.4, 0.85, 0);
  mesh(rbox(3.4, 0.8, 2.6, 0.25), olive, 0, 0, 0, turret);
  mesh(xcyl(0.09, 5.2, 20), olive, 4.0, 0.05, 0, turret);
  mesh(xcyl(0.16, 0.9, 20), olive, 1.9, 0.05, 0, turret);
  mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 20), dark, -0.6, 0.5, 0.5, turret);
  // Periscopes: little blocks of glass on the turret roof.
  for (const [x, z] of [
    [0.9, -0.7],
    [0.9, 0.7],
    [-0.6, -0.45],
  ])
    glassy(mesh(new THREE.BoxGeometry(0.22, 0.14, 0.3), glass(), x, 0.47, z, turret));
  // The engine sits at the back.
  smokes(g, -3.0, 0.3);
  return g;
}

function jet(): THREE.Group {
  const g = new THREE.Group();
  const white = mat(0xeef1f4, 0.4, 0.2);
  const blue = mat(0x1d3f8f, 0.4, 0.2);
  const grey = mat(0xb7bcc2, 0.4, 0.6);
  const R = 3.25;
  // The fuselage in three sections (a crash breaks it at the joins): nose with the upper deck, the
  // centre over the wings, and the tail.
  const section = (parent: THREE.Object3D, x0: number, x1: number, cx: number) => {
    mesh(xcyl(R, x1 - x0, 40), white, (x0 + x1) / 2 - cx, 0, 0, parent);
    for (const s of [-1, 1]) mesh(new THREE.BoxGeometry(x1 - x0, 0.5, 0.05), blue, (x0 + x1) / 2 - cx, -0.6, s * (R + 0.01), parent);
  };
  const nose = part(g, 'heavy', 19, 0, 0);
  section(nose, 12, 26, 19);
  mesh(new THREE.SphereGeometry(R, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(-Math.PI / 2).scale(2.2, 1, 1), white, 7, 0, 0, nose);
  // The hump of the upper deck.
  mesh(new THREE.SphereGeometry(1, 24, 16).scale(12, 2.2, 2.6), white, -1, 2.4, 0, nose);
  glassy(mesh(new THREE.BoxGeometry(1.4, 0.4, 3.2), glass(), 11.5, 1.4, 0, nose));
  section(g, -10, 12, 0);
  const tail = part(g, 'heavy', -20, 0, 0);
  section(tail, -30, -10, -20);
  mesh(new THREE.ConeGeometry(R, 12, 32).rotateZ(Math.PI / 2), white, -16, 0.4, 0, tail);
  // Swept wings and tailplanes, extruded from their outlines.
  const wing = (span: number, root: number, tip: number, sweep: number) => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(-sweep, span);
    s.lineTo(-sweep - tip, span);
    s.lineTo(-root, 0);
    s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth: 0.5, bevelEnabled: false }).rotateX(Math.PI / 2);
  };
  for (const side of [-1, 1]) {
    // Each wing tears off with its engines.
    const wg = part(g, 'heavy', 0, 0, side * 14);
    const w = mesh(wing(30, 14, 4, 16), grey, 6, -1.2, -side * 14, wg);
    w.scale.z = side;
    for (const z of [11, 21]) {
      mesh(xcyl(1.25, 6, 24), mat(0xd5d9de, 0.35, 0.7), 4 - (z - 11) * 0.7, -2.9, side * (z - 14), wg);
      mesh(new THREE.CircleGeometry(1.15, 24).rotateY(Math.PI / 2), mat(0x222222, 0.5, 0.8), 7.05 - (z - 11) * 0.7, -2.9, side * (z - 14), wg);
    }
    const tg = part(g, 'heavy', -30, 1, side * 5);
    const t = mesh(wing(11, 7, 2.5, 7), grey, 2, 0, -side * 5, tg);
    t.scale.z = side;
  }
  const fin = new THREE.Shape();
  fin.moveTo(0, 0);
  fin.lineTo(-7, 12);
  fin.lineTo(-11, 12);
  fin.lineTo(-10, 0);
  fin.closePath();
  mesh(new THREE.ExtrudeGeometry(fin, { depth: 0.5, bevelEnabled: false }).translate(0, 0, -0.25), blue, -6, 2.5, 0, tail);
  return g;
}

function container(): THREE.Group {
  const g = new THREE.Group();
  const tex = canvasTexture(512, 128, (c) => {
    c.fillStyle = '#b8471f';
    c.fillRect(0, 0, 512, 128);
    for (let x = 0; x < 512; x += 10) {
      c.fillStyle = x % 20 ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.12)';
      c.fillRect(x, 0, 5, 128);
    }
  });
  tex.wrapS = THREE.RepeatWrapping;
  const m = mat(0xffffff, 0.6, 0.35, { map: tex });
  mesh(new THREE.BoxGeometry(6.06, 2.59, 2.44), m, 0, 0, 0, g);
  const frame = mat(0x3a1a10, 0.7, 0.4);
  for (const x of [-3.0, 3.0]) for (const y of [-1.27, 1.27]) mesh(new THREE.BoxGeometry(0.1, 0.1, 2.46), frame, x, y, 0, g);
  for (const x of [-3.0, 3.0]) for (const z of [-1.2, 1.2]) mesh(new THREE.BoxGeometry(0.1, 2.6, 0.1), frame, x, 0, z, g);
  return g;
}

function penny(): THREE.Group {
  const g = new THREE.Group();
  const face = canvasTexture(256, 256, (c) => {
    const gr = c.createRadialGradient(128, 128, 20, 128, 128, 128);
    gr.addColorStop(0, '#c26a3a');
    gr.addColorStop(1, '#8d4425');
    c.fillStyle = gr;
    c.fillRect(0, 0, 256, 256);
    c.strokeStyle = 'rgba(255,220,180,0.55)';
    c.lineWidth = 6;
    c.beginPath();
    c.arc(128, 128, 116, 0, Math.PI * 2);
    c.stroke();
    // A profile in relief, suggested by a lighter oval.
    c.fillStyle = 'rgba(255,200,160,0.25)';
    c.beginPath();
    c.ellipse(128, 124, 52, 66, 0.15, 0, Math.PI * 2);
    c.fill();
  });
  const m = mat(0xffffff, 0.35, 1, { map: face });
  const rim = mat(0xa8552f, 0.4, 1);
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.009525, 0.009525, 0.00152, 48), [rim, m, m]);
  coin.rotation.z = Math.PI / 2;
  g.add(coin);
  return g;
}

function bowlingBall(): THREE.Group {
  const g = new THREE.Group();
  const tex = canvasTexture(512, 256, (c) => {
    c.fillStyle = '#16245e';
    c.fillRect(0, 0, 512, 256);
    const r = rand(7);
    for (let k = 0; k < 40; k++) {
      c.strokeStyle = `rgba(${90 + r() * 60},${40 + r() * 40},${160 + r() * 80},0.45)`;
      c.lineWidth = 3 + r() * 10;
      c.beginPath();
      c.moveTo(r() * 512, r() * 256);
      c.bezierCurveTo(r() * 512, r() * 256, r() * 512, r() * 256, r() * 512, r() * 256);
      c.stroke();
    }
    c.fillStyle = '#05060a';
    for (const [x, y, s] of [
      [250, 100, 12],
      [278, 96, 12],
      [262, 140, 15],
    ])
      c.fillRect(x - s, y - s * 0.5, s * 2, s);
  });
  mesh(new THREE.SphereGeometry(0.109, 48, 32), mat(0xffffff, 0.12, 0.1, { map: tex, envMapIntensity: 1.4 }), 0, 0, 0, g);
  return g;
}

function anvil(): THREE.Group {
  const g = new THREE.Group();
  const s = new THREE.Shape();
  s.moveTo(-0.3, -0.16);
  s.lineTo(0.18, -0.16);
  s.lineTo(0.12, -0.08);
  s.lineTo(0.06, 0.06);
  s.lineTo(0.2, 0.08);
  s.quadraticCurveTo(0.33, 0.1, 0.35, 0.16);
  s.lineTo(-0.3, 0.16);
  s.lineTo(-0.3, 0.06);
  s.lineTo(-0.16, 0.04);
  s.lineTo(-0.14, -0.08);
  s.lineTo(-0.3, -0.12);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.22, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2 }).translate(0, 0, -0.11);
  mesh(geo, mat(0x7a7f86, 0.45, 0.85), 0, 0, 0, g);
  return g;
}

function piano(): THREE.Group {
  const g = new THREE.Group();
  const lacquer = mat(0x18181d, 0.14, 0.2, { envMapIntensity: 1.5 });
  const s = new THREE.Shape();
  s.moveTo(-1.05, -0.75);
  s.lineTo(1.05, -0.75);
  s.lineTo(1.05, 0.75);
  s.lineTo(0.2, 0.75);
  s.bezierCurveTo(-0.2, 0.75, -0.3, 0.1, -0.7, 0.05);
  s.quadraticCurveTo(-1.05, 0.0, -1.05, -0.4);
  s.closePath();
  const body = new THREE.ExtrudeGeometry(s, { depth: 0.38, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 2 }).rotateX(-Math.PI / 2).translate(0, 0.1, 0);
  mesh(body, lacquer, 0, 0, 0, g);
  // Keyboard along the straight front edge.
  const keys = canvasTexture(512, 32, (c) => {
    c.fillStyle = '#f4f1e8';
    c.fillRect(0, 0, 512, 32);
    c.fillStyle = '#111';
    for (let k = 0; k < 52; k++) {
      c.fillRect(k * 9.85, 0, 1, 32);
      if ([0, 1, 3, 4, 5].includes(k % 7)) c.fillRect(k * 9.85 + 6.5, 0, 5.5, 20);
    }
  });
  detach(mesh(new THREE.BoxGeometry(0.05, 0.2, 1.42).rotateY(0), mat(0xffffff, 0.3, 0, { map: keys }), 1.1, 0.33, 0, g), 'trim').rotation.set(0, Math.PI / 2, Math.PI / 2);
  detach(mesh(new THREE.BoxGeometry(1.42, 0.06, 0.2), mat(0xf4f1e8, 0.3, 0, { map: keys }), 1.15, 0.33, 0, g), 'trim').rotation.y = Math.PI / 2;
  for (const [x, z] of [
    [0.9, 0.6],
    [0.9, -0.6],
    [-0.8, -0.3],
  ])
    detach(mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.6, 12), lacquer, x, -0.25, z, g), 'trim');
  detach(mesh(new THREE.BoxGeometry(0.05, 0.25, 0.3), mat(0xd9b45a, 0.3, 1), 0.85, -0.45, 0, g), 'trim');
  return g;
}

function fridge(): THREE.Group {
  const g = new THREE.Group();
  const steel = mat(0xc9cdd1, 0.32, 0.85);
  mesh(rbox(1.8, 0.8, 0.7, 0.05), steel, 0, 0, 0, g);
  mesh(new THREE.BoxGeometry(0.012, 0.81, 0.71), mat(0x333333, 0.5), 0.35, 0, 0, g);
  for (const x of [0.65, -0.2]) detach(mesh(new THREE.BoxGeometry(0.4, 0.04, 0.04), chrome(), x, 0.42, 0.25, g), 'trim');
  return g;
}

function cow(): THREE.Group {
  const g = new THREE.Group();
  const hide = canvasTexture(512, 256, (c) => {
    c.fillStyle = '#f2efe8';
    c.fillRect(0, 0, 512, 256);
    c.fillStyle = '#1b1715';
    const r = rand(11);
    for (let k = 0; k < 14; k++) {
      c.beginPath();
      c.ellipse(r() * 512, r() * 256, 30 + r() * 50, 20 + r() * 40, r() * 3, 0, Math.PI * 2);
      c.fill();
    }
  });
  const skin = mat(0xffffff, 0.8, 0, { map: hide });
  const pink = mat(0xd99a92, 0.7);
  const dark = mat(0x1b1715, 0.7);
  mesh(new THREE.SphereGeometry(1, 32, 20).scale(0.95, 0.5, 0.4), skin, 0, 0.15, 0, g);
  mesh(new THREE.SphereGeometry(1, 24, 16).scale(0.3, 0.24, 0.2), skin, 1.0, 0.45, 0, g);
  mesh(new THREE.SphereGeometry(1, 20, 12).scale(0.13, 0.12, 0.15), pink, 1.27, 0.38, 0, g);
  for (const s of [-1, 1]) {
    mesh(new THREE.ConeGeometry(0.03, 0.18, 10).rotateX((s * Math.PI) / 3), mat(0xe8dfc8, 0.5), 0.95, 0.68, s * 0.14, g);
    mesh(new THREE.SphereGeometry(1, 12, 8).scale(0.04, 0.1, 0.12), skin, 0.9, 0.55, s * 0.24, g).rotation.x = s * 0.6;
    for (const x of [0.6, -0.6]) {
      mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.75, 12), skin, x, -0.5, s * 0.22, g);
      mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 12), dark, x, -0.89, s * 0.22, g);
    }
  }
  mesh(new THREE.SphereGeometry(0.15, 16, 12), pink, -0.35, -0.3, 0, g);
  mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 8).rotateZ(-0.3), skin, -1.0, 0.05, 0, g);
  return g;
}

/** A lumpy rock: an icosphere pushed in and out by layered noise (regmaglypts on a meteorite). */
function rock(d: number, seed: number, color: number, rough: number, metal: number, bumpy = 0.35): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(d / 2, 4);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const r = rand(seed);
  const dents = Array.from({ length: 40 }, () => {
    const v = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    return { v, s: 0.1 + r() * 0.3, k: 0.04 + r() * 0.1 };
  });
  const lobes = Array.from({ length: 7 }, () => ({ v: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), k: (r() - 0.4) * bumpy }));
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const n = p.clone().normalize();
    let f = 1;
    for (const l of lobes) f += l.k * Math.max(0, n.dot(l.v)) ** 2;
    for (const dd of dents) {
      const a = n.distanceTo(dd.v);
      if (a < dd.s) f -= dd.k * Math.cos(((a / dd.s) * Math.PI) / 2) ** 2;
    }
    p.copy(n).multiplyScalar((d / 2) * f);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  // Mottled colour per face, and faceted shading: it reads as rock.
  const flat = geo.index ? geo.toNonIndexed() : geo;
  const n = flat.attributes.position.count;
  const col = new Float32Array(n * 3);
  const base = new THREE.Color(color);
  for (let f = 0; f < n; f += 3) {
    const k = 0.72 + 0.5 * r();
    for (let j = 0; j < 3; j++) col.set([base.r * k, base.g * k, base.b * k], (f + j) * 3);
  }
  flat.setAttribute('color', new THREE.BufferAttribute(col, 3));
  flat.computeVertexNormals();
  mesh(flat, mat(0xffffff, rough, metal, { flatShading: true, vertexColors: true }), 0, 0, 0, g);
  return g;
}

function satellite(): THREE.Group {
  const g = new THREE.Group();
  const foil = canvasTexture(256, 256, (c) => {
    c.fillStyle = '#c8962e';
    c.fillRect(0, 0, 256, 256);
    const r = rand(5);
    for (let k = 0; k < 160; k++) {
      c.fillStyle = `rgba(${255 * r()},${200 * r()},60,0.25)`;
      c.beginPath();
      c.moveTo(r() * 256, r() * 256);
      c.lineTo(r() * 256, r() * 256);
      c.lineTo(r() * 256, r() * 256);
      c.fill();
    }
  });
  mesh(new THREE.BoxGeometry(3, 2, 2), mat(0xffffff, 0.3, 1, { map: foil }), 0, 0, 0, g);
  const cells = canvasTexture(256, 128, (c) => {
    c.fillStyle = '#0c1a3a';
    c.fillRect(0, 0, 256, 128);
    c.strokeStyle = '#7a8bb0';
    c.lineWidth = 2;
    for (let x = 0; x <= 256; x += 21) c.strokeRect(x, 0, 21, 128);
    for (let y = 0; y <= 128; y += 32) c.strokeRect(0, y, 256, 32);
  });
  const panel = mat(0xffffff, 0.25, 0.6, { map: cells });
  for (const s of [-1, 1]) {
    detach(mesh(new THREE.BoxGeometry(1.6, 0.04, 6), panel, 0, 0, s * 4.3, g), 'heavy');
    detach(mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.3, 8).rotateX(Math.PI / 2), chrome(), 0, 0, s * 1.6, g), 'trim');
  }
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.8, 32, 12, 0, Math.PI * 2, 0, 0.6), mat(0xe8e8e8, 0.4, 0.2, { side: THREE.DoubleSide }));
  dish.rotation.z = -Math.PI / 2;
  dish.position.set(2.0, 0, 0);
  g.add(detach(dish, 'trim'));
  return g;
}

function station(): THREE.Group {
  const g = new THREE.Group();
  const panels = canvasTexture(512, 256, (c) => {
    c.fillStyle = '#e7e9ec';
    c.fillRect(0, 0, 512, 256);
    c.strokeStyle = 'rgba(80,90,100,0.5)';
    c.lineWidth = 2;
    for (let x = 0; x < 512; x += 64) c.strokeRect(x, 0, 64, 256);
    for (let y = 0; y < 256; y += 64) c.strokeRect(0, y, 512, 64);
  });
  mesh(xcyl(2.1, 11, 48), mat(0xffffff, 0.55, 0.15, { map: panels }), 0, 0, 0, g);
  const ring = mat(0x9aa3ad, 0.35, 0.9);
  for (const s of [-1, 1]) {
    mesh(xcyl(1.6, 1.0, 40, 2.1), ring, s * 6, 0, 0, g).scale.x = s;
    mesh(xcyl(0.8, 0.5, 32), ring, s * 6.7, 0, 0, g);
  }
  const rad = mat(0xf6f6f2, 0.3, 0.2);
  detach(mesh(new THREE.BoxGeometry(5, 0.05, 2.6), rad, 0, 2.3, 0, g), 'heavy');
  return g;
}

function whale(): THREE.Group {
  const g = new THREE.Group();
  const pts: THREE.Vector2[] = [];
  for (let k = 0; k <= 40; k++) {
    const u = k / 40;
    const r = 2.0 * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.7 * (1 - 0.75 * u ** 3) + 0.05;
    pts.push(new THREE.Vector2(Math.max(0.05, r), -12.5 + u * 25));
  }
  const body = new THREE.LatheGeometry(pts, 48).rotateZ(-Math.PI / 2).scale(1, 0.85, 1);
  // Blue-grey above, paler grooved belly below.
  const col = new Float32Array(body.attributes.position.count * 3);
  const pos = body.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const belly = Math.max(0, Math.min(1, (-y + 0.3) / 1.2));
    const c = new THREE.Color(0x3e5a74).lerp(new THREE.Color(0x9fb0bd), belly);
    col.set([c.r, c.g, c.b], i * 3);
  }
  body.setAttribute('color', new THREE.BufferAttribute(col, 3));
  mesh(body, mat(0xffffff, 0.55, 0.05, { vertexColors: true }), 0, 0, 0, g);
  const fin = mat(0x3e5a74, 0.55);
  // Flukes: two flattened lobes at the tail (−x).
  for (const s of [-1, 1]) {
    mesh(new THREE.SphereGeometry(1, 16, 8).scale(1.4, 0.12, 2.6), fin, -12.6, 0, s * 2.2, g).rotation.y = s * 0.5;
    mesh(new THREE.SphereGeometry(1, 16, 8).scale(2, 0.12, 0.6), fin, 5, -1.2, s * 2.0, g).rotation.y = s * -0.6;
  }
  mesh(new THREE.ConeGeometry(0.3, 0.8, 8), fin, -6, 1.6, 0, g);
  return g;
}

function house(): THREE.Group {
  const g = new THREE.Group();
  const wallTex = canvasTexture(512, 256, (c) => {
    c.fillStyle = '#d9cdb4';
    c.fillRect(0, 0, 512, 256);
    c.fillStyle = 'rgba(0,0,0,0.07)';
    for (let y = 0; y < 256; y += 10) c.fillRect(0, y, 512, 2);
    c.fillStyle = '#28323d';
    for (const x of [60, 180, 320, 430]) {
      c.fillRect(x, 50, 50, 60);
      c.fillRect(x, 150, 50, 60);
    }
    c.fillStyle = '#6a3b22';
    c.fillRect(245, 140, 40, 116);
  });
  const wall = mat(0xffffff, 0.85, 0, { map: wallTex });
  mesh(new THREE.BoxGeometry(12, 5, 10), wall, 0, -1, 0, g);
  const roofS = new THREE.Shape();
  roofS.moveTo(-6.4, 0);
  roofS.lineTo(6.4, 0);
  roofS.lineTo(0, 3.2);
  roofS.closePath();
  const roof = new THREE.ExtrudeGeometry(roofS, { depth: 10.6, bevelEnabled: false }).translate(0, 0, -5.3).rotateY(Math.PI / 2);
  mesh(roof, mat(0x4a3f3a, 0.8), 0, 1.5, 0, g);
  mesh(new THREE.BoxGeometry(1.2, 4, 1.2), mat(0x8c3b2a, 0.9), 3, 3, 2.5, g);
  return g;
}

function ship(): THREE.Group {
  const g = new THREE.Group();
  const s = new THREE.Shape();
  s.moveTo(-150, -19);
  s.lineTo(110, -19);
  s.quadraticCurveTo(150, -10, 152, 0);
  s.quadraticCurveTo(150, 10, 110, 19);
  s.lineTo(-150, 19);
  s.closePath();
  const hull = new THREE.ExtrudeGeometry(s, { depth: 24, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, -30, 0);
  const hullMat = mat(0x1d2c4a, 0.5, 0.3);
  mesh(hull, hullMat, 0, 0, 0, g);
  const decks = canvasTexture(1024, 128, (c) => {
    c.fillStyle = '#f4f6f8';
    c.fillRect(0, 0, 1024, 128);
    c.fillStyle = '#1e3448';
    for (let y = 8; y < 128; y += 16) c.fillRect(0, y, 1024, 6);
  });
  const deck = mat(0xffffff, 0.45, 0.1, { map: decks });
  mesh(new THREE.BoxGeometry(240, 30, 34), deck, -15, 9, 0, g);
  mesh(new THREE.BoxGeometry(150, 8, 28), deck, -30, 28, 0, g);
  mesh(new THREE.CylinderGeometry(6, 7, 14, 24).scale(1.6, 1, 1), mat(0xc0392b, 0.5, 0.2), -70, 39, 0, g);
  return g;
}

function cube(): THREE.Group {
  const g = new THREE.Group();
  const brushed = canvasTexture(256, 256, (c) => {
    c.fillStyle = '#9ea4aa';
    c.fillRect(0, 0, 256, 256);
    const r = rand(3);
    for (let k = 0; k < 600; k++) {
      c.fillStyle = `rgba(255,255,255,${r() * 0.08})`;
      c.fillRect(0, r() * 256, 256, 1);
    }
  });
  mesh(rbox(9.76, 9.76, 9.76, 0.1), mat(0xffffff, 0.35, 1, { map: brushed }), 0, 0, 0, g);
  return g;
}

/** What survives a breakup, by name. */
function core(name: string, shape: Shape): THREE.Group {
  const g = new THREE.Group();
  const iron = mat(0x767a80, 0.55, 0.8);
  switch (name) {
    case 'engine block':
    case 'engine and frame':
    case 'diesel engine': {
      const s = shape.kind === 'box' ? shape : { l: 0.7, h: 0.6, w: 0.6 };
      mesh(rbox(s.l, s.h * 0.7, s.w, 0.05), iron, 0, -s.h * 0.15, 0, g);
      for (let k = 0; k < 4; k++) mesh(new THREE.CylinderGeometry(s.w * 0.12, s.w * 0.12, s.h * 0.35, 16), iron, -s.l * 0.3 + k * s.l * 0.2, s.h * 0.3, 0, g);
      return g;
    }
    case 'jet engine':
      mesh(xcyl(1.2, 4, 32, 0.9), mat(0xb9bec4, 0.35, 0.9), 0, 0, 0, g);
      mesh(new THREE.CircleGeometry(1.1, 32).rotateY(Math.PI / 2), mat(0x1a1a1a, 0.4, 0.9), 2.01, 0, 0, g);
      return g;
    case 'cargo of steel coils':
      for (let i = 0; i < 4; i++) for (const z of [-0.5, 0.5]) mesh(zcyl(0.55, 0.9, 32), mat(0x6e7378, 0.4, 0.95), -1.8 + i * 1.2, 0, z, g);
      return g;
    case 'cast-iron frame':
      mesh(new THREE.BoxGeometry(1.6, 0.12, 1.2), mat(0xb8913a, 0.45, 0.9), 0, 0, 0, g);
      return g;
    case 'compressor':
      mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 20), mat(0x111111, 0.5, 0.5), 0, 0, 0, g);
      return g;
    case 'titanium fuel tank':
      mesh(new THREE.SphereGeometry(0.45, 32, 24), mat(0x8e9399, 0.3, 1), 0, 0, 0, g);
      return g;
    case 'steel docking frame': {
      // A docking port torn out of the module: the collar, its flanges, the hatch, and the stubs of
      // the struts that held it (axis along x, like the module it came from).
      const steel = mat(0x9aa0a8, 0.45, 0.6);
      const dark = mat(0x5c6168, 0.6, 0.5);
      mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.55, 40, 1, true).rotateZ(Math.PI / 2), mat(0x9aa0a8, 0.45, 0.6, { side: THREE.DoubleSide }), 0, 0, 0, g);
      for (const x of [-0.3, 0.3]) mesh(new THREE.TorusGeometry(1.05, 0.08, 10, 48).rotateY(Math.PI / 2), steel, x, 0, 0, g);
      // The hatch, shut, with its handle.
      mesh(new THREE.CylinderGeometry(0.92, 0.92, 0.08, 40).rotateZ(Math.PI / 2), dark, 0.12, 0, 0, g);
      mesh(new THREE.BoxGeometry(0.06, 0.12, 0.7), steel, 0.2, 0, 0, g);
      // Torn strut stubs, each a different length.
      const r = rand(17);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + r() * 0.3;
        const len = 0.18 + 0.25 * r();
        const strut = mesh(new THREE.BoxGeometry(0.14, len, 0.12), dark, -0.15 + 0.3 * r(), Math.cos(a) * (1.08 + len / 2), Math.sin(a) * (1.08 + len / 2), g);
        strut.rotation.x = a - Math.PI / 2;
        strut.rotation.z = (r() - 0.5) * 0.5;
      }
      return g;
    }
    case 'brick chimney':
      mesh(new THREE.BoxGeometry(6, 1.2, 1.2), mat(0x8c3b2a, 0.9), 0, 0, 0, g);
      return g;
    case 'hull section': {
      // A slice of the ship: navy hull below the waterline stripe, white decks with rows of windows.
      const s = shape.kind === 'box' ? shape : { l: 30, h: 20, w: 38 };
      const hullH = s.h * 0.45;
      mesh(new THREE.BoxGeometry(s.l, hullH, s.w), mat(0x1d2c4a, 0.55, 0.3), 0, -s.h / 2 + hullH / 2, 0, g);
      mesh(new THREE.BoxGeometry(s.l * 1.002, s.h * 0.04, s.w * 1.002), mat(0xb3261e, 0.5, 0.2), 0, -s.h / 2 + hullH * 0.35, 0, g);
      const decks = canvasTexture(256, 128, (c) => {
        c.fillStyle = '#f4f6f8';
        c.fillRect(0, 0, 256, 128);
        c.fillStyle = '#1e3448';
        for (let y = 10; y < 128; y += 20) for (let x = 4; x < 256; x += 12) c.fillRect(x, y, 8, 7);
      });
      mesh(new THREE.BoxGeometry(s.l, s.h - hullH, s.w * 0.92), mat(0xffffff, 0.45, 0.1, { map: decks }), 0, s.h / 2 - (s.h - hullH) / 2, 0, g);
      return g;
    }
    default:
      return rock(shape.kind === 'sphere' ? shape.d : 0.3, 99, 0x2a2420, 0.9, 0.1);
  }
}

/** The model for an object (or what's left of it). */
export function buildModel(id: string, shape: Shape, coreName?: string): THREE.Group {
  if (coreName) return core(coreName, shape);
  switch (id) {
    case 'tungsten-rod':
      return rod(shape);
    case 'sedan':
      return car(0xa3171b);
    case 'pickup':
      return car(0x2f4f6b, true);
    case 'school-bus':
      return bus();
    case 'tank':
      return tank();
    case 'jumbo-jet':
      return jet();
    case 'container':
      return container();
    case 'penny':
      return penny();
    case 'bowling-ball':
      return bowlingBall();
    case 'anvil':
      return anvil();
    case 'piano':
      return piano();
    case 'fridge':
      return fridge();
    case 'cow':
      return cow();
    case 'iron-meteorite':
      return rock(1, 4, 0x3a332c, 0.55, 0.45);
    case 'stony-meteorite':
      return rock(0.3, 8, 0x2a2420, 0.85, 0.05);
    case 'asteroid':
      return rock(19, 21, 0x6b645c, 0.95, 0, 0.3);
    case 'satellite':
      return satellite();
    case 'station-module':
      return station();
    case 'blue-whale':
      return whale();
    case 'house':
      return house();
    case 'cruise-ship':
      return ship();
    case 'steel-cube':
      return cube();
    default:
      return rock(1, 1, 0x555555, 0.8, 0);
  }
}

/** Little chunks thrown off in a breakup (shapes and colours vary by seed). */
export function debrisGeometry(plates = false): THREE.BufferGeometry {
  // Torn panels for machines; chunks for rock.
  return plates ? new THREE.IcosahedronGeometry(1, 0).scale(1, 0.2, 0.8) : new THREE.IcosahedronGeometry(1, 0);
}
