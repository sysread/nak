// Venice wire-shape for the edge function (Deno side). This is a deliberate
// duplicate of the embed half of src/lib/venice.ts: the app is Node/Vite and
// this is a Deno island, and coupling the two toolchains before the function
// surface settles is premature (see
// docs/dev/in-progress/venice-edge-functions/). Sharing the browser client
// is a consolidation-phase decision, not a step-5 one.
//
// Kept pure and fetch-injectable on purpose: the handler in venice/index.ts is
// a thin shell around this, so the request-shaping and response-parsing logic
// is unit-testable with a fake fetch and no network (see tests/).

// The error-kind vocabulary is owned by venice-stream.ts: kinds are
// wire contract (the browser maps them to UI affordances), and the
// streaming consumer constructs kinds ('truncated', 'auth') this
// module's helpers never produce. A type-only import keeps this file
// runtime-pure while guaranteeing the class and the wire union cannot
// drift apart.
import type { VeniceErrorKind } from './venice-stream.ts';

export interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

// Kind discipline within this file: the non-streaming helpers below
// collapse ALL non-OK Venice responses - including 401/403 - to
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
function parseVeniceRetryAfterMs(headers: Headers): number | null {
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

const DEFAULT_BASE_URL = 'https://api.venice.ai/api/v1';

export interface VeniceEmbedOptions {
  apiKey: string;
  model: string;
  input: string | string[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * POST /embeddings against Venice. Mirrors the browser client's request shape
 * (OpenAI-compatible `{ model, input }` body, Bearer auth) so a row embedded
 * server-side is byte-identical to one embedded in the worker today.
 */
export async function veniceEmbed(opts: VeniceEmbedOptions): Promise<EmbeddingResponse> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ model: opts.model, input: opts.input }),
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
    // 429 is the one status callers branch on (back-off vs give-up), so it
    // gets its own kind; everything else is a generic http failure.
    throw new VeniceError(
      `Venice embeddings ${res.status}: ${body.slice(0, 200)}`,
      res.status === 429 ? 'rate_limit' : 'http',
      res.status
    );
  }

  try {
    return (await res.json()) as EmbeddingResponse;
  } catch {
    throw new VeniceError('Failed to parse Venice embedding response.', 'parse');
  }
}

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

export interface VeniceCompleteOptions {
  apiKey: string;
  /**
   * Venice wire-shape body the browser already built via the exported
   * buildChatBody helper in src/lib/venice.ts. The function does not
   * inspect or reshape it - thin proxy. Keeping the shaping browser-side
   * sidesteps the wire-shape duplication the chat-completions design doc
   * flagged.
   */
  body: Record<string, unknown>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Backoff delays (ms) BETWEEN retry attempts for transient upstream
   * failures; length is the number of retries. Defaults to
   * COMPLETE_RETRY_SCHEDULE_MS. Pass `[]` to disable retries (the unit
   * tests that assert single-attempt error mapping do this so they stay
   * fast and exercise the classifier directly).
   */
  retrySchedule?: number[];
  /**
   * Opt-in: also retry a 429 (rate_limit), honoring Venice's Retry-After
   * window (capped, see RATE_LIMIT_WAIT_CAP_MS). Off by default so the
   * browser-proxied non-streaming route and the mid-turn tool calls keep
   * their current give-up-on-429 behavior. The server-side background
   * agents (auto-title and the rest of the curation family) set this:
   * they have no browser rate-limit loop behind them, so without it a
   * single "model overloaded" 429 fails the whole sub-call.
   */
  retryRateLimit?: boolean;
  /**
   * Aborts the in-flight fetch and any pending backoff sleep. Optional -
   * the route handler does not wire one today (the backoff is bounded),
   * but tool sub-completions and tests can cancel.
   */
  signal?: AbortSignal;
}

// Transient-failure retry schedule for the non-streaming completion.
// Venice's /chat/completions intermittently returns a 5xx (capacity)
// or drops the connection; a single hiccup otherwise fails the whole
// non-streaming call, which silently kills whatever background feature
// issued it (auto-title, intuition, context recall, web_search, the
// summary/topics/bias agents, ...). These are the same transient
// classes the streaming path already retries server-side
// (withRateLimitRetry in getStreamingCompletion); the non-streaming
// path lost its retry loop in the move onto the edge function. 429 is
// retried only when the caller opts in via retryRateLimit (the
// server-side curation/background agents do; the browser-proxied route
// and mid-turn tools do not, because the browser's
// SupabaseService.complete owns their rate-limit loop and honors
// Retry-After). Deterministic (no jitter) on purpose - the retries hit
// Venice's infra, not ours, and the per-turn caller count is small, so
// there's no thundering herd against our own service to spread out.
const COMPLETE_RETRY_SCHEDULE_MS = [500, 1500, 4000];

