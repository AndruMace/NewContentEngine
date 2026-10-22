/**
 * Where blows land, as the view draws them: a spot on a body part (from the sim's Aim: part, side and a
 * place within it) found on the part's rest geometry, followed as the part moves; the stylized wound
 * left there (claw rakes, bite punctures, sword cuts, gores, bruises, scorches), conformed to the
 * surface; and the strike itself, the attacker's jaws, brow, claws, hooves, fists or blade reaching
 * exactly that spot at the impact (the limb by IK, the head by leaning the body and the neck into it).
 */
import { THREE } from '../../three-layer';
import type { CreatureDef, MoveDef } from '../roster';
import type { Aim, Wound } from '../sim';
import type { LegName, PoseIn, ProcRig } from './rig';
import { hash, type V3 } from './builder';
import { LEAN, limbFor, limbReach, type StrikePart } from './anatomy';

export { limbFor, strikeParts, type StrikePart } from './anatomy';

const sat = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => {
  const t = sat(x);
  return t * t * (3 - 2 * t);
};

/** A spot on a part: its parent object, the point and outward normal in the parent's space, the hide colour there. */
export interface Spot {
  parent: THREE.Object3D;
  local: THREE.Vector3;
  normal: THREE.Vector3;
  color: THREE.Color;
  /** The part's geometry and the transform from the parent's space into it (to fit wounds to the surface). */
  geo: THREE.BufferGeometry;
  geoOffset: THREE.Vector3;
}

const raycaster = new THREE.Raycaster();
const hitMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const probes = new WeakMap<THREE.BufferGeometry, THREE.Mesh>();
function probe(geo: THREE.BufferGeometry) {
  let m = probes.get(geo);
  if (!m) {
    m = new THREE.Mesh(geo, hitMat);
    m.updateMatrixWorld(true);
    probes.set(geo, m);
  }
  return m;
}

/** First surface along a ray (in the geometry's own space). */
function cast(geo: THREE.BufferGeometry, from: THREE.Vector3, dir: THREE.Vector3, far = 6) {
  raycaster.set(from, dir);
  raycaster.far = far;
  const hit = raycaster.intersectObject(probe(geo), false)[0];
  if (!hit) return null;
  const col = geo.getAttribute('color');
  const color = col && hit.face ? new THREE.Color(col.getX(hit.face.a), col.getY(hit.face.a), col.getZ(hit.face.a)) : new THREE.Color(0.5, 0.4, 0.3);
  return { point: hit.point.clone(), color };
}

const SPINE = ['pelvis', 'spine', 'chest', 'neck1', 'neck2'] as const;

function bodySpot(rig: ProcRig, a: Aim): Spot | null {
  const spec = rig.spec;
  const pts = SPINE.map((n) => new THREE.Vector3(...spec.bones[n]));
  // Along the torso (rump to shoulders), then round it from the top (or the front, upright) to the side.
  const lens = pts.slice(1).map((p, i) => p.distanceTo(pts[i]));
  const total = lens.reduce((x, y) => x + y, 0);
  let d = (0.08 + 0.86 * a.u) * total;
  let i = 0;
  while (i < lens.length - 1 && d > lens[i]) d -= lens[i++];
  const axis = pts[i].clone().lerp(pts[i + 1], lens[i] ? d / lens[i] : 0);
  const along = pts[i + 1].clone().sub(pts[i]).normalize();
  const up = Math.abs(along.y) > 0.7 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const sideV = new THREE.Vector3(a.side, 0, 0);
  const phi = 0.35 + 1.05 * a.v;
  const out = up.multiplyScalar(Math.cos(phi)).addScaledVector(sideV, Math.sin(phi)).normalize();
  const geo = rig.bodyMesh.geometry;
  const hit = cast(geo, axis.clone().addScaledVector(out, 3), out.clone().negate());
  if (!hit) return null;
  // Rides the nearest bone (bones are unrotated at rest, so its space is the body's, shifted).
  const bones = (['pelvis', 'spine', 'chest', 'neck1', 'neck2'] as const).map((n) => ({ n, p: new THREE.Vector3(...spec.bones[n]) }));
  const near = bones.reduce((x, y) => (y.p.distanceTo(hit.point) < x.p.distanceTo(hit.point) ? y : x));
  const bone = rig.bones[near.n];
  return { parent: bone, local: hit.point.clone().sub(near.p), normal: out, color: hit.color, geo, geoOffset: near.p.clone() };
}

