/**
 * 3D view: a low-poly colosseum and the fighters, posed from sim state (live, or a replay snapshot).
 * Rendering only: reads state, never changes it. Sim (x, y) on the arena floor maps to three.js (x, z).
 *
 * Every fighter is modelled and animated in code (proc/): its pose is a pure function of its sim state,
 * so any frame (a replay, a restarted preview) poses exactly. The VS card shows each fighter alone on a
 * pedestal far from the arena, through its own camera, inside its half of the card.
 */
import { hexToRgb, lighten, rgbToCss, type Ctx2D, type Theme } from '@sim/engine';
import { THREE, canvasTexture, draw3D, sceneCache } from '../three-layer';
import type { CreatureDef } from './roster';
import { ARENA_R, GATES } from './sim';
import { VS_STRIPS, vsSlide } from './vs';
import { ProcRig, restPose } from './proc/rig';
import { SPECIES } from './proc/species';
import { PROC_POSES } from './proc/poses';
import { REPLAY_S, fightersNow, replaying, type FighterView, type State } from './index';

const VFOV = 32;
const ASPECT = 1080 / 1920;
/** Camera elevation over the arena (radians). */
const ELEVATION = 0.46;
const WALL_H = 1.7;
/** Where the VS card's pedestals stand (well away from the arena, which is behind their cameras). */
const PEDESTALS = [new THREE.Vector3(-14, 0, 110), new THREE.Vector3(14, 0, 110)];
const FLAME_N = 70;
const SUN = 1.9;
const BURST_N = 12;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const wrapAngle = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
const fract = (x: number) => x - Math.floor(x);
const hash = (i: number) => fract(Math.sin(i * 12.9898 + 78.233) * 43758.5453);

interface Inst {
  rig: ProcRig;
  group: THREE.Group;
  mats: THREE.MeshStandardMaterial[];
  head: THREE.Object3D;
  def: CreatureDef;
  /** Nose to rump (metres; the tail doesn't count for framing). */
  length: number;
}

function makeInst(def: CreatureDef): Inst {
  const rig = new ProcRig(SPECIES[def.proc.kind]);
  const length = (def.front ?? def.radius) + (def.back ?? def.radius);
  return { rig, group: rig.root, mats: [rig.material, ...(rig.wingMaterial ? [rig.wingMaterial] : [])], head: rig.head, def, length };
}

function pose(inst: Inst, f: FighterView, simT: number, horde: boolean, all: FighterView[]) {
  const d = f.def;
  let y = d.hover ? d.hover + Math.sin(simT * 3.1 + f.idx) * 0.12 : 0;
  // Fallen dragons drop out of the air; in a horde the fallen sink away after a while.
  if (!f.alive && d.hover) y *= 1 - clamp01((simT - f.diedAt) / 0.6);
  if (!f.alive && horde && f.side === 1) y -= clamp01((simT - f.diedAt - 2.2) / 1.2) * d.height * 1.2;
  inst.group.position.set(f.x, y, f.y);
  inst.group.rotation.set(0, Math.atan2(Math.cos(f.heading), Math.sin(f.heading)), 0);
  inst.group.visible = f.alive || !horde || simT - f.diedAt < 3.6;
  inst.rig.pose(PROC_POSES[d.proc.kind](f, simT, all));
  const fl = f.flash * 0.22;
  for (const m of inst.mats) m.emissive.setRGB(fl + f.burn * 0.45, fl * 0.5 + f.burn * 0.12, fl * 0.4);
}

/** Sandy floor with raked rings and scuffs. */
function sandTexture() {
  return canvasTexture(1024, 1024, (c) => {
    c.fillStyle = '#a8865a';
    c.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 9000; i++) {
      const x = hash(i) * 1024;
      const y = hash(i + 0.5) * 1024;
      c.fillStyle = `rgba(${hash(i + 1) > 0.5 ? '255,240,210' : '120,90,50'},${(0.05 + hash(i + 2) * 0.1).toFixed(3)})`;
      c.fillRect(x, y, 2 + hash(i + 3) * 4, 2 + hash(i + 4) * 4);
    }
    c.strokeStyle = 'rgba(110,80,40,0.12)';
    c.lineWidth = 6;
    for (let r = 60; r < 512; r += 46) {
      c.beginPath();
      c.arc(512, 512, r, 0, Math.PI * 2);
      c.stroke();
    }
  });
}

