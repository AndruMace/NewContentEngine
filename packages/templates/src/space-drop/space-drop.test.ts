import { describe, expect, it } from 'vitest';
import { spaceDrop } from '.';
import { air, shockTemperature } from './atmosphere';
import { crater, impactEnergy } from './impact';
import { OBJECTS, objectById, rodBody } from './objects';
import { findEvent, simulate, type Start } from './physics';
import { sayEvents } from '../story';
import { fakeVoice, runStory } from '../story/testing';

const drop = (km: number): Start => ({ mode: 'drop', altitude: km * 1000, angle: 0, speed: 0 });
const orbit = (angle: number): Start => ({ mode: 'orbit', altitude: 300_000, angle, speed: 0 });
const meteor = (kms: number, angle: number): Start => ({ mode: 'meteor', altitude: 0, angle, speed: kms * 1000 });

describe('atmosphere', () => {
  it('matches the 1976 US Standard Atmosphere', () => {
    expect(air(0).rho).toBeCloseTo(1.225, 3);
    expect(air(0).T).toBeCloseTo(288.15, 2);
    expect(air(11000).T).toBeCloseTo(216.8, 0);
    expect(air(11000).rho).toBeCloseTo(0.3648, 3);
    expect(air(30000).rho / 0.01841).toBeCloseTo(1, 2);
    expect(air(50000).rho / 1.027e-3).toBeCloseTo(1, 1);
    expect(air(100000).rho / 5.604e-7).toBeCloseTo(1, 2);
    expect(air(0).a).toBeCloseTo(340.3, 0);
  });

  it('puts equilibrium shock-layer air near 7,000 K at orbital speed and ~11,000 K on a lunar return', () => {
    expect(shockTemperature(7800, 230)).toBeGreaterThan(6500);
    expect(shockTemperature(7800, 230)).toBeLessThan(7600);
    expect(shockTemperature(11000, 230)).toBeGreaterThan(10000);
    expect(shockTemperature(11000, 230)).toBeLessThan(12000);
  });
});

describe('falls', () => {
  it('a penny settles at its measured terminal speed (about 11 m/s)', () => {
    const tr = simulate(objectById('penny').body, drop(100));
    expect(tr.impact!.v).toBeGreaterThan(9);
    expect(tr.impact!.v).toBeLessThan(14);
  });

  it('from rest at 100 km, anything reaches about 1 km/s before the air takes over', () => {
    // Free fall from 100 km down to ~40 km is ~1.1 km/s; drag shaves a little off.
    for (const id of ['sedan', 'anvil', 'cow']) {
      const vmax = findEvent(simulate(objectById(id).body, drop(100)), 'maxSpeed')!.v;
      expect(vmax).toBeGreaterThan(850);
      expect(vmax).toBeLessThan(1150);
    }
  });

  it('a Chelyabinsk-size asteroid (19 m, 19 km/s, 18°) bursts in the air at 20–35 km with hundreds of kilotons', () => {
    const tr = simulate(objectById('asteroid').body, meteor(19, 18), { T0: 250 });
    expect(tr.airburst).not.toBeNull();
    expect(tr.airburst!.alt).toBeGreaterThan(20000);
    expect(tr.airburst!.alt).toBeLessThan(35000);
    const kt = tr.airburst!.energy / 4.184e12;
    expect(kt).toBeGreaterThan(200);
    expect(kt).toBeLessThan(600);
    // A meteorite still reaches the ground, at a few hundred km/h (dark flight).
    expect(tr.impact!.v).toBeLessThan(400);
  });

  it('a satellite breaks up near the 78 km rule of thumb, leaving its titanium tank', () => {
    const tr = simulate(objectById('satellite').body, orbit(3));
    expect(tr.breakup!.alt).toBeGreaterThan(65000);
    expect(tr.breakup!.alt).toBeLessThan(85000);
    expect(tr.impact!.body.name).toBe('titanium fuel tank');
  });

  it('a point-first tungsten rod from orbit barely slows; tumbling, it falls far slower', () => {
    const nose = simulate(rodBody(9000, 'nose'), orbit(5));
    const tumble = simulate(rodBody(9000, 'tumble'), orbit(5));
    expect(nose.impact!.v).toBeGreaterThan(4000);
    expect(tumble.impact!.v).toBeLessThan(nose.impact!.v / 4);
    // Its nose sits at tungsten's melting point and melts back a little.
    expect(nose.maxTs).toBeCloseTo(3695, 0);
    expect(nose.massLost).toBeGreaterThan(0);
    expect(nose.massLost).toBeLessThan(0.2);
  });

  it('heavier rods hit harder', () => {
    const e = [500, 9000, 100000].map((m) => impactEnergy(simulate(rodBody(m, 'nose'), orbit(5))));
    expect(e[1]).toBeGreaterThan(e[0] * 10);
    expect(e[2]).toBeGreaterThan(e[1] * 10);
  });

  it('every object falls to an end from every way in', () => {
    for (const o of OBJECTS)
      for (const start of [drop(100), orbit(4)]) {
        const tr = simulate(o.body, start);
        expect(tr.end === 'impact' || tr.end === 'burnup').toBe(true);
        expect(tr.t[tr.t.length - 1]).toBeLessThan(6 * 3600);
        for (const v of tr.v) expect(Number.isFinite(v)).toBe(true);
      }
  });
});