function headSpot(rig: ProcRig, a: Aim): Spot | null {
  const geo = rig.headMesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const y = bb.min.y + (bb.max.y - bb.min.y) * (0.3 + 0.35 * a.v);
  const z = bb.min.z + (bb.max.z - bb.min.z) * (0.2 + 0.5 * a.u);
  const out = new THREE.Vector3(a.side, 0.35, 0.15).normalize();
  const hit = cast(geo, new THREE.Vector3(0, y, z).addScaledVector(out, 3), out.clone().negate());
  if (!hit) return null;
  return { parent: rig.headMesh, local: hit.point, normal: out, color: hit.color, geo, geoOffset: new THREE.Vector3() };
}

function limbSpot(rig: ProcRig, a: Aim): Spot | null {
  const name = limbFor(rig.spec, a.zone as 'fore' | 'hind', a.side);
  const leg = name ? rig.limb(name) : undefined;
  if (!leg) return null;
  const seg = a.u < 0.55 ? leg.upper : leg.lower;
  const len = a.u < 0.55 ? leg.spec.lens[0] : leg.spec.lens[1];
  const geo = seg.geometry;
  const y = -len * (0.25 + 0.5 * a.v);
  const out = new THREE.Vector3(a.side, 0, 0.6).normalize();
  const hit = cast(geo, new THREE.Vector3(0, y, 0).addScaledVector(out, 2), out.clone().negate());
  if (!hit) return null;
  return { parent: seg, local: hit.point, normal: out, color: hit.color, geo, geoOffset: new THREE.Vector3() };
}

function wingSpot(rig: ProcRig, a: Aim): Spot | null {
  const w = rig.wings.find((x) => x.side === a.side) ?? rig.wings[0];
  if (!w) return null;
  const geo = w.mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const x = bb.min.x + (bb.max.x - bb.min.x) * (0.25 + 0.55 * a.u);
  const z = bb.max.z - (bb.max.z - bb.min.z) * (0.2 + 0.45 * a.v);
  const hit = cast(geo, new THREE.Vector3(x, 3, z), new THREE.Vector3(0, -1, 0));
  if (!hit) return null;
  return { parent: w.mesh, local: hit.point, normal: new THREE.Vector3(0, 1, 0), color: hit.color, geo, geoOffset: new THREE.Vector3() };
}

const spotCache = new WeakMap<ProcRig, Map<string, Spot | null>>();

/** The spot an aim names on this rig (worked out once, on the rest geometry; falls back to the body). */
export function spotOf(rig: ProcRig, a: Aim): Spot | null {
  let m = spotCache.get(rig);
  if (!m) spotCache.set(rig, (m = new Map()));
  const key = `${a.zone}|${a.side}|${a.u.toFixed(3)}|${a.v.toFixed(3)}`;
  if (m.has(key)) return m.get(key)!;
  let s: Spot | null = null;
  if (a.zone === 'head') s = headSpot(rig, a);
  else if (a.zone === 'fore' || a.zone === 'hind') s = limbSpot(rig, a);
  else if (a.zone === 'wing') s = wingSpot(rig, a);
  s ??= bodySpot(rig, { ...a, zone: 'body' }) ?? bodySpot(rig, { zone: 'body', side: a.side, u: 0.5, v: 0.5 });
  m.set(key, s);
  return s;
}

/** Where a spot is in the world now (and the way its surface faces). */
export function spotWorld(s: Spot, out = new THREE.Vector3(), normal?: THREE.Vector3) {
  s.parent.updateWorldMatrix(true, false);
  if (normal) normal.copy(s.normal).transformDirection(s.parent.matrixWorld);
  return s.parent.localToWorld(out.copy(s.local));
}

// ---- wounds ----------------------------------------------------------------------------------------

const BLOOD = new THREE.Color('#7c1018');
const BLOOD_DARK = new THREE.Color('#420a0e');
const CHAR = new THREE.Color('#221a16');
const EMBER = new THREE.Color('#4a2414');

export const woundMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.42, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });

