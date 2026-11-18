import { describe, expect, it } from 'vitest';
import {
  SECTION_EXAMPLES_PER_SECTION,
  buildDecisionBody,
  buildSectionPromptGroups,
  parseDecisionAnswers,
} from '../src/lib/grocery-section-agent';
import type { GrocerySection } from '../src/lib/supabase';

function section(id: string, name: string, position: number): GrocerySection {
  return { id, name, position, created_at: '2026-01-01T00:00:00Z' };
}

const SECTIONS = [
  section('s-produce', 'Produce', 0),
  section('s-frozen', 'Frozen', 1),
  section('s-pantry', 'Pantry', 2),
];

describe('buildSectionPromptGroups', () => {
  it('lists sections in order and attaches their examples', () => {
    const groups = buildSectionPromptGroups(SECTIONS, [
      { name: 'apples', section_id: 's-produce' },
      { name: 'peas', section_id: 's-frozen' },
      { name: 'kale', section_id: 's-produce' },
    ]);
    expect(groups).toEqual([
      { name: 'Produce', examples: ['apples', 'kale'] },
      { name: 'Frozen', examples: ['peas'] },
      { name: 'Pantry', examples: [] },
    ]);
  });

  it('caps examples per section', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `item-${i}`,
      section_id: 's-pantry',
    }));
    const groups = buildSectionPromptGroups(SECTIONS, many);
    expect(groups[2]!.examples).toHaveLength(SECTION_EXAMPLES_PER_SECTION);
  });

  it('drops examples pointing at unknown sections', () => {
    const groups = buildSectionPromptGroups(SECTIONS, [
      { name: 'ghost', section_id: 's-gone' },
    ]);
    expect(groups.every((g) => g.examples.length === 0)).toBe(true);
  });
});

describe('buildDecisionBody', () => {
  it('pins the private-tier decision model and carries the state shape', () => {
    const body = buildDecisionBody({
      sections: SECTIONS,
      examples: [{ name: 'apples', section_id: 's-produce' }],
      names: ['corn', 'flour'],
    });
    expect(body.model).toBe('clef-api');
    const state = body.state as Record<string, unknown>;
    expect(state.sections).toEqual([
      { name: 'Produce', examples: ['apples'] },
      { name: 'Frozen', examples: [] },
      { name: 'Pantry', examples: [] },
    ]);
    expect(state.items).toEqual(['corn', 'flour']);
    expect(state.recipe).toBeUndefined();
  });

  it('writes one choice question per item, keyed by the item name', () => {
    const body = buildDecisionBody({
      sections: SECTIONS,
      examples: [],
      names: ['corn', 'flour'],
    });
    const questions = body.questions as Record<string, Record<string, unknown>>;
    expect(Object.keys(questions).sort()).toEqual(['corn', 'flour']);
    for (const key of ['corn', 'flour']) {
      expect(questions[key]!.type).toBe('choice');
      // The id is NOT sent to the model - the instruction must name the item.
      expect(questions[key]!.instructions).toContain(`"${key}"`);
    }
  });

  it('offers every section by name plus the none option in the criteria', () => {
    const body = buildDecisionBody({
      sections: SECTIONS,
      examples: [{ name: 'apples', section_id: 's-produce' }],
      names: ['corn'],
    });
    const questions = body.questions as Record<string, Record<string, unknown>>;
    const criteria = questions['corn']!.criteria as Record<string, unknown>;
    expect(Object.keys(criteria).sort()).toEqual([
      'Frozen',
      'Pantry',
      'Produce',
      'none',
    ]);
    expect(criteria['Produce']).toBe('Examples: apples');
    expect(criteria['Frozen']).toBeNull();
    expect(criteria['none']).toContain('unfiled');
  });

  it('carries the recipe context in the state, capped', () => {
    const body = buildDecisionBody({
      sections: SECTIONS,
      examples: [],
      names: ['corn'],
      recipe: { title: 'Corn Chowder', cooklang: `x`.repeat(9000) },
    });
    const state = body.state as { recipe: { title: string; ingredients: string } };
    expect(state.recipe.title).toBe('Corn Chowder');
    expect(state.recipe.ingredients).toHaveLength(6000);
  });
});

describe('parseDecisionAnswers', () => {
  const names = ['Corn', 'flour'];

  function payload(answers: Record<string, unknown>): unknown {
    return { answers };
  }

  it('maps names to section ids with confidence', () => {
    const out = parseDecisionAnswers(
      payload({
        Corn: { type: 'choice', choice: 'Frozen', confidence: 0.93 },
        flour: { type: 'choice', choice: 'Pantry', confidence: 0.81 },
      }),
      names,
      SECTIONS
    );
    expect(out.get('corn')).toEqual({ sectionId: 's-frozen', confidence: 0.93 });
    expect(out.get('flour')).toEqual({ sectionId: 's-pantry', confidence: 0.81 });
  });

  it('drops the none pick, unknown sections, and missing answers', () => {
    const out = parseDecisionAnswers(
      payload({
        Corn: { type: 'choice', choice: 'none', confidence: 0.9 },
        flour: { type: 'choice', choice: 'Nowhere', confidence: 0.9 },
      }),
      names,
      SECTIONS
    );
    expect(out.size).toBe(0);
  });

  it('coerces a missing or non-finite confidence to 0', () => {
    const out = parseDecisionAnswers(
      payload({
        Corn: { type: 'choice', choice: 'Produce' },
        flour: { type: 'choice', choice: 'Pantry', confidence: 'high' },
      }),
      names,
      SECTIONS
    );
    expect(out.get('corn')!.confidence).toBe(0);
    expect(out.get('flour')!.confidence).toBe(0);
  });

  it('ignores names the model was not asked about', () => {
    const out = parseDecisionAnswers(
      payload({ pumpkin: { type: 'choice', choice: 'Produce', confidence: 1 } }),
      names,
      SECTIONS
    );
    expect(out.size).toBe(0);
  });

  it('fails closed on non-object payloads and malformed answers', () => {
    expect(parseDecisionAnswers(null, names, SECTIONS).size).toBe(0);
    expect(parseDecisionAnswers('nope', names, SECTIONS).size).toBe(0);
    expect(parseDecisionAnswers({ answers: 'nope' }, names, SECTIONS).size).toBe(0);
    expect(
      parseDecisionAnswers(payload({ Corn: 'Frozen' }), names, SECTIONS).size
    ).toBe(0);
  });

  it('resolves duplicate section names to the first match', () => {
    const dupes = [...SECTIONS, section('s-frozen-2', 'Frozen', 3)];
    const out = parseDecisionAnswers(
      payload({ Corn: { type: 'choice', choice: 'Frozen', confidence: 0.5 } }),
      ['Corn'],
      dupes
    );
    expect(out.get('corn')!.sectionId).toBe('s-frozen');
  });
});
