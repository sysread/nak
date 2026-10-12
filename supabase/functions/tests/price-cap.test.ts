// Offline unit tests for the model price-cap enforcement helper. The pure
// pieces (price extraction from the Venice /models shape, the over-cap
// decision) are tested directly; assertModelWithinCap is exercised with an
// injected fetch and explicit caps so the fail-open posture, the 403 on
// breach, and the inert-when-unconfigured path are covered with no network.
import { assertEquals, assertRejects } from '@std/assert';
import {
  __test,
  assertEditModelWithinCap,
  assertImageModelWithinCap,
  assertModelWithinCap,
  assertUpscaleModelWithinCap,
  capsConfigured,
  coercePriceCaps,
  extractImageModelPrices,
  extractInpaintModelPrices,
  extractModelPrices,
  extractUpscalePrices,
  overCapReason,
} from '../_shared/price-cap.ts';
import { VeniceError } from '../_shared/venice.ts';

// A Venice /models envelope: cheap model + expensive model + a free model
// with no pricing block (the shape Venice returns for internal models).
const CATALOG = {
  object: 'list',
  type: 'text',
  data: [
    {
      id: 'cheap-1',
      model_spec: { pricing: { input: { usd: 0.5 }, output: { usd: 1.5 } } },
    },
    {
      id: 'spendy-1',
      model_spec: { pricing: { input: { usd: 5 }, output: { usd: 20 } } },
    },
    { id: 'free-1', model_spec: {} },
  ],
};

function fetchReturning(body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
}

function fetchThrowing(): typeof fetch {
  return (() => Promise.reject(new Error('venice down'))) as typeof fetch;
}

Deno.test('extractModelPrices reads per-1M USD from the model_spec pricing block', () => {
  const prices = extractModelPrices(CATALOG);
  assertEquals(prices.get('cheap-1'), { inputUsdPerM: 0.5, outputUsdPerM: 1.5 });
  assertEquals(prices.get('spendy-1'), { inputUsdPerM: 5, outputUsdPerM: 20 });
  // Free model: pricing block absent -> both sides null (unpriced).
  assertEquals(prices.get('free-1'), { inputUsdPerM: null, outputUsdPerM: null });
});

Deno.test('overCapReason flags the breached dimension and passes within-cap', () => {
  const caps = { maxInputUsdPerM: 1, maxOutputUsdPerM: 10, maxImageUsd: null };
  assertEquals(overCapReason({ inputUsdPerM: 0.5, outputUsdPerM: 1.5 }, caps), null);
  assertEquals(
    overCapReason({ inputUsdPerM: 5, outputUsdPerM: 1.5 }, caps)?.startsWith('input'),
    true,
  );
  assertEquals(
    overCapReason({ inputUsdPerM: 0.5, outputUsdPerM: 20 }, caps)?.startsWith('output'),
    true,
  );
  // Unpriced side never breaches (fail-open on missing price).
  assertEquals(overCapReason({ inputUsdPerM: null, outputUsdPerM: null }, caps), null);
  // Null cap on a dimension imposes no ceiling there.
  assertEquals(
    overCapReason({ inputUsdPerM: 999, outputUsdPerM: 1 }, { maxInputUsdPerM: null, maxOutputUsdPerM: 10, maxImageUsd: null }),
    null,
  );
});

