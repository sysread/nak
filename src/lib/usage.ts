// The Venice billing-usage domain. This lived on VeniceClient until usage moved
// behind the `venice` edge function (the shared key is server-side now, so the
// browser no longer holds a Venice key for this path). What stays here is the
// part that is NOT transport: the row shape, the defensive coercion, the paging
// cap, and the page-accumulation loop. The transport - one page fetched from
// the edge function with the session JWT - is injected by the caller
// (SupabaseService.fetchUsage). Keeping the loop transport-agnostic is what lets
// it be unit-tested against a fake page fetcher with no network.

/**
 * Currency codes Venice reports on billing rows. USD is the obvious fiat
 * denominator; VCU ("Venice Compute Units") is the credit unit on
 * prepaid/bundled plans; DIEM and BUNDLED_CREDITS show up on Venice's
 * token-economy and partner-credit tiers. Listed here as a union so the UI can
 * format the pill ("$0.07" vs "0.15 VCU") without having to guess.
 *
 * Docs: https://docs.venice.ai/api-reference/endpoint/billing/usage
 */
export type UsageCurrency = 'USD' | 'VCU' | 'DIEM' | 'BUNDLED_CREDITS';

/**
 * One row of the `/billing/usage` response. Each row is a single charge against
 * a product SKU - one chat completion, one embedding batch, one image
 * generation. LLM rows carry an `inferenceDetails` block with prompt/completion
 * token counts; non-LLM SKUs (image, video, etc.) leave it null. `units` is the
 * billable quantity in whatever unit the SKU bills in (typically output
 * mega-tokens for LLMs); `amount` is the cost in `currency`.
 *
 * Every field beyond the JSON-mandatory ones is treated as optional by the
 * parser - the endpoint is marked beta in Venice's docs and shape drift is
 * likely. See {@link coerceUsageRow}.
 */
export interface UsageRow {
  timestamp: string;
  sku: string;
  pricePerUnitUsd: number;
  units: number;
  amount: number;
  currency: UsageCurrency;
  notes: string;
  inferenceDetails: {
    requestId?: string;
    inferenceExecutionTime?: number;
    promptTokens?: number;
    completionTokens?: number;
  } | null;
}

export interface UsageRequestOptions {
  /** ISO 8601 lower bound (inclusive). Omitted -> unbounded. */
  startDate?: string;
  /** ISO 8601 upper bound (exclusive, per Venice docs). Omitted -> unbounded. */
  endDate?: string;
  /**
   * Filter to a single currency. Usually left unset so the caller sees every
   * charge regardless of denomination - pill formatting downstream handles the
   * mix.
   */
  currency?: UsageCurrency;
  /**
   * Fires once per page after that page lands. `page` is the 1-based index of
   * the page that just arrived; `totalPages` is the server-reported page count
   * clamped to {@link USAGE_MAX_PAGES}. Callers use this to surface a progress
   * hint in the Usage pane - the first tick teaches the UI how many pages to
   * expect, subsequent ticks advance the counter. Driving this per page is the
   * whole reason the loop stays in the browser rather than the function: a
   * single fat server-side response could not report page-by-page progress.
   *
   * Best-effort: a throw inside the callback is swallowed so a misbehaving UI
   * listener can't abort the paging loop mid-window.
   */
  onProgress?: (info: { page: number; totalPages: number }) => void;
}

/**
 * Safety cap on usage paging. 20 x 500 = 10k rows - more than enough for a
 * month of heavy use, and bounded memory for a pathological response. Hitting
 * the cap is surfaced by the Usage pane as a truncation note so the user knows
 * to narrow the date range rather than silently seeing only the top slice.
 */
export const USAGE_MAX_PAGES = 20;

/** Rows per page requested from Venice. The cap above counts in these units. */
const USAGE_PAGE_LIMIT = 500;

/**
 * Defensive reader for one `/billing/usage` row. Venice's docs mark the endpoint
 * beta and we've seen shape drift on other beta endpoints there - so every field
 * is validated and a row that fails any check is dropped entirely. Better to
 * lose one malformed row than crash the Usage pane on a single bad entry.
 */
