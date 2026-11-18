// Venice billing surface: the /billing/usage-analytics query
// builder + relay, and the per-key spend read from /api_keys. The
// barrel _shared/venice.ts re-exports everything.
import { DEFAULT_BASE_URL, VeniceError } from './shared.ts';

export interface UsageAnalyticsParams {
  /** Inclusive lower bound, `YYYY-MM-DD`. Both bounds or neither. */
  startDate?: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. Both bounds or neither. */
  endDate?: string;
}

// Default analytics window when the browser sends no explicit range. Matches
// the Usage pane's rolling default; Venice clamps oversized lookbacks to 90d.
const DEFAULT_ANALYTICS_LOOKBACK = '7d';

/**
 * Assemble the Venice /billing/usage-analytics query string. Pure so the param
 * shaping is unit-testable offline. The endpoint takes EITHER an explicit
 * `startDate`+`endDate` pair (date-only, both required together) OR a
 * `lookback`; when the browser sends a full range we pass it through, otherwise
 * we fall back to the default lookback so an unparameterized call still returns
 * a sane window. A lone startDate or endDate is treated as "no range" rather
 * than forwarded half-set, since Venice requires the pair.
 */
export function buildAnalyticsQuery(params: UsageAnalyticsParams): string {
  const qs = new URLSearchParams();
  if (params.startDate && params.endDate) {
    qs.set('startDate', params.startDate);
    qs.set('endDate', params.endDate);
  } else {
    qs.set('lookback', DEFAULT_ANALYTICS_LOOKBACK);
  }
  return qs.toString();
}

export interface VeniceUsageAnalyticsOptions {
  apiKey: string;
  params: UsageAnalyticsParams;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * GET /billing/usage-analytics from Venice with the shared key. Returns Venice's
 * JSON body verbatim and lets the browser (src/lib/usage.ts) pick out and coerce
 * the `byModel` slice - the same browser-coerces division of labour /models
 * uses, keeping this handler free of UsageModelBucket knowledge. One cached
 * response carries the whole per-model roll-up, so unlike the old /billing/usage
 * proxy there is no paging. Mirrors veniceFetchModels' error mapping: 429 ->
 * rate_limit, everything else -> http.
 */
export async function veniceFetchUsageAnalytics(
  opts: VeniceUsageAnalyticsOptions
): Promise<unknown> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const qs = buildAnalyticsQuery(opts.params);

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/billing/usage-analytics?${qs}`, {
      method: 'GET',
      // GET with no body: send only Authorization + Accept. A JSON
      // Content-Type here forces a needless preflight and some intermediaries
      // choke on a body-less request that declares one.
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    throw new VeniceError(
      `Network error contacting Venice: ${(err as Error).message}`,
      'network'
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new VeniceError(
      `Venice billing/usage-analytics ${res.status}: ${body.slice(0, 200)}`,
      res.status === 429 ? 'rate_limit' : 'http',
      res.status
    );
  }

  try {
    return await res.json();
  } catch {
    throw new VeniceError('Failed to parse Venice usage-analytics response.', 'parse');
  }
}

/**
 * The one API key's spend the Usage pane headlines, distilled from a `/api_keys`
 * row. Deliberately much narrower than the row Venice sends.
 *
 * This is the one Venice proxy that does NOT relay the upstream body verbatim
 * (the pattern /models and /billing/usage-analytics both follow). `/api_keys`
 * returns every key on the Venice account - id, description, key suffix, limits,
 * spend - and the account is shared by every member of the nak project. Relaying
 * it would publish the whole key inventory, including keys with nothing to do
 * with nak, to anyone who can open Settings. Reading one number does not justify
 * that, so the selection happens server-side and only the selected row's spend
 * crosses back.
 *
 * Trailing-seven-days is the only window Venice offers here. The row also
 * carries `currentPeriodUsage` (spend against the key's consumption-limit
 * window), but Venice omits it for keys with no limits set, so it cannot be
 * relied on as the headline figure.
 */
export interface VeniceKeyUsage {
  /** Venice's human label for the key, e.g. "nak-personal". */
  description: string;
  /** Trailing-seven-day spend in prepaid fiat. */
  usd: number;
  /** Trailing-seven-day spend in staked DIEM credits. */
  diem: number;
}

/**
 * Venice reports per-key spend as decimal STRINGS ("143.8535"), unlike the
 * analytics endpoint's numbers. A missing or unparseable figure reads as 0
 * rather than failing the row - the same degrade-don't-drop stance the
 * analytics coercer takes on an absent currency total.
 */
function parseSpend(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw !== 'string') return 0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pick the row describing the key we authenticated with out of a `/api_keys`
 * response, matched on the last six characters of the key string.
 *
 * Venice has no whoami endpoint: `/api_keys` lists every key on the account and
 * nothing in the response marks which one signed the request. The suffix Venice
 * publishes as `last6Chars` is the only handle we have on our own row.
 *
 * Fails closed to null - rendered by the pane as "couldn't identify this key"
 * rather than a number - in three cases. A malformed response and no matching
 * row are the obvious two. The third is worth spelling out: MORE than one row
 * matching the suffix. Six characters is a small key space and one account can
 * hold keys that collide in it; picking either would silently attribute another
 * key's spend to nak, which is the precise bug this figure exists to fix.
 */
export function selectKeyUsage(raw: unknown, keySuffix: string): VeniceKeyUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;

  const matches = data.filter(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' &&
      row !== null &&
      (row as Record<string, unknown>).last6Chars === keySuffix
  );
  if (matches.length !== 1) return null;

  const row = matches[0];
  const trailing = (row.usage as { trailingSevenDays?: unknown } | undefined)
    ?.trailingSevenDays;
  if (typeof trailing !== 'object' || trailing === null) return null;
  const t = trailing as Record<string, unknown>;

  return {
    description:
      typeof row.description === 'string' && row.description ? row.description : 'this key',
    usd: parseSpend(t.usd),
    diem: parseSpend(t.diem),
  };
}

export interface VeniceApiKeysOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * GET /api_keys from Venice with the shared key, returning only the spend of
 * the key we called with (see {@link VeniceKeyUsage} for why this one does not
 * relay verbatim). Null when the key cannot be identified in the response.
 *
 * Requires an ADMIN-typed key; an INFERENCE key gets 401 here, which surfaces
 * as a VeniceError and leaves the pane's headline hidden while the per-model
 * chart below it still renders. Mirrors veniceFetchModels' error mapping:
 * 429 -> rate_limit, everything else -> http.
 */
export async function veniceFetchKeyUsage(
  opts: VeniceApiKeysOptions
): Promise<VeniceKeyUsage | null> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/api_keys`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    throw new VeniceError(
      `Network error contacting Venice: ${(err as Error).message}`,
      'network'
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new VeniceError(
      `Venice api_keys ${res.status}: ${body.slice(0, 200)}`,
      res.status === 429 ? 'rate_limit' : 'http',
      res.status
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new VeniceError('Failed to parse Venice api_keys response.', 'parse');
  }

  return selectKeyUsage(payload, opts.apiKey.slice(-6));
}
