/**
 * Rays and turtles: a manta's slow wingbeats (open water and reef), a spotted eagle ray with its
 * whip of a tail (reef), and sea turtles rowing with their front flippers (reef).
 */
import { THREE } from '../../three-layer';
import type { WaterUniforms } from '../water';
import type { Depth, Population } from '../schedule';
import { beat, creatureMaterial, face, passState, type Fauna } from './kit';

/**
 * A ray's body, nose at +z, about 1 across: wings swept back from a thick centre, and (for the eagle
 * ray) a long thin tail; for the manta, two horn-like fins at the front.
 */
function rayGeometry(kind: 'manta' | 'eagle') {
  const g = new THREE.PlaneGeometry(1, 0.6, 32, 14);
  g.rotateX(-Math.PI / 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i) / 0.6; // -0.5 tail .. 0.5 nose
    const ax = Math.abs(x) * 2; // 0 centre .. 1 wing tip
    // Wing outline: widest a little forward of the middle, tapering to points.
    const width = Math.max(0.12, 1 - Math.abs(z - 0.08) * (kind === 'manta' ? 1.7 : 1.9));
    const xs = x * width;
    // Swept back towards the tips; a domed body down the middle.
    const zs = z * 0.6 - 0.28 * Math.pow(ax * width, 1.6) * 0.6;
    const y = 0.05 * Math.pow(Math.max(0, 1 - ax * width * 2.2), 2) * (1 - Math.abs(z) * 1.2);
    p.setXYZ(i, xs, y, zs);
  }
  g.computeVertexNormals();
  const parts: THREE.BufferGeometry[] = [g.toNonIndexed()];
  const tri = (pts: number[]) => {
    const t = new THREE.BufferGeometry();
    t.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    t.computeVertexNormals();
    parts.push(t);
  };
  if (kind === 'eagle') tri([-0.006, 0.0, -0.28, 0.006, 0.0, -0.28, 0, 0.0, -1.2]);
  else {
    tri([0.05, 0.0, 0.3, 0.08, 0.0, 0.3, 0.07, -0.02, 0.4]);
    tri([-0.05, 0.0, 0.3, -0.08, 0.0, 0.3, -0.07, -0.02, 0.4]);
    tri([-0.004, 0.0, -0.25, 0.004, 0.0, -0.25, 0, 0.0, -0.45]);
  }
  const out = new THREE.BufferGeometry();
  const cat = (name: string) => parts.flatMap((q) => [...(q.getAttribute(name).array as Float32Array)]);
  out.setAttribute('position', new THREE.Float32BufferAttribute(cat('position'), 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(cat('normal'), 3));
  return out;
}

export function buildRays(U: WaterUniforms, _depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const manta = pop.species === 'manta';
  const geo = rayGeometry(manta ? 'manta' : 'eagle');
  const rays = pop.slots.map((slot) => {
    const mat = manta
      ? creatureMaterial(U, { back: [0.06, 0.06, 0.08], belly: [0.88, 0.88, 0.86], mode: 2, amp: 0.35, k: 1.2, sheen: 0.2 })
      : creatureMaterial(U, { back: [0.08, 0.09, 0.12], belly: [0.9, 0.9, 0.88], mode: 2, amp: 0.4, k: 1.5, pattern: 2, patCol: [0.85, 0.88, 0.9], patScale: 9, sheen: 0.25 });
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
    return { slot, mesh, mat };
  });
  return {
    group,
    update(t, L, s) {
      for (const { slot, mesh, mat } of rays) {
        const ps = passState(pop, slot, s, D, v, { clear: 4, spread: 4, yMin: -5, yMax: 4, speed: [0.4, 0.8] });
        mesh.visible = ps.visible;
        if (!ps.visible) continue;
        mesh.position.copy(ps.pos);
        // Rays glide nearly level.
        const h = ps.heading.clone();
        h.y *= 0.3;
        face(mesh, h.normalize());
        mesh.scale.setScalar(manta ? 3.5 + 1.5 * ps.h(10) : 1.6 + 0.6 * ps.h(10));
        mat.uniforms.uBeat.value = beat(manta ? 0.17 : 0.3, t, L) + ps.h(11) * 6.28;
        // Bank gently into the slow wingbeats.
        mesh.rotateZ(0.08 * Math.sin(mat.uniforms.uBeat.value * 0.5));
      }
    },
  };
}

