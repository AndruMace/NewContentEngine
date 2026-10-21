import { describe, expect, it } from 'vitest';
import { THREE } from '../../three-layer';
import { CREATURES } from '../roster';
import type { FighterView } from '../index';
import { ProcRig, restPose, triangleCount } from './rig';
import { SPECIES } from './species';
import { PROC_POSES, wounded } from './poses';
import { Rng } from '@sim/engine';
import { creatureById } from '../roster';
import { makeWorld, stepWorld } from '../sim';
import { viewOf } from '../index';
import { stage } from './stage';
import { spotOf, spotWorld, strikeParts } from './contact';

const procs = CREATURES;

/** A fighter snapshot in a given state (the poses read only these fields). */
function view(def: (typeof procs)[number], over: Partial<FighterView>): FighterView {
  return {
    idx: 0,
    side: 0,
    def,
    x: 0,
    y: 0,
    heading: 0,
    alive: true,
    state: 'idle',
    stateT: 0,
    moveIdx: -1,
    hp: 1,
    maxHp: 1,
    flash: 0,
    burn: 0,
    diedAt: -1,
    number: 0,
    engaged: true,
    target: 1,
    spd: 0,
    gait: 0,
    yawRate: 0,
    crouch: 0,
    grab: null,
    heldBy: -1,
    lastHitT: -10,
    lastHitDir: 0,
    lastHitPow: 0,
    dodgeDir: 1,
    hurt: { head: 0, body: 0, wing: 0, LF: 0, RF: 0, LH: 0, RH: 0 },
    wounds: [],
    aim: null,
    evadeT: -10,
    downLen: 1.2,
    fallDir: 1,
    hover: def.hover ?? 0,
    ...over,
  };
}

/** Every bone and leg segment of a posed rig has a finite transform. */
function finite(rig: ProcRig) {
  let ok = true;
  rig.root.updateMatrixWorld(true);
  rig.root.traverse((o) => {
    for (const v of o.matrixWorld.elements) if (!Number.isFinite(v)) ok = false;
  });
  return ok;
}

describe('procedural creatures', () => {
  it.each(Object.keys(SPECIES))('%s stays within the triangle budget', (id) => {
    const tris = triangleCount(SPECIES[id as keyof typeof SPECIES]);
    expect(tris).toBeGreaterThan(1000);
    expect(tris).toBeLessThan(5000);
  });

  it.each(procs.map((c) => [c.id, c] as const))('%s poses cleanly in every state and move', (_id, def) => {
    const rig = new ProcRig(SPECIES[def.proc.kind]);
    const foe = view(def, { idx: 1, x: 3, side: 1, target: 0 });
    const states: Partial<FighterView>[] = [
      {},
      { spd: def.walk, gait: 0.3 },
      { spd: def.run, gait: 0.7 },
      { crouch: 1 },
      { state: 'stagger', stateT: 0.9, lastHitT: 0.9, lastHitPow: 2, lastHitDir: 1 },
      { state: 'down', stateT: 0.5, downLen: 1.2 },
      { evadeT: 0.5 },
      { spd: def.walk, gait: 0.4, hurt: { head: 0.3, body: 0.3, wing: 0.4, LF: 0.4, RF: 0, LH: 0, RH: 0.3 }, hp: 0.1, hover: 0 },
      { alive: false, state: 'dead', diedAt: 0.2 },
      ...def.moves.map((_, i) => ({ state: 'attack' as const, moveIdx: i, stateT: 0.5 })),
      ...(['latch', 'roll', 'pin'] as const).map((kind) => ({ state: 'grab' as const, grab: { kind, target: 1, t0: 0.6, until: 3, next: 1, dps: 10, side: 1 as const, aim: { zone: 'body' as const, side: 1 as const, u: 0.8, v: 0.1 }, ticks: 0 } })),
    ];
    for (const st of states)
      for (const simT of [0.55, 0.8, 1.1, 1.6]) {
        const f = view(def, st);
        rig.root.position.set(f.x, 0, f.y);
        const p = PROC_POSES[def.proc.kind](f, simT, [f, foe]);
        wounded(p, f, simT);
        rig.pose(p);
        expect(finite(rig), `${JSON.stringify(st)} @ ${simT}`).toBe(true);
      }
    // Held by someone else.
    const roller = view(def, { idx: 1, state: 'grab', grab: { kind: 'roll', target: 0, t0: 0.5, until: 3, next: 1, dps: 10, side: 1, aim: { zone: 'fore', side: 1, u: 0.3, v: 0.5 }, ticks: 0 } });
    rig.pose(PROC_POSES[def.proc.kind](view(def, { state: 'held', heldBy: 1 }), 1, [roller]));
    expect(finite(rig)).toBe(true);
  });

  it('plants the feet: a standing pose leaves every paw on the ground', () => {
    for (const spec of Object.values(SPECIES)) {
      const rig = new ProcRig(spec);
      rig.pose(restPose());
      rig.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(rig.root);
      expect(box.min.y).toBeGreaterThan(-0.08);
      expect(box.min.y).toBeLessThan(0.08);
    }
  });

  it('blows that land touch: the striking part is on the spot it hit at the impact', () => {
    const misses: number[] = [];
    for (const [a, b] of [['bear', 'lion'], ['horse', 'king'], ['wolf', 'deer'], ['croc', 'unicorn'], ['swordsman', 'brawler']])
      for (const seed of [1, 2]) {
        const w = makeWorld({ mode: 'duel', a: creatureById(a), b: creatureById(b), hpScale: 1, capS: 32, maxSwarm: 30, rng: new Rng(seed) });
        const rigs = new Map(w.fighters.map((f) => [f.idx, new ProcRig(SPECIES[f.def.proc.kind])]));
        let n = 0;
        while (w.winner < 0 && w.fightT < 40 && n < 12) {
          const hits: { a: number; b: number; wound: number }[] = [];
          stepWorld(w, 1 / 120, (e) => {
            if (e.type === 'hit') hits.push(e as never);
          });
          for (const h of hits) {
            const f = w.fighters[h.a];
            const o = w.fighters[h.b];
            if (!f.alive || f.state !== 'attack' || !f.move) continue;
            const parts = strikeParts(f.def, f.move, Math.max(0, f.hitIdx - 1));
            if (!parts.length) continue;
            stage(rigs, w.fighters.map(viewOf), w.simT, false);
            const spot = spotOf(rigs.get(o.idx)!, o.wounds[h.wound]);
            if (!spot) continue;
            const P = spotWorld(spot, new THREE.Vector3());
            const rig = rigs.get(f.idx)!;
            misses.push(Math.min(...parts.map((p) => (p.kind === 'paw' ? rig.pawWorld(p.limb) : p.kind === 'sword' ? rig.propTip('sword') : rig.headPoint(p.kind)).distanceTo(P))));
            n++;
          }
        }
      }
    misses.sort((x, y) => x - y);
    expect(misses.length).toBeGreaterThan(40);
    expect(misses[Math.floor(misses.length * 0.5)]).toBeLessThan(0.12);
    expect(misses[Math.floor(misses.length * 0.75)]).toBeLessThan(0.3);
  });
});
