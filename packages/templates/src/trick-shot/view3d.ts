/**
 * Trick Shot's three.js view. Rendering only: reads sim state, never changes physics. The camera is
 * the one piece of visual state the sim keeps (s.cam, smoothed in step() when visual), so it moves
 * the same way in the Playground and in renders.
 */
import { paletteAt, type Ctx2D, type Theme } from '@sim/engine';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { THREE, draw3D, environmentMap, sceneCache } from '../three-layer';
import { BALL_R, CUP_H, CUP_WALL, HALF_X, HALF_Z, HEIGHT } from './course';
import { FIRST_LAUNCH_S, muzzle, type Pt3, type Shot, type State } from './index';

/** Outro: celebrate, then a slow-motion replay of the last stretch before the ball dropped in. */
export const REPLAY_FROM_S = 0.7;
export const REPLAY_LEN_S = 1.6;
export const REPLAY_SPEED = 0.5;

export interface Cam {
  px: number;
  py: number;
  pz: number;
  lx: number;
  ly: number;
  lz: number;
}

const TRAIL = 26;
const MAX_LIVE = 4;
const REPLAY_DOTS = 160;
const CONFETTI = 260;

const WIDE: Cam = { px: 0, py: 5.6, pz: 14.5, lx: 0, ly: 4.3, lz: 0 };

/** Where the camera wants to be now (the sim smooths toward it). */
function desired(s: State, t: number): Cam {
  if (t < FIRST_LAUNCH_S) {
    // Establishing: a slow arc round the cabinet to face-on.
    const a = 0.75 * (1 - t / FIRST_LAUNCH_S);
    return { px: Math.sin(a) * 15, py: 5.8, pz: Math.cos(a) * 15, lx: 0, ly: 4.3, lz: 0 };
  }
  const { cup } = s.course;
  if (s.endAt !== null) {
    // The finish: pulled back, looking down at the cup.
    return { px: cup.x * 0.5, py: 4.2, pz: cup.z + 9.5, lx: cup.x * 0.6, ly: 1.4, lz: cup.z * 0.6 };
  }
  const live = s.shots.filter((sh) => !sh.done);
  if (!live.length) return WIDE;
  if (live.length > 1) {
    // Race: frame every ball and the cup.
    let x = cup.x, y = CUP_H, z = cup.z;
    for (const sh of live) {
      x += sh.body.x;
      y += sh.body.y;
      z += sh.body.z;
    }
    const k = live.length + 1;
    return { px: (x / k) * 0.5, py: y / k + 2.4, pz: z / k + 11.5, lx: x / k, ly: y / k + 0.6, lz: z / k };
  }
  // Follow the ball, swinging the cup into frame as it comes down.
  const b = live[0].body;
  const w = Math.min(1, Math.max(0, (4.5 - b.y) / 3.5)) * 0.55;
  const lx = b.x + (cup.x - b.x) * w;
  const ly = b.y + (CUP_H - b.y) * w + 0.3;
  const lz = b.z + (cup.z - b.z) * w;
  return { px: lx * 0.55, py: Math.max(1.6, ly + 2.2), pz: lz + 9.5, lx, ly, lz };
}

export const initialCamera = (s: State): Cam => desired(s, 0);

