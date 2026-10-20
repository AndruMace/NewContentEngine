/**
 * The station's interior around the porthole (static): the painted steel hull with its plate seams
 * and ribs, the porthole's deep bore with a riveted flange and rim, a console ledge below it with a
 * logbook and a mug, two gauges, the wall lamp and pipes. The gauge needles drift (see view3d).
 */
import { THREE, canvasTexture } from '../three-layer';
import { model, textureMaterial } from '../ambient/assets';
import { PORT, WALL } from './layout';

function plate(w: number, h: number, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** A gauge face: ticks, numbers-like marks, a red sector; the needle is separate. */
function gaugeFace(label: string) {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = '#e8e2d0';
    g.beginPath();
    g.arc(128, 128, 120, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#222';
    g.lineWidth = 6;
    g.stroke();
    for (let i = 0; i <= 20; i++) {
      const a = Math.PI * 0.75 + (i / 20) * Math.PI * 1.5;
      const r0 = i % 5 === 0 ? 84 : 96;
      g.lineWidth = i % 5 === 0 ? 5 : 2;
      g.beginPath();
      g.moveTo(128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0);
      g.lineTo(128 + Math.cos(a) * 108, 128 + Math.sin(a) * 108);
      g.stroke();
    }
    g.strokeStyle = '#b03020';
    g.lineWidth = 10;
    g.beginPath();
    g.arc(128, 128, 100, Math.PI * 0.75 + Math.PI * 1.2, Math.PI * 0.75 + Math.PI * 1.5);
    g.stroke();
    g.fillStyle = '#333';
    g.font = 'bold 26px sans-serif';
    g.textAlign = 'center';
    g.fillText(label, 128, 190);
  });
}

export interface Station {
  group: THREE.Group;
  needles: THREE.Object3D[];
  lampAt: THREE.Vector3;
  lampGlass: THREE.MeshStandardMaterial;
}

export function buildStation(): Station {
  const group = new THREE.Group();
  const hull = textureMaterial('rusty_painted_metal', [1.4, 1.4], { metalness: 0.4, roughness: 0.75, color: 0x8a9aa0 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x5c6468, metalness: 0.6, roughness: 0.5 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xa08048, metalness: 0.7, roughness: 0.35 });

  // The hull face with the porthole's hole.
  const wall = new THREE.Shape();
  wall.moveTo(-3, -0.5);
  wall.lineTo(3, -0.5);
  wall.lineTo(3, 3.2);
  wall.lineTo(-3, 3.2);
  const hole = new THREE.Path();
  hole.absarc(PORT.x, PORT.y, PORT.r, 0, Math.PI * 2, true);
  wall.holes.push(hole);
  const wg = new THREE.ShapeGeometry(wall, 64);
  // UVs in metres (the texture repeats on its own scale).
  const uv = wg.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.7, uv.getY(i) * 0.7);
  const wm = new THREE.Mesh(wg, hull);
  wm.position.z = WALL;
  wm.receiveShadow = true;
  group.add(wm);
  // Ribs and seams.
  for (const x of [-1.7, 1.7]) group.add(plate(0.14, 3.7, steel, x, 1.35, WALL + 0.04));
  group.add(plate(6, 0.1, steel, 0, 2.75, WALL + 0.03));
  group.add(plate(6, 0.1, steel, 0, 0.05, WALL + 0.03));

  // The bore: the hull is thick here.
  const bore = new THREE.Mesh(new THREE.CylinderGeometry(PORT.r, PORT.r, PORT.depth, 64, 1, true), steel);
  bore.rotation.x = Math.PI / 2;
  bore.position.set(PORT.x, PORT.y, WALL - PORT.depth / 2);
  bore.material = steel.clone();
  (bore.material as THREE.MeshStandardMaterial).side = THREE.BackSide;
  group.add(bore);
  // Flange with rivets, and a rolled rim.
  const flange = new THREE.Mesh(new THREE.RingGeometry(PORT.r + 0.02, PORT.r + 0.22, 64), steel);
  flange.position.set(PORT.x, PORT.y, WALL + 0.012);
  flange.receiveShadow = true;
  group.add(flange);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(PORT.r + 0.025, 0.04, 16, 96), brass);
  rim.position.set(PORT.x, PORT.y, WALL + 0.03);
  rim.castShadow = true;
  group.add(rim);
  const rivet = new THREE.SphereGeometry(0.022, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  rivet.rotateX(Math.PI / 2);
  const rivets = new THREE.InstancedMesh(rivet, brass, 28);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    m.makeTranslation(PORT.x + Math.cos(a) * (PORT.r + 0.14), PORT.y + Math.sin(a) * (PORT.r + 0.14), WALL + 0.015);
    rivets.setMatrixAt(i, m);
  }
  group.add(rivets);

  // A console ledge below, with a logbook and a mug.
  const ledge = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.05, 0.42), steel);
  ledge.position.set(0, 0.42, WALL + 0.21);
  ledge.castShadow = ledge.receiveShadow = true;
  group.add(ledge);
  const book = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.035, 0.34), new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.9 }));
  book.position.set(-0.45, 0.462, WALL + 0.22);
  book.rotation.y = 0.15;
  book.castShadow = true;
  group.add(book);
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.038, 0.1, 24), new THREE.MeshStandardMaterial({ color: 0x8a3a2a, roughness: 0.6 }));
  mug.position.set(0.38, 0.495, WALL + 0.2);
  mug.castShadow = true;
  group.add(mug);

  // Two gauges on the right, needles separate.
  const needles: THREE.Object3D[] = [];
  ['DEPTH', 'PRESS'].forEach((label, i) => {
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.1, 48), new THREE.MeshStandardMaterial({ map: gaugeFace(label), roughness: 0.4 }));
    face.position.set(1.12, 1.62 - i * 0.3, WALL + 0.035);
    group.add(face);
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.102, 0.012, 10, 48), brass);
    bezel.position.copy(face.position);
    group.add(bezel);
    const needle = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.08, 0.004), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    needle.geometry.translate(0, 0.035, 0);
    const pivot = new THREE.Object3D();
    pivot.position.set(face.position.x, face.position.y, WALL + 0.04);
    pivot.add(needle);
    group.add(pivot);
    needles.push(pivot);
  });

  // The wall lamp (left of the porthole) and pipes along the top.
  const lamp = model('industrial_wall_lamp');
  lamp.position.set(-1.15, 1.95, WALL + 0.02);
  group.add(lamp);
  const lampGlass = new THREE.MeshStandardMaterial({ color: 0xffe0b0, emissive: new THREE.Color(0xffc080), emissiveIntensity: 1.5 });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 10), lampGlass);
  bulb.position.set(-1.15, 1.86, WALL + 0.18);
  group.add(bulb);
  const pipes = model('modular_industrial_pipes_01');
  // A riser with its valve, up the hull to the right of the porthole.
  pipes.position.set(1.55, 1.2, WALL + 0.12);
  pipes.rotation.y = -Math.PI / 2;
  group.add(pipes);

  return { group, needles, lampAt: new THREE.Vector3(-1.15, 1.84, WALL + 0.3), lampGlass };
}
