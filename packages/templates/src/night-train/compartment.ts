/**
 * The sleeper compartment (static), in the old style of the great night trains: walnut panelling
 * with moulded frames and a pale inlay line, brass fittings, a wood-framed window with a brass bead
 * and latch, burgundy velour berths and curtains with tie-backs under a pelmet, brass wall sconces
 * with frosted tulip glasses, a fringed silk table lamp, china and a book on the table, a luggage
 * rack with a suitcase, a gilt-framed painting. Built once; the curtains sway and the lamps glow.
 */
import { THREE, canvasTexture } from '../three-layer';
import { model, textureMaterial } from '../ambient/assets';
import { box, curtain, frame, panel, roundedRect } from '../ambient/interior';
import { BACK, BERTH, CEILING, HALF_W, LAMP, TABLE, WALL, WINDOW } from './layout';

/** An oil painting of a lake below mountains at dusk (no filters: plain fills and gradients). */
function paintingTexture() {
  return canvasTexture(512, 360, (g) => {
    const sky = g.createLinearGradient(0, 0, 0, 220);
    sky.addColorStop(0, '#2c3a58');
    sky.addColorStop(0.6, '#a86a4a');
    sky.addColorStop(1, '#e0a86a');
    g.fillStyle = sky;
    g.fillRect(0, 0, 512, 360);
    g.fillStyle = '#4a4a5e';
    g.beginPath();
    g.moveTo(0, 220);
    [[60, 150], [130, 190], [210, 110], [300, 180], [370, 130], [450, 185], [512, 160], [512, 230], [0, 230]].forEach(([x, y]) => g.lineTo(x, y));
    g.fill();
    g.fillStyle = '#2e3440';
    g.beginPath();
    g.moveTo(0, 240);
    [[90, 205], [170, 235], [260, 210], [360, 238], [440, 215], [512, 232], [512, 260], [0, 260]].forEach(([x, y]) => g.lineTo(x, y));
    g.fill();
    const lake = g.createLinearGradient(0, 255, 0, 360);
    lake.addColorStop(0, '#c08860');
    lake.addColorStop(1, '#2a3048');
    g.fillStyle = lake;
    g.fillRect(0, 255, 512, 105);
    g.fillStyle = 'rgba(240, 200, 140, 0.35)';
    for (let i = 0; i < 9; i++) g.fillRect(200 + Math.sin(i) * 20, 262 + i * 9, 90 - i * 7, 2);
    // Varnish: a warm tint and the canvas weave.
    g.fillStyle = 'rgba(120, 80, 20, 0.12)';
    g.fillRect(0, 0, 512, 360);
  });
}

export interface Compartment {
  group: THREE.Group;
  /** The table lamp's shade (its glow is set each frame) and where its light comes from. */
  shade: THREE.MeshStandardMaterial;
  lampAt: THREE.Vector3;
  /** The wall sconces' glass and light positions. */
  sconceGlass: THREE.MeshStandardMaterial;
  sconces: THREE.Vector3[];
  curtains: THREE.Mesh[];
}

/** How the room is furnished: the sleeper's berth (Night Train) or a day coach's bench seat. */
export interface CompartmentStyle {
  /** Upholstery and curtain colours. */
  cloth?: number;
  curtain?: number;
  seat?: 'berth' | 'bench';
}

