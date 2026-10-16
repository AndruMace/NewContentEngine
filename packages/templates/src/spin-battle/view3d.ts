/**
 * 3D view of the stadium and tops. Rendering only: reads sim state, never changes it.
 * Sim coordinates (x, y) on the stadium floor map to three.js (x, height, y).
 */
import { FONT_FAMILY, hexToRgb, lighten, mixRgb, paletteAt, rgbToCss, type Ctx2D, type Theme } from '@sim/engine';
import { THREE, canvasTexture, draw3D, environmentMap, sceneCache } from '../three-layer';
import { clamp01 } from '../scoring';
import type { Team } from '../fx';
import { HEAVY_HIT, POCKET_HALF, RIM, type Top } from './physics';
import type { State, VsSlide } from './index';
import { BEAT_S, DROP_S, vsLayout } from './intro';

/** Visual bowl depth: floor height = BOWL_H * r². */
const BOWL_H = 0.16;
const WALL_H = 0.11;
const WALL_T = 0.07;
/** Spark streaks available per frame (heavy hits use up to ~40 each). */
const SPARK_POOL = 240;
/** Where the camera sits relative to what it looks at (zoom moves it closer). */
const CAM_OFFSET = new THREE.Vector3(0, 4.35, 3.85);
/** Look slightly past the centre so the stadium sits low in the frame, under the HUD. */
const CAM_LOOK_Z = -0.3;

const floorY = (x: number, y: number) => BOWL_H * Math.min(1, x * x + y * y);

/** The contour ring, extruded straight from the top's collision polygon (what you see is what hits). */
function contourGeometry(top: Top) {
  const shape = new THREE.Shape();
  const { x, y } = top.poly;
  for (let k = 0; k <= x.length; k++) {
    const i = k % x.length;
    // Shape y is mirrored so that after rotateX(-90°) the outline lands at (x, y) in x/z.
    if (k === 0) shape.moveTo(x[i], -y[i]);
    else shape.lineTo(x[i], -y[i]);
  }
  const type = top.type;
  const depth = type === 'stamina' ? 0.018 : type === 'defense' ? 0.04 : 0.03;
  // A small bevel only, so the visible edge stays on the collision outline.
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.002, bevelSegments: 1, curveSegments: 4 });
  geo.rotateX(-Math.PI / 2);
  return { geo, depth };
}

function faceTexture(team: Team, theme: Theme) {
  return canvasTexture(256, 256, (c) => {
    const col = hexToRgb(team.color);
    const g = c.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, rgbToCss(lighten(col, 0.35)));
    g.addColorStop(1, rgbToCss(mixRgb(col, [0, 0, 0], 0.25)));
    c.fillStyle = g;
    c.fillRect(0, 0, 256, 256);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    if (team.icon) {
      // A dark medallion behind the emblem so it reads on any colour.
      c.fillStyle = rgbToCss(mixRgb(col, [0, 0, 0], 0.65));
      c.beginPath();
      c.arc(128, 128, 88, 0, Math.PI * 2);
      c.fill();
      c.font = `130px ${FONT_FAMILY}`;
      c.fillText(team.icon, 128, 138);
    } else {
      // Colour tops: a bold swirl so the spin reads.
      c.strokeStyle = rgbToCss(lighten(col, 0.85));
      c.lineWidth = 22;
      c.lineCap = 'round';
      for (let k = 0; k < 3; k++) {
        c.beginPath();
        c.arc(128, 128, 70, (k * Math.PI * 2) / 3, (k * Math.PI * 2) / 3 + 1.2);
        c.stroke();
      }
    }
    c.strokeStyle = theme.accent;
    c.lineWidth = 10;
    c.beginPath();
    c.arc(128, 128, 120, 0, Math.PI * 2);
    c.stroke();
  });
}

