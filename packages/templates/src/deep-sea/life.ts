/**
 * Sea life for Deep Sea Submarine: every population the depth has (schedule.ts), built by its kind's
 * module in fauna/, plus the whale passing far off and, in the abyss, bioluminescent sparkles.
 */
import { THREE } from '../three-layer';
import type { WaterUniforms } from './water';
import type { Depth, Population, SeaSchedule, Species } from './schedule';
import type { Fauna } from './fauna/kit';
import { buildJellies } from './fauna/jelly';
import { buildAnglers, buildSharks, buildShoals } from './fauna/fish';
import { buildRays, buildTurtles } from './fauna/rays';
import { buildSquid } from './fauna/cephalopods';
import { buildCombs, buildEels, buildSiphonophores, buildSparkles } from './fauna/glowing';
import { buildWhales } from './fauna/whale';

type Builder = (U: WaterUniforms, depth: Depth, pop: Population, D: number, v: number) => Fauna;

const BUILDERS: Record<Species, Builder> = {
  jelly: buildJellies,
  lanternfish: buildShoals,
  reefSchool: buildShoals,
  comb: buildCombs,
  squid: buildSquid,
  vampire: buildSquid,
  siphonophore: buildSiphonophores,
  manta: buildRays,
  eagleRay: buildRays,
  shark: buildSharks,
  reefShark: buildSharks,
  turtle: buildTurtles,
  eel: buildEels,
  angler: buildAnglers,
};

export interface Life {
  group: THREE.Group;
  /** t, the loop length, and how far the submarine has travelled (m). */
  update(t: number, L: number, s: number): void;
}

export function buildLife(depth: Depth, U: WaterUniforms, sched: SeaSchedule, seed: number): Life {
  const group = new THREE.Group();
  const fauna: Fauna[] = sched.fauna.map((pop) => BUILDERS[pop.species](U, depth, pop, sched.D, sched.v));
  fauna.push(buildWhales(U, sched.whales));
  if (depth === 'abyss') fauna.push(buildSparkles(seed));
  for (const f of fauna) group.add(f.group);
  return {
    group,
    update(t, L, s) {
      for (const f of fauna) f.update(t, L, s);
    },
  };
}
