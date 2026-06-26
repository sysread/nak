// Offline unit tests for the model price-cap enforcement helper. The pure
// pieces (price extraction from the Venice /models shape, the over-cap
// decision) are tested directly; assertModelWithinCap is exercised with an
// injected fetch and explicit caps so the fail-open posture, the 403 on
// breach, and the inert-when-unconfigured path are covered with no network.
import { assertEquals, assertRejects } from '@std/assert';
import {
  __test,
  assertModelWithinCap,
  capsConfigured,
  extractModelPrices,
  overCapReason,
  readCaps,
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
  const caps = { maxInputUsdPerM: 1, maxOutputUsdPerM: 10 };
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
    overCapReason({ inputUsdPerM: 999, outputUsdPerM: 1 }, { maxInputUsdPerM: null, maxOutputUsdPerM: 10 }),
    null,
  );
});

Deno.test('readCaps validates: non-number / negative -> null (inert)', () => {
  assertEquals(readCaps({ modelPriceCaps: { maxInputUsdPerM: 2, maxOutputUsdPerM: 8 } }), {
    maxInputUsdPerM: 2,
    maxOutputUsdPerM: 8,
  });
  assertEquals(readCaps({ modelPriceCaps: { maxInputUsdPerM: '2', maxOutputUsdPerM: -1 } }), {
    maxInputUsdPerM: null,
    maxOutputUsdPerM: null,
  });
  assertEquals(readCaps({}), { maxInputUsdPerM: null, maxOutputUsdPerM: null });
  assertEquals(capsConfigured({ maxInputUsdPerM: null, maxOutputUsdPerM: null }), false);
  assertEquals(capsConfigured({ maxInputUsdPerM: 1, maxOutputUsdPerM: null }), true);
});

Deno.test('assertModelWithinCap throws a 403 VeniceError on an over-cap model', async () => {
  __test.resetCache();
  const err = await assertRejects(
    () =>
      assertModelWithinCap({
        model: 'spendy-1',
        apiKey: 'k',
        caps: { maxInputUsdPerM: 1, maxOutputUsdPerM: 10 },
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
    caps: { maxInputUsdPerM: 1, maxOutputUsdPerM: 10 },
    fetchImpl: fetchReturning(CATALOG),
  });
});

Deno.test('assertModelWithinCap allows an unknown / unpriced model (fail-open)', async () => {
  __test.resetCache();
  await assertModelWithinCap({
    model: 'not-in-catalog',
    apiKey: 'k',
    caps: { maxInputUsdPerM: 0.01, maxOutputUsdPerM: 0.01 },
    fetchImpl: fetchReturning(CATALOG),
  });
  __test.resetCache();
  // free-1 is in the catalog but has no price -> cannot breach.
  await assertModelWithinCap({
    model: 'free-1',
    apiKey: 'k',
    caps: { maxInputUsdPerM: 0.01, maxOutputUsdPerM: 0.01 },
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
    caps: { maxInputUsdPerM: null, maxOutputUsdPerM: null },
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
    caps: { maxInputUsdPerM: 0.01, maxOutputUsdPerM: 0.01 },
    fetchImpl: fetchThrowing(),
  });
});
