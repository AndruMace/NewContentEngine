import { describe, expect, it } from 'vitest';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { THREE } from '../three-layer';
import { sayEvents } from '../story';
import { runStory } from '../story/testing';
import { spaceDrop, type SpaceDropState } from '.';
import { OMEGA, R_EARTH } from './atmosphere';
import { buildModel } from './models';
import { objectById } from './objects';
import { simulate } from './physics';
import { CRUSH, Wreck, bowl, crushFraction, subdivide, type CraterShape } from './wreck';

/** Edges of a triangle soup, keyed by their two (rounded) end points: how many triangles share each. */
function edgeCounts(geo: THREE.BufferGeometry): Map<string, number> {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // Rounded to 0.01 mm, and -0 made 0 (a sphere's seam meets at sin 0 and sin 2π).
  const key = (i: number) => [pos.getX(i), pos.getY(i), pos.getZ(i)].map((x) => (Math.round(x * 1e5) || 0).toString()).join(',');
  const counts = new Map<string, number>();
  for (let t = 0; t < pos.count; t += 3) {
    const k = [key(t), key(t + 1), key(t + 2)];
    // Skip slivers with two corners in one place (a sphere's poles).
    if (k[0] === k[1] || k[1] === k[2] || k[2] === k[0]) continue;
    for (let e = 0; e < 3; e++) {
      const id = [k[e], k[(e + 1) % 3]].sort().join('|');
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

function longestEdge(geo: THREE.BufferGeometry): number {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  let m = 0;
  for (let t = 0; t < pos.count; t += 3) for (let e = 0; e < 3; e++) m = Math.max(m, a.fromBufferAttribute(pos, t + e).distanceTo(b.fromBufferAttribute(pos, t + ((e + 1) % 3))));
  return m;
}

describe('subdivide', () => {
  it.each([
    ['box', new THREE.BoxGeometry(4.7, 1.4, 1.8)],
    ['sphere', new THREE.SphereGeometry(1, 16, 10)],
    ['rounded box', new RoundedBoxGeometry(4.7, 0.7, 1.8, 3, 0.18)],
  ])('%s: splits until no edge is too long, and stays watertight (no cracks to tear open)', (_, geo) => {
    const before = edgeCounts(geo.index ? geo.toNonIndexed() : geo);
    expect([...before.values()].every((n) => n === 2)).toBe(true);
    const out = subdivide(geo, 0.2);
    expect(longestEdge(out)).toBeLessThanOrEqual(0.2 + 1e-6);
    const after = edgeCounts(out);
    expect(after.size).toBeGreaterThan(before.size);
    expect([...after.values()].every((n) => n === 2)).toBe(true);
    // Texture coordinates and normals come along.
    expect(out.attributes.uv.count).toBe(out.attributes.position.count);
    expect(out.attributes.normal.count).toBe(out.attributes.position.count);
  });
});

describe('crush', () => {
  it('flattens a car at 187 km/h as far as it can go, but barely dents an engine block or a tank', () => {
    const car = crushFraction(CRUSH.car, 1500, 52, 1.8);
    expect(car).toBeGreaterThan(0.55);
    expect(car).toBeLessThanOrEqual(CRUSH.car.max);
    expect(crushFraction(CRUSH['engine block'], 180, 70, 0.6)).toBeLessThan(0.02);
    expect(crushFraction(CRUSH.tank, 60000, 205, 2.4)).toBeLessThanOrEqual(CRUSH.tank.max);
  });

  it('crushes more the harder it hits', () => {
    const slow = crushFraction(CRUSH['jet engine'], 4300, 40, 2.4);
    const fast = crushFraction(CRUSH['jet engine'], 4300, 85, 2.4);
    expect(fast).toBeGreaterThan(slow);
  });
});

describe('wreck', () => {
  const crater: CraterShape = { R: 1.9, depth: 0.78, rim: 0.14 };
  const landCar = (seed: number) => {
    const shape = objectById('sedan').body.shape;
    const w = new Wreck(buildModel('sedan', shape), 'car', seed, 4.7);
    w.prepare(() => ({
      q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.3, 1.2)),
      scale: new THREE.Vector3(1, 1, 1),
      v: 52,
      vh: new THREE.Vector3(1, 0, 0),
      mass: 1500,
      size: 4.7,
      crater,
    }));
    w.work(Infinity);
    return w;
  };

  it('every part it throws comes to rest on the ground, not in it or above it', () => {
    const w = landCar(1);
    expect(w.parts.length).toBeGreaterThan(4);
    const box = new THREE.Box3();
    const at = (psi: number) => {
      w.update(psi, 1, new THREE.Color(0.5, 0.4, 0.3));
      w.group.updateMatrixWorld(true);
      return w.parts.map((p) => {
        box.setFromObject(p);
        const c = box.getCenter(new THREE.Vector3());
        return { c, low: box.min.y, ground: bowl(crater, Math.hypot(c.x, c.z)) };
      });
    };
    const late = at(8.5);
    const last = at(8.9);
    late.forEach((p, i) => {
      // Lying on the ground (boxes of tilted parts overhang a little).
      expect(p.low).toBeGreaterThan(p.ground - 0.12);
      expect(p.low).toBeLessThan(p.ground + 0.12);
      // And still.
      expect(p.c.distanceTo(last[i].c)).toBeLessThan(0.01);
    });
  });

  it('works out the same wreck every time', () => {
    const a = landCar(3);
    const b = landCar(3);
    a.update(2, 1, new THREE.Color());
    b.update(2, 1, new THREE.Color());
    a.parts.forEach((p, i) => expect(p.position.distanceTo(b.parts[i].position)).toBeLessThan(1e-9));
  });
});

describe('landing spot', () => {
  it('comes down where it lands: the last samples sit over the impact point, and the last on the ground', () => {
    const tr = simulate(objectById('sedan').body, { mode: 'drop', altitude: 100_000, angle: 0, speed: 0 });
    const n = tr.t.length - 1;
    expect(tr.r[n]).toBe(R_EARTH);
    expect(tr.th[n]).toBe(tr.impact!.th);
    // Horizontal offset from the site (which turns with the Earth), a moment before it lands.
    const site = (t: number) => tr.impact!.th - OMEGA * (tr.impact!.t - t);
    const x = tr.r[n - 1] * Math.sin(tr.th[n - 1] - site(tr.t[n - 1]));
    expect(Math.abs(x)).toBeLessThan(1);
  });
});

describe('seeds', () => {
  it.each([{ object: 'sedan' }, {}, { mode: 'versus', versusA: 'tank', versusB: 'piano', versusC: 'asteroid' }])('%j: another seed changes how it looks, never a number', (params) => {
    const a = runStory(spaceDrop, params, 1);
    const b = runStory(spaceDrop, params, 2);
    const physics = (r: typeof a) => r.events.filter((e) => e.type.startsWith('drop:')).map(({ t: _t, ...e }) => e);
    expect(physics(b)).toEqual(physics(a));
    expect(sayEvents(b.events).map((x) => x.facts)).toEqual(sayEvents(a.events).map((x) => x.facts));
    const sa = a.state as SpaceDropState;
    const sb = b.state as SpaceDropState;
    sa.sim.runs.forEach((r, k) => {
      expect(sb.sim.runs[k].energy).toBe(r.energy);
      expect(sb.sim.runs[k].crater).toEqual(r.crater);
    });
    expect(sb.look).not.toEqual(sa.look);
  });

  it('the sun setting fixes how high the sun is', () => {
    const height = (sun: string, seed: number) => (runStory(spaceDrop, { sun }, seed).state as SpaceDropState).look.sun[1];
    expect(height('low', 1)).toBeCloseTo(Math.sin((12 * Math.PI) / 180), 6);
    expect(height('low', 7)).toBeCloseTo(height('low', 1), 6);
    expect(height('high', 3)).toBeCloseTo(Math.sin((62 * Math.PI) / 180), 6);
  });
});

describe('impact sounds', () => {
  const wreckOf = (params: Record<string, unknown>) => runStory(spaceDrop, params, 1).events.find((e) => e.type === 'drop:impact')?.wreck;
  it('a car with its windows crumples and shatters; an engine block crumples; a rod from orbit does neither', () => {
    expect(wreckOf({ object: 'sedan' })).toBe('glazed');
    expect(wreckOf({ object: 'sedan', start: 'orbit' })).toBe('crush');
    expect(wreckOf({})).toBe('none');
  });
});
