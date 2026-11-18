// Venice /augment/scrape relay. The barrel _shared/venice.ts
// re-exports everything.
import { DEFAULT_BASE_URL, VeniceError } from './shared.ts';

export interface VeniceScrapeOptions {
  apiKey: string;
  /** The page to fetch. Venice rejects some hosts (X/Twitter, Reddit) with a 400. */
  url: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * POST /augment/scrape against Venice: fetch one page and return its
 * content converted to markdown. This is the direct-retrieval
 * complement to enable_web_search - the search pipeline is built
 * around queries and does poorly when handed a bare URL, so the
 * web_search tool routes single-page requests here instead.
 *
 * Venice's response is `{ url, content, format: "markdown" }`; only
 * `content` is returned - the caller already knows the URL it asked
 * for. An empty content string is surfaced as a parse error rather
 * than returned: a blank page body gives the model nothing to work
 * with and reads as success, which is worse than a loud failure.
 * Error mapping mirrors the sibling helpers: 429 -> rate_limit,
 * other non-OK -> http (a blocked-host 400's body rides along so the
 * model can see why), connection failure -> network.
 */
export async function veniceScrapeUrl(opts: VeniceScrapeOptions): Promise<string> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/augment/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ url: opts.url }),
      signal: opts.signal,
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
      `Venice augment/scrape ${res.status}: ${body.slice(0, 600)}`,
      res.status === 429 ? 'rate_limit' : 'http',
      res.status
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new VeniceError('Failed to parse Venice scrape response.', 'parse');
  }
  const content = (payload as { content?: unknown }).content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new VeniceError(
      'Venice scrape response contained no page content.',
      'parse'
    );
  }
  return content;
}