Deno.test('coercePriceCaps reads an app_config row; non-number / negative -> null', () => {
  assertEquals(
    coercePriceCaps({ max_input_usd_per_m: 2, max_output_usd_per_m: 8, max_image_usd: 0.1 }),
    { maxInputUsdPerM: 2, maxOutputUsdPerM: 8, maxImageUsd: 0.1 }
  );
  // 0 is the no-limit sentinel; a negative / non-numeric column also
  // degrades to "no cap on that side".
  assertEquals(
    coercePriceCaps({ max_input_usd_per_m: 0, max_output_usd_per_m: '0.00', max_image_usd: 0 }),
    { maxInputUsdPerM: null, maxOutputUsdPerM: null, maxImageUsd: null }
  );
  assertEquals(coercePriceCaps({ max_input_usd_per_m: -1, max_output_usd_per_m: 'x' }), {
    maxInputUsdPerM: null,
    maxOutputUsdPerM: null,
    maxImageUsd: null,
  });
  // PostgREST serializes numeric columns as JSON strings - coerce them.
  assertEquals(
    coercePriceCaps({ max_input_usd_per_m: '2.5', max_output_usd_per_m: '10', max_image_usd: '0.05' }),
    { maxInputUsdPerM: 2.5, maxOutputUsdPerM: 10, maxImageUsd: 0.05 }
  );
  // Unseeded row / absent columns.
  assertEquals(coercePriceCaps({}), {
    maxInputUsdPerM: null,
    maxOutputUsdPerM: null,
    maxImageUsd: null,
  });
  assertEquals(coercePriceCaps(null), {
    maxInputUsdPerM: null,
    maxOutputUsdPerM: null,
    maxImageUsd: null,
  });
  assertEquals(
    capsConfigured({ maxInputUsdPerM: null, maxOutputUsdPerM: null, maxImageUsd: null }),
    false
  );
  assertEquals(
    capsConfigured({ maxInputUsdPerM: 1, maxOutputUsdPerM: null, maxImageUsd: null }),
    true
  );
});

Deno.test('assertModelWithinCap throws a 403 VeniceError on an over-cap model', async () => {
  __test.resetCache();
  const err = await assertRejects(
    () =>
      assertModelWithinCap({
        model: 'spendy-1',
        apiKey: 'k',
        caps: { maxInputUsdPerM: 1, maxOutputUsdPerM: 10, maxImageUsd: null },
        fetchImpl: fetchReturning(CATALOG),
      }),
    VeniceError,
  );
  assertEquals(err.status, 403);
});

Deno.test('assertModelWithinCap allows a within-cap model', async () => {
  __test.resetCache();
  await assertModelWithinCap({
    model: 'cheap-1',
    apiKey: 'k',
    caps: { maxInputUsdPerM: 1, maxOutputUsdPerM: 10, maxImageUsd: null },
    fetchImpl: fetchReturning(CATALOG),
  });
});

Deno.test('assertModelWithinCap allows an unknown / unpriced model (fail-open)', async () => {
  __test.resetCache();
  await assertModelWithinCap({
    model: 'not-in-catalog',
    apiKey: 'k',
    caps: { maxInputUsdPerM: 0.01, maxOutputUsdPerM: 0.01, maxImageUsd: null },
    fetchImpl: fetchReturning(CATALOG),
  });
  __test.resetCache();
  // free-1 is in the catalog but has no price -> cannot breach.
  await assertModelWithinCap({
    model: 'free-1',
    apiKey: 'k',
    caps: { maxInputUsdPerM: 0.01, maxOutputUsdPerM: 0.01, maxImageUsd: null },
    fetchImpl: fetchReturning(CATALOG),
  });
});

