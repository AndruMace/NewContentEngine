import { z } from 'zod';
import { FONT_FAMILY, lighten, paletteAt, type DramaScore, type Rng, type Template } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { clamp01, gaussFit } from '../scoring';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { THREE, canvasTexture, draw3D, environmentMap, sceneCache } from '../three-layer';
import { SHARD_MASS, ShellWorld, WALL_K, axisQuat, crackShell, prismPoints, qrot, worlds, type ShardSpec } from './physics';
import { polyhedron, type ShapeId, type V3 } from './polyhedra';

const SHAPES: ShapeId[] = ['cube', 'octahedron', 'dodecahedron', 'icosahedron'];

export const shellEscapeSchema = z.object({
  shells: z.number().int().min(2).max(6).default(4).meta({ title: 'Shells' }),
  shapes: z.enum(['mixed', ...SHAPES] as [string, ...string[]]).default('mixed').meta({ title: 'Shell shapes' }),
  holeSize: z.number().min(0.5).max(1.6).default(1).meta({ title: 'Hole size', step: 0.05 }),
  speed: z.number().min(0.5).max(2.5).default(1.5).meta({ title: 'Ball speed', step: 0.05 }),
  spin: z.number().min(0).max(2).default(0.5).meta({ title: 'Shell spin', step: 0.05 }),
});

export type ShellEscapeParams = z.infer<typeof shellEscapeSchema>;

interface Shell {
  shape: ShapeId;
  /** Circumradius. */
  R: number;
  axis: V3;
  omega: number;
  angle0: number;
  hole: number;
  /** The hole is the hole face shrunk toward its centre by this factor (a window the same shape as the face). */
  holeScale: number;
  ballR: number;
  hue: number;
  brokeAt: number | null;
  /** The glass pieces it breaks into, and the global id of the first. */
  shards: ShardSpec[];
  shardBase: number;
}

interface State {
  p: ShellEscapeParams;
  shells: Shell[];
  world: ShellWorld;
  freed: boolean;
  rng: Rng;
  layer: number;
  pos: V3;
  vel: V3;
  r: number;
  bounces: number;
  escapes: number[];
  lastRimT: number;
  lastChipT: number;
  lastDebrisT: number;
  endAt: number | null;
  t: number;
  visual: boolean;
  trail: V3[];
  /** Recent bounces (which face, where), for the face flash and impact ripple. */
  hits: { t: number; layer: number; face: number; p: V3; n: V3 }[];
  /** Every shard's pose (x, y, z, qx, qy, qz, qw), copied out of the world each step; and whether it's flying. */
  shardPose: Float32Array;
  shardLive: Uint8Array;
}

/** Each shell's circumradius as a fraction of the inradius of the shell around it. */
const NEST = 0.84;
/** Ball speed in active-shell inradii per second (times the speed param), set as it enters each shell. */
const SPEED_K = 2.1;
/**
 * Window size: its share of the shell's surface (times the holeSize param), the same for every
 * shape. Purely geometric: the ball escapes only by physically flying through it.
 */
