/**
 * Unit coverage for collectUsagePages - the transport-agnostic usage paging
 * loop. The page transport is injected, so row coercion, multi-page
 * accumulation, the USAGE_MAX_PAGES clamp, onProgress, and error propagation are
 * all exercised against a fake fetchPage with no network. The HTTP wire shape
 * (query string, headers, Venice error mapping) lives on the function side and
 * is covered by supabase/functions/tests/usage.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  collectUsagePages,
  USAGE_MAX_PAGES,
  type UsagePageRequest,
  type UsagePageResult,
} from '../src/lib/usage';

function goodRow(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-03-01T12:00:00Z',
    sku: 'llm-output-mtokens-example',
    pricePerUnitUsd: 0.002,
    units: 72,
    amount: 0.14,
    currency: 'USD',
    notes: '',
    inferenceDetails: null,
    ...overrides,
  };
}

// A fetchPage that serves a fixed list of pages (each { rows, totalPages }),
// recording the requests it received so the loop's paging math can be asserted.
// Calls past the list reuse the last page - convenient for the cap test, where
// every page reports the same pathological totalPages.
function pager(pages: UsagePageResult[]): {
  fetchPage: (req: UsagePageRequest) => Promise<UsagePageResult>;
  requests: UsagePageRequest[];
} {
  const requests: UsagePageRequest[] = [];
  let i = 0;
  const fetchPage = (req: UsagePageRequest): Promise<UsagePageResult> => {
    requests.push(req);
    const page = pages[Math.min(i, pages.length - 1)];
    i++;
    return Promise.resolve(page);
  };
  return { fetchPage, requests };
}

describe('collectUsagePages', () => {
  it('coerces a well-formed row', async () => {
    const row = goodRow({
      inferenceDetails: {
        requestId: 'req_1',
        promptTokens: 50_000,
        completionTokens: 22_000,
        inferenceExecutionTime: 1234,
      },
    });
    const { fetchPage } = pager([{ rows: [row], totalPages: 1 }]);
    const rows = await collectUsagePages(fetchPage);
    expect(rows).toEqual([row]);
  });

  it('drops rows that fail coercion without failing the whole fetch', async () => {
    // Defensive decoder drops any row missing a required scalar. The endpoint is
    // marked beta and shape drift shouldn't crash the Usage pane; surviving rows
    // still come through.
    const bad = { sku: 'broken' }; // no timestamp, no amount
    const good = goodRow({ sku: 'grok-41-fast' });
    const { fetchPage } = pager([{ rows: [bad, good], totalPages: 1 }]);
    const rows = await collectUsagePages(fetchPage);
    expect(rows.map((r) => r.sku)).toEqual(['grok-41-fast']);
  });

  it('drops rows with an unrecognized currency', async () => {
    const { fetchPage } = pager([{ rows: [goodRow({ currency: 'BTC' })], totalPages: 1 }]);
    const rows = await collectUsagePages(fetchPage);
    expect(rows).toEqual([]);
  });

  it('pages through every page the transport reports and concatenates', async () => {
    const { fetchPage, requests } = pager([
      { rows: [goodRow({ sku: 'a' })], totalPages: 2 },
      { rows: [goodRow({ sku: 'b' })], totalPages: 2 },
    ]);
    const rows = await collectUsagePages(fetchPage);
    expect(rows.map((r) => r.sku)).toEqual(['a', 'b']);
    expect(requests.map((r) => r.page)).toEqual([1, 2]);
  });

  it('forwards the window and fixed page params to the transport', async () => {
    const { fetchPage, requests } = pager([{ rows: [], totalPages: 1 }]);
    await collectUsagePages(fetchPage, {
      startDate: '2026-01-01T00:00:00Z',
      endDate: '2026-02-01T00:00:00Z',
      currency: 'USD',
    });
    expect(requests[0]).toMatchObject({
      page: 1,
      limit: 500,
      sortOrder: 'desc',
      startDate: '2026-01-01T00:00:00Z',
      endDate: '2026-02-01T00:00:00Z',
      currency: 'USD',
    });
  });

  it('reports per-page progress through onProgress', async () => {
    const { fetchPage } = pager([
      { rows: [goodRow()], totalPages: 2 },
      { rows: [goodRow()], totalPages: 2 },
    ]);
    const ticks: { page: number; totalPages: number }[] = [];
    await collectUsagePages(fetchPage, { onProgress: (info) => ticks.push(info) });
    expect(ticks).toEqual([
      { page: 1, totalPages: 2 },
      { page: 2, totalPages: 2 },
    ]);
  });

  it('clamps onProgress totalPages at USAGE_MAX_PAGES and survives a throwing listener', async () => {
    // A pathologically large totalPages must not promise pages the cap will
    // never let the loop pull, and a misbehaving UI listener must not abort
    // paging.
    const { fetchPage } = pager([{ rows: [], totalPages: 9999 }]);
    const ticks: { page: number; totalPages: number }[] = [];
    await collectUsagePages(fetchPage, {
      onProgress: (info) => {
        ticks.push(info);
        throw new Error('listener throws should not abort paging');
      },
    });
    expect(ticks).toHaveLength(USAGE_MAX_PAGES);
    expect(ticks[0]).toEqual({ page: 1, totalPages: USAGE_MAX_PAGES });
    expect(ticks[ticks.length - 1]).toEqual({
      page: USAGE_MAX_PAGES,
      totalPages: USAGE_MAX_PAGES,
    });
  });

  it('propagates a transport error', async () => {
    // The transport (SupabaseService.fetchUsagePage) throws VeniceError on a
    // failed page; the loop must not swallow it.
    const fetchPage = () => Promise.reject(new Error('boom'));
    await expect(collectUsagePages(fetchPage)).rejects.toThrow('boom');
  });
});
