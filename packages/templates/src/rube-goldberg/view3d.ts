/**
 * Rube Goldberg's three.js view, aiming for a product-photo look: a wall-mounted marble run on a
 * plywood board in a soft studio, with physically based wood, brass, steel and glass. Rendering only:
 * poses come from the tape.
 */
import { paletteAt, type Ctx2D, type Theme } from '@sim/engine';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { THREE, canvasTexture, draw3DComposed, sceneCache, studioEnvironment } from '../three-layer';
import type { State } from './index';
import { DT, MARBLE_R, STEPS_PER_FRAME, type Finish, type Piece, type Shape } from './sim';

/** Pseudo-random from an integer (visual texture noise only). */
export const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** A wood grain texture: long wavy grain lines and pores over a base tone. */
export function woodTexture(base: [number, number, number], dark: [number, number, number], seed: number): THREE.Texture {
  const tex = canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = `rgb(${base.join(',')})`;
    ctx.fillRect(0, 0, 512, 512);
    for (let k = 0; k < 140; k++) {
      const y0 = hash(seed + k) * 512;
      const amp = 2 + hash(seed + k * 3) * 9;
      const freq = 0.006 + hash(seed + k * 7) * 0.012;
      const a = 0.05 + hash(seed + k * 11) * 0.22;
      ctx.strokeStyle = `rgba(${dark.join(',')},${a.toFixed(3)})`;
      ctx.lineWidth = 0.6 + hash(seed + k * 13) * 2.2;
      ctx.beginPath();
      for (let x = 0; x <= 512; x += 8) {
        const y = y0 + Math.sin(x * freq + k) * amp + Math.sin(x * freq * 3.1 + k * 2) * amp * 0.3;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let k = 0; k < 1800; k++) {
      ctx.fillStyle = `rgba(${dark.join(',')},${(0.05 + hash(seed + k * 17) * 0.12).toFixed(3)})`;
      ctx.fillRect(hash(seed + k * 19) * 512, hash(seed + k * 23) * 512, 1 + hash(k) * 3, 1);
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Box-map UVs (project along each face's dominant axis), in metres × density, so grain scale is real. */
export function boxMapUVs(g: THREE.BufferGeometry, density = 3) {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Grain runs along x (the long axis of every plank).
    const [u, v] = ax >= ay && ax >= az ? [z, y] : ay >= az ? [x, z] : [x, y];
    uv[i * 2] = u * density;
    uv[i * 2 + 1] = v * density;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export function latheUVs(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position');
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < pos.count; i++) {
    cx += pos.getX(i);
    cz += pos.getZ(i);
  }
  cx /= pos.count;
  cz /= pos.count;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (Math.atan2(pos.getZ(i) - cz, pos.getX(i) - cx) / (Math.PI * 2)) * 4;
    uv[i * 2 + 1] = pos.getY(i) * 8;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function geometry(shape: Shape): THREE.BufferGeometry {
  switch (shape.kind) {
    case 'box': {
      const g = shape.round ? new RoundedBoxGeometry(shape.hx * 2, shape.hy * 2, shape.hz * 2, 2, shape.round) : new THREE.BoxGeometry(shape.hx * 2, shape.hy * 2, shape.hz * 2);
      boxMapUVs(g);
      return g;
    }
    case 'sphere':
      return new THREE.SphereGeometry(shape.r, 48, 32);
    case 'cylinder':
      return new THREE.CylinderGeometry(shape.r, shape.r, shape.hh * 2, 40);
    case 'capsule':
      return new THREE.CapsuleGeometry(shape.r, shape.hh * 2, 8, 24);
    case 'torus':
      return new THREE.TorusGeometry(shape.R, shape.r, 12, 72).rotateX(Math.PI / 2);
    case 'mesh': {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(shape.positions, 3));
      g.setIndex(new THREE.BufferAttribute(shape.indices, 1));
      g.computeVertexNormals();
      // Brushed-metal anisotropy needs texture coordinates to find its brush direction (without them
      // it blows out white). Generated meshes are all lathed round a vertical axis, so map u round
      // that axis and v up it: the brushing then runs round the piece, like spun metal.
      latheUVs(g);
      return g;
    }
  }
}

/** A twisted coloured vane: the "cat's eye" inside a glass marble. */
export function vaneGeometry(r: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(r * 1.5, r * 1.6, 1, 24);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const x = pos.getX(i);
    const a = (y / r) * 1.6;
    // Taper toward the poles so it stays inside the sphere.
    const k = Math.sqrt(Math.max(0, 1 - (y / (r * 0.82)) ** 2));
    pos.setXYZ(i, x * k * Math.cos(a), y, x * k * Math.sin(a));
  }
  g.computeVertexNormals();
  return g;
}

function materials(theme: Theme) {
  const maple = woodTexture([214, 178, 128], [120, 78, 40], 1);
  const walnut = woodTexture([110, 72, 45], [45, 26, 14], 2);
  const ply = woodTexture([206, 176, 136], [140, 104, 66], 3);
  const paint = (hue: number) => {
    const c = paletteAt(theme.palette, (hue * 0.37) % 1).map((v) => v / 255) as [number, number, number];
    return new THREE.MeshPhysicalMaterial({ color: new THREE.Color(...c), roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.3, side: THREE.DoubleSide });
  };
  const mats: Record<Exclude<Finish, 'paint'>, THREE.Material> = {
    maple: new THREE.MeshPhysicalMaterial({ map: maple, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.4 }),
    walnut: new THREE.MeshPhysicalMaterial({ map: walnut, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.35 }),
    brass: new THREE.MeshPhysicalMaterial({ color: 0xc9a352, metalness: 0.9, roughness: 0.45, anisotropy: 0.6, side: THREE.DoubleSide }),
    steel: new THREE.MeshPhysicalMaterial({ color: 0xa9aeb6, metalness: 0.9, roughness: 0.34, anisotropy: 0.4, side: THREE.DoubleSide }),
    // Clear acrylic guards: nearly invisible face-on, with reflections and bright edges catching light.
    glass: new THREE.MeshPhysicalMaterial({ color: 0xdfeeff, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.04, clearcoat: 1, specularIntensity: 1, depthWrite: false, side: THREE.DoubleSide }),
    ivory: new THREE.MeshPhysicalMaterial({ color: 0xf1ead8, roughness: 0.42, clearcoat: 0.3 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 }),
    felt: new THREE.MeshStandardMaterial({ color: 0x1d5a3a, roughness: 1, side: THREE.DoubleSide }),
    bell: new THREE.MeshPhysicalMaterial({ color: 0xe2bd62, metalness: 1, roughness: 0.14, side: THREE.DoubleSide }),
  };
  return { mats, paint, ply };
}

function meshFor(piece: Piece, m: ReturnType<typeof materials>, theme: Theme): THREE.Object3D {
  const shape = piece.draw ?? piece.shape;
  // Clear acrylic guards: in a photo you mostly see their polished edges, so draw just those (a
  // see-through sheet confuses the depth-based post effects and reads as a grey veil).
  if (piece.finish === 'glass' && shape.kind !== 'sphere') {
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry(shape)), new THREE.LineBasicMaterial({ color: 0xdfeeff, transparent: true, opacity: 0.35 }));
    edges.position.set(piece.pos.x, piece.pos.y, piece.pos.z);
    edges.quaternion.set(piece.rot.x, piece.rot.y, piece.rot.z, piece.rot.w);
    return edges;
  }
  const tint = () => new THREE.Color(...(paletteAt(theme.palette, ((piece.hue ?? 0) * 0.29 + 0.1) % 1).map((v) => v / 255) as [number, number, number]));
  const mat =
    piece.finish === 'paint'
      ? m.paint(piece.hue ?? 0)
      : piece.finish === 'glass' && shape.kind === 'sphere'
        ? // Tinted glass: colour builds up with depth through the marble, like real cat's-eyes.
          new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.03, transmission: 1, ior: 1.52, thickness: MARBLE_R * 1.8, attenuationColor: tint().lerp(new THREE.Color(0xffffff), 0.35), attenuationDistance: 0.02, clearcoat: 1, specularIntensity: 1 })
        : m.mats[piece.finish];
  const mesh = new THREE.Mesh(geometry(shape), mat);
  mesh.castShadow = true;
  // Thin two-sided surfaces (funnels, bells) shadow themselves badly: let them cast but not receive.
  mesh.receiveShadow = shape.kind !== 'mesh';
  mesh.position.set(piece.pos.x, piece.pos.y, piece.pos.z);
  mesh.quaternion.set(piece.rot.x, piece.rot.y, piece.rot.z, piece.rot.w);
  if (piece.finish === 'glass' && shape.kind === 'sphere') {
    const c = paletteAt(theme.palette, ((piece.hue ?? 0) * 0.29 + 0.1) % 1).map((v) => v / 255) as [number, number, number];
    const vane = new THREE.Mesh(vaneGeometry(shape.r), new THREE.MeshStandardMaterial({ color: new THREE.Color(...c), roughness: 0.4, side: THREE.DoubleSide, emissive: new THREE.Color(...c), emissiveIntensity: 0.08 }));
    const g = new THREE.Group();
    g.add(vane, mesh);
    mesh.position.set(0, 0, 0);
    g.position.set(piece.pos.x, piece.pos.y, piece.pos.z);
    return g;
  }
  return mesh;
}

