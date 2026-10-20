import { describe, expect, it } from 'vitest';
import { LONG_FORM_TEMPLATES } from '@sim/templates';
import { LongFormCopySchema, describeScene, fallbackLongFormCopy } from './longformCopy';

/** A few settings per template: the defaults, and each enum option in turn. */
function variants(schema: any): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{}];
  for (const [key, prop] of Object.entries<any>(schema.shape ?? {})) {
    const options = prop?.def?.innerType?.options ?? prop?.options;
    if (Array.isArray(options)) for (const o of options) out.push({ [key]: o });
  }
  return out;
}

describe('long-form copy', () => {
  for (const t of LONG_FORM_TEMPLATES) {
    it(`${t.id}: describes itself and has valid fallback copy for every setting`, () => {
      expect(t.longForm?.describe).toBeTypeOf('function');
      expect(t.longForm?.fallbackCopy).toBeTypeOf('function');
      for (const params of variants(t.schema)) {
        for (const totalS of [3600, 3 * 3600, 8 * 3600]) {
          const recipe = { templateId: t.id, seed: 1, params, themeId: 'neon-dark', melodyId: 'ode-to-joy', loopS: 1800, totalS };
          expect(describeScene(recipe).length).toBeGreaterThan(40);
          const copy = fallbackLongFormCopy(recipe);
          expect(() => LongFormCopySchema.parse(copy)).not.toThrow();
          expect(copy.title).toContain(totalS === 3600 ? '1 Hour' : `${totalS / 3600} Hours`);
        }
      }
    });
  }
});