function blurTexture(team: Team) {
  return canvasTexture(256, 256, (c) => {
    const col = lighten(hexToRgb(team.color), 0.3);
    const g = c.createRadialGradient(128, 128, 40, 128, 128, 128);
    // A ring around the rim only, so the emblem on the face stays readable.
    g.addColorStop(0, rgbToCss(col, 0));
    g.addColorStop(0.62, rgbToCss(col, 0));
    g.addColorStop(0.85, rgbToCss(col, 0.5));
    g.addColorStop(0.97, rgbToCss([255, 255, 255], 0.35));
    g.addColorStop(1, rgbToCss(col, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, 256, 256);
  });
}

function buildTop(top: Top, theme: Theme) {
  const r = top.stats.radius;
  const group = new THREE.Group();
  const spinner = new THREE.Group();
  group.add(spinner);
  const tint = new THREE.Color(rgbToCss(mixRgb([200, 205, 215], hexToRgb(top.team.color), 0.62)));
  const metal = new THREE.MeshStandardMaterial({ color: tint, metalness: 0.75, roughness: 0.32, emissive: new THREE.Color(top.team.color), emissiveIntensity: 0 });
  // Driver: the tip it spins on (sharp for stamina, flat for attack).
  const tipR = top.type === 'attack' ? 0.03 : top.type === 'stamina' ? 0.004 : 0.016;
  const driver = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.32, tipR, 0.06, 24), new THREE.MeshStandardMaterial({ color: 0x222228, metalness: 0.4, roughness: 0.5 }));
  driver.position.y = 0.03;
  driver.castShadow = true;
  spinner.add(driver);
  const { geo, depth } = contourGeometry(top);
  const contour = new THREE.Mesh(geo, metal);
  contour.position.y = 0.06;
  // Left-spin tops have mirrored blades (hooks facing the other way).
  contour.scale.x = top.dir;
  contour.castShadow = true;
  spinner.add(contour);
  const faceY = 0.06 + depth + 0.008;
  const face = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.58, r * 0.62, 0.014, 48), [
    new THREE.MeshStandardMaterial({ color: top.team.color, metalness: 0.3, roughness: 0.5 }),
    new THREE.MeshStandardMaterial({ map: faceTexture(top.team, theme), metalness: 0.1, roughness: 0.45 }),
    new THREE.MeshStandardMaterial({ color: top.team.color }),
  ]);
  face.position.y = faceY + 0.007;
  face.castShadow = true;
  spinner.add(face);
  // Motion-blur ring: stays still while the top spins under it, fading with RPM.
  const blur = new THREE.Mesh(new THREE.CircleGeometry(r * 1.06, 48), new THREE.MeshBasicMaterial({ map: blurTexture(top.team), transparent: true, depthWrite: false, opacity: 0.5 }));
  blur.rotation.x = -Math.PI / 2;
  blur.position.y = faceY + 0.02;
  group.add(blur);
  return { group, spinner, metal, blur };
}

/** Launchers hold the tops this high over their launch spots during the countdown. */
const LAUNCH_H = 0.46;
/** Gap between the launcher and the top hanging from it. */
const HANG = 0.115;
const SHOWCASE_Y = 10;

/** A launcher: body, pistol grip, the socket the top hangs from, and a toothed ripcord. */
function buildLauncher(top: Top) {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d36, metalness: 0.55, roughness: 0.4 });
  const team = new THREE.MeshStandardMaterial({ color: top.team.color, metalness: 0.3, roughness: 0.45, emissive: new THREE.Color(top.team.color), emissiveIntensity: 0.25 });
  const side = top.dir;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.075, 0.17), dark);
  body.castShadow = true;
  group.add(body);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.346, 0.022, 0.176), team);
  stripe.position.y = 0.022;
  group.add(stripe);
  const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.05, 24), dark);
  socket.position.y = -0.06;
  group.add(socket);
  // Grip on the opposite side to the ripcord, angled back like a pistol grip.
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.07), dark);
  grip.position.set(-side * 0.13, 0.12, 0);
  grip.rotation.z = side * 0.25;
  grip.castShadow = true;
  group.add(grip);
  const cord = new THREE.Group();
  const teeth = canvasTexture(256, 32, (c) => {
    c.fillStyle = top.team.color;
    c.fillRect(0, 0, 256, 32);
    c.fillStyle = 'rgba(0,0,0,0.45)';
    for (let x = 0; x < 256; x += 16) c.fillRect(x, 0, 7, 32);
  });
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.012, 0.04), new THREE.MeshStandardMaterial({ map: teeth, metalness: 0.2, roughness: 0.5 }));
  strip.position.x = side * 0.2;
  cord.add(strip);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.15), team);
  handle.position.x = side * 0.46;
  cord.add(handle);
  group.add(cord);
  group.visible = false;
  return { group, cord, side };
}

