/**
 * The cabin's static interior: log walls with chinking, plank floor and beamed ceiling, the stone
 * chimney with its firebox, hearth and mantel, window casings and mullions, and the furniture.
 * Built once; nothing here moves.
 */
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { THREE } from '../three-layer';
import { model, textureMaterial } from '../ambient/assets';
import { BACK, CEILING, CHIMNEY, FIREBOX, FRONT, HALF_W, HEARTH, LOG_PITCH, LOG_R, MANTEL, WINDOWS, type Opening } from './layout';

/** Deterministic visual-only randomness (layout details never affect the sim). */
function hashRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 4294967296;
  };
}

/** Rescale a box's UVs to metres × `perMetre`, so one texture keeps its scale across boxes of any size. */
function worldUvBox(w: number, h: number, d: number, perMetre: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // Face order: +x, -x, +y, -y, +z, -z (4 vertices each); each face's u and v span these sizes.
  const spans: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let i = 0; i < uv.count; i++) {
    const [su, sv] = spans[Math.floor(i / 4)];
    uv.setXY(i, uv.getX(i) * su * perMetre, uv.getY(i) * sv * perMetre);
  }
  return g;
}

function boxAt(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** One log lying along x (or along z with `alongZ`), as geometry ready to merge (uv in metres, tinted). */
function logGeo(len: number, rnd: () => number, alongZ: boolean, at: THREE.Vector3) {
  const r = LOG_R * (0.92 + rnd() * 0.16);
  const g = new THREE.CylinderGeometry(r, r * (0.97 + rnd() * 0.06), len, 24, 1);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const u0 = rnd();
  const v0 = rnd() * 4;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + u0) * 0.9, uv.getY(i) * len * 0.55 + v0);
  // Each log a slightly different shade, so the wall doesn't read as one repeated texture.
  const shade = 0.78 + rnd() * 0.3;
  const warm = rnd() * 0.08;
  const colors = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = shade + warm;
    colors[i + 1] = shade;
    colors[i + 2] = shade - warm;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // Roll about its own axis first (the cylinder's axis is y), then lay it down.
  g.rotateY(rnd() * Math.PI * 2);
  g.rotateZ(Math.PI / 2);
  if (alongZ) g.rotateY(Math.PI / 2);
  g.translate(at.x, at.y, at.z);
  return g;
}

/** [x0, x1] spans of a back-wall log row at height y, between the openings it meets. */
function backRowSpans(y: number): [number, number][] {
  const cuts: [number, number][] = [[-CHIMNEY.halfW, CHIMNEY.halfW]];
  for (const w of WINDOWS) if (y + LOG_R * 0.6 > w.y0 && y - LOG_R * 0.6 < w.y1) cuts.push([w.x0, w.x1]);
  cuts.sort((a, b) => a[0] - b[0]);
  const spans: [number, number][] = [];
  let x = -HALF_W - LOG_R;
  for (const [a, b] of cuts) {
    if (a > x) spans.push([x, a]);
    x = Math.max(x, b);
  }
  if (x < HALF_W + LOG_R) spans.push([x, HALF_W + LOG_R]);
  return spans;
}

/** A flat panel (the chinking behind the logs) with rectangular holes, as one geometry. */
function panelWithHoles(x0: number, x1: number, y0: number, y1: number, holes: Opening[]) {
  const shape = new THREE.Shape();
  shape.moveTo(x0, y0);
  shape.lineTo(x1, y0);
  shape.lineTo(x1, y1);
  shape.lineTo(x0, y1);
  shape.lineTo(x0, y0);
  for (const h of holes) {
    const p = new THREE.Path();
    p.moveTo(h.x0, h.y0);
    p.lineTo(h.x0, h.y1);
    p.lineTo(h.x1, h.y1);
    p.lineTo(h.x1, h.y0);
    p.lineTo(h.x0, h.y0);
    shape.holes.push(p);
  }
  return new THREE.ShapeGeometry(shape);
}

export interface Room {
  group: THREE.Group;
  /** Lantern glass position (for its light). */
  lantern: THREE.Vector3;
  /** Candle wick positions on the mantel. */
  candles: THREE.Vector3[];
}

