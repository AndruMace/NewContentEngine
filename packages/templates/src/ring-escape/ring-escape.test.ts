import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { ringEscape } from './index';

const theme = getTheme('neon-dark');
const melody = getMelody('ode-to-joy');

describe('ring-escape physics', () => {
  it('never tunnels: the ball stays inside the current ring until it breaks', () => {
    for (let seed = 0; seed < 40; seed++) {
      const r = new Runner(ringEscape, {
        seed,
        theme,
        melody,
        visual: false,
        params: { ringCount: 30, maxSpeed: 3500, speedBoostPerBreak: 1.1, ballRadius: 8, ringThickness: 3 },
        maxSeconds: 60,
      });
      while (!r.done) {
        r.advanceFrame();
        const s = r.state;
        if (s.escapedAt !== null) break;
        const ring = s.rings[s.current];
        const d = Math.hypot(s.ball.x - s.cx, s.ball.y - s.cy);
        expect(d).toBeLessThan(ring.r + ring.th + s.ball.r);
      }
    }
  });

  it('default params usually escape within a reasonable time', () => {
    let escaped = 0;
    for (let seed = 0; seed < 30; seed++) {
      const r = new Runner(ringEscape, { seed, theme, melody, visual: false, maxSeconds: 120 }).runToEnd();
      if (!r.timedOut) escaped++;
    }
    expect(escaped).toBeGreaterThan(25);
  });
});
