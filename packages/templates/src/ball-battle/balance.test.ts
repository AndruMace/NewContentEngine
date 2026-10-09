import { describe, expect, it } from 'vitest';
import { Runner, getTheme, hashString } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { ballBattle } from './index';
import { WEAPON_IDS } from './weapons';

const theme = getTheme('neon-dark');
const melody = getMelody('ode-to-joy');
const run = (params: Record<string, unknown>, seed: number, visual = false) => new Runner(ballBattle, { seed, theme, melody, visual, params }).runToEnd();

describe('ball battle', () => {
  it('keeps weapons balanced in 1v1s', () => {
    const wins: Record<string, number> = {};
    const games: Record<string, number> = {};
    for (let seed = 0; seed < 300; seed++) {
      const r = run({ format: 'ffa', fighters: 2, weapons: 'mixed' }, seed);
      const s = r.state as { fighters: { weapon: { id: string } }[] };
      const win = r.events.find((e) => e.type === 'win');
      s.fighters.forEach((f, i) => {
        games[f.weapon.id] = (games[f.weapon.id] ?? 0) + 1;
        if (win?.who === i) wins[f.weapon.id] = (wins[f.weapon.id] ?? 0) + 1;
      });
    }
    for (const w of WEAPON_IDS) {
      const rate = (wins[w] ?? 0) / games[w];
      expect(rate, w).toBeGreaterThan(0.38);
      expect(rate, w).toBeLessThan(0.62);
    }
  }, 60_000);

  it.each(['ffa', 'teams', 'giant', 'bracket'])('%s: finishes, is deterministic, and visuals never change the fight', (format) => {
    for (const seed of [1, 2, 3]) {
      const a = run({ format, teams: 'countries' }, seed, true);
      const b = run({ format, teams: 'countries' }, seed, false);
      expect(a.timedOut).toBe(false);
      expect(hashString(JSON.stringify(a.events))).toBe(hashString(JSON.stringify(b.events)));
      expect(a.events.some((e) => e.type === 'win')).toBe(true);
    }
  });

  it('rolls damage within each weapon range, replayably', () => {
    const r = run({ format: 'ffa', fighters: 4 }, 11);
    const hits = r.events.filter((e) => e.type === 'hit');
    const ranges: Record<string, [number, number]> = { sword: [9, 11], dagger: [5, 7], hammer: [11, 14], bow: [5, 6] };
    for (const h of hits) {
      const [lo, hi] = ranges[h.weapon as string];
      expect(h.dmg as number).toBeGreaterThanOrEqual(lo);
      expect(h.dmg as number).toBeLessThanOrEqual(hi);
    }
    expect(new Set(hits.map((h) => h.dmg)).size).toBeGreaterThan(3);
    expect(run({ format: 'ffa', fighters: 4 }, 11).events.map((e) => e.dmg)).toEqual(r.events.map((e) => e.dmg));
  });

  it('freezes on hits, shrinks the arena and slows down for the final blow', () => {
    const r = run({ format: 'ffa', fighters: 2 }, 4);
    expect(r.events.some((e) => e.type === 'shrink')).toBe(true);
    const s = r.state as { simT: number; t: number };
    // Hit freeze and slow motion make sim time lag video time.
    expect(s.simT).toBeLessThan(s.t - 0.5);
    const noFx = run({ format: 'ffa', fighters: 2, hitFreeze: 0, slowMotion: false }, 4).state as { simT: number; t: number };
    expect(noFx.simT).toBeCloseTo(noFx.t, 1);
  });

  it('runs a three-match bracket', () => {
    const r = run({ format: 'bracket' }, 5);
    expect(r.events.filter((e) => e.type === 'matchStart')).toHaveLength(3);
    expect(r.events.filter((e) => e.type === 'matchEnd')).toHaveLength(3);
    const final = r.events.filter((e) => e.type === 'matchStart')[2];
    const semis = r.events.filter((e) => e.type === 'matchEnd').slice(0, 2).map((e) => e.winner);
    expect([final.a, final.b]).toEqual(semis);
  });
});
