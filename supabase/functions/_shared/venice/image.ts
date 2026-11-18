// Venice image endpoints: /image/generate plus the edit family
// (edit / upscale / background-remove) and the chunked base64
// encoder they share. The barrel _shared/venice.ts re-exports everything.
import { DEFAULT_BASE_URL, VeniceError } from './shared.ts';

export interface VeniceGenerateImageOptions {
  apiKey: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  stylePreset?: string;
  width?: number;
  height?: number;
  /**
   * Ratio-based models only (catalog `constraints.aspectRatios`): sent as
   * `aspect_ratio`, mutually exclusive with width/height - those models
   * reject pixel dimensions outright.
   */
  aspectRatio?: string;
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
 * the wire discipline the other Venice helpers use). Pins `variants: 1` and
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
  if (typeof opts.aspectRatio === 'string') body.aspect_ratio = opts.aspectRatio;
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

// --- Image editing ----------------------------------------------------------
//
// Three helpers against Venice's image-edit family. Unlike /image/generate,
// these endpoints return the image as RAW BYTES (the Content-Type header
// carries the format, there is no JSON envelope and no return_binary flag),
// so each returns base64 ready to drop into the __generated_image payload.
//
// Wall-clock bound: every helper composes its own per-attempt timer (~180s)
// with the caller's abort signal. A hung upstream then degrades to a clean
// timeout error instead of eating the turn's 380s wall deadline
// (getStreamingResponse.ts WALL_DEADLINE_MS) - the same house pattern as the
// vision sub-calls in venice/tools/_vision.ts. 180s covers the slowest
// legitimate image op (a 4x upscale) with headroom.
const IMAGE_OP_TIMEOUT_MS = 180_000;

/**
 * Compose the helper's own timeout with an optional caller signal. The
 * caller signal (ctx.signal, the turn's abort path) forwards to the
 * controller; the timer aborts independently. Returns the controller's
 * signal plus a cleanup the caller MUST run in a finally block so the
 * timer never holds the isolate awake.
 */
function imageOpSignal(signal?: AbortSignal): {
  ctl: AbortController;
  cleanup: () => void;
} {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), IMAGE_OP_TIMEOUT_MS);
  const forward = () => ctl.abort();
  signal?.addEventListener('abort', forward, { once: true });
  return {
    ctl,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}

/**
 * Shared response handling for the three edit-family endpoints: non-OK
 * mapping (422 content policy, 429 rate limit, everything else http) and
 * binary-to-base64 conversion. Venice can also flag a content violation
 * via header on a 200 like /image/generate does - undocumented for these
 * endpoints, checked defensively since the check is free.
 */
async function imageOpResponseToBase64(
  res: Response,
  endpoint: string
): Promise<{ imageBase64: string; mimeType: string }> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 422 is a content-policy rejection ("Your prompt violates the content
    // policy of Venice.ai or the model provider"). A distinct message the
    // model can relay; not charged unless Venice's own moderation blocked
    // the image after the provider generated it.
    if (res.status === 422) {
      throw new VeniceError(
        'Venice rejected the image operation for a content-policy violation. ' +
          'Rephrase the request or tell the user it was not allowed.',
        'http',
        422
      );
    }
    throw new VeniceError(
      `Venice ${endpoint} ${res.status}: ${body.slice(0, 200)}`,
      res.status === 429 ? 'rate_limit' : 'http',
      res.status
    );
  }
  if (res.headers.get('x-venice-is-content-violation') === 'true') {
    throw new VeniceError(
      'Venice rejected the image operation for a content-policy violation. ' +
        'Rephrase the request or tell the user it was not allowed.',
      'http',
      res.status
    );
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new VeniceError(
      `Venice ${endpoint} response contained no image data.`,
      'parse'
    );
  }
  return {
    imageBase64: await base64FromBytesChunked(bytes),
    // Detected from the output bytes by the endpoint; fall back to png,
    // the response format of the fixed-model endpoints.
    mimeType: res.headers.get('Content-Type')?.split(';')[0] ?? 'image/png',
  };
}

// Incremental base64 encode. Slices are 24,576 bytes - a multiple of 3, so
// per-slice btoa output concatenates to exactly the one-shot encoding with
// padding only in the final slice.
const BASE64_CHUNK_BYTES = 24_576;

/**
 * Encode bytes to base64 without blocking the event loop: chunked
 * `String.fromCharCode.apply` + `btoa` per 24,576-byte slice, awaiting a
 * macrotask between slices. The yield is load-bearing - the chat
 * orchestrator's liveness heartbeat is a 15s setInterval, and a
 * synchronous conversion of a multi-MB image blocks the loop long enough
 * to starve it, which buried live chat turns as dead (the
 * upscaler-liveness plan's M2 repro). ~2,700 yields across a 64MB output
 * cost ~3s of wall time, noise against the 180s op budget. The inner
 * 0x8000 walk never iterates twice at the current slice size - it guards
 * apply's argument count if BASE64_CHUNK_BYTES is ever raised past the
 * engine's practical limit.
 * Padding only in the final slice; concatenation is byte-identical to a
 * one-shot encode.
 */
