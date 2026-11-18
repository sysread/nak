// Venice /augment/text-parser relay. The barrel _shared/venice.ts
// re-exports everything.
import { DEFAULT_BASE_URL, VeniceError } from './shared.ts';

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