// Ceiling on how long a single 429 backoff will wait, even if Venice's
// Retry-After asks for longer. Keeps a sustained-overload 429 from
// parking a background sub-call past the function's waitUntil budget;
// the agents' claim-release-and-retry-next-tick path is the backstop
// for overload that outlasts this.
const RATE_LIMIT_WAIT_CAP_MS = 5000;

/**
 * True for failures a retry might clear: a connection-level error, or an
 * upstream 5xx (500/502/503/504). A 4xx (bad request, auth) and a
 * 'parse' (deterministic bad body) won't improve on retry, and
 * 'rate_limit' is owned by the browser's retry loop.
 */
function isTransientCompleteError(err: VeniceError): boolean {
  if (err.kind === 'network') return true;
  return (
    err.kind === 'http' && typeof err.status === 'number' && err.status >= 500
  );
}

/**
 * Resolve after `ms`, or early with `true` if `signal` aborts first.
 * `false` means the full delay elapsed. No signal = a plain sleep.
 */
function sleepCancellable(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * POST /chat/completions against Venice with the shared key. Thin proxy:
 * forwards the body verbatim, returns the parsed JSON response verbatim.
 * The browser's parseChatCompletion takes the shape from there.
 *
 * Retries transient upstream failures (5xx / connection drop) on the
 * COMPLETE_RETRY_SCHEDULE_MS backoff before giving up; see
 * isTransientCompleteError for what counts and why 429 is excluded. On
 * 429, the helper reads Retry-After / x-ratelimit-reset-* into a
 * retryAfterMs hint so the browser's retry loop can act on Venice's
 * window rather than picking a backoff blindly. Other non-OK statuses
 * collapse to http; network failures to network; non-JSON success
 * bodies to parse.
 */
export async function veniceComplete(opts: VeniceCompleteOptions): Promise<unknown> {
  const schedule = opts.retrySchedule ?? COMPLETE_RETRY_SCHEDULE_MS;
  let attempt = 0;
  for (;;) {
    try {
      return await veniceCompleteOnce(opts);
    } catch (err) {
      const retryable =
        err instanceof VeniceError &&
        (isTransientCompleteError(err) ||
          (opts.retryRateLimit === true && err.kind === 'rate_limit'));
      if (!retryable || attempt >= schedule.length) throw err;
      // On a 429 Venice tells us how long its window is; honor that over
      // the blind schedule, but floor it at the scheduled delay and cap
      // it (a long Retry-After must not blow the background budget).
      const baseMs = schedule[attempt];
      const waitMs =
        err.kind === 'rate_limit' && typeof err.retryAfterMs === 'number'
          ? Math.min(Math.max(err.retryAfterMs, baseMs), RATE_LIMIT_WAIT_CAP_MS)
          : baseMs;
      const interrupted = await sleepCancellable(waitMs, opts.signal);
      // Aborted mid-backoff: surface the failure we already have rather
      // than firing another attempt the caller no longer wants.
      if (interrupted) throw err;
      attempt += 1;
    }
  }
}

/**
 * One attempt of the /chat/completions proxy: fetch, classify a non-OK
 * status into a typed VeniceError, parse the body. The retrying
 * veniceComplete wrapper above owns the attempt loop.
 */
async function veniceCompleteOnce(opts: VeniceCompleteOptions): Promise<unknown> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/chat/completions`, {
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
        `Venice chat/completions 429: ${errBody.slice(0, 200)}`,
        'rate_limit',
        429,
        parseVeniceRetryAfterMs(res.headers)
      );
    }
    throw new VeniceError(
      `Venice chat/completions ${res.status}: ${errBody.slice(0, 200)}`,
      'http',
      res.status
    );
  }

  try {
    return await res.json();
  } catch {
    throw new VeniceError('Failed to parse Venice completion response.', 'parse');
  }
}

export interface VeniceGenerateImageOptions {
  apiKey: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  stylePreset?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  cfgScale?: number;
  safeMode?: boolean;
  hideWatermark?: boolean;
  format?: 'webp' | 'png' | 'jpeg';
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface VeniceImageGenResult {
  /** Base64-encoded image bytes, no `data:` prefix. */
  imageBase64: string;
  /** MIME type derived from the requested format, e.g. `image/webp`. */
  mimeType: string;
}

/**
 * POST /image/generate against Venice. Camel-cased options map to Venice's
 * snake_case wire shape; only fields the caller supplied are forwarded (matches
 * the wire discipline veniceEmbed uses). Pins `variants: 1` and
 * `return_binary: false` so the response is a single base64 image ready to
 * drop into a message_attachments row - the generate_image tool downstream
 * never wants raw bytes or multi-image output.
 *
 * Content-policy guard: Venice can return HTTP 200 with the
 * `x-venice-is-content-violation` header set when a prompt trips its policy
 * and no usable image came back. We surface that as a VeniceError so the tool
 * sees the violation explicitly rather than silently returning an empty image.
 *
 * Returns the first image as base64 plus a derived MIME type. Throws a
 * VeniceError on any failure; 429 -> rate_limit so the caller can branch on
 * the back-off case, everything else -> http or network.
 */
export async function veniceGenerateImage(
  opts: VeniceGenerateImageOptions
): Promise<VeniceImageGenResult> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const format = opts.format ?? 'webp';

  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    format,
    variants: 1,
    safe_mode: opts.safeMode ?? true,
    return_binary: false,
  };
  if (typeof opts.width === 'number') body.width = opts.width;
  if (typeof opts.height === 'number') body.height = opts.height;
  if (opts.negativePrompt) body.negative_prompt = opts.negativePrompt;
  if (opts.stylePreset) body.style_preset = opts.stylePreset;
  if (typeof opts.seed === 'number') body.seed = opts.seed;
  if (typeof opts.steps === 'number') body.steps = opts.steps;
  if (typeof opts.cfgScale === 'number') body.cfg_scale = opts.cfgScale;
  if (typeof opts.hideWatermark === 'boolean') body.hide_watermark = opts.hideWatermark;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/image/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new VeniceError(
      `Network error contacting Venice: ${(err as Error).message}`,
      'network'
    );
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new VeniceError(
      `Venice image/generate ${res.status}: ${errBody.slice(0, 200)}`,
      res.status === 429 ? 'rate_limit' : 'http',
      res.status
    );
  }
  // Content-policy: a 200 may still carry no image when the header flags a
  // policy violation. Check before parsing so the helper does not hand back
  // an empty result as if it succeeded.
  if (res.headers.get('x-venice-is-content-violation') === 'true') {
    throw new VeniceError(
      'Venice rejected the image prompt for a content-policy violation. ' +
        'Rephrase the request or tell the user the prompt was not allowed.',
      'http',
      res.status
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new VeniceError('Failed to parse Venice image response.', 'parse');
  }
  const images = (payload as { images?: unknown }).images;
  const first = Array.isArray(images) ? images[0] : undefined;
  if (typeof first !== 'string' || first.length === 0) {
    throw new VeniceError(
      'Venice image response contained no image data.',
      'parse'
    );
  }
  return { imageBase64: first, mimeType: `image/${format}` };
}

export interface VeniceExtractTextOptions {
  apiKey: string;
  file: Blob;
  filename: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * POST /augment/text-parser against Venice. The endpoint is multipart, not
 * JSON: the file rides as a `file` part, with `response_format=json` so the
 * upstream returns a structured `{ text, ... }` body. Mirrors the browser
 * client's prior request shape so a re-extraction is byte-identical to one
 * extracted from the browser today. Content-Type is deliberately not set on
 * the outgoing fetch - the runtime generates the correct multipart boundary
 * from the FormData body; setting `application/json` would clobber it.
 *
 * Returns the extracted text. Accepts `text` as the canonical response field
 * and falls back to a couple of plausible alternates so a wire tweak does
 * not instantly break us. Throws a VeniceError on any failure; 429 -> rate_limit
 * for back-off branching, everything else -> http or network depending on
 * whether the connection itself failed.
 */
export async function veniceExtractText(opts: VeniceExtractTextOptions): Promise<string> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  const form = new FormData();
  form.append('file', opts.file, opts.filename);
  form.append('response_format', 'json');

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/augment/text-parser`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
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
      `Venice text-parser ${res.status}: ${body.slice(0, 200)}`,
      res.status === 429 ? 'rate_limit' : 'http',
      res.status
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new VeniceError('Failed to parse Venice text-parser response.', 'parse');
  }
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p.text === 'string') return p.text;
    if (typeof p.content === 'string') return p.content;
    if (typeof p.data === 'object' && p.data) {
      const d = p.data as Record<string, unknown>;
      if (typeof d.text === 'string') return d.text;
    }
  }
  throw new VeniceError(
    'Venice text-parser response did not contain a text field.',
    'parse'
  );
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

/** Venice `/models?type=` filters nak offers a picker for. */
export type VeniceModelType = 'text' | 'image';

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
