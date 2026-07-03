/**
 * Venice edge-function proxy slice of the Supabase data layer: every
 * browser call that rides functions.invoke into the `venice` edge
 * function - /complete, /embed, /usage-analytics, /models, and
 * /text-parser. The function holds the shared Venice key server-side;
 * the browser never sees it, and failures surface as VeniceError so
 * call sites render the same error shape a direct Venice call would
 * have produced.
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its proxy methods
 * here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. The one deliberate extra export is veniceFunctionError,
 * which the agent-runs slice (./agent-runs.ts) uses to translate its
 * own functions.invoke failures.
 *
 * The profiles.settings reads/writes that used to share a banner with
 * these methods live in ./settings.ts - settings CRUD and
 * edge-function invocation are separate concerns.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../logger.svelte';
import type {
  ChatCompletion,
  ChatRequest,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../venice';
import {
  buildChatBody,
  parseChatCompletion,
  VeniceError,
} from '../venice';
import { coerceCatalog, type CatalogModel } from '../models/catalog';
import { coerceImageCatalog, type ImageCatalogModel } from '../models/image-catalog';
import {
  coerceUsageAnalytics,
  type UsageRequestOptions,
  type UsageModelBucket,
} from '../usage';

const log = createLogger('supabase');

/**
 * Translate a supabase-js functions.invoke error (from any venice-function
 * route) into a VeniceError. A FunctionsHttpError carries the function's
 * Response on `.context`; we read the status and the function's normalized
 * { error } body off it so the caller surfaces the real failure and a 429 still
 * reads as rate_limit. Anything without a Response context (a relay or transport
 * failure) becomes a network error.
 *
 * Exported (not slice-private) because the agent-runs slice invokes
 * other venice-function routes and normalizes their failures through
 * the same translation.
 */
export async function veniceFunctionError(error: unknown): Promise<VeniceError> {
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    let payload: { error?: string; kind?: string; retryAfterMs?: number | null } = {};
    try {
      payload = await ctx.clone().json();
    } catch {
      // Non-JSON error body - fall back to the status line.
    }
    const message = payload.error ?? `venice function request failed (HTTP ${ctx.status})`;
    const kind = ctx.status === 429 ? 'rate_limit' : 'http';
    // The /complete route relays Venice's Retry-After / x-ratelimit-reset-*
    // hint through the JSON body since the headers themselves don't survive
    // the functions.invoke round trip. Carry the parsed window onto the
    // VeniceError so the browser's retry loop can act on it.
    const retryAfterMs =
      typeof payload.retryAfterMs === 'number' ? payload.retryAfterMs : null;
    return new VeniceError(message, kind, ctx.status, retryAfterMs);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new VeniceError(`Network error contacting the venice function: ${message}`, 'network');
}

/**
 * Maximum attempts (initial + retries) before `SupabaseService.complete`
 * surfaces a 429 to the caller. Picked so a brief quota dip recovers
 * transparently while a stuck quota still surfaces within ~10s of total
 * wait. The streaming path in chat/loop.ts uses its own attempt count;
 * the non-streaming chat seam sits behind tool sub-calls and background
 * agents with no UI feedback, so a propagated 429 lands as a silent
 * `{error: "..."}` in a tool-result row or a swallowed agent failure -
 * being a bit more patient here trades a few seconds of latency for not
 * burning a turn.
 */
const COMPLETE_RATE_LIMIT_MAX_ATTEMPTS = 5;

/**
 * Fallback wait schedule for `complete` 429s, used only when the
 * function-side relayed no Retry-After or x-ratelimit-reset-* hint.
 * Log10-spaced from 1s to 5s across the four retry intervals:
 * 10^(i * log10(5) / 3) for i in 0..3. Smooths the request burst across
 * a quota reset window without piling up several seconds of wait on the
 * first retry.
 */
const COMPLETE_RATE_LIMIT_FALLBACK_WAIT_MS = [1_000, 1_710, 2_924, 5_000];

