/**
 * Day Train's settlements as buildings (settlements.ts says where): farmsteads, villages round a
 * church, walled towns on their hilltops with a castle at the top, lone castles, and cities on far
 * ridges, all from the building kit (buildings.ts), each its own mesh, laid out once from its seed.
 * A settlement is shown while it is within reach of the window.
 */
import { THREE } from '../three-layer';
import { ringPos } from '../night-train/track';
import { CONES, FLAGS, Kit, MAT, PLASTER, SLATE, STONE, THATCH, TILE, WOOD, buildingMaterial } from './buildings';
import { FAR_RANGE, type WorldUniforms } from './world';
import { ringDelta, type Settlement } from './settlements';

type V3 = [number, number, number];

/** A small repeatable random stream (mulberry32) for laying out a settlement from its seed. */
function stream(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    chance: (p: number) => next() < p,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length) % arr.length],
  };
}
type R = ReturnType<typeof stream>;

const shade = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];

/** A cottage (or a town house: taller, narrower), its front towards -z. */
function cottage(k: Kit, r: R, o: { town?: boolean; far?: boolean } = {}) {
  const w = o.town ? r.range(5.5, 8) : r.range(6.5, 10);
  const dp = o.town ? r.range(6, 8) : r.range(5, 6.5);
  const storeys = o.town ? (r.chance(0.5) ? 3 : 2) : r.chance(0.4) ? 2 : 1;
  const h = storeys === 1 ? 2.9 : storeys === 2 ? 5.3 : 7.7;
  const roofKind = o.town ? r.pick(['slate', 'tile', 'tile', 'tile'] as const) : r.pick(['thatch', 'thatch', 'thatch', 'tile', 'tile', 'slate'] as const);
  const roofMat = roofKind === 'thatch' ? MAT.thatch : roofKind === 'slate' ? MAT.slate : MAT.tile;
  const roof = shade(roofKind === 'thatch' ? THATCH : roofKind === 'slate' ? SLATE : TILE, r.range(0.85, 1.12));
  const wallKind = r.pick(['timber', 'timber', 'stone', 'plaster'] as const);
  const wallMat = wallKind === 'timber' ? MAT.timber : wallKind === 'stone' ? MAT.stone : MAT.plain;
  const wall = shade(wallKind === 'stone' ? r.pick(STONE) : r.pick(PLASTER), r.range(0.92, 1.05));
  const rh = (roofKind === 'thatch' ? 1.2 : 1) * r.range(0.55, 0.75) * dp;
  k.house(0, 0, w, dp, h, rh, wall, wallMat, roof, roofMat, roofKind === 'thatch' ? 0.65 : 0.4);
  if (o.far) return;
  // Windows along the front and back on each storey, a door in the front; one in each gable end.
  const n = Math.max(1, Math.floor(w / 2.3));
  const door = r.next() * n;
  for (let s = 0; s < storeys; s++) {
    const y0 = 1.0 + s * 2.4;
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + ((i + 0.5) * w) / n;
      if (s === 0 && Math.floor(door) === i) k.opening(x - 0.5, 0, x + 0.5, 2.05, -dp / 2, -1, MAT.wood, r.pick(WOOD));
      else k.opening(x - 0.4, y0, x + 0.4, y0 + 0.95, -dp / 2, -1);
      k.opening(x - 0.4, y0, x + 0.4, y0 + 0.95, dp / 2, 1);
    }
    k.openingX(-0.4, y0, 0.4, y0 + 0.9, -w / 2, -1);
    k.openingX(-0.4, y0, 0.4, y0 + 0.9, w / 2, 1);
  }
  if (r.chance(0.6)) {
    const cx = r.pick([-1, 1]) * w * 0.3;
    k.box(cx - 0.4, h + rh * 0.3, 0.2, cx + 0.4, h + rh + 1.1, 1.0, shade(r.pick(STONE), 0.85), MAT.stone);
  }
}

function barn(k: Kit, r: R) {
  const w = r.range(11, 15);
  const dp = r.range(7, 9);
  const wood = r.pick(WOOD);
  k.house(0, 0, w, dp, r.range(4, 5), dp * 0.55, wood, MAT.wood, shade(r.pick([SLATE, TILE, THATCH]), r.range(0.8, 1)), r.pick([MAT.slate, MAT.tile, MAT.thatch]), 0.4);
  k.opening(-1.6, 0, 1.6, 3.4, -dp / 2, -1, MAT.wood, shade(wood, 0.7));
}