export function updateCamera(s: State, t: number, dt: number) {
  const d = desired(s, t);
  const k = 1 - Math.exp(-3 * dt);
  const c = s.cam;
  c.px += (d.px - c.px) * k;
  c.py += (d.py - c.py) * k;
  c.pz += (d.pz - c.pz) * k;
  c.lx += (d.lx - c.lx) * k;
  c.ly += (d.ly - c.ly) * k;
  c.lz += (d.lz - c.lz) * k;
}

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const view = sceneCache((s: State, theme: Theme) => {
  const scene = new THREE.Scene();
  scene.environment = environmentMap();
  scene.environmentIntensity = 0.3;
  const camera = new THREE.PerspectiveCamera(42, 1080 / 1920, 0.1, 80);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a28, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(2.5, 14, 6);
  sun.target.position.set(0, 3, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 8, bottom: -8, near: 1, far: 30 });
  sun.shadow.bias = -0.001;
  scene.add(sun, sun.target);

  // Cabinet: a glossy floor, faint glass on the back and sides, and a glowing frame.
  const accent = new THREE.Color(theme.accent);
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(HALF_X * 2 + 0.3, 0.12, HALF_Z * 2 + 0.3),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.bg[1]).lerp(new THREE.Color(0x30303a), 0.5), roughness: 0.35, metalness: 0.25 }),
  );
  floor.position.y = -0.06;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(HALF_X * 2, 12, accent, accent);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.12;
  grid.scale.z = HALF_Z / HALF_X;
  grid.position.y = 0.002;
  scene.add(grid);
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xbfd8ff, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(HALF_X * 2, HEIGHT), glass.clone());
  (back.material as THREE.MeshPhysicalMaterial).opacity = 0.13;
  back.position.set(0, HEIGHT / 2, -HALF_Z);
  back.receiveShadow = true;
  scene.add(back);
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(HALF_Z * 2, HEIGHT), glass);
    side.rotation.y = Math.PI / 2;
    side.position.set(sx * HALF_X, HEIGHT / 2, 0);
    scene.add(side);
  }
  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(HALF_X * 2, HEIGHT, HALF_Z * 2)),
    new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.55 }),
  );
  frame.position.y = HEIGHT / 2;
  scene.add(frame);

  // Obstacles, each with its own material so it can flash when hit.
  const obstacles = s.course.obstacles.map((o) => {
    const color = new THREE.Color(...paletteAt(theme.palette, o.hue).map((c) => c / 255) as [number, number, number]);
    const mat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.45, metalness: 0.05, clearcoat: 0.25, emissive: color, emissiveIntensity: 0.03 });
    const group = new THREE.Group();
    const sh = o.shape;
    if (sh.kind === 'box') {
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(sh.hx * 2, sh.hy * 2, sh.hz * 2, 2, Math.min(sh.hy, sh.hz) * 0.9), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      if (o.kind === 'swing') {
        // The hinge pin along the paddle's top edge.
        const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, sh.hz * 2 + 0.12, 16), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8, roughness: 0.3 }));
        pin.rotation.x = Math.PI / 2;
        pin.position.y = sh.hy;
        group.add(pin);
      }
      if (o.kind === 'spinner') {
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.4, 20), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8, roughness: 0.3 }));
        group.add(hub);
      }
    } else {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(sh.r, 32, 20), mat);
      mesh.castShadow = true;
      group.add(mesh);
      if (o.kind === 'bumper') {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(sh.r * 1.02, 0.035, 10, 48), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.3 }));
        ring.rotation.x = Math.PI / 2;
        group.add(ring);
      }
      group.position.set(sh.x, sh.y, sh.z);
    }
    scene.add(group);
    return { group, mat };
  });

  // The cup: a metal tube with a glowing rim and a lit base, so it reads as the target from anywhere.
  const { cup } = s.course;
  const profile = [new THREE.Vector2(cup.r, 0.05), new THREE.Vector2(cup.r, CUP_H), new THREE.Vector2(cup.r + CUP_WALL, CUP_H), new THREE.Vector2(cup.r + CUP_WALL, 0)];
  const cupMesh = new THREE.Mesh(new THREE.LatheGeometry(profile, 64), new THREE.MeshStandardMaterial({ color: 0xd8d8e0, metalness: 0.9, roughness: 0.25, side: THREE.DoubleSide }));
  cupMesh.position.set(cup.x, 0, cup.z);
  cupMesh.castShadow = true;
  scene.add(cupMesh);
  const rimMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.6 });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(cup.r + CUP_WALL / 2, 0.025, 10, 64), rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.set(cup.x, CUP_H, cup.z);
  scene.add(rim);
  const baseMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.35 });
  const base = new THREE.Mesh(new THREE.CircleGeometry(cup.r, 48), baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.set(cup.x, 0.055, cup.z);
  scene.add(base);

  // Cannons: a ball joint and a barrel that turns to its aim.
  const cannons = s.cannons.map((c, i) => {
    const group = new THREE.Group();
    group.position.set(c.x, c.y, c.z);
    const metal = new THREE.MeshStandardMaterial({ color: s.p.mode === 'race' ? new THREE.Color(s.teams[i].color) : accent, metalness: 0.6, roughness: 0.35 });
    group.add(new THREE.Mesh(new THREE.SphereGeometry(0.26, 32, 20), metal));
    const barrel = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.62, 24), metal);
    tube.rotation.z = -Math.PI / 2;
    tube.position.x = 0.28;
    barrel.add(tube);
    group.add(barrel);
    scene.add(group);
    return { group, barrel };
  });

  const ballGeo = new THREE.SphereGeometry(BALL_R, 40, 28);
  const seamGeo = new THREE.TorusGeometry(BALL_R * 0.995, 0.014, 8, 48);
  const balls: THREE.Mesh[] = [];
  const ghostTrails = new Map<number, THREE.Mesh>();
  const trail = new THREE.InstancedMesh(new THREE.SphereGeometry(BALL_R, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }), TRAIL * MAX_LIVE);
  trail.frustumCulled = false;
  scene.add(trail);
  const replayDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.04, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }), REPLAY_DOTS);
  replayDots.frustumCulled = false;
  scene.add(replayDots);
  const replayBall = new THREE.Mesh(ballGeo, new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.15, clearcoat: 1, emissive: accent, emissiveIntensity: 0.35 }));
  scene.add(replayBall);

  const confettiGeo = new THREE.BufferGeometry();
  confettiGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CONFETTI * 3), 3));
  const colors = new Float32Array(CONFETTI * 3);
  for (let i = 0; i < CONFETTI; i++) {
    const c = i % 3 === 0 ? [1, 1, 1] : paletteAt(theme.palette, hash(i)).map((v) => v / 255);
    colors.set(c, i * 3);
  }
  confettiGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const confetti = new THREE.Points(confettiGeo, new THREE.PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, depthWrite: false }));
  confetti.frustumCulled = false;
  scene.add(confetti);

  return { scene, camera, obstacles, cannons, balls, ballGeo, seamGeo, ghostTrails, trail, replayDots, replayBall, confetti, rimMat, baseMat };
});

