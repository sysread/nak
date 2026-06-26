import { describe, it, expect } from 'vitest';
import {
  coerceImageCatalog,
  type ImageCatalogModel,
} from '../src/lib/models/image-catalog';
import {
  buildImageModelOptions,
  formatImagePrice,
  imageModelLabel,
} from '../src/lib/ui/image-model-picker';

// One raw /models?type=image entry in Venice's nested shape.
function rawEntry(over: Record<string, unknown> = {}): unknown {
  return {
    id: 'venice-sd35',
    model_spec: {
      name: 'Venice SD3.5',
      pricing: { generation: { usd: 0.01 } },
      ...over,
    },
  };
}

describe('coerceImageCatalog', () => {
  it('flattens a well-formed image entry', () => {
    const [model] = coerceImageCatalog({ data: [rawEntry()] });
    expect(model).toEqual<ImageCatalogModel>({
      id: 'venice-sd35',
      name: 'Venice SD3.5',
      usdPerImage: 0.01,
      beta: false,
      deprecated: false,
    });
  });

  it('accepts a bare array as well as the {data} envelope', () => {
    expect(coerceImageCatalog([rawEntry()])).toHaveLength(1);
    expect(coerceImageCatalog({ data: [rawEntry()] })).toHaveLength(1);
  });

  it('drops offline models so the picker never offers an unservable one', () => {
    expect(coerceImageCatalog([rawEntry({ offline: true })])).toEqual([]);
  });

  it('drops entries missing an id or model_spec', () => {
    expect(coerceImageCatalog([{ model_spec: { name: 'x' } }])).toEqual([]);
    expect(coerceImageCatalog([{ id: 'x' }])).toEqual([]);
  });

  it('reads usdPerImage from flat generation pricing, null when absent', () => {
    const [flat] = coerceImageCatalog([rawEntry()]);
    expect(flat.usdPerImage).toBe(0.01);
    const [noPrice] = coerceImageCatalog([rawEntry({ pricing: undefined })]);
    expect(noPrice.usdPerImage).toBeNull();
  });

  it('treats resolution-tiered pricing as no single rate (null)', () => {
    // pricing.resolutions.* has no representative flat number, so the row
    // shows "n/a" rather than picking an arbitrary tier.
    const [tiered] = coerceImageCatalog([
      rawEntry({ pricing: { resolutions: { '1K': { usd: 0.01 } } } }),
    ]);
    expect(tiered.usdPerImage).toBeNull();
  });

  it('flags beta (either flag) and deprecation', () => {
    const [beta] = coerceImageCatalog([rawEntry({ beta: true })]);
    expect(beta.beta).toBe(true);
    const [betaModel] = coerceImageCatalog([rawEntry({ betaModel: true })]);
    expect(betaModel.beta).toBe(true);
    const [dep] = coerceImageCatalog([
      rawEntry({ deprecation: { date: '2026-01-01T00:00:00.000Z' } }),
    ]);
    expect(dep.deprecated).toBe(true);
  });

  it('falls back to the id when name is missing, and sorts by name', () => {
    const list = coerceImageCatalog([
      rawEntry({ name: undefined }),
      { id: 'aaa-model', model_spec: { name: 'Aaa' } },
    ]);
    // 'Aaa' sorts before 'venice-sd35' (the id used as the missing name).
    expect(list.map((m) => m.name)).toEqual(['Aaa', 'venice-sd35']);
  });
});

describe('formatImagePrice', () => {
  it('renders three decimals per image', () => {
    expect(formatImagePrice(0.01)).toBe('$0.010/image');
  });
  it('reads n/a for null pricing', () => {
    expect(formatImagePrice(null)).toBe('price n/a');
  });
});

describe('imageModelLabel', () => {
  const base: ImageCatalogModel = {
    id: 'venice-sd35',
    name: 'Venice SD3.5',
    usdPerImage: 0.01,
    beta: false,
    deprecated: false,
  };

  it('combines name and price', () => {
    expect(imageModelLabel(base)).toBe('Venice SD3.5 - $0.010/image');
  });

  it('appends beta and retiring badges', () => {
    expect(imageModelLabel({ ...base, beta: true })).toBe(
      'Venice SD3.5 - $0.010/image (beta)'
    );
    expect(imageModelLabel({ ...base, beta: true, deprecated: true })).toBe(
      'Venice SD3.5 - $0.010/image (beta, retiring)'
    );
  });
});

describe('buildImageModelOptions', () => {
  const catalog: ImageCatalogModel[] = [
    { id: 'venice-sd35', name: 'Venice SD3.5', usdPerImage: 0.01, beta: false, deprecated: false },
    { id: 'flux-dev', name: 'FLUX Dev', usdPerImage: 0.02, beta: false, deprecated: false },
  ];

  it('maps catalog rows to labelled options', () => {
    const opts = buildImageModelOptions(catalog, 'venice-sd35');
    expect(opts).toHaveLength(2);
    expect(opts.find((o) => o.id === 'flux-dev')?.label).toBe(
      'FLUX Dev - $0.020/image'
    );
  });

  it('prepends a synthetic current option when the id is off-catalog', () => {
    // e.g. a retired pick or the default that the image catalog dropped -
    // the select must still show the real current value.
    const opts = buildImageModelOptions(catalog, 'some-retired-model');
    expect(opts[0]).toEqual({
      id: 'some-retired-model',
      label: 'some-retired-model (current)',
    });
    expect(opts).toHaveLength(3);
  });

  it('does not duplicate the current option when it is in the catalog', () => {
    const opts = buildImageModelOptions(catalog, 'flux-dev');
    expect(opts).toHaveLength(2);
  });

  it('synthesizes a current option against an empty catalog', () => {
    const opts = buildImageModelOptions([], 'venice-sd35');
    expect(opts).toEqual([{ id: 'venice-sd35', label: 'venice-sd35 (current)' }]);
  });
});
