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
    for (let seed = 1; seed <= 8; seed++) {
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
    }
  });
});
