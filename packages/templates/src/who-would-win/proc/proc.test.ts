import { describe, expect, it } from 'vitest';
import { THREE } from '../../three-layer';
import { CREATURES } from '../roster';
import type { FighterView } from '../index';
import { ProcRig, restPose, triangleCount } from './rig';
import { SPECIES } from './species';
import { PROC_POSES } from './poses';

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
    dodgeDir: 1,
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
      { state: 'stagger', stateT: 0.9, lastHitT: 0.9 },
      { alive: false, state: 'dead', diedAt: 0.2 },
      ...def.moves.map((_, i) => ({ state: 'attack' as const, moveIdx: i, stateT: 0.5 })),
      ...(['latch', 'roll', 'pin'] as const).map((kind) => ({ state: 'grab' as const, grab: { kind, target: 1, t0: 0.6, until: 3, next: 1, dps: 10, side: 1 as const } })),
    ];
    for (const st of states)
      for (const simT of [0.55, 0.8, 1.1, 1.6]) {
        const f = view(def, st);
        rig.root.position.set(f.x, 0, f.y);
        rig.pose(PROC_POSES[def.proc.kind](f, simT, [f, foe]));
        expect(finite(rig), `${JSON.stringify(st)} @ ${simT}`).toBe(true);
      }
    // Held by someone else.
    const roller = view(def, { idx: 1, state: 'grab', grab: { kind: 'roll', target: 0, t0: 0.5, until: 3, next: 1, dps: 10, side: 1 } });
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
});
