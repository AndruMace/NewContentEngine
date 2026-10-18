/**
 * The Marble Machine's three.js view. Rendering only: everything is drawn from the schedule as a
 * pure function of time. Rails are generated from the routes' own marble paths, so marbles always
 * run exactly on them.
 */
import { paletteAt, type Ctx2D, type Theme } from '@sim/engine';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { THREE, draw3D, environmentMap, sceneCache } from '../three-layer';
import { cameraAt } from './camera';
import {
  BARS,
  BASS_LEVER,
  BUCKET_DT,
  DOMINO,
  DRUM,
  DRUM_OMEGA,
  GATE_Y,
  HELIX,
  HOPPER,
  LIFT,
  MARBLE_R,
  RAIL,
  SEESAWS,
  TRIGGER_PHI,
  TROUGH,
  WHEEL,
  bassLeverAngle,
  bucketY,
  dominoTilt,
  leverAngle,
  wheelAngle,
} from './machine';
import { ROUTES, routeToExit } from './routes';
import { Path, v3, type Seg, type V3 } from './segments';
import type { State } from './index';

const RAIL_KINDS = new Set(['rail', 'helix', 'loop', 'trough', 'top']);
const PEG_POOL = 160;
const BUCKET_POOL = 28;

/** A bar's colour along the theme palette (offset per video), darker for bass bars. */
function barColor(theme: Theme, s: State, ch: number): THREE.Color {
  const n = s.channels.length;
  const u = ((n > 1 ? ch / (n - 1) : 0.5) * 0.85 + s.hueShift * 0.15) % 1;
  const c = new THREE.Color(...(paletteAt(theme.palette, u).map((v) => v / 255) as [number, number, number]));
  return s.channels[ch].bass ? c.multiplyScalar(0.65) : c;
}

/**
 * Two rails under a run of marble path: offset below the marble (outside it, round a loop) and to
 * either side of its direction of travel.
 */
function railsFor(points: V3[], loop: boolean, mat: THREE.Material): THREE.Mesh[] {
  if (points.length < 2) return [];
  const up = new THREE.Vector3(0, 1, 0);
  const out: THREE.Vector3[][] = [[], []];
  for (let k = 0; k < points.length; k++) {
    const a = points[Math.max(0, k - 1)];
    const b = points[Math.min(points.length - 1, k + 1)];
    const tan = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
    const side = loop ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3().crossVectors(tan, up);
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
    side.normalize();
    const nrm = new THREE.Vector3().crossVectors(side, tan).normalize();
    const p = new THREE.Vector3(points[k].x, points[k].y, points[k].z).addScaledVector(nrm, -MARBLE_R * 0.8);
    out[0].push(p.clone().addScaledVector(side, 0.065));
    out[1].push(p.clone().addScaledVector(side, -0.065));
  }
  return out.map((pts) => new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 0.02, 6, false), mat));
}

/** Sample a run of segments (the kinds that sit on rails) into point lists, one per continuous run. */
function railRuns(segs: Seg[]): { pts: V3[]; loop: boolean }[] {
  const runs: { pts: V3[]; loop: boolean }[] = [];
  let cur: { pts: V3[]; loop: boolean } | null = null;
  for (const g of segs) {
    if (!RAIL_KINDS.has(g.kind)) {
      cur = null;
      continue;
    }
    const loop = g.kind === 'loop';
    if (!cur || cur.loop !== loop) {
      cur = { pts: [], loop };
      runs.push(cur);
    }
    const n = Math.max(2, Math.ceil((g.t1 - g.t0) / 0.03));
    for (let k = 0; k <= n; k++) cur.pts.push(g.at(g.t0 + ((g.t1 - g.t0) * k) / n));
  }
  return runs;
}

