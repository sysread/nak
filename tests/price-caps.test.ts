// Unit tests for the browser-side model price-cap primitives: coercing the
// app_config row, the over-cap comparison, and the catalog filter that
// feeds the Settings model picker. Mirrors the edge-side coverage in
// supabase/functions/tests/price-cap.test.ts (the logic is duplicated
// across the Deno-island boundary).
import { describe, it, expect } from 'vitest';
import type { CatalogModel } from '../src/lib/models/catalog';
import type { ImageCatalogModel } from '../src/lib/models/image-catalog';
import {
  coercePriceCaps,
  capsConfigured,
  isModelOverCap,
  filterCatalogByCaps,
  isImageModelOverCap,
  filterImageCatalogByCap,
  NO_PRICE_CAPS,
} from '../src/lib/models/price-caps';

function model(id: string, input: number | null, output: number | null): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 128_000,
    supportsVision: false,
    supportsReasoning: false,
    supportsFunctionCalling: false,
    supportsResponseFormat: false,
    inputUsdPerM: input,
    outputUsdPerM: output,
    deprecated: false,
    privacy: null,
    supportsE2EE: false,
  };
}

// usdPerImage is non-nullable on ImageCatalogModel: coerceImageModel drops
// unpriced / resolution-tiered models upstream, so the cap filter only ever
// sees priced rows.
function imageModel(id: string, usdPerImage: number): ImageCatalogModel {
  return { id, name: id, usdPerImage, beta: false, deprecated: false };
}

describe('coercePriceCaps', () => {
  it('reads the cap columns, including PostgREST numeric-as-string', () => {
    expect(
      coercePriceCaps({ max_input_usd_per_m: 3, max_output_usd_per_m: 8.5, max_image_usd: 0.1 })
    ).toEqual({ maxInputUsdPerM: 3, maxOutputUsdPerM: 8.5, maxImageUsd: 0.1 });
    expect(
      coercePriceCaps({
        max_input_usd_per_m: '3.00',
        max_output_usd_per_m: '8.50',
        max_image_usd: '0.10',
      })
    ).toEqual({ maxInputUsdPerM: 3, maxOutputUsdPerM: 8.5, maxImageUsd: 0.1 });
  });

  it('treats 0 / negative / non-numeric / absent as no cap', () => {
    expect(coercePriceCaps({ max_input_usd_per_m: 0, max_output_usd_per_m: '0.00' })).toEqual(
      NO_PRICE_CAPS
    );
    expect(coercePriceCaps({ max_input_usd_per_m: -1, max_output_usd_per_m: 'x' })).toEqual(
      NO_PRICE_CAPS
    );
    expect(coercePriceCaps({})).toEqual(NO_PRICE_CAPS);
    expect(coercePriceCaps(null)).toEqual(NO_PRICE_CAPS);
  });

  it('capsConfigured is false only when both text sides are uncapped', () => {
    expect(capsConfigured(NO_PRICE_CAPS)).toBe(false);
    expect(capsConfigured({ maxInputUsdPerM: 3, maxOutputUsdPerM: null, maxImageUsd: null })).toBe(
      true
    );
    // capsConfigured gates the text catalog fetch only, so an image-only
    // cap does not flip it (the image filter checks maxImageUsd directly).
    expect(capsConfigured({ maxInputUsdPerM: null, maxOutputUsdPerM: null, maxImageUsd: 0.1 })).toBe(
      false
    );
  });
});

describe('isModelOverCap', () => {
  const caps = { maxInputUsdPerM: 3, maxOutputUsdPerM: 8.5, maxImageUsd: null };

  it('flags a breach on either dimension and passes within-cap', () => {
    expect(isModelOverCap(model('a', 1, 2), caps)).toBe(false);
    expect(isModelOverCap(model('b', 5, 2), caps)).toBe(true); // input over
    expect(isModelOverCap(model('c', 1, 20), caps)).toBe(true); // output over
    // Exactly at the cap is allowed (strictly greater breaches).
    expect(isModelOverCap(model('d', 3, 8.5), caps)).toBe(false);
  });

  it('never flags an unpriced side (fail-open on missing price)', () => {
    expect(isModelOverCap(model('e', null, null), caps)).toBe(false);
    expect(isModelOverCap(model('f', null, 20), caps)).toBe(true); // priced side still checked
  });
});

describe('filterCatalogByCaps', () => {
  const catalog = [model('cheap', 1, 2), model('spendy', 5, 20), model('free', null, null)];

  it('drops over-cap models when a cap is set', () => {
    const out = filterCatalogByCaps(catalog, {
      maxInputUsdPerM: 3,
      maxOutputUsdPerM: 8.5,
      maxImageUsd: null,
    });
    expect(out.map((m) => m.id)).toEqual(['cheap', 'free']);
  });

  it('returns the list unchanged when no cap is configured', () => {
    expect(filterCatalogByCaps(catalog, NO_PRICE_CAPS).map((m) => m.id)).toEqual([
      'cheap',
      'spendy',
      'free',
    ]);
  });
});

describe('image cap', () => {
  const caps = { maxInputUsdPerM: null, maxOutputUsdPerM: null, maxImageUsd: 0.1 };
  const imgCatalog = [imageModel('img-cheap', 0.01), imageModel('img-spendy', 0.5)];

  it('isImageModelOverCap flags only a priced model over the cap', () => {
    expect(isImageModelOverCap(imageModel('a', 0.05), caps)).toBe(false);
    expect(isImageModelOverCap(imageModel('b', 0.5), caps)).toBe(true);
    // At the cap passes (strictly greater breaches).
    expect(isImageModelOverCap(imageModel('c', 0.1), caps)).toBe(false);
  });

  it('filterImageCatalogByCap drops over-cap models, no-op when uncapped', () => {
    expect(filterImageCatalogByCap(imgCatalog, caps).map((m) => m.id)).toEqual(['img-cheap']);
    expect(filterImageCatalogByCap(imgCatalog, NO_PRICE_CAPS).map((m) => m.id)).toEqual([
      'img-cheap',
      'img-spendy',
    ]);
  });
});
