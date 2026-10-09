import { describe, expect, it } from 'vitest';
import * as dm from './math';

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-14 * Math.max(1, Math.abs(b));

describe('deterministic math', () => {
  it('matches Math.* to ~1e-14 across the ranges sims use', () => {
    for (let i = 0; i < 20000; i++) {
      const x = (i / 20000 - 0.5) * 800;
      expect(close(dm.sin(x), Math.sin(x))).toBe(true);
      expect(close(dm.cos(x), Math.cos(x))).toBe(true);
      const y = ((i * 7919) % 20000) / 20000 - 0.5;
      expect(close(dm.atan2(y, x), Math.atan2(y, x))).toBe(true);
      const e = (i / 20000 - 0.5) * 60;
      expect(Math.abs(dm.exp(e) - Math.exp(e)) <= 1e-14 * Math.exp(e)).toBe(true);
      const l = 1e-6 + i * 0.37;
      expect(close(dm.log(l), Math.log(l))).toBe(true);
    }
    expect(close(dm.pow(0.42, 0.8), Math.pow(0.42, 0.8))).toBe(true);
    expect(close(dm.asin(0.3), Math.asin(0.3))).toBe(true);
  });
});
