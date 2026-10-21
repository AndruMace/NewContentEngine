import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { hpScaleFor } from './balance';
import { CREATURES, DUELS, HORDES, creatureById, matchupId } from './roster';
import { condition, makeWorld, stepWorld } from './sim';

/** The motions each kind of body has a pose for (proc/poses.ts). */
const MOTIONS: Record<string, string[]> = {
  lion: ['swipe', 'bite', 'pounce', 'roar'],
  bear: ['swipe', 'rear', 'bite', 'charge', 'maul', 'roar'],
  croc: ['lunge', 'snap', 'tail'],
  mammal: ['headbutt', 'charge', 'bite', 'buck', 'combo', 'toss', 'swat', 'stomp', 'roar'],
  human: ['slash', 'kick', 'punch_l', 'punch_r', 'chop', 'club', 'bash', 'backhand', 'stomp', 'pummel', 'beat', 'grapple', 'bite', 'charge'],
  dragon: ['bite', 'breath'],
  griffin: ['bite', 'swipe', 'dive'],
  spider: ['bite', 'leap'],
};
const bodyOf = (kind: string) =>
  kind in MOTIONS ? kind : kind === 'tiger' ? 'lion' : ['swordsman', 'king', 'brawler', 'gorilla', 'minotaur', 'troll', 'viking'].includes(kind) ? 'human' : 'mammal';

describe('roster', () => {
  it.each(CREATURES.map((c) => [c.id, c] as const))('%s: every move has a pose and lands within its length', (_id, c) => {
    for (const m of c.moves) {
      expect(MOTIONS[bodyOf(c.proc.kind)], `${m.name} (${m.clip})`).toContain(m.clip);
      for (const h of m.hits) expect(h.at).toBeGreaterThan(0);
      for (const h of m.hits) expect(h.at).toBeLessThan(1);
    }
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

describe('injuries', () => {
  it('blows leave wounds where they land, and add up to injuries', () => {
    const w = fight('duel', 'bear', 'lion', 3);
    const loser = w.fighters.find((f) => !f.alive)!;
    expect(loser.wounds.length).toBeGreaterThan(3);
    for (const wd of loser.wounds) {
      expect(['head', 'body', 'fore', 'hind', 'wing']).toContain(wd.zone);
      expect(wd.t).toBeGreaterThan(0);
    }
    const c = condition(loser);
    expect(Math.max(c.leg, c.head, c.body, c.arm)).toBeGreaterThan(0.3);
  });

  it('a crippled leg slows a fighter down', () => {
    const run = (hurt: number) => {
      const w = makeWorld({ mode: 'duel', a: creatureById('horse'), b: creatureById('wolf'), hpScale: 2, capS: 32, maxSwarm: 30, rng: new Rng(5) });
      const f = w.fighters[0];
      f.hurt.LF = hurt;
      // (Far apart: it closes in at a run.)
      f.x = -9;
      w.fighters[1].x = 9;
      const x0 = f.x;
      for (let i = 0; i < 180; i++) stepWorld(w, 1 / 120, () => {});
      return f.x - x0;
    };
    expect(run(0.4)).toBeLessThan(run(0) * 0.8);
  });
});