const ESCAPE_CHANCE = 0.105;
const BALL_K = 0.12;
const OUTRO_S = 2.8;
/** Glass opacity on the camera's side (clear, so the ball shows) and the far side (tinted backdrop). */
const GLASS_NEAR = 0.05;
const GLASS_FAR = 0.22;
const CAM_EASE_S = 1.5;
const TRAIL = 34;
const smooth = (u: number) => u * u * (3 - 2 * u);

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/** Rodrigues rotation of v about unit axis k by angle a. */
function rotate(k: V3, a: number, v: V3): V3 {
  const c = dm.cos(a);
  const s = dm.sin(a);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

function unitVector(rng: { range(a: number, b: number): number }): V3 {
  const z = rng.range(-1, 1);
  const a = rng.range(0, Math.PI * 2);
  const r = Math.sqrt(1 - z * z);
  return [r * dm.cos(a), r * dm.sin(a), z];
}

const shellAngle = (sh: Shell, t: number) => sh.angle0 + sh.omega * t;

/** Set the ball's speed, keeping its direction. */
function setSpeed(s: State, v: number) {
  const cur = Math.hypot(...s.vel);
  if (cur < 1e-12) return;
  s.vel = scale(s.vel, v / cur);
  s.world.body(s.world.ball).setLinvel({ x: s.vel[0], y: s.vel[1], z: s.vel[2] }, true);
}

/**
 * Break a shell into its shards. Each piece starts where its glass was, moving with the spinning
 * shell, flung outward, and blasted hardest near the hole the ball came out of.
 */
function shatter(s: State, sh: Shell, layer: number, ang: number) {
  const q = axisQuat(sh.axis, ang);
  const next = s.shells[layer + 1];
  const nextPace = next ? s.p.speed * SPEED_K * polyhedron(next.shape).inradius * next.R : targetSpeed(s);
  const vBall = Math.hypot(...s.vel);
  // Lighter than the ball, more so the bigger the shell they're now rattling round in.
  const mass = SHARD_MASS * (sh.R / (next?.R ?? sh.R)) ** 2;
  const pieces = sh.shards.map((spec, k) => {
    const id = sh.shardBase + k;
    const P = qrot(q, scale(spec.c, sh.R));
    const spinV = cross(scale(sh.axis, sh.omega), P);
    const nW = qrot(q, spec.n);
    const away: V3 = [P[0] - s.pos[0], P[1] - s.pos[1], P[2] - s.pos[2]];
    const d = Math.max(1e-9, Math.hypot(...away));
    const blast = (vBall * SHATTER_BLAST * dm.exp(-d / (0.4 * sh.R))) / d;
    const out = nextPace * SHATTER_OUT * s.rng.range(0.5, 1.1);
    const v: V3 = [0, 1, 2].map((i) => spinV[i] + nW[i] * out + away[i] * blast) as V3;
    const wv: V3 = [s.rng.range(-6, 6), s.rng.range(-6, 6), s.rng.range(-6, 6)];
    s.shardLive[id] = 1;
    s.shardPose.set([P[0], P[1], P[2], q.x, q.y, q.z, q.w], id * 7);
    return { id, spec, v, w: wv, mass };
  });
  s.world.shatter(layer, sh, q, pieces);
}

const targetSpeed = (s: State) => s.p.speed * SPEED_K * polyhedron(s.shells[Math.min(s.layer, s.shells.length - 1)].shape).inradius * s.shells[Math.min(s.layer, s.shells.length - 1)].R;
/** The ball's speed drifts back to its pace over this long after the walls' spin or debris change it. */
const PACE_TAU_S = 1.2;
/** Breaking glass flies outward at this share of the ball's pace (plus a blast near where the ball got out). */
const SHATTER_OUT = 0.32;
const SHATTER_BLAST = 0.55;
/** Shards are forgotten once this many outer-shell radii away. */
const SHARD_FAR = 4;

export const shellEscape: Template<ShellEscapeParams, State> = {
  id: 'shell-escape',
  name: 'Shell Escape 3D',
  family: 'bounce',
  description:
    'A glowing ball bounces inside nested, slowly spinning glass shapes (cubes, octahedra, dodecahedra, icosahedra), rendered in 3D with real rigid-body physics. Each shell has one window; when the ball finds it, the shell shatters into glass shards that fly out and rattle round inside the next, bigger shell (where the ball can knock them about), and the camera pulls back. Every bounce plays a note and lights up the face it hit. Escape all of them to win.',
  schema: shellEscapeSchema,
  substeps: 2,
  // Rapier with flying debris: a run takes about a second to simulate.
  searchBudget: 30,
  glowScale: 0.5,
  defaultCopy: {
    hook: 'How many bounces to escape every shell?',
    cta: 'Escaped in {bounces} bounces! Guess closer?',
  },
  nudges: ['Guess the bounce count 👇', 'How many bounces to break out? 👇', 'Which shell is hardest? 👇', 'Comment your guess 👇', 'Lock in a number 👇', 'Call it before it escapes 👇'],

  init({ params: p, rng, visual }) {
    const shapes: ShapeId[] = [];
    for (let i = 0; i < p.shells; i++) {
      if (p.shapes !== 'mixed') shapes.push(p.shapes as ShapeId);
      else {
        let s: ShapeId;
        do s = rng.pick(SHAPES);
        while (i > 0 && s === shapes[i - 1]);
        shapes.push(s);
      }
    }
    // Sizes from the outside in: each shell fits (while spinning) inside the next one out.
    const R = new Array<number>(p.shells);
    R[p.shells - 1] = 1;
    for (let i = p.shells - 2; i >= 0; i--) R[i] = R[i + 1] * polyhedron(shapes[i + 1]).inradius * NEST;
    let shardBase = 0;
    const shells: Shell[] = shapes.map((shape, i) => {
      const poly = polyhedron(shape);
      // Window area as a share of the whole surface ≈ scale² / faces, so size it per shape for an
      // even pace: many-faced shapes get bigger windows.
      const holeScale = Math.min(0.97, Math.sqrt(ESCAPE_CHANCE * p.holeSize * poly.faces.length));
      const sh: Shell = {
        shape,
        R: R[i],
        axis: unitVector(rng),
        omega: p.spin * rng.range(0.7, 1.3) * (i % 2 ? -1 : 1),
        angle0: rng.range(0, Math.PI * 2),
        hole: rng.int(0, poly.faces.length - 1),
        holeScale,
        ballR: BALL_K * poly.inradius * R[i],
        hue: (i + 0.5) / p.shells,
        brokeAt: null,
        shards: [],
        shardBase,
      };
      sh.shards = crackShell(sh, rng);
      shardBase += sh.shards.length;
      return sh;
    });
    const world = new ShellWorld(shells, shells[0].ballR, shardBase);
    const s: State = {
      p,
      shells,
      world,
      freed: false,
      rng,
      layer: 0,
      pos: [0, 0, 0],
      vel: [0, 0, 0],
      r: shells[0].ballR,
      bounces: 0,
      escapes: [],
      lastRimT: -1,
      lastChipT: -1,
      lastDebrisT: -1,
      endAt: null,
      t: 0,
      visual,
      trail: [],
      hits: [],
      shardPose: new Float32Array(shardBase * 7),
      shardLive: new Uint8Array(shardBase),
    };
    s.vel = scale(unitVector(rng), targetSpeed(s));
    world.setBall(s.pos, s.vel);
    worlds.register(s, world);
    return s;
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    if (s.freed) return;
    const w = s.world;
    const n = s.shells.length;
    // Shells turn to where they'll be at the end of this step.
    s.shells.forEach((sh, i) => {
      if (sh.brokeAt === null) w.spin(i, axisQuat(sh.axis, shellAngle(sh, t + dt)));
    });
    if (s.layer < n) {
      const want = s.shells[s.layer].ballR;
      if (Math.abs(want - s.r) > want * 1e-4) {
        s.r += (want - s.r) * Math.min(1, dt * 5);
        w.setBallRadius(s.r);
      }
    }
    const contacts = w.advance();
    const ball = w.body(w.ball);
    const bp = ball.translation();
    const bv = ball.linvel();
    s.pos = [bp.x, bp.y, bp.z];
    s.vel = [bv.x, bv.y, bv.z];
    if (s.visual) {
      s.trail.push([s.pos[0], s.pos[1], s.pos[2]]);
      if (s.trail.length > TRAIL) s.trail.shift();
    }
    const curR = s.shells[Math.min(s.layer, n - 1)].R;
    const pace = targetSpeed(s);

    for (const c of contacts) {
      const ballHit = c.a.kind === 'ball' ? c.b : c.b.kind === 'ball' ? c.a : null;
      if (ballHit?.kind === 'wall') {
        if (ballHit.layer !== s.layer) continue;
        const sh = s.shells[s.layer];
        const face = polyhedron(sh.shape).faces[ballHit.face];
        const ang = shellAngle(sh, t + dt);
        const nw = rotate(sh.axis, ang, face.n);
        s.bounces++;
        s.hits.push({ t, layer: s.layer, face: ballHit.face, p: [s.pos[0] + nw[0] * s.r, s.pos[1] + nw[1] * s.r, s.pos[2] + nw[2] * s.r], n: nw });
        if (s.hits.length > 8) s.hits.shift();
        emit({ type: 'bounce', layer: s.layer, x: s.pos[0] / sh.R });
        if (ballHit.face === sh.hole && t - s.lastRimT > 0.25) {
          // Struck the window's frame: a near miss when it was within a ball and a half of the opening.
          const local = rotate(sh.axis, -ang, s.pos);
          const dist = dot(local, face.n);
          const inPlane: V3 = [local[0] - face.n[0] * dist, local[1] - face.n[1] * dist, local[2] - face.n[2] * dist];
          let clearance = Infinity;
          for (const m of face.edgeNormals) clearance = Math.min(clearance, face.apothem * sh.holeScale * sh.R - dot(inPlane, m));
          if (clearance > -s.r * 1.5) {
            s.lastRimT = t;
            emit({ type: 'rim', layer: s.layer });
          }
        }
      } else if (ballHit?.kind === 'shard') {
        if (c.speed < pace * 0.05 || t - s.lastChipT < 0.06) continue;
        s.lastChipT = t;
        emit({ type: 'chip', speed: c.speed / pace, x: s.pos[0] / curR });
      } else if (!ballHit && (c.a.kind === 'shard' || c.b.kind === 'shard')) {
        // Glass on glass: the rattle of debris (thinned, so a cloud of shards doesn't machine-gun).
        if (c.speed < pace * 0.08 || t - s.lastDebrisT < 0.05) continue;
        s.lastDebrisT = t;
        const id = c.a.kind === 'shard' ? c.a.id : (c.b as { id: number }).id;
        emit({ type: 'debris', speed: c.speed / pace, x: s.shardPose[id * 7] / curR });
      }
    }

    if (s.layer < n) {
      const sh = s.shells[s.layer];
      const poly = polyhedron(sh.shape);
      const ang = shellAngle(sh, t + dt);
      const local = rotate(sh.axis, -ang, s.pos);
      let out = -Infinity;
      let via = -1;
      poly.faces.forEach((face, f) => {
        const d = dot(local, face.n) - face.d * sh.R;
        if (d > out) {
          out = d;
          via = f;
        }
      });
      if (out > s.r * 1.1 + WALL_K * sh.R) {
        // Out: the shell breaks, and the ball takes on the next shell's pace (direction unchanged).
        sh.brokeAt = t;
        s.escapes.push(t);
        shatter(s, sh, s.layer, ang);
        s.layer++;
        emit({ type: 'escape', layer: s.layer, of: n, bounces: s.bounces, viaWindow: via === sh.hole });
        if (s.layer >= n) {
          s.endAt = t;
          emit({ type: 'free', bounces: s.bounces });
        } else setSpeed(s, targetSpeed(s));
      } else {
        // Hold the pace: the spinning walls and knocks from debris drift it a little.
        const v = Math.hypot(...s.vel);
        if (v > 1e-9) setSpeed(s, v + (pace - v) * (1 - dm.exp(-dt / PACE_TAU_S)));
      }
    } else {
      // Free: glide to a stop while still in frame.
      setSpeed(s, Math.hypot(...s.vel) * dm.exp(-2.2 * dt));
    }

    // Copy the shards out (the view and the sound read them), forgetting the far-flung ones.
    const far = SHARD_FAR * s.shells[n - 1].R;
    for (let id = 0; id < s.shardLive.length; id++) {
      const h = w.shardBodies[id];
      if (h === null) continue;
      const b = w.body(h);
      const p = b.translation();
      if (Math.abs(p.x) > far || Math.abs(p.y) > far || Math.abs(p.z) > far) {
        w.dropShard(id);
        s.shardLive[id] = 0;
        continue;
      }
      const q = b.rotation();
      s.shardPose.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w], id * 7);
    }

    if (s.endAt !== null && s.t >= s.endAt + OUTRO_S) {
      w.free();
      s.freed = true;
    }
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    return { left: s.shells.length - s.layer, bounces: s.bounces, outro: s.endAt !== null };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.8, y: 0.12 },
      { kind: 'counter', key: 'left', label: 'SHELLS LEFT', y: 0.215, size: 110 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.17 },
    ];
  },

  render({ ctx, theme }, s) {
    const v = view(s, theme);
    // Camera: frames the active shell and eases back after every escape, so the shell in play
    // always fills about the same part of the screen.
    const viewR = (i: number) => (i < s.shells.length ? s.shells[i].R : s.shells[s.shells.length - 1].R * 1.35);
    let R = viewR(0);
    s.escapes.forEach((te, i) => {
      const u = clamp01((s.t - te) / CAM_EASE_S);
      const e = u * u * (3 - 2 * u);
      R = viewR(i) + (viewR(i + 1) - viewR(i)) * e;
    });
    const dist = R * CAM_DIST;
    const az = s.t * 0.22;
    const el = 0.3 + 0.08 * Math.sin(s.t * 0.4);
    const cam = new THREE.Vector3(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    // After the last escape the camera turns to keep the free ball centred.
    const outro = s.endAt !== null ? smooth(clamp01((s.t - s.endAt) / 1.2)) : 0;
    const look = new THREE.Vector3(...s.pos).multiplyScalar(outro);

    v.shells.forEach((g, i) => {
      const sh = s.shells[i];
      const broken = sh.brokeAt !== null && s.t >= sh.brokeAt;
      const ang = shellAngle(sh, broken ? sh.brokeAt! : s.t);
      g.group.quaternion.setFromAxisAngle(new THREE.Vector3(...sh.axis), ang);
      if (!broken) {
        // Only the shell in play is shown: the ones around it are wider than the portrait frame, and
        // their edges cutting across it made the active shell hard to read.
        const active = i === s.layer;
        g.group.visible = active;
        if (!active) return;
        const poly = polyhedron(sh.shape);
        // How much each face looks toward the camera (1 near side, 0 far side), softened so edges
        // don't pop as the shell turns.
        const facing = poly.faces.map((face) => {
          const n = new THREE.Vector3(...rotate(sh.axis, ang, face.n));
          const c = n.clone().multiplyScalar(face.d * sh.R);
          return clamp01(n.dot(cam.clone().sub(c).normalize()) * 4 + 0.5);
        });
        // Near edges bright and thick, far edges thin and dim: no more guessing which side is front.
        g.edgeMeshes.forEach((m, e) => {
          const [a, b] = g.edgeFaces[e];
          const f = Math.max(facing[a] ?? 0, facing[b] ?? 0);
          const thick = 0.55 + 0.95 * f;
          m.scale.set(thick, 1, thick);
          g.edgeMats[e].opacity = 0.16 + 0.84 * f;
        });
        // The window: a thick, pulsing white frame, unlike any edge.
        g.rimMat.opacity = 0.8 + 0.2 * Math.sin(s.t * 6);
        g.rims.forEach((m) => m.scale.set(1 + 0.25 * (0.5 + 0.5 * Math.sin(s.t * 6)), 1, 1 + 0.25 * (0.5 + 0.5 * Math.sin(s.t * 6))));
        g.faceMats.forEach((m, f) => {
          m.visible = true;
          // The face the ball just hit lights up.
          let flash = 0;
          for (const h of s.hits) if (h.layer === i && h.face === f && s.t >= h.t) flash = Math.max(flash, Math.exp(-(s.t - h.t) * 7));
          // Near glass nearly clear (the ball shows through), far glass tinted: the ball is always
          // seen against the back wall, which reads as depth.
          m.opacity = GLASS_FAR - (GLASS_FAR - GLASS_NEAR) * facing[f] + 0.3 * flash;
          m.emissiveIntensity = 0.85 * flash;
        });
        updateAim(g, s, i, ang);
        return;
      }
      // Broken: the shell is gone, its shards (drawn below) are flying.
      g.group.visible = false;
    });
    // Shards: wherever the physics has them. Older debris (from shells further in) fades back, so
    // the newest break and the ball stay readable.
    v.shardMats.forEach((m, i) => {
      const age = Math.max(0, s.layer - 1 - i);
      const k = age === 0 ? 1 : age === 1 ? 0.45 : 0.2;
      m.glass.opacity = 0.16 * k;
      m.edge.opacity = 0.4 * k;
    });
    v.shards.forEach((m, id) => {
      m.visible = s.shardLive[id] === 1;
      if (!m.visible) return;
      const o = id * 7;
      m.position.set(s.shardPose[o], s.shardPose[o + 1], s.shardPose[o + 2]);
      m.quaternion.set(s.shardPose[o + 3], s.shardPose[o + 4], s.shardPose[o + 5], s.shardPose[o + 6]);
    });
    // Final escape: a shockwave ring expanding from where the ball broke out.
    if (s.endAt !== null) {
      const tau = s.t - s.endAt;
      v.wave.visible = tau < 1.6;
      const out = s.shells[s.shells.length - 1];
      v.wave.position.copy(look);
      v.wave.scale.setScalar(out.R * (0.4 + 2.6 * tau));
      (v.wave.material as THREE.MeshBasicMaterial).opacity = clamp01(1 - tau / 1.6);
      v.wave.lookAt(cam);
    }
    // Depth fog: the far side of the shell dims.
    (v.scene.fog as THREE.Fog).near = dist - R * 0.6;
    (v.scene.fog as THREE.Fog).far = dist + R * 2.6;
    // Ball, light and trail. The light falls off with distance, so the face it's nearest glows.
    const activeR = s.shells[Math.min(s.layer, s.shells.length - 1)].R;
    v.ball.position.set(...s.pos);
    v.ball.scale.setScalar(s.r);
    v.light.position.set(...s.pos);
    v.light.intensity = 0.9 * activeR * activeR;
    v.trail.forEach((m, i) => {
      const pt = s.trail[s.trail.length - 1 - i];
      m.visible = !!pt && i > 0;
      if (!pt) return;
      m.position.set(...pt);
      m.scale.setScalar(s.r * (0.8 - (0.65 * i) / v.trail.length));
      (m.material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - i / v.trail.length);
    });
    v.camera.position.copy(cam);
    v.camera.near = R * 0.05;
    v.camera.far = R * 40;
    v.camera.updateProjectionMatrix();
    v.camera.lookAt(look);
    draw3D(ctx, v.scene, v.camera);
  },

  renderTop({ ctx, theme }, s) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.font = `900 44px ${FONT_FAMILY}`;
    const label = `${s.bounces} bounces`;
    ctx.lineWidth = 9;
    ctx.strokeStyle = theme.textStroke;
    ctx.strokeText(label, 540, 1920 * 0.74);
    ctx.fillStyle = theme.text;
    ctx.fillText(label, 540, 1920 * 0.74);
    ctx.restore();
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, (e.x as number) * 0.8)) : 0;
    switch (e.type) {
      case 'bounce':
        if (e.t - lastNoteT < 0.07) return [{ kind: 'sfx', name: 'tick', vel: 0.2, pan }];
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? 0.28 : 0.62, voice: theme.voice, pan }));
      case 'rim':
        return [{ kind: 'sfx', name: 'tick', vel: 0.45, pitch: 1 }];
      case 'chip': {
        // The ball knocking a shard: a glass clink (kept out of the top octave: partials near
        // Nyquist overshoot the true-peak ceiling once encoded).
        const v = clamp01((e.speed as number) / 1.2);
        return [{ kind: 'sfx', name: 'clink', vel: 0.05 + 0.18 * v, pitch: 0.25 + 0.2 * v, pan }];
      }
      case 'debris': {
        // Shards tinkling against the glass and each other.
        const v = clamp01((e.speed as number) / 1.2);
        return [{ kind: 'sfx', name: 'clink', vel: 0.025 + 0.08 * v, pitch: 0.4 + 0.15 * v, pan }];
      }
      case 'escape': {
        const k = e.layer as number;
        const penta = [0, 2, 4, 7, 9];
        return [
          { kind: 'sfx', name: 'shatter', vel: 0.7, pitch: k / Math.max(1, e.of as number) },
          { kind: 'note', midi: 72 + penta[k % 5] + 12 * Math.floor(k / 5), vel: 0.45, voice: 'bell', dur: 1.6 },
        ];
      }
      case 'free':
        return [
          { kind: 'sfx', name: 'boom', vel: 1 },
          { kind: 'sfx', name: 'whoosh', vel: 0.7 },
          ...melody.peek().flatMap((midi) => [
            { kind: 'note' as const, midi, vel: 0.8, voice: 'bell' as const, dur: 2.5 },
            { kind: 'note' as const, midi: midi + 12, vel: 0.5, voice: 'bell' as const, dur: 2.5 },
          ]),
        ];
    }
    return [];
  },

  score(events, { durationS, targetS, timedOut }): DramaScore {
    const durFit = gaussFit(durationS, targetS, targetS * 0.25);
    const free = events.find((e) => e.type === 'free');
    if (timedOut || !free) return { total: 0.02 * durFit, parts: { durFit }, notes: ['never escaped'] };
    const escapes = events.filter((e) => e.type === 'escape').map((e) => e.t);
    const gaps = escapes.map((te, i) => te - (i ? escapes[i - 1] : 0));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    // Escapes spread through the video (no layer over in a blink, none dragging on).
    const evenFit = 1 - clamp01(sd / mean / 0.9);
    const rims = events.filter((e) => e.type === 'rim').length;
    const rimFit = 1 - dm.exp(-rims / 5);
    const bps = events.filter((e) => e.type === 'bounce').length / free.t;
    const paceFit = gaussFit(bps, 2.5, 1.6);
    return {
      total: durFit * (0.35 + 0.3 * evenFit + 0.2 * rimFit + 0.15 * paceFit),
      parts: { durFit, evenFit, rimFit, paceFit },
      notes: [`${free.bounces} bounces`, `${rims} near misses`],
    };
  },
};

