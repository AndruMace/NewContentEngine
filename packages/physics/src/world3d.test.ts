import { describe, expect, it } from 'vitest';
import { World3D, rotation, type Box3, type Plane3, type Sphere3, type Tube3 } from './world3d';

const dt = 1 / 240;

describe('World3D', () => {
  it('bounces a dropped ball off a plane with the expected restitution', () => {
    const w = new World3D();
    w.gravity = 10;
    w.add<Plane3>({ kind: 'plane', nx: 0, ny: 1, nz: 0, d: 0, restitution: 0.8 });
    const b = w.addBody({ x: 0, y: 2, z: 0, vx: 0, vy: 0, vz: 0, r: 0.2, restitution: 0.8 });
    let impact = 0;
    let after = 0;
    for (let k = 0; k < 400 && !after; k++) {
      const vy = b.vy;
      w.step(dt, () => {
        impact = -vy;
        after = b.vy;
      });
    }
    expect(after / impact).toBeCloseTo(0.8, 1);
  });

  it('deflects a ball off a tilted box without gaining energy', () => {
    const w = new World3D();
    w.gravity = 0;
    w.add<Box3>({ kind: 'box', cx: 0, cy: 0, cz: 0, hx: 1, hy: 0.05, hz: 1, rot: rotation(0.3, 0, 0.4), restitution: 1, friction: 0 });
    const b = w.addBody({ x: -0.2, y: 2, z: 0.1, vx: 0, vy: -4, vz: 0, r: 0.2, restitution: 1, friction: 0 });
    let hits = 0;
    for (let k = 0; k < 480; k++) w.step(dt, () => hits++);
    expect(hits).toBe(1);
    expect(Math.hypot(b.vx, b.vy, b.vz)).toBeLessThanOrEqual(4 + 1e-9);
    expect(Math.abs(b.vx) + Math.abs(b.vz)).toBeGreaterThan(0.5);
  });

  it("rattles a ball off a cup's rim edge, and holds one that drops in", () => {
    const rim = new World3D();
    rim.gravity = 0;
    rim.add<Tube3>({ kind: 'tube', cx: 0, cz: 0, y0: 0, y1: 1, ri: 0.5, ro: 0.55 });
    // Landing square on top of the rim: straight back up.
    const top = rim.addBody({ x: 0.525, y: 1.5, z: 0, vx: 0, vy: -3, vz: 0, r: 0.2, restitution: 0.6 });
    // Clipping the rim's outer edge: knocked outward (the edge is a real circle, not a box corner).
    const edge = rim.addBody({ x: 0, y: 1.5, z: -0.7, vx: 0, vy: -3, vz: 0, r: 0.2, restitution: 0.6 });
    for (let k = 0; k < 120; k++) rim.step(dt);
    expect(top.vy).toBeGreaterThan(0);
    expect(edge.vz).toBeLessThan(-1);
    expect(Math.abs(edge.vx)).toBeLessThan(1e-9);

    const cup = new World3D();
    cup.add<Tube3>({ kind: 'tube', cx: 0, cz: 0, y0: 0, y1: 1, ri: 0.5, ro: 0.55, restitution: 0.3 });
    cup.add<Plane3>({ kind: 'plane', nx: 0, ny: 1, nz: 0, d: 0, restitution: 0.1 });
    const c = cup.addBody({ x: 0.1, y: 2, z: 0.05, vx: 0.4, vy: 0, vz: 0.2, r: 0.2, restitution: 0.4 });
    for (let k = 0; k < 1200; k++) cup.step(dt);
    expect(Math.hypot(c.x, c.z)).toBeLessThan(0.5 - 0.2 + 1e-3);
    expect(c.y).toBeLessThan(0.25);
  });

  it('kicks a ball off a bumper and spins it off a spinner', () => {
    const w = new World3D();
    w.gravity = 0;
    w.add<Sphere3>({ kind: 'sphere', x: 0, y: 0, z: 0, r: 0.5, restitution: 0.8, kick: 3 });
    const b = w.addBody({ x: 0, y: 1.2, z: 0, vx: 0, vy: -2, vz: 0, r: 0.2 });
    for (let k = 0; k < 120; k++) w.step(dt);
    expect(b.vy).toBeGreaterThan(3);

    const s = new World3D();
    s.gravity = 0;
    s.addSpinner({ cx: 0, cy: 0, cz: 0, hx: 1, hy: 0.1, hz: 0.1 }, 0, 6);
    const c = s.addBody({ x: 0.7, y: 0, z: -0.5, vx: 0, vy: 0, vz: 0, r: 0.2, restitution: 0.5 });
    for (let k = 0; k < 120; k++) s.step(dt);
    expect(Math.hypot(c.vx, c.vz)).toBeGreaterThan(1);
  });

  it('is deterministic', () => {
    const run = () => {
      const w = new World3D();
      w.add<Plane3>({ kind: 'plane', nx: 0, ny: 1, nz: 0, d: 0, restitution: 0.7 });
      for (let i = 0; i < 12; i++) w.add<Box3>({ kind: 'box', cx: (i % 4) - 1.5, cy: 1 + (i >> 2), cz: 0, hx: 0.4, hy: 0.04, hz: 0.6, rot: rotation(i, 0, 0.5 - i * 0.1), restitution: 0.7 });
      const balls = [0, 1, 2].map((i) => w.addBody({ x: i * 0.3 - 0.3, y: 5, z: i * 0.1, vx: 0.5, vy: 0, vz: -0.3, r: 0.18, restitution: 0.7 }));
      for (let k = 0; k < 2400; k++) w.step(dt);
      return balls.map((b) => [b.x, b.y, b.z].join(',')).join(';');
    };
    expect(run()).toBe(run());
  });
});
