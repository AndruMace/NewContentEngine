import { THEMES, paramsJsonSchema } from '@sim/engine';
import { TEMPLATES } from '@sim/templates';
import { HOOK_STYLES, LENGTH_BUCKETS, PLANNED_VARIANTS, variantKey } from '@sim/planner';
import type { Catalog, ParamSpec } from './learner';

/** Everything the learner can tell apart, from the current template/theme/melody libraries. */
export function defaultCatalog(): Catalog {
  return {
    templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name })),
    themes: THEMES.map((t) => t.id),
    hookStyles: Object.keys(HOOK_STYLES),
    lengthBuckets: Object.entries(LENGTH_BUCKETS).map(([id, [lo, hi]]) => ({ id, midS: (lo + hi) / 2 })),
    // Melodies are assigned for variety, never learned: past decisions shouldn't favour one.
    melodies: [],
    variants: Object.entries(PLANNED_VARIANTS).flatMap(([templateId, vs]) => vs.flatMap((v) => v.values.slice(1).map((value) => variantKey(templateId, v, value)))),
  };
}

/**
 * Every template setting the taste model can learn about. Planner-split variants (country vs colour
 * teams, Fourier subject…) are left out: they are features of their own.
 */
export function paramSpecs(): ParamSpec[] {
  const out: ParamSpec[] = [];
  for (const t of TEMPLATES) {
    // Length is planned from the target (and learned through duration), not a matter of taste.
    const planned = new Set([...(PLANNED_VARIANTS[t.id] ?? []).map((v) => v.param), ...(t.lengthParam ? [t.lengthParam.param] : [])]);
    const props = (paramsJsonSchema(t) as { properties: Record<string, any> }).properties;
    for (const [param, p] of Object.entries(props)) {
      if (planned.has(param)) continue;
      const title = p.title ?? param;
      if ((p.type === 'number' || p.type === 'integer') && Number.isFinite(p.minimum) && Number.isFinite(p.maximum) && p.maximum > p.minimum)
        out.push({ templateId: t.id, param, title, kind: 'number', default: p.default ?? (p.minimum + p.maximum) / 2, min: p.minimum, max: p.maximum });
      else if (Array.isArray(p.enum)) out.push({ templateId: t.id, param, title, kind: 'enum', default: String(p.default ?? p.enum[0]), values: p.enum.map(String) });
      else if (p.type === 'boolean') out.push({ templateId: t.id, param, title, kind: 'enum', default: String(p.default ?? false), values: ['true', 'false'] });
    }
  }
  return out;
}

/** The YouTube learner's catalog plus template settings: what the taste model learns from. */
export const tasteCatalog = (): Catalog => ({ ...defaultCatalog(), params: paramSpecs() });
