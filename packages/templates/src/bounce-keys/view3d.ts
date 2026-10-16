/**
 * The three.js styles of Bounce Keys (cascade-3d, spiral, falling). Rendering only: reads sim state,
 * never changes it. Sim space is screen-style (x right, y down, z toward the camera in pixels); it
 * maps to three.js as x = (x - 540) / 100, y = -y / 100, z = z / 100.
 */
import { lighten, type Ctx2D, type RGB, type Theme } from '@sim/engine';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { THREE, draw3D, environmentMap, sceneCache } from '../three-layer';
import { BALL_R, BLOCK_H, BLOCK_W, BREAK_DELAY_S, ballAt, contactAt, followAt, glow, landedIndex, noteColor, type State } from './index';
import type { Pt } from './timeline';

const U = 100;
const v3 = (p: Pt) => new THREE.Vector3((p.x - 540) / U, -p.y / U, p.z / U);
const SPARK_POOL = 900;
const TRAIL = 12;

const rgb = (c: RGB, k = 1) => new THREE.Color((c[0] / 255) * k, (c[1] / 255) * k, (c[2] / 255) * k);

/** Fog range (three.js units from the camera) per style: upcoming blocks fade into the background. */
const FOG: Record<string, [number, number]> = { 'cascade-3d': [14, 32], spiral: [10, 19], falling: [13, 29] };

const view = sceneCache((s: State, theme: Theme) => {
  const scene = new THREE.Scene();
  scene.environment = environmentMap();
  scene.environmentIntensity = 0.25;
  const [near, far] = FOG[s.p.style] ?? [10, 30];
  scene.fog = new THREE.Fog(new THREE.Color(theme.bg[1]), near, far);
  const camera = new THREE.PerspectiveCamera(45, 1080 / 1920, 0.1, 80);
  if (s.p.style === 'falling') camera.up.set(0, 0, -1);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a28, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 0.5, far: 30 });
  sun.shadow.bias = -0.0015;
  scene.add(sun, sun.target);

  // One instance per note. Each block's top face passes through the ball's contact point, tilted to
  // its bounce normal; in the spiral the long side runs round the column.
  const n = s.onsets.length;
  const blockGeo = new RoundedBoxGeometry(BLOCK_W / U, BLOCK_H / U, 0.72, 3, 0.07);
  const blockMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.05, clearcoat: 0.6, clearcoatRoughness: 0.2 });
  const blocks = new THREE.InstancedMesh(blockGeo, blockMat, n);
  blocks.castShadow = true;
  blocks.receiveShadow = true;
  const matrices: THREE.Matrix4[] = [];
  for (let i = 0; i < n; i++) {
    const nrm = s.normals[i];
    const up = new THREE.Vector3(nrm.x, -nrm.y, nrm.z).normalize();
    const along = s.p.style === 'spiral' ? new THREE.Vector3(-Math.sin(s.theta[i]), 0, Math.cos(s.theta[i])) : new THREE.Vector3(1, 0, 0);
    const xAxis = along.sub(up.clone().multiplyScalar(along.dot(up))).normalize();
    const zAxis = new THREE.Vector3().crossVectors(xAxis, up);
    // Short notes get short bars (scaled along their length only).
    const m = new THREE.Matrix4().makeBasis(xAxis.multiplyScalar(s.sizes[i]), up, zAxis);
    m.setPosition(v3(contactAt(s, i)).sub(up.clone().multiplyScalar(BLOCK_H / U / 2)));
    matrices.push(m);
    blocks.setMatrixAt(i, m);
    blocks.setColorAt(i, rgb(noteColor(theme, s, s.onsets[i].midi)));
  }
  scene.add(blocks);

  if (s.p.style === 'spiral') {
    // The dark column the blocks spiral round, banded with accent rings, the full height of the song.
    // (Emissive reads far brighter than its number once bloom runs, so it is only a hint.)
    const top = -s.lands[0].y / U + 8;
    const bottom = -s.lands[n - 1].y / U - 8;
    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(0.85, 0.85, top - bottom, 48, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x14131c, metalness: 0.75, roughness: 0.4, emissive: new THREE.Color(theme.accent), emissiveIntensity: 0.012 }),
    );
    column.position.y = (top + bottom) / 2;
    column.receiveShadow = true;
    scene.add(column);
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent).multiplyScalar(0.6) });
    for (let y = bottom; y < top; y += 1.6) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.025, 8, 64), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      scene.add(ring);
    }
  }

  const ballMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(theme.ball), roughness: 0.15, metalness: 0.2, clearcoat: 1, emissiveIntensity: 0.6 });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R / U, 40, 28), ballMat);
  ball.castShadow = true;
  scene.add(ball);

  const trail = new THREE.InstancedMesh(new THREE.SphereGeometry(BALL_R / U, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false }), TRAIL);
  scene.add(trail);

  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARK_POOL * 3), 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SPARK_POOL * 3), 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ size: 0.09, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  sparks.frustumCulled = false;
  scene.add(sparks);

  return { scene, camera, sun, blocks, matrices, ball, ballMat, trail, sparks, sparkGeo };
});

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const tmp = new THREE.Matrix4();
const tmpColor = new THREE.Color();

