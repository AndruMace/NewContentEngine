/**
 * Tower Stack's view: chunky extruded toy pieces on a soft periwinkle backdrop that catches their
 * shadows, a ruler up the side, and the game's cards (height, pieces, hearts, what's next) drawn
 * crisp on top. Rendering only: reads sim state, never changes physics. The camera is the one piece
 * of visual state the sim keeps (s.cam, smoothed in step() when visual), so it moves the same way in
 * the Playground and in renders.
 */
import { FONT_FAMILY, type Ctx2D } from '@sim/engine';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { burst, drawSparks, updateSparks } from '../fx';
import { THREE, draw3D, environmentMap, sceneCache } from '../three-layer';
import { DEPTH, extent, placed, type PieceDef } from './pieces';
import { BASE_HW } from './world';
import { MILESTONES, type State } from './index';

export interface Cam {
  /** World heights at the bottom and top of the play area (the frame below the cards). */
  lo: number;
  hi: number;
  cx: number;
}

const W = 1080;
const H = 1920;
/** The play area: the part of the frame below the cards. */
const AREA_TOP = 0.27;
const AREA_BOTTOM = 0.94;
const FOV = 16;

const LOOKS = {
  day: {
    bg: ['#e4eafc', '#c9d5f5'],
    card: 'rgba(255,255,255,0.94)',
    cardText: '#1b2140',
    muted: '#6b7395',
    ruler: 'rgba(40,50,100,0.38)',
    shadow: 0.17,
    base: '#a7b4ee',
    accent: '#3b5bdb',
  },
  night: {
    bg: ['#151a33', '#262e58'],
    card: 'rgba(30,36,70,0.94)',
    cardText: '#eef1ff',
    muted: '#9aa3cc',
    ruler: 'rgba(210,220,255,0.38)',
    shadow: 0.32,
    base: '#5866b8',
    accent: '#8ea2ff',
  },
};

function desired(s: State): Cam {
  const cx = Math.max(-1, Math.min(1, s.shape.comX * 0.6));
  if (s.endAt !== null) {
    // The finish: the whole tower, top to bottom, with room above it for the final height.
    const lo = -0.9;
    return { lo, hi: Math.max(lo + 8.5, (s.shape.top - 0.32 * lo) / 0.68), cx };
  }
  let top = s.shape.top;
  if (s.phase === 'think' || s.phase === 'aim' || s.phase === 'rewind') top = Math.max(top, s.held.y + extent(s.queue[s.index], s.held.a).maxY);
  let lo = -0.7;
  let hi = Math.max(top + 1.5, lo + 8);
  if (hi - lo > 16) lo = hi - 16;
  return { lo, hi, cx };
}

export const initialCamera = (s: State): Cam => desired(s);

export function updateCamera(s: State, _t: number, dt: number) {
  const d = desired(s);
  const k = 1 - Math.exp(-(s.endAt !== null ? 1.6 : 2.6) * dt);
  s.cam.lo += (d.lo - s.cam.lo) * k;
  s.cam.hi += (d.hi - s.cam.hi) * k;
  s.cam.cx += (d.cx - s.cam.cx) * k;
}