/** Rows of spectators: coloured dots on dark stone. */
function crowdTexture() {
  return canvasTexture(2048, 256, (c) => {
    c.fillStyle = '#3a3330';
    c.fillRect(0, 0, 2048, 256);
    const cols = ['#c94f4f', '#e0b65a', '#4f7fc9', '#e8e2d6', '#6aa86a', '#a86ac0', '#d98a4a'];
    for (let row = 0; row < 8; row++)
      for (let i = 0; i < 120; i++) {
        if (hash(row * 131 + i) < 0.18) continue;
        const x = i * 17 + (row % 2) * 8 + hash(i + row) * 4;
        const y = 20 + row * 30;
        c.fillStyle = cols[Math.floor(hash(i * 7 + row) * cols.length)];
        c.beginPath();
        c.arc(x, y, 6, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#e9c9a8';
        c.beginPath();
        c.arc(x, y - 9, 4, 0, Math.PI * 2);
        c.fill();
      }
  });
}

function glowTexture() {
  return canvasTexture(128, 128, (c) => {
    const g = c.createRadialGradient(64, 64, 2, 64, 64, 62);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
  });
}

function starTexture() {
  return canvasTexture(128, 128, (c) => {
    c.translate(64, 64);
    c.fillStyle = '#ffffff';
    c.beginPath();
    for (let k = 0; k < 16; k++) {
      const r = k % 2 === 0 ? 60 : 18;
      const a = (k / 16) * Math.PI * 2;
      c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    c.closePath();
    c.fill();
  });
}

function buildArena(scene: THREE.Scene) {
  const floor = new THREE.Mesh(new THREE.CircleGeometry(ARENA_R + 0.7, 64), new THREE.MeshStandardMaterial({ map: sandTexture(), roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const stone = new THREE.MeshStandardMaterial({ color: 0x9a8a78, roughness: 0.95, flatShading: true });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(ARENA_R + 0.7, ARENA_R + 0.7, WALL_H, 40, 1, true), stone);
  (wall.material as THREE.MeshStandardMaterial).side = THREE.BackSide;
  wall.position.y = WALL_H / 2;
  wall.receiveShadow = true;
  scene.add(wall);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(ARENA_R + 0.85, 0.22, 4, 40), new THREE.MeshStandardMaterial({ color: 0xb8a58c, roughness: 0.9, flatShading: true }));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = WALL_H;
  scene.add(rim);
  // Gates (where a horde comes in), dark arches in the wall.
  const gateMat = new THREE.MeshStandardMaterial({ color: 0x1c1612, roughness: 1 });
  for (const a of [...GATES, Math.PI / 2]) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.45), gateMat);
    g.position.set(Math.cos(a) * (ARENA_R + 0.66), 0.72, Math.sin(a) * (ARENA_R + 0.66));
    g.lookAt(0, 0.72, 0);
    scene.add(g);
  }
  // Stands rising behind the wall.
  const crowd = crowdTexture();
  crowd.wrapS = THREE.RepeatWrapping;
  crowd.repeat.set(4, 1);
  for (let k = 0; k < 5; k++) {
    const r = ARENA_R + 1.6 + k * 1.6;
    // Both sides: from far out the camera sees the near stands' backs (the crowd faces in either way).
    const tier = new THREE.Mesh(new THREE.CylinderGeometry(r + 1.2, r, 1.3, 48, 1, true), new THREE.MeshStandardMaterial({ map: crowd, roughness: 1, side: THREE.DoubleSide }));
    tier.position.y = WALL_H + 0.65 + k * 1.3;
    scene.add(tier);
  }
  // The ground around it all, so a wide shot never shows the void past the stands.
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 32), new THREE.MeshStandardMaterial({ color: 0x4a3f36, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);
  // Torches on the wall.
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
  const torches: THREE.Mesh[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + 0.2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.6, 6), new THREE.MeshStandardMaterial({ color: 0x3b2a1e }));
    const px = Math.cos(a) * (ARENA_R + 0.6);
    const pz = Math.sin(a) * (ARENA_R + 0.6);
    post.position.set(px, WALL_H + 0.3, pz);
    scene.add(post);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.35, 6), flameMat);
    flame.position.set(px, WALL_H + 0.75, pz);
    scene.add(flame);
    torches.push(flame);
  }
  return torches;
}

