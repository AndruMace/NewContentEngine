/**
 * Marble Race 3D's view: the tower dressed in the chosen look (see looks.ts), marbles wearing their
 * team's colours, checkpoint lines with banners, and a camera that frames the marbles deciding the
 * race. Drawing only: the race is on the tape.
 */
import { FONT_FAMILY, type Ctx2D, type Theme } from '@sim/engine';
import { THREE, canvasTexture, draw3D, draw3DComposed, sceneCache } from '../three-layer';
import { boxMapUVs, hash, latheUVs } from '../rube-goldberg/view3d';
import { kitFor, type LookId } from './looks';
import { funnelGeometry, turnGeometry } from './shapes';
import type { Piece } from '../rube-goldberg/sim';
import { R, W, type Course } from './course';
import type { State } from './index';

export const FOV = 40;
const ELEVATION = 0.34;
const NEAR_D = 0.72;
const FAR_D = 1.6;

export interface CameraTrack {
  /** Where the camera stands across (slow), and what it looks at (close behind the action). */
  px: Float32Array;
  lx: Float32Array;
  ly: Float32Array;
  lz: Float32Array;
  d: Float32Array;
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

/**
 * The camera's track, from the race's per-frame framing [x, y, z, width, height] (smoothed both ways along
 * the tape, so no lag). The pack sweeps from side to side of the tower on every lane: rather than
 * whip across with it, the camera stands near the middle and turns to follow (like a spectator),
 * coming down the tower with the marbles, and stands back when the ones that matter spread out.
 */
export function cameraTrack(focus: Float32Array, course: Course): CameraTrack {
  const n = Math.max(1, focus.length / 5);
  const px = new Float32Array(n);
  const lx = new Float32Array(n);
  const ly = new Float32Array(n);
  const lz = new Float32Array(n);
  const d = new Float32Array(n);
  const mid = (course.minX + course.maxX) / 2;
  for (let f = 0; f < n; f++) {
    const [x, y, z, w, h] = [focus[f * 5], focus[f * 5 + 1], focus[f * 5 + 2], focus[f * 5 + 3], focus[f * 5 + 4]];
    px[f] = mid + (x - mid) * 0.4;
    lx[f] = x;
    ly[f] = y;
    lz[f] = z * 0.6;
    // Back far enough to take in the marbles that matter, with a margin (the frame is narrow).
    const tanV = Math.tan((FOV / 2) * (Math.PI / 180));
    const need = Math.max((h / 2 + 0.06) / tanV, (w / 2 + 0.05) / (tanV * (1080 / 1920)));
    d[f] = Math.max(NEAR_D, Math.min(FAR_D, need));
  }
  return { px: smoothSeries(px, 1.2, 60), lx: smoothSeries(lx, 0.3, 60), ly: smoothSeries(ly, 0.3, 60), lz: smoothSeries(lz, 0.8, 60), d: smoothSeries(rollingMax(d, 45), 0.5, 60) };
}

/** The largest value within ±r samples: smoothing then can't average a brief need to stand back away. */
function rollingMax(xs: Float32Array, r: number): Float32Array {
  const out = new Float32Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - r); j <= Math.min(xs.length - 1, i + r); j++) m = Math.max(m, xs[j]);
    out[i] = m;
  }
  return out;
}

/** Where the camera stands and looks at time t. */
export function cameraPose(s: State, t: number) {
  const c = s.camera;
  const u = Math.max(0, Math.min(c.lx.length - 1, t * 60));
  const i = Math.floor(u);
  const j = Math.min(c.lx.length - 1, i + 1);
  const a = u - i;
  const at = (xs: Float32Array) => xs[i] + (xs[j] - xs[i]) * a;
  const look = new THREE.Vector3(at(c.lx), at(c.ly), at(c.lz));
  const d = at(c.d);
  // A slow sway round the tower keeps it reading as 3D.
  const yaw = 0.15 * Math.sin(t * 0.13 + 0.6);
  const pos = new THREE.Vector3(at(c.px) + Math.sin(yaw) * Math.cos(ELEVATION) * d, look.y + Math.sin(ELEVATION) * d, look.z + Math.cos(yaw) * Math.cos(ELEVATION) * d);
  return { pos, look };
}