/**
 * The reflection environment: a dark studio with a big overhead softbox, a strip light either side
 * and a warm bounce card low in front, so metal shows long soft highlights on black.
 */
export const studio = () =>
  studioEnvironment('rube-goldberg', (scene) => {
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16), new THREE.MeshBasicMaterial({ color: 0x0c0b0e, side: THREE.BackSide })));
    const panel = (w: number, h: number, color: number, at: [number, number, number], look: [number, number, number]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.position.set(...at);
      m.lookAt(...look);
      scene.add(m);
    };
    panel(8, 5, 0xb8ad9e, [0, 9, 3], [0, 0, 0]);
    panel(1.6, 10, 0xe8eeff, [-7, 2, 2], [0, 0, 0]);
    panel(1.6, 10, 0xffffff, [7, 3, -1], [0, 0, 0]);
    panel(10, 2, 0x8a6a48, [0, -6, 6], [0, 0, 0]);
  });

/** How far a piece reaches from its centre, at most (a bounding radius). */
function reach(shape: Shape): number {
  switch (shape.kind) {
    case 'box':
      return Math.sqrt(shape.hx * shape.hx + shape.hy * shape.hy + shape.hz * shape.hz);
    case 'sphere':
      return shape.r;
    case 'cylinder':
    case 'capsule':
      return Math.sqrt(shape.r * shape.r + (shape.hh + shape.r) ** 2);
    case 'torus':
      return shape.R + shape.r;
    case 'mesh':
      return 0;
  }
}

