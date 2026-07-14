import { describe, expect, it } from 'vitest';
import {
  OTHER_SECTION_LABEL,
  acquiredHeaderLabel,
  canCreateGroceryItem,
  groceryItemFromIngredient,
  groupItemsBySection,
  itemQuantityLabel,
  normalizeGroceryName,
  recipeCheckboxItemIds,
  sectionOrderAfterDrag,
} from '../src/lib/ui/grocery-list';
import type { GroceryItemView, GrocerySection } from '../src/lib/supabase';
import type { Ingredient } from '../src/lib/cooklang';

function section(id: string, name: string, position: number): GrocerySection {
  return { id, name, position, created_at: '2026-01-01T00:00:00Z' };
}

function item(overrides: Partial<GroceryItemView> & { name: string }): GroceryItemView {
  return {
    id: overrides.name,
    count: null,
    unit: null,
    note: null,
    section_id: null,
    needed: true,
    recipe_id: null,
    image_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    recipe_title: null,
    image_url: null,
    ...overrides,
  };
}

function ingredient(overrides: Partial<Ingredient> & { name: string }): Ingredient {
  return { qty: null, unit: null, optional: false, ...overrides };
}

describe('normalizeGroceryName', () => {
  it('trims and lowercases', () => {
    expect(normalizeGroceryName('  Eggs ')).toBe('eggs');
  });
});

describe('groupItemsBySection', () => {
  const sections = [section('a', 'Produce', 0), section('b', 'Dairy', 1)];

  it('groups in section order and pins Other last', () => {
    const items = [
      item({ name: 'milk', section_id: 'b' }),
      item({ name: 'bread', section_id: null }),
      item({ name: 'apples', section_id: 'a' }),
    ];
    const groups = groupItemsBySection(sections, items);
    expect(groups.map((g) => g.name)).toEqual(['Produce', 'Dairy', OTHER_SECTION_LABEL]);
    expect(groups[2]!.id).toBeNull();
    expect(groups[2]!.items.map((i) => i.name)).toEqual(['bread']);
  });

  it('includes empty sections and an empty Other - every card renders', () => {
    const groups = groupItemsBySection(sections, [item({ name: 'kale', section_id: 'a' })]);
    expect(groups.map((g) => g.name)).toEqual(['Produce', 'Dairy', OTHER_SECTION_LABEL]);
    expect(groups[1]!.items).toEqual([]);
    expect(groups[2]!.items).toEqual([]);
  });

  it('files items pointing at a deleted section under Other', () => {
    const groups = groupItemsBySection(sections, [item({ name: 'ghost', section_id: 'gone' })]);
    expect(groups.map((g) => g.name)).toEqual(['Produce', 'Dairy', OTHER_SECTION_LABEL]);
    expect(groups[2]!.items.map((i) => i.name)).toEqual(['ghost']);
  });

  it('preserves item order within a group', () => {
    const items = [
      item({ id: '1', name: 'first', section_id: 'a' }),
      item({ id: '2', name: 'second', section_id: 'a' }),
    ];
    expect(groupItemsBySection(sections, items)[0]!.items.map((i) => i.id)).toEqual(['1', '2']);
  });
});

describe('itemQuantityLabel', () => {
  it('joins count and unit', () => {
    expect(itemQuantityLabel({ count: '2', unit: 'lb' })).toBe('2 lb');
  });
  it('handles count-only and unit-only', () => {
    expect(itemQuantityLabel({ count: '1/2', unit: null })).toBe('1/2');
    expect(itemQuantityLabel({ count: null, unit: 'loaf' })).toBe('loaf');
  });
  it('returns null when both are empty', () => {
    expect(itemQuantityLabel({ count: null, unit: null })).toBeNull();
    expect(itemQuantityLabel({ count: '  ', unit: '' })).toBeNull();
  });
});

describe('acquiredHeaderLabel', () => {
  it('shows exact count when fully loaded', () => {
    expect(acquiredHeaderLabel(3, false)).toBe('Acquired (3)');
  });
  it('marks the count as a lower bound when more pages exist', () => {
    expect(acquiredHeaderLabel(30, true)).toBe('Acquired (30+)');
  });
});

