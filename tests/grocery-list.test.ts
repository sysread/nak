import { describe, expect, it } from 'vitest';
import {
  OTHER_SECTION_LABEL,
  acquiredHeaderLabel,
  canCreateGroceryItem,
  groceryItemFromIngredient,
  groupItemsBySection,
  itemDetailLine,
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

  it('groups with Other pinned first, then section order', () => {
    const items = [
      item({ name: 'milk', section_id: 'b' }),
      item({ name: 'bread', section_id: null }),
      item({ name: 'apples', section_id: 'a' }),
    ];
    const groups = groupItemsBySection(sections, items);
    expect(groups.map((g) => g.name)).toEqual([OTHER_SECTION_LABEL, 'Produce', 'Dairy']);
    expect(groups[0]!.id).toBeNull();
    expect(groups[0]!.items.map((i) => i.name)).toEqual(['bread']);
  });

  it('includes empty sections and an empty Other - every card renders', () => {
    const groups = groupItemsBySection(sections, [item({ name: 'kale', section_id: 'a' })]);
    expect(groups.map((g) => g.name)).toEqual([OTHER_SECTION_LABEL, 'Produce', 'Dairy']);
    expect(groups[0]!.items).toEqual([]);
    expect(groups[2]!.items).toEqual([]);
  });

  it('files items pointing at a deleted section under Other', () => {
    const groups = groupItemsBySection(sections, [item({ name: 'ghost', section_id: 'gone' })]);
    expect(groups.map((g) => g.name)).toEqual([OTHER_SECTION_LABEL, 'Produce', 'Dairy']);
    expect(groups[0]!.items.map((i) => i.name)).toEqual(['ghost']);
  });

  it('sorts items alphabetically by name within a group', () => {
    const items = [
      item({ id: '1', name: 'zucchini', section_id: 'a' }),
      item({ id: '2', name: 'apples', section_id: 'a' }),
      item({ id: '3', name: 'Melon', section_id: 'a' }),
    ];
    // Index 1: Other is pinned first, Produce ('a') follows.
    expect(groupItemsBySection(sections, items)[1]!.items.map((i) => i.name)).toEqual([
      'apples',
      'Melon',
      'zucchini',
    ]);
  });
});

