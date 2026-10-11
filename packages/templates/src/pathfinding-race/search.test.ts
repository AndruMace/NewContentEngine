import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { MAP_KINDS, WALL, makeMap, neighbours, reachable, type GridMap } from './maps';
import { ALGOS, optimalCost, recordSearch, type AlgoId } from './search';

/** A path must start at the start, end at the goal and only step between open neighbours. */
function validPath(m: GridMap, path: number[]) {
  expect(path[0]).toBe(m.start);
  expect(path[path.length - 1]).toBe(m.goal);
  const nb: number[] = [];
  for (let i = 1; i < path.length; i++) expect(neighbours(m, path[i - 1], nb)).toContain(path[i]);
}

describe('pathfinding maps and searches', () => {
  for (const kind of MAP_KINDS)
    it(`${kind}: every algorithm reaches the goal; BFS/Dijkstra/A* are optimal where they should be`, () => {
      for (let seed = 1; seed <= 12; seed++) {
        const m = makeMap(kind, 31 + (seed % 3) * 10, 15 + (seed % 4) * 4, new Rng(seed));
        expect(reachable(m)).toBe(true);
        expect(m.cells[m.start]).not.toBe(WALL);
        const best = optimalCost(m);
        const algos = (Object.keys(ALGOS) as AlgoId[]).filter((a) => a !== 'wall' || kind === 'maze');
        for (const a of algos) {
          const r = recordSearch(a, m);
          validPath(m, r.path);
          expect(r.cost).toBeGreaterThanOrEqual(best);
          if (a === 'astar' || a === 'dijkstra') expect(r.cost).toBe(best);
          if ((a === 'bfs' || a === 'bidir') && kind !== 'weighted') expect(r.cost).toBe(best);
          if (kind === 'maze') expect(r.cost).toBe(best); // a perfect maze has a single route
        }
      }
    });
});