const view = sceneCache((s: State, theme: Theme) => {
  const scene = new THREE.Scene();
  scene.environment = environmentMap();
  scene.environmentIntensity = 0.35;
  const camera = new THREE.PerspectiveCamera(40, 1080 / 1920, 0.05, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x202030, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(1.2, 3.4, 1.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -1.4, right: 1.4, top: 1.4, bottom: -1.4, near: 0.5, far: 8 });
  sun.shadow.bias = -0.0015;
  scene.add(sun);

  // Bowl: a lathe of the floor profile, out to the rim.
  const pts: THREE.Vector2[] = [];
  const N = 60;
  for (let j = 0; j <= N; j++) {
    const r = (RIM * j) / N;
    pts.push(new THREE.Vector2(r, BOWL_H * r * r));
  }
  const pal = theme.palette;
  const tex = canvasTexture(1024, 1024, (c) => {
    // Lathe UVs: u runs around, v runs from the centre (0) to the rim (1).
    const deep = paletteAt(pal, 0.2);
    const edge = paletteAt(pal, 0.7);
    const g = c.createLinearGradient(0, 0, 0, 1024);
    g.addColorStop(0, rgbToCss(deep.map((x) => x * 0.25) as [number, number, number]));
    g.addColorStop(1, rgbToCss(edge.map((x) => x * 0.5) as [number, number, number]));
    c.fillStyle = g;
    c.fillRect(0, 0, 1024, 1024);
    c.strokeStyle = 'rgba(255,255,255,0.14)';
    c.lineWidth = 3;
    for (let k = 0; k < 24; k++) {
      c.beginPath();
      c.moveTo((k / 24) * 1024, 120);
      c.lineTo((k / 24) * 1024, 1024);
      c.stroke();
    }
    for (const v of [0.12, 0.35, 0.6, 0.85, 0.97]) {
      c.strokeStyle = v === 0.97 ? theme.accent : 'rgba(255,255,255,0.22)';
      c.lineWidth = v === 0.97 ? 10 : 5;
      c.beginPath();
      c.moveTo(0, v * 1024);
      c.lineTo(1024, v * 1024);
      c.stroke();
    }
  });
  // Everything that makes up the stadium, so the VS card can hide it.
  const stadium = new THREE.Group();
  scene.add(stadium);
  const bowl = new THREE.Mesh(new THREE.LatheGeometry(pts, 128), new THREE.MeshStandardMaterial({ map: tex, metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide }));
  bowl.receiveShadow = true;
  stadium.add(bowl);

  // Outer deck and the wall, broken by the pockets.
  const rimY = BOWL_H;
  const deck = new THREE.Mesh(new THREE.RingGeometry(RIM, 1.45, 96), new THREE.MeshStandardMaterial({ color: 0x15151c, metalness: 0.4, roughness: 0.6, side: THREE.DoubleSide }));
  deck.rotation.x = -Math.PI / 2;
  deck.position.y = rimY - 0.002;
  deck.receiveShadow = true;
  stadium.add(deck);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x9aa0ad, metalness: 0.75, roughness: 0.3, emissive: new THREE.Color(theme.accent), emissiveIntensity: 0.06 });
  const gaps = [...s.arena.pockets].sort((a, b) => a - b);
  const sectors: [number, number][] = [];
  if (!gaps.length) sectors.push([0, Math.PI * 2]);
  else
    gaps.forEach((g, i) => {
      const next = i + 1 < gaps.length ? gaps[i + 1] : gaps[0] + Math.PI * 2;
      sectors.push([g + POCKET_HALF + 0.02, next - POCKET_HALF - 0.02]);
    });
  for (const [a0, a1] of sectors) {
    const shape = new THREE.Shape();
    const M = Math.max(8, Math.ceil((a1 - a0) * 30));
    for (let k = 0; k <= M; k++) {
      const a = a0 + ((a1 - a0) * k) / M;
      const px = Math.cos(a) * RIM;
      const py = -Math.sin(a) * RIM;
      if (k === 0) shape.moveTo(px, py);
      else shape.lineTo(px, py);
    }
    for (let k = M; k >= 0; k--) {
      const a = a0 + ((a1 - a0) * k) / M;
      shape.lineTo(Math.cos(a) * (RIM + WALL_T), -Math.sin(a) * (RIM + WALL_T));
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: WALL_H, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const wall = new THREE.Mesh(geo, wallMat);
    wall.position.y = rimY;
    wall.castShadow = true;
    stadium.add(wall);
  }
  // Pockets: dark trays just outside the gaps, with a warning stripe.
  for (const g of gaps) {
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 2 * POCKET_HALF * RIM + 0.06), new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 1 }));
    tray.position.set(Math.cos(g) * (RIM + 0.11), rimY - 0.025, Math.sin(g) * (RIM + 0.11));
    tray.rotation.y = -g;
    stadium.add(tray);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.012, 2 * POCKET_HALF * RIM + 0.06), new THREE.MeshBasicMaterial({ color: 0xff4757 }));
    stripe.position.set(Math.cos(g) * (RIM + 0.012), rimY + 0.006, Math.sin(g) * (RIM + 0.012));
    stripe.rotation.y = -g;
    stadium.add(stripe);
  }

  const tops = s.tops.map((t) => {
    const v = buildTop(t, theme);
    scene.add(v.group);
    return v;
  });
  const accent = new THREE.Color(theme.accent);
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }));
  halo.rotation.x = -Math.PI / 2;
  halo.visible = false;
  scene.add(halo);
  // Sparks are short streaks (unit boxes stretched along their direction of travel).
  const sparkGeo = new THREE.BoxGeometry(1, 1, 1);
  const sparkMats = [0xffffff, 0xfff1c0, 0xffb347].map((color) => new THREE.MeshBasicMaterial({ color }));
  const sparks = Array.from({ length: SPARK_POOL }, (_, i) => {
    const m = new THREE.Mesh(sparkGeo, sparkMats[i % sparkMats.length]);
    m.visible = false;
    scene.add(m);
    return m;
  });
  // Heavy hits: a white-hot flash at the contact point that lights up the tops and floor.
  const impact = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  impact.visible = false;
  scene.add(impact);
  const flash = new THREE.PointLight(0xffd59a, 0, 1.8, 2);
  scene.add(flash);
  const launchers = s.tops.map((t) => {
    const l = buildLauncher(t);
    scene.add(l.group);
    return l;
  });
  // Landing shockwaves, one per top.
  const shocks = s.tops.map((t) => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 64),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(rgbToCss(lighten(hexToRgb(t.team.color), 0.35))), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    scene.add(m);
    return m;
  });
  // The VS card's camera: far above the stadium (which is hidden then), looking straight ahead.
  const showcaseCam = new THREE.PerspectiveCamera(40, 1080 / 1920, 0.05, 20);
  showcaseCam.position.set(0, SHOWCASE_Y, 2.4);
  showcaseCam.lookAt(0, SHOWCASE_Y, 0);
  showcaseCam.updateMatrixWorld();
  return { scene, camera, tops, halo, sparks, impact, flash, stadium, launchers, shocks, showcaseCam };
});

