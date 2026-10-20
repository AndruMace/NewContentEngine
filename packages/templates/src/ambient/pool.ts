/** Pools of one-shot recordings for the long-form scenes (thunder, rail clicks, creaks…). */
import type { Rng } from '@sim/engine';

/** Each pool played in a shuffled order, reshuffled when used up (never the same clip twice in a row). */
export function clipPicker(rng: Rng, pool: string[]) {
  let order: string[] = [];
  let last = '';
  return () => {
    if (!order.length) {
      order = [...pool];
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [order[i], order[j]] = [order[j], order[i]];
      }
      if (order[order.length - 1] === last && order.length > 1) [order[0], order[order.length - 1]] = [order[order.length - 1], order[0]];
    }
    last = order.pop()!;
    return last;
  };
}