/** A marble's position at time t (for tests and the winner's ring). */
export function marbleAt(s: State, i: number, t: number) {
  const f = Math.max(0, Math.min(s.frames.length - 1, Math.round(t * 60)));
  const o = s.marbles[i] * 7;
  return new THREE.Vector3(s.frames[f][o], s.frames[f][o + 1], s.frames[f][o + 2]);
}

function geometryOf(shape: Piece['shape']): THREE.BufferGeometry {
  switch (shape.kind) {
    case 'box': {
      const g = new THREE.BoxGeometry(shape.hx * 2, shape.hy * 2, shape.hz * 2);
      // Real-scale texture coordinates: grain runs along each plank.
      boxMapUVs(g);
      return g;
    }
    case 'sphere':
      return new THREE.SphereGeometry(shape.r, 32, 20);
    case 'cylinder':
      return new THREE.CylinderGeometry(shape.r, shape.r, shape.hh * 2, 24);
    case 'capsule':
      return new THREE.CapsuleGeometry(shape.r, shape.hh * 2, 6, 12);
    case 'torus':
      return new THREE.TorusGeometry(shape.R, shape.r, 8, 48).rotateX(Math.PI / 2);
    case 'mesh': {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(shape.positions, 3));
      g.setIndex(new THREE.BufferAttribute(shape.indices, 1));
      g.computeVertexNormals();
      // Turns and funnels are all round a vertical axis: map u round it and v up it (spun metal,
      // and brushed-metal anisotropy needs coordinates to find its direction).
      latheUVs(g);
      return g;
    }
  }
}

/** A soft round dot (snowflakes). */
function flakeTexture() {
  return canvasTexture(32, 32, (c) => {
    const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 32, 32);
  });
}

const BURST = 14;
const FLAKES = 1400;
/** The box of falling snow kept round the camera's target (it wraps, so flakes stay put in the world). */
const SNOW_BOX = [1.4, 1.6, 1.2] as const;

