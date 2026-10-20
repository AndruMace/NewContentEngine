import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { hpScaleFor } from './balance';
import { CREATURES, DUELS, HORDES, MODEL_FILES, creatureById, matchupId } from './roster';
import { makeWorld, stepWorld } from './sim';

const MODELS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../assets/ambient/models/creatures');

/** Clip lengths by name, read from a GLB's JSON chunk. */
function clipsOf(model: string): Map<string, number> {
  const b = readFileSync(join(MODELS, `${model}.glb`));
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  const acc = json.accessors;
  return new Map((json.animations ?? []).map((a: { name: string; samplers: { input: number }[] }) => [a.name, Math.max(...a.samplers.map((s) => acc[s.input].max[0]))]));
}

describe('roster matches the models', () => {
  it.each(CREATURES.map((c) => [c.id, c] as const))('%s: every clip exists, at the length the sim assumes', (_id, c) => {
    const clips = clipsOf(c.model);
    const named = [c.clips.idle, c.clips.walk, c.clips.run, c.clips.death, ...c.clips.hit, ...(c.dodge ? [c.dodge.left, c.dodge.right] : [])];
    for (const name of named) expect(clips.has(name), name).toBe(true);
    for (const [name, len] of Object.entries(c.clips.lens)) expect(clips.get(name), name).toBeCloseTo(len, 2);
    for (const m of c.moves) {
      expect(clips.get(m.clip), `${m.name} (${m.clip})`).toBeCloseTo(m.len, 2);
      for (const h of m.hits) expect(h.at).toBeGreaterThan(0);
    }
    if (c.dodge) expect(clips.get(c.dodge.left)).toBeCloseTo(c.dodge.len, 2);
  });

  it('has every model file it loads', () => {
    for (const m of MODEL_FILES) expect(() => readFileSync(join(MODELS, `${m}.glb`))).not.toThrow();
  });

  it('has unique matchups of known fighters', () => {
    const ids = [...DUELS, ...HORDES].map(([a, b]) => matchupId(a, b));
    expect(new Set(ids).size).toBe(ids.length);
    for (const [a, b] of [...DUELS, ...HORDES]) expect(() => [creatureById(a), creatureById(b)]).not.toThrow();
  });
});

function fight(mode: 'duel' | 'horde', a: string, b: string, seed: number, maxSwarm = 30) {
  const w = makeWorld({ mode, a: creatureById(a), b: creatureById(b), hpScale: hpScaleFor(16), capS: 32, maxSwarm, rng: new Rng(seed) });
  while (w.winner < 0 && w.fightT < 120) stepWorld(w, 1 / 120, () => {});
  return w;
}

describe('fights', () => {
  it.each(DUELS.map(([a, b]) => [a, b] as const))('%s vs %s always ends, and either can win', (a, b) => {
    let aWins = 0;
    const N = 40;
    for (let seed = 1; seed <= N; seed++) {
      const w = fight('duel', a, b, seed);
      expect(w.winner, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      if (w.winner === 0) aWins++;
    }
    // Curated duels are contests, not foregone conclusions.
    expect(aWins).toBeGreaterThan(0);
    expect(aWins).toBeLessThan(N);
  });

  it.each(HORDES.map(([a, b]) => [a, b] as const))('%s vs a horde of %s ends with a count in range', (a, b) => {
    for (let seed = 1; seed <= 10; seed++) {
      const w = fight('horde', a, b, seed, 30);
      expect(w.winner, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(w.swarm!.sent).toBeGreaterThanOrEqual(1);
      expect(w.swarm!.sent).toBeLessThanOrEqual(30);
    }
  });
});
