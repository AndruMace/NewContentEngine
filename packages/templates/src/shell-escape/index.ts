import { z } from 'zod';
import { FONT_FAMILY, lighten, paletteAt, type DramaScore, type Rng, type Template } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { clamp01, gaussFit } from '../scoring';
import { THREE, canvasTexture, draw3D, environmentMap, sceneCache } from '../three-layer';
import { polyhedron, type ShapeId, type V3 } from './polyhedra';

const SHAPES: ShapeId[] = ['cube', 'octahedron', 'dodecahedron', 'icosahedron'];

export const shellEscapeSchema = z.object({
  shells: z.number().int().min(2).max(6).default(4).meta({ title: 'Shells' }),
  shapes: z.enum(['mixed', ...SHAPES] as [string, ...string[]]).default('mixed').meta({ title: 'Shell shapes' }),
  holeSize: z.number().min(0.5).max(1.6).default(1).meta({ title: 'Hole size (escape chance per bounce)', step: 0.05 }),
  speed: z.number().min(0.5).max(2.5).default(1.5).meta({ title: 'Ball speed', step: 0.05 }),
  spin: z.number().min(0).max(2).default(0.7).meta({ title: 'Shell spin', step: 0.05 }),
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
}

interface State {
  p: ShellEscapeParams;
  shells: Shell[];
  layer: number;
  pos: V3;
  vel: V3;
  r: number;
  passing: boolean;
  bounces: number;
  escapes: number[];
  lastRimT: number;
  endAt: number | null;
  t: number;
  visual: boolean;
  rng: Rng;
  trail: V3[];
  /** Recent bounces (which face, where), for the face flash and impact ripple. */
  hits: { t: number; layer: number; face: number; p: V3; n: V3 }[];
}

/** Each shell's circumradius as a fraction of the inradius of the shell around it. */
const NEST = 0.84;
/** Ball speed in active-shell inradii per second (times the speed param). */
const SPEED_K = 2.1;
/** Target chance that a bounce lands in the hole (times the holeSize param), the same for every shape. */
const ESCAPE_CHANCE = 0.09;
/** Seeded wobble on each bounce so the ball never settles into a path that keeps missing the hole. */
const JITTER = 0.14;
const BALL_K = 0.12;
const OUTRO_S = 2.8;
const GLASS = 0.14;

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
const targetSpeed = (s: State) => s.p.speed * SPEED_K * polyhedron(s.shells[Math.min(s.layer, s.shells.length - 1)].shape).inradius * s.shells[Math.min(s.layer, s.shells.length - 1)].R;

export const shellEscape: Template<ShellEscapeParams, State> = {
  id: 'shell-escape',
  name: 'Shell Escape 3D',
  family: 'bounce',
  description:
    'A glowing ball bounces inside nested, slowly spinning glass shapes (cubes, octahedra, dodecahedra, icosahedra), rendered in 3D. Each shell has one window; when the ball finds it, the shell shatters and the camera pulls back to the next, bigger shell. Every bounce plays a note and lights up the face it hit. Escape all of them to win.',
  schema: shellEscapeSchema,
  substeps: 4,
  glowScale: 0.8,
  defaultCopy: {
    hook: 'How many bounces to escape every shell?',
    cta: 'Escaped in {bounces} bounces! Guess closer?',
  },

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
    const shells: Shell[] = shapes.map((shape, i) => {
      const poly = polyhedron(shape);
      // Window area as a share of the whole surface ≈ scale² / faces, so size it per shape for an
      // even pace: many-faced shapes get bigger windows.
      const holeScale = Math.min(0.97, Math.sqrt(ESCAPE_CHANCE * p.holeSize * poly.faces.length));
      return {
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
      };
    });
    const s: State = {
      p,
      shells,
      layer: 0,
      pos: [0, 0, 0],
      vel: [0, 0, 0],
      r: shells[0].ballR,
      passing: false,
      bounces: 0,
      escapes: [],
      lastRimT: -1,
      endAt: null,
      t: 0,
      visual,
      rng,
      trail: [],
      hits: [],
    };
    s.vel = scale(unitVector(rng), targetSpeed(s));
    return s;
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    const { pos, vel } = s;
    for (let k = 0; k < 3; k++) pos[k] += vel[k] * dt;
    if (s.visual && Math.round(t * 240) % 2 === 0) {
      s.trail.push([pos[0], pos[1], pos[2]]);
      if (s.trail.length > 22) s.trail.shift();
    }
    if (s.layer >= s.shells.length) {
      // Free: glide to a stop while still in frame.
      const k = dm.exp(-2.2 * dt);
      for (let i = 0; i < 3; i++) vel[i] *= k;
      return;
    }
    const sh = s.shells[s.layer];
    const poly = polyhedron(sh.shape);
    s.r += (sh.ballR - s.r) * Math.min(1, dt * 5);
    const ang = shellAngle(sh, t + dt);
    const local = rotate(sh.axis, -ang, pos);
    const spinV = cross(scale(sh.axis, sh.omega), pos);
    const speed = targetSpeed(s);

    // The hole face goes first: while the ball is passing through the window, the other faces'
    // planes (which extend past the shell) must not bounce it back.
    const order = [sh.hole, ...poly.faces.map((_, f) => f).filter((f) => f !== sh.hole)];
    for (const f of order) {
      if (s.passing && f !== sh.hole) break;
      const face = poly.faces[f];
      const D = face.d * sh.R;
      const dist = dot(local, face.n);
      if (f === sh.hole) {
        // How far inside the window's edges the ball's centre is (≥ ball radius: it fits through).
        const inPlane: V3 = [local[0] - face.n[0] * dist, local[1] - face.n[1] * dist, local[2] - face.n[2] * dist];
        let clearance = Infinity;
        for (const m of face.edgeNormals) clearance = Math.min(clearance, face.apothem * sh.holeScale * sh.R - dot(inPlane, m));
        if (s.passing && dist < D - s.r) s.passing = false; // came back in
        // Mid-pass, the spinning window can slide out from under the ball: unless it's already fully
        // outside, it then hits the frame and bounces back in like any other wall.
        const fits = clearance >= s.r || (s.passing && (clearance >= 0 || dist >= D + s.r));
        if (!fits) s.passing = false;
        if (dist > D - s.r && fits) {
          s.passing = true;
          if (dist > D + s.r * 1.1) {
            sh.brokeAt = t;
            s.escapes.push(t);
            s.layer++;
            s.passing = false;
            emit({ type: 'escape', layer: s.layer, of: s.shells.length, bounces: s.bounces });
            if (s.layer >= s.shells.length) {
              s.endAt = t;
              emit({ type: 'free', bounces: s.bounces });
            } else {
              const k = targetSpeed(s) / Math.sqrt(dot(vel, vel));
              for (let i = 0; i < 3; i++) vel[i] *= k;
            }
            return;
          }
          continue;
        }
        if (dist > D - s.r && clearance > -s.r * 1.5 && t - s.lastRimT > 0.25) {
          s.lastRimT = t;
          emit({ type: 'rim', layer: s.layer });
        }
      }
      if (dist <= D - s.r) continue;
      // Bounce off the (moving) face: reflect the velocity relative to the spinning wall.
      const n = rotate(sh.axis, ang, face.n);
      const over = dist - (D - s.r);
      for (let i = 0; i < 3; i++) pos[i] -= n[i] * over;
      const u: V3 = [vel[0] - spinV[0], vel[1] - spinV[1], vel[2] - spinV[2]];
      const un = dot(u, n);
      if (un > 0) {
        const j = unitVector(s.rng);
        const sp0 = Math.sqrt(dot(u, u));
        for (let i = 0; i < 3; i++) vel[i] = u[i] - 2 * un * n[i] + spinV[i] + j[i] * JITTER * sp0;
        // Never let the wobble point it back into the wall.
        const back = dot(vel, n);
        if (back > 0) for (let i = 0; i < 3; i++) vel[i] -= 2 * back * n[i];
        const k = speed / Math.sqrt(dot(vel, vel));
        for (let i = 0; i < 3; i++) vel[i] *= k;
        s.bounces++;
        s.hits.push({ t, layer: s.layer, face: f, p: [pos[0] + n[0] * s.r, pos[1] + n[1] * s.r, pos[2] + n[2] * s.r], n });
        if (s.hits.length > 8) s.hits.shift();
        emit({ type: 'bounce', layer: s.layer, x: pos[0] / sh.R });
      }
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
    // Camera: frames the active shell and pulls back after every escape.
    const viewR = (i: number) => (i < s.shells.length ? s.shells[i].R : 1.5);
    let R = viewR(0);
    s.escapes.forEach((te, i) => {
      const u = clamp01((s.t - te) / 1.1);
      const e = u * u * (3 - 2 * u);
      R = viewR(i) + (viewR(i + 1) - viewR(i)) * e;
    });
    // A wide lens close in gives strong perspective: the ball visibly grows and shrinks with depth.
    const dist = R * CAM_DIST;
    v.shells.forEach((g, i) => {
      const sh = s.shells[i];
      const broken = sh.brokeAt !== null && s.t >= sh.brokeAt;
      const ang = shellAngle(sh, broken ? sh.brokeAt! : s.t);
      g.group.quaternion.setFromAxisAngle(new THREE.Vector3(...sh.axis), ang);
      if (!broken) {
        // Shells the camera is inside (or about to be) fade to faint edges, and fill in as it pulls back.
        // Only the active shell has glass; the ones around it are faint outlines until the camera
        // pulls back to them (and vanish while the camera is inside them).
        const fade = clamp01((dist - sh.R * 1.4) / (sh.R * 1.6));
        const active = i === s.layer;
        g.group.visible = active || fade > 0.01;
        g.edgeMat.opacity = active ? 1 : 0.3 * fade;
        g.rimMat.opacity = active ? 1 : 0.3 * fade;
        g.faceMats.forEach((m, f) => {
          m.visible = active;
          // The face the ball just hit lights up.
          let flash = 0;
          for (const h of s.hits) if (h.layer === i && h.face === f && s.t >= h.t) flash = Math.max(flash, Math.exp(-(s.t - h.t) * 7));
          m.opacity = GLASS + 0.32 * flash;
          m.emissiveIntensity = 0.85 * flash;
        });
        updateMarkers(g, s, i, ang);
        return;
      }
      // Shatter: faces fly outward, tumbling and fading.
      const tau = s.t - sh.brokeAt!;
      g.group.visible = tau < 1.4;
      g.edges.visible = false;
      for (const m of g.markers) m.visible = false;
      for (const m of g.faceMats) {
        m.visible = true;
        m.emissiveIntensity = 0;
        m.opacity = GLASS * clamp01(1 - tau / 1.4);
      }
      g.faces.forEach((m, f) => {
        const c = g.centers[f];
        m.position.copy(c).multiplyScalar(1 + 2.6 * tau + 1.5 * tau * tau);
        m.rotation.set(tau * (3 + (f % 3)), tau * (2 + (f % 4)), 0);
      });
    });
    // Final escape: a shockwave ring expanding from where the ball broke out.
    if (s.endAt !== null) {
      const tau = s.t - s.endAt;
      v.wave.visible = tau < 1.6;
      const out = s.shells[s.shells.length - 1];
      v.wave.scale.setScalar(out.R * (1 + 3.5 * tau));
      (v.wave.material as THREE.MeshBasicMaterial).opacity = clamp01(1 - tau / 1.6);
      v.wave.lookAt(v.camera.position);
    }
    // Impact ripples where the ball touched the wall.
    let ri = 0;
    for (const h of s.hits) {
      const tau = s.t - h.t;
      if (tau < 0 || tau > 0.45 || ri >= v.ripples.length) continue;
      const m = v.ripples[ri++];
      m.visible = true;
      m.position.set(...h.p);
      m.quaternion.setFromUnitVectors(Z_AXIS, new THREE.Vector3(...h.n));
      m.scale.setScalar(s.r * (1.1 + 6 * tau));
      (m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - tau / 0.45);
    }
    for (; ri < v.ripples.length; ri++) v.ripples[ri].visible = false;
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
      m.scale.setScalar(s.r * (0.85 - (0.7 * i) / v.trail.length));
      (m.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - i / v.trail.length);
    });
    const az = s.t * 0.22;
    const el = 0.3 + 0.08 * Math.sin(s.t * 0.4);
    v.camera.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    v.camera.near = R * 0.05;
    v.camera.far = R * 40;
    v.camera.updateProjectionMatrix();
    v.camera.lookAt(0, 0, 0);
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
  faces: THREE.Mesh[];
  centers: THREE.Vector3[];
  faceMats: THREE.MeshPhysicalMaterial[];
  markers: THREE.Mesh[];
  edgeMat: THREE.MeshBasicMaterial;
  rimMat: THREE.MeshBasicMaterial;
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const CAM_DIST = 4.4;

/** Proximity spots: a soft glow on each face, under the ball, that sharpens and brightens as it nears. */
function updateMarkers(g: ShellView, s: State, i: number, ang: number) {
  const active = i === s.layer;
  const sh = s.shells[i];
  const poly = polyhedron(sh.shape);
  const local = rotate(sh.axis, -ang, s.pos);
  const pl: V3 = [local[0] / sh.R, local[1] / sh.R, local[2] / sh.R];
  const rUnit = s.r / sh.R;
  poly.faces.forEach((face, f) => {
    const m = g.markers[f];
    if (!active) {
      m.visible = false;
      return;
    }
    const dist = dot(pl, face.n);
    const gap = face.d - dist;
    const inPlane: V3 = [pl[0] - face.n[0] * dist, pl[1] - face.n[1] * dist, pl[2] - face.n[2] * dist];
    const inside = face.edgeNormals.every((e) => dot(inPlane, e) <= face.apothem);
    const near = clamp01(1 - gap / (0.65 * poly.inradius));
    m.visible = inside && near > 0.01;
    if (!m.visible) return;
    m.position.set(inPlane[0] + face.n[0] * (face.d - 0.004), inPlane[1] + face.n[1] * (face.d - 0.004), inPlane[2] + face.n[2] * (face.d - 0.004));
    m.scale.setScalar(rUnit * (1.3 + 2.4 * (1 - near)));
    (m.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 1.3 * near * near);
  });
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
  const spotTex = canvasTexture(128, 128, (c) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
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
    const edgeCol = lighten(col, 0.2);
    const group = new THREE.Group();
    group.scale.setScalar(sh.R);
    const glass = new THREE.MeshPhysicalMaterial({
      color,
      transparent: true,
      opacity: GLASS,
      roughness: 0.1,
      metalness: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      envMapIntensity: 0.5,
      emissive: new THREE.Color(`rgb(${lighten(col, 0.5).map((c) => Math.round(c)).join(',')})`),
      emissiveIntensity: 0,
    });
    const faceMats: THREE.MeshPhysicalMaterial[] = [];
    const markers: THREE.Mesh[] = [];
    const faces: THREE.Mesh[] = [];
    const centers: THREE.Vector3[] = [];
    const rimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent), transparent: true });
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
      const marker = new THREE.Mesh(spotGeo, new THREE.MeshBasicMaterial({ map: spotTex, color: new THREE.Color(theme.accent), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      marker.quaternion.setFromUnitVectors(Z_AXIS, n);
      marker.visible = false;
      group.add(marker);
      markers.push(marker);
      if (f === sh.hole) {
        // Glowing outline around the window.
        const basis = new THREE.Matrix4().makeBasis(u, w, n);
        window2d.forEach((a, e) => {
          const b = window2d[(e + 1) % window2d.length];
          const va = new THREE.Vector3(a.x, a.y, 0).applyMatrix4(basis);
          const vb = new THREE.Vector3(b.x, b.y, 0).applyMatrix4(basis);
          const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, va.distanceTo(vb), 8), rimMat);
          seg.position.copy(va).add(vb).multiplyScalar(0.5);
          seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
          mesh.add(seg);
        });
      }
    });
    const edges = new THREE.Group();
    const edgeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(`rgb(${edgeCol.map((c) => Math.round(c)).join(',')})`), transparent: true });
    const up = new THREE.Vector3(0, 1, 0);
    for (const [a, b] of poly.edges) {
      const va = new THREE.Vector3(...a);
      const vb = new THREE.Vector3(...b);
      const len = va.distanceTo(vb);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, len, 8), edgeMat);
      m.position.copy(va).add(vb).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(up, vb.clone().sub(va).normalize());
      edges.add(m);
    }
    group.add(edges);
    scene.add(group);
    glass.dispose();
    return { group, edges, faces, centers, faceMats, markers, edgeMat, rimMat };
  });

  const ballCol = new THREE.Color(theme.ball);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), new THREE.MeshStandardMaterial({ color: ballCol, emissive: ballCol, emissiveIntensity: 0.9, roughness: 0.25 }));
  scene.add(ball);
  const trailGeo = new THREE.SphereGeometry(1, 16, 12);
  const trail = Array.from({ length: 20 }, () => {
    const m = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent), transparent: true, opacity: 0.4, depthWrite: false }));
    scene.add(m);
    return m;
  });
  const wave = new THREE.Mesh(new THREE.TorusGeometry(1, 0.02, 12, 96), new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent), transparent: true, depthWrite: false }));
  wave.visible = false;
  scene.add(wave);
  const ripples = Array.from({ length: 6 }, () => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.72, 1, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent), transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    m.visible = false;
    scene.add(m);
    return m;
  });
  return { scene, camera, light, shells, ball, trail, wave, ripples };
});