export function buildCompartment(style: CompartmentStyle = {}): Compartment {
  const group = new THREE.Group();
  const walnut = textureMaterial('black_walnut_veneer_01', [1, 1], { metalness: 0, roughness: 0.55, color: 0x9a6a48 });
  const mould = textureMaterial('black_walnut_veneer_01', [3, 3], { metalness: 0, roughness: 0.5, color: 0x5a3a26 });
  const inlay = new THREE.MeshStandardMaterial({ color: 0xc8a878, roughness: 0.6 });
  const velour = textureMaterial('velour_velvet', [3, 3], { metalness: 0, color: style.cloth ?? 0x5a1a22 });
  const curtainCloth = textureMaterial('velour_velvet', [4, 4], { metalness: 0, color: style.curtain ?? 0x6a1e22, side: THREE.DoubleSide });
  const carpet = textureMaterial('dirty_carpet', [2, 2], { metalness: 0, color: 0x6a3a34 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08440, metalness: 0.75, roughness: 0.32 });
  const cream = new THREE.MeshStandardMaterial({ color: 0xd8c8a4, roughness: 0.85 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xc09048, metalness: 0.8, roughness: 0.4 });

  // ---- the outer wall, with the window ----
  const T = 0.08;
  const z = WALL + T / 2;
  group.add(box(2 * HALF_W, WINDOW.y0, T, walnut, 0, WINDOW.y0 / 2, z));
  group.add(box(2 * HALF_W, CEILING - WINDOW.y1, T, walnut, 0, (CEILING + WINDOW.y1) / 2, z));
  const sideW = HALF_W + WINDOW.x0;
  group.add(box(sideW, WINDOW.y1 - WINDOW.y0, T, walnut, -HALF_W + sideW / 2, (WINDOW.y0 + WINDOW.y1) / 2, z));
  group.add(box(sideW, WINDOW.y1 - WINDOW.y0, T, walnut, HALF_W - sideW / 2, (WINDOW.y0 + WINDOW.y1) / 2, z));
  // A broad walnut frame round the glass, a brass bead inside it, a sill and a latch.
  const wf = roundedRect(WINDOW.x0 - 0.09, WINDOW.y0 - 0.06, WINDOW.x1 + 0.09, WINDOW.y1 + 0.07, 0.03);
  wf.holes.push(roundedRect(WINDOW.x0, WINDOW.y0, WINDOW.x1, WINDOW.y1, WINDOW.r));
  const wfm = new THREE.Mesh(new THREE.ExtrudeGeometry(wf, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 2, curveSegments: 8 }), mould);
  wfm.position.z = WALL - 0.01;
  wfm.castShadow = wfm.receiveShadow = true;
  group.add(wfm);
  const bead = roundedRect(WINDOW.x0 - 0.012, WINDOW.y0 - 0.012, WINDOW.x1 + 0.012, WINDOW.y1 + 0.012, WINDOW.r + 0.01);
  bead.holes.push(roundedRect(WINDOW.x0, WINDOW.y0, WINDOW.x1, WINDOW.y1, WINDOW.r));
  const beadM = new THREE.Mesh(new THREE.ExtrudeGeometry(bead, { depth: 0.075, bevelEnabled: false, curveSegments: 8 }), brass);
  beadM.position.z = WALL - 0.008;
  group.add(beadM);
  group.add(box(WINDOW.x1 - WINDOW.x0 + 0.3, 0.035, 0.13, mould, 0, WINDOW.y0 - 0.075, WALL + 0.09));
  group.add(box(0.12, 0.025, 0.035, brass, 0, WINDOW.y0 + 0.012, WALL + 0.06));
  // Window-corner fillers behind the rounded opening.
  const fill = new THREE.Shape();
  fill.moveTo(WINDOW.x0 - 0.1, WINDOW.y0 - 0.1);
  fill.lineTo(WINDOW.x1 + 0.1, WINDOW.y0 - 0.1);
  fill.lineTo(WINDOW.x1 + 0.1, WINDOW.y1 + 0.1);
  fill.lineTo(WINDOW.x0 - 0.1, WINDOW.y1 + 0.1);
  fill.holes.push(roundedRect(WINDOW.x0, WINDOW.y0, WINDOW.x1, WINDOW.y1, WINDOW.r));
  const corners = new THREE.Mesh(new THREE.ShapeGeometry(fill, 8), new THREE.MeshStandardMaterial({ color: 0x1a120c, roughness: 1 }));
  corners.position.z = WALL - 0.015;
  group.add(corners);

  // Panelling below the window, either side of the table's bracket.
  panel(group, mould, inlay, -HALF_W + 0.08, 0.1, -0.08, WINDOW.y0 - 0.14, WALL + T);
  panel(group, mould, inlay, 0.08, 0.1, HALF_W - 0.08, WINDOW.y0 - 0.14, WALL + T);
  // A dado rail along the walls at the sill's height.
  group.add(box(2 * HALF_W, 0.03, 0.03, mould, 0, WINDOW.y0 - 0.11, WALL + T + 0.015));

  // ---- side walls (panelled), ceiling, floor ----
  const depth = BACK - WALL;
  const side = (sx: number) => {
    const wall = box(T, CEILING, depth, walnut, sx * (HALF_W + T / 2), CEILING / 2, (WALL + BACK) / 2);
    group.add(wall);
    // Two tall panels on each side wall, facing into the room. Turned to face +x (left wall) the
    // panels' x runs along -z; turned to face -x (right wall) it runs along +z.
    const pg = new THREE.Group();
    const k = sx < 0 ? -1 : 1;
    const spans: [number, number][] = [
      [WALL + 0.12, (WALL + BACK) / 2 - 0.05],
      [(WALL + BACK) / 2 + 0.05, BACK - 0.12],
    ];
    for (const [z0, z1] of spans) panel(pg, mould, inlay, Math.min(k * z0, k * z1), 0.62, Math.max(k * z0, k * z1), CEILING - 0.35, 0);
    pg.rotation.y = sx < 0 ? Math.PI / 2 : -Math.PI / 2;
    pg.position.x = sx * HALF_W;
    group.add(pg);
  };
  side(-1);
  side(1);
  // A cream ceiling with walnut ribs and a domed brass light (off).
  group.add(box(2 * HALF_W + 2 * T, T, depth, cream, 0, CEILING + T / 2, (WALL + BACK) / 2));
  for (const rz of [WALL + 0.5, WALL + 1.45]) group.add(box(2 * HALF_W, 0.05, 0.07, mould, 0, CEILING - 0.025, rz));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.5, emissive: new THREE.Color(0xffd8a0), emissiveIntensity: 0.04 }));
  dome.position.set(0, CEILING, (WALL + BACK) / 2);
  group.add(dome);
  group.add(box(2 * HALF_W, T, depth, carpet, 0, -T / 2, (WALL + BACK) / 2, 1.5));

  // ---- the table: walnut with a brass edge, on brass brackets ----
  const tw = TABLE.x1 - TABLE.x0;
  group.add(box(tw, 0.03, TABLE.depth, walnut, 0, TABLE.y - 0.015, WALL + TABLE.depth / 2, 2));
  group.add(box(tw + 0.01, 0.012, 0.012, brass, 0, TABLE.y - 0.02, WALL + TABLE.depth + 0.004));
  for (const bx of [-0.35, 0.35]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.42, 8), brass);
    arm.position.set(bx, TABLE.y - 0.17, WALL + 0.15);
    arm.rotation.x = -0.75;
    group.add(arm);
  }

  // ---- the table lamp: a brass column and a pleated amber silk shade with a gold fringe ----
  const lamp = new THREE.Group();
  const lathe = (pts: number[][], mat: THREE.Material, seg = 32) => new THREE.Mesh(new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg), mat);
  const column = lathe(
    [
      [0, 0],
      [0.065, 0],
      [0.065, 0.012],
      [0.04, 0.03],
      [0.018, 0.05],
      [0.012, 0.09],
      [0.02, 0.1],
      [0.011, 0.11],
      [0.011, 0.2],
      [0.016, 0.21],
      [0, 0.215],
    ],
    brass,
  );
  column.castShadow = true;
  const shadeMat = new THREE.MeshStandardMaterial({ color: 0xc8823c, emissive: new THREE.Color(0xff9a40), emissiveIntensity: 0.3, roughness: 0.9, side: THREE.DoubleSide });
  const shadeGeo = new THREE.CylinderGeometry(0.055, 0.1, 0.12, 48, 1, true);
  const sp = shadeGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < sp.count; i++) {
    const a = Math.atan2(sp.getZ(i), sp.getX(i));
    const k = 1 + 0.045 * Math.abs(Math.sin(a * 12));
    sp.setXYZ(i, sp.getX(i) * k, sp.getY(i), sp.getZ(i) * k);
  }
  shadeGeo.computeVertexNormals();
  const shade = new THREE.Mesh(shadeGeo, shadeMat);
  shade.position.y = 0.25;
  // The fringe: short gold tassels round the shade's lower rim.
  const tassel = new THREE.CylinderGeometry(0.0025, 0.004, 0.03, 4);
  const fringe = new THREE.InstancedMesh(tassel, gold, 64);
  const tm = new THREE.Matrix4();
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    tm.makeTranslation(Math.cos(a) * 0.103, 0.175, Math.sin(a) * 0.103);
    fringe.setMatrixAt(i, tm);
  }
  lamp.add(column, shade, fringe);
  lamp.position.set(LAMP.x, LAMP.y, LAMP.z);
  group.add(lamp);
  const lampAt = new THREE.Vector3(LAMP.x, LAMP.y + 0.24, LAMP.z);

  // ---- on the table: a china teapot, a cup and saucer, a book ----
  const china = new THREE.MeshStandardMaterial({ color: 0xf0ece2, roughness: 0.2 });
  const cupGeo = new THREE.LatheGeometry(
    [
      [0, 0],
      [0.022, 0],
      [0.026, 0.008],
      [0.036, 0.05],
      [0.034, 0.052],
      [0.031, 0.01],
      [0, 0.01],
    ].map(([x, y]) => new THREE.Vector2(x, y)),
    32,
  );
  const cup = new THREE.Mesh(cupGeo, china);
  cup.position.set(0.22, TABLE.y + 0.007, WALL + 0.25);
  const saucer = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.045, 0.008, 32), china);
  saucer.position.set(0.22, TABLE.y + 0.004, WALL + 0.25);
  const pot = lathe(
    [
      [0, 0],
      [0.05, 0],
      [0.075, 0.04],
      [0.072, 0.09],
      [0.045, 0.12],
      [0.03, 0.125],
      [0.034, 0.135],
      [0.012, 0.15],
      [0.016, 0.16],
      [0, 0.165],
    ],
    china,
  );
  pot.position.set(0.02, TABLE.y, WALL + 0.17);
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.016, 0.1, 10), china);
  spout.position.set(0.1, TABLE.y + 0.08, WALL + 0.17);
  spout.rotation.z = -0.9;
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.007, 8, 20, Math.PI), china);
  handle.position.set(-0.07, TABLE.y + 0.075, WALL + 0.17);
  handle.rotation.z = Math.PI / 2;
  const book = box(0.15, 0.03, 0.21, new THREE.MeshStandardMaterial({ color: 0x3a1a14, roughness: 0.7 }), 0.42, TABLE.y + 0.015, WALL + 0.22);
  book.rotation.y = -0.25;
  const pages = box(0.142, 0.022, 0.2, new THREE.MeshStandardMaterial({ color: 0xd8c8a0, roughness: 0.9 }), 0.424, TABLE.y + 0.015, WALL + 0.22);
  pages.rotation.y = -0.25;
  for (const m of [cup, saucer, pot, spout, handle]) m.castShadow = m.receiveShadow = true;
  group.add(cup, saucer, pot, spout, handle, book, pages);

  if (style.seat === 'bench') {
    // ---- the left seat: a day coach's bench, buttoned back, padded headrests ----
    const bw = BERTH.x1 - BERTH.x0;
    const seatTop = 0.46;
    group.add(box(bw, seatTop - 0.12, depth - 0.1, walnut, BERTH.x0 + bw / 2, (seatTop - 0.12) / 2, (WALL + BACK) / 2));
    group.add(box(bw, 0.13, depth - 0.14, velour, BERTH.x0 + bw / 2, seatTop - 0.06, (WALL + BACK) / 2, 2));
    group.add(box(0.13, 0.72, depth - 0.18, velour, -HALF_W + 0.065, seatTop + 0.36, (WALL + BACK) / 2, 2));
    const button = new THREE.SphereGeometry(0.01, 8, 6);
    const buttons = new THREE.InstancedMesh(button, new THREE.MeshStandardMaterial({ color: 0x101820, roughness: 0.6 }), 24);
    for (let i = 0; i < 24; i++) {
      tm.makeTranslation(-HALF_W + 0.135, seatTop + 0.12 + (i % 3) * 0.16, WALL + 0.2 + Math.floor(i / 3) * 0.26);
      buttons.setMatrixAt(i, tm);
    }
    group.add(buttons);
    // Two padded headrests.
    for (const hz of [WALL + 0.45, WALL + 1.25]) group.add(box(0.12, 0.2, 0.55, velour, -HALF_W + 0.19, seatTop + 0.82, hz, 2));
    // An armrest at the window end, walnut-capped.
    group.add(box(bw - 0.06, 0.2, 0.09, velour, BERTH.x0 + bw / 2 + 0.03, seatTop + 0.1, WALL + 0.12, 2));
    group.add(box(bw - 0.04, 0.025, 0.11, walnut, BERTH.x0 + bw / 2 + 0.03, seatTop + 0.21, WALL + 0.12, 2));
    const brassEdge = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, depth - 0.14, 10), brass);
    brassEdge.rotation.x = Math.PI / 2;
    brassEdge.position.set(BERTH.x1 + 0.005, seatTop - 0.005, (WALL + BACK) / 2);
    group.add(brassEdge);
  } else {
    // ---- the left berth: a buttoned velour back, a mattress, pillows ----
    const bw = BERTH.x1 - BERTH.x0;
    group.add(box(bw, BERTH.top - 0.12, depth - 0.1, walnut, BERTH.x0 + bw / 2, (BERTH.top - 0.12) / 2, (WALL + BACK) / 2));
    group.add(box(bw, 0.13, depth - 0.12, velour, BERTH.x0 + bw / 2, BERTH.top - 0.06, (WALL + BACK) / 2, 2));
    group.add(box(0.1, 0.5, depth - 0.2, velour, -HALF_W + 0.05, BERTH.top + 0.25, (WALL + BACK) / 2, 2));
    const button = new THREE.SphereGeometry(0.01, 8, 6);
    const buttons = new THREE.InstancedMesh(button, new THREE.MeshStandardMaterial({ color: 0x3a0e12, roughness: 0.6 }), 24);
    for (let i = 0; i < 24; i++) {
      tm.makeTranslation(-HALF_W + 0.1, BERTH.top + 0.12 + (i % 3) * 0.14, WALL + 0.2 + Math.floor(i / 3) * 0.26);
      buttons.setMatrixAt(i, tm);
    }
    group.add(buttons);
    const brassEdge = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, depth - 0.12, 10), brass);
    brassEdge.rotation.x = Math.PI / 2;
    brassEdge.position.set(BERTH.x1 + 0.005, BERTH.top - 0.005, (WALL + BACK) / 2);
    group.add(brassEdge);
    const pillows = model('throw_pillows_01');
    pillows.scale.setScalar(0.55);
    pillows.position.set(BERTH.x0 + bw * 0.5, BERTH.top, WALL + 0.3);
    pillows.rotation.y = Math.PI * 0.5;
    // Muted to an old tapestry's colours.
    pillows.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m?.color) m.color.setHex(0x8a6a58);
    });
    group.add(pillows);
  }

  // ---- curtains with tie-backs under a velour pelmet with a brass trim ----
  const curtains: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const c = curtain(0.42, WINDOW.y1 - WINDOW.y0 + 0.32, curtainCloth, sx, 0.62);
    c.position.set(sx * (WINDOW.x1 + 0.09), WINDOW.y1 + 0.2, WALL + 0.1);
    group.add(c);
    curtains.push(c);
    const tie = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 8, 20), velour);
    tie.position.set(sx * (WINDOW.x1 + 0.2), WINDOW.y1 + 0.2 - (WINDOW.y1 - WINDOW.y0 + 0.32) * 0.62, WALL + 0.13);
    tie.rotation.x = Math.PI / 2;
    group.add(tie);
  }
  const pw = WINDOW.x1 - WINDOW.x0 + 0.9;
  group.add(box(pw, 0.2, 0.08, velour, 0, WINDOW.y1 + 0.2, WALL + 0.16, 2));
  group.add(box(pw + 0.01, 0.014, 0.012, brass, 0, WINDOW.y1 + 0.1, WALL + 0.205));
  // The blind's hem and its brass pull, just showing at the top of the glass.
  group.add(box(WINDOW.x1 - WINDOW.x0 - 0.06, 0.05, 0.012, cream, 0, WINDOW.y1 - 0.025, WALL + 0.03));
  const pull = new THREE.Mesh(new THREE.TorusGeometry(0.015, 0.004, 8, 16), brass);
  pull.position.set(0, WINDOW.y1 - 0.065, WALL + 0.04);
  group.add(pull);

  // ---- brass sconces with frosted tulip glasses, either side of the window ----
  const sconceGlass = new THREE.MeshStandardMaterial({ color: 0xf0e2c8, emissive: new THREE.Color(0xffc080), emissiveIntensity: 0.18, roughness: 0.4, transparent: true, opacity: 0.92 });
  const sconces: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    const x = sx * (WINDOW.x1 + 0.17);
    const y = WINDOW.y1 + 0.02;
    const plateM = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.012, 20), brass);
    plateM.rotation.x = Math.PI / 2;
    plateM.position.set(x, y, WALL + T + 0.006);
    const arm = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.006, 8, 16, Math.PI / 2), brass);
    arm.position.set(x, y - 0.06, WALL + T + 0.01);
    arm.rotation.y = -Math.PI / 2;
    const tulip = lathe(
      [
        [0.0, 0.0],
        [0.012, 0.0],
        [0.03, 0.03],
        [0.042, 0.075],
        [0.04, 0.085],
      ],
      sconceGlass,
      24,
    );
    tulip.position.set(x, y - 0.03, WALL + T + 0.07);
    group.add(plateM, arm, tulip);
    sconces.push(new THREE.Vector3(x, y + 0.02, WALL + T + 0.08));
  }

  // ---- luggage rack over the left berth (brass rails), with a suitcase; a coat hook ----
  const rackY = CEILING - 0.42;
  for (const dx of [0, 0.18, 0.34]) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, depth - 0.3, 10), brass);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(-HALF_W + 0.06 + dx, rackY, (WALL + BACK) / 2);
    group.add(bar);
  }
  for (const rz of [WALL + 0.25, BACK - 0.25]) {
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.012, 0.012), brass);
    bracket.position.set(-HALF_W + 0.2, rackY - 0.01, rz);
    group.add(bracket);
  }
  const suitcase = model('vintage_suitcase');
  suitcase.position.set(-HALF_W + 0.2, rackY + 0.01, WALL + 0.75);
  group.add(suitcase);
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.006, 8, 16, Math.PI * 1.3), brass);
  hook.position.set(HALF_W - 0.01, 1.62, WALL + 0.22);
  hook.rotation.y = Math.PI / 2;
  group.add(hook);

  // ---- a gilt-framed painting on the left wall, above the berth ----
  const paint = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.35), new THREE.MeshStandardMaterial({ map: paintingTexture(), roughness: 0.7 }));
  const pf = new THREE.Group();
  pf.add(paint);
  frame(pf, gold, -0.28, -0.205, 0.28, 0.205, 0.008, 0.05, 0.03);
  pf.position.set(-HALF_W + 0.01, 1.38, WALL + 1.0);
  pf.rotation.y = Math.PI / 2;
  group.add(pf);

  return { group, shade: shadeMat, lampAt, sconceGlass, sconces, curtains };
}