describe('craters', () => {
  it('scale with energy, and dig deeper into sand than into granite', () => {
    const small = crater(9000, 19250, 1000, 90, 'sand');
    const big = crater(9000, 19250, 6000, 90, 'sand');
    // In sand, diameter grows as U^(2μ/(2+μ)) = U^0.34: six times the speed, 1.84 times as wide.
    expect(big.diameter / small.diameter).toBeCloseTo(6 ** (0.82 / 2.41), 1);
    expect(crater(9000, 19250, 3000, 90, 'sand').diameter).toBeGreaterThan(crater(9000, 19250, 3000, 90, 'rock').diameter);
    // A 9 t rod at 3 km/s into granite: ~10 t of TNT, a crater about 15 m across.
    const d = crater(9000, 19250, 3000, 90, 'rock').diameter;
    expect(d).toBeGreaterThan(8);
    expect(d).toBeLessThan(30);
  });
});

describe('space drop', () => {
  it.each([{}, { object: 'sedan' }, { object: 'asteroid' }, { object: 'penny', start: 'orbit' }, { mode: 'versus' }, { mode: 'versus', versusA: 'tungsten-rod', versusB: 'penny', versusC: 'cow', start: 'drop' }])(
    '%j: lands near its length and every beat has its facts',
    (params) => {
      const r = runStory(spaceDrop, params, 1);
      expect(r.timedOut).toBe(false);
      expect(r.durationS).toBeGreaterThan(35);
      expect(r.durationS).toBeLessThan(80);
      for (const b of sayEvents(r.events)) for (const k of b.required) expect(b.facts).toHaveProperty(k);
    },
  );

  it.each([{}, { mode: 'versus', versusA: 'tungsten-rod', versusB: 'cow', start: 'drop' }])('%j: the same fall and facts however long the lines run', (params) => {
    const short = runStory(spaceDrop, params, 2, fakeVoice(spaceDrop, params, 2, 0.7));
    const long = runStory(spaceDrop, params, 2, fakeVoice(spaceDrop, params, 2, 1.8));
    expect(sayEvents(short.events)).toEqual(sayEvents(long.events));
    const happenings = (r: typeof short) => r.events.filter((e) => e.type.startsWith('drop:') && e.type !== 'drop:drone' && e.type !== 'drop:roar').map(({ t: _t, ...e }) => e);
    expect(happenings(short)).toEqual(happenings(long));
  });

  it('the asteroid on auto comes in as Chelyabinsk did, and bursts', () => {
    const r = runStory(spaceDrop, { object: 'asteroid' }, 1);
    expect(r.events.some((e) => e.type === 'drop:airburst')).toBe(true);
  });
});
