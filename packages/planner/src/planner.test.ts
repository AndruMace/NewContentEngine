import { describe, expect, it } from 'vitest';
import { Rng, paramsJsonSchema } from '@sim/engine';
import { TEMPLATES, getTemplate } from '@sim/templates';
import { LIMITS, chooseArms, conceptFromMock, conceptFromResponse, fallbackConcept, normalizeCopy, planConcepts, platformText } from './index';

describe('arm selection', () => {
  it('spreads arms across templates and respects the filters', () => {
    const arms = chooseArms({ count: 9, templateIds: [], themeIds: ['neon-dark', 'sunset'], minLengthS: 20, maxLengthS: 45 }, new Map(), new Rng(1));
    expect(arms).toHaveLength(9);
    expect(new Set(arms.map((a) => a.templateId)).size).toBeGreaterThanOrEqual(5);
    expect(arms.every((a) => ['neon-dark', 'sunset'].includes(a.themeId))).toBe(true);
    expect(chooseArms({ count: 4, templateIds: [], themeIds: [], minLengthS: 15, maxLengthS: 24 }, new Map(), new Rng(2)).every((a) => a.lengthBucket === 'short')).toBe(true);
  });
});

describe('concepts', () => {
  it('fallback concepts are valid for every template', () => {
    for (const t of TEMPLATES) {
      const c = fallbackConcept({ templateId: t.id, themeId: 'neon-dark', lengthBucket: 'medium', hookStyle: 'question' }, 30, new Rng(3));
      expect(() => t.schema.parse(c.params)).not.toThrow();
      expect(c.copy.hook.length).toBeLessThanOrEqual(LIMITS.hook);
    }
  });

  it('mock (Claude-shaped) responses are clamped into range and unknown params dropped', () => {
    for (const t of TEMPLATES) {
      const c = conceptFromMock({ templateId: t.id, themeId: 'ocean', lengthBucket: 'short', hookStyle: 'curiosity' }, 20, new Rng(5));
      const props = (paramsJsonSchema(t) as { properties: Record<string, any> }).properties;
      for (const [k, v] of Object.entries(c.params)) {
        expect(k in props).toBe(true);
        if (typeof v === 'number') expect(v).toBeLessThanOrEqual(props[k].maximum ?? Infinity);
      }
      expect(c.copy.hashtags.every((h) => /^#[\p{L}\p{N}_]+$/u.test(h))).toBe(true);
    }
  });

  it('rejects structurally invalid responses with a readable error', () => {
    expect(() => conceptFromResponse({ hook: 'x' }, { templateId: 'ring-escape', themeId: 'neon-dark', lengthBucket: 'short', hookStyle: 'question' }, 20, 'claude')).toThrow();
  });

  it('enforces platform limits', () => {
    const long = 'x'.repeat(500);
    const c = normalizeCopy({ hook: long, cta: long, title: long + ' #Shorts', youtubeDescription: 'd', tiktokCaption: long, xPost: long, hashtags: Array(10).fill('tag') });
    expect(c.hook.length).toBe(LIMITS.hook);
    expect(c.xPost.length).toBeLessThanOrEqual(LIMITS.x);
    expect(c.title).not.toMatch(/#shorts/i);
    expect(platformText(c).youtube).toMatch(/#Shorts/);
    expect(c.hashtags.length).toBe(1); // deduplicated
  });

  it('plans a full batch offline with the mock generator', async () => {
    const planned = await planConcepts(
      { count: 6, templateIds: [], themeIds: [], minLengthS: 20, maxLengthS: 45, generator: 'mock', seed: 11 },
      new Map(),
      { recentHooks: [] },
    );
    expect(planned).toHaveLength(6);
    for (const p of planned) {
      expect(p.concept.source).toBe('mock');
      expect(p.concept.targetS).toBeGreaterThanOrEqual(20);
      expect(p.concept.targetS).toBeLessThanOrEqual(45);
      expect(() => getTemplate(p.concept.templateId).schema.parse(p.concept.params)).not.toThrow();
    }
  });
});
