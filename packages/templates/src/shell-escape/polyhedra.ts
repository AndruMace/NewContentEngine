import * as dm from '@sim/physics/math';

export type ShapeId = 'cube' | 'octahedron' | 'dodecahedron' | 'icosahedron';
export type V3 = [number, number, number];

export interface Face {
  /** Outward unit normal (shape's local frame). */
  n: V3;
  /** Distance from the centre to the face plane (circumradius 1). */
  d: number;
  /** Corner points in order around the face. */
  pts: V3[];
  /** Distance from the face centre to its edges (regular faces: the same for every edge). */
  apothem: number;
  /** Outward unit normal of each edge within the face plane (same order as pts). */
  edgeNormals: V3[];
}

export interface Polyhedron {
  id: ShapeId;
  faces: Face[];
  edges: [V3, V3][];
  /** Inradius / circumradius. */
  inradius: number;
}

const PHI = (1 + Math.sqrt(5)) / 2;

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.sqrt(dot(a, a));
  return [a[0] / l, a[1] / l, a[2] / l];
};

function signs(v: number[]): number[][] {
  // Every combination of signs for the non-zero entries.
  let out: number[][] = [[]];
  for (const x of v) out = out.flatMap((p) => (x === 0 ? [[...p, 0]] : [[...p, x], [...p, -x]]));
  return out;
}

function vertices(id: ShapeId): V3[] {
  const raw: number[][] = [];
  const add = (v: number[]) => raw.push(...signs(v));
  switch (id) {
    case 'cube':
      add([1, 1, 1]);
      break;
    case 'octahedron':
      add([1, 0, 0]);
      add([0, 1, 0]);
      add([0, 0, 1]);
      break;
    case 'icosahedron':
      add([0, 1, PHI]);
      add([1, PHI, 0]);
      add([PHI, 0, 1]);
      break;
    case 'dodecahedron':
      add([1, 1, 1]);
      add([0, 1 / PHI, PHI]);
      add([1 / PHI, PHI, 0]);
      add([PHI, 0, 1 / PHI]);
      break;
  }
  return raw.map((v) => norm(v as V3));
}

const cache = new Map<ShapeId, Polyhedron>();

/**
 * A regular polyhedron with circumradius 1, built from exact vertex coordinates so the physics
 * never depends on a graphics library: faces are the planes through three vertices that have every
 * other vertex on one side.
 */
export function polyhedron(id: ShapeId): Polyhedron {
  const hit = cache.get(id);
  if (hit) return hit;
  const vs = vertices(id);
  const eps = 1e-9;
  const faces: Face[] = [];
  for (let i = 0; i < vs.length; i++)
    for (let j = i + 1; j < vs.length; j++)
      for (let k = j + 1; k < vs.length; k++) {
        let n = cross(sub(vs[j], vs[i]), sub(vs[k], vs[i]));
        if (dot(n, n) < eps) continue;
        n = norm(n);
        let d = dot(n, vs[i]);
        if (d < 0) {
          n = [-n[0], -n[1], -n[2]];
          d = -d;
        }
        if (vs.some((v) => dot(n, v) > d + 1e-7)) continue;
        if (faces.some((f) => dot(f.n, n) > 1 - 1e-7)) continue;
        const on = vs.filter((v) => Math.abs(dot(n, v) - d) < 1e-7);
        // Order the corners around the face centre.
        const c: V3 = [n[0] * d, n[1] * d, n[2] * d];
        const u = norm(sub(on[0], c));
        const w = cross(n, u);
        const pts = on
          .map((p) => ({ p, a: dm.atan2(dot(sub(p, c), w), dot(sub(p, c), u)) }))
          .sort((a, b) => a.a - b.a)
          .map((x) => x.p);
        let apothem = Infinity;
        const edgeNormals: V3[] = [];
        for (let e = 0; e < pts.length; e++) {
          const a = pts[e];
          const b = pts[(e + 1) % pts.length];
          const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
          apothem = Math.min(apothem, Math.sqrt(dot(sub(mid, c), sub(mid, c))));
          edgeNormals.push(norm(sub(mid, c)));
        }
        faces.push({ n, d, pts, apothem, edgeNormals });
      }
  const edges: [V3, V3][] = [];
  const seen = new Set<string>();
  for (const f of faces)
    for (let e = 0; e < f.pts.length; e++) {
      const a = f.pts[e];
      const b = f.pts[(e + 1) % f.pts.length];
      const key = [a, b].map((p) => p.map((x) => x.toFixed(6)).join(',')).sort().join('|');
      if (!seen.has(key)) {
        seen.add(key);
        edges.push([a, b]);
      }
    }
  const poly: Polyhedron = { id, faces, edges, inradius: faces[0].d };
  cache.set(id, poly);
  return poly;
}