function build(s: State, theme: Theme) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(new THREE.Color(theme.bg[1]), 45, 120);
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x5a4a3a, 1.05));
  const sun = new THREE.DirectionalLight(0xfff1d6, SUN);
  sun.position.set(-8, 18, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -ARENA_R - 2;
  sc.right = ARENA_R + 2;
  sc.top = ARENA_R + 2;
  sc.bottom = -ARENA_R - 2;
  sc.near = 1;
  sc.far = 60;
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);
  // Front light for the VS card (its cameras look away from the sun); off in the arena.
  const vsLight = new THREE.DirectionalLight(0xffffff, 0);
  vsLight.position.set(6, 14, -40);
  vsLight.target.position.set(0, 0, 110);
  scene.add(vsLight);
  scene.add(vsLight.target);
  const torches = buildArena(scene);

  // Pedestals for the VS card.
  const pedestal = new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.6, metalness: 0.2 });
  for (const p of PEDESTALS) {
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.4, 0.3, 32), pedestal);
    ped.position.set(p.x, -0.15, p.z);
    scene.add(ped);
  }
  const showcase = [s.a, s.b].map((def, k) => {
    const inst = makeInst(def);
    inst.group.position.copy(PEDESTALS[k]);
    scene.add(inst.group);
    return inst;
  });

  const camera = new THREE.PerspectiveCamera(VFOV, ASPECT, 0.1, 300);
  const vsCam = new THREE.PerspectiveCamera(VFOV, ASPECT, 0.1, 300);

  // Fire breath and hit flashes: pooled sprites.
  const glow = glowTexture();
  const flames = Array.from({ length: FLAME_N }, () => {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffa040, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.visible = false;
    scene.add(m);
    return m;
  });
  const star = starTexture();
  const bursts = Array.from({ length: BURST_N }, () => {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: star, color: 0xffffff, transparent: true, depthWrite: false, depthTest: false }));
    m.visible = false;
    scene.add(m);
    return m;
  });
  return { scene, camera, vsCam, sun, vsLight, torches, showcase, fighters: new Map<number, Inst>(), flames, bursts };
}

const view = sceneCache(build);
let lastCamera: THREE.PerspectiveCamera | null = null;

/** Where a point of the arena (height h) lands on screen in the last frame drawn (null if behind). */
export function projectToScreen(_s: State, x: number, y: number, h: number): { x: number; y: number } | null {
  if (!lastCamera) return null;
  const v = new THREE.Vector3(x, h, y).project(lastCamera);
  if (v.z > 1) return null;
  return { x: (v.x * 0.5 + 0.5) * 1080, y: (-v.y * 0.5 + 0.5) * 1920 };
}

function aimArena(camera: THREE.PerspectiveCamera, s: State) {
  const hf = 2 * Math.atan(Math.tan(((VFOV / 2) * Math.PI) / 180) * ASPECT);
  const d = (s.cam.span / 2 / Math.tan(hf / 2)) * 1.05;
  const look = new THREE.Vector3(s.cam.x, 0.7, s.cam.y);
  camera.position.set(look.x, look.y + Math.sin(ELEVATION) * d, look.z + Math.cos(ELEVATION) * d);
  camera.lookAt(look);
}

function aimReplay(camera: THREE.PerspectiveCamera, s: State, fighters: FighterView[]) {
  const u = clamp01((s.t - s.replayAt!) / REPLAY_S);
  // The two at the heart of it: the one that fell and the one that felled it.
  const who = fighters.find((f) => f.idx === s.koWho) ?? fighters[0];
  const by = fighters.find((f) => f.idx === s.koBy) ?? who;
  const mx = (who.x + by.x) / 2;
  const my = (who.y + by.y) / 2;
  const tall = Math.max(who.def.height + (who.def.hover ?? 0), by.def.height + (by.def.hover ?? 0));
  // Low, looking nearly along the line between them (a narrow portrait frame fits two along its
  // depth), slowly circling; always inside the arena (the stands would block the view from outside).
  // Of the four ways round, the one with the most room.
  const along = Math.atan2(who.y - by.y, who.x - by.x);
  const gap = Math.hypot(who.x - by.x, who.y - by.y);
  const want = Math.max(7, gap * 1.6 + tall * 2.8);
  const room = (yaw: number) => {
    let k = want;
    while (k > 3 && Math.hypot(mx + Math.cos(yaw) * k, my + Math.sin(yaw) * k) > ARENA_R - 0.4) k -= 0.25;
    return k;
  };
  const base = [along + 0.55, along - 0.55, along + Math.PI + 0.55, along + Math.PI - 0.55].reduce((a, b) => (room(b) > room(a) + 0.01 ? b : a));
  const yaw = base + 0.3 * (u - 0.5) * Math.sign(wrapAngle(base - along));
  const d = room(yaw);
  const cx = (k: number) => mx + Math.cos(yaw) * k;
  const cz = (k: number) => my + Math.sin(yaw) * k;
  camera.position.set(cx(d), tall * 0.45 + d * 0.12, cz(d));
  camera.lookAt(mx, tall * 0.45, my);
}