export function drawCascade3D(ctx: Ctx2D, theme: Theme, s: State, t: number, revealK: number) {
  const v = view(s, theme);
  const n = s.onsets.length;
  const nextIdx = landedIndex(s.onsets, t) + 1;

  // Blocks: shattered once left behind, flashing when struck, the next one pulsing.
  for (let i = 0; i < n; i++) {
    const o = s.onsets[i];
    const broken = t > o.t + BREAK_DELAY_S && i < n - 1;
    v.blocks.setMatrixAt(i, broken ? HIDDEN : v.matrices[i]);
    if (broken || i > nextIdx + 60) continue;
    let l = glow(t - o.t);
    if (i === nextIdx) l = Math.max(l, 0.25 + 0.15 * Math.sin(t * 10));
    if (revealK >= 0) l = Math.max(l, 0.8 * Math.exp(-revealK));
    const col = noteColor(theme, s, o.midi);
    // Kept well under white so the note colours survive the bloom; a hit pushes toward white.
    tmpColor.copy(rgb(col, 0.42 + 0.7 * l)).lerp(new THREE.Color(1.3, 1.3, 1.3), 0.25 * l);
    v.blocks.setColorAt(i, tmpColor);
  }
  v.blocks.instanceMatrix.needsUpdate = true;
  if (v.blocks.instanceColor) v.blocks.instanceColor.needsUpdate = true;

  // Ball: squashed for a moment after each landing, lit in the colour of the note it's heading to.
  const pt = ballAt(s.arcs, s.onsets, t);
  const i = landedIndex(s.onsets, t);
  const since = i >= 0 ? t - s.onsets[i].t : 10;
  const sq = 0.3 * Math.exp(-since * 22);
  const target = noteColor(theme, s, s.onsets[Math.min(n - 1, i + 1)].midi);
  v.ball.position.copy(v3(pt));
  v.ball.position.y -= (sq * BALL_R) / U;
  v.ball.scale.set(1 + sq, 1 - sq, 1 + sq);
  v.ballMat.emissive.copy(rgb(lighten(target, 0.2), 0.45));
  for (let k = 0; k < TRAIL; k++) {
    const p = ballAt(s.arcs, s.onsets, t - (k + 1) * 0.014);
    const scale = 0.85 - (0.6 * k) / TRAIL;
    tmp.makeScale(scale, scale, scale).setPosition(v3(p));
    v.trail.setMatrixAt(k, tmp);
    v.trail.setColorAt(k, rgb(target));
  }
  v.trail.instanceMatrix.needsUpdate = true;
  if (v.trail.instanceColor) v.trail.instanceColor.needsUpdate = true;

  // Sparks, fading as they die (additive, so darker reads as more transparent).
  const pos = v.sparkGeo.getAttribute('position') as THREE.BufferAttribute;
  const cols = v.sparkGeo.getAttribute('color') as THREE.BufferAttribute;
  const live = Math.min(SPARK_POOL, s.sparks3.length);
  for (let k = 0; k < live; k++) {
    const q = s.sparks3[s.sparks3.length - 1 - k];
    pos.setXYZ(k, (q.x - 540) / U, -q.y / U, q.z / U);
    const a = Math.min(1, (q.life / q.maxLife) * 1.5);
    cols.setXYZ(k, (q.col[0] / 255) * a, (q.col[1] / 255) * a, (q.col[2] / 255) * a);
  }
  v.sparkGeo.setDrawRange(0, live);
  pos.needsUpdate = true;
  cols.needsUpdate = true;

  placeCamera(v.camera, v.sun, v.scene.fog as THREE.Fog, s, t);
  draw3D(ctx, v.scene, v.camera);
}

/** Where the camera follows at time t: straight along the landings in time (no easing at each). */
function pathAt(s: State, t: number): { p: Pt; ang: number } {
  const n = s.lands.length;
  const i = Math.max(0, Math.min(n - 1, landedIndex(s.onsets, t)));
  const j = Math.min(n - 1, i + 1);
  const u = t <= s.onsets[0].t || j === i ? 0 : Math.min(1, (t - s.onsets[i].t) / s.onsets[i].dur);
  const a = s.lands[i];
  const b = s.lands[j];
  const ang = s.theta.length ? s.theta[i] + (s.theta[j] - s.theta[i]) * u : 0;
  return { p: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u }, ang };
}

