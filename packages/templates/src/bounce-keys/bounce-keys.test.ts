import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { MELODIES, getMelody } from '@sim/audio';
import { bounceKeys } from './index';
import { arcAt, buildTimeline, solveArc, tonicOf } from './timeline';

const theme = getTheme('neon-dark');
const run = (melodyId: string, params: Record<string, unknown> = {}, seed = 1) =>
  new Runner(bounceKeys, { seed, theme, melody: getMelody(melodyId), params, visual: false }).runToEnd();

describe('timeline', () => {
  it('ends on a phrase that comes home to the tonic, close to the asked length', () => {
    for (const m of MELODIES) {
      const tl = buildTimeline(m, 0, 27);
      const last = tl.onsets.at(-1)!;
      const lastStep = [last.midi, ...last.bass];
      // Canon in D is a ground bass that never cadences; anything else must end at home.
      if (m.id !== 'canon-in-d') expect(lastStep.some((n) => n % 12 === tonicOf(m)), m.id).toBe(true);
      expect(last.t, m.id).toBeGreaterThan(27 * 0.7);
      expect(last.t, m.id).toBeLessThan(27 * 1.3);
    }
  });

  it('solves hops that land exactly on target and peak above both ends', () => {
    const a = solveArc(100, 900, 400, 1000, 2, 0.4, 700);
    const end = arcAt(a, 2.4);
    expect(end.x).toBeCloseTo(400, 6);
    expect(end.y).toBeCloseTo(1000, 6);
    const apexT = -a.vy / a.g;
    expect(a.y0 + a.vy * apexT + 0.5 * a.g * apexT * apexT).toBeCloseTo(700, 6);
  });
});

describe('bounce keys', () => {
  it.each(['cascade', 'keys'])('lands every note on its beat (%s)', (style) => {
    for (const m of MELODIES) {
      const r = run(m.id, { style });
      const onsets = r.state.onsets;
      const lands = r.events.filter((e) => e.type === 'land');
      expect(lands, m.id).toHaveLength(onsets.length);
      lands.forEach((e, i) => {
        // Events are stamped at the start of the 1/240 s substep the landing falls in.
        expect(onsets[i].t - e.t, m.id).toBeGreaterThanOrEqual(0);
        expect(onsets[i].t - e.t, m.id).toBeLessThan(1 / 240 + 1e-9);
        expect(e.midi).toBe(onsets[i].midi);
      });
    }
  });

  it.each(['cascade', 'keys'])('hops end on the landing points and rise above them (%s)', (style) => {
    for (const id of ['fur-elise', 'toccata', 'saints']) {
      const s = run(id, { style }).state;
      s.arcs.forEach((a, i) => {
        const end = arcAt(a, a.t0 + a.dt);
        expect(end.x).toBeCloseTo(s.lands[i].x, 6);
        expect(end.y).toBeCloseTo(s.lands[i].y, 6);
        const apexT = Math.max(0, -a.vy / a.g);
        const apexY = a.y0 + a.vy * apexT + 0.5 * a.g * apexT * apexT;
        expect(apexY).toBeLessThanOrEqual(Math.min(a.y0, s.lands[i].y) + 1e-6);
      });
    }
  });

  it('makes a video close to the asked length for every song', () => {
    for (const m of MELODIES) {
      const r = run(m.id);
      expect(r.timedOut, m.id).toBe(false);
      // Phrases are whole and the tempo only stretches so far, so some songs land further off.
      expect(r.durationS, m.id).toBeGreaterThan(32 * 0.75);
      expect(r.durationS, m.id).toBeLessThan(32 * 1.25);
    }
  });

  it('reveals the song after the last note and names it in the hud', () => {
    const r = run('jingle-bells');
    const lastLand = r.events.filter((e) => e.type === 'land').at(-1)!;
    const reveal = r.events.find((e) => e.type === 'reveal')!;
    expect(reveal.t).toBeGreaterThan(lastLand.t);
    const hud = bounceKeys.hud(r.state);
    expect(hud.answer).toBe('Jingle Bells');
    expect(hud.outro).toBe(true);
  });

  it('brings in the bass ball partway through, and leaves it out when off', () => {
    const r = run('ode-to-joy');
    const bass = r.events.filter((e) => e.type === 'bassLand');
    expect(bass.length).toBeGreaterThan(3);
    expect(bass[0].t).toBeGreaterThan(r.durationS * 0.3);
    expect(run('ode-to-joy', { bassBall: false }).events.some((e) => e.type === 'bassLand')).toBe(false);
  });

  it('plays the chosen voice, or the theme\'s', () => {
    const notes = (params: Record<string, unknown>) => run('twinkle', params).audio.filter((a) => a.kind === 'note' && a.voice !== 'softsine' && a.voice !== 'pluck');
    expect(new Set(notes({ voice: 'bell' }).map((a) => a.kind === 'note' && a.voice))).toEqual(new Set(['bell']));
    expect(new Set(notes({}).map((a) => a.kind === 'note' && a.voice))).toEqual(new Set([theme.voice]));
  });

  it('builds its run from the melody, so a new song is a new run', () => {
    expect(bounceKeys.melodyDriven).toBe(true);
    expect(run('twinkle').durationS).not.toBe(run('fur-elise').durationS);
  });
});
