/**
 * Unit coverage for the Venice edit-model catalog coercion
 * (GET /models?type=inpaint). Mirrors the image-catalog.test.ts shape:
 * the coercion is the only logic - the picker renders whatever passes.
 */
import { describe, it, expect } from 'vitest';
import { coerceEditCatalog } from '../src/lib/models/edit-image-catalog';

const ENVELOPE = {
  object: 'list',
  type: 'inpaint',
  data: [
    {
      id: 'firered-image-edit',
      model_spec: {
        name: 'FireRed Image Edit',
        privacy: 'private',
        pricing: { inpaint: { usd: 0.04 } },
      },
    },
    {
      id: 'nano-banana-2-edit',
      model_spec: {
        name: 'Nano Banana 2 Edit',
        privacy: 'anonymized',
        beta: true,
        pricing: { inpaint: { usd: 0.1 } },
      },
    },
    // Offline: in the catalog but not servable - dropped.
    {
      id: 'offline-edit',
      model_spec: { privacy: 'private', offline: true, pricing: { inpaint: { usd: 0.01 } } },
    },
    // Unpriced: no flat per-edit rate - dropped (picker never shows a
    // price-less row).
    {
      id: 'free-edit',
      model_spec: { privacy: 'private', pricing: {} },
    },
    // Blocked-model policy (src/lib/models/blocked-models.ts): Grok
    // rows never reach the picker, on the id...
    {
      id: 'grok-imagine-edit',
      model_spec: {
        name: 'Grok Imagine Edit',
        privacy: 'anonymized',
        pricing: { inpaint: { usd: 0.03 } },
      },
    },
    // ...or the display name alone.
    {
      id: 'innocuous-edit',
      model_spec: {
        name: 'Grok Edit Pro',
        privacy: 'private',
        pricing: { inpaint: { usd: 0.02 } },
      },
    },
    // Missing spec entirely - dropped.
    { id: 'bare-edit' },
  ],
};

describe('coerceEditCatalog', () => {
  it('flattens usable rows with privacy, price, and flags', () => {
    const models = coerceEditCatalog(ENVELOPE);
    expect(models.map((m) => m.id)).toEqual(['firered-image-edit', 'nano-banana-2-edit']);
    expect(models[0]).toEqual({
      id: 'firered-image-edit',
      name: 'FireRed Image Edit',
      usdPerEdit: 0.04,
      privacy: 'private',
      beta: false,
      deprecated: false,
    });
    expect(models[1].privacy).toBe('anonymized');
    expect(models[1].beta).toBe(true);
  });

  it('sorts by display name regardless of catalog order', () => {
    const models = coerceEditCatalog(ENVELOPE);
    const names = models.map((m) => m.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('accepts a bare array and drops garbage entries', () => {
    const models = coerceEditCatalog([...ENVELOPE.data, null, 'junk', 42] as unknown[]);
    expect(models).toHaveLength(2);
  });

  it('drops blocked models (Grok) on id or display name', () => {
    // The ENVELOPE carries both blocked rows (grok-imagine-edit and a
    // grok-named innocuous-edit); neither survives coercion.
    const models = coerceEditCatalog(ENVELOPE);
    expect(models.map((m) => m.id)).toEqual(['firered-image-edit', 'nano-banana-2-edit']);
  });

  it('classifies anything but anonymized as private (defensive default)', () => {
    const models = coerceEditCatalog({
      data: [{ id: 'x', model_spec: { pricing: { inpaint: { usd: 0.02 } }, privacy: 'weird' } }],
    });
    expect(models[0].privacy).toBe('private');
  });
});
