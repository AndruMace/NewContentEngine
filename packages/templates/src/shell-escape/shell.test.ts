import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { polyhedron } from './polyhedra';
import { shellEscape } from './index';

describe('shell escape', () => {
  it('builds regular polyhedra from exact vertices', () => {
    const faces = { cube: 6, octahedron: 8, dodecahedron: 12, icosahedron: 20 } as const;
    for (const [id, n] of Object.entries(faces)) {
      const p = polyhedron(id as keyof typeof faces);
      expect(p.faces).toHaveLength(n);
      expect(p.edges).toHaveLength(n + (id === 'cube' || id === 'octahedron' ? 12 - n : id === 'dodecahedron' ? 18 : 10));
      // Every face is the same distance from the centre.
      for (const f of p.faces) expect(f.d).toBeCloseTo(p.inradius, 9);
    }
  });

  it('only leaves a shell through its window', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const r = new Runner(shellEscape, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params: { shells: 3 }, visual: false });
      let layer = 0;
      while (!r.done) {
        r.advanceFrame();
        const s = r.state;
        if (s.layer > layer) layer = s.layer;
        if (s.layer < s.shells.length) {
          // While inside the active shell, the ball is within its circumsphere.
          const d = Math.hypot(...s.pos);
          expect(d).toBeLessThan(s.shells[s.layer].R + s.r * 2);
        }
      }
      expect(r.timedOut).toBe(false);
      expect(layer).toBe(3);
      // Every escape was through the window (never through a wall), and the broken shells left shards.
      const escapes = r.events.filter((e) => e.type === 'escape');
      expect(escapes).toHaveLength(3);
      for (const e of escapes) expect(e.viaWindow).toBe(true);
      expect(r.state.shardLive.some((x) => x === 1)).toBe(true);
    }
  });

  it('breaks each shell into a similar number of convex shards', () => {
    const r = new Runner(shellEscape, { seed: 2, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params: { shells: 4 }, visual: false });
    for (const sh of r.state.shells) {
      expect(sh.shards.length).toBeGreaterThanOrEqual(18);
      expect(sh.shards.length).toBeLessThanOrEqual(40);
      // Every piece lies flat in its face's plane.
      for (const p of sh.shards) for (const v of p.poly) expect(v[0] * p.n[0] + v[1] * p.n[1] + v[2] * p.n[2]).toBeCloseTo(polyhedron(sh.shape).inradius, 6);
    }
  });
});