type View = ReturnType<typeof view>;

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const tmp = new THREE.Matrix4();

function ballMesh(v: View, i: number, color: string): THREE.Mesh {
  while (v.balls.length <= i) {
    const mesh = new THREE.Mesh(v.ballGeo, new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness: 0.18, metalness: 0.1, clearcoat: 1, emissive: new THREE.Color(color), emissiveIntensity: 0.12 }));
    mesh.castShadow = true;
    // Two seams round the ball at right angles, so its spin shows from any side.
    const seamMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.45), roughness: 0.4, transparent: true });
    for (const tilt of [0, Math.PI / 2]) {
      const seam = new THREE.Mesh(v.seamGeo, seamMat);
      seam.rotation.x = tilt;
      mesh.add(seam);
    }
    v.scene.add(mesh);
    v.balls.push(mesh);
  }
  return v.balls[i];
}

/** A faint tube along a finished shot's path (built once). */
function ghostTrail(v: View, i: number, sh: Shot) {
  if (v.ghostTrails.has(i) || sh.trail.length < 2) return;
  const pts = sh.trail.filter((_, k) => k % 2 === 0 || k === sh.trail.length - 1).map((q) => new THREE.Vector3(q.x, q.y, q.z));
  const curve = new THREE.CatmullRomCurve3(pts);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(600, pts.length * 2), 0.018, 6, false), new THREE.MeshBasicMaterial({ color: new THREE.Color(sh.team.color), transparent: true, opacity: 0.22, depthWrite: false }));
  v.scene.add(mesh);
  v.ghostTrails.set(i, mesh);
}

function at(path: (Pt3 & { t: number })[], t: number): Pt3 {
  let k = 1;
  while (k < path.length - 1 && path[k].t < t) k++;
  const a = path[k - 1];
  const b = path[k];
  const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 1;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
}