/** Flames out of the breather's mouth along its cone (deterministic from sim time). */
function drawBreath(v: ReturnType<typeof view>, insts: Map<number, Inst>, fighters: FighterView[], simT: number) {
  let used = 0;
  for (const f of fighters) {
    if (!f.alive || f.state !== 'attack') continue;
    const m = f.def.moves[f.moveIdx];
    if (!m?.breath) continue;
    const el = simT - f.stateT;
    const from = m.hits[0].at * m.len;
    const to = m.breath.until * m.len + 0.25;
    if (el < from || el > to) continue;
    const inst = insts.get(f.idx);
    const mouth = new THREE.Vector3();
    if (inst) inst.head.getWorldPosition(mouth);
    else mouth.set(f.x, f.def.height * 0.7, f.y);
    const dirX = Math.cos(f.heading);
    const dirZ = Math.sin(f.heading);
    const ending = clamp01((to - el) / 0.25);
    for (let i = 0; i < FLAME_N && used < FLAME_N; i++) {
      const sp = v.flames[used++];
      const u = fract(hash(i) + (el - from) * 2.4);
      const dist = 0.3 + u * m.reach;
      const side = (hash(i + 9) - 0.5) * 2 * Math.tan(m.arc) * dist * 0.8;
      const lift = (hash(i + 3) - 0.5) * 0.6 * u - u * 0.4;
      sp.position.set(mouth.x + dirX * dist - dirZ * side, Math.max(0.15, mouth.y + lift), mouth.z + dirZ * dist + dirX * side);
      const size = 0.35 + u * 1.3;
      sp.scale.set(size, size, 1);
      const mat = sp.material as THREE.SpriteMaterial;
      mat.color.setRGB(1, 0.62 - 0.42 * u, 0.18 - 0.16 * u);
      mat.opacity = (1 - u) * 0.6 * ending * clamp01((el - from) / 0.1 + u * 0.5);
      sp.visible = true;
    }
  }
  for (let i = used; i < FLAME_N; i++) v.flames[i].visible = false;
}

/** A star burst where each recent blow landed. */
function drawBursts(v: ReturnType<typeof view>, s: State, simT: number) {
  let used = 0;
  for (let i = s.hits.length - 1; i >= 0 && used < BURST_N; i--) {
    const h = s.hits[i];
    const age = simT - h.simT;
    if (age < 0) continue;
    if (age > 0.3) break;
    const sp = v.bursts[used++];
    const k = age / 0.3;
    const size = (0.6 + Math.min(1.6, h.power) * 0.5) * (h.crit ? 1.5 : 1) * (0.5 + k);
    sp.position.set(h.x, h.h, h.y);
    sp.scale.set(size, size, 1);
    const mat = sp.material as THREE.SpriteMaterial;
    mat.opacity = 1 - k;
    mat.color.set(h.crit ? 0xffd23b : 0xffffff);
    mat.rotation = h.simT * 7;
    sp.visible = true;
  }
  for (let i = used; i < BURST_N; i++) v.bursts[i].visible = false;
}