/**
 * Hard cap on a single 429 wait inside `complete`. Mirrors
 * RATE_LIMIT_WAIT_CAP_MS in chat/loop.ts: a Retry-After longer than a
 * minute almost certainly means a daily/monthly cap that won't clear
 * during the current call, so surface it as a hard error rather than
 * blocking a tool sub-call (or, worse, a background agent the user
 * can't see) for that long.
 */
const COMPLETE_RATE_LIMIT_WAIT_CAP_MS = 60_000;

/**
 * Sleep that resolves either when `ms` elapses or `signal` aborts.
 * Returns true if the signal interrupted the sleep, false on a clean
 * timeout. When no signal is passed, behaves as a plain delay and
 * always returns false. Private to this module - the chat-loop has its
 * own copy because the retry shapes diverge slightly (chat-loop emits
 * UI lifecycle events on either side of the sleep; this one just
 * waits).
 */
function sleepCancellable(
  ms: number,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Fetch Venice billing usage through the `venice` edge function. The browser
 * no longer holds a Venice key for this path - the function reads the shared
 * key server-side and proxies one call to /billing/usage-analytics, which
 * returns the per-model roll-up pre-aggregated in a single cached response
 * (replacing the multi-page walk over the per-request ledger this used to do).
 * Coercion of the `byModel` slice lives in src/lib/usage.ts (browser-side) so
 * a malformed entry degrades to "skipped" rather than failing the whole list.
 * The session JWT rides along on functions.invoke and the gateway's verify_jwt
 * gates the call; failures surface as VeniceError so the pane renders the same
 * error shape it always has.
 */
export async function fetchUsage(
  client: SupabaseClient,
  opts: UsageRequestOptions = {}
): Promise<UsageModelBucket[]> {
  const { data, error } = await client.functions.invoke('venice/usage-analytics', {
    body: { startDate: opts.startDate, endDate: opts.endDate },
  });
  if (error) throw await veniceFunctionError(error);
  return coerceUsageAnalytics(data);
}

/**
 * Fetch the live Venice text-model catalog through the venice edge
 * function's /models route, coerced into the flat CatalogModel shape the
 * Settings model picker reads. The function holds the shared key
 * server-side and relays Venice's response; coercion lives in
 * src/lib/models/catalog.ts (browser-side) so a malformed row degrades
 * to "skipped" rather than failing the whole list. Errors surface as
 * VeniceError, the same shape the Usage pane already renders.
 */
export async function fetchModels(client: SupabaseClient): Promise<CatalogModel[]> {
  const { data, error } = await client.functions.invoke('venice/models', {
    body: {},
  });
  if (error) throw await veniceFunctionError(error);
  return coerceCatalog(data);
}

/**
 * Fetch the live Venice image-model catalog through the same /models
 * route, passing `type: 'image'` so Venice returns the image slice
 * (per-image pricing + size constraints rather than context window /
 * reasoning). Coerced into the flat ImageCatalogModel shape the Settings
 * image-generation picker reads; same degrade-on-malformed-row contract
 * and same VeniceError surface as fetchModels.
 */
export async function fetchImageModels(
  client: SupabaseClient
): Promise<ImageCatalogModel[]> {
  const { data, error } = await client.functions.invoke('venice/models', {
    body: { type: 'image' },
  });
  if (error) throw await veniceFunctionError(error);
  return coerceImageCatalog(data);
}

/**
 * Generate an embedding through the venice edge function's /embed route,
 * replacing the browser's direct Venice call. The function reads the shared
 * key server-side; this keeps the same { model, input } request and
 * { data: [{ embedding }] } response shape the old VeniceClient.embed had, so
 * callers only swap the handle. Note: req.signal is not propagated -
 * functions.invoke has no abort hook - so a superseded search's embed is
 * discarded by the caller's own staleness guard rather than aborted; an embed
 * is a quick call, so the wasted request is cheap.
 */
export async function embed(
  client: SupabaseClient,
  req: EmbeddingRequest
): Promise<EmbeddingResponse> {
  const { data, error } = await client.functions.invoke('venice/embed', {
    body: { model: req.model, input: req.input },
  });
  if (error) throw await veniceFunctionError(error);
  return (data ?? { data: [] }) as EmbeddingResponse;
}

/**
 * Extract readable text from a user-uploaded file through the venice edge
 * function's /text-parser route. Routes around the CORS rejection that hits
 * any browser-direct call to Venice's /augment/text-parser (Venice CORS-
 * enables chat/image/embeddings, not text-parser - the user saw "Failed to
 * fetch" on every non-image attachment). The function holds the shared key
 * server-side; this method packages the file as multipart/form-data and
 * surfaces failures through the same VeniceError contract the call sites
 * already render. Returns the parsed text on success.
 *
 * functions.invoke handles FormData natively (it leaves Content-Type unset
 * so the runtime writes the multipart boundary), so the wire shape matches
 * what Venice's endpoint expects.
 */
export async function extractText(
  client: SupabaseClient,
  file: Blob,
  filename: string
): Promise<string> {
  const form = new FormData();
  form.append('file', file, filename);
  const { data, error } = await client.functions.invoke('venice/text-parser', {
    body: form,
  });
  if (error) throw await veniceFunctionError(error);
  const text = (data as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') {
    throw new VeniceError(
      'Venice text-parser response did not contain a text field.',
      'parse'
    );
  }
  return text;
}

/**
 * Non-streaming chat completion through the venice edge function's
 * /complete route. The browser builds Venice's wire-shape body via
 * buildChatBody and forwards it; the function holds the shared key
 * server-side and relays Venice's response (or error) verbatim. The
 * 429 retry loop stays browser-side: the non-streaming chat seam
 * sits behind tool sub-calls and background agents with no UI
 * feedback, so a propagated 429 lands silently in a tool-result row
 * or a swallowed agent failure - being a bit patient here trades a
 * few seconds of latency for not burning a turn.
 *
 * Retry-After: Venice's hint travels through the function's 429
 * response body (retryAfterMs) since the underlying header does not
 * survive the functions.invoke round trip. Fallback when the hint is
 * absent: a log10-spaced 1s -> 5s schedule, hard-capped at 60s.
 * req.signal aborts both the in-flight invoke (when supabase-js
 * supports it) and the inter-attempt sleep.
 *
 * Streaming chat completion still talks to Venice directly from
 * src/lib/chat/loop.ts; the streaming attractor is the next driver-B
 * milestone.
 */
export async function complete(
  client: SupabaseClient,
  req: ChatRequest
): Promise<ChatCompletion> {
  const body = buildChatBody(req, false);
  let attempt = 0;
  while (true) {
    let payload: unknown;
    try {
      const { data, error } = await client.functions.invoke('venice/complete', {
        body,
      });
      if (error) throw await veniceFunctionError(error);
      payload = data;
    } catch (err) {
      if (!(err instanceof VeniceError)) throw err;
      const retriesExhausted = attempt >= COMPLETE_RATE_LIMIT_MAX_ATTEMPTS - 1;
      if (
        err.kind !== 'rate_limit' ||
        retriesExhausted ||
        req.signal?.aborted === true
      ) {
        throw err;
      }
      const hint = err.retryAfterMs;
      const fallbackIdx = Math.min(
        attempt,
        COMPLETE_RATE_LIMIT_FALLBACK_WAIT_MS.length - 1
      );
      const baseMs = hint ?? COMPLETE_RATE_LIMIT_FALLBACK_WAIT_MS[fallbackIdx];
      const waitMs = Math.min(baseMs, COMPLETE_RATE_LIMIT_WAIT_CAP_MS);
      log.info(
        `complete rate-limited (attempt ${attempt + 1}/${COMPLETE_RATE_LIMIT_MAX_ATTEMPTS}); waiting ${waitMs}ms before retry`
      );
      const interrupted = await sleepCancellable(waitMs, req.signal);
      if (interrupted) {
        // Aborted during the sleep. Throw a spec-shaped AbortError so
        // callers' existing AbortError branches fire - same path a
        // mid-fetch abort would have taken.
        const abortErr = new Error('Aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      attempt += 1;
      continue;
    }
    return parseChatCompletion(payload);
  }
}
