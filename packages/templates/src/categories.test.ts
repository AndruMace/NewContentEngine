import { describe, expect, it } from 'vitest';
import { ALL_TEMPLATES, LONG_FORM_TEMPLATES, TEMPLATES, groupTemplates } from './index';

describe('template categories', () => {
  it('puts every template in a picker section', () => {
    expect(groupTemplates(ALL_TEMPLATES).flatMap((g) => g.templates)).toHaveLength(ALL_TEMPLATES.length);
  });

  it('keeps Shorts and long-form templates in their own sections', () => {
    expect(TEMPLATES.filter((t) => t.category === 'ambient')).toEqual([]);
    expect(LONG_FORM_TEMPLATES.every((t) => t.category === 'ambient')).toBe(true);
  });
});
