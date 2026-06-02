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

export type VeniceErrorKind = 'rate_limit' | 'http' | 'network' | 'parse';

export class VeniceError extends Error {
  readonly kind: VeniceErrorKind;
  readonly status?: number;
  constructor(message: string, kind: VeniceErrorKind, status?: number) {
    super(message);
    this.name = 'VeniceError';
    this.kind = kind;
    this.status = status;
  }
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
