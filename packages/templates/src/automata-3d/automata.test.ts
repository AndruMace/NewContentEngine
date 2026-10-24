import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme, hashString } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { MODE_IMPLS, automata3d } from './index';
import { CAPTION_GAP } from './shared';
import { CycleWatch, Grid3, Life2 } from './grid';
import { CRYSTAL_PRESETS, countsText, describeRule2, parseRule2, parseRule3, type Rule3 } from './rules';
import { lifeStart, symmetricSeed } from './seeds';

/** Straightforward reference step (no bounding box, no padding tricks). */
function naiveStep(n: number, cells: Uint8Array, rule: Rule3): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(cells.length);
  const at = (x: number, y: number, z: number) => (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n ? 0 : cells[x + n * (y + n * z)]);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let k = 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy && !dz) continue;
              if (rule.nb === 'vn' && Math.abs(dx) + Math.abs(dy) + Math.abs(dz) !== 1) continue;
              if (at(x + dx, y + dy, z + dz) === 1) k++;
            }
        const s = at(x, y, z);
        out[x + n * (y + n * z)] = s === 0 ? (rule.birth >>> k) & 1 : s === 1 ? ((rule.survive >>> k) & 1 ? 1 : rule.states > 2 ? 2 : 0) : s + 1 < rule.states ? s + 1 : 0;
      }
  return out;
}


describe('rules', () => {
  it('parses 3D rule strings', () => {
    const r = parseRule3('0-2,5/1,3/4/VN');
    expect(r).toEqual({ survive: 0b100111, birth: 0b1010, states: 4, nb: 'vn' });
    expect(() => parseRule3('0-9/1/2/VN')).toThrow();
  });

  it('describes neighbour counts in words', () => {
    expect(countsText(parseRule3('4/4/5/M').birth, 26)).toBe('exactly 4');
    expect(countsText(parseRule3('0/1,3/2/VN').birth, 6)).toBe('1 or 3');
    expect(countsText(parseRule3('9-26/5-7,12-13,15/5/M').birth, 26)).toBe('5 to 7, 12, 13 or 15');
    expect(countsText(parseRule3('9-26/5/5/M').survive, 26)).toBe('9 or more');
    expect(describeRule2(parseRule2('B3/S23'))).toContain('exactly 3 live neighbours comes alive; a live one survives with 2 or 3');
  });

  it('parses 2D rule strings', () => {
    expect(parseRule2('B3/S23')).toEqual({ birth: 0b1000, survive: 0b1100 });
  });
});

describe('Grid3', () => {
  /** The unbounded grid's states over a naive grid's box (offset so world 0 sits at index `off`). */
  const dump = (g: Grid3, n: number, off: number) => {
    const out = new Uint8Array(n ** 3);
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const id = g.cellAt(x - off, y - off, z - off);
          out[x + n * (y + n * z)] = id < 0 ? 0 : g.state(id);
        }
    return out;
  };

  for (const [name, src] of [
    ['445', '4/4/5/M'],
    ['crystal', '0-6/1,3/2/VN'],
    ['builder', '2,6,9/4,6,8-9/10/M'],
  ] as const) {
    it(`matches a reference step (${name}), across chunk edges and negative coordinates`, () => {
      const rule = parseRule3(src);
      // A random 9³ block round the origin; 12 generations can't reach the reference's walls.
      const n = 37;
      const off = 18;
      const rng = new Rng(11);
      const g = new Grid3(rule.nb);
      const ref0 = new Uint8Array(n ** 3);
      for (let z = -4; z <= 4; z++)
        for (let y = -4; y <= 4; y++)
          for (let x = -4; x <= 4; x++)
            if (rng.chance(0.3)) {
              g.set(x, y, z, 1);
              ref0[x + off + n * (y + off + n * (z + off))] = 1;
            }
      let ref: Uint8Array<ArrayBufferLike> = ref0;
      for (let k = 0; k < 12; k++) {
        g.step(rule);
        ref = naiveStep(n, ref, rule);
        expect(dump(g, n, off)).toEqual(ref);
      }
    });
  }

  it('keeps a symmetric seed symmetric', () => {
    const rule = parseRule3(CRYSTAL_PRESETS.shells.rule);
    const g = new Grid3(rule.nb);
    // Mirror images about the centre (-½) are x and -1 - x.
    for (const [x, y, z] of symmetricSeed(32, new Rng(3), { size: 3, density: 0.4, symmetry: 'cubic' })) g.set(x - 16, y - 16, z - 16, 1);
    for (let k = 0; k < 15; k++) g.step(rule);
    expect(g.empty).toBe(false);
    const at = (x: number, y: number, z: number) => {
      const id = g.cellAt(x, y, z);
      return id < 0 ? 0 : g.state(id);
    };
    for (let z = -20; z < 20; z++)
      for (let y = -20; y < 20; y++)
        for (let x = -20; x < 20; x++) {
          const v = at(x, y, z);
          expect(at(-1 - x, y, z)).toBe(v);
          expect(at(y, x, z)).toBe(v);
          expect(at(z, y, x)).toBe(v);
        }
  });
});