export async function base64FromBytesChunked(
  bytes: Uint8Array,
  yieldBetweenSlices: () => Promise<void> = () => new Promise((r) => setTimeout(r, 0)),
): Promise<string> {
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK_BYTES) {
    const slice = bytes.subarray(start, Math.min(start + BASE64_CHUNK_BYTES, bytes.length));
    let binary = '';
    for (let i = 0; i < slice.length; i += 0x8000) {
      binary += String.fromCharCode.apply(
        null,
        slice.subarray(i, Math.min(i + 0x8000, slice.length)) as unknown as number[],
      );
    }
    parts.push(btoa(binary));
    if (start + BASE64_CHUNK_BYTES < bytes.length) await yieldBetweenSlices();
  }
  return parts.join('');
}

export interface VeniceEditImageOptions {
  apiKey: string;
  /** Model id from the ?type=inpaint catalog. */
  model: string;
  /** Short, specific edit instruction. */
  prompt: string;
  /**
   * The source image: raw base64 or a data URI (Venice accepts both here;
   * URLs are also allowed but the function always inlines - the same
   * environmental reasoning as attachmentObjectAsDataUrl).
   */
  image: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * POST /image/edit against Venice: prompt-driven edit of one image. Wire
 * shape per the vendored venice-image-edit skill (2026-10): `model` (NOT
 * `modelId` - that is the deprecated alias and multi-edit's field name),
 * `prompt`, `image`; only fields the caller supplied are forwarded. Aspect
 * ratio is deliberately omitted - Venice infers it from the input image,
 * which is what the tool wants. Strict-body endpoint: an unknown field is a
 * 400, so nothing speculative goes on the wire.
 */
export async function veniceEditImage(
  opts: VeniceEditImageOptions
): Promise<{ imageBase64: string; mimeType: string }> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { ctl, cleanup } = imageOpSignal(opts.signal);

  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    image: opts.image,
    // Smaller attachments than the endpoint's PNG default (which can run
    // ~1MB at 1024px); webp renders everywhere the app targets.
    output_format: 'webp',
    safe_mode: true,
  };

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/image/edit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (err) {
    throw new VeniceError(
      `Network error contacting Venice: ${(err as Error).message}`,
      'network'
    );
  } finally {
    cleanup();
  }
  return imageOpResponseToBase64(res, 'image/edit');
}

export interface VeniceUpscaleImageOptions {
  apiKey: string;
  /**
   * The source image as RAW base64 - no `data:` prefix. The upscale
   * endpoint is the one edit-family route that rejects data URIs.
   */
  image: string;
  /** 2-4. Venice auto-reduces past its 16MP output cap. */
  scale: number;
  /** 0-0.02 detail/texture budget; Venice clamps further. */
  creativity?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * POST /image/upscale against Venice with the fixed `upscaler` model (no
 * `model` field exists on this endpoint). Response is PNG bytes, always.
 */
export async function veniceUpscaleImage(
  opts: VeniceUpscaleImageOptions
): Promise<{ imageBase64: string; mimeType: string }> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { ctl, cleanup } = imageOpSignal(opts.signal);

  const body: Record<string, unknown> = {
    image: opts.image,
    scale: opts.scale,
  };
  if (typeof opts.creativity === 'number') body.creativity = opts.creativity;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/image/upscale`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (err) {
    throw new VeniceError(
      `Network error contacting Venice: ${(err as Error).message}`,
      'network'
    );
  } finally {
    cleanup();
  }
  return imageOpResponseToBase64(res, 'image/upscale');
}

export interface VeniceRemoveBackgroundOptions {
  apiKey: string;
  /** Raw base64 or a data URI. (URLs are accepted too; we always inline.) */
  image: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * POST /image/background-remove against Venice with the fixed
 * `bria-bg-remover` model. Response is PNG bytes with an alpha channel.
 * Unlike upscale, this endpoint accepts data URIs; we forward whatever the
 * caller built.
 */
export async function veniceRemoveBackground(
  opts: VeniceRemoveBackgroundOptions
): Promise<{ imageBase64: string; mimeType: string }> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { ctl, cleanup } = imageOpSignal(opts.signal);

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/image/background-remove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ image: opts.image }),
      signal: ctl.signal,
    });
  } catch (err) {
    throw new VeniceError(
      `Network error contacting Venice: ${(err as Error).message}`,
      'network'
    );
  } finally {
    cleanup();
  }
  return imageOpResponseToBase64(res, 'image/background-remove');
}