const geometries = new Map<string, THREE.ExtrudeGeometry>();
function pieceGeometry(def: PieceDef) {
  let g = geometries.get(def.id);
  if (g) return g;
  const shape = new THREE.Shape(def.outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const bevel = 0.05;
  // The bevel starts inside the outline, so pieces that touch don't overlap on screen.
  g = new THREE.ExtrudeGeometry(shape, { depth: DEPTH - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 3, curveSegments: 6 });
  g.translate(0, 0, -(DEPTH - 2 * bevel) / 2);
  g.computeVertexNormals();
  geometries.set(def.id, g);
  return g;
}

const view = sceneCache((s: State) => {
  const look = LOOKS[s.p.look];
  const scene = new THREE.Scene();
  scene.environment = environmentMap();
  scene.environmentIntensity = s.p.look === 'day' ? 0.35 : 0.2;
  const camera = new THREE.PerspectiveCamera(FOV, W / H, 0.5, 400);
  scene.add(new THREE.HemisphereLight(0xffffff, s.p.look === 'day' ? 0x9aa6d8 : 0x2a3160, s.p.look === 'day' ? 1.1 : 0.7));
  const sun = new THREE.DirectionalLight(0xfff8f0, s.p.look === 'day' ? 1.9 : 1.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 6;
  scene.add(sun, sun.target);
  // The backdrop: invisible except for the pieces' soft shadows.
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(200, 400), new THREE.ShadowMaterial({ opacity: look.shadow }));
  wall.position.z = -DEPTH / 2 - 0.45;
  wall.receiveShadow = true;
  scene.add(wall);
  const base = new THREE.Mesh(new RoundedBoxGeometry(BASE_HW * 2, 0.35, DEPTH + 0.15, 3, 0.06), new THREE.MeshStandardMaterial({ color: look.base, roughness: 0.6 }));
  base.position.y = -0.175;
  base.castShadow = base.receiveShadow = true;
  scene.add(base);
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const material = (def: PieceDef) => {
    let m = materials.get(def.id);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: def.color, roughness: s.p.look === 'day' ? 0.55 : 0.4, metalness: 0, transparent: true });
      materials.set(def.id, m);
    }
    return m;
  };
  const meshes: THREE.Mesh[] = [];
  const held = new THREE.Mesh(undefined, undefined);
  held.castShadow = held.receiveShadow = true;
  scene.add(held);
  return { scene, camera, sun, meshes, held, material };
});

/** Screen position of a world point (for the 2D layer), with the camera as last drawn. */
let project: (x: number, y: number) => { x: number; y: number } = (x, y) => ({ x, y });

export function drawTowerStack3D(ctx: Ctx2D, s: State, t: number) {
  const look = LOOKS[s.p.look];
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, look.bg[0]);
  g.addColorStop(1, look.bg[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const v = view(s, undefined as never);
  const { lo, hi, cx } = s.cam;
  // Fit [lo, hi] into the play area of the frame.
  const frameH = (hi - lo) / (AREA_BOTTOM - AREA_TOP);
  const midY = lo - (1 - AREA_BOTTOM) * frameH + frameH / 2;
  const dist = frameH / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);
  v.camera.position.set(cx - dist * 0.04, midY + dist * 0.07, dist);
  v.camera.lookAt(cx, midY, 0);
  v.camera.far = dist * 2 + 20;
  v.camera.updateProjectionMatrix();
  v.camera.updateMatrixWorld();
  v.sun.position.set(cx - 4, midY + 7, 12);
  v.sun.target.position.set(cx, midY, 0);
  const sc = v.sun.shadow.camera;
  const half = frameH * 0.62;
  Object.assign(sc, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 40 });
  sc.updateProjectionMatrix();

  // While the player thinks, the world is busy with its test drops: draw the tower as it stands.
  const pieces = s.phase === 'think' ? s.snap.pieces : s.world.pieces;
  while (v.meshes.length < pieces.length) {
    const m = new THREE.Mesh();
    m.castShadow = m.receiveShadow = true;
    v.scene.add(m);
    v.meshes.push(m);
  }
  v.meshes.forEach((m, i) => {
    const p = pieces[i];
    m.visible = !!p;
    if (!p) return;
    m.geometry = pieceGeometry(p.def);
    m.material = v.material(p.def);
    m.position.set(p.x, p.y, 0);
    m.rotation.set(0, 0, p.a);
  });
  const showHeld = s.phase === 'think' || s.phase === 'aim' || s.phase === 'rewind';
  v.held.visible = showHeld && s.index < s.queue.length;
  if (v.held.visible) {
    const def = s.queue[s.index];
    v.held.geometry = pieceGeometry(def);
    v.held.material = v.material(def);
    const pop = s.phase === 'think' ? smooth(Math.min(1, (t - s.phaseAt) / 0.2)) : 1;
    v.held.position.set(s.held.x, s.held.y + (1 - pop) * 0.4, 0);
    v.held.rotation.set(0, 0, s.held.a);
    v.held.scale.setScalar(0.75 + 0.25 * pop);
  }
  // Neutral tone mapping keeps the pastels' hue and saturation.
  draw3D(ctx, v.scene, v.camera, { exposure: s.p.look === 'day' ? 1 : 1.1, toneMapping: THREE.NeutralToneMapping });

  const cam = v.camera;
  const tmp = new THREE.Vector3();
  project = (x, y) => {
    tmp.set(x, y, 0).project(cam);
    return { x: ((tmp.x + 1) / 2) * W, y: ((1 - tmp.y) / 2) * H };
  };
}

