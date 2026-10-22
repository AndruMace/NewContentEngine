/**
 * Building blocks for the train interiors (Night Train's sleeper, Day Train's coach): boxes with
 * texture scales in metres, rounded panels, mouldings and gathered curtains.
 */
import { THREE } from '../three-layer';

/** A box whose UVs are in metres × `perMetre` (one texture scale across boxes of any size). */
export function worldUvBox(w: number, h: number, d: number, perMetre: number) {
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

export function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, perMetre = 1) {
  const m = new THREE.Mesh(worldUvBox(w, h, d, perMetre), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

export function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number) {
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

/** A frame of four bars (a moulding round a panel), in the plane z, facing +z. */
export function frame(group: THREE.Group, mat: THREE.Material, x0: number, y0: number, x1: number, y1: number, z: number, w: number, d: number) {
  group.add(box(x1 - x0, w, d, mat, (x0 + x1) / 2, y0 + w / 2, z));
  group.add(box(x1 - x0, w, d, mat, (x0 + x1) / 2, y1 - w / 2, z));
  group.add(box(w, y1 - y0 - 2 * w, d, mat, x0 + w / 2, (y0 + y1) / 2, z));
  group.add(box(w, y1 - y0 - 2 * w, d, mat, x1 - w / 2, (y0 + y1) / 2, z));
}

/** A raised panel on a wall facing +z: a darker moulded frame with a pale inlay line inside it. */
export function panel(group: THREE.Group, mould: THREE.Material, inlay: THREE.Material, x0: number, y0: number, x1: number, y1: number, z: number) {
  frame(group, mould, x0, y0, x1, y1, z + 0.012, 0.035, 0.024);
  frame(group, inlay, x0 + 0.07, y0 + 0.07, x1 - 0.07, y1 - 0.07, z + 0.003, 0.008, 0.006);
}

/**
 * A curtain: a gathered panel hinged at its top edge, drawn back by a tie-back at `tieAt` (fraction
 * of its height from the top) towards `side` (-1 left, +1 right of the window).
 */
export function curtain(width: number, height: number, mat: THREE.Material, side: number, tieAt: number) {
  const g = new THREE.PlaneGeometry(width, height, 40, 24);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const down = 0.5 - y / height; // 0 at the top, 1 at the bottom
    // Pinched in at the tie-back, flaring a little below it.
    const pinch = 1 - 0.28 * Math.exp(-Math.pow((down - tieAt) / 0.3, 2));
    const xs = side * (width / 2) + (x - side * (width / 2)) * pinch;
    pos.setX(i, xs);
    pos.setZ(i, 0.04 * Math.sin((x / width) * Math.PI * 11) * (0.6 + 0.6 * down));
  }
  g.computeVertexNormals();
  g.translate(0, -height / 2, 0);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}