const view = sceneCache((s: State, theme: Theme) => {
  const kit = kitFor(s.p.look as LookId, theme);
  const scene = new THREE.Scene();
  scene.environment = kit.env;
  scene.environmentIntensity = kit.envIntensity;
  if (kit.background) scene.background = kit.background;
  if (kit.haze) scene.fog = new THREE.Fog(kit.haze, 1, 4);
  const camera = new THREE.PerspectiveCamera(FOV, 1080 / 1920, 0.02, 30);
  const key = kit.lights(scene);
  const boxes: THREE.Box3[] = [];

  // Turns and funnels, drawn smooth from their shapes (their colliders are coarse meshes).
  for (const spec of [...s.course.turns.map((t) => ({ geo: turnGeometry(t), hue: t.hue })), ...s.course.funnels.map((f) => ({ geo: funnelGeometry(f), hue: f.hue }))]) {
    const m = new THREE.Mesh(spec.geo, kit.turn(spec.hue));
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    if (kit.meshEdges) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(spec.geo, 60), new THREE.LineBasicMaterial({ color: kit.meshEdges, transparent: true, opacity: 0.5 })));
    boxes.push(new THREE.Box3().setFromObject(m));
  }

  // The tower.
  for (const p of s.statics) {
    if (p.shape.kind === 'mesh') continue;
    const geo = geometryOf(p.shape);
    const pos = new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z);
    const rot = new THREE.Quaternion(p.rot.x, p.rot.y, p.rot.z, p.rot.w);
    if (p.finish === 'glass' && !(kit.wall instanceof THREE.Material)) {
      // Clear walls: in a photo you see their polished edges (a see-through sheet reads as a grey
      // veil under the post effects).
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: kit.wall.edges, transparent: true, opacity: kit.wall.opacity }));
      e.position.copy(pos);
      e.quaternion.copy(rot);
      scene.add(e);
    } else {
      const mat =
        p.finish === 'glass'
          ? (kit.wall as THREE.Material)
          : p.finish === 'steel'
            ? kit.peg
            : p.finish === 'felt'
              ? kit.pad
              : kit.floor(p.hue ?? 0);
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(pos);
      m.quaternion.copy(rot);
      m.castShadow = p.finish !== 'glass';
      m.receiveShadow = p.finish !== 'glass';
      m.renderOrder = p.finish === 'glass' ? 2 : 0;
      scene.add(m);
      if (p.finish !== 'glass') boxes.push(new THREE.Box3().setFromObject(m));
    }
    // Rail caps along the wall tops: walnut, a light strip, a ridge of snow.
    if (p.finish === 'glass' && p.shape.kind === 'box' && kit.wallCap) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(p.shape.hx * 2 + 0.0006, kit.capHeight, p.shape.hz * 2 + 0.0016), kit.wallCap);
      boxMapUVs(cap.geometry);
      cap.position.copy(new THREE.Vector3(0, p.shape.hy + kit.capHeight / 2 - 0.0005, 0).applyQuaternion(rot).add(pos));
      cap.quaternion.copy(rot);
      cap.castShadow = true;
      scene.add(cap);
    }
  }

  // Set dressing: the wall the tower is mounted on, what it stands on, the brackets holding it.
  const c = s.course;
  const top = Math.max(...c.path.map((p) => p.y)) + 0.15;
  const bottom = c.bottom - 0.1;
  const wallZ = c.minZ - 0.05;
  if (kit.backdrop) {
    const h = top - bottom + 1.2;
    const board = new THREE.Mesh(new THREE.BoxGeometry(2.6, h, 0.02), kit.backdrop);
    // Real-scale tiling for the board's texture.
    const map = (kit.backdrop as THREE.MeshStandardMaterial).map;
    if (map) map.repeat.set(map.repeat.x, Math.max(map.repeat.y, (map.repeat.x * h) / 2.6));
    board.position.set((c.minX + c.maxX) / 2, (top + bottom) / 2 - 0.3, wallZ - 0.01);
    board.receiveShadow = true;
    scene.add(board);
  }
  if (kit.bench) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.05, 0.7), kit.bench);
    boxMapUVs(bench.geometry);
    bench.position.set((c.minX + c.maxX) / 2, bottom - 0.025, wallZ + 0.35);
    bench.receiveShadow = true;
    scene.add(bench);
  }
  if (kit.ground) {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), kit.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = kit.bench ? bottom - 0.9 : bottom - 0.05;
    ground.receiveShadow = true;
    scene.add(ground);
  }
  kit.dress?.(scene, { minX: c.minX, maxX: c.maxX, top, bottom, wallZ });
  if (kit.bracket) {
    // Two brackets per lane, from its back edge straight to the wall, unless something is in the way.
    const rod = new THREE.CylinderGeometry(0.0022, 0.0022, 1, 12);
    const rose = new THREE.CylinderGeometry(0.007, 0.007, 0.003, 20).rotateX(Math.PI / 2);
    for (const p of s.statics) {
      if (p.finish !== 'paint' || p.shape.kind !== 'box') continue;
      const rot = new THREE.Quaternion(p.rot.x, p.rot.y, p.rot.z, p.rot.w);
      for (const side of [-0.6, 0.6]) {
        const a = new THREE.Vector3(p.shape.hx * side, -p.shape.hy, -p.shape.hz).applyQuaternion(rot).add(new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z));
        a.y -= 0.003;
        const len = a.z - wallZ;
        // Only short ones: long rods reaching back past other lanes read as stray lines.
        if (len < 0.01 || len > 0.13) continue;
        let clear = true;
        for (let zz = a.z - 0.012; zz > wallZ && clear; zz -= 0.006) {
          const q = new THREE.Vector3(a.x, a.y, zz);
          for (const b of boxes) if (b.containsPoint(q)) clear = false;
        }
        if (!clear) continue;
        const m = new THREE.Mesh(rod, kit.bracket);
        m.scale.y = len;
        m.rotation.x = Math.PI / 2;
        m.position.set(a.x, a.y, (a.z + wallZ) / 2);
        m.castShadow = true;
        scene.add(m);
        const r = new THREE.Mesh(rose, kit.bracket);
        r.position.set(a.x, a.y, wallZ + 0.0015);
        scene.add(r);
      }
    }
  }

  // Moving parts: marbles, gates, spinners.
  const marbleIdx = new Map(s.marbles.map((b, i) => [b, i]));
  const bodies = s.bodies.map((b, bi) => {
    const g = new THREE.Group();
    const mi = marbleIdx.get(bi);
    if (mi !== undefined) {
      const team = s.teams[mi];
      g.add(kit.marble(team));
      if (kit.outlines) {
        // An outline in the team's colour that shows through the track: your marble never
        // vanishes behind a lane.
        const outline = new THREE.Mesh(
          new THREE.RingGeometry(R * 1.12, R * 1.32, 40),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(team.color), transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
        );
        outline.renderOrder = 10;
        scene.add(outline);
        g.userData.outline = outline;
      }
    } else {
      for (const p of b.pieces) {
        // Gates and spinners are painted pieces with no palette hue; contraptions (trapdoor flaps,
        // elevator slats, paddle wheels) wear the track's own materials.
        const machine = p.finish === 'paint' && p.hue === -1;
        const isGate = machine && p.shape.kind === 'box' && p.shape.hz > 0.02;
        if (isGate) g.userData.gate = true;
        const geo = geometryOf(p.shape);
        let obj: THREE.Object3D;
        if (p.finish === 'glass' && !(kit.wall instanceof THREE.Material)) obj = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: kit.wall.edges, transparent: true, opacity: kit.wall.opacity }));
        else {
          const mat = machine ? (isGate ? kit.gate : kit.spinner) : p.finish === 'glass' ? (kit.wall as THREE.Material) : p.finish === 'brass' ? kit.turn(p.hue ?? 0) : p.finish === 'steel' ? (kit.bracket ?? kit.peg) : kit.floor(p.hue ?? 0);
          const m = new THREE.Mesh(geo, mat);
          m.castShadow = true;
          m.receiveShadow = !machine;
          obj = m;
        }
        obj.position.set(p.pos.x, p.pos.y, p.pos.z);
        obj.quaternion.set(p.rot.x, p.rot.y, p.rot.z, p.rot.w);
        g.add(obj);
      }
    }
    scene.add(g);
    return g;
  });

  // Checkpoint lines (painted or lit across the lane) and their banners.
  const lines = c.lines.map((l, i) => {
    const last = i === c.lines.length - 1;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.0008, W), (last ? kit.finishLine : kit.line).clone());
    (strip.material as THREE.Material).transparent = true;
    strip.position.set(l.at.x, l.at.y + 0.0005, l.at.z);
    strip.receiveShadow = true;
    scene.add(strip);
    const text = last ? 'FINISH' : s.mode === 'elimination' ? `ELIMINATION ${i + 1}/${c.lines.length}` : `CHECKPOINT ${i + 1}`;
    // Its banner is drawn flat over the frame (after the 3D), above the line.
    return { strip, text, color: last ? '#ffffff' : kit.banner.text, at: new THREE.Vector3(l.at.x, l.at.y + 0.045, l.at.z) };
  });

  // Knock-out bursts: a ring of sparks in the marble's colour.
  const sparkGeo = new THREE.SphereGeometry(R * 0.28, 8, 6);
  const bursts = s.teams.map((team) => {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(team.color), transparent: true });
    const parts = Array.from({ length: BURST }, () => {
      const m = new THREE.Mesh(sparkGeo, mat);
      m.visible = false;
      scene.add(m);
      return m;
    });
    return { mat, parts };
  });

  // The winner: a ring (stylised) or a warm spotlight from above (photoreal).
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R * 1.6, R * 0.12, 10, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff'), transparent: true }));
  ring.visible = false;
  scene.add(ring);
  const spot = new THREE.SpotLight(0xfff0d8, 0, 0.6, 0.35, 0.6, 1.5);
  scene.add(spot, spot.target);

  // Falling snow.
  let snow: { points: THREE.Points; base: Float32Array } | null = null;
  if (kit.snow) {
    const base = new Float32Array(FLAKES * 3);
    for (let i = 0; i < FLAKES; i++) for (let k = 0; k < 3; k++) base[i * 3 + k] = hash(i * 3 + k + 7) * SNOW_BOX[k];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FLAKES * 3), 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({ map: flakeTexture(), size: 0.006, transparent: true, depthWrite: false, opacity: 0.95 }));
    points.frustumCulled = false;
    scene.add(points);
    snow = { points, base };
  }
  return { kit, scene, camera, key, bodies, lines, bursts, ring, spot, snow };
});