/** The two halves of the VS card: a coloured strip each, with its fighter on a pedestal. */
function drawVsCard(ctx: Ctx2D, s: State, v: ReturnType<typeof view>) {
  const sl = vsSlide(s.phase, s.t - s.phaseAt);
  if (!sl.showing) return;
  v.vsLight.intensity = 2.2;
  v.sun.intensity = 0;
  for (let k = 0; k < 2; k++) {
    const st = VS_STRIPS[k];
    const o = sl.o[k];
    const col = hexToRgb(st.color);
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.beginPath();
    ctx.moveTo(-40, st.topL + 3);
    ctx.lineTo(1120, st.topR + 3);
    ctx.lineTo(1120, st.bottomR - 3);
    ctx.lineTo(-40, st.bottomL - 3);
    ctx.closePath();
    ctx.fillStyle = '#0b0b14';
    ctx.fill();
    ctx.clip();
    const g = ctx.createRadialGradient(st.model.x, st.model.y, 40, st.model.x, st.model.y, 760);
    g.addColorStop(0, rgbToCss(col, 0.8));
    g.addColorStop(0.55, rgbToCss(col, 0.3));
    g.addColorStop(1, rgbToCss(col, 0.06));
    ctx.fillStyle = g;
    ctx.fillRect(-40, -40, 1160, 2000);
    ctx.strokeStyle = rgbToCss(lighten(col, 0.6), 0.08);
    ctx.lineWidth = 26;
    const drift = ((s.t * 900) % 240) * (k === 0 ? 1 : -1);
    for (let i = -6; i < 12; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 240 + drift, 2000);
      ctx.lineTo(i * 240 + drift + 700, -40);
      ctx.stroke();
    }
    // The fighter, framed so it stands st.model.h pixels tall at st.model (x, y).
    const inst = v.showcase[k];
    const def = inst.def;
    const p = PEDESTALS[k];
    const idleT = s.t;
    // Standing on the pedestal; the dragon hovers with its wings beating.
    inst.rig.pose({ ...restPose(), time: idleT + k * 0.7, wingFlap: 0.6 + 0.6 * Math.sin(idleT * 6.5), wingFold: 0.25, legs: def.hover ? Object.fromEntries(SPECIES[def.proc.kind].legs.map((l) => [l.name, 'relax' as const])) : {}, gaitScale: def.hover ? 0 : 1 });
    // Face the camera, three-quarters on, the two looking towards each other.
    inst.group.rotation.y = Math.PI + (k === 0 ? 0.6 : -0.6);
    const tall = def.height + (def.hover ?? 0);
    inst.group.position.set(p.x, def.hover ? def.hover + Math.sin(s.t * 3) * 0.1 : 0, p.z);
    const size = Math.max(tall, inst.length * 0.85);
    const visH = (size / st.model.h) * 1920;
    const d = visH / 2 / Math.tan(((VFOV / 2) * Math.PI) / 180);
    const look = new THREE.Vector3(p.x, tall * 0.5, p.z);
    // Looking away from the arena, so nothing but the fighter is behind it.
    v.vsCam.position.set(look.x, look.y + d * 0.2, look.z - d);
    v.vsCam.lookAt(look);
    ctx.translate(st.model.x - 540, st.model.y - 960);
    draw3D(ctx, v.scene, v.vsCam);
    ctx.restore();
  }
  v.vsLight.intensity = 0;
  v.sun.intensity = SUN;
}


export function drawScene(ctx: Ctx2D, s: State, theme: Theme) {
  const v = view(s, theme);
  const { fighters, simT } = fightersNow(s);
  const horde = s.mode === 'horde';
  for (const f of fighters) {
    let inst = v.fighters.get(f.idx);
    if (!inst) {
      inst = makeInst(f.def);
      v.scene.add(inst.group);
      v.fighters.set(f.idx, inst);
    }
    pose(inst, f, simT, horde, fighters);
  }
  // Fighters not in this snapshot (a replay from before they came in) stay hidden.
  for (const [idx, inst] of v.fighters) if (!fighters.some((f) => f.idx === idx)) inst.group.visible = false;
  for (const [k, fl] of v.torches.entries()) fl.scale.y = 0.8 + 0.3 * Math.abs(Math.sin(s.t * 9 + k * 1.7));
  drawBreath(v, v.fighters, fighters, simT);
  drawBursts(v, s, simT);
  if (s.phase !== 'vs') {
    if (replaying(s)) aimReplay(v.camera, s, fighters);
    else aimArena(v.camera, s);
    lastCamera = v.camera;
    draw3D(ctx, v.scene, v.camera);
  }
  if (s.phase === 'vs' || s.phase === 'count') drawVsCard(ctx, s, v);
}
