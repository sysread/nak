// Shared plumbing for the Venice endpoint helpers in this
// directory: the base URL, the typed error class, and the
// rate-limit retry-after parser. The barrel _shared/venice.ts
// re-exports everything as one surface.
//
// The error-kind vocabulary is owned by venice-stream.ts: kinds are
// wire contract (the browser maps them to UI affordances), and the
// streaming consumer constructs kinds ('truncated', 'auth') these
// helpers never produce. A type-only import keeps this file
// runtime-pure while guaranteeing the class and the wire union cannot
// drift apart.
import type { VeniceErrorKind } from '../venice-stream.ts';

// Kind discipline across the endpoint helpers: the non-streaming
// ones collapse ALL non-OK Venice responses - including 401/403 - to
// 'http' on purpose. Their function-side handlers route every non-OK
// to 502 either way; surfacing a finer kind from the embed/usage/
// complete paths would change their handler error mapping with no
// consumer asking for it. Only the streaming SSE consumer
// (venice/getStreamingCompletion.ts) uses the finer-grained kinds.

export class VeniceError extends Error {
  readonly kind: VeniceErrorKind;
  readonly status?: number;
  /**
   * Milliseconds the caller should wait before retrying. Populated only
   * for kind === 'rate_limit' when Venice returned a Retry-After or
   * x-ratelimit-reset-* header the function could parse. Null otherwise -
   * the browser-side retry loop falls back to its own backoff schedule.
   * Carried through the function's error JSON so the browser can act on
   * Venice's hint rather than picking blindly.
   */
  readonly retryAfterMs?: number | null;
  constructor(message: string, kind: VeniceErrorKind, status?: number, retryAfterMs?: number | null) {
    super(message);
    this.name = 'VeniceError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

/**
 * Parse Venice's rate-limit hint headers into a wait duration in
 * milliseconds. Mirrors the browser-side parseRetryAfterMs in
 * src/lib/venice.ts. Preference order:
 *   1. Retry-After (RFC 7231 7.1.3) - either delta-seconds or an
 *      HTTP-date. Venice currently sends seconds; we accept both so a
 *      switch on their end does not break us.
 *   2. x-ratelimit-reset-requests / x-ratelimit-reset-tokens - present
 *      on every Venice response. When 429 fires without Retry-After we
 *      fall back to the soonest of these two windows.
 * Returns null when none of the headers are present or parseable.
 */
export function parseVeniceRetryAfterMs(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const trimmed = retryAfter.trim();
    const asInt = Number(trimmed);
    if (Number.isFinite(asInt) && asInt >= 0) {
      return Math.round(asInt * 1000);
    }
    const asDate = Date.parse(trimmed);
    if (Number.isFinite(asDate)) {
      return Math.max(0, asDate - Date.now());
    }
  }
  const candidates: number[] = [];
  for (const name of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const raw = headers.get(name);
    if (!raw) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) candidates.push(seconds * 1000);
  }
  if (candidates.length === 0) return null;
  return Math.round(Math.min(...candidates));
}

export const DEFAULT_BASE_URL = 'https://api.venice.ai/api/v1';