/** The replay camera: low and to the side of where the match was decided, drifting round it. */
export interface ReplayCam {
  x: number;
  y: number;
  angle: number;
}

function placeCamera(s: State, camera: THREE.PerspectiveCamera, replay?: ReplayCam) {
  if (replay) {
    // Look at the action, pulled a little towards the middle.
    const tx = replay.x * 0.8;
    const tz = replay.y * 0.8;
    const target = new THREE.Vector3(tx, floorY(tx, tz) + 0.04, tz);
    camera.fov = 46;
    camera.position.set(tx + Math.sin(replay.angle) * 2.4, target.y + 1.45, tz + Math.cos(replay.angle) * 2.4);
    camera.updateProjectionMatrix();
    camera.lookAt(target);
    camera.updateMatrixWorld();
    return;
  }
  if (camera.fov !== 40) {
    camera.fov = 40;
    camera.updateProjectionMatrix();
  }
  const target = new THREE.Vector3(s.cam.x, floorY(s.cam.x, s.cam.y), s.cam.y + CAM_LOOK_Z);
  camera.position.copy(target).addScaledVector(CAM_OFFSET, 1 / s.cam.z);
  camera.lookAt(target);
  camera.updateMatrixWorld();
}

/** Deterministic 0..1 hash (visual-only randomness for spark sprays). */
const hash = (k: number, seed: number) => {
  const x = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

const tmpAxis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Draw the stadium. `s` owns the 3D scene; `look` is the state to show (the live state, or the
 * replay's view of the past), optionally from the replay camera.
 */
export function drawView(ctx: Ctx2D, s: State, theme: Theme, look: State = s, replayCam?: ReplayCam) {
  const v = view(s, theme);
  v.stadium.visible = true;
  placeCamera(look, v.camera, replayCam);
  drawTops(v, look);
  drawLaunchers(v, look);
  drawSparks(v, look);
  if (look.endAt !== null && look.t >= look.endAt && look.winner >= 0) {
    const w = look.tops[look.winner];
    v.halo.visible = true;
    v.halo.position.set(w.x, floorY(w.x, w.y) + 0.005, w.y);
    v.halo.scale.setScalar(w.stats.radius * 1.6 * (1 + 0.08 * Math.sin((look.t - look.endAt) * 10)));
  } else v.halo.visible = false;
  draw3D(ctx, v.scene, v.camera);
}

type View = ReturnType<typeof view>;

function drawTops(v: View, s: State) {
  s.tops.forEach((top, i) => {
    const tv = v.tops[i];
    const g = tv.group;
    const sinceOut = top.outAt >= 0 ? s.t - top.outAt : 0;
    g.visible = s.phase !== 'vs';
    let x = top.x;
    let z = top.y;
    let y = floorY(x, z);
    let tilt = top.tilt;
    let tumble = 0;
    let spin = top.spin;
    if (s.phase === 'countdown') {
      // Hanging still under its launcher.
      y = launcherY(s, i) - HANG;
    } else if (s.phase === 'drop') {
      // Ripcord pulled: spinning up as it falls straight down.
      const tau = s.t - s.launchAt;
      y += (LAUNCH_H - HANG) * (1 - (tau / DROP_S) ** 2);
      spin += 30 * tau * tau;
    }
    if (top.status === 'out') {
      const sp = Math.sqrt(top.outVx * top.outVx + top.outVy * top.outVy) || 1;
      const ux = top.outVx / sp;
      const uz = top.outVy / sp;
      if (top.outKind === 'wall') {
        // Launched over the wall: a high arc out of the stadium, tumbling.
        const tau = sinceOut;
        g.visible = tau < 1.3;
        x += ux * 1.5 * tau;
        z += uz * 1.5 * tau;
        y = BOWL_H + 0.05 + 1.9 * tau - 3.2 * tau * tau;
        tumble = tau * 9;
      } else {
        // Into a pocket: slides out and drops into the tray.
        const tau = Math.min(sinceOut, 0.6);
        x += ux * 0.3 * clamp01(tau / 0.25);
        z += uz * 0.3 * clamp01(tau / 0.25);
        y = BOWL_H - 0.4 * Math.max(0, tau - 0.15) ** 1.2;
        g.visible = sinceOut < 0.9;
        tumble = tau * 4;
      }
    } else if (top.status === 'down') {
      // Spin finish: it tips onto its side and stays there.
      tilt = 0.25 + 0.95 * clamp01(sinceOut / 0.35);
      // Lying on its side it rests on the contour's edge, not the tip: lift it out of the floor.
      y += top.stats.radius * 0.75 * Math.sin(tilt);
      // Free-for-all: a fallen top sinks away so the others don't spin through it (and the winner
      // stays where it is to the end).
      if (s.p.format === 'ffa' && top.idx !== s.winner) {
        const sink = clamp01((sinceOut - 1) / 0.5);
        y -= 0.3 * sink;
        g.visible = g.visible && sink < 1;
      }
    }
    g.position.set(x, y, z);
    tmpAxis.set(Math.cos(top.precess), 0, Math.sin(top.precess));
    g.setRotationFromAxisAngle(tmpAxis, tilt + tumble);
    // Right spin turns clockwise seen from above.
    tv.spinner.quaternion.setFromAxisAngle(UP, -top.dir * spin);
    const w = top.status === 'spinning' && (s.phase === 'fight' || s.phase === 'after' || s.phase === 'over') ? top.omega : 0;
    (tv.blur.material as THREE.MeshBasicMaterial).opacity = 0.4 * clamp01((w - 0.15) / 0.6);
    tv.metal.emissiveIntensity = 0.8 * top.flash;
  });

}

/** Launcher height over the floor: it comes down at the start of the countdown and jolts on each beat. */
function launcherY(s: State, i: number) {
  const p = s.launchPos[i] ?? { x: 0, y: 0 };
  const since = s.t - s.phaseAt;
  const enter = 1 - (1 - clamp01(since / 0.35)) ** 3;
  const beat = Math.floor(since / BEAT_S);
  const jolt = since >= 0 ? -0.02 * Math.exp(-(since - beat * BEAT_S) * 14) : 0;
  return floorY(p.x, p.y) + LAUNCH_H + (1 - enter) * 1.4 + jolt;
}

function drawLaunchers(v: View, s: State) {
  s.tops.forEach((top, i) => {
    const l = v.launchers[i];
    const p = s.launchPos[i];
    const sinceGo = s.t - s.launchAt;
    const going = (s.phase === 'drop' || s.phase === 'fight') && s.launchAt >= 0 && sinceGo < 0.5;
    l.group.visible = !!p && (s.phase === 'countdown' || going);
    if (!l.group.visible) return;
    if (s.phase === 'countdown') {
      l.group.position.set(p.x, launcherY(s, i), p.y);
      l.cord.position.x = 0;
      l.cord.visible = true;
      return;
    }
    // GO: the ripcord whips out, then the launcher lifts away.
    const y = floorY(p.x, p.y) + LAUNCH_H + 2.2 * Math.max(0, sinceGo - 0.08) ** 2 * 4;
    l.group.position.set(p.x, y, p.y);
    l.cord.position.x = l.side * 1.1 * clamp01(sinceGo / 0.12) ** 2;
    l.cord.visible = sinceGo < 0.16;
    void top;
  });
  // Landing shockwaves.
  s.tops.forEach((top, i) => {
    const m = v.shocks[i];
    const tau = s.t - s.landAt;
    m.visible = s.landAt >= 0 && tau >= 0 && tau < 0.45;
    if (!m.visible) return;
    const p = s.launchPos[i];
    const u = tau / 0.45;
    m.position.set(p.x, floorY(p.x, p.y) + 0.006, p.y);
    m.scale.setScalar(top.stats.radius * (0.8 + 3.2 * (1 - (1 - u) ** 3)));
    (m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - u);
  });
}

/**
 * VS card: each top shown big in its half, tilted towards the viewer and turning slowly. Each half
 * is drawn separately so the tops slide in and out with their halves.
 */
export function drawShowcase(ctx: Ctx2D, s: State, theme: Theme, sl: VsSlide) {
  const v = view(s, theme);
  v.stadium.visible = false;
  v.halo.visible = false;
  v.impact.visible = false;
  v.flash.intensity = 0;
  for (const sp of v.sparks) sp.visible = false;
  for (const l of v.launchers) l.group.visible = false;
  for (const m of v.shocks) m.visible = false;
  const tanY = Math.tan((20 * Math.PI) / 180);
  const layout = vsLayout(s.tops.length);
  s.tops.forEach((top, k) => {
    v.tops.forEach((tv, j) => (tv.group.visible = j === k));
    const tv = v.tops[k];
    const strip = layout.strips[k];
    const c = strip.top;
    // The camera distance sizes the top for its strip (smaller strips, smaller tops).
    const d = strip.camD;
    v.showcaseCam.position.set(0, SHOWCASE_Y, d);
    v.showcaseCam.lookAt(0, SHOWCASE_Y, 0);
    v.showcaseCam.updateMatrixWorld();
    const x = ((c.x - 540) / 540) * d * tanY * (1080 / 1920);
    const y = SHOWCASE_Y + ((960 - c.y) / 960) * d * tanY;
    tv.group.position.set(x, y - 0.06, 0);
    tv.group.rotation.set(0.95 + 0.04 * Math.sin(s.t * 3 + k), 0, 0);
    tv.spinner.quaternion.setFromAxisAngle(UP, -top.dir * s.t * 2.4);
    (tv.blur.material as THREE.MeshBasicMaterial).opacity = 0;
    tv.metal.emissiveIntensity = 0;
    const o = sl.o[k];
    ctx.save();
    ctx.translate(o.x, o.y);
    draw3D(ctx, v.scene, v.showcaseCam);
    ctx.restore();
  });
  for (const tv of v.tops) tv.group.visible = true;
  v.stadium.visible = true;
}

const SPARK_G = 5;
const tmpPos = new THREE.Vector3();

/**
 * Clash sparks: streaks spraying along the contact surface (where the contours scrape), with a
 * few kicked up high. Heavy hits throw several times as many, faster and longer-lived, plus a
 * white-hot flash; opposite-spin hits (surfaces running together) throw fewer.
 */
function drawSparks(v: View, s: State) {
  let si = 0;
  let flashI = 0;
  for (const h of s.hits) {
    const tau = s.t - h.t;
    const heavy = clamp01((h.power - HEAVY_HIT * 0.75) / HEAVY_HIT);
    const life = 0.3 + 0.35 * heavy;
    if (tau < 0 || tau > life) continue;
    const fade = 1 - tau / life;
    const base = new THREE.Vector3(h.x, floorY(h.x, h.y) + 0.085, h.y);
    // Tangent to the contact (perpendicular to the line between the tops), in x/z.
    const tx = -h.ny;
    const tz = h.nx;
    const n = Math.round((h.opp ? 4 : 7) + (h.opp ? 14 : 34) * heavy);
    for (let k = 0; k < n && si < v.sparks.length; k++) {
      const r1 = hash(k, h.simT);
      const r2 = hash(k + 101, h.simT);
      const r3 = hash(k + 211, h.simT);
      const side = k % 2 ? 1 : -1;
      const a = (r1 - 0.5) * 1.5;
      const dx = side * (tx * Math.cos(a) - tz * Math.sin(a));
      const dz = side * (tx * Math.sin(a) + tz * Math.cos(a));
      const up = 0.2 + 1.1 * r2 * r2;
      const speed = (1.2 + 3.4 * heavy) * (0.45 + 0.75 * r3);
      const vx = dx * speed;
      const vz = dz * speed;
      const vy = up * speed - SPARK_G * tau;
      const sp = v.sparks[si++];
      sp.visible = true;
      sp.position.set(base.x + vx * tau, base.y + up * speed * tau - 0.5 * SPARK_G * tau * tau, base.z + vz * tau);
      sp.lookAt(tmpPos.set(sp.position.x + vx, sp.position.y + vy, sp.position.z + vz));
      const w = 0.009 * (1 + 0.7 * heavy) * fade;
      sp.scale.set(w, w, (0.03 + 0.035 * Math.sqrt(vx * vx + vy * vy + vz * vz)) * fade);
    }
    // The flash lasts a split second.
    if (heavy > 0 && tau < 0.16) {
      const f = heavy * (1 - tau / 0.16);
      if (f > flashI) {
        flashI = f;
        v.flash.position.set(base.x, base.y + 0.06, base.z);
        v.impact.position.copy(base);
        v.impact.scale.setScalar(0.02 + 0.04 * f);
      }
    }
  }
  // Landing: a ring of low sparks around each top as it hits the floor.
  const tl = s.t - s.landAt;
  if (s.landAt >= 0 && tl >= 0 && tl < 0.4) {
    s.launchPos.forEach((p, i) => {
      for (let k = 0; k < 18 && si < v.sparks.length; k++) {
        const a = (k / 18) * Math.PI * 2 + i;
        const speed = 1.6 + 1.2 * hash(k, i + 7);
        const up = 0.25 + 0.5 * hash(k + 31, i + 7);
        const vx = Math.cos(a) * speed;
        const vz = Math.sin(a) * speed;
        const vy = up * speed - SPARK_G * tl;
        const sp = v.sparks[si++];
        const r = s.tops[i].stats.radius;
        sp.visible = true;
        sp.position.set(p.x + Math.cos(a) * r + vx * tl, floorY(p.x, p.y) + 0.03 + up * speed * tl - 0.5 * SPARK_G * tl * tl, p.y + Math.sin(a) * r + vz * tl);
        sp.lookAt(tmpPos.set(sp.position.x + vx, sp.position.y + vy, sp.position.z + vz));
        const f = 1 - tl / 0.4;
        sp.scale.set(0.008 * f, 0.008 * f, (0.03 + 0.03 * speed) * f);
      }
    });
  }
  for (; si < v.sparks.length; si++) v.sparks[si].visible = false;
  v.flash.intensity = 2.5 * flashI;
  v.impact.visible = flashI > 0.02;
  (v.impact.material as THREE.MeshBasicMaterial).opacity = Math.min(1, flashI * 1.3);
}

/** Screen position (video pixels) of a point on the stadium floor. */
export function screenOf(s: State, theme: Theme, x: number, y: number) {
  const v = view(s, theme);
  placeCamera(s, v.camera);
  const p = new THREE.Vector3(x, floorY(x, y), y).project(v.camera);
  return { x: (p.x * 0.5 + 0.5) * 1080, y: (-p.y * 0.5 + 0.5) * 1920 };
}
