/**
 * Unit coverage for the Settings edit-model picker primitives: option
 * assembly, privacy badge glyphs, per-edit price label, and the
 * default-clears-override mapping. Mirrors image-model-picker.test.ts
 * (the generation twin).
 */
import { describe, it, expect } from 'vitest';
import type { EditCatalogModel } from '../src/lib/models/edit-image-catalog';
import {
  buildEditModelOptions,
  editModelOption,
  editImageModelLabel,
  editImageModelOverrideFor,
  formatEditPrice,
} from '../src/lib/ui/edit-image-picker';

const PRIVATE: EditCatalogModel = {
  id: 'firered-image-edit',
  name: 'FireRed Image Edit',
  usdPerEdit: 0.04,
  privacy: 'private',
  beta: false,
  deprecated: false,
};

const ANONYMIZED: EditCatalogModel = {
  id: 'nano-banana-2-edit',
  name: 'Nano Banana 2 Edit',
  usdPerEdit: 0.1,
  privacy: 'anonymized',
  beta: true,
  deprecated: false,
};

describe('editModelOption', () => {
  it('formats the per-edit price and carries the privacy badge', () => {
    const opt = editModelOption(PRIVATE);
    expect(opt.priceLabel).toBe('$0.040/edit');
    // Same glyph semantics as privacyChip: lock = private.
    expect(opt.badges).toContain('\u{1F512} Private');
    expect(opt.badges).not.toContain('beta');
  });

  it('badges anonymized with the mask glyph and beta rows', () => {
    const opt = editModelOption(ANONYMIZED);
    expect(opt.badges).toContain('\u{1F3AD} Anonymized');
    expect(opt.badges).toContain('beta');
  });
});

describe('buildEditModelOptions', () => {
  it('lists every catalog row in order', () => {
    const options = buildEditModelOptions([PRIVATE, ANONYMIZED], 'firered-image-edit');
    expect(options.map((o) => o.id)).toEqual(['firered-image-edit', 'nano-banana-2-edit']);
  });

  it('prepends a synthetic current row for an off-catalog pick', () => {
    const options = buildEditModelOptions([PRIVATE], 'retired-edit');
    expect(options[0]).toMatchObject({ id: 'retired-edit', name: 'retired-edit', priceLabel: null });
    expect(options[0].badges).toContain('current');
  });
});

describe('editImageModelOverrideFor', () => {
  it('clears the override when picking the built-in default', () => {
    expect(editImageModelOverrideFor('firered-image-edit')).toBeUndefined();
  });

  it('stores any other id as-is', () => {
    expect(editImageModelOverrideFor('nano-banana-2-edit')).toBe('nano-banana-2-edit');
  });
});

describe('labels and prices', () => {
  it('resolves the display name from the catalog, falling back to the id', () => {
    expect(editImageModelLabel([PRIVATE], 'firered-image-edit')).toBe('FireRed Image Edit');
    expect(editImageModelLabel([], 'ghost-edit')).toBe('ghost-edit');
  });

  it('formats three-decimal per-edit prices', () => {
    expect(formatEditPrice(0.04)).toBe('$0.040/edit');
  });
});