/** The smallest z (furthest back) any piece of the machine reaches, moving parts included. */
function deepest(s: State): number {
  let z = 0;
  const visit = (shape: Shape, cz: number) => {
    if (shape.kind === 'mesh') {
      for (let i = 2; i < shape.positions.length; i += 3) z = Math.min(z, cz + shape.positions[i]);
      return;
    }
    // Boxes are tight in z when they lie in the machine's plane: use their depth if unrotated.
    z = Math.min(z, cz - reach(shape));
  };
  for (const p of s.statics) {
    const sh = p.draw ?? p.shape;
    const flatBox = sh.kind === 'box' && Math.abs(p.rot.x) < 1e-6 && Math.abs(p.rot.y) < 1e-6;
    if (flatBox) z = Math.min(z, p.pos.z - (sh as { hz: number }).hz);
    else visit(sh, p.pos.z);
  }
  s.bodies.forEach((b, i) => {
    const f0 = s.frames[s.firstFrame[i]];
    const bz = f0[i * 7 + 2];
    for (const p of b.pieces) visit(p.draw ?? p.shape, bz + p.pos.z);
  });
  return z;
}

/** Hardboard pegboard: warm brown with a regular grid of dark holes (one texture = 25 cm square). */
function pegboardTexture(): THREE.Texture {
  const tex = canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = 'rgb(138,104,72)';
    ctx.fillRect(0, 0, 512, 512);
    for (let k = 0; k < 2600; k++) {
      ctx.fillStyle = `rgba(${hash(k) > 0.5 ? '255,235,210' : '60,40,25'},${(0.03 + hash(k + 9) * 0.05).toFixed(3)})`;
      ctx.fillRect(hash(k + 3) * 512, hash(k + 5) * 512, 2 + hash(k + 7) * 5, 1);
    }
    for (let i = 0; i < 10; i++)
      for (let j = 0; j < 10; j++) {
        const x = 25.6 + i * 51.2;
        const y = 25.6 + j * 51.2;
        ctx.fillStyle = 'rgba(20,12,6,0.92)';
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,230,200,0.12)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x + 0.8, y + 0.8, 6.5, Math.PI * 0.1, Math.PI * 0.9);
        ctx.stroke();
      }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Slate: dark grey stone with fine cleavage streaks and mottling. */