function church(k: Kit, r: R, scale = 1) {
  const stone = r.pick(STONE);
  const w = 18 * scale;
  const dp = 8 * scale;
  const h = 7 * scale;
  k.house(0, 0, w, dp, h, 5.5 * scale, stone, MAT.stone, r.chance(0.6) ? SLATE : TILE, r.chance(0.6) ? MAT.slate : MAT.tile, 0.5);
  for (let i = 0; i < 4; i++) {
    const x = -w / 2 + ((i + 0.8) * w) / 5;
    k.opening(x - 0.55, 2, x + 0.55, 5.2 * scale, -dp / 2, -1);
    k.opening(x - 0.55, 2, x + 0.55, 5.2 * scale, dp / 2, 1);
  }
  // The tower at the west end, belfry openings near its top, a tall spire.
  const tx = -w / 2 - 2.6 * scale;
  const th = r.range(16, 21) * scale;
  const s = 2.6 * scale;
  k.box(tx - s, -3, -s, tx + s, th, s, stone, MAT.stone);
  k.opening(tx - 0.6, th - 3.2, tx + 0.6, th - 1, -s, -1, MAT.window, [0.05, 0.05, 0.05]);
  k.openingX(-0.6, th - 3.2, 0.6, th - 1, tx - s, -1, MAT.window, [0.05, 0.05, 0.05]);
  k.openingX(-0.6, th - 3.2, 0.6, th - 1, tx + s, 1, MAT.window, [0.05, 0.05, 0.05]);
  k.cone(tx, 0, s * 1.35, th, r.range(10, 15) * scale, 4, r.chance(0.3) ? CONES[3] : SLATE, MAT.cone);
}

/** A windmill facing the line (its sails turn in the plane of the line). */
function windmill(k: Kit, r: R) {
  const body = r.chance(0.6) ? r.pick(PLASTER) : r.pick(STONE);
  k.drum(0, 0, 3.1, 2.1, -3, 11, 8, body, r.chance(0.6) ? MAT.plain : MAT.stone);
  k.cone(0, 0, 2.6, 11, 2.8, 8, r.chance(0.5) ? THATCH : shade(WOOD[0], 0.9), r.chance(0.5) ? MAT.thatch : MAT.wood);
  k.opening(-0.5, 0, 0.5, 2.0, -2.95, -1, MAT.wood, WOOD[0]);
  k.opening(-0.35, 5.5, 0.35, 6.4, -2.6, -1);
  const hub: V3 = [0, 10.2, -2.7];
  k.animate(1, hub);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Along the stock from 0.8 m to 9.5 m, the lattice on one side of it.
    const P = (u: number, v: number): V3 => [hub[0] + ca * u - sa * v, hub[1] + sa * u + ca * v, hub[2] - 0.15];
    k.quad(P(0.8, -0.1), P(9.5, -0.1), P(9.5, 1.8), P(0.8, 1.8), [0.3, 0.22, 0.15], MAT.sail);
    k.quad(P(0, -0.12), P(9.6, -0.12), P(9.6, 0.12), P(0, 0.12), [0.3, 0.22, 0.15], MAT.plain);
  }
  k.animate(0);
  k.box(-0.3, 9.9, -2.9, 0.3, 10.5, -2.3, [0.25, 0.2, 0.15], MAT.plain);
}

function bale(k: Kit) {
  k.drum(0, 0, 0.75, 0.75, -0.2, 1.2, 10, [0.72, 0.6, 0.3], MAT.thatch);
  k.cone(0, 0, 0.75, 1.2, 0.12, 10, [0.72, 0.6, 0.3], MAT.thatch);
}

/** A round tower with a pointed roof (and maybe a pennant). */
function tower(k: Kit, r: R, rad: number, h: number, roof: V3, stone: V3, pennant = 0.5) {
  k.drum(0, 0, rad, rad, -3, h, 12, stone, MAT.stone);
  const ch = rad * r.range(2.2, 3.2);
  k.cone(0, 0, rad * 1.18, h, ch, 12, roof, MAT.cone);
  k.opening(-0.25, h * 0.5, 0.25, h * 0.5 + 1.2, -rad * 0.985, -1, MAT.window, [0.05, 0.05, 0.05]);
  k.opening(-0.25, h * 0.78, 0.25, h * 0.78 + 1.0, -rad * 0.985, -1, MAT.window, [0.05, 0.05, 0.05]);
  if (r.chance(pennant)) k.pennant(0, 0, h + ch - 0.4, 3.5, r.pick(FLAGS));
}

/** A curtain wall from (0, 0) along +x for len metres, merlons along its top. */
function wallRun(k: Kit, len: number, h: number, thick: number, stone: V3) {
  k.box(0, -3, -thick / 2, len, h, thick / 2, stone, MAT.stone);
  for (let x = 0.4; x < len - 0.6; x += 1.7) k.box(x, h, -thick / 2, x + 0.85, h + 0.9, -thick / 2 + 0.6, stone, MAT.stone);
}

