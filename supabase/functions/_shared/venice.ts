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

export interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

// The 'auth' kind covers Venice 401/403 - bad or missing key. Added
// when the streaming-root migration started classifying Venice
// auth failures distinctly so the function can surface them as a
// terminal error event rather than collapsing to generic http.
// The streaming SSE consumer in venice/getStreamingCompletion.ts is
// the first caller that constructs a VeniceError with this kind; the
// existing non-streaming helpers below have always collapsed 401/403
// to 'http' and continue to do so (the function-side handlers route
// non-OK Venice responses to 502 either way, and changing the kind
// the embed/usage/complete/etc paths surface would change their
// handler error mapping unrelated to streaming).
export type VeniceErrorKind = 'rate_limit' | 'auth' | 'http' | 'network' | 'parse';

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

export interface UsagePageParams {
  /** 1-based page index. */
  page: number;
  /** Rows per page; the browser loop pins this at 500. */
  limit: number;
  /** Venice sort direction, e.g. 'desc'. */
  sortOrder: string;
  /** ISO 8601 lower bound (inclusive). Omitted -> unbounded. */
  startDate?: string;
  /** ISO 8601 upper bound (exclusive, per Venice docs). Omitted -> unbounded. */
  endDate?: string;
  /** Single-currency filter. Omitted -> every denomination. */
  currency?: string;
}

/**
 * Assemble the Venice /billing/usage query string for one page. Pure so the
 * param shaping is unit-testable offline. Optional filters are dropped entirely
 * when unset - an empty `startDate=` could read upstream as an epoch bound
 * rather than "no bound", so omission, not an empty value, is what means
 * unbounded.
 */
export function buildUsageQuery(params: UsagePageParams): string {
  const qs = new URLSearchParams();
  qs.set('limit', String(params.limit));
  qs.set('page', String(params.page));
  qs.set('sortOrder', params.sortOrder);
  if (params.startDate) qs.set('startDate', params.startDate);
  if (params.endDate) qs.set('endDate', params.endDate);
  if (params.currency) qs.set('currency', params.currency);
  return qs.toString();
}

/**
 * One page of usage as relayed to the browser: the raw Venice rows plus the
 * server-reported page count. Row coercion and the paging cap live in the
 * browser loop (src/lib/usage.ts), so this handler stays a thin authenticated
 * passthrough and does not need to know the UsageRow shape.
 */
export interface UsagePage {
  data: unknown[];
  totalPages: number;
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
}

/**
 * POST /chat/completions against Venice with the shared key. Thin proxy:
 * forwards the body verbatim, returns the parsed JSON response verbatim.
 * The browser's parseChatCompletion takes the shape from there.
 *
 * On 429, the helper reads Retry-After / x-ratelimit-reset-* into a
 * retryAfterMs hint so the browser's retry loop can act on Venice's
 * window rather than picking a backoff blindly. Other non-OK statuses
 * collapse to http; network failures to network; non-JSON success
 * bodies to parse.
 */
export async function veniceComplete(opts: VeniceCompleteOptions): Promise<unknown> {
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

export interface VeniceUsageOptions {
  apiKey: string;
  params: UsagePageParams;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * GET one page of /billing/usage from Venice with the shared key. Mirrors
 * veniceEmbed's error mapping: 429 -> rate_limit (the one status the caller
 * backs off on), everything else -> http. Returns the raw rows and the
 * reported page count; the caller clamps that count to its own safety cap.
 */
export async function veniceFetchUsagePage(opts: VeniceUsageOptions): Promise<UsagePage> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const qs = buildUsageQuery(opts.params);

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/billing/usage?${qs}`, {
      method: 'GET',
      // GET with no body: send only Authorization + Accept. A JSON
      // Content-Type here forces a needless preflight and some intermediaries
      // choke on a body-less request that declares one. Pin Accept so a
      // default of */* can't negotiate the CSV variant Venice also serves here.
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
      `Venice billing/usage ${res.status}: ${body.slice(0, 200)}`,
      res.status === 429 ? 'rate_limit' : 'http',
      res.status
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new VeniceError('Failed to parse Venice usage response.', 'parse');
  }
  const obj = payload as { data?: unknown; pagination?: { totalPages?: number } };
  const data = Array.isArray(obj.data) ? obj.data : [];
  const totalPages =
    typeof obj.pagination?.totalPages === 'number' ? obj.pagination.totalPages : 1;
  return { data, totalPages };
}