Deno.test('assertModelWithinCap is inert when no cap is configured', async () => {
  __test.resetCache();
  let fetched = false;
  const fetchImpl = (() => {
    fetched = true;
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
  await assertModelWithinCap({
    model: 'spendy-1',
    apiKey: 'k',
    caps: { maxInputUsdPerM: null, maxOutputUsdPerM: null, maxImageUsd: null },
    fetchImpl,
  });
  // No cap -> never even fetches the catalog.
  assertEquals(fetched, false);
});

Deno.test('assertModelWithinCap fails open when the catalog fetch throws', async () => {
  __test.resetCache();
  await assertModelWithinCap({
    model: 'spendy-1',
    apiKey: 'k',
    caps: { maxInputUsdPerM: 0.01, maxOutputUsdPerM: 0.01, maxImageUsd: null },
    fetchImpl: fetchThrowing(),
  });
});

// A Venice /models?type=image envelope: cheap + expensive + a per-tier
// model with no flat generation price.
const IMAGE_CATALOG = {
  object: 'list',
  type: 'image',
  data: [
    { id: 'img-cheap', model_spec: { pricing: { generation: { usd: 0.01 } } } },
    { id: 'img-spendy', model_spec: { pricing: { generation: { usd: 0.5 } } } },
    { id: 'img-tiered', model_spec: { pricing: {} } },
  ],
};

Deno.test('extractImageModelPrices reads per-image USD from pricing.generation', () => {
  const prices = extractImageModelPrices(IMAGE_CATALOG);
  assertEquals(prices.get('img-cheap'), 0.01);
  assertEquals(prices.get('img-spendy'), 0.5);
  assertEquals(prices.get('img-tiered'), null);
});

Deno.test('assertImageModelWithinCap throws 403 over cap, allows within / unpriced / uncapped', async () => {
  const caps = { maxInputUsdPerM: null, maxOutputUsdPerM: null, maxImageUsd: 0.1 };
  __test.resetCache();
  const err = await assertRejects(
    () =>
      assertImageModelWithinCap({
        model: 'img-spendy',
        apiKey: 'k',
        caps,
        fetchImpl: fetchReturning(IMAGE_CATALOG),
      }),
    VeniceError,
  );
  assertEquals(err.status, 403);

  __test.resetCache();
  await assertImageModelWithinCap({
    model: 'img-cheap',
    apiKey: 'k',
    caps,
    fetchImpl: fetchReturning(IMAGE_CATALOG),
  });

  __test.resetCache();
  // Per-tier (unpriced) model can't breach.
  await assertImageModelWithinCap({
    model: 'img-tiered',
    apiKey: 'k',
    caps,
    fetchImpl: fetchReturning(IMAGE_CATALOG),
  });

  // No image cap -> never fetches.
  let fetched = false;
  const fetchImpl = (() => {
    fetched = true;
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
  await assertImageModelWithinCap({
    model: 'img-spendy',
    apiKey: 'k',
    caps: { maxInputUsdPerM: null, maxOutputUsdPerM: null, maxImageUsd: null },
    fetchImpl,
  });
  assertEquals(fetched, false);
});

// --- Image-edit cap checks (M2 of the image-editing plan) ------------------

// Venice /models?type=inpaint envelope: flat per-edit pricing on every
// live edit model (verified 2026-10-12), plus an unpriced straggler.
const INPAINT_CATALOG = {
  object: 'list',
  type: 'inpaint',
  data: [
    { id: 'edit-cheap', model_spec: { pricing: { inpaint: { usd: 0.04 } } } },
    { id: 'edit-spendy', model_spec: { pricing: { inpaint: { usd: 0.34 } } } },
    { id: 'edit-unpriced', model_spec: { pricing: {} } },
  ],
};

// Venice /models?type=upscale envelope: the fixed upscaler with tiered
// pricing (2x $0.02 / 4x $0.08, live-probed 2026-10-12).
const UPSCALE_CATALOG = {
  object: 'list',
  type: 'upscale',
  data: [
    {
      id: 'upscaler',
      model_spec: {
        pricing: { upscale: { '2x': { usd: 0.02 }, '4x': { usd: 0.08 } } },
      },
    },
  ],
};

Deno.test('extractInpaintModelPrices reads per-edit USD from pricing.inpaint', () => {
  const prices = extractInpaintModelPrices(INPAINT_CATALOG);
  assertEquals(prices.get('edit-cheap'), 0.04);
  assertEquals(prices.get('edit-spendy'), 0.34);
  assertEquals(prices.get('edit-unpriced'), null);
});

Deno.test('extractUpscalePrices reads the 2x/4x tiers off the upscaler row', () => {
  const prices = extractUpscalePrices(UPSCALE_CATALOG);
  assertEquals(prices.get(2), 0.02);
  assertEquals(prices.get(4), 0.08);
  // Missing a tier just leaves it unmapped (the consumer fails open).
  assertEquals(
    extractUpscalePrices({ data: [{ id: 'upscaler', model_spec: { pricing: { upscale: { '2x': { usd: 0.02 } } } } }] }).get(4),
    undefined,
  );
});

Deno.test('assertEditModelWithinCap throws 403 over cap, allows within / unpriced / uncapped', async () => {
  const caps = { maxInputUsdPerM: null, maxOutputUsdPerM: null, maxImageUsd: 0.1 };
  __test.resetCache();
  const err = await assertRejects(
    () =>
      assertEditModelWithinCap({
        model: 'edit-spendy',
        apiKey: 'k',
        caps,
        fetchImpl: fetchReturning(INPAINT_CATALOG),
      }),
    VeniceError,
  );
  assertEquals(err.status, 403);

  __test.resetCache();
  await assertEditModelWithinCap({
    model: 'edit-cheap',
    apiKey: 'k',
    caps,
    fetchImpl: fetchReturning(INPAINT_CATALOG),
  });

  __test.resetCache();
  // Unpriced edit model can't breach.
  await assertEditModelWithinCap({
    model: 'edit-unpriced',
    apiKey: 'k',
    caps,
    fetchImpl: fetchReturning(INPAINT_CATALOG),
  });

  // No image cap -> inert (never fetches).
  let fetched = false;
  const fetchImpl = (() => {
    fetched = true;
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
  await assertEditModelWithinCap({
    model: 'edit-spendy',
    apiKey: 'k',
    caps: { maxInputUsdPerM: null, maxOutputUsdPerM: null, maxImageUsd: null },
    fetchImpl,
  });
  assertEquals(fetched, false);

  // Catalog hiccup -> fail open.
  __test.resetCache();
  await assertEditModelWithinCap({
    model: 'edit-spendy',
    apiKey: 'k',
    caps,
    fetchImpl: fetchThrowing(),
  });
});

Deno.test('assertUpscaleModelWithinCap bills by tier: 2x at the 2x rate, 3x+ at 4x', async () => {
  const caps = { maxInputUsdPerM: null, maxOutputUsdPerM: null, maxImageUsd: 0.05 };
  __test.resetCache();
  // 2x at $0.02 passes a $0.05 cap.
  await assertUpscaleModelWithinCap({ scale: 2, apiKey: 'k', caps, fetchImpl: fetchReturning(UPSCALE_CATALOG) });

  __test.resetCache();
  // 3x bills at the 4x rate ($0.08) -> over the cap.
  const err = await assertRejects(
    () => assertUpscaleModelWithinCap({ scale: 3, apiKey: 'k', caps, fetchImpl: fetchReturning(UPSCALE_CATALOG) }),
    VeniceError,
  );
  assertEquals(err.status, 403);

  __test.resetCache();
  // 4x at $0.08 -> over the cap.
  const err4 = await assertRejects(
    () => assertUpscaleModelWithinCap({ scale: 4, apiKey: 'k', caps, fetchImpl: fetchReturning(UPSCALE_CATALOG) }),
    VeniceError,
  );
  assertEquals(err4.status, 403);

  __test.resetCache();
  // No cap -> inert.
  await assertUpscaleModelWithinCap({
    scale: 4,
    apiKey: 'k',
    caps: { maxInputUsdPerM: null, maxOutputUsdPerM: null, maxImageUsd: null },
    fetchImpl: fetchReturning(UPSCALE_CATALOG),
  });

  __test.resetCache();
  // Catalog hiccup -> fail open.
  await assertUpscaleModelWithinCap({
    scale: 4,
    apiKey: 'k',
    caps,
    fetchImpl: fetchThrowing(),
  });
});