const view = sceneCache((s: State, theme: Theme) => {
  const scene = new THREE.Scene();
  scene.environment = environmentMap();
  scene.environmentIntensity = 0.45;
  const camera = new THREE.PerspectiveCamera(40, 1080 / 1920, 0.1, 80);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a28, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(3, 14, 8);
  sun.target.position.set(0, 5, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 8, bottom: -8, near: 1, far: 30 });
  sun.shadow.bias = -0.001;
  scene.add(sun, sun.target);
  const rim = new THREE.DirectionalLight(new THREE.Color(theme.accent), 0.5);
  rim.position.set(-5, 6, -6);
  scene.add(rim);

  const accent = new THREE.Color(theme.accent);
  const brass = new THREE.MeshStandardMaterial({ color: 0xd4ae5a, metalness: 0.85, roughness: 0.3 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9ccd6, metalness: 0.9, roughness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24222c, metalness: 0.4, roughness: 0.6 });

  // Base platform and the backboard everything is mounted on.
  const base = new THREE.Mesh(new RoundedBoxGeometry(6.6, 0.18, 3.6, 3, 0.05), new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.75, metalness: 0.05 }));
  base.position.set(0, -0.09, 0.15);
  base.receiveShadow = true;
  scene.add(base);
  const board = new THREE.Mesh(new THREE.BoxGeometry(6.4, 11.2, 0.1), new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.bg[1]).lerp(new THREE.Color(0x202030), 0.6), roughness: 0.85, metalness: 0.1 }));
  board.position.set(0, 5.6, -1.85);
  board.receiveShadow = true;
  scene.add(board);
  for (const x of [-3.15, 3.15]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 11.2, 0.14), dark);
    post.position.set(x, 5.6, -1.75);
    scene.add(post);
  }

  // Rails: every contraption route, the trough, the top rail and the hopper spiral.
  for (const kind of ROUTES) {
    if (kind === 'direct') continue;
    for (const run of railRuns(routeToExit(kind, 0, MARBLE_R, [], [[], []]).segs)) for (const m of railsFor(run.pts, run.loop, brass)) scene.add(m);
  }
  const troughY = (x: number) => TROUGH.y0 + ((TROUGH.y1 - TROUGH.y0) * (x + 2.8)) / (TROUGH.xEnd + 2.8);
  const trough = Array.from({ length: 40 }, (_, k) => {
    const x = -2.8 + ((TROUGH.xEnd + 2.8) * k) / 39;
    return v3(x, troughY(x) + MARBLE_R, TROUGH.z);
  });
  for (const m of railsFor(trough, false, brass)) scene.add(m);
  const top = new Path(0, v3(LIFT.x, RAIL.y + MARBLE_R, RAIL.z))
    .rail(v3(RAIL.xEnd, RAIL.y + MARBLE_R, RAIL.z), 2.6, 'top')
    .rail(v3(HOPPER.x + HOPPER.r, HOPPER.y + 0.25, HOPPER.z), 1.6)
    .helix(HOPPER.x, HOPPER.z, HOPPER.r, 1.25, HOPPER.y - 0.3, 1.4);
  for (const run of railRuns(top.segs)) for (const m of railsFor(run.pts, run.loop, brass)) scene.add(m);
  const hopper = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.12, 0.5, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0xd4ae5a, metalness: 0.85, roughness: 0.3, side: THREE.DoubleSide }));
  hopper.position.set(HOPPER.x, HOPPER.y - 0.45, HOPPER.z);
  scene.add(hopper);

  // The helix's column and the loop's supports.
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, HELIX.top - HELIX.bottom + 0.6, 20), steel);
  column.position.set(HELIX.cx, (HELIX.top + HELIX.bottom) / 2, HELIX.cz);
  column.castShadow = true;
  scene.add(column);

  // The program drum: a turning cylinder; its pegs are drawn per frame.
  const drum = new THREE.Group();
  drum.position.set(0, DRUM.y, DRUM.z);
  const drumBody = new THREE.Mesh(new THREE.CylinderGeometry(DRUM.r, DRUM.r, DRUM.x1 - DRUM.x0, 48), new THREE.MeshStandardMaterial({ color: 0x5a3d28, roughness: 0.55, metalness: 0.15 }));
  drumBody.rotation.z = Math.PI / 2;
  drum.add(drumBody);
  for (const x of [DRUM.x0, DRUM.x1, (DRUM.x0 + DRUM.x1) / 2]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(DRUM.r + 0.01, 0.03, 10, 48), brass);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = x;
    drum.add(ring);
  }
  scene.add(drum);
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, DRUM.x1 - DRUM.x0 + 0.8, 12), steel);
  axle.rotation.z = Math.PI / 2;
  axle.position.set(0, DRUM.y, DRUM.z);
  scene.add(axle);
  const pegs = new THREE.InstancedMesh(new RoundedBoxGeometry(0.12, 0.07, 0.07, 2, 0.02), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.2 }), PEG_POOL);
  pegs.frustumCulled = false;
  scene.add(pegs);
  // The release comb for straight drops, just in front of the drum.
  const comb = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, BARS.x1 - BARS.x0 + 0.3, 10), brass);
  comb.rotation.z = Math.PI / 2;
  comb.position.set(0, GATE_Y + 0.12, BARS.z);
  scene.add(comb);

  // Seesaws.
  const levers = SEESAWS.map((sw) => {
    const g = new THREE.Group();
    g.position.set(sw.pivot.x, sw.pivot.y, sw.pivot.z);
    const plank = new THREE.Mesh(new RoundedBoxGeometry(sw.half * 2 + 0.1, 0.06, 0.26, 2, 0.02), new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4, metalness: 0.3 }));
    plank.castShadow = true;
    g.add(plank);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 12), steel);
    pin.rotation.x = Math.PI / 2;
    pin.position.z = -0.6;
    scene.add(g);
    const stand = pin.clone();
    stand.position.set(sw.pivot.x, sw.pivot.y, sw.pivot.z - 0.6);
    scene.add(stand);
    return g;
  });

  // The vibraphone: bars over resonator tubes.
  const bars = s.channels.map((c, ch) => {
    const mat = new THREE.MeshPhysicalMaterial({ color: barColor(theme, s, ch), roughness: 0.3, metalness: 0.2, clearcoat: 0.7, emissive: barColor(theme, s, ch), emissiveIntensity: 0.05 });
    const bar = new THREE.Mesh(new RoundedBoxGeometry(c.w, BARS.h + (c.bass ? 0.04 : 0), c.d, 2, 0.03), mat);
    bar.position.set(c.x, BARS.top - BARS.h / 2, BARS.z);
    bar.castShadow = true;
    scene.add(bar);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(c.w * 0.3, c.w * 0.3, c.tube, 20), brass);
    tube.position.set(c.x, BARS.top - BARS.h - 0.05 - c.tube / 2, BARS.z);
    scene.add(tube);
    return { bar, mat };
  });
  const hits = s.channels.map((_, ch) => s.sched.drops.filter((d) => d.ch === ch).map((d) => d.t).sort((a, b) => a - b));

  // The paddle wheel.
  const wheel = new THREE.Group();
  wheel.position.set(WHEEL.c.x, WHEEL.c.y, WHEEL.c.z);
  wheel.add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.3, 20).rotateX(Math.PI / 2), steel));
  for (let k = 0; k < WHEEL.paddles; k++) {
    const paddle = new THREE.Mesh(new THREE.BoxGeometry(WHEEL.r, 0.04, 0.24), new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4, metalness: 0.3 }));
    const a = (k / WHEEL.paddles) * Math.PI * 2;
    paddle.position.set((Math.cos(a) * WHEEL.r) / 2, (Math.sin(a) * WHEEL.r) / 2, 0);
    paddle.rotation.z = a;
    wheel.add(paddle);
  }
  scene.add(wheel);

  // The bucket elevator: two rails and its buckets (drawn per frame).
  for (const dz of [-0.16, 0.16]) {
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, LIFT.y1 - LIFT.y0 + 0.4, 8), steel);
    rail.position.set(LIFT.x + 0.17, (LIFT.y0 + LIFT.y1) / 2, LIFT.z + dz);
    scene.add(rail);
  }
  const buckets = new THREE.InstancedMesh(new RoundedBoxGeometry(0.3, 0.06, 0.3, 2, 0.02), brass, BUCKET_POOL);
  buckets.frustumCulled = false;
  scene.add(buckets);

  // The bass hopper and the lever that opens it.
  const lever = new THREE.Group();
  lever.position.set(BASS_LEVER.pivot.x, BASS_LEVER.pivot.y, BASS_LEVER.pivot.z);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(BASS_LEVER.len, 0.07, 0.07), new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4, metalness: 0.4 }));
  arm.position.x = BASS_LEVER.len / 2;
  lever.add(arm);
  scene.add(lever);
  const bassBox = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.4, 0.4, 2, 0.04), brass);
  bassBox.position.set(BASS_LEVER.pivot.x + 0.05, BASS_LEVER.pivot.y + 0.42, BASS_LEVER.pivot.z);
  scene.add(bassBox);

  // Dominoes and the bell they ring.
  const run = s.sched.dominoes;
  const dominoes = new THREE.InstancedMesh(new RoundedBoxGeometry(DOMINO.t, DOMINO.h, DOMINO.w, 2, 0.01), new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.5 }), Math.max(1, run?.n ?? 1));
  dominoes.castShadow = true;
  dominoes.visible = !!run;
  scene.add(dominoes);
  const bellMat = new THREE.MeshStandardMaterial({ color: 0xe0b84c, metalness: 0.9, roughness: 0.2, emissive: accent, emissiveIntensity: 0 });
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.2, 0.3, 32, 1, true), bellMat);
  bell.material.side = THREE.DoubleSide;
  if (run) bell.position.set(run.bell.x, 0.15, run.bell.z);
  bell.visible = !!run;
  scene.add(bell);

  // Marbles: chrome, bass marbles brass-tinted.
  const marbles = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 28, 18), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.12 }), Math.max(1, s.sched.drops.length));
  marbles.castShadow = true;
  marbles.frustumCulled = false;
  s.sched.drops.forEach((d, k) => marbles.setColorAt(k, d.bass ? new THREE.Color(0xf0c060) : new THREE.Color(0xe8ecf4)));
  scene.add(marbles);

  return { scene, camera, drum, pegs, levers, bars, hits, wheel, buckets, lever, dominoes, bellMat, marbles };
});

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const tmp = new THREE.Matrix4();
const q = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const scale = new THREE.Vector3();
const pos = new THREE.Vector3();