export function drawTrickShot3D(ctx: Ctx2D, theme: Theme, s: State, t: number) {
  const v = view(s, theme);

  s.course.obstacles.forEach((o, i) => {
    const { group, mat } = v.obstacles[i];
    if (o.shape.kind === 'box') {
      const r = o.shape.rot;
      tmp.set(r[0], r[1], r[2], o.shape.cx, r[3], r[4], r[5], o.shape.cy, r[6], r[7], r[8], o.shape.cz, 0, 0, 0, 1);
      group.matrixAutoUpdate = false;
      group.matrix.copy(tmp);
    }
    const flash = Math.max(0, 1 - (t - o.hitAt) / 0.35);
    mat.emissiveIntensity = 0.03 + 0.7 * flash;
  });

  s.cannons.forEach((c, i) => {
    const { barrel, group } = v.cannons[i];
    const dir = muzzle(c, c.aim, 1).vel;
    barrel.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(dir.x, dir.y, dir.z).normalize());
    const since = t - c.firedAt;
    const recoil = since >= 0 && since < 0.3 ? 0.12 * (1 - since / 0.3) : 0;
    barrel.position.set(-dir.x * recoil, -dir.y * recoil, -dir.z * recoil);
    group.visible = true;
  });

  let live = 0;
  s.shots.forEach((sh, i) => {
    const mesh = ballMesh(v, i, sh.team.color);
    const winner = s.winner >= 0 && s.shots[s.winner] === sh;
    // Scored race balls leave the cabinet; missed attempts stay where they stopped, dimmed.
    mesh.visible = !(sh.done && s.p.mode === 'race' && !winner);
    mesh.position.set(sh.body.x, sh.body.y, sh.body.z);
    const q = sh.body.q;
    mesh.quaternion.set(q.x, q.y, q.z, q.w);
    const mat = mesh.material as THREE.MeshPhysicalMaterial;
    mat.transparent = sh.done && !winner;
    mat.opacity = sh.done && !winner ? 0.35 : 1;
    (mesh.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.opacity = mat.opacity;
    if (sh.done && !winner && s.p.mode === 'attempts') ghostTrail(v, i, sh);
    if (!sh.done && live < MAX_LIVE) {
      const tail = sh.trail.slice(-TRAIL);
      for (let k = 0; k < TRAIL; k++) {
        const q = tail[k];
        const idx = live * TRAIL + k;
        if (!q) {
          v.trail.setMatrixAt(idx, HIDDEN);
          continue;
        }
        const sc = 0.25 + (0.6 * k) / TRAIL;
        tmp.makeScale(sc, sc, sc).setPosition(q.x, q.y, q.z);
        v.trail.setMatrixAt(idx, tmp);
      }
      live++;
    }
  });
  for (let k = live * TRAIL; k < TRAIL * MAX_LIVE; k++) v.trail.setMatrixAt(k, HIDDEN);
  v.trail.instanceMatrix.needsUpdate = true;

  const { cup } = s.course;
  const won = s.success && s.endAt !== null;
  v.rimMat.emissiveIntensity = won ? 1.4 : 0.6;
  v.baseMat.opacity = won ? 0.75 : 0.35;

  // Confetti fountain from the cup (positions are a pure function of time since the sink).
  const pos = v.confetti.geometry.getAttribute('position') as THREE.BufferAttribute;
  const since = won ? t - s.endAt! : -1;
  v.confetti.visible = since >= 0 && since < 2.2;
  if (v.confetti.visible) {
    for (let i = 0; i < CONFETTI; i++) {
      const a = hash(i + 1) * Math.PI * 2;
      const sp = 0.6 + 1.6 * hash(i + 7);
      const up = 4 + 4 * hash(i + 13);
      const u = Math.max(0, since - 0.15 * hash(i + 19));
      pos.setXYZ(i, cup.x + Math.cos(a) * sp * u, Math.max(0, CUP_H + up * u - 4.9 * u * u), cup.z + Math.sin(a) * sp * u);
    }
    pos.needsUpdate = true;
  }

  // Camera: the sim's smoothed camera, or the replay angle from beside the cup.
  const c = s.cam;
  const camera = v.camera;
  camera.position.set(c.px, c.py, c.pz);
  camera.lookAt(c.lx, c.ly, c.lz);
  const replayT = won ? t - s.endAt! - REPLAY_FROM_S : -1;
  const replaying = replayT >= 0 && replayT <= REPLAY_LEN_S / REPLAY_SPEED && s.replay.length > 1;
  v.replayBall.visible = replaying;
  for (let k = 0; k < REPLAY_DOTS; k++) v.replayDots.setMatrixAt(k, HIDDEN);
  if (replaying) {
    const t0 = s.replay[0].t;
    const now = t0 + replayT * REPLAY_SPEED;
    const p = at(s.replay, now);
    v.replayBall.position.set(p.x, p.y, p.z);
    const shown = s.replay.filter((q) => q.t <= now);
    const step = Math.max(1, Math.ceil(shown.length / REPLAY_DOTS));
    for (let k = 0, j = 0; j < shown.length && k < REPLAY_DOTS; j += step, k++) v.replayDots.setMatrixAt(k, tmp.makeTranslation(shown[j].x, shown[j].y, shown[j].z));
    // Low beside the cup, on the far side from where the ball came in, looking back up its path.
    const start = s.replay[0];
    let dx = cup.x - start.x;
    let dz = cup.z - start.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    camera.position.set(cup.x + dx * 3.4 + dz * 0.9, CUP_H + 0.85, cup.z + dz * 3.4 - dx * 0.9 + 0.8);
    camera.lookAt(p.x + (cup.x - p.x) * 0.35, p.y + (CUP_H - p.y) * 0.35, p.z + (cup.z - p.z) * 0.35);
  }
  v.replayDots.instanceMatrix.needsUpdate = true;

  draw3D(ctx, v.scene, camera);
}