describe('Life2', () => {
  const life = parseRule2('B3/S23');

  it('blinks a blinker', () => {
    const b = new Life2(8, false);
    for (const x of [2, 3, 4]) b.set(x, 3, 1);
    const w = new CycleWatch();
    for (let k = 0; k < 6; k++) {
      b.step(life);
      w.push(b.hash());
    }
    expect(w.period()).toBe(2);
  });

  it('flies a glider round a torus', () => {
    const b = new Life2(16, true);
    for (const [x, y] of [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]) b.set(x, y, 1);
    const before = b.hash();
    for (let k = 0; k < 64; k++) b.step(life);
    // 4 generations per diagonal cell: after 64 it's back where it started.
    expect(b.hash()).toBe(before);
  });

  it('runs diehard to nothing in 130 generations', () => {
    const b = new Life2(64, false);
    for (const [x, y] of lifeStart('diehard', 64, new Rng(1))) b.set(x, y, 1);
    let alive = 7;
    let gen = 0;
    while (alive > 0 && gen < 200) {
      alive = b.step(life).alive;
      gen++;
    }
    expect(gen).toBe(130);
  });
});

describe('modes', () => {
  const theme = getTheme('neon-dark');
  const melody = getMelody('ode-to-joy');
  const run = (params: Record<string, unknown>, seed: number, visual = false) =>
    new Runner(automata3d, { seed, params, theme, melody, visual, maxSeconds: 90 }).runToEnd();
  const hash = (r: Runner) => hashString(JSON.stringify(r.events));

  for (const params of [
    { mode: 'tower', pattern: 'diehard' },
    { mode: 'war', warSize: 28 },
    { mode: 'war', warSize: 28, warRule: 'cyclic', arena: 'cube' },
  ]) {
    it(`${JSON.stringify(params)} is deterministic and ends on time`, () => {
      const a = run(params, 4);
      expect(hash(run(params, 4))).toBe(hash(a));
      expect(hash(run(params, 4, true))).toBe(hash(a));
      expect(a.timedOut).toBe(false);
      expect(a.events.some((e) => e.type.endsWith(':end'))).toBe(true);
    });
  }

  it('grows a crystal with no walls', () => {
    // Frost grows about a cell a generation: 60 generations take it well past the old 64-cell cube.
    const r = run({ mode: 'crystal', preset: 'frost', generations: 60 }, 9);
    const end = r.events.find((e) => e.type === 'crystal:end')!;
    const gens = r.events.filter((e) => e.type === 'crystal:gen');
    expect([end.kind, end.gen, gens.length]).toEqual(['cap', 60, 60]);
    expect(end.radius).toBeGreaterThan(50);
    expect(gens.at(-1)!.alive).toBeGreaterThan(0);
  });

  it('runs the R-pentomino to its true end on an endless board', () => {
    // On an infinite plane it settles after 1,103 generations, throwing off six gliders that fly on.
    const end = run({ mode: 'tower', pattern: 'r-pentomino' }, 1).events.find((e) => e.type === 'tower:end')!;
    expect(end.kind).toBe('escape');
    expect(end.gen).toBeGreaterThanOrEqual(1103);
    expect(end.gen).toBeLessThanOrEqual(1110);
  });

  it('lasts as long as Diehard should', () => {
    const end = run({ mode: 'tower', pattern: 'diehard' }, 1).events.find((e) => e.type === 'tower:end')!;
    expect([end.kind, end.gen]).toEqual(['dead', 130]);
  });

  it('follows a hand-set generation count and pace', () => {
    // Diehard at 5 a second: 130 generations take 26 s, after the 1.4 s intro.
    const slow = run({ mode: 'tower', pattern: 'diehard', genRate: 5 }, 1).events.find((e) => e.type === 'tower:end')!;
    expect(slow.gen).toBe(130);
    expect(slow.t).toBeCloseTo(1.4 + 26, 1);
    // Cut short at 50: still going.
    const cut = run({ mode: 'tower', pattern: 'diehard', generations: 50 }, 1).events.find((e) => e.type === 'tower:end')!;
    expect([cut.kind, cut.gen]).toEqual(['cap', 50]);
    const crystal = run({ mode: 'crystal', preset: 'frost', generations: 12, genRate: 4 }, 1).events.filter((e) => e.type === 'crystal:gen');
    expect(crystal.length).toBe(12);
    expect(crystal[11].t).toBeCloseTo(1.4 + 3, 1);
    // War: 60 generations at 20 a second is a 3 s match.
    const war = run({ mode: 'war', warSize: 28, generations: 60, genRate: 20 }, 1).events;
    expect(war.filter((e) => e.type === 'war:gen').length).toBeLessThanOrEqual(60);
    expect(war.find((e) => e.type === 'war:end')!.t).toBeLessThan(3.1);
  });

  describe('captions', () => {
    const captions = (params: Record<string, unknown>, seed = 1) => {
      const r = run({ ...params, captions: true }, seed);
      const st = r.state as { mode: 'crystal' | 'tower' | 'war'; inner: unknown };
      return { r, caps: MODE_IMPLS[st.mode].captions(st.inner) };
    };

    it("don't change the run", () => {
      for (const params of [{ mode: 'tower', pattern: 'diehard' }, { mode: 'war', warSize: 28 }, { mode: 'crystal', preset: 'frost', generations: 20 }]) {
        expect(hash(run({ ...params, captions: true }, 4))).toBe(hash(run(params, 4)));
      }
    });

    it('say how a tower run actually ends', () => {
      const diehard = captions({ mode: 'tower', pattern: 'diehard' }).caps;
      expect(diehard.at(-1)!.text).toContain('vanish');
      const r = captions({ mode: 'tower', pattern: 'r-pentomino' }).caps.map((c) => c.text);
      expect(r.some((t) => t.includes('gliders: little 5-cell shapes'))).toBe(true);
      expect(r.at(-1)).toContain('settle');
      // A torus has nowhere to fly off to.
      const torus = captions({ mode: 'tower', pattern: 'r-pentomino', wrap: true, board: 96 }).caps.map((c) => c.text);
      expect(torus.some((t) => t.includes('donut'))).toBe(true);
      expect(torus.some((t) => t.includes('forever') && t.includes('glider'))).toBe(false);
    });

    it("describe the crystal's own rule and seed", () => {
      const frost = captions({ mode: 'crystal', preset: 'frost', symmetry: 'mirror' }).caps.map((c) => c.text);
      expect(frost[0]).toContain('mirrored 8 ways');
      // Frost has 5 states: alive, 3 fading stages, empty.
      expect(frost.some((t) => t.includes('through 3 stages'))).toBe(true);
      const crystal = captions({ mode: 'crystal', preset: 'crystal' }).caps.map((c) => c.text);
      expect(crystal.some((t) => t.includes('stages'))).toBe(false);
    });

    it('come in order, with time to read each, within the run', () => {
      for (const params of [{ mode: 'crystal', preset: 'frost' }, { mode: 'tower', pattern: 'acorn' }, { mode: 'tower', pattern: 'diehard' }]) {
        const { r, caps } = captions(params);
        const end = r.events.find((e) => e.type.endsWith(':end'))!;
        for (let k = 1; k < caps.length; k++) expect(caps[k].at - caps[k - 1].at).toBeGreaterThanOrEqual(CAPTION_GAP - 1e-9);
        expect(caps.at(-1)!.at).toBeLessThan(end.t);
      }
    });

    it('call out who beats whom in a rock-paper-scissors war', () => {
      const texts = captions({ mode: 'war', warSize: 28, warRule: 'cyclic' }).caps.map((c) => c.text);
      expect(texts).toContain('Each colour can only take the one it beats: Blue takes Red, Gold takes Blue, Red takes Gold.');
    });
  });

  it('keeps colony counts equal to the cells they hold', () => {
    const r = run({ mode: 'war', warSize: 28, finalRush: false }, 2);
    const gens = r.events.filter((e) => e.type === 'war:gen');
    const end = r.events.find((e) => e.type === 'war:end')!;
    const counts = gens.at(-1)!.counts as number[];
    // Without the rush nothing leaves the arena once it's full: the total only ever grows.
    for (let k = 1; k < gens.length; k++) expect((gens[k].counts as number[]).reduce((a, b) => a + b)).toBeGreaterThanOrEqual((gens[k - 1].counts as number[]).reduce((a, b) => a + b));
    expect(counts[end.winner as number]).toBe(Math.max(...counts));
  });
});
