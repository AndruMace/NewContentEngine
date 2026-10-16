import { describe, expect, it } from 'vitest';
import { Runner, getTheme, hashString } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { spinBattle } from './index';
import { TOP_TYPES } from './tops';

const theme = getTheme('neon-dark');
const melody = getMelody('ode-to-joy');
const run = (params: Record<string, unknown>, seed: number, visual = false) => new Runner(spinBattle, { seed, theme, melody, visual, params }).runToEnd();

describe('spin battle', () => {
  it('keeps the top types balanced in duels', () => {
    const wins: Record<string, number> = {};
    const games: Record<string, number> = {};
    const kinds: Record<string, number> = {};
    for (let seed = 0; seed < 400; seed++) {
      const r = run({ format: 'duel', matchup: 'random' }, seed);
      expect(r.timedOut).toBe(false);
      const win = r.events.find((e) => e.type === 'win')!;
      kinds[win.kind === 'spin' ? 'spin' : 'over'] = (kinds[win.kind === 'spin' ? 'spin' : 'over'] ?? 0) + 1;
      r.state.tops.forEach((t, i) => {
        games[t.type] = (games[t.type] ?? 0) + 1;
        if (win.who === i) wins[t.type] = (wins[t.type] ?? 0) + 1;
      });
    }
    for (const type of TOP_TYPES) {
      const rate = (wins[type] ?? 0) / games[type];
      expect(rate, type).toBeGreaterThan(0.4);
      expect(rate, type).toBeLessThan(0.6);
    }
    // Both ways of losing actually happen.
    expect(kinds.spin, 'spin finishes').toBeGreaterThan(60);
    expect(kinds.over, 'over finishes').toBeGreaterThan(60);
  }, 120_000);

  it.each(['attack-defense', 'attack-stamina', 'defense-stamina'])('%s is close to a coin flip', (matchup) => {
    const [a] = matchup.split('-');
    let aWins = 0;
    const n = 160;
    for (let seed = 0; seed < n; seed++) {
      const r = run({ format: 'duel', matchup }, seed);
      const win = r.events.find((e) => e.type === 'win')!;
      if (r.state.tops[win.who as number].type === a) aWins++;
    }
    expect(aWins / n).toBeGreaterThan(0.36);
    expect(aWins / n).toBeLessThan(0.64);
  }, 60_000);

  it('keeps the types balanced when the tops spin opposite ways', () => {
    const wins: Record<string, number> = {};
    const games: Record<string, number> = {};
    for (let seed = 0; seed < 400; seed++) {
      const r = run({ format: 'duel', spins: 'opposite' }, seed);
      const win = r.events.find((e) => e.type === 'win')!;
      expect(r.state.tops[0].dir).toBe(-r.state.tops[1].dir);
      r.state.tops.forEach((t, i) => {
        games[t.type] = (games[t.type] ?? 0) + 1;
        if (win.who === i) wins[t.type] = (wins[t.type] ?? 0) + 1;
      });
    }
    for (const type of TOP_TYPES) {
      const rate = (wins[type] ?? 0) / games[type];
      expect(rate, type).toBeGreaterThan(0.38);
      expect(rate, type).toBeLessThan(0.62);
    }
  }, 120_000);

  it.each(['3', '4'])('free-for-all with %s tops: eliminated one at a time, deterministic', (players) => {
    for (const seed of [1, 2, 3]) {
      const a = run({ format: 'ffa', players }, seed, true);
      const b = run({ format: 'ffa', players }, seed, false);
      expect(a.timedOut).toBe(false);
      expect(hashString(JSON.stringify(a.events))).toBe(hashString(JSON.stringify(b.events)));
      expect(a.state.tops).toHaveLength(Number(players));
      const elims = a.events.filter((e) => e.type === 'elim').map((e) => e.who);
      const win = a.events.find((e) => e.type === 'win')!;
      // Everyone but the winner goes out, once each (the last one with the final finish).
      const last = a.events.find((e) => e.type === 'finish')!.loser;
      expect(new Set([...elims, last]).size).toBe(Number(players) - 1);
      expect([...elims, last]).not.toContain(win.who);
    }
  });

  it('gives every type a fair chance in a 4-top free-for-all', () => {
    const wins: Record<string, number> = {};
    const games: Record<string, number> = {};
    for (let seed = 0; seed < 300; seed++) {
      const r = run({ format: 'ffa', players: '4' }, seed);
      const win = r.events.find((e) => e.type === 'win')!;
      r.state.tops.forEach((t, i) => {
        games[t.type] = (games[t.type] ?? 0) + 1;
        if (win.who === i) wins[t.type] = (wins[t.type] ?? 0) + 1;
      });
    }
    // A fair share is 0.25.
    for (const type of TOP_TYPES) {
      const rate = (wins[type] ?? 0) / games[type];
      expect(rate, type).toBeGreaterThan(0.14);
      expect(rate, type).toBeLessThan(0.36);
    }
  }, 120_000);

  it('replays the deciding moment before the outro', () => {
    const on = run({ format: 'duel', replay: true }, 4);
    const off = run({ format: 'duel', replay: false }, 4);
    const types = (r: typeof on) => r.events.map((e) => e.type);
    expect(types(on)).toContain('replay');
    expect(types(on)).toContain('replayFinish');
    expect(types(off)).not.toContain('replay');
    expect(on.durationS).toBeGreaterThan(off.durationS + 2);
    // The fight itself is identical either way.
    const fight = (r: typeof on) => JSON.stringify(r.events.filter((e) => !e.type.startsWith('replay')));
    expect(fight(on)).toBe(fight(off));
  });

  it.each(['duel', 'points'])('%s: finishes, is deterministic, and visuals never change the fight', (format) => {
    for (const seed of [1, 2, 3]) {
      const a = run({ format, identity: 'named' }, seed, true);
      const b = run({ format, identity: 'named' }, seed, false);
      expect(a.timedOut).toBe(false);
      expect(hashString(JSON.stringify(a.events))).toBe(hashString(JSON.stringify(b.events)));
      expect(a.events.some((e) => e.type === 'win')).toBe(true);
    }
  });

  it('points matches are won by reaching the target (or leading at the round cap)', () => {
    let draws = 0;
    let finishes = 0;
    for (let seed = 0; seed < 60; seed++) {
      const r = run({ format: 'points', targetPoints: 3 }, seed);
      expect(r.timedOut).toBe(false);
      const win = r.events.find((e) => e.type === 'win')!;
      const score = win.score as number[];
      const w = win.who as number;
      expect(score[w]).toBeGreaterThanOrEqual(score[1 - w]);
      const rounds = r.events.filter((e) => e.type === 'finish');
      finishes += rounds.length;
      draws += rounds.filter((e) => e.kind === 'draw').length;
      if (rounds.length < 6) expect(score[w]).toBeGreaterThanOrEqual(3);
    }
    expect(draws / finishes).toBeLessThan(0.1);
  }, 60_000);
});