// ---- 3D scene ---------------------------------------------------------------------------------------

interface ShellView {
  group: THREE.Group;
  edges: THREE.Group;
  edgeMeshes: THREE.Mesh[];
  edgeMats: THREE.MeshBasicMaterial[];
  /** The two faces that meet at each edge. */
  edgeFaces: [number, number][];
  faces: THREE.Mesh[];
  centers: THREE.Vector3[];
  faceMats: THREE.MeshPhysicalMaterial[];
  /** Where the ball will hit next: a soft spot that grows brighter as impact nears (gold if it's the window). */
  aim: THREE.Mesh;
  aimMat: THREE.MeshBasicMaterial;
  rimMat: THREE.MeshBasicMaterial;
  rims: THREE.Mesh[];
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const CAM_DIST = 4.4;
const AIM_LEAD_S = 1.1;

/**
 * Aim spot: on the face the ball is heading for, where it will land, fading in over the last
 * AIM_LEAD_S seconds. When the landing point is inside the window it turns gold, so viewers see
 * an escape coming (and feel the near misses).
 */
function updateAim(g: ShellView, s: State, i: number, ang: number) {
  const sh = s.shells[i];
  g.aim.visible = false;
  if (i !== s.layer || s.endAt !== null) return;
  const poly = polyhedron(sh.shape);
  const local = rotate(sh.axis, -ang, s.pos);
  const vel = rotate(sh.axis, -ang, s.vel);
  let best = -1;
  let tHit = Infinity;
  poly.faces.forEach((face, f) => {
    const vn = dot(vel, face.n);
    if (vn <= 1e-9) return;
    const tf = (face.d * sh.R - s.r - dot(local, face.n)) / vn;
    if (tf >= 0 && tf < tHit) {
      tHit = tf;
      best = f;
    }
  });
  if (best < 0 || tHit > AIM_LEAD_S) return;
  const face = poly.faces[best];
  const hit: V3 = [local[0] + vel[0] * tHit, local[1] + vel[1] * tHit, local[2] + vel[2] * tHit];
  const dist = dot(hit, face.n);
  const inPlane: V3 = [hit[0] - face.n[0] * dist, hit[1] - face.n[1] * dist, hit[2] - face.n[2] * dist];
  let clearance = Infinity;
  for (const m of face.edgeNormals) clearance = Math.min(clearance, face.apothem * sh.holeScale * sh.R - dot(inPlane, m));
  const window = best === sh.hole && clearance >= s.r;
  const near = 1 - tHit / AIM_LEAD_S;
  const k = 1 / sh.R;
  g.aim.visible = true;
  g.aim.position.set((inPlane[0] + face.n[0] * (face.d * sh.R - 0.004 * sh.R)) * k, (inPlane[1] + face.n[1] * (face.d * sh.R - 0.004 * sh.R)) * k, (inPlane[2] + face.n[2] * (face.d * sh.R - 0.004 * sh.R)) * k);
  g.aim.quaternion.setFromUnitVectors(Z_AXIS, new THREE.Vector3(...face.n));
  g.aim.scale.setScalar((s.r / sh.R) * (window ? 2.6 : 1.8) * (1.2 + 0.8 * (1 - near)));
  g.aimMat.color.set(window ? '#ffffff' : g.aimMat.userData.base);
  g.aimMat.opacity = Math.min(1, 0.3 + 0.9 * near);
}

const view = sceneCache((s: State, theme) => {
  const scene = new THREE.Scene();
  scene.environment = environmentMap();
  scene.fog = new THREE.Fog(new THREE.Color(theme.bg[1]), 1, 10);
  const camera = new THREE.PerspectiveCamera(52, 1080 / 1920, 0.01, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(2, 3, 2.5);
  scene.add(sun);
  // Physical falloff; intensity is rescaled with the active shell's size each frame (render).
  const light = new THREE.PointLight(new THREE.Color(theme.accent), 1, 0, 2);
  // Aim spot: a solid core with a soft edge, so it reads on bright glass too.
  const aimTex = canvasTexture(128, 128, (c) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
  });
  const spotGeo = new THREE.PlaneGeometry(2, 2);
  scene.add(light);

  const shells: ShellView[] = s.shells.map((sh) => {
    const poly = polyhedron(sh.shape);
    const col = paletteAt(theme.palette, sh.hue);
    const color = new THREE.Color(`rgb(${col.map((c) => Math.round(c)).join(',')})`);
    const edgeCol = col;
    const group = new THREE.Group();
    group.scale.setScalar(sh.R);
    const glass = new THREE.MeshPhysicalMaterial({
      color,
      transparent: true,
      opacity: GLASS_FAR,
      roughness: 0.1,
      metalness: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      envMapIntensity: 0.5,
      emissive: new THREE.Color(`rgb(${lighten(col, 0.5).map((c) => Math.round(c)).join(',')})`),
      emissiveIntensity: 0,
    });
    const faceMats: THREE.MeshPhysicalMaterial[] = [];
    const faces: THREE.Mesh[] = [];
    const centers: THREE.Vector3[] = [];
    const rimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff'), transparent: true });
    const rims: THREE.Mesh[] = [];
    poly.faces.forEach((face, f) => {
      const c = new THREE.Vector3(...face.n).multiplyScalar(face.d);
      const u = new THREE.Vector3(...face.pts[0]).sub(c).normalize();
      const n = new THREE.Vector3(...face.n);
      const w = new THREE.Vector3().crossVectors(n, u);
      const shape = new THREE.Shape(face.pts.map((p) => {
        const d = new THREE.Vector3(...p).sub(c);
        return new THREE.Vector2(d.dot(u), d.dot(w));
      }));
      const window2d = face.pts.map((p) => {
        const d = new THREE.Vector3(...p).sub(c).multiplyScalar(sh.holeScale);
        return new THREE.Vector2(d.dot(u), d.dot(w));
      });
      if (f === sh.hole) shape.holes.push(new THREE.Path(window2d.slice().reverse()));
      const geo = new THREE.ShapeGeometry(shape, 32);
      geo.applyMatrix4(new THREE.Matrix4().makeBasis(u, w, n));
      const mat = glass.clone();
      faceMats.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(c);
      group.add(mesh);
      faces.push(mesh);
      centers.push(c.clone());
      if (f === sh.hole) {
        // Glowing outline around the window.
        const basis = new THREE.Matrix4().makeBasis(u, w, n);
        window2d.forEach((a, e) => {
          const b = window2d[(e + 1) % window2d.length];
          const va = new THREE.Vector3(a.x, a.y, 0).applyMatrix4(basis);
          const vb = new THREE.Vector3(b.x, b.y, 0).applyMatrix4(basis);
          const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, va.distanceTo(vb), 10), rimMat);
          seg.position.copy(va).add(vb).multiplyScalar(0.5);
          seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
          mesh.add(seg);
          rims.push(seg);
        });
      }
    });
    const edges = new THREE.Group();
    const edgeColor = new THREE.Color(`rgb(${edgeCol.map((c) => Math.round(c)).join(',')})`);
    const up = new THREE.Vector3(0, 1, 0);
    const near = (p: V3, q: V3) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 1e-6;
    const edgeMeshes: THREE.Mesh[] = [];
    const edgeMats: THREE.MeshBasicMaterial[] = [];
    const edgeFaces: [number, number][] = [];
    for (const [a, b] of poly.edges) {
      const va = new THREE.Vector3(...a);
      const vb = new THREE.Vector3(...b);
      const len = va.distanceTo(vb);
      // Each edge has its own material: its brightness depends on whether it's on the near side.
      const mat = new THREE.MeshBasicMaterial({ color: edgeColor, transparent: true });
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, len, 8), mat);
      m.position.copy(va).add(vb).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(up, vb.clone().sub(va).normalize());
      edges.add(m);
      edgeMeshes.push(m);
      edgeMats.push(mat);
      const adj = poly.faces.flatMap((face, f) => (face.pts.some((p) => near(p, a)) && face.pts.some((p) => near(p, b)) ? [f] : []));
      edgeFaces.push([adj[0] ?? 0, adj[1] ?? adj[0] ?? 0]);
    }
    group.add(edges);
    const aimMat = new THREE.MeshBasicMaterial({ map: aimTex, color: new THREE.Color(theme.accent), transparent: true, depthWrite: false, side: THREE.DoubleSide });
    aimMat.userData.base = theme.accent;
    const aim = new THREE.Mesh(spotGeo, aimMat);
    aim.visible = false;
    group.add(aim);
    scene.add(group);
    glass.dispose();
    return { group, edges, edgeMeshes, edgeMats, edgeFaces, faces, centers, faceMats, aim, aimMat, rimMat, rims };
  });

  // Shards: a thin slab of the shell's glass each, with bright cut edges that catch the light.
  const shards: THREE.Mesh[] = [];
  const shardMats: { glass: THREE.MeshPhysicalMaterial; edge: THREE.LineBasicMaterial }[] = [];
  s.shells.forEach((sh) => {
    const col = paletteAt(theme.palette, sh.hue);
    const color = new THREE.Color(`rgb(${col.map((c) => Math.round(c)).join(',')})`);
    const mat = new THREE.MeshPhysicalMaterial({
      color,
      transparent: true,
      opacity: 0.16,
      roughness: 0.06,
      metalness: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      envMapIntensity: 0.6,
      emissive: new THREE.Color(`rgb(${lighten(col, 0.5).map((c) => Math.round(c)).join(',')})`),
      emissiveIntensity: 0.04,
    });
    const edgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(`rgb(${lighten(col, 0.2).map((c) => Math.round(c)).join(',')})`), transparent: true, opacity: 0.4 });
    shardMats.push({ glass: mat, edge: edgeMat });
    for (const spec of sh.shards) {
      const pts = prismPoints(spec.poly, spec.n, spec.c, sh.R, WALL_K * sh.R);
      const vs: THREE.Vector3[] = [];
      for (let i = 0; i < pts.length; i += 3) vs.push(new THREE.Vector3(pts[i], pts[i + 1], pts[i + 2]));
      const geo = new ConvexGeometry(vs);
      const m = new THREE.Mesh(geo, mat);
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), edgeMat));
      m.visible = false;
      scene.add(m);
      shards.push(m);
    }
  });

  const ballCol = new THREE.Color(theme.ball);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), new THREE.MeshStandardMaterial({ color: ballCol, emissive: ballCol, emissiveIntensity: 0.9, roughness: 0.25 }));
  scene.add(ball);
  const trailGeo = new THREE.SphereGeometry(1, 16, 12);
  const trail = Array.from({ length: TRAIL - 2 }, () => {
    const m = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent), transparent: true, opacity: 0.4, depthWrite: false }));
    scene.add(m);
    return m;
  });
  const wave = new THREE.Mesh(new THREE.TorusGeometry(1, 0.02, 12, 96), new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent), transparent: true, depthWrite: false }));
  wave.visible = false;
  scene.add(wave);
  return { scene, camera, light, shells, shards, shardMats, ball, trail, wave };
});
