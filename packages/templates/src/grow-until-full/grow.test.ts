import { describe, expect, it } from 'vitest';
import { Runner, getTheme, hashString } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { growUntilFull } from './index';
import { bodyContact } from './arena';

const theme = getTheme('neon-dark');
const melody = getMelody('ode-to-joy');
const run = (params: Record<string, unknown>, seed = 3, visual = false) =>
  new Runner(growUntilFull, { seed, theme, melody, visual, params, maxSeconds: 90 }).runToEnd();

describe.each(['single', 'crowd', 'mitosis'])('%s mode', (mode) => {
  it.each(['circle', 'square', 'hexagon', 'triangle'])('fills a %s within the usual video lengths', (arena) => {
    const r = run({ mode, arena });
    expect(r.timedOut).toBe(false);
    const full = r.events.find((e) => e.type === 'full')!;
    expect(full.t).toBeGreaterThan(12);
    expect(full.t).toBeLessThan(60);
  });

  it('is deterministic, and visual-only work does not change physics', () => {
    const h = (seed: number, visual: boolean) => hashString(JSON.stringify(run({ mode, arena: 'hexagon' }, seed, visual).events));
    expect(h(11, false)).toBe(h(11, false));
    expect(h(12, true)).toBe(h(12, false));
  });
});

describe('modes', () => {
  it('crowd: the biggest ball wins', () => {
    const r = run({ mode: 'crowd', balls: 5 });
    const s = r.state;
    const biggest = Math.max(...s.balls.map((b) => b.r));
    expect(s.balls[s.winner].r).toBe(biggest);
    expect(r.events.find((e) => e.type === 'full')!.winner).toBe(s.balls[s.winner].team!.label);
  });

  it('mitosis: splits keep the area and vary the final count across seeds', () => {
    const counts = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const r = run({ mode: 'mitosis' }, seed);
      expect(r.events.filter((e) => e.type === 'split').length).toBe(r.state.balls.length - 1);
      counts.add(r.state.balls.length);
    }
    expect(counts.size).toBeGreaterThan(1);
  });

  it.each(['square', 'hexagon', 'triangle'])('single: a %s ball ends up filling its matching arena', (arena) => {
    const { state } = run({ arena });
    const b = state.balls[0];
    expect(b.r / state.arena.inR).toBeGreaterThan(0.97);
    expect(Math.hypot(b.x - state.arena.cx, b.y - state.arena.cy)).toBeLessThan(1);
  });

  it.each([
    ['square', 4],
    ['hexagon', 3],
    ['triangle', 3],
  ] as const)('crowd: %s pieces bounce their way to filling the arena', (arena, count) => {
    const c = { nx: 0, ny: 0 };
    for (let seed = 1; seed <= 4; seed++) {
      const { state, events } = run({ mode: 'crowd', arena }, seed);
      const { balls, fit } = state;
      expect(balls).toHaveLength(count);
      expect(events.find((e) => e.type === 'full')!.share).toBeGreaterThan(0.999);
      for (const b of balls) expect(b.r).toBeCloseTo(fit!.r / 1.025, 6);
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) expect(bodyContact(state.arena, balls[i], balls[j], c)).toBeLessThan(1);
    }
  });

  it('crowd: four squares fill the square arena', () => {
    const { state } = run({ mode: 'crowd', arena: 'square' });
    const area = state.balls.reduce((a, b) => a + (2 * b.r) ** 2, 0);
    expect(area / (2 * state.arena.inR) ** 2).toBeGreaterThan(0.95);
  });

  it.each(['mitosis', 'crowd'])('%s: square balls never end up wedged into each other', (mode) => {
    const c = { nx: 0, ny: 0 };
    for (let seed = 1; seed <= 6; seed++) {
      const r = new Runner(growUntilFull, { seed, theme, melody, visual: false, params: { mode, arena: 'square' }, maxSeconds: 90 });
      let worst = 0;
      while (!r.done) {
        r.advanceFrame();
        const { arena, balls } = r.state;
        for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) worst = Math.max(worst, bodyContact(arena, balls[i], balls[j], c) / Math.min(balls[i].r, balls[j].r));
      }
      expect(worst).toBeLessThan(0.2);
    }
  });

  it('balls never leave a polygon arena', () => {
    const r = new Runner(growUntilFull, { seed: 5, theme, melody, visual: false, params: { mode: 'crowd', arena: 'triangle' }, maxSeconds: 90 });
    let worst = 0;
    while (!r.done) {
      r.advanceFrame();
      const { arena, balls } = r.state;
      for (const b of balls)
        for (let k = 0; k < arena.ux.length; k++) worst = Math.max(worst, (b.x - arena.cx) * arena.ux[k] + (b.y - arena.cy) * arena.uy[k] + b.r - arena.inR);
    }
    expect(worst).toBeLessThan(1);
  });
});
