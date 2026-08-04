import { describe, expect, it } from 'vitest';
import {
  SECTION_EXAMPLES_PER_SECTION,
  buildClassifierMessages,
  buildSectionPromptGroups,
  parseClassifierAnswer,
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
  it('numbers sections in order and attaches their examples', () => {
    const groups = buildSectionPromptGroups(SECTIONS, [
      { name: 'apples', section_id: 's-produce' },
      { name: 'peas', section_id: 's-frozen' },
      { name: 'kale', section_id: 's-produce' },
    ]);
    expect(groups).toEqual([
      { number: 1, name: 'Produce', examples: ['apples', 'kale'] },
      { number: 2, name: 'Frozen', examples: ['peas'] },
      { number: 3, name: 'Pantry', examples: [] },
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

describe('buildClassifierMessages', () => {
  it('is a single user turn naming sections, examples, and items', () => {
    const messages = buildClassifierMessages({
      sections: SECTIONS,
      examples: [{ name: 'apples', section_id: 's-produce' }],
      names: ['corn', 'flour'],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    const body = messages[0]!.content as string;
    expect(body).toContain('1. Produce (examples: apples)');
    expect(body).toContain('3. Pantry');
    expect(body).toContain('- corn');
    expect(body).toContain('- flour');
    expect(body).not.toContain('Recipe:');
  });

  it('includes the recipe context when provided', () => {
    const messages = buildClassifierMessages({
      sections: SECTIONS,
      examples: [],
      names: ['corn'],
      recipe: { title: 'Corn Chowder', cooklang: 'Add @corn{1%can}.' },
    });
    const body = messages[0]!.content as string;
    expect(body).toContain('Recipe: Corn Chowder');
    expect(body).toContain('@corn{1%can}');
  });
});

describe('parseClassifierAnswer', () => {
  const names = ['Corn', 'flour'];

  it('maps names to section ids by number', () => {
    const out = parseClassifierAnswer('{"Corn": 2, "flour": 3}', names, SECTIONS);
    expect(out.get('corn')).toBe('s-frozen');
    expect(out.get('flour')).toBe('s-pantry');
  });

  it('matches keys by normalized name and accepts number-as-string', () => {
    const out = parseClassifierAnswer('{" CORN ": "2"}', names, SECTIONS);
    expect(out.get('corn')).toBe('s-frozen');
  });

  it('drops 0 (no fit), out-of-range, and non-integer values', () => {
    const out = parseClassifierAnswer(
      '{"Corn": 0, "flour": 9, "extra": 1.5}',
      names,
      SECTIONS
    );
    expect(out.size).toBe(0);
  });

  it('ignores names the model invented', () => {
    const out = parseClassifierAnswer('{"pumpkin": 1}', names, SECTIONS);
    expect(out.size).toBe(0);
  });

  it('fails closed on non-JSON and non-object answers', () => {
    expect(parseClassifierAnswer('not json', names, SECTIONS).size).toBe(0);
    expect(parseClassifierAnswer('[1,2]', names, SECTIONS).size).toBe(0);
    expect(parseClassifierAnswer('null', names, SECTIONS).size).toBe(0);
  });
});