describe('filterSectionGroups', () => {
  it('hides empty groups by default and shows them when toggled', async () => {
    const { filterSectionGroups, groupItemsBySection } = await import(
      '../src/lib/ui/grocery-list'
    );
    const sections = [section('a', 'Produce', 0), section('b', 'Dairy', 1)];
    const groups = groupItemsBySection(sections, [item({ name: 'kale', section_id: 'a' })]);
    expect(filterSectionGroups(groups, false).map((g) => g.name)).toEqual(['Produce']);
    expect(filterSectionGroups(groups, true).map((g) => g.name)).toEqual([
      'Other',
      'Produce',
      'Dairy',
    ]);
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

describe('itemDetailLine', () => {
  const base = { count: null, unit: null, note: null, recipe_title: null };

  it('joins quantity, note, and recipe title in that order', () => {
    expect(
      itemDetailLine({
        count: '2',
        unit: 'lb',
        note: 'the thick-cut kind',
        recipe_title: 'Chili',
      })
    ).toBe('2 lb \u00b7 the thick-cut kind \u00b7 Chili');
  });

  it('renders whichever parts are present', () => {
    expect(itemDetailLine({ ...base, count: '3' })).toBe('3');
    expect(itemDetailLine({ ...base, note: 'green ones' })).toBe('green ones');
    expect(itemDetailLine({ ...base, recipe_title: 'Chili' })).toBe('Chili');
  });

  it('drops the recipe title when the note already names it', () => {
    expect(
      itemDetailLine({ ...base, note: 'For Chili', recipe_title: 'Chili' })
    ).toBe('For Chili');
  });

  it('keeps the recipe title alongside an unrelated note', () => {
    expect(
      itemDetailLine({ ...base, note: 'For a party', recipe_title: 'Chili' })
    ).toBe('For a party \u00b7 Chili');
  });

  it('returns null when the item carries no details', () => {
    expect(itemDetailLine(base)).toBeNull();
    expect(
      itemDetailLine({ count: ' ', unit: '', note: '  ', recipe_title: '' })
    ).toBeNull();
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

describe('isShoppingTripActive', () => {
  it('is active only on the same local calendar day', async () => {
    const { isShoppingTripActive } = await import('../src/lib/ui/grocery-list');
    const start = new Date(2026, 6, 15, 18, 30); // 6:30pm local
    const iso = start.toISOString();
    expect(isShoppingTripActive(iso, new Date(2026, 6, 15, 23, 59))).toBe(true);
    // Past local midnight: same trip timestamp now reads inactive.
    expect(isShoppingTripActive(iso, new Date(2026, 6, 16, 0, 1))).toBe(false);
    expect(isShoppingTripActive(undefined, new Date())).toBe(false);
    expect(isShoppingTripActive('garbage', new Date())).toBe(false);
    // A future timestamp (clock skew) is not an active trip.
    expect(isShoppingTripActive(iso, new Date(2026, 6, 15, 12, 0))).toBe(false);
  });
});

describe('splitAcquiredForTrip', () => {
  it('routes rows touched since the trip start into the cart', async () => {
    const { splitAcquiredForTrip } = await import('../src/lib/ui/grocery-list');
    const startedAt = '2026-07-15T18:00:00Z';
    const inCart = item({ name: 'eggs', needed: false, updated_at: '2026-07-15T18:05:00Z' });
    const old = item({ name: 'milk', needed: false, updated_at: '2026-07-10T10:00:00Z' });
    const { cart, history } = splitAcquiredForTrip([inCart, old], startedAt, true);
    expect(cart.map((i) => i.name)).toEqual(['eggs']);
    expect(history.map((i) => i.name)).toEqual(['milk']);
  });

  it('returns an empty cart when no trip is active', async () => {
    const { splitAcquiredForTrip } = await import('../src/lib/ui/grocery-list');
    const rows = [item({ name: 'eggs', needed: false, updated_at: '2026-07-15T18:05:00Z' })];
    const { cart, history } = splitAcquiredForTrip(rows, '2026-07-15T18:00:00Z', false);
    expect(cart).toEqual([]);
    expect(history).toHaveLength(1);
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

describe('splitBrowseRows', () => {
  it('splits by recipe link, Staples first, preserving order', async () => {
    const { splitBrowseRows } = await import('../src/lib/ui/grocery-list');
    const groups = splitBrowseRows([
      item({ id: '1', name: 'flour', recipe_id: 'r1' }),
      item({ id: '2', name: 'paper towels', recipe_id: null }),
      item({ id: '3', name: 'eggs', recipe_id: 'r1' }),
      item({ id: '4', name: 'coffee', recipe_id: null }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Staples', 'Ingredients']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['2', '4']);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['1', '3']);
  });

  it('drops empty groups', async () => {
    const { splitBrowseRows } = await import('../src/lib/ui/grocery-list');
    const onlyStaples = splitBrowseRows([item({ name: 'coffee', recipe_id: null })]);
    expect(onlyStaples.map((g) => g.key)).toEqual(['staples']);
    expect(splitBrowseRows([])).toEqual([]);
  });
});

describe('sectionDropEdge', () => {
  it('marks the hovered row edge matching where the drop lands', async () => {
    const { sectionDropEdge } = await import('../src/lib/ui/grocery-list');
    const ids = ['a', 'b', 'c'];
    expect(sectionDropEdge(ids, 'a', 'c')).toBe('bottom'); // dragging down
    expect(sectionDropEdge(ids, 'c', 'a')).toBe('top'); // dragging up
    expect(sectionDropEdge(ids, 'a', 'a')).toBeNull();
    expect(sectionDropEdge(ids, 'zz', 'a')).toBeNull();
  });
});

describe('recipeCheckboxItemIds', () => {
  it('maps ingredients to rows by normalized name, carrying needed', () => {
    const map = recipeCheckboxItemIds(
      [ingredient({ name: 'Flour' }), ingredient({ name: 'salt' })],
      [{ id: 'r1', name: 'flour', needed: true }]
    );
    expect(map.get('flour')).toEqual({ id: 'r1', needed: true });
    expect(map.has('salt')).toBe(false);
  });

  it('collapses duplicate ingredient names onto one row', () => {
    const map = recipeCheckboxItemIds(
      [ingredient({ name: 'butter' }), ingredient({ name: 'Butter' })],
      [{ id: 'r2', name: 'butter', needed: false }]
    );
    expect(map.size).toBe(1);
    expect(map.get('butter')).toEqual({ id: 'r2', needed: false });
  });

  it('prefers a needed row when two rows share a name', () => {
    const map = recipeCheckboxItemIds(
      [ingredient({ name: 'eggs' })],
      [
        { id: 'old', name: 'eggs', needed: false },
        { id: 'live', name: 'Eggs', needed: true },
      ]
    );
    expect(map.get('eggs')).toEqual({ id: 'live', needed: true });
  });
});

describe('partitionIngredientsForAdd', () => {
  it('splits into revive / create, skipping needed rows and dup names', async () => {
    const { partitionIngredientsForAdd } = await import('../src/lib/ui/grocery-list');
    const entries = new Map([
      ['flour', { id: 'f1', needed: true }],
      ['eggs', { id: 'e1', needed: false }],
    ]);
    const { reviveIds, create } = partitionIngredientsForAdd(
      [
        ingredient({ name: 'Flour' }),
        ingredient({ name: 'eggs' }),
        ingredient({ name: 'salt' }),
        ingredient({ name: 'Salt' }),
      ],
      entries
    );
    expect(reviveIds).toEqual(['e1']);
    expect(create.map((i) => i.name)).toEqual(['salt']);
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
