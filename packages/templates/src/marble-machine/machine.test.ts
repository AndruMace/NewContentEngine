import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { MELODIES } from '@sim/audio';
import { DOMINO, barContact } from './machine';
import { ROUTE_GAP, ROUTES } from './routes';
import { MARBLE_MACHINE_CAMERAS, marbleMachine } from './index';

const run = (melodyId: string, params: Record<string, unknown> = {}) =>
  new Runner(marbleMachine, { seed: 1, theme: getTheme('neon-dark'), melody: MELODIES.find((m) => m.id === melodyId)!, params, visual: false }).runToEnd();

describe('marble machine', () => {
  it.each(MELODIES.map((m) => m.id))('%s: every note is struck once, on its beat', (id) => {
    for (const camera of MARBLE_MACHINE_CAMERAS) {
      const r = run(id, { camera });
      const s = r.state;
      const lands = r.events.filter((e) => e.type === 'land');
      expect(lands.map((e) => e.i)).toEqual(s.onsets.map((_, i) => i));
      for (const e of lands) expect(Math.abs(e.t - s.onsets[e.i as number].t)).toBeLessThan(1 / 240 + 1e-9);
    }
  });

  it.each(MELODIES.map((m) => m.id))('%s: every marble lands on its bar at its note, and routes never overfill', (id) => {
    const s = run(id).state;
    for (const d of s.sched.drops) {
      const at = d.path.at(d.t);
      const want = barContact(s.channels[d.ch], d.r);
      expect(Math.hypot(at.x - want.x, at.y - want.y, at.z - want.z)).toBeLessThan(1e-6);
      expect(d.release).toBeGreaterThanOrEqual(0);
      // Segments run end to end in time.
      for (let k = 1; k < d.path.segs.length; k++) expect(d.path.segs[k].t0).toBeCloseTo(d.path.segs[k - 1].t1, 9);
    }
    for (const kind of ROUTES) {
      const entries = s.sched.drops.filter((d) => d.route === kind).map((d) => d.release).sort((a, b) => a - b);
      for (let k = 1; k < entries.length; k++) expect(entries[k] - entries[k - 1]).toBeGreaterThanOrEqual(ROUTE_GAP[kind] - 1e-9);
    }
  });

  it('sends plenty of marbles through the contraptions, not just straight drops', () => {
    const s = run('ode-to-joy').state;
    const showpieces = s.sched.drops.filter((d) => d.route !== 'direct').length;
    expect(showpieces / s.sched.drops.length).toBeGreaterThan(0.4);
    for (const kind of ['helix', 'seesaw', 'loop', 'zigzag']) expect(s.sched.drops.some((d) => d.route === kind)).toBe(true);
  });

  it('sets off the dominoes with the final marble and rings the bell at the reveal', () => {
    for (const id of ['ode-to-joy', 'fur-elise', 'twinkle']) {
      const s = run(id).state;
      const dom = s.sched.dominoes!;
      expect(dom).not.toBeNull();
      expect(dom.start + (dom.n - 1) * DOMINO.dt + DOMINO.fall).toBeCloseTo(s.revealAt, 9);
      const last = s.sched.drops.find((d) => d.final)!;
      expect(last.i).toBe(s.onsets.length - 1);
      // The final marble reaches the first domino exactly as the run starts.
      const touch = last.path.at(dom.start);
      expect(Math.abs(touch.x - (dom.x0 - dom.dir * (DOMINO.t / 2 + last.r)))).toBeLessThan(1e-6);
    }
  });

  it('brings in the bass marbles partway through, and only when asked', () => {
    const withBass = run('ode-to-joy', { bass: true });
    const without = run('ode-to-joy', { bass: false });
    expect(withBass.events.filter((e) => e.type === 'bassLand').length).toBeGreaterThan(3);
    expect(without.events.filter((e) => e.type === 'bassLand')).toHaveLength(0);
    expect(withBass.events.find((e) => e.type === 'bassEnter')!.t).toBeLessThan(withBass.events.find((e) => e.type === 'bassLand')!.t);
  });
});
