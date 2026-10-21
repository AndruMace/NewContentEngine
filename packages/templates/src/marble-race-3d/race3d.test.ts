import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { THREE } from '../three-layer';
import { runRace } from './race';
import { marbleRace3d } from './index';
import { FOV, cameraPose, marbleAt } from './view3d';

const run = (params: Record<string, unknown>, seed: number) =>
  new Runner(marbleRace3d, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params, visual: false });

describe('marble race 3d', () => {
  it.each([
    ['elimination', 8],
    ['elimination', 16],
    ['race', 12],
  ] as const)('%s with %i marbles: every race runs to a winner, nobody leaves the track', (mode, marbles) => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = runRace(new Rng(seed), { mode, marbles, sections: mode === 'race' ? 5 : Math.min(marbles - 1, 6), lanesPerSection: 3, density: 1, spinnerSpeed: 2.2 });
      expect(r.timedOut).toBe(false);
      expect(r.lost).toBe(0);
      expect(r.winner).toBeGreaterThanOrEqual(0);
      if (mode === 'elimination') expect(r.events.filter((e) => e.type === 'eliminate')).toHaveLength(marbles - 1);
      else expect(r.events.filter((e) => e.type === 'finish').length).toBeGreaterThan(0);
      // Watchable lengths, and not held together by nudges.
      expect(r.winStep / 240).toBeGreaterThan(12);
      expect(r.winStep / 240).toBeLessThan(60);
      expect(r.kicks).toBeLessThan(25);
      r.sim.free();
    }
  });

  it.each(['trapdoor', 'wheel', 'jump', 'lift'] as const)('%s: races run through it in every section, with no one lost or stuck', (kind) => {
    for (let seed = 1; seed <= 2; seed++) {
      const r = runRace(new Rng(seed), { mode: 'race', marbles: 8, sections: 4, lanesPerSection: 3, density: 1, spinnerSpeed: 2.2, specials: [kind], specialChance: 1 });
      expect(r.timedOut).toBe(false);
      expect(r.lost).toBe(0);
      expect(r.kicks).toBeLessThan(15);
      r.sim.free();
    }
  });

  it('race mode waits for the podium: 1st, 2nd and 3rd all cross before the end', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const r = runRace(new Rng(seed), { mode: 'race', marbles: 8, sections: 4, lanesPerSection: 3, density: 1, spinnerSpeed: 2.2 });
      const finishes = r.events.filter((e) => e.type === 'finish');
      expect(finishes.slice(0, 3).map((e) => e.place)).toEqual([1, 2, 3]);
      const podium = r.events.find((e) => e.type === 'podium')!;
      expect(podium.step).toBe(finishes[2].step);
      expect(r.podiumStep).toBeGreaterThanOrEqual(r.winStep);
      r.sim.free();
    }
  });

  it('never builds a join through track already there (seed 972661: a helix through an elevator jammed it)', () => {
    for (const [mode, marbleCount] of [['race', 4], ['elimination', 5]] as const) {
      const s = run({ mode, marbleCount }, 972661).state;
      expect(s.winner).toBeGreaterThanOrEqual(0);
      expect(s.steps / 240).toBeGreaterThan(12);
    }
  });

  it('plays the background tune or none, as set', () => {
    const music = (sound: string) => run({ marbleCount: 5, sound }, 2).runToEnd().events.filter((e) => e.type === 'music').length;
    expect(music('background')).toBeGreaterThan(10);
    expect(music('effects')).toBe(0);
    expect(music('melody')).toBe(0);
  });

  it('plays the same tape every time', () => {
    const a = run({ marbleCount: 6 }, 3).runToEnd();
    const b = run({ marbleCount: 6 }, 3).runToEnd();
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.events.some((e) => e.type === 'win')).toBe(true);
  });

  it('keeps the race in shot', () => {
    const cam = new THREE.PerspectiveCamera(FOV, 1080 / 1920, 0.02, 20);
    for (const seed of [1, 2]) {
      const s = run({ marbleCount: 8 }, seed).state;
      const inFrame = (p: THREE.Vector3) => {
        const q = p.clone().project(cam);
        return Math.abs(q.x) < 0.95 && Math.abs(q.y) < 0.95;
      };
      let seen = 0;
      let total = 0;
      const end = s.steps / 240;
      for (let t = 0; t < end; t += 1 / 15) {
        const { pos, look } = cameraPose(s, t);
        cam.position.copy(pos);
        cam.lookAt(look);
        cam.updateMatrixWorld();
        const f = Math.min(s.progress.length - 1, Math.round(t * 60));
        const prog = s.progress[f];
        // The leader (of those still racing) at this moment.
        const out = new Set(s.events.filter((e) => e.type === 'eliminate' && e.step <= t * 240).map((e) => e.who as number));
        const lead = [...prog.keys()].filter((i) => !out.has(i)).sort((a, b) => prog[b] - prog[a])[0];
        total++;
        if (inFrame(marbleAt(s, lead, t))) seen++;
        // The winner is always in shot once the race is won.
        if (t * 240 >= s.winStep) expect(inFrame(marbleAt(s, s.winner, t))).toBe(true);
      }
      // The leader is on screen nearly all the time (elimination rounds frame the whole field).
      expect(seen / total).toBeGreaterThan(0.85);
    }
  });
});
