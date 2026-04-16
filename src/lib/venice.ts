/**
 * Venice.ai API client. Calls the Venice REST API directly from the browser
 * using a user-supplied API key. Venice implements the OpenAI-compatible
 * /chat/completions and /embeddings endpoints.
 *
 * Docs: https://docs.venice.ai/api-reference
 */

export interface VeniceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: VeniceMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  signal?: AbortSignal;
}

export interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

export class VeniceError extends Error {
  readonly status: number | null;
  readonly kind: 'rate_limit' | 'auth' | 'network' | 'http' | 'parse';
  constructor(
    message: string,
    kind: VeniceError['kind'],
    status: number | null = null
  ) {
    super(message);
    this.name = 'VeniceError';
    this.kind = kind;
    this.status = status;
  }
}

const DEFAULT_BASE_URL = 'https://api.venice.ai/api/v1';

export interface VeniceClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class VeniceClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: VeniceClientOptions) {
    if (!opts.apiKey) throw new VeniceError('API key is required', 'auth');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async classifyError(res: Response): Promise<VeniceError> {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      // ignore
    }
    if (res.status === 401 || res.status === 403) {
      return new VeniceError(
        `Venice rejected the API key (HTTP ${res.status}). ${detail}`,
        'auth',
        res.status
      );
    }
    if (res.status === 429) {
      return new VeniceError(
        `Venice rate limit hit (HTTP 429). ${detail}`,
        'rate_limit',
        res.status
      );
    }
    return new VeniceError(
      `Venice HTTP ${res.status}: ${detail}`,
      'http',
      res.status
    );
  }

  /**
   * Streaming chat completion. Yields assistant text deltas as they arrive.
   * The server uses the OpenAI-compatible SSE format.
   */
  async *streamChat(req: ChatRequest): AsyncGenerator<string, void, void> {
    const body = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: true,
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      throw new VeniceError(
        `Network error contacting Venice: ${(err as Error).message}`,
        'network'
      );
    }
    if (!res.ok) throw await this.classifyError(res);
    if (!res.body) throw new VeniceError('Venice returned empty body', 'parse');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const delta = parseSseFrame(frame);
          if (delta === null) continue;
          if (delta === '[DONE]') return;
          yield delta;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: req.model, input: req.input }),
        signal: req.signal,
      });
    } catch (err) {
      throw new VeniceError(
        `Network error contacting Venice: ${(err as Error).message}`,
        'network'
      );
    }
    if (!res.ok) throw await this.classifyError(res);
    try {
      return (await res.json()) as EmbeddingResponse;
    } catch {
      throw new VeniceError('Failed to parse Venice embedding response.', 'parse');
    }
  }
}

/**
 * Parses a single SSE frame and returns the content delta. Returns null
 * if the frame has no usable content, or the string '[DONE]' when the
 * server signals completion.
 */
export function parseSseFrame(frame: string): string | '[DONE]' | null {
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n');
  if (payload === '[DONE]') return '[DONE]';
  try {
    const obj = JSON.parse(payload) as {
      choices?: { delta?: { content?: string } }[];
    };
    const delta = obj.choices?.[0]?.delta?.content;
    return typeof delta === 'string' && delta.length > 0 ? delta : null;
  } catch {
    return null;
  }
}