export function drawRace3D(ctx: Ctx2D, theme: Theme, s: State, t: number) {
  const v = view(s, theme);
  const { kit } = v;
  const f = Math.max(0, Math.min(s.frames.length - 1, Math.round(t * 60)));
  const fr = s.frames[f];
  const first = s.frames[0];
  s.bodies.forEach((_, bi) => {
    const g = v.bodies[bi];
    const o = bi * 7;
    g.position.set(fr[o], fr[o + 1], fr[o + 2]);
    g.quaternion.set(fr[o + 3], fr[o + 4], fr[o + 5], fr[o + 6]);
    // Gates are gone once they've lifted clear (they'd hang over the track).
    if (g.userData.gate && fr[o + 1] > first[o + 1] + 0.03) g.visible = false;
  });
  const { pos, look } = cameraPose(s, t);
  // Knocked-out marbles burst and vanish.
  s.marbles.forEach((bi, i) => {
    const out = s.outAt[i];
    v.bodies[bi].visible = out < 0 || t < out;
    const ring = v.bodies[bi].userData.outline as THREE.Mesh | undefined;
    if (ring) {
      ring.visible = v.bodies[bi].visible;
      ring.position.copy(v.bodies[bi].position);
      ring.lookAt(pos);
    }
    const b = v.bursts[i];
    const tau = out >= 0 ? t - out : -1;
    const on = tau >= 0 && tau < 0.9;
    b.parts.forEach((m, k) => {
      m.visible = on;
      if (!on) return;
      const a = (k / BURST) * Math.PI * 2;
      const up = 0.6 + 0.4 * Math.sin(k * 2.3);
      const sp = 0.25 + 0.1 * Math.cos(k * 1.7);
      const c = v.bodies[bi].position;
      m.position.set(c.x + Math.cos(a) * sp * tau, c.y + up * sp * tau - 2.5 * tau * tau, c.z + Math.sin(a) * sp * tau);
      m.scale.setScalar(1 - tau / 0.9);
    });
    b.mat.opacity = on ? 1 - tau / 0.9 : 0;
  });
  // Lines already decided fade back; only the line in play has its banner up.
  const lead = s.progress[f] ? Math.max(...s.progress[f].filter((_, i) => s.outAt[i] < 0 || t < s.outAt[i])) : 0;
  const live = s.mode === 'elimination' ? s.nextCp : s.course.lines.findIndex((l) => l.s > lead);
  const won = s.winner >= 0 && s.k >= s.winStep;
  v.lines.forEach((l, i) => {
    (l.strip.material as THREE.Material).opacity = i < live ? 0.35 : 1;
  });

  v.camera.position.copy(pos);
  v.camera.lookAt(look);
  v.camera.updateProjectionMatrix();
  const d = pos.distanceTo(look);
  if (v.scene.fog) {
    const fog = v.scene.fog as THREE.Fog;
    // Photoreal looks: a light haze far off; stylised: the tower fades into the theme's backdrop.
    fog.near = d * (kit.post.composed ? 2.2 : 0.9);
    fog.far = d * (kit.post.composed ? 14 : 3.2);
  }
  // The key light (and its shadows) follows the action.
  v.key.position.set(look.x + 0.6, look.y + 1.4, look.z + 1.1);
  v.key.target.position.copy(look);
  const sc = v.key.shadow.camera;
  const half = d * 0.6;
  sc.left = -half;
  sc.right = half;
  sc.top = half;
  sc.bottom = -half;
  sc.updateProjectionMatrix();

  // The winner.
  v.ring.visible = won && kit.outlines;
  if (won) {
    const w = marbleAt(s, s.winner, t);
    if (kit.outlines) {
      v.ring.position.copy(w);
      v.ring.lookAt(pos);
      v.ring.scale.setScalar(1 + 0.18 * Math.sin(t * 10));
    } else {
      const u = Math.min(1, (s.k - s.winStep) / 240 / 0.5);
      v.spot.intensity = 6 * u;
      v.spot.position.set(w.x, w.y + 0.25, w.z + 0.08);
      v.spot.target.position.copy(w);
    }
  }

  if (v.snow) {
    const arr = (v.snow.points.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const o = [look.x - SNOW_BOX[0] / 2, look.y - SNOW_BOX[1] / 2, look.z - SNOW_BOX[2] / 2];
    const wrap = (x: number, m: number) => ((x % m) + m) % m;
    for (let i = 0; i < FLAKES; i++) {
      const b = v.snow.base;
      // Each flake falls at its own pace and drifts on the breeze.
      const fall = t * (0.05 + 0.04 * hash(i + 99));
      const drift = 0.012 * Math.sin(t * (0.6 + hash(i + 5)) + i);
      arr[i * 3] = o[0] + wrap(b[i * 3] + drift + t * 0.01 - o[0], SNOW_BOX[0]);
      arr[i * 3 + 1] = o[1] + wrap(b[i * 3 + 1] - fall - o[1], SNOW_BOX[1]);
      arr[i * 3 + 2] = o[2] + wrap(b[i * 3 + 2] - o[2], SNOW_BOX[2]);
    }
    v.snow.points.geometry.getAttribute('position').needsUpdate = true;
  }

  if (kit.post.composed) {
    // Ambient occlusion grounds every joint and contact; a shallow depth of field sells the scale.
    draw3DComposed(ctx, v.scene, v.camera, {
      exposure: kit.post.exposure,
      toneMapping: kit.post.toneMapping,
      ao: { radius: 0.02, scale: 1 },
      dof: { focus: d, aperture: kit.post.aperture, maxblur: 0.006 },
    });
  } else draw3D(ctx, v.scene, v.camera, { exposure: kit.post.exposure, toneMapping: kit.post.toneMapping });

  // The banner over the line in play, drawn flat on top (crisp, and untouched by the post effects).
  const l = v.lines[live];
  if (l && !won) {
    const q = l.at.clone().project(v.camera);
    if (q.z < 1 && Math.abs(q.x) < 1.2 && Math.abs(q.y) < 1.2) drawBanner(ctx, l.text, l.color, kit.banner.back, (q.x * 0.5 + 0.5) * 1080, (0.5 - q.y * 0.5) * 1920, 0.7 / d);
  }
}

function drawBanner(ctx: Ctx2D, text: string, color: string, back: string, x: number, y: number, scale: number) {
  const size = Math.max(22, Math.min(40, 40 * scale));
  ctx.save();
  ctx.font = `900 ${size}px ${FONT_FAMILY}`;
  const w = ctx.measureText(text).width + size * 1.2;
  const h = size * 1.55;
  ctx.fillStyle = back;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + size * 0.05);
  ctx.restore();
}