function coerceUsageRow(raw: unknown): UsageRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const timestamp = typeof r.timestamp === 'string' ? r.timestamp : null;
  const sku = typeof r.sku === 'string' ? r.sku : null;
  const amount = typeof r.amount === 'number' ? r.amount : null;
  const units = typeof r.units === 'number' ? r.units : null;
  const pricePerUnitUsd =
    typeof r.pricePerUnitUsd === 'number' ? r.pricePerUnitUsd : null;
  const currency = isUsageCurrency(r.currency) ? r.currency : null;
  if (!timestamp || !sku || amount === null || units === null || currency === null) {
    return null;
  }
  const notes = typeof r.notes === 'string' ? r.notes : '';
  let inferenceDetails: UsageRow['inferenceDetails'] = null;
  if (typeof r.inferenceDetails === 'object' && r.inferenceDetails !== null) {
    const d = r.inferenceDetails as Record<string, unknown>;
    const details: NonNullable<UsageRow['inferenceDetails']> = {};
    if (typeof d.requestId === 'string') details.requestId = d.requestId;
    if (typeof d.inferenceExecutionTime === 'number') {
      details.inferenceExecutionTime = d.inferenceExecutionTime;
    }
    if (typeof d.promptTokens === 'number') details.promptTokens = d.promptTokens;
    if (typeof d.completionTokens === 'number') {
      details.completionTokens = d.completionTokens;
    }
    inferenceDetails = details;
  }
  return {
    timestamp,
    sku,
    pricePerUnitUsd: pricePerUnitUsd ?? 0,
    units,
    amount,
    currency,
    notes,
    inferenceDetails,
  };
}

function isUsageCurrency(v: unknown): v is UsageCurrency {
  return v === 'USD' || v === 'VCU' || v === 'DIEM' || v === 'BUNDLED_CREDITS';
}

/** The per-page request the loop hands its injected transport. */
export interface UsagePageRequest {
  page: number;
  limit: number;
  sortOrder: 'asc' | 'desc';
  startDate?: string;
  endDate?: string;
  currency?: UsageCurrency;
}

/** One page as returned by the transport: raw rows plus the reported count. */
export interface UsagePageResult {
  /** Raw rows straight from the function; coerced by the loop below. */
  rows: unknown[];
  /** Server-reported total page count; the loop clamps it to the safety cap. */
  totalPages: number;
}

type UsagePageFetcher = (req: UsagePageRequest) => Promise<UsagePageResult>;

/**
 * Page through the usage range and return every coerced row. Transport-agnostic:
 * `fetchPage` does one round trip (today, a call to the venice function's /usage
 * route) and may throw on failure - that error propagates unchanged so callers
 * can render it. The loop owns coercion, the {@link USAGE_MAX_PAGES} clamp, the
 * per-page {@link UsageRequestOptions.onProgress} tick, and the break condition.
 */
export async function collectUsagePages(
  fetchPage: UsagePageFetcher,
  opts: UsageRequestOptions = {}
): Promise<UsageRow[]> {
  const out: UsageRow[] = [];
  let page = 1;
  for (;;) {
    const { rows, totalPages: reported } = await fetchPage({
      page,
      limit: USAGE_PAGE_LIMIT,
      sortOrder: 'desc',
      startDate: opts.startDate,
      endDate: opts.endDate,
      currency: opts.currency,
    });
    for (const raw of rows) {
      const row = coerceUsageRow(raw);
      if (row) out.push(row);
    }
    // Clamp at the safety cap so a progress UI reading "page 19 of 384" doesn't
    // promise rows the loop will never return. The truncated flag downstream is
    // what tells the user the window was wider than the cap could pull.
    const totalPages = Math.min(reported, USAGE_MAX_PAGES);
    try {
      opts.onProgress?.({ page, totalPages });
    } catch {
      // Best-effort: a listener throw must not abort paging.
    }
    if (page >= totalPages) break;
    page++;
  }
  return out;
}
