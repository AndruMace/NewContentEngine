import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { hpScaleFor } from './balance';
import { whoWouldWin } from './index';
import { CREATURES, DUELS, DUEL_FAVOURITES, HORDES, creatureById, grownTo, matchupId } from './roster';
import { condition, makeWorld, stepWorld } from './sim';

/** The motions each kind of body has a pose for (proc/poses.ts). */
const MOTIONS: Record<string, string[]> = {
  lion: ['swipe', 'bite', 'pounce', 'roar'],
  bear: ['swipe', 'rear', 'bite', 'charge', 'maul', 'roar'],
  croc: ['lunge', 'snap', 'tail'],
  mammal: ['headbutt', 'charge', 'bite', 'buck', 'combo', 'toss', 'swat', 'stomp', 'roar', 'frenzy'],
  human: ['slash', 'kick', 'punch_l', 'punch_r', 'chop', 'club', 'bash', 'backhand', 'stomp', 'pummel', 'beat', 'grapple', 'bite', 'charge', 'whirl'],
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

  it('names who ought to win every curated duel', () => {
    for (const [a, b] of DUELS) {
      const fav = DUEL_FAVOURITES[matchupId(a, b)];
      expect(fav === null || fav === a || fav === b, matchupId(a, b)).toBe(true);
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
  it.each(DUELS.map(([a, b]) => [a, b] as const))('%s vs %s always ends, and the one that ought to win usually does', (a, b) => {
    let aWins = 0;
    const N = 40;
    for (let seed = 1; seed <= N; seed++) {
      const w = fight('duel', a, b, seed);
      expect(w.winner, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      if (w.winner === 0) aWins++;
    }
    // The favourite wins most of the time (the dragon nearly always); a toss-up is close to even.
    const fav = DUEL_FAVOURITES[matchupId(a, b)];
    const [lo, hi] = fav === null ? [0.3, 0.7] : fav === a ? [0.6, 0.97] : [0.03, 0.4];
    expect(aWins).toBeGreaterThanOrEqual(N * lo);
    expect(aWins).toBeLessThanOrEqual(N * hi);
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

describe('formats', () => {
  const run = (params: Record<string, unknown>, seed: number) => {
    const r = new Runner(whoWouldWin, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), visual: false, params: { fightLength: 12, ...params } });
    r.runToEnd();
    return { r, win: r.events.find((e) => e.type === 'win'), bouts: r.events.filter((e) => e.type === 'bout'), fights: r.events.filter((e) => e.type === 'fight') };
  };

  it('teams: two on two, fought to a finish', () => {
    for (const seed of [1, 2, 3]) {
      const { r, win } = run({ mode: 'team' }, seed);
      expect(r.timedOut).toBe(false);
      expect(win?.mode).toBe('team');
      expect(String(win?.left).split('+')).toHaveLength(2);
      expect(String(win?.right).split('+')).toHaveLength(2);
    }
  });

  it('tournament: two semi-finals, then a final between their winners', () => {
    for (const seed of [1, 2]) {
      const { r, win, bouts, fights } = run({ mode: 'tournament', highlightsSemi2: true }, seed);
      expect(r.timedOut).toBe(false);
      expect(fights).toHaveLength(3);
      expect(bouts).toHaveLength(2);
      const through = bouts.map((b) => (b.side === 0 ? b.a : b.b));
      expect([win?.a, win?.b]).toEqual(through);
      expect(win?.champ).toBe(win?.side === 0 ? win?.a : win?.b);
    }
  });

  it('gauntlet: the challenger fights on until it loses or beats them all', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { r, win, bouts, fights } = run({ mode: 'gauntlet', gauntletSize: 3 }, seed);
      expect(r.timedOut).toBe(false);
      // Every fight before the last was won by the challenger.
      for (const b of bouts) expect(b.side).toBe(0);
      expect(fights).toHaveLength(bouts.length + 1);
      expect(win?.beaten).toBe(bouts.length + (win?.side === 0 ? 1 : 0));
    }
  });

  it('pound for pound: the smaller one grows to the bigger one\'s weight', () => {
    const fox = creatureById('fox');
    const big = grownTo(fox, creatureById('bull').mass);
    expect(big.mass).toBe(creatureById('bull').mass);
    expect(big.scale).toBeCloseTo(Math.cbrt(big.mass / fox.mass));
    expect(big.height).toBeCloseTo(fox.height * big.scale!);
    expect(big.hp).toBeGreaterThan(fox.hp);
    const { r, win } = run({ mode: 'duel', matchup: 'custom', fighterA: 'fox', fighterB: 'bull', poundForPound: true }, 1);
    expect(r.timedOut).toBe(false);
    expect(win).toBeTruthy();
  });

  it('highlights are shorter than the same fights played in full', () => {
    const full = run({ mode: 'tournament' }, 3).r.t;
    const fast = run({ mode: 'tournament', highlightsSemi1: true, highlightsSemi2: true, highlightsFinal: true }, 3).r.t;
    expect(fast).toBeLessThan(full);
  });
});