/** The most the camera's height may trail the ball's (px), so long lobs and drops stay in frame. */
const MAX_LAG_Y = 520;

/**
 * The ball's actual flight averaged over a window either side of t (triangular weights), so the
 * camera glides through runs and held notes alike instead of stopping at every landing, and still
 * follows a held note's lob and drop. The spiral's orbit angle averages the landing path. Computed
 * from t alone, so any frame renders the same however the video is scrubbed.
 */
function smoothFollow(s: State, t: number, half: number): { p: Pt; ang: number; extent: number } {
  const N = 24;
  let w = 0;
  const acc = { x: 0, y: 0, z: 0, ang: 0, extent: 0 };
  for (let k = -N; k <= N; k++) {
    const wk = 1 - Math.abs(k) / (N + 1);
    const tk = t + (k / N) * half;
    const b = ballAt(s.arcs, s.onsets, tk);
    acc.x += b.x * wk;
    acc.y += b.y * wk;
    acc.z += b.z * wk;
    acc.ang += pathAt(s, tk).ang * wk;
    acc.extent += hopExtent(s, tk) * wk;
    w += wk;
  }
  const p = { x: acc.x / w, y: acc.y / w, z: acc.z / w };
  const by = ballAt(s.arcs, s.onsets, t).y;
  p.y = Math.min(by + MAX_LAG_Y, Math.max(by - MAX_LAG_Y, p.y));
  return { p, ang: acc.ang / w, extent: acc.extent / w };
}

/** How tall the hop in flight at t is (its rise plus its drop, px): big for a held note's lob. */
function hopExtent(s: State, t: number): number {
  const i = landedIndex(s.onsets, t);
  if (i < 0 || i + 1 >= s.arcs.length) return 0;
  const a = s.arcs[i + 1];
  const rise = a.vy < 0 ? (a.vy * a.vy) / (2 * a.g) : 0;
  return rise + Math.max(0, s.lands[i + 1].y - s.lands[i].y);
}

/** Extra camera distance (three.js units) for a hop of this extent, so its destination stays in view. */
const pullBack = (extent: number) => Math.max(0, extent - 500) / 100 * 0.9;

/**
 * Each style's camera follows the ball's landings. Falling eases from landing to landing; the
 * spiral and the 3D cascade glide on a smoothed path, since their sideways and orbiting motion
 * looks jerky when it stops at every note.
 */
function placeCamera(camera: THREE.PerspectiveCamera, sun: THREE.DirectionalLight, fog: THREE.Fog, s: State, t: number) {
  const [near, far] = FOG[s.p.style] ?? [10, 30];
  const look = new THREE.Vector3();
  if (s.p.style === 'falling') {
    const { i, e } = followAt(s, t);
    const j = Math.min(s.lands.length - 1, i + 1);
    const a = s.lands[i];
    const b = s.lands[j];
    const f = v3({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, z: a.z + (b.z - a.z) * e });
    // High above, looking down the drop: blocks rush up toward the lens as the camera descends.
    camera.position.set(f.x * 0.3, f.y + 12, f.z * 0.3 + 0.8);
    look.set(f.x * 0.3, f.y - 3, f.z * 0.3);
  } else if (s.p.style === 'spiral') {
    const sm = smoothFollow(s, t, 0.9);
    const f = v3(sm.p);
    // Orbit outside the tower, looking in at the column, aimed a little ahead: the block just left
    // has shattered, so what's on screen is what's next. Big hops pull the camera back (and the
    // fog with it) so the bar the ball is heading for stays in view.
    const back = pullBack(sm.extent);
    const phi = sm.ang + 0.25;
    camera.position.set(Math.cos(phi) * (12.5 + back), f.y + 3.6 + back * 0.15, Math.sin(phi) * (12.5 + back));
    look.set(Math.cos(phi) * 2.3, f.y + 0.3 - back * 0.35, Math.sin(phi) * 2.3);
    fog.near = near + back;
    fog.far = far + back;
  } else {
    const sm = smoothFollow(s, t, 0.8);
    const f = v3(sm.p);
    // In front and above, tilted down at the cascade, with a slow sway; pulled back for big hops.
    const back = pullBack(sm.extent);
    camera.position.set(f.x * 0.25 + 0.5 * Math.sin(t * 0.3), f.y + 3.2 + back * 0.15, 16.5 + back);
    look.set(f.x * 0.25, f.y + 0.5 - back * 0.35, 0);
    fog.near = near + back;
    fog.far = far + back;
  }
  camera.lookAt(look);
  sun.position.copy(look).add(new THREE.Vector3(3, 7, 4));
  sun.target.position.copy(look);
}
