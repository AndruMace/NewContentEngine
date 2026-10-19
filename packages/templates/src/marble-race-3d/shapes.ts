/**
 * Drawing geometry for the turns and funnels: dense, solid and smooth-shaded (walls with real
 * thickness and rounded lips, a few degrees per segment), built from the shapes the course
 * recorded. Their colliders are coarser triangle meshes; these only have to look right.
 */
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { THREE } from '../three-layer';
import { OUTER_H, RT, T, W, WALL_H, type FunnelSpec, type TurnSpec } from './course';

/** A rounded lip over a wall top, from (r0, h) to (r1, h), as profile points. */
function lip(r0: number, r1: number, h: number, n = 8): [number, number][] {
  const c = (r0 + r1) / 2;
  const rad = Math.abs(r1 - r0) / 2;
  const sgn = Math.sign(r1 - r0);
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = Math.PI - (i / n) * Math.PI;
    return [c + sgn * Math.cos(a) * rad, h + Math.sin(a) * rad];
  });
}

/**
 * Sweep a cross-section profile ([radial distance from the axis, height above the floor line])
 * round the turn's axis, dropping as it goes. One smooth surface per call: separate calls meet at
 * creases.
 */
function sweep(t: TurnSpec, profile: [number, number][]): THREE.BufferGeometry {
  const span = Math.abs(t.a1 - t.a0);
  const n = Math.max(12, Math.ceil(span / ((2 * Math.PI) / 180)));
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const m = profile.length;
  // Profile length so far, for texture coordinates across.
  const across = [0];
  for (let k = 1; k < m; k++) across.push(across[k - 1] + Math.hypot(profile[k][0] - profile[k - 1][0], profile[k][1] - profile[k - 1][1]));
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = t.a0 + (t.a1 - t.a0) * u;
    const y = t.y0 + (t.y1 - t.y0) * u;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let k = 0; k < m; k++) {
      const [r, h] = profile[k];
      pos.push(t.c.x + r * ca, y + h, t.c.z + r * sa);
      // Metres × 6 along and across: real-scale grain and brushing.
      uv.push(u * span * RT * 6, across[k] * 6);
    }
  }
  for (let i = 0; i < n; i++)
    for (let k = 0; k < m - 1; k++) {
      const a = i * m + k;
      const b = a + m;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A turn or helix: floor slab, and inner and outer walls with thickness and rounded tops. */
export function turnGeometry(t: TurnSpec): THREE.BufferGeometry {
  const rIn = RT - W / 2;
  const rOut = RT + W / 2;
  const parts = [
    sweep(t, [[rIn, 0], [RT, 0], [rOut, 0]]),
    sweep(t, [[rOut + T, -T], [rIn - T, -T]]),
    sweep(t, [[rIn, 0], [rIn, WALL_H]]),
    sweep(t, lip(rIn, rIn - T, WALL_H)),
    sweep(t, [[rIn - T, WALL_H], [rIn - T, -T]]),
    sweep(t, [[rOut, OUTER_H], [rOut, 0]]),
    sweep(t, lip(rOut + T, rOut, OUTER_H)),
    sweep(t, [[rOut + T, -T], [rOut + T, OUTER_H]]),
  ];
  return mergeGeometries(parts)!;
}

/** A coin funnel: a spun bowl with thickness, a rim wall with a rolled lip, and the spout below. */
export function funnelGeometry(f: FunnelSpec): THREE.BufferGeometry {
  const segs = 160;
  const lathe = (pts: [number, number][]) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segs);
  const bowl = (dy: number) =>
    Array.from({ length: 33 }, (_, i): [number, number] => {
      const u = i / 32;
      return [f.rHole + (f.rTop - f.rHole) * u, -f.depth * (1 - u) ** 1.8 + dy];
    });
  const parts = [
    lathe(bowl(0)),
    lathe(bowl(-T).reverse()),
    lathe([[f.rTop, 0], [f.rTop, WALL_H]]),
    lathe(lip(f.rTop, f.rTop + T, WALL_H)),
    lathe([[f.rTop + T, WALL_H], [f.rTop + T, -T]]),
    lathe([[f.rHole, -f.depth], [f.rHole, -f.depth - f.spout]]),
    lathe([[f.rHole, -f.depth - f.spout], [f.rHole + T * 0.6, -f.depth - f.spout]]),
    lathe([[f.rHole + T * 0.6, -f.depth - f.spout], [f.rHole + T * 0.6, -f.depth - T]]),
  ];
  // Lathe geometry spins round y; the funnel stands at its rim centre.
  // (Each part keeps its own smooth normals; merged, they meet at creases.)
  const g = mergeGeometries(parts)!;
  g.translate(f.c.x, f.c.y, f.c.z);
  return g;
}