/** A bruise: the hide darkened, a little red in it. */
const bruiseOf = (hide: THREE.Color) => new THREE.Color(hide.r * 0.5 + 0.1, hide.g * 0.38, hide.b * 0.42 + 0.02);

/**
 * The wound's mesh, round its spot, in the spot's parent space: flat shapes in the surface's tangent
 * plane, each point dropped onto the surface (so it wraps a curved body), a hair proud of it.
 */
export function woundMesh(s: Spot, w: Wound, def: CreatureDef): THREE.Mesh {
  const n = s.normal.clone().normalize();
  const seed = w.u * 97.1 + w.v * 31.7 + w.t;
  // The tangent frame, turned at random (claw rakes run every which way).
  const ref = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const t1 = new THREE.Vector3().crossVectors(ref, n).normalize();
  const t2 = new THREE.Vector3().crossVectors(n, t1).normalize();
  const turn = (hash(seed) - 0.5) * 2.2;
  const ta = t1.clone().multiplyScalar(Math.cos(turn)).addScaledVector(t2, Math.sin(turn));
  const tb = new THREE.Vector3().crossVectors(n, ta).normalize();
  // (Its parent is scaled with a grown body already: sized for its usual height.)
  const k = w.size * Math.max(0.45, Math.min(1.3, def.height / (def.scale ?? 1) / 1.6));
  const pos: number[] = [];
  const col: number[] = [];
  const geoPt = new THREE.Vector3();
  const down = n.clone().negate();
  // A point of the pattern (a, b in the tangent plane; lift above the surface) dropped onto the part.
  const place = (a: number, b: number, lift: number) => {
    geoPt.copy(s.local).addScaledVector(ta, a).addScaledVector(tb, b).add(s.geoOffset);
    const hit = cast(s.geo, geoPt.clone().addScaledVector(n, 0.2), down, 0.32);
    // (Only the surface right there: never a far one, the neck or the other side.)
    const p = hit && hit.point.distanceTo(geoPt) < 0.09 ? hit.point : geoPt.clone();
    return p.addScaledVector(n, 0.006 + lift).sub(s.geoOffset).sub(s.local);
  };
  const tri = (pa: THREE.Vector3, pb: THREE.Vector3, pc: THREE.Vector3, c: THREE.Color) => {
    pos.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z, pc.x, pc.y, pc.z);
    for (let i = 0; i < 3; i++) col.push(c.r, c.g, c.b);
  };
  /** A tapering strip from b0 to b1 along tb (curving a little), offset `a` across it. */
  const strip = (a: number, b0: number, b1: number, width: number, c: THREE.Color, lift = 0, bend = 0) => {
    const N = 5;
    const ring: [THREE.Vector3, THREE.Vector3][] = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const b = b0 + (b1 - b0) * u;
      const wid = width * Math.pow(Math.sin(Math.PI * Math.min(0.999, Math.max(0.001, u))), 0.6);
      const ac = a + bend * (u - 0.5) * (u - 0.5) * 4;
      ring.push([place(ac - wid / 2, b, lift), place(ac + wid / 2, b, lift)]);
    }
    for (let i = 0; i < N; i++) {
      tri(ring[i][0], ring[i + 1][0], ring[i + 1][1], c);
      tri(ring[i][0], ring[i + 1][1], ring[i][1], c);
    }
  };
  /** An irregular blob (a bruise, a scorch, a puncture) round (a, b). */
  const blob = (a: number, b: number, r: number, c: THREE.Color, lift = 0, sides = 9, stretch = 1) => {
    const centre = place(a, b, lift);
    const rim: THREE.Vector3[] = [];
    for (let i = 0; i < sides; i++) {
      const ang = (i / sides) * Math.PI * 2;
      const rr = r * (0.75 + 0.45 * hash(seed + i * 3.1 + a * 7 + b * 13));
      rim.push(place(a + Math.cos(ang) * rr * stretch, b + Math.sin(ang) * rr, lift));
    }
    for (let i = 0; i < sides; i++) tri(centre, rim[i], rim[(i + 1) % sides], c);
  };
  const bruise = bruiseOf(s.color);
  switch (w.kind) {
    case 'claw': {
      // Three (or four) parallel rakes.
      const L = 0.24 * k;
      const gap = 0.05 * k;
      const count = w.size > 1.1 ? 4 : 3;
      for (let i = 0; i < count; i++) {
        const a = (i - (count - 1) / 2) * gap;
        const off = (hash(seed + i) - 0.5) * L * 0.2;
        strip(a, -L / 2 + off, L / 2 + off, 0.024 * k, i % 2 ? BLOOD : BLOOD.clone().lerp(BLOOD_DARK, 0.4), 0.001, 0.02 * k);
      }
      break;
    }
    case 'bite': {
      // Two arcs of punctures (upper and lower jaw) in a bruise.
      blob(0, 0, 0.085 * k, bruise, 0, 10, 1.25);
      for (const jaw of [1, -1])
        for (let i = 0; i < 4; i++) {
          const ang = (i / 3 - 0.5) * 1.8;
          blob(Math.sin(ang) * 0.09 * k, jaw * Math.cos(ang) * 0.045 * k, 0.017 * k, i % 3 === 0 ? BLOOD_DARK : BLOOD, 0.002, 5);
        }
      break;
    }
    case 'cut':
      strip(0, -0.17 * k, 0.17 * k, 0.03 * k, BLOOD, 0.001, 0.015 * k);
      strip(0, -0.13 * k, 0.13 * k, 0.012 * k, BLOOD_DARK, 0.002);
      break;
    case 'gore':
      blob(0, 0, 0.09 * k, bruise, 0, 10);
      strip(0, -0.1 * k, 0.12 * k, 0.04 * k, BLOOD, 0.001);
      blob(0, 0.01 * k, 0.03 * k, BLOOD_DARK, 0.002, 6, 0.6);
      break;
    case 'blunt':
      blob(0, 0, 0.1 * k, bruise, 0, 11);
      blob((hash(seed) - 0.5) * 0.03 * k, (hash(seed + 1) - 0.5) * 0.03 * k, 0.055 * k, bruise.clone().multiplyScalar(0.8), 0.001, 7);
      break;
    case 'burn':
      blob(0, 0, 0.13 * k, CHAR, 0, 12);
      blob(0.02 * k, -0.01 * k, 0.07 * k, EMBER, 0.001, 8);
      break;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, woundMaterial);
  m.position.copy(s.local);
  m.frustumCulled = false;
  return m;
}

