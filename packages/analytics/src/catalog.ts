import { THEMES } from '@sim/engine';
import { MELODIES } from '@sim/audio';
import { TEMPLATES } from '@sim/templates';
import { HOOK_STYLES, LENGTH_BUCKETS } from '@sim/planner';
import type { Catalog } from './learner';

/** Everything the learner can tell apart, from the current template/theme/melody libraries. */
export function defaultCatalog(): Catalog {
  return {
    templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name })),
    themes: THEMES.map((t) => t.id),
    hookStyles: Object.keys(HOOK_STYLES),
    lengthBuckets: Object.entries(LENGTH_BUCKETS).map(([id, [lo, hi]]) => ({ id, midS: (lo + hi) / 2 })),
    melodies: MELODIES.map((m) => m.id),
  };
}
