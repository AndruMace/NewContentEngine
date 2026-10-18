import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { inKeepOut } from './course';
import { trickShot } from './index';

const run = (seed: number, params: Record<string, unknown> = {}) =>
  new Runner(trickShot, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params, visual: false });

describe('trick shot', () => {
  it('places every obstacle, leaving the column above the cup clear', () => {
    for (let seed = 0; seed < 40; seed++) {
      for (const obstacles of [28, 40]) {
        const { course } = run(seed, { obstacles, spinners: 2, mix: seed % 2 ? 'boards' : 'mixed' }).state;
        expect(course.obstacles.length).toBe(obstacles + 2);
        for (const o of course.obstacles) for (const part of o.parts) expect(inKeepOut(part, course.cup)).toBe(false);
      }
    }
  });

  it('attempts mode: misses close in on the cup and the planned last shot goes in', () => {
    let firstMiss = 0;
    let lastMiss = 0;
    for (let seed = 0; seed < 20; seed++) {
      const r = run(seed, { mode: 'attempts' }).runToEnd();
      const plan = r.state.plan;
      if (!plan) continue;
      const misses = r.events.filter((e) => e.type === 'miss').map((e) => Math.abs(e.err as number));
      // The live run replays the test shots exactly, so it lands on the planned attempt.
      expect(r.events.find((e) => e.type === 'sink')?.attempt).toBe(plan.length);
      firstMiss += misses[0];
      lastMiss += misses[misses.length - 1];
    }
    expect(lastMiss).toBeLessThan(firstMiss * 0.5);
  });

  it('race mode: the winner reaches the cups to win first', () => {
    for (const seed of [1, 2, 3]) {
      const r = run(seed, { mode: 'race', racePoints: 2 }).runToEnd();
      const s = r.state;
      if (!s.success) continue;
      const winner = s.shots[s.winner].cannon;
      expect(s.points[winner]).toBe(2);
      for (let k = 0; k < s.points.length; k++) if (k !== winner) expect(s.points[k]).toBeLessThan(2);
    }
  });

  it('bounce mode never ends with the ball outside the cup', () => {
    for (const seed of [4, 5, 6]) {
      const r = run(seed).runToEnd();
      if (r.timedOut) continue;
      const { body } = r.state.shots[r.state.winner];
      const { cup } = r.state.course;
      expect(Math.hypot(body.x - cup.x, body.z - cup.z)).toBeLessThan(cup.r);
    }
  });
});
