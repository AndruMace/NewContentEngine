import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme, hashString } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { automata3d } from './index';
import { CycleWatch, Grid3, Life2 } from './grid';
import { CRYSTAL_PRESETS, parseRule2, parseRule3, type Rule3 } from './rules';
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

const dump = (g: Grid3) => {
  const out = new Uint8Array(g.n ** 3);
  for (let z = 0; z < g.n; z++) for (let y = 0; y < g.n; y++) for (let x = 0; x < g.n; x++) out[x + g.n * (y + g.n * z)] = g.get(x, y, z);
  return out;
};

describe('rules', () => {
  it('parses 3D rule strings', () => {
    const r = parseRule3('0-2,5/1,3/4/VN');
    expect(r).toEqual({ survive: 0b100111, birth: 0b1010, states: 4, nb: 'vn' });
    expect(() => parseRule3('0-9/1/2/VN')).toThrow();
  });

  it('parses 2D rule strings', () => {
    expect(parseRule2('B3/S23')).toEqual({ birth: 0b1000, survive: 0b1100 });
  });
});

describe('Grid3', () => {
  for (const [name, src] of [
    ['445', '4/4/5/M'],
    ['crystal', '0-6/1,3/2/VN'],
    ['builder', '2,6,9/4,6,8-9/10/M'],
  ] as const) {
    it(`matches a reference step (${name}), including at the cube's faces`, () => {
      const rule = parseRule3(src);
      const n = 9;
      const rng = new Rng(11);
      const g = new Grid3(n);
      for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (rng.chance(0.3)) g.set(x, y, z, 1);
      let ref: Uint8Array<ArrayBufferLike> = dump(g);
      for (let k = 0; k < 12; k++) {
        g.step(rule);
        ref = naiveStep(n, ref, rule);
        expect(dump(g)).toEqual(ref);
      }
    });
  }

  it('keeps a symmetric seed symmetric', () => {
    const preset = CRYSTAL_PRESETS.shells;
    const rule = parseRule3(preset.rule);
    const n = 32;
    const g = new Grid3(n);
    for (const [x, y, z] of symmetricSeed(n, new Rng(3), { size: 3, density: 0.4, symmetry: 'cubic' })) g.set(x, y, z, 1);
    for (let k = 0; k < 15; k++) g.step(rule);
    expect(g.empty).toBe(false);
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const v = g.get(x, y, z);
          expect(g.get(n - 1 - x, y, z)).toBe(v);
          expect(g.get(y, x, z)).toBe(v);
          expect(g.get(z, y, x)).toBe(v);
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

  it('plays the crystal it planned', () => {
    // The run is planned on one copy of the seed and played on another: they must be the same seed.
    const r = run({ mode: 'crystal', preset: 'frost', size: 40 }, 9);
    const end = r.events.find((e) => e.type === 'crystal:end')!;
    const last = r.events.filter((e) => e.type === 'crystal:gen').at(-1)!;
    expect(end.kind).toBe('edge');
    expect(last.gen).toBe(end.gen);
    expect(last.alive).toBeGreaterThan(0);
  });

  it('lasts as long as Diehard should', () => {
    const end = run({ mode: 'tower', pattern: 'diehard' }, 1).events.find((e) => e.type === 'tower:end')!;
    expect([end.kind, end.gen]).toEqual(['dead', 130]);
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