/** Last hit at or before t in a sorted list (or -Infinity). */
function lastBefore(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? ts[lo - 1] : -Infinity;
}

export function drawMachine3D(ctx: Ctx2D, theme: Theme, s: State, t: number) {
  const v = view(s, theme);

  v.drum.rotation.x = DRUM_OMEGA * t;
  // Pegs on the drum's front for marbles about to be released (and just released).
  let np = 0;
  for (const d of s.sched.drops) {
    const phi = TRIGGER_PHI - DRUM_OMEGA * (d.release - t);
    if (phi < -Math.PI / 2 || phi > TRIGGER_PHI + 0.9 || np >= PEG_POOL) continue;
    const rr = DRUM.r + 0.03;
    q.setFromAxisAngle(X, phi);
    pos.set(d.pegX, DRUM.y - rr * Math.sin(phi), DRUM.z + rr * Math.cos(phi));
    v.pegs.setMatrixAt(np, tmp.compose(pos, q, scale.set(1, 1, 1)));
    v.pegs.setColorAt(np, v.bars[d.ch].mat.color);
    np++;
  }
  for (let k = np; k < PEG_POOL; k++) v.pegs.setMatrixAt(k, HIDDEN);
  v.pegs.instanceMatrix.needsUpdate = true;
  if (v.pegs.instanceColor) v.pegs.instanceColor.needsUpdate = true;

  SEESAWS.forEach((sw, k) => (v.levers[k].rotation.z = leverAngle(sw, s.sched.seesawLandings[k], t)));
  v.wheel.rotation.z = -wheelAngle(s.sched.wheelDrops, t);
  v.lever.rotation.z = -bassLeverAngle(s.bassEnterAt, t);

  // Bars flash and dip when struck.
  s.channels.forEach((c, ch) => {
    const since = t - lastBefore(v.hits[ch], t);
    const flash = Math.max(0, 1 - since / 0.35);
    const dip = since < 0.5 ? 0.025 * Math.sin(since * 40) * Math.exp(-since * 8) : 0;
    const { bar, mat } = v.bars[ch];
    mat.emissiveIntensity = 0.05 + 0.9 * flash;
    bar.position.y = BARS.top - BARS.h / 2 - Math.abs(dip);
  });

  // Elevator buckets.
  const kMax = Math.floor(t / BUCKET_DT);
  for (let j = 0; j < BUCKET_POOL; j++) {
    const k = kMax - j;
    const y = bucketY(k, t);
    if (y < LIFT.y0 || y > LIFT.y1) v.buckets.setMatrixAt(j, HIDDEN);
    else v.buckets.setMatrixAt(j, tmp.makeTranslation(LIFT.x, y - 0.03, LIFT.z));
  }
  v.buckets.instanceMatrix.needsUpdate = true;

  const run = s.sched.dominoes;
  if (run) {
    for (let k = 0; k < run.n; k++) {
      const x = run.x0 + run.dir * k * DOMINO.spacing;
      const tilt = dominoTilt(run, k, t);
      // Tip over the far bottom edge.
      const px = x + (run.dir * DOMINO.t) / 2;
      q.setFromAxisAngle(Z, -run.dir * tilt);
      const off = new THREE.Vector3(-(run.dir * DOMINO.t) / 2, DOMINO.h / 2, 0).applyQuaternion(q);
      pos.set(px + off.x, off.y, DOMINO.z + off.z);
      v.dominoes.setMatrixAt(k, tmp.compose(pos, q, scale.set(1, 1, 1)));
    }
    v.dominoes.instanceMatrix.needsUpdate = true;
    v.bellMat.emissiveIntensity = t >= s.revealAt ? 1.2 * Math.exp(-(t - s.revealAt) * 1.5) : 0;
  }

  // Marbles.
  s.sched.drops.forEach((d, k) => {
    if (t < d.release || t >= d.goneAt) {
      v.marbles.setMatrixAt(k, HIDDEN);
      return;
    }
    const p = d.path.at(t);
    v.marbles.setMatrixAt(k, tmp.makeScale(d.r, d.r, d.r).setPosition(p.x, p.y, p.z));
  });
  v.marbles.instanceMatrix.needsUpdate = true;

  const pose = cameraAt(s.shots, run, t);
  v.camera.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
  v.camera.lookAt(pose.look.x, pose.look.y, pose.look.z);
  draw3D(ctx, v.scene, v.camera);
}

