import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/engine';
import { ALGORITHMS, CMP, SET, SWAP, recordSort, type AlgorithmId } from './algorithms';

/** Replays recorded ops on the input and returns the result. */
function replay(input: number[], ops: Int32Array) {
  const a = input.slice();
  for (let o = 0; o < ops.length; o += 3) {
    if (ops[o] === SWAP) [a[ops[o + 1]], a[ops[o + 2]]] = [a[ops[o + 2]], a[ops[o + 1]]];
    else if (ops[o] === SET) a[ops[o + 1]] = ops[o + 2];
    else expect(ops[o]).toBe(CMP);
  }
  return a;
}

describe.each(Object.keys(ALGORITHMS) as AlgorithmId[])('%s sort', (id) => {
  it('replayed ops sort shuffled, reversed and duplicate-heavy input', () => {
    const rng = new Rng(9);
    const inputs = [
      Array.from({ length: 50 }, () => rng.int(1, 50)),
      Array.from({ length: 33 }, (_, i) => 33 - i),
      Array.from({ length: 40 }, () => rng.int(1, 4)),
    ];
    for (const input of inputs) {
      const out = replay(input, recordSort(id, input));
      expect(out).toEqual(input.slice().sort((a, b) => a - b));
    }
  });
});