/** A keep with corner turrets, at the current base. */
function keep(k: Kit, r: R, size: number, roof: V3, stone: V3) {
  const s = size / 2;
  const h = size * 1.7;
  k.box(-s, -3, -s, s, h, s, stone, MAT.stone);
  k.cone(0, 0, s * 1.45, h, size * 0.7, 4, SLATE, MAT.slate);
  for (const [x, z] of [[-s, -s], [s, -s], [-s, s], [s, s]] as const) {
    k.drum(x, z, size * 0.16, size * 0.16, h * 0.6, h + 3, 10, stone, MAT.stone);
    k.cone(x, z, size * 0.2, h + 3, size * 0.55, 10, roof, MAT.cone);
  }
  for (let i = 0; i < 3; i++) k.opening(-s + size * (0.25 + i * 0.25) - 0.35, h * 0.55, -s + size * (0.25 + i * 0.25) + 0.35, h * 0.55 + 1.6, -s, -1);
  k.pennant(0, 0, h + size * 0.7 - 0.5, 4, r.pick(FLAGS));
}

/**
 * A walled ring of radius R round (s, d): n towers at the corners, walls between, a gatehouse
 * facing the line. Parts at their own base points (so each sits on the ground under it).
 */
function ringWall(k: Kit, r: R, s: number, d: number, R: number, n: number, h: number, roof: V3, stone: V3, D: number) {
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + Math.PI / 2 + r.range(-0.1, 0.1);
    const rr = R * r.range(0.92, 1.05);
    return [Math.cos(a) * rr, Math.sin(a) * rr] as const;
  });
  for (let i = 0; i < n; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % n];
    const len = Math.hypot(bx - ax, bz - az);
    // The wall's own frame: its start, turned to run towards the next tower.
    k.at(ringPos(s + ax, D), d + az, Math.atan2(bz - az, bx - ax));
    wallRun(k, len, h, 2.4, stone);
    k.at(ringPos(s + ax, D), d + az, 0);
    tower(k, r, r.range(3, 4), h + r.range(3, 6), roof, stone, 0.35);
  }
}

/** A country station house: half-timbered over stone, a canopy on posts along the platform. */
function stationHouse(k: Kit, r: R) {
  const w = r.range(16, 22);
  const dp = 7;
  const roof = r.chance(0.5) ? TILE : SLATE;
  k.house(0, 0, w, dp, 5.2, 3.6, r.pick(PLASTER), MAT.timber, roof, roof === TILE ? MAT.tile : MAT.slate, 0.5);
  for (let i = 0; i < 6; i++) {
    const x = -w / 2 + ((i + 0.5) * w) / 6;
    if (i === 2) k.opening(x - 0.7, 0, x + 0.7, 2.4, -dp / 2, -1, MAT.wood, WOOD[1]);
    else k.opening(x - 0.5, 0.9, x + 0.5, 2.3, -dp / 2, -1);
    k.opening(x - 0.4, 3.2, x + 0.4, 4.2, -dp / 2, -1);
  }
  // The canopy over the platform, on slender posts.
  const cz = -dp / 2 - 3.2;
  k.box(-w / 2 - 2, 3.4, cz - 0.2, w / 2 + 2, 3.55, -dp / 2, [0.3, 0.42, 0.34], MAT.plain);
  for (let x = -w / 2; x <= w / 2 + 0.1; x += w / 4) k.box(x - 0.08, -1, cz - 0.08, x + 0.08, 3.4, cz + 0.08, [0.2, 0.3, 0.24], MAT.plain);
  k.box(-0.5, 4.6, -dp / 2 - 0.1, 0.5, 5.4, -dp / 2, [0.9, 0.88, 0.82], MAT.plain);
}

