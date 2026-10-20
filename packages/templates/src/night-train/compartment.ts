/**
 * The sleeper compartment (static): walnut-panelled walls with the window in the outer wall, a
 * rounded metal window frame, the fold-down table and its lamp, the left berth with pillows, curtains
 * either side of the window and the blind's hem at the top, a luggage rack with a suitcase, carpet.
 * Built once; the curtains sway a little and the lamp glows (see view3d).
 */
import { THREE } from '../three-layer';
import { model, textureMaterial } from '../ambient/assets';
import { BACK, BERTH, CEILING, HALF_W, LAMP, TABLE, WALL, WINDOW } from './layout';

/** A box whose UVs are in metres × `perMetre` (one texture scale across boxes of any size). */
function worldUvBox(w: number, h: number, d: number, perMetre: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
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

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, perMetre = 1) {
  const m = new THREE.Mesh(worldUvBox(w, h, d, perMetre), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number) {
  const s = new THREE.Shape();
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0);
  s.quadraticCurveTo(x1, y0, x1, y0 + r);
  s.lineTo(x1, y1 - r);
  s.quadraticCurveTo(x1, y1, x1 - r, y1);
  s.lineTo(x0 + r, y1);
  s.quadraticCurveTo(x0, y1, x0, y1 - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  return s;
}

/** A curtain: a hanging panel with soft vertical folds, hinged at its top edge (it sways from there). */
function curtain(width: number, height: number, mat: THREE.Material) {
  const g = new THREE.PlaneGeometry(width, height, 48, 12);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    // Gathered at the top, falling looser at the bottom.
    pos.setZ(i, 0.035 * Math.sin((x / width) * Math.PI * 9) * (0.6 + 0.4 * (0.5 - y / height)));
  }
  g.computeVertexNormals();
  g.translate(0, -height / 2, 0);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

export interface Compartment {
  group: THREE.Group;
  /** The lamp's shade (its glow is set each frame) and where its light comes from. */
  shade: THREE.MeshStandardMaterial;
  lampAt: THREE.Vector3;
  curtains: THREE.Mesh[];
}

export function buildCompartment(): Compartment {
  const group = new THREE.Group();
  const veneer = textureMaterial('black_walnut_veneer_01', [1, 1], { metalness: 0, roughness: 0.85, color: 0xc4a68a });
  const velour = textureMaterial('velour_velvet', [3, 3], { metalness: 0, color: 0x6a2a30 });
  const curtainCloth = textureMaterial('velour_velvet', [4, 4], { metalness: 0, color: 0x7a3a2a, side: THREE.DoubleSide });
  const carpet = textureMaterial('dirty_carpet', [2, 2], { metalness: 0, color: 0x6a5a5a });
  // Satin aluminium for the frame and rails, brass for the lamp.
  const metal = new THREE.MeshStandardMaterial({ color: 0x8c8984, metalness: 0.35, roughness: 0.45 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08a52, metalness: 0.5, roughness: 0.4 });
  const cream = new THREE.MeshStandardMaterial({ color: 0xd8cbb0, roughness: 0.85 });

  // The outer wall, around the window opening (boxes above, below and either side).
  const T = 0.08;
  const z = WALL + T / 2;
  group.add(box(2 * HALF_W, WINDOW.y0, T, veneer, 0, WINDOW.y0 / 2, z));
  group.add(box(2 * HALF_W, CEILING - WINDOW.y1, T, veneer, 0, (CEILING + WINDOW.y1) / 2, z));
  const sideW = HALF_W + WINDOW.x0;
  group.add(box(sideW, WINDOW.y1 - WINDOW.y0, T, veneer, -HALF_W + sideW / 2, (WINDOW.y0 + WINDOW.y1) / 2, z));
  group.add(box(sideW, WINDOW.y1 - WINDOW.y0, T, veneer, HALF_W - sideW / 2, (WINDOW.y0 + WINDOW.y1) / 2, z));
  // The window frame: a rounded aluminium surround filling the opening's corners.
  const outer = roundedRect(WINDOW.x0 - 0.05, WINDOW.y0 - 0.05, WINDOW.x1 + 0.05, WINDOW.y1 + 0.05, WINDOW.r + 0.05);
  outer.holes.push(roundedRect(WINDOW.x0, WINDOW.y0, WINDOW.x1, WINDOW.y1, WINDOW.r));
  const frameGeo = new THREE.ExtrudeGeometry(outer, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2, curveSegments: 10 });
  const frame = new THREE.Mesh(frameGeo, metal);
  frame.position.z = WALL - 0.02;
  frame.castShadow = frame.receiveShadow = true;
  group.add(frame);
  // The corners of the opening behind the rounded frame, so nothing shows through them.
  const fill = new THREE.Shape();
  fill.moveTo(WINDOW.x0 - 0.06, WINDOW.y0 - 0.06);
  fill.lineTo(WINDOW.x1 + 0.06, WINDOW.y0 - 0.06);
  fill.lineTo(WINDOW.x1 + 0.06, WINDOW.y1 + 0.06);
  fill.lineTo(WINDOW.x0 - 0.06, WINDOW.y1 + 0.06);
  fill.holes.push(roundedRect(WINDOW.x0, WINDOW.y0, WINDOW.x1, WINDOW.y1, WINDOW.r));
  const corners = new THREE.Mesh(new THREE.ShapeGeometry(fill, 10), new THREE.MeshStandardMaterial({ color: 0x1a1612, roughness: 1 }));
  corners.position.z = WALL - 0.025;
  group.add(corners);

  // Side walls, ceiling, floor.
  const depth = BACK - WALL;
  group.add(box(T, CEILING, depth, veneer, -HALF_W - T / 2, CEILING / 2, (WALL + BACK) / 2));
  group.add(box(T, CEILING, depth, veneer, HALF_W + T / 2, CEILING / 2, (WALL + BACK) / 2));
  group.add(box(2 * HALF_W + 2 * T, T, depth, cream, 0, CEILING + T / 2, (WALL + BACK) / 2));
  group.add(box(2 * HALF_W, T, depth, carpet, 0, -T / 2, (WALL + BACK) / 2, 1.5));

  // The fold-down table under the window, on a bracket.
  group.add(box(TABLE.x1 - TABLE.x0, 0.03, TABLE.depth, veneer, (TABLE.x0 + TABLE.x1) / 2, TABLE.y - 0.015, WALL + TABLE.depth / 2, 2));
  group.add(box(0.04, 0.3, 0.3, metal, 0, TABLE.y - 0.18, WALL + 0.16));

  // The table lamp: brass base and stem, a pleated cream shade that glows.
  const lamp = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.025, 32), brass);
  base.position.y = 0.0125;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.2, 12), brass);
  stem.position.y = 0.12;
  const shadeMat = new THREE.MeshStandardMaterial({ color: 0xe8d8b8, emissive: new THREE.Color(0xffb070), emissiveIntensity: 0.55, roughness: 1, side: THREE.DoubleSide });
  const shadeGeo = new THREE.CylinderGeometry(0.05, 0.085, 0.11, 36, 1, true);
  const sp = shadeGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < sp.count; i++) {
    const a = Math.atan2(sp.getZ(i), sp.getX(i));
    const k = 1 + 0.04 * Math.cos(a * 18);
    sp.setXYZ(i, sp.getX(i) * k, sp.getY(i), sp.getZ(i) * k);
  }
  shadeGeo.computeVertexNormals();
  const shade = new THREE.Mesh(shadeGeo, shadeMat);
  shade.position.y = 0.25;
  lamp.add(base, stem, shade);
  for (const m of [base, stem]) m.castShadow = true;
  lamp.position.set(LAMP.x, LAMP.y, LAMP.z);
  group.add(lamp);
  const lampAt = new THREE.Vector3(LAMP.x, LAMP.y + 0.24, LAMP.z);

  // A cup and saucer on the table.
  const cupGeo = new THREE.LatheGeometry(
    [
      [0, 0],
      [0.028, 0],
      [0.032, 0.01],
      [0.038, 0.06],
      [0.036, 0.062],
      [0.033, 0.012],
      [0, 0.012],
    ].map(([x, y]) => new THREE.Vector2(x, y)),
    32,
  );
  const porcelain = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.25 });
  const cup = new THREE.Mesh(cupGeo, porcelain);
  cup.position.set(0.18, TABLE.y + 0.006, WALL + 0.24);
  const saucer = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.008, 32), porcelain);
  saucer.position.set(0.18, TABLE.y + 0.004, WALL + 0.24);
  for (const m of [cup, saucer]) m.castShadow = m.receiveShadow = true;
  group.add(cup, saucer);

  // The left berth: a velour mattress on a panelled base, with pillows against the window end.
  const bw = BERTH.x1 - BERTH.x0;
  group.add(box(bw, BERTH.top - 0.12, depth - 0.1, veneer, BERTH.x0 + bw / 2, (BERTH.top - 0.12) / 2, (WALL + BACK) / 2));
  group.add(box(bw, 0.13, depth - 0.12, velour, BERTH.x0 + bw / 2, BERTH.top - 0.06, (WALL + BACK) / 2, 2));
  const pillows = model('throw_pillows_01');
  pillows.scale.setScalar(0.62);
  pillows.position.set(BERTH.x0 + bw * 0.45, BERTH.top, WALL + 0.32);
  pillows.rotation.y = Math.PI * 0.5;
  group.add(pillows);

  // Curtains either side of the window, hanging from a rail; the blind's hem showing at the top.
  const curtains: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const c = curtain(0.34, 1.05, curtainCloth);
    c.position.set(side * (WINDOW.x1 + 0.07), WINDOW.y1 + 0.1, WALL + 0.07);
    group.add(c);
    curtains.push(c);
  }
  group.add(box(WINDOW.x1 - WINDOW.x0 + 0.9, 0.02, 0.02, metal, 0, WINDOW.y1 + 0.1, WALL + 0.07));
  const blind = box(WINDOW.x1 - WINDOW.x0 + 0.04, 0.07, 0.012, cream, 0, WINDOW.y1 - 0.02, WALL + 0.035);
  group.add(blind);
  group.add(box(WINDOW.x1 - WINDOW.x0 + 0.04, 0.012, 0.03, metal, 0, WINDOW.y1 - 0.06, WALL + 0.04));

  // Luggage rack over the right side, and a suitcase on it.
  const rackZ = (WALL + BACK) / 2 + 0.3;
  for (const dz of [-0.2, 0, 0.2]) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.6, 10), metal);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(HALF_W - 0.3, CEILING - 0.42, rackZ + dz);
    group.add(bar);
  }
  const suitcase = model('vintage_suitcase');
  suitcase.position.set(HALF_W - 0.32, CEILING - 0.41, rackZ);
  suitcase.rotation.y = Math.PI / 2;
  group.add(suitcase);

  return { group, shade: shadeMat, lampAt, curtains };
}