export function buildRoom(): Room {
  const group = new THREE.Group();
  const rnd = hashRng(7);

  // ---- Log walls ----------------------------------------------------------------------------
  const logMat = textureMaterial('rough_wood', [1, 1], { vertexColors: true, color: 0xb88a62 });
  const logs: THREE.BufferGeometry[] = [];
  const rows = Math.ceil(CEILING / LOG_PITCH) + 1;
  for (let r = 0; r < rows; r++) {
    const y = LOG_R * 0.85 + r * LOG_PITCH;
    for (const [a, b] of backRowSpans(y)) logs.push(logGeo(b - a, rnd, false, new THREE.Vector3((a + b) / 2, y, BACK)));
    // Side walls run from the back wall to behind the camera; offset half a log (corner notching).
    const ys = y + LOG_PITCH / 2;
    if (ys < CEILING + LOG_R) {
      for (const side of [-1, 1]) logs.push(logGeo(FRONT - BACK + 2 * LOG_R, rnd, true, new THREE.Vector3(side * HALF_W, ys, (BACK + FRONT) / 2)));
    }
  }
  const logMesh = new THREE.Mesh(mergeGeometries(logs), logMat);
  logMesh.castShadow = logMesh.receiveShadow = true;
  group.add(logMesh);

  // Chinking: pale mortar showing between the round logs.
  const chinkMat = new THREE.MeshStandardMaterial({ color: 0xa89a86, roughness: 0.95 });
  const back = new THREE.Mesh(panelWithHoles(-HALF_W, HALF_W, 0, CEILING, WINDOWS), chinkMat);
  back.position.z = BACK - LOG_R * 0.35;
  back.receiveShadow = back.castShadow = true;
  group.add(back);
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(FRONT - BACK, CEILING), chinkMat);
    p.rotation.y = side * -Math.PI / 2;
    p.position.set(side * (HALF_W + LOG_R * 0.35), CEILING / 2, (BACK + FRONT) / 2);
    p.receiveShadow = p.castShadow = true;
    group.add(p);
  }

  // ---- Floor and ceiling --------------------------------------------------------------------
  const floorMat = textureMaterial('wood_floor_worn', [5, 5], { color: 0x9c8068 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF_W, FRONT - BACK), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, (BACK + FRONT) / 2);
  floor.receiveShadow = true;
  group.add(floor);
  const ceilMat = textureMaterial('rough_wood', [6, 3], { color: 0x6e5038 });
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF_W, FRONT - BACK), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, CEILING, (BACK + FRONT) / 2);
  ceil.receiveShadow = true;
  group.add(ceil);
  const beamMat = textureMaterial('rough_wood', [1, 1], { color: 0x7a5a40 });
  for (let z = BACK + 1.2; z < FRONT; z += 1.9) {
    const beam = boxAt(worldUvBox(2 * HALF_W, 0.24, 0.22, 0.8), beamMat, 0, CEILING - 0.12, z);
    group.add(beam);
  }

  // ---- Chimney, firebox, hearth, mantel -------------------------------------------------------
  const stone = (shade = 0xffffff) => textureMaterial('rustic_stone_wall_02', [1, 1], { color: shade });
  const stoneMat = stone(0xd8cfc4);
  const soot = stone(0x2a2522);
  const cw = 2 * CHIMNEY.halfW;
  const cd = CHIMNEY.front - BACK + LOG_R;
  const cz = BACK - LOG_R + cd / 2;
  const fbW = 2 * FIREBOX.halfW;
  const pierW = CHIMNEY.halfW - FIREBOX.halfW;
  // Piers either side of the opening, and the breast above it up to the ceiling.
  for (const side of [-1, 1]) group.add(boxAt(worldUvBox(pierW, FIREBOX.top, cd, 0.9), stoneMat, side * (FIREBOX.halfW + pierW / 2), FIREBOX.top / 2, cz));
  group.add(boxAt(worldUvBox(fbW, FIREBOX.bottom, cd, 0.9), stoneMat, 0, FIREBOX.bottom / 2, cz));
  group.add(boxAt(worldUvBox(cw, CEILING - FIREBOX.top, cd, 0.9), stoneMat, 0, (CEILING + FIREBOX.top) / 2, cz));
  // Inside the firebox: sooty back and sides, and its floor.
  const inner = FIREBOX.top - FIREBOX.bottom;
  const fbDepth = CHIMNEY.front - FIREBOX.back;
  group.add(boxAt(worldUvBox(fbW, inner, 0.05, 1.1), soot, 0, FIREBOX.bottom + inner / 2, FIREBOX.back - 0.025));
  for (const side of [-1, 1]) group.add(boxAt(worldUvBox(0.05, inner, fbDepth, 1.1), soot, side * (FIREBOX.halfW - 0.025), FIREBOX.bottom + inner / 2, FIREBOX.back + fbDepth / 2));
  // Hearth: a raised stone slab in front of the fire.
  const hd = HEARTH.front - CHIMNEY.front;
  group.add(boxAt(worldUvBox(2 * HEARTH.halfW, HEARTH.height, hd, 0.7), stone(0xb0a497), 0, HEARTH.height / 2, CHIMNEY.front + hd / 2));
  // Mantel: a rough-hewn beam across the chimney.
  const mantelMat = textureMaterial('rough_wood', [1, 1], { color: 0x6a4a32 });
  group.add(boxAt(worldUvBox(2 * MANTEL.halfW, MANTEL.h, MANTEL.depth, 1.2), mantelMat, 0, MANTEL.y + MANTEL.h / 2, CHIMNEY.front + MANTEL.depth / 2 - 0.06));

  // Candles on the mantel (their flames are drawn with the fire).
  const candles: THREE.Vector3[] = [];
  const waxMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc4, roughness: 0.6 });
  for (const [x, h] of [[-1.05, 0.2], [-0.88, 0.14], [0.98, 0.17]] as const) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.037, h, 18), waxMat);
    const y0 = MANTEL.y + MANTEL.h;
    c.position.set(x, y0 + h / 2, CHIMNEY.front + MANTEL.depth / 2 - 0.06);
    c.castShadow = c.receiveShadow = true;
    group.add(c);
    candles.push(new THREE.Vector3(x, y0 + h + 0.012, c.position.z));
  }

  // ---- Windows: casings, sills, mullions -----------------------------------------------------
  const frameMat = textureMaterial('rough_wood', [1, 1], { color: 0x5c4030 });
  const T = 0.09;
  const depth = 2 * LOG_R + 0.04;
  for (const w of WINDOWS) {
    const ww = w.x1 - w.x0;
    const wh = w.y1 - w.y0;
    const cx = (w.x0 + w.x1) / 2;
    const cy = (w.y0 + w.y1) / 2;
    // Jambs and head inside the opening (the log ends sit against them), and a deeper sill.
    for (const x of [w.x0 + T / 2, w.x1 - T / 2]) group.add(boxAt(worldUvBox(T, wh, depth, 1.5), frameMat, x, cy, BACK));
    group.add(boxAt(worldUvBox(ww, T, depth, 1.5), frameMat, cx, w.y1 - T / 2, BACK));
    group.add(boxAt(worldUvBox(ww + 0.24, 0.07, depth + 0.16, 1.5), frameMat, cx, w.y0 - 0.035, BACK + 0.08));
    // Mullions: one upright and one transom, four panes.
    group.add(boxAt(worldUvBox(0.06, wh, 0.07, 1.5), frameMat, cx, cy, BACK - 0.02));
    group.add(boxAt(worldUvBox(ww, 0.06, 0.07, 1.5), frameMat, cx, w.y0 + wh * 0.58, BACK - 0.02));
  }

  // ---- Furniture and props -----------------------------------------------------------------------
  const place = (id: string, x: number, z: number, yaw: number, y = 0, scale = 1) => {
    const m = model(id);
    m.scale.setScalar(scale);
    m.rotation.y = yaw;
    m.position.set(x, y, z);
    group.add(m);
    return m;
  };
  // Chairs angled towards the fire, either side of the rug.
  place('Rockingchair_01', -2.15, -0.15, Math.atan2(2.15, -2.4));
  place('ArmChair_01', 2.25, 0.05, Math.atan2(-2.25, -2.6));
  const table = new THREE.Vector3(3.15, 0, -1.25);
  place('WoodenTable_01', table.x, table.z, -0.4);
  const tableTop = new THREE.Box3().setFromObject(group.children[group.children.length - 1]).max.y;
  place('Lantern_01', table.x, table.z, 0.5, tableTop);
  // Rug in front of the hearth.
  const rugMat = textureMaterial('caban', [2.2, 1.4], { color: 0x5a4a44 });
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.8), rugMat);
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.006, -0.55);
  rug.receiveShadow = true;
  group.add(rug);
  // A stack of split firewood beside the hearth.
  const barkMat = textureMaterial('bark_brown_02', [1, 1], { color: 0xc0a080 });
  const woodPile: THREE.BufferGeometry[] = [];
  const pr = hashRng(31);
  for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 4 - Math.floor(row / 2); k++) {
      const g = new THREE.CylinderGeometry(0.075, 0.08, 0.55, 10, 1);
      g.rotateX(Math.PI / 2 + (pr() - 0.5) * 0.15);
      g.rotateY((pr() - 0.5) * 0.12);
      g.translate(-2.4 + k * 0.155 + (row % 2) * 0.075, 0.075 + row * 0.135, BACK + 0.62 + (pr() - 0.5) * 0.04);
      woodPile.push(g.toNonIndexed());
    }
  }
  const pile = new THREE.Mesh(mergeGeometries(woodPile), barkMat);
  pile.castShadow = pile.receiveShadow = true;
  group.add(pile);

  return { group, lantern: new THREE.Vector3(table.x, tableTop + 0.2, table.z), candles };
}
