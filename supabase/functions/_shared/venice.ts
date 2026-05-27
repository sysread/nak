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