export function buildTurtles(U: WaterUniforms, _depth: Depth, pop: Population, D: number, v: number): Fauna {
  const group = new THREE.Group();
  const shellGeo = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.55);
  shellGeo.scale(0.42, 0.2, 0.55);
  const plastronGeo = new THREE.CircleGeometry(1, 28);
  plastronGeo.rotateX(Math.PI / 2);
  plastronGeo.scale(0.4, 1, 0.52);
  plastronGeo.translate(0, -0.02, 0);
  const headGeo = new THREE.SphereGeometry(1, 14, 10);
  headGeo.scale(0.09, 0.075, 0.13);
  const flipperGeo = new THREE.BoxGeometry(0.5, 0.025, 0.14);
  flipperGeo.translate(0.25, 0, 0);
  const rearGeo = new THREE.BoxGeometry(0.18, 0.02, 0.1);
  rearGeo.translate(0.09, 0, 0);
  const turtles = pop.slots.map((slot) => {
    const shell = creatureMaterial(U, { back: [0.36, 0.3, 0.17], belly: [0.3, 0.25, 0.15], pattern: 4, patScale: 5.5, sheen: 0.35 });
    const skin = creatureMaterial(U, { back: [0.42, 0.4, 0.3], belly: [0.7, 0.66, 0.5], sheen: 0.2 });
    const belly = creatureMaterial(U, { back: [0.75, 0.68, 0.48], belly: [0.75, 0.68, 0.48] });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(shellGeo, shell), new THREE.Mesh(plastronGeo, belly));
    const head = new THREE.Mesh(headGeo, skin);
    head.position.set(0, 0.02, 0.6);
    g.add(head);
    // Flippers on pivots at the shoulders and hips (they turn about the body's long axis).
    const limbs = [
      { x: 0.32, z: 0.3, geo: flipperGeo, front: true },
      { x: -0.32, z: 0.3, geo: flipperGeo, front: true },
      { x: 0.3, z: -0.38, geo: rearGeo, front: false },
      { x: -0.3, z: -0.38, geo: rearGeo, front: false },
    ].map((l) => {
      const pivot = new THREE.Object3D();
      pivot.position.set(l.x, 0, l.z);
      const m = new THREE.Mesh(l.geo, skin);
      if (l.x < 0) m.scale.x = -1;
      m.rotation.y = l.front ? (l.x > 0 ? -0.5 : 0.5) : l.x > 0 ? -1.1 : 1.1;
      pivot.add(m);
      g.add(pivot);
      return { pivot, front: l.front, side: Math.sign(l.x) };
    });
    group.add(g);
    return { slot, g, limbs };
  });
  return {
    group,
    update(t, L, s) {
      for (const { slot, g, limbs } of turtles) {
        const ps = passState(pop, slot, s, D, v, { clear: 2.8, spread: 3, yMin: -3.5, yMax: 2, speed: [0.25, 0.5] });
        g.visible = ps.visible;
        if (!ps.visible) continue;
        g.position.copy(ps.pos);
        face(g, ps.heading);
        g.scale.setScalar(0.9 + 0.4 * ps.h(10));
        // Slow strokes of the front flippers (up and back), the hind ones paddling and steering.
        const b = beat(0.28, t, L) + ps.h(11) * 6.28;
        for (const l of limbs) l.pivot.rotation.z = l.side * (l.front ? 0.55 * Math.sin(b) - 0.1 : 0.2 * Math.sin(b * 2 + 1));
        g.position.y += 0.05 * Math.sin(b);
      }
    },
  };
}
