// Venice /models catalog: the type-filtered fetch plus the TTL
// cache shared by function-side catalog consumers. The barrel
// _shared/venice.ts re-exports everything.
import { DEFAULT_BASE_URL, VeniceError } from './shared.ts';

/** Venice `/models?type=` filters nak offers a picker or a price cap for. */
export type VeniceModelType = 'text' | 'image' | 'inpaint' | 'upscale';

export interface VeniceModelsOptions {
  apiKey: string;
  /**
   * Which catalog slice to fetch. Defaults to 'text' (the tier/vision
   * pickers). 'image' backs the Settings image-generation picker - a
   * different `model_spec` shape (per-image pricing, size constraints
   * instead of context window / reasoning), coerced browser-side by
   * src/lib/models/image-catalog.ts.
   */
  type?: VeniceModelType;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * GET /models?type=<text|image> from Venice with the shared key. Thin
 * passthrough: returns Venice's JSON body verbatim and lets the browser
 * (src/lib/models/catalog.ts for text, image-catalog.ts for image)
 * flatten and coerce it - the same division of labour the usage page
 * uses, keeping this handler free of any CatalogModel knowledge. The
 * `type` filter is pinned to a closed set by the caller (handleModels)
 * so an arbitrary value never reaches Venice. Mirrors
 * veniceFetchUsagePage's error mapping: 429 -> rate_limit, else http.
 */
export async function veniceFetchModels(opts: VeniceModelsOptions): Promise<unknown> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const type = opts.type ?? 'text';

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/models?type=${type}`, {
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
      `Venice models ${res.status}: ${body.slice(0, 200)}`,
      res.status === 429 ? 'rate_limit' : 'http',
      res.status
    );
  }

  try {
    return await res.json();
  } catch {
    throw new VeniceError('Failed to parse Venice models response.', 'parse');
  }
}

// TTL cache over the raw /models catalog, shared by every function-side
// consumer of the same slice (the price caps and the image-constraint
// lookup) so a cold isolate pays ONE catalog fetch per type per TTL
// instead of one per consumer. 15 minutes - the same cadence price-cap
// established; catalog drift on that scale is acceptable for caps and
// sizing constraints alike.
const RAW_CATALOG_TTL_MS = 15 * 60 * 1000;
const rawCatalogCache = new Map<VeniceModelType, { raw: unknown; at: number }>();

/**
 * Raw (uncoerced) /models?type=<type> body, cached per type. Callers
 * extract the shape they need (prices, constraints). Throws on catalog
 * failure - fail-open posture belongs to the consumer.
 */
export async function veniceRawCatalogCached(
  apiKey: string,
  type: VeniceModelType,
  fetchImpl?: typeof fetch
): Promise<unknown> {
  const now = Date.now();
  const hit = rawCatalogCache.get(type);
  if (hit && now - hit.at < RAW_CATALOG_TTL_MS) return hit.raw;
  const raw = await veniceFetchModels({ apiKey, type, fetchImpl });
  rawCatalogCache.set(type, { raw, at: now });
  return raw;
}

/** Test isolation: drop every cached catalog slice. */
export function resetRawCatalogCache(): void {
  rawCatalogCache.clear();
}