const smooth = (u: number) => u * u * (3 - 2 * u);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The crisp layer: ruler, cards, the player's cursor, pop-ups and confetti. */
export function drawTowerStackTop(ctx: Ctx2D, s: State, t: number) {
  const look = LOOKS[s.p.look];
  drawRuler(ctx, s, look);
  drawCursor(ctx, s, t, look);

  // Confetti from the top of each piece as it comes to rest.
  for (const pop of s.popups)
    if (pop.kind === 'gain' && !pop.burst) {
      pop.burst = true;
      const last = s.world.pieces[s.world.pieces.length - 1];
      if (last) {
        const top = Math.max(...placed(last.def, last.x, last.y, last.a).map((q) => q[1]));
        const at = project(last.x, top);
        const colors = ['#ff6b6b', '#ffd43b', '#51cf66', '#339af0', '#cc5de8', '#ff922b'];
        burst(s.sparks, s.fxRng, at.x, at.y - 10, 26, 520, () => colors[s.fxRng.int(0, colors.length - 1)], 11);
        for (const sp of s.sparks) if (sp.vy > 0) sp.vy *= -0.6;
      }
    }
  s.sparks = updateSparks(s.sparks, 1 / 60, 1400);
  drawSparks(ctx, s.sparks);

  drawCards(ctx, s, t, look);
  drawPopups(ctx, s, t, look);

  // A red pulse as the tower goes, a white flash as it rewinds.
  const f = t - s.fallAt;
  if (f >= 0 && f < 0.7) {
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.75);
    v.addColorStop(0, 'rgba(255,60,60,0)');
    v.addColorStop(1, `rgba(255,60,60,${0.35 * (1 - f / 0.7)})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }
  const r = t - s.rewindAt;
  if (r >= 0 && r < 0.35) {
    ctx.fillStyle = `rgba(255,255,255,${0.55 * (1 - r / 0.35)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

type Look = (typeof LOOKS)['day'];

function drawRuler(ctx: Ctx2D, s: State, look: Look) {
  const x = 64;
  const topY = AREA_TOP * H - 30;
  ctx.save();
  ctx.font = `700 26px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const step = s.cam.hi - s.cam.lo > 12 ? 2 : 1;
  for (let k = 0; k <= 80; k += step) {
    const at = project(0, k);
    if (at.y < topY) break;
    if (at.y > H) continue;
    const major = k % 5 === 0;
    ctx.strokeStyle = look.ruler;
    ctx.lineWidth = major ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(x, at.y);
    ctx.lineTo(x + (major ? 34 : 16), at.y);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = look.ruler;
      ctx.fillText(`${k * 10} cm`, x + 44, at.y);
    }
  }
  // The next thing to beat, marked at its height.
  const next = MILESTONES.find((m) => m.cm > s.height);
  if (next && s.endAt === null) {
    const at = project(0, next.cm / 10);
    if (at.y > AREA_TOP * H + 60 && at.y < H - 40) {
      ctx.strokeStyle = look.accent;
      ctx.setLineDash([10, 10]);
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(x, at.y);
      ctx.lineTo(W - 40, at.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      pill(ctx, x + 6, at.y - 52, `Next: ${next.icon} ${next.name}`, 26, look);
    }
  }
  ctx.restore();
}

function pill(ctx: Ctx2D, x: number, y: number, text: string, size: number, look: Look) {
  ctx.font = `700 ${size}px ${FONT_FAMILY}`;
  const w = ctx.measureText(text).width + size * 1.2;
  const h = size * 1.6;
  ctx.fillStyle = look.card;
  ctx.shadowColor = 'rgba(30,40,90,0.18)';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = look.cardText;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + size * 0.6, y + h / 2 + 1);
}

function card(ctx: Ctx2D, x: number, y: number, w: number, h: number, look: Look) {
  ctx.save();
  ctx.fillStyle = look.card;
  ctx.shadowColor = 'rgba(30,40,90,0.2)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 6;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 30);
  ctx.fill();
  ctx.restore();
}

function heart(ctx: Ctx2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + r * 0.9);
  ctx.bezierCurveTo(x - r * 1.5, y - r * 0.1, x - r * 0.7, y - r * 1.2, x, y - r * 0.45);
  ctx.bezierCurveTo(x + r * 0.7, y - r * 1.2, x + r * 1.5, y - r * 0.1, x, y + r * 0.9);
  ctx.fill();
}

/** A piece's outline, fitted into a box. */
function icon(ctx: Ctx2D, def: PieceDef, cx: number, cy: number, size: number) {
  const e = extent(def, 0);
  const k = size / Math.max(e.maxX - e.minX, e.maxY - e.minY);
  const ox = cx - ((e.minX + e.maxX) / 2) * k;
  const oy = cy + ((e.minY + e.maxY) / 2) * k;
  ctx.beginPath();
  def.outline.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * k, oy - y * k) : ctx.moveTo(ox + x * k, oy - y * k)));
  ctx.closePath();
  ctx.fillStyle = def.color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawCards(ctx: Ctx2D, s: State, t: number, look: Look) {
  const y = 300;
  // Height, piece count and hearts.
  card(ctx, 40, y, 420, 196, look);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = look.cardText;
  ctx.font = `900 96px ${FONT_FAMILY}`;
  const h = String(s.height);
  ctx.fillText(h, 74, y + 106);
  const hw = ctx.measureText(h).width;
  ctx.font = `800 32px ${FONT_FAMILY}`;
  ctx.fillText('cm tall', 74 + hw + 14, y + 104);
  ctx.font = `700 30px ${FONT_FAMILY}`;
  ctx.fillStyle = look.muted;
  const total = s.p.mode === 'daily' ? `/${s.queue.length}` : '';
  ctx.fillText(`Piece ${Math.min(s.index + 1, s.queue.length)}${total}`, 74, y + 160);
  for (let i = 0; i < s.p.lives; i++) {
    const lost = i >= s.lives;
    // The heart just lost shrinks away.
    const justLost = i === s.lives && t - s.fallAt < 0.5;
    const k = justLost ? 1 + 0.6 * Math.sin(((t - s.fallAt) / 0.5) * Math.PI) : 1;
    heart(ctx, 330 + i * 40, y + 150, 15 * k, lost && !justLost ? 'rgba(150,160,200,0.45)' : '#f0506e');
  }

  // Now and next.
  const x = 520;
  card(ctx, x, y, 520, 196, look);
  ctx.font = `700 26px ${FONT_FAMILY}`;
  ctx.fillStyle = look.muted;
  ctx.fillText('now', x + 30, y + 46);
  ctx.fillText('next', x + 330, y + 46);
  const cur = s.queue[Math.min(s.index, s.queue.length - 1)];
  if (s.endAt === null) {
    icon(ctx, cur, x + 90, y + 118, 84);
    ctx.font = `800 30px ${FONT_FAMILY}`;
    ctx.fillStyle = look.cardText;
    ctx.fillText(cur.name, x + 150, y + 112, 170);
    ctx.font = `600 22px ${FONT_FAMILY}`;
    ctx.fillStyle = look.muted;
    // Its size, as the real game's cards show it.
    const e = extent(cur, 0);
    ctx.fillText(`${Math.round((e.maxX - e.minX) * 10)} × ${Math.round((e.maxY - e.minY) * 10)} cm`, x + 150, y + 146, 170);
  } else {
    ctx.font = `800 30px ${FONT_FAMILY}`;
    ctx.fillStyle = look.cardText;
    ctx.fillText(s.lives > 0 ? 'All stacked!' : 'Out of falls', x + 30, y + 118);
  }
  for (let k = 1; k <= 2; k++) {
    const d = s.queue[s.index + k];
    if (d && s.endAt === null) icon(ctx, d, x + 330 + 36 + (k - 1) * 96, y + 118, 64);
  }
}

/** The player's hand: an arrow cursor holding the piece as it slides it over and turns it. */
function drawCursor(ctx: Ctx2D, s: State, t: number, look: Look) {
  if (s.phase !== 'think' && s.phase !== 'aim' && !(s.phase === 'drop' && t - s.phaseAt < 0.35)) return;
  const fade = s.phase === 'drop' ? 1 - (t - s.phaseAt) / 0.35 : s.phase === 'think' ? Math.min(1, (t - s.phaseAt) / 0.15) : 1;
  const at = project(s.held.x, s.held.y);
  const x = at.x + 14, y = at.y + 6;
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.translate(x, y);
  ctx.scale(1.6, 1.6);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 30);
  ctx.lineTo(8, 23);
  ctx.lineTo(14, 36);
  ctx.lineTo(19, 34);
  ctx.lineTo(13, 21);
  ctx.lineTo(23, 21);
  ctx.closePath();
  ctx.fillStyle = '#1b2140';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
  ctx.restore();
  // The turn badge, while it is turning.
  if (s.phase === 'aim' && Math.abs(s.aim.toA - s.aim.fromA) > 0.01 && t < s.aim.at + s.aim.len) {
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = look.card;
    ctx.strokeStyle = look.accent;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x + 70, y - 40, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = look.accent;
    ctx.font = `900 30px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('↻', x + 70, y - 38);
    ctx.restore();
  }
}

function drawPopups(ctx: Ctx2D, s: State, t: number, look: Look) {
  for (const p of s.popups) {
    const age = t - p.t0;
    if (p.kind === 'gain' && age < 1.3) {
      ctx.save();
      ctx.globalAlpha = clamp01((1.3 - age) / 0.4) * clamp01(age / 0.1);
      ctx.font = `900 46px ${FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = p.text.startsWith('-') ? '#e8590c' : '#2f9e44';
      ctx.fillText(p.text, 60, 560 - age * 40);
      ctx.restore();
    }
    if (p.kind === 'milestone' && age < 2.6) {
      ctx.save();
      const a = clamp01(age / 0.2) * clamp01((2.6 - age) / 0.3);
      ctx.globalAlpha = a;
      const y = H - 210 + (1 - smooth(clamp01(age / 0.25))) * 40;
      card(ctx, 60, y, W - 120, 132, look);
      ctx.font = `64px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.icon ?? '', 130, y + 68);
      ctx.textAlign = 'left';
      ctx.fillStyle = look.cardText;
      ctx.font = `900 40px ${FONT_FAMILY}`;
      ctx.fillText(p.text, 190, y + 48, W - 300);
      ctx.fillStyle = look.muted;
      ctx.font = `600 28px ${FONT_FAMILY}`;
      ctx.fillText(p.sub ?? '', 190, y + 94, W - 300);
      ctx.restore();
    }
    if (p.kind === 'fall' && age < 1.6) {
      ctx.save();
      const pop = 0.8 + 0.2 * smooth(clamp01(age / 0.18));
      ctx.globalAlpha = clamp01((1.6 - age) / 0.3);
      ctx.translate(W / 2, 640);
      ctx.scale(pop, pop);
      ctx.fillStyle = '#f0506e';
      ctx.beginPath();
      ctx.roundRect(-300, -70, 600, 140, 40);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 52px ${FONT_FAMILY}`;
      ctx.fillText(`💔 ${p.text}`, 0, -18);
      ctx.font = `700 26px ${FONT_FAMILY}`;
      ctx.fillText(p.sub ?? '', 0, 34);
      ctx.restore();
    }
    if (p.kind === 'final' && age > 0.4) {
      // The final height, and the tallest thing it beat.
      ctx.save();
      const u = smooth(clamp01((age - 0.4) / 0.35));
      ctx.globalAlpha = u;
      const y = 560;
      card(ctx, 140, y, W - 280, 250, look);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = look.muted;
      ctx.font = `800 30px ${FONT_FAMILY}`;
      ctx.fillText(s.lives > 0 ? 'FINAL HEIGHT' : 'LAST STEADY TOWER', W / 2, y + 58);
      ctx.fillStyle = look.cardText;
      ctx.font = `900 ${Math.round(110 * (0.8 + 0.2 * u))}px ${FONT_FAMILY}`;
      ctx.fillText(p.text, W / 2, y + 168);
      const beat = MILESTONES.filter((m) => m.cm <= s.height).pop();
      ctx.font = `700 32px ${FONT_FAMILY}`;
      ctx.fillStyle = look.muted;
      ctx.fillText(beat ? `${beat.icon} Taller than ${beat.name}` : 'Shorter than a phone…', W / 2, y + 220);
      ctx.restore();
    }
  }
}