describe('canCreateGroceryItem', () => {
  const suggestions = [item({ name: 'Eggs', needed: false })];
  const needed = [item({ name: 'Milk' })];

  it('allows a genuinely new name', () => {
    expect(canCreateGroceryItem('butter', suggestions, needed)).toBe(true);
  });
  it('refuses empty input', () => {
    expect(canCreateGroceryItem('   ', suggestions, needed)).toBe(false);
  });
  it('refuses a name matching a suggestion (reuse its row instead)', () => {
    expect(canCreateGroceryItem('eggs ', suggestions, needed)).toBe(false);
  });
  it('refuses a name already on the needed list', () => {
    expect(canCreateGroceryItem('MILK', suggestions, needed)).toBe(false);
  });
});

describe('sectionOrderAfterDrag', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('moves an id earlier', () => {
    expect(sectionOrderAfterDrag(ids, 'c', 'a')).toEqual(['c', 'a', 'b', 'd']);
  });
  it('moves an id later', () => {
    expect(sectionOrderAfterDrag(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });
  it('returns null for a self-drop or unknown ids', () => {
    expect(sectionOrderAfterDrag(ids, 'a', 'a')).toBeNull();
    expect(sectionOrderAfterDrag(ids, 'zz', 'a')).toBeNull();
    expect(sectionOrderAfterDrag(ids, 'a', 'zz')).toBeNull();
  });
});

describe('browse filter mapping', () => {
  it('maps status filters to the needed argument', async () => {
    const { browseNeededArg } = await import('../src/lib/ui/grocery-list');
    expect(browseNeededArg('all')).toBeUndefined();
    expect(browseNeededArg('needed')).toBe(true);
    expect(browseNeededArg('acquired')).toBe(false);
  });

  it('maps section select values to the sectionId argument', async () => {
    const { browseSectionArg, BROWSE_SECTION_ALL, BROWSE_SECTION_OTHER } =
      await import('../src/lib/ui/grocery-list');
    expect(browseSectionArg(BROWSE_SECTION_ALL)).toBeUndefined();
    expect(browseSectionArg(BROWSE_SECTION_OTHER)).toBe('other');
    expect(browseSectionArg('abc-123')).toBe('abc-123');
  });
});

describe('computeBrowseView', () => {
  it('prioritizes error, then loading, then empty, then list', async () => {
    const { computeBrowseView } = await import('../src/lib/ui/grocery-list');
    expect(computeBrowseView({ loading: true, error: 'x', count: 0, filtered: false }))
      .toEqual({ kind: 'error', message: 'x' });
    expect(computeBrowseView({ loading: true, error: null, count: 0, filtered: false }))
      .toEqual({ kind: 'loading' });
    expect(computeBrowseView({ loading: false, error: null, count: 0, filtered: true }))
      .toEqual({ kind: 'empty', reason: 'no-matches' });
    expect(computeBrowseView({ loading: false, error: null, count: 0, filtered: false }))
      .toEqual({ kind: 'empty', reason: 'no-items-yet' });
    expect(computeBrowseView({ loading: false, error: null, count: 3, filtered: false }))
      .toEqual({ kind: 'list' });
  });

  it('keeps showing the list while a refetch is in flight', async () => {
    const { computeBrowseView } = await import('../src/lib/ui/grocery-list');
    expect(computeBrowseView({ loading: true, error: null, count: 5, filtered: true }))
      .toEqual({ kind: 'list' });
  });
});

describe('recipeCheckboxItemIds', () => {
  it('maps ingredients to rows by normalized name', () => {
    const map = recipeCheckboxItemIds(
      [ingredient({ name: 'Flour' }), ingredient({ name: 'salt' })],
      [{ id: 'r1', name: 'flour' }]
    );
    expect(map.get('flour')).toBe('r1');
    expect(map.has('salt')).toBe(false);
  });

  it('collapses duplicate ingredient names onto one row', () => {
    const map = recipeCheckboxItemIds(
      [ingredient({ name: 'butter' }), ingredient({ name: 'Butter' })],
      [{ id: 'r2', name: 'butter' }]
    );
    expect(map.size).toBe(1);
    expect(map.get('butter')).toBe('r2');
  });
});

describe('groceryItemFromIngredient', () => {
  it('carries quantity/unit verbatim and links the recipe', () => {
    const payload = groceryItemFromIngredient(
      ingredient({ name: 'onion', qty: '2-3', unit: 'large' }),
      { id: 'rec-1', title: 'French Onion Soup' }
    );
    expect(payload).toEqual({
      name: 'onion',
      count: '2-3',
      unit: 'large',
      note: 'For French Onion Soup',
      recipe_id: 'rec-1',
    });
  });
});
