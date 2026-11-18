// Venice /decisions relay: evaluate a state against typed questions
// (noul / choice / score) and get structured answers back. BETA -
// Venice may change the request/response schemas without notice, so
// this helper stays a thin verbatim relay on purpose: the caller
// owns the body shape and the answer coercion, and wire drift
// surfaces as upstream 400s, not as silent coercion bugs.
//
// Same discipline as the sibling helpers: pure and fetch-injectable,
// single attempt (no retry loop - the first caller that wants
// transient retries copies veniceComplete's schedule), and the
// shared kind discipline on errors (429 -> rate_limit with the
// retry-after hint, everything else -> http). The error body gets
// the 600-char slice so a beta DetailedError body stays legible in
// the 502 log.

import {
  DEFAULT_BASE_URL,
  parseVeniceRetryAfterMs,
  VeniceError,
} from './shared.ts';

export interface VeniceDecisionOptions {
  apiKey: string;
  /**
   * Venice /decisions wire body: `{ model, state, questions, ... }`.
   * Forwarded verbatim - the caller shapes it, this helper inspects
   * nothing.
   */
  body: Record<string, unknown>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * POST /decisions against Venice with the shared key. Returns the
 * parsed JSON response verbatim (`{ model, answers, usage }`); the
 * caller reads answers under its own question ids. Error mapping
 * mirrors the sibling relays: 429 -> rate_limit (+ retryAfterMs from
 * Retry-After / x-ratelimit-reset-*), other non-OK -> http,
 * connection failure -> network, non-JSON success -> parse.
 */
export async function veniceDecision(opts: VeniceDecisionOptions): Promise<unknown> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    throw new VeniceError(
      `Network error contacting Venice: ${(err as Error).message}`,
      'network'
    );
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 429) {
      throw new VeniceError(
        `Venice decisions 429: ${errBody.slice(0, 600)}`,
        'rate_limit',
        429,
        parseVeniceRetryAfterMs(res.headers)
      );
    }
    throw new VeniceError(
      `Venice decisions ${res.status}: ${errBody.slice(0, 600)}`,
      'http',
      res.status
    );
  }

  try {
    return await res.json();
  } catch {
    throw new VeniceError('Failed to parse Venice decisions response.', 'parse');
  }
}
