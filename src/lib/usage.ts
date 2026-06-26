// The Venice billing-usage domain. Usage lives behind the `venice` edge
// function (the shared key is server-side, so the browser never holds a Venice
// key for this path). What stays here is the part that is NOT transport: the
// consumed bucket shape and the defensive coercion of Venice's
// /billing/usage-analytics response into it. The transport - one request to the
// edge function with the session JWT - is injected by the caller
// (SupabaseService.fetchUsage).
//
// The pane reads the pre-aggregated `byModel` array from
// /billing/usage-analytics: Venice does the per-model roll-up server-side and
// returns it in one cached response, replacing what used to be a 20-page walk
// over the per-request /billing/usage ledger. Everything else in the analytics
// payload (byDate, byModelDaily, byKey, ...) is ignored - the Usage pane only
// needs the per-model token + spend totals.

/**
 * Currency codes the analytics endpoint reports spend in. Venice's `byModel`
 * rows carry `totalUsd` and `totalDiem` only - the per-request ledger's legacy
 * `VCU` and the `BUNDLED_CREDITS` denomination have no field in the analytics
 * shape, so the pane reports USD and DIEM and nothing else. USD is prepaid
 * fiat; DIEM is the staked-credit unit.
 *
 * Docs: https://docs.venice.ai/api-reference/endpoint/billing/usage-analytics
 */
export type UsageCurrency = 'USD' | 'DIEM';

/**
 * One per-model bucket coerced from the analytics `byModel` array - the only
 * slice of the response the Usage pane consumes. `tokens` is an actual token
 * count (Venice reports `totalUnits` in millions of tokens, so the coercer
 * multiplies by 1e6); it is 0 for non-LLM SKUs whose `unitType` isn't tokens
 * (image, video, etc.), which still surface as a bucket so they appear in the
 * list with a zero-width bar. `usd`/`diem` are the model's spend in each
 * currency, already positive (the analytics endpoint reports spend as a
 * positive figure, unlike the per-request ledger's signed debits).
 */
export interface UsageModelBucket {
  modelName: string;
  tokens: number;
  usd: number;
  diem: number;
}

export interface UsageRequestOptions {
  /**
   * Inclusive lower bound as a `YYYY-MM-DD` date. Venice's analytics endpoint
   * wants both bounds or neither; pass both for a custom range, or omit both to
   * let the edge function fall back to its default lookback window.
   */
  startDate?: string;
  /** Inclusive upper bound as a `YYYY-MM-DD` date. See {@link startDate}. */
  endDate?: string;
}

/** Venice reports `totalUnits` in millions of tokens; scale to a raw count. */
const TOKENS_PER_UNIT = 1_000_000;

/**
 * Defensive reader over one `/billing/usage-analytics` `byModel` entry. The
 * endpoint is marked Beta in Venice's docs and we've seen shape drift on other
 * beta endpoints there, so an entry missing any field it needs is dropped
 * rather than allowed to crash the Usage pane. A missing `totalUsd`/`totalDiem`
 * coerces to 0 (the common case - a model billed in one currency reports 0 for
 * the other) rather than dropping the row.
 */
function coerceModelBucket(raw: unknown): UsageModelBucket | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const modelName = typeof r.modelName === 'string' ? r.modelName : null;
  if (!modelName) return null;
  // Only token-billed SKUs carry a meaningful token count; image/video/etc.
  // bill in their own units and contribute 0 tokens (but still appear as a
  // bucket so the spend shows up in the list).
  const isTokens = r.unitType === 'tokens';
  const totalUnits = typeof r.totalUnits === 'number' ? r.totalUnits : 0;
  const tokens = isTokens ? Math.round(totalUnits * TOKENS_PER_UNIT) : 0;
  const usd = typeof r.totalUsd === 'number' ? r.totalUsd : 0;
  const diem = typeof r.totalDiem === 'number' ? r.totalDiem : 0;
  return { modelName, tokens, usd, diem };
}

/**
 * Coerce the analytics response into the per-model buckets the pane renders.
 * Reads only `byModel`; a non-array or missing `byModel` yields an empty list
 * (rendered as "no usage in this range") rather than throwing. Transport-
 * agnostic: the caller does the round trip and hands the parsed JSON body here.
 */
export function coerceUsageAnalytics(raw: unknown): UsageModelBucket[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const byModel = (raw as { byModel?: unknown }).byModel;
  if (!Array.isArray(byModel)) return [];
  const out: UsageModelBucket[] = [];
  for (const entry of byModel) {
    const bucket = coerceModelBucket(entry);
    if (bucket) out.push(bucket);
  }
  return out;
}