// ---- strikes ---------------------------------------------------------------------------------------

/** How far into reaching for the spot a move is at `el` seconds in (1 at the impact), and which hit. */
export function strikeWeight(m: MoveDef, el: number): { a: number; k: number } {
  let best = { a: 0, k: 0 };
  m.hits.forEach((h, k) => {
    const at = h.at * m.len;
    const d = el - at;
    const pre = Math.min(0.2, at * 0.85);
    const a = d < -pre ? 0 : d < 0 ? ease(1 + d / pre) : d < 0.06 ? 1 : 1 - ease((d - 0.06) / 0.18);
    if (a > best.a) best = { a, k };
  });
  return best;
}

const tmp = new THREE.Vector3();
const clampV = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Pose the attacker so its striking parts reach the world point P by `a` (0 leaves the move's own motion).
 * Limbs go there by IK; a blade's point is laid on it; jaws and brow get there by the body leaning in and
 * the neck reaching (a few corrections, measuring where the head actually ended up each time).
 */
export function reachFor(rig: ProcRig, p: PoseIn, parts: StrikePart[], P: THREE.Vector3, a: number, opts: { flier?: boolean; leap?: number } = {}) {
  if (a <= 0.001 || !parts.length) {
    rig.pose(p);
    return;
  }
  rig.pose(p);
  rig.root.updateWorldMatrix(true, false);
  const Pm = rig.root.worldToLocal(P.clone());
  const limbs = parts.filter((x) => x.kind === 'paw') as { kind: 'paw'; limb: LegName }[];
  const sword = parts.some((x) => x.kind === 'sword');
  // Out of the limb's reach: the body steps and leans into the blow (as far as it can) first.
  const reaching = sword ? ['RA'] : limbs.map((x) => x.limb);
  if (reaching.length) {
    const shift = new THREE.Vector3();
    for (const name of reaching) {
      const l = rig.limb(name);
      if (!l) continue;
      const hip = rig.root.worldToLocal(l.pivot.getWorldPosition(new THREE.Vector3()));
      const len = limbReach(l.spec) + (sword ? (rig.props.find((x) => x.spec.limb === 'RA')?.tip ?? 0.9) * 0.85 : 0);
      const need = Pm.clone().sub(hip);
      const excess = need.length() - len;
      if (excess > 0) shift.addScaledVector(need.normalize(), Math.min(excess + 0.05, LEAN + 0.2) / reaching.length);
    }
    p.lean = [clampV(p.lean[0] + shift.x * a, -0.35, 0.35), clampV(p.lean[1] + shift.y * a * (opts.flier ? 0.8 : opts.leap ? 1 : 0.3), opts.flier ? -1 : -0.3, 0.25 + (opts.leap ?? 0)), clampV(p.lean[2] + shift.z * a, -LEAN - 0.2, LEAN + 0.2)];
    rig.pose(p);
  }
  limbs.forEach((x) => {
    const l = rig.limb(x.limb);
    if (!l) return;
    const cur = l.paw.position.clone();
    // Two limbs land side by side.
    const want = Pm.clone();
    if (limbs.length > 1) want.x += 0.07 * Math.sign(l.spec.hip[0] || 1);
    const v = cur.lerp(want, a);
    p.legs[x.limb] = [v.x, v.y, v.z];
    if (a > 0.3) p.reach = { ...p.reach, [x.limb]: true };
  });
  if (sword) {
    const hand = rig.limb('RA');
    if (hand) {
      const cur = hand.paw.position.clone();
      const tipLen = rig.props.find((x) => x.spec.limb === 'RA')?.tip ?? 0.9;
      const dir = Pm.clone().sub(cur).normalize();
      // Hand where the weapon meets the spot (a blade most of its length out, cutting through; a club's or
      // an axe's head on it).
      const thru = rig.props.find((x) => x.spec.limb === 'RA')?.tip ?? 0;
      const want = Pm.clone().addScaledVector(dir, -tipLen * (thru > 0.95 && rig.spec.legs.some((l) => l.arm) && tipLen < 0.95 ? 0.85 : 0.97));
      const v = cur.lerp(want, a);
      p.legs.RA = [v.x, v.y, v.z];
      const was = new THREE.Vector3(...(p.props.sword ?? [0, 0.6, 0.8])).normalize();
      const d = was.lerp(dir, a).normalize();
      p.props.sword = [d.x, d.y, d.z];
    }
  }
  const head = parts.find((x) => x.kind === 'snout' || x.kind === 'brow') as { kind: 'snout' | 'brow' } | undefined;
  if (head) {
    const lean = [...p.lean] as V3;
    // The move's own curl of the head gives way to reaching for the spot.
    p.neckPitch *= 1 - 0.6 * a;
    p.headPitch *= 1 - 0.6 * a;
    const err = () => {
      rig.pose(p);
      rig.root.updateWorldMatrix(true, false);
      return Pm.clone().sub(rig.root.worldToLocal(rig.headPoint(head.kind, tmp)));
    };
    for (let it = 0; it < 6; it++) {
      const E = err();
      lean[2] = clampV(lean[2] + E.z * a * 0.85, -LEAN - 0.15, LEAN + 0.2);
      lean[0] = clampV(lean[0] + E.x * a * 0.4, -0.4, 0.4);
      lean[1] = clampV(lean[1] + E.y * a * (opts.flier ? 0.6 : opts.leap ? 0.8 : 0.2), opts.flier ? -1 : -0.3, 0.2 + (opts.leap ?? 0));
      p.lean = [...lean];
      p.neckYaw = clampV(p.neckYaw + (E.x / 0.6) * a * 0.8, -1.3, 1.3);
      // Pitch the neck by measuring which way brings the head nearer (long heads swing far).
      const e0 = err().length();
      const was = p.neckPitch;
      p.neckPitch = was + 0.08;
      const e1 = err().length();
      const g = (e1 - e0) / 0.08;
      p.neckPitch = clampV(was - clampV(Math.abs(g) > 0.05 ? (e0 / g) * 0.7 : 0, -0.4, 0.4) * a, -1.4, 1.6);
    }
  }
  rig.pose(p);
}
