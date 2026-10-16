import { describe, expect, it } from 'vitest';
import { Rng, paramsJsonSchema } from '@sim/engine';
import { TEMPLATES, getTemplate } from '@sim/templates';
import { LIMITS, PLANNED_VARIANTS, applyTitleEmoji, chooseArms, flatArmModel, planOne, startsWithEmoji, type ArmModel, conceptFromMock, conceptFromResponse, fallbackConcept, normalizeCopy, planConcepts, platformText, mergeCopyOutput, uploadText, conceptOutputSchema, summarizePerformance, uploadCopyFromClaude, variantHook } from './index';

describe('arm selection', () => {
  it('spreads arms across templates and respects the filters', () => {
    const arms = chooseArms({ count: 9, templateIds: [], themeIds: ['neon-dark', 'sunset'], minLengthS: 20, maxLengthS: 45 }, flatArmModel, new Rng(1)).map((c) => c.arm);
    expect(arms).toHaveLength(9);
    expect(new Set(arms.map((a) => a.templateId)).size).toBeGreaterThanOrEqual(5);
    expect(arms.every((a) => ['neon-dark', 'sunset'].includes(a.themeId))).toBe(true);
    expect(chooseArms({ count: 4, templateIds: [], themeIds: [], minLengthS: 15, maxLengthS: 24 }, flatArmModel, new Rng(2)).every((c) => c.arm.lengthBucket === 'short')).toBe(true);
  });

  it('runs no experiments until the model is ready', () => {
    expect(chooseArms({ count: 9, templateIds: [], themeIds: [], minLengthS: 20, maxLengthS: 45 }, flatArmModel, new Rng(3)).some((c) => c.experiment)).toBe(false);
  });

  it('reserves experiment slots for uncertain arms and boosts stale templates once ready', () => {
    // A confident model that loves ring-escape and knows nothing about sand-pour.
    const model: ArmModel = {
      ready: true,
      sample: () => (arm) => (arm.templateId === 'ring-escape' ? 1 : 0),
      mean: (arm) => (arm.templateId === 'ring-escape' ? 1 : 0.2),
      sd: (arm) => (arm.templateId === 'sand-pour' ? 0.9 : 0.1),
      experimentReason: (arm) => `Testing ${arm.templateId}`,
    };
    // A fixed template set so the per-template cap (ceil(9 / 5) = 2) doesn't depend on the catalog
    // size; sand-pour last so the tied exploit slots don't use up its cap first.
    const templateIds = ['ring-escape', 'marble-race', 'ball-battle', 'polyrhythm', 'sand-pour'];
    const chosen = chooseArms({ count: 9, templateIds, themeIds: [], minLengthS: 20, maxLengthS: 45 }, model, new Rng(4));
    const exps = chosen.filter((c) => c.experiment);
    expect(chosen).toHaveLength(9);
    expect(exps.length).toBe(2);
    expect(exps.every((c) => c.arm.templateId === 'sand-pour' && c.experiment!.reason === 'Testing sand-pour')).toBe(true);
    // Diversity still holds: ring-escape can't take every exploit slot.
    expect(chosen.filter((c) => c.arm.templateId === 'ring-escape').length).toBeLessThanOrEqual(2);

    const now = Date.now();
    const lastPostedAt = Object.fromEntries(TEMPLATES.map((t) => [t.id, now]));
    lastPostedAt['marble-race'] = now - 30 * 86_400_000;
    const flatish: ArmModel = { ...model, sample: () => () => 0, mean: () => 0, sd: () => 0.1 };
    const withStale = chooseArms({ count: 3, templateIds: [], themeIds: [], minLengthS: 20, maxLengthS: 45, lastPostedAt, now }, flatish, new Rng(5));
    expect(withStale[0].arm.templateId).toBe('marble-race');
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
      flatArmModel,
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

describe('copy hygiene', () => {
  it('strips tool/AI self-references from hashtags and captions', () => {
    const c = normalizeCopy({
      hook: 'h',
      cta: 'c',
      title: 'Marble race #Claude',
      youtubeDescription: 'Eight marbles race to the bottom #ai',
      tiktokCaption: 'who wins? #marblerace #Claude #satisfying #AIgenerated',
      xPost: 'Pick a marble #anthropic #oddlysatisfying',
      hashtags: ['#claude', 'ai', '#marblerace', 'Satisfying', '#ChatGPT'],
    });
    expect(c.hashtags).toEqual(['#marblerace', '#Satisfying']);
    expect(c.tiktokCaption).toBe('who wins? #marblerace #satisfying');
    expect(c.xPost).toBe('Pick a marble #oddlysatisfying');
    expect(c.title).toBe('Marble race');
    expect(c.youtubeDescription).toBe('Eight marbles race to the bottom');
    // Normal words containing "ai" are untouched.
    expect(normalizeCopy({ ...c, tiktokCaption: 'raining sand #rain' }).tiktokCaption).toBe('raining sand #rain');
  });
});

describe('title emoji', () => {
  const arm = { templateId: 'sand-pour', themeId: 'sunset', lengthBucket: 'medium' as const, hookStyle: 'question' as const };

  it('adds, keeps or strips a leading emoji', () => {
    const rng = new Rng(1);
    expect(startsWithEmoji(applyTitleEmoji('How many grains will it take?!', true, 'sand-pour', rng))).toBe(true);
    expect(applyTitleEmoji('🤯 How many grains will it take?!', true, 'sand-pour', rng)).toBe('🤯 How many grains will it take?!');
    expect(applyTitleEmoji('🤯😱 How many grains?', false, 'sand-pour', rng)).toBe('How many grains?');
    expect(applyTitleEmoji('⚔️ Sword fight', false, 'ball-battle', rng)).toBe('Sword fight');
    expect(applyTitleEmoji('🇧🇷 Brazil wins?', false, 'marble-race', rng)).toBe('Brazil wins?');
    expect(applyTitleEmoji('Grains 🤯', false, 'sand-pour', rng)).toBe('Grains 🤯');
  });

  it('leads most titles with an emoji and keeps a comparison group', async () => {
    let withEmoji = 0;
    for (let i = 0; i < 200; i++) {
      const { concept } = await planOne(arm, 30, 'fallback', { recentHooks: [] }, new Rng(i));
      expect(startsWithEmoji(concept.copy.title)).toBe(concept.titleEmoji);
      if (concept.titleEmoji) withEmoji++;
    }
    expect(withEmoji).toBeGreaterThan(130);
    expect(withEmoji).toBeLessThan(170);
  });

  it('splits Ball Battle evenly between country and colour teams, whatever the model returns', async () => {
    const bb = { ...arm, templateId: 'ball-battle' };
    let countries = 0;
    for (let i = 0; i < 200; i++) {
      const { concept } = await planOne(bb, 30, i % 2 ? 'mock' : 'fallback', { recentHooks: [] }, new Rng(i));
      if (concept.params.teams === 'countries') countries++;
    }
    expect(countries).toBeGreaterThan(80);
    expect(countries).toBeLessThan(120);
    // The planned choice wins over the model's answer, and every value has a prompt guide.
    const raw = { params: { teams: 'colors' }, melodyId: 'ode-to-joy', hook: 'Who wins?', cta: 'Pick one', title: 'Battle', youtubeDescription: '', tiktokCaption: 'Battle', xPost: 'Battle', hashtags: ['#battle'], rationale: '' };
    expect(conceptFromResponse(raw, bb, 30, 'claude', { titleEmoji: false, variants: { teams: 'countries' }, rng: new Rng(1) }).params.teams).toBe('countries');
    for (const vs of Object.values(PLANNED_VARIANTS)) for (const v of vs) expect(Object.keys(v.guide).sort()).toEqual([...v.values].sort());
  });

  it('fixes the Fourier hook to the subject (country, US state, dinosaur…)', async () => {
    const fd = { ...arm, templateId: 'fourier-drawing' };
    const hooks: Record<string, string> = {
      countries: 'Guess what country the circles are drawing?',
      states: 'Guess which US state the circles are drawing?',
      dinosaurs: 'Guess which dinosaur the circles are drawing?',
      animals: 'Guess what animal the circles are drawing?',
      fantasy: 'Guess what mythical creature the circles are drawing?',
    };
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { concept } = await planOne(fd, 30, i % 2 ? 'mock' : 'fallback', { recentHooks: [] }, new Rng(i));
      const subject = concept.params.subject as string;
      seen.add(subject);
      expect(concept.copy.hook).toBe(hooks[subject]);
    }
    expect(seen.size).toBe(5);
  });

  it('uses settings chosen up front (taste model) whatever the model returns, keeping planned variants', async () => {
    const bb = { ...arm, templateId: 'ball-battle' };
    const chooseParams = (_a: unknown, _t: number, fixed: Record<string, unknown>) => ({ params: { ...fixed, speed: 1111, hp: 222 }, source: 'near a video you approved' });
    for (const gen of ['mock', 'fallback'] as const) {
      const { concept } = await planOne(bb, 30, gen, { recentHooks: [], chooseParams }, new Rng(3));
      expect(concept.params.speed).toBe(1111);
      expect(concept.params.hp).toBe(222);
      expect(['colors', 'countries']).toContain(concept.params.teams);
      expect(concept.paramsSource).toBe('near a video you approved');
    }
  });

  it('adds a template-relevant comment prompt to most videos, varied across a batch', async () => {
    const { getTemplate } = await import('@sim/templates');
    const recentNudges: string[] = [];
    let withCues = 0;
    const picked: string[] = [];
    for (let i = 0; i < 120; i++) {
      const templateId = i % 2 ? 'ring-escape' : 'marble-race';
      const { concept } = await planOne({ ...arm, templateId }, 30, i % 3 ? 'fallback' : 'mock', { recentHooks: [], recentNudges }, new Rng(i));
      if (!concept.copy.nudge) continue;
      withCues++;
      expect(getTemplate(templateId).nudges).toContain(concept.copy.nudge);
      if (i < 12) picked.push(concept.copy.nudge);
    }
    expect(withCues).toBeGreaterThan(75);
    expect(withCues).toBeLessThan(105);
    // Within a batch-sized run, no prompt repeats until its template's pool is used up.
    expect(new Set(picked).size).toBe(picked.length);
  });

  it('leaves other templates\' plans unchanged', async () => {
    const { concept } = await planOne(arm, 30, 'fallback', { recentHooks: [] }, new Rng(5));
    expect(concept.params).not.toHaveProperty('teams');
  });

  it("enforces the plan when the model doesn't follow it", () => {
    const raw = { params: {}, melodyId: 'ode-to-joy', hook: 'Wait for it', cta: 'Which color?', title: 'How many grains will it take?!', youtubeDescription: '', tiktokCaption: 'Watch the sand', xPost: 'Watch the sand', hashtags: ['#sand'], rationale: '' };
    expect(startsWithEmoji(conceptFromResponse(raw, arm, 30, 'claude', { titleEmoji: true, rng: new Rng(2) }).copy.title)).toBe(true);
    expect(conceptFromResponse({ ...raw, title: '🤯 How many grains will it take?!' }, arm, 30, 'claude', { titleEmoji: false, rng: new Rng(2) }).copy.title).toBe('How many grains will it take?!');
  });
});

describe('upload text', () => {
  const copy = normalizeCopy({
    hook: 'Can it escape?',
    cta: 'Did you call it?',
    title: '😱 Can the ball escape 30 rings?',
    youtubeDescription: 'A ball bounces out through 30 spinning rings.',
    tiktokCaption: 'Wait for ring 30… #satisfying',
    instagramCaption: 'Ring 30 is the hard one',
    xPost: 'This ball had no business escaping #physics',
    hashtags: ['satisfying', '#ringescape', '#AI'],
    pinnedComments: { youtube: 'What ring did you think it would stop at?', x: 'Faster or slower next time?' },
    coverText: 'Ring 30?! #satisfying',
    emojis: ['😱', 'x', '🌀', '😱'],
  });

  it('normalizes the new fields', () => {
    expect(copy.hashtags).toEqual(['#satisfying', '#ringescape']);
    expect(copy.coverText).toBe('Ring 30?!');
    expect(copy.emojis).toEqual(['😱', '🌀']);
  });

  it('builds paste-ready fields per platform and one block with everything', () => {
    const t = uploadText(copy);
    expect(t.youtube.fields.map((f) => f.id)).toEqual(['title', 'description', 'pinned']);
    expect(t.youtube.fields[1].text).toBe('A ball bounces out through 30 spinning rings.\n\n#satisfying #ringescape #Shorts');
    // Captions without hashtags of their own get the shared ones; ones with hashtags are left alone.
    expect(t.instagram.fields[0].text).toBe('Ring 30 is the hard one #satisfying #ringescape');
    expect(t.tiktok.fields[0].text).toBe('Wait for ring 30… #satisfying');
    // Empty fields are left out (no TikTok pinned comment here).
    expect(t.tiktok.fields.map((f) => f.id)).toEqual(['caption', 'cover']);
    expect(t.x.all).toBe('This ball had no business escaping #physics\n\nReply to your post:\nFaster or slower next time?');
    expect(platformText(copy).instagram).toBe(t.instagram.all);
  });

  it('merges a partial answer without touching other platforms', () => {
    const next = mergeCopyOutput(copy, { tiktokCaption: 'New take #marblerace', tiktokPinnedComment: 'Pick a ring' });
    expect(next.tiktokCaption).toBe('New take #marblerace');
    expect(next.pinnedComments).toEqual({ ...copy.pinnedComments, tiktok: 'Pick a ring' });
    expect(next.title).toBe(copy.title);
    expect(next.instagramCaption).toBe(copy.instagramCaption);
  });

  it('asks the batch planner for every platform', () => {
    const schema = conceptOutputSchema(getTemplate('ring-escape'));
    for (const k of ['instagramCaption', 'youtubePinnedComment', 'xReply', 'coverText', 'emojis']) expect(schema.required).toContain(k);
  });
});

describe('performance summary', () => {
  const post = (title: string, reward: number, extra: { views?: number; provisional?: boolean } = {}) => ({ title, hook: 'hook', templateName: 'Ring Escape', reward, provisional: false, ...extra });

  it('says nothing until enough posts are scored', () => {
    expect(summarizePerformance([post('a', 1), post('b', 0), post('c', -1)])).toBeUndefined();
  });

  it('lists the best first and the weakest separately, without overlap', () => {
    const s = summarizePerformance([post('mid', 0.1), post('top', 1.5, { views: 12000 }), post('low', -1.2, { provisional: true }), post('ok', 0.6), post('bad', -0.4)])!;
    const lines = s.split('\n');
    expect(lines[1]).toBe('- "top" (Ring Escape; on-screen "hook"): +1.5 vs average, 12,000 views');
    expect(lines.indexOf('Weakest:')).toBe(4);
    expect(lines[5]).toContain('"low"');
    expect(lines[5]).toContain('early numbers');
    expect(s.match(/"mid"/g)).toHaveLength(1);
  });
});

describe('mystery songs', () => {
  it('never shows the copy writer which song a Bounce Keys video plays', async () => {
    let prompt = '';
    const client = {
      beta: {
        messages: {
          create: async (req: { messages: { content: string }[] }) => {
            prompt = req.messages[0].content;
            return { stop_reason: 'refusal', stop_details: null, content: [] };
          },
        },
      },
    } as unknown as Parameters<typeof uploadCopyFromClaude>[0];
    const recipe = { templateId: 'bounce-keys', seed: 1, params: { style: 'keys' }, themeId: 'neon-dark', melodyId: 'fur-elise', targetS: 32 };
    const input = { recipe, onScreen: { hook: 'Guess the song 🎵', cta: 'It was {answer}! Did you get it? 🎵' }, titleEmoji: false };
    await expect(uploadCopyFromClaude(client, input, {} as Parameters<typeof uploadCopyFromClaude>[2], new Rng(1))).rejects.toThrow();
    expect(prompt).toContain('Bounce Keys');
    expect(prompt).toContain('never name');
    for (const leak of ['Für Elise', 'Elise', 'Beethoven', 'fur-elise']) expect(prompt).not.toContain(leak);
  });

  it('fixes the Bounce Keys hook to the question', () => {
    for (const style of ['cascade', 'keys']) expect(variantHook('bounce-keys', { style })).toBe('Guess the song 🎵');
  });
});