/** Lays out one settlement into the kit. */
function layout(k: Kit, w: Settlement, D: number) {
  const r = stream(w.seed);
  const place = (a: number, o: number, yaw: number) => k.at(ringPos(w.s + a, D), w.out + o, yaw);
  const stone = r.pick(STONE);
  const roofCol = r.pick(CONES);
  // Houses scattered in a disc, kept apart.
  const scatter = (count: number, R: number, gap: number, clear: number, make: () => void, facing?: () => number) => {
    const taken: [number, number][] = [];
    for (let i = 0, tries = 0; i < count && tries < count * 12; tries++) {
      const a = r.range(0, Math.PI * 2);
      const rr = R * Math.sqrt(r.next());
      if (rr < clear) continue;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      if (taken.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < gap)) continue;
      taken.push([x, z]);
      place(x, z, facing ? facing() : r.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]) + r.range(-0.25, 0.25));
      make();
      i++;
    }
  };
  if (w.kind === 'station') {
    place(0, 0, 0);
    stationHouse(k, r);
  } else if (w.kind === 'farm') {
    place(0, 0, r.range(-0.3, 0.3));
    cottage(k, r);
    place(r.range(12, 18) * r.pick([-1, 1]), r.range(4, 10), r.range(-0.3, 0.3) + Math.PI / 2);
    barn(k, r);
    for (let i = 0, n = r.range(2, 6); i < n; i++) {
      place(r.range(-30, 30), r.range(15, 35), 0);
      bale(k);
    }
    if (r.chance(0.25)) {
      place(r.range(-40, 40), r.range(30, 50), 0);
      windmill(k, r);
    }
  } else if (w.kind === 'village') {
    if (r.chance(0.75)) {
      place(r.range(-10, 10), r.range(0, 15), r.range(-0.2, 0.2));
      church(k, r, r.range(0.85, 1.05));
    }
    scatter(Math.round(r.range(10, 24)), 80, 13, 16, () => cottage(k, r));
    for (let i = 0, n = r.range(1, 3); i < n; i++) {
      place(r.range(-90, 90), r.range(40, 90), r.range(-0.3, 0.3));
      barn(k, r);
    }
    if (r.chance(0.4)) {
      place(r.range(40, 120) * r.pick([-1, 1]), r.range(50, 110), 0);
      windmill(k, r);
    }
  } else if (w.kind === 'town') {
    // On its hilltop: a ring of walls and towers, houses packed inside, two spires, a castle at the top.
    const R = w.radius * 0.33;
    ringWall(k, r, w.s, w.out, R, Math.round(r.range(9, 13)), r.range(7, 9), roofCol, stone, D);
    scatter(Math.round(r.range(70, 130)), R - 7, 8.5, 14, () => cottage(k, r, { town: true }));
    place(r.range(-R * 0.4, R * 0.4), r.range(-R * 0.4, 0), r.range(-0.2, 0.2));
    church(k, r, 1.2);
    place(r.range(-R * 0.5, R * 0.5), r.range(-R * 0.2, R * 0.3), r.range(-0.2, 0.2));
    church(k, r, 0.9);
    place(0, R * 0.45, 0);
    keep(k, r, r.range(12, 15), roofCol, stone);
  } else if (w.kind === 'castle') {
    const R = r.range(24, 34);
    ringWall(k, r, w.s, w.out, R, Math.round(r.range(5, 7)), r.range(9, 12), roofCol, stone, D);
    place(0, R * 0.15, 0);
    keep(k, r, r.range(13, 17), roofCol, stone);
    for (let i = 0; i < 3; i++) {
      place(r.range(-R * 0.6, R * 0.6), r.range(-R * 0.5, R * 0.5), 0);
      tower(k, r, r.range(2.2, 3.2), r.range(18, 26), roofCol, stone, 0.7);
    }
  } else {
    // A city: a skyline of tall houses within its walls, many spires, a cathedral, a palace.
    const R = w.radius * 0.33;
    ringWall(k, r, w.s, w.out, R, Math.round(r.range(14, 18)), 12, roofCol, stone, D);
    scatter(Math.round(r.range(260, 380)), R - 8, 10, 0, () => cottage(k, r, { town: true, far: true }));
    for (let i = 0; i < 16; i++) {
      place(r.range(-R * 0.85, R * 0.85), r.range(-R * 0.8, R * 0.8), 0);
      tower(k, r, r.range(3.5, 6), r.range(30, 55), r.pick(CONES), stone, 0.4);
    }
    place(r.range(-R * 0.3, R * 0.3), r.range(-R * 0.3, 0), 0);
    church(k, r, 2.8);
    // The palace on the summit: a great keep among slender towers.
    place(0, R * 0.5, 0);
    keep(k, r, 34, roofCol, stone);
    for (let i = 0; i < 5; i++) {
      place(r.range(-40, 40), R * 0.5 + r.range(-35, 35), 0);
      tower(k, r, r.range(3, 4.5), r.range(55, 80), roofCol, stone, 0.8);
    }
  }
}

export function buildTowns(U: WorldUniforms, towns: Settlement[], D: number) {
  const group = new THREE.Group();
  const anim = { uSail: { value: 0 }, uFlag: { value: 0 } };
  const mat = buildingMaterial(U, anim);
  const meshes = towns.map((w) => {
    const k = new Kit();
    layout(k, w, D);
    const mesh = new THREE.Mesh(k.build(), mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    group.add(mesh);
    return { w, mesh };
  });
  return {
    group,
    /** dist: distance travelled (m); sail, flag: phases (whole cycles per loop). */
    update(dist: number, sail: number, flag: number) {
      const here = ringPos(dist, D);
      for (const { w, mesh } of meshes) mesh.visible = Math.abs(ringDelta(here, w.s, D)) < FAR_RANGE + w.radius;
      anim.uSail.value = sail;
      anim.uFlag.value = flag;
    },
  };
}