function slateTexture(): THREE.Texture {
  const tex = canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = 'rgb(54,58,64)';
    ctx.fillRect(0, 0, 512, 512);
    for (let k = 0; k < 90; k++) {
      ctx.fillStyle = `rgba(${hash(k) > 0.5 ? '90,96,104' : '30,32,36'},${(0.05 + hash(k + 1) * 0.1).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(hash(k + 2) * 512, hash(k + 3) * 512, 20 + hash(k + 4) * 90, 6 + hash(k + 5) * 20, hash(k + 6) * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let k = 0; k < 160; k++) {
      ctx.strokeStyle = `rgba(110,116,124,${(0.04 + hash(k + 7) * 0.1).toFixed(3)})`;
      ctx.lineWidth = 0.6 + hash(k + 8);
      const y = hash(k + 9) * 512;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(512, y + (hash(k + 10) - 0.5) * 30);
      ctx.stroke();
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Whitewashed brick: running bond, uneven paint over warm brick showing through. */
function brickTexture(): THREE.Texture {
  const tex = canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = 'rgb(176,170,160)';
    ctx.fillRect(0, 0, 512, 512);
    const bw = 128;
    const bh = 42.6;
    for (let row = 0; row < 12; row++)
      for (let col = -1; col < 5; col++) {
        const x = col * bw + (row % 2 ? bw / 2 : 0) + 3;
        const y = row * bh + 3;
        const n = row * 7 + col;
        const r = 214 + hash(n) * 22;
        ctx.fillStyle = `rgb(${r},${r - 6},${r - 14})`;
        ctx.fillRect(x, y, bw - 6, bh - 6);
        // Brick colour showing through where the whitewash is thin.
        for (let k = 0; k < 6; k++) {
          ctx.fillStyle = `rgba(150,80,60,${(0.05 + hash(n * 13 + k) * 0.12).toFixed(3)})`;
          ctx.fillRect(x + hash(n * 3 + k) * (bw - 30), y + hash(n * 5 + k) * (bh - 14), 10 + hash(n + k) * 30, 4 + hash(n * 2 + k) * 8);
        }
      }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Concrete: mid grey with speckle and faint form-board seams. */
export function concreteTexture(): THREE.Texture {
  const tex = canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = 'rgb(118,116,112)';
    ctx.fillRect(0, 0, 512, 512);
    for (let k = 0; k < 5000; k++) {
      const v = hash(k) > 0.5 ? 150 : 80;
      ctx.fillStyle = `rgba(${v},${v},${v - 4},${(0.05 + hash(k + 1) * 0.12).toFixed(3)})`;
      ctx.fillRect(hash(k + 2) * 512, hash(k + 3) * 512, 1 + hash(k + 4) * 3, 1 + hash(k + 5) * 3);
    }
    ctx.strokeStyle = 'rgba(60,58,55,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 256);
    ctx.lineTo(512, 256);
    ctx.stroke();
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export const BACKDROPS = ['plywood', 'pegboard', 'slate', 'brick', 'concrete'] as const;
export type Backdrop = (typeof BACKDROPS)[number];

/** The wall behind the run, textured at real scale (each texture tile covers `tile` metres). */
function backdropMaterial(kind: Backdrop, ply: THREE.Texture, w: number, h: number): THREE.MeshPhysicalMaterial {
  const tiled = (tex: THREE.Texture, tile: number) => {
    tex.repeat.set(w / tile, h / tile);
    return tex;
  };
  switch (kind) {
    case 'pegboard':
      return new THREE.MeshPhysicalMaterial({ map: tiled(pegboardTexture(), 0.25), color: 0x8a7a6c, roughness: 0.85 });
    case 'slate':
      return new THREE.MeshPhysicalMaterial({ map: tiled(slateTexture(), 0.6), roughness: 0.6, clearcoat: 0.15, clearcoatRoughness: 0.6 });
    case 'brick':
      return new THREE.MeshPhysicalMaterial({ map: tiled(brickTexture(), 0.75), color: 0x9a948c, roughness: 0.95 });
    case 'concrete':
      return new THREE.MeshPhysicalMaterial({ map: tiled(concreteTexture(), 0.5), color: 0x8a8884, roughness: 0.92 });
    case 'plywood':
    default:
      ply.repeat.set(2, h * 2);
      return new THREE.MeshPhysicalMaterial({ map: ply, color: 0x5a4a3c, roughness: 0.75 });
  }
}

const view = sceneCache((s: State, theme: Theme) => {
  const scene = new THREE.Scene();
  scene.environment = studio();
  scene.environmentIntensity = 0.9;
  // A dark, warm studio: the wood and brass carry the light.
  scene.background = new THREE.Color(0x141317);
  const camera = new THREE.PerspectiveCamera(FOV, 1080 / 1920, 0.02, 40);

  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x2a2420, 0.25));
  const key = new THREE.DirectionalLight(0xffe9cf, 2.1);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -0.7, right: 0.7, top: 0.7, bottom: -0.7, near: 0.1, far: 6 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  key.shadow.radius = 4;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xcfdcff, 0.35);
  fill.position.set(-2, 1, 3);
  scene.add(fill);
  // Rim light from behind and above, to edge the channels and marbles against the board.
  const rim = new THREE.DirectionalLight(0xfff5e8, 1.1);
  rim.position.set(-0.6, 3, -2.5);
  scene.add(rim);

  const m = materials(theme);
  // Machine extent: from the scenery's lowest and highest points.
  let yMin = 0;
  let yMax = 0;
  for (const p of s.statics) {
    yMin = Math.min(yMin, p.pos.y);
    yMax = Math.max(yMax, p.pos.y);
  }
  // The plywood board the run is mounted on, and the bench it stands on.
  const boardH = yMax - yMin + 0.5;
  const plyMat = backdropMaterial(s.p.backdrop, m.ply, 2.2, boardH);
  // The board stands just behind the deepest piece (a vortex bowl or a spiral can reach well back),
  // so nothing ever pokes into it.
  const boardZ = Math.min(-0.09, deepest(s) - 0.012) - 0.009;
  // Wide enough that swivelling toward a marble at the machine's edge never shows the board's edge.
  const board = new THREE.Mesh(new THREE.BoxGeometry(2.2, boardH, 0.018), plyMat);
  board.position.set(0, (yMax + yMin) / 2, boardZ);
  board.receiveShadow = true;
  scene.add(board);
  const bench = new THREE.Mesh(new RoundedBoxGeometry(1.6, 0.06, 0.7, 2, 0.01), m.mats.walnut);
  boxMapUVs(bench.geometry);
  bench.position.set(0, yMin - 0.32, 0.18);
  bench.receiveShadow = true;
  scene.add(bench);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x232126, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = yMin - 1.2;
  floor.receiveShadow = true;
  scene.add(floor);

  for (const p of s.statics) scene.add(meshFor(p, m, theme));
  const bodies = s.bodies.map((b) => {
    const g = new THREE.Group();
    for (const p of b.pieces) g.add(meshFor(p, m, theme));
    scene.add(g);
    return g;
  });
  return { scene, camera, key, bodies };
});

/** Pose of body i at video frame f (its first pose before it existed). */
function pose(s: State, i: number, f: number): Float32Array {
  const ff = Math.max(f, s.firstFrame[i]);
  const frame = s.frames[Math.min(ff, s.frames.length - 1)];
  return frame.subarray(i * 7, i * 7 + 7);
}

/**
 * The marble to watch at each frame. A stage's record names the marble that leaves it, but in a
 * hand-off stage (dominoes, cradle, catapult) a second marble waits while the first one arrives:
 * watch the arriving marble until the waiting one actually starts to move.
 */
function watchedMarbles(s: State): Int32Array {
  const n = s.frames.length;
  const out = new Int32Array(n).fill(s.stages[0].marble);
  const speedAt = (i: number, f: number) => {
    if (f < 1) return 0;
    const a = pose(s, i, f - 1);
    const b = pose(s, i, f);
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (DT * STEPS_PER_FRAME);
  };
  s.stages.forEach((g, k) => {
    const incoming = k > 0 ? s.stages[k - 1].marble : g.marble;
    const f0 = Math.floor(g.from / STEPS_PER_FRAME);
    const f1 = Math.min(n, Math.ceil(g.to / STEPS_PER_FRAME));
    let switched = incoming === g.marble;
    for (let f = f0; f < f1; f++) {
      if (!switched && speedAt(g.marble, f) > 0.05) switched = true;
      out[f] = switched ? g.marble : incoming;
    }
  });
  const last = s.stages[s.stages.length - 1];
  for (let f = Math.ceil(last.to / STEPS_PER_FRAME); f < n; f++) out[f] = last.marble;
  return out;
}

/** Zero-phase smoothing of a per-frame series: exponential filters run forward then backward, twice. */
function smoothSeries(xs: Float32Array, tau: number, fps: number): Float32Array {
  const k = 1 - Math.exp(-1 / (fps * tau));
  const y = Float32Array.from(xs);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < y.length; i++) y[i] = y[i - 1] + k * (y[i] - y[i - 1]);
    for (let i = y.length - 2; i >= 0; i--) y[i] = y[i + 1] + k * (y[i] - y[i + 1]);
  }
  return y;
}

interface Track {
  /** Where the camera stands: a slow, heavily smoothed version of the ball's path. */
  px: Float32Array;
  py: Float32Array;
  /** What it aims at: the ball, only lightly smoothed, so the camera swivels to keep it in frame. */
  lx: Float32Array;
  ly: Float32Array;
  lz: Float32Array;
}

/**
 * The camera's track, from the tape. Smoothing runs both ways along it (no lag), and it is held
 * still from the moment the bell rings: what the marble does afterwards (drops into the cup, or
 * further) must not pull the shot down ahead of time.
 */
function cameraTrack(s: State): Track {
  const n = s.frames.length;
  const watched = watchedMarbles(s);
  const hold = Math.min(n - 1, Math.ceil(s.finaleStep / STEPS_PER_FRAME));
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const zs = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const ff = Math.min(f, hold);
    const p = pose(s, watched[ff], ff);
    xs[f] = p[0];
    ys[f] = p[1];
    zs[f] = p[2];
  }
  const fps = 1 / (DT * STEPS_PER_FRAME);
  return { px: smoothSeries(xs, 1.0, fps), py: smoothSeries(ys, 0.6, fps), lx: smoothSeries(xs, 0.11, fps), ly: smoothSeries(ys, 0.11, fps), lz: smoothSeries(zs, 0.3, fps) };
}

/** How long the pull back to the whole machine takes once the bell rings. */
const PULLBACK_S = 2.2;

interface CameraPlan {
  track: Track;
  watched: Int32Array;
  yMin: number;
  yMax: number;
}
const plans = new WeakMap<State, CameraPlan>();

function cameraPlan(s: State): CameraPlan {
  let plan = plans.get(s);
  if (plan) return plan;
  let yMin = 0;
  let yMax = 0;
  for (const p of s.statics) {
    yMin = Math.min(yMin, p.pos.y);
    yMax = Math.max(yMax, p.pos.y);
  }
  plan = { track: cameraTrack(s), watched: watchedMarbles(s), yMin, yMax };
  plans.set(s, plan);
  return plan;
}

const ease = (u: number) => {
  const k = Math.min(1, Math.max(0, u));
  return k * k * (3 - 2 * k);
};

/**
 * Where the camera is and what it looks at, at time t (a pure function of the tape): following the
 * marble down the machine from the start, then pulling back to show all of it as the bell rings.
 * `sharp` is true for the wide shot (deep focus, everything readable).
 */
export function cameraPose(s: State, t: number): { pos: THREE.Vector3; look: THREE.Vector3; sharp: boolean } {
  const plan = cameraPlan(s);
  const f = Math.min(s.frames.length - 1, Math.round(t / DT / STEPS_PER_FRAME));
  const mid = (plan.yMax + plan.yMin) / 2;
  const span = plan.yMax - plan.yMin + 0.4;
  const wideDist = span / (2 * Math.tan((FOV * Math.PI) / 360)) + 0.3;
  const wide = { pos: new THREE.Vector3(0.18, mid + 0.1, wideDist), look: new THREE.Vector3(0, mid, 0) };
  const tr = plan.track;
  const fx = tr.px[f];
  const fy = tr.py[f];
  // Stand back (to see the contraption and the next one coming), drifting slowly with the run and
  // a little above it, so the marble shows over the channel walls; swivel to aim at the ball itself,
  // so it never leaves the frame however far it runs to either side.
  const follow = { pos: new THREE.Vector3(fx * 0.55 + 0.08, fy + 0.29, 1.22), look: new THREE.Vector3(tr.lx[f], tr.ly[f] - 0.015, tr.lz[f] * 0.5) };
  const finaleT = s.finaleStep * DT;
  // Close on the ball from the first frame; as the bell rings, pull back to the whole machine.
  const b = ease((t - finaleT + 0.15) / PULLBACK_S);
  return { pos: follow.pos.clone().lerp(wide.pos, b), look: follow.look.clone().lerp(wide.look, b), sharp: b > 0.5 };
}

/** The marble the camera watches at time t, and where it is (for tests). */
export function watchedAt(s: State, t: number): { x: number; y: number; z: number } {
  const plan = cameraPlan(s);
  const f = Math.min(s.frames.length - 1, Math.round(t / DT / STEPS_PER_FRAME));
  const p = pose(s, plan.watched[f], f);
  return { x: p[0], y: p[1], z: p[2] };
}

export const FOV = 32;

export function drawRube3D(ctx: Ctx2D, theme: Theme, s: State, t: number) {
  const v = view(s, theme);
  const f = Math.min(s.frames.length - 1, Math.round(t / DT / STEPS_PER_FRAME));
  s.bodies.forEach((_, i) => {
    const p = pose(s, i, f);
    v.bodies[i].position.set(p[0], p[1], p[2]);
    v.bodies[i].quaternion.set(p[3], p[4], p[5], p[6]);
  });

  const { pos, look, sharp } = cameraPose(s, t);
  v.camera.position.copy(pos);
  v.camera.lookAt(look);
  // Keep the key light's shadow map centred on what we're looking at.
  v.key.position.set(look.x + 0.8, look.y + 1.6, look.z + 1.4);
  v.key.target.position.copy(look);
  v.key.shadow.camera.updateProjectionMatrix();
  // Ambient occlusion grounds every joint and contact; a shallow depth of field on the marble sells
  // the tabletop scale.
  const focus = v.camera.position.distanceTo(look);
  draw3DComposed(ctx, v.scene, v.camera, {
    exposure: 0.95,
    toneMapping: THREE.AgXToneMapping,
    ao: { radius: 0.02, scale: 1 },
    dof: { focus, aperture: sharp ? 0.004 : 0.012, maxblur: 0.005 },
  });
}
