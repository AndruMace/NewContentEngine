import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { SHAPES, dft, reconstructionError } from './fourier';
import { fourierDrawing } from './index';

describe('fourier drawing', () => {
  it('ships well-formed shapes', () => {
    expect(new Set(SHAPES.map((s) => s.id)).size).toBe(SHAPES.length);
    for (const cat of ['country', 'state', 'dinosaur', 'animal', 'fantasy']) expect(SHAPES.filter((s) => s.category === cat).length).toBeGreaterThanOrEqual(8);
    for (const s of SHAPES) {
      expect(s.points.length).toBe(800);
      expect(s.points.every((v) => Number.isInteger(v) && Math.abs(v) <= 500)).toBe(true);
      expect(s.name && s.icon).toBeTruthy();
    }
  });

  it('gets closer with every stage and exact with every circle', () => {
    for (const s of SHAPES.filter((_, i) => i % 5 === 0)) {
      const { centre, terms } = dft(s.points);
      const errs = [1, 2, 4, 8, 16, 32, 64, 128].map((k) => reconstructionError(s.points, centre, terms, k));
      for (let i = 1; i < errs.length; i++) expect(errs[i]).toBeLessThanOrEqual(errs[i - 1] + 1e-9);
      expect(reconstructionError(s.points, centre, terms, terms.length)).toBeLessThan(1e-9);
    }
  });

  it('asks about the right kind of thing', () => {
    for (const [subject, hook] of [['states', 'Guess which US state the circles are drawing?'], ['dinosaurs', 'Guess which dinosaur the circles are drawing?']]) {
      const r = new Runner(fourierDrawing, { seed: 2, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), visual: false, params: { subject } });
      expect(fourierDrawing.hud(r.state).guess).toBe(hook);
    }
  });

  it('plays every stage, then reveals the answer', () => {
    const r = new Runner(fourierDrawing, { seed: 4, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), visual: false, params: { subject: 'countries' } }).runToEnd();
    expect(r.timedOut).toBe(false);
    const stages = r.events.filter((e) => e.type === 'stage').map((e) => e.circles as number);
    expect(stages[0]).toBe(1);
    expect(stages[stages.length - 1]).toBe(200);
    const reveal = r.events.find((e) => e.type === 'reveal');
    expect(SHAPES.find((s) => s.id === reveal?.shape)?.category).toBe('country');
  });
});
