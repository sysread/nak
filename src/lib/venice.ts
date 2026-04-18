/**
 * Venice.ai API client. Calls the Venice REST API directly from the browser
 * using a user-supplied API key. Venice implements the OpenAI-compatible
 * /chat/completions and /embeddings endpoints.
 *
 * Docs: https://docs.venice.ai/api-reference
 *
 * Why we parse SSE manually instead of using the browser's EventSource:
 * EventSource is GET-only and cannot set custom headers (no way to send
 * `Authorization: Bearer …`). A POST fetch() with `stream: true` and
 * a hand-rolled frame splitter on `\n\n` is the standard workaround —
 * this is the same pattern OpenAI's own JS SDK uses in the browser.
 *
 * The API key is passed on every request as an Authorization header.
 * It lives in memory while the app is unlocked (state.svelte.ts holds
 * the VeniceClient instance) and never touches storage except as part
 * of the encrypted config blob.
 *
 * Streaming shape: streamChat yields a discriminated union of
 * StreamEvent values. Text deltas appear as they arrive; tool_call
 * events appear *once* per call, after the accumulator has assembled
 * a complete `arguments` JSON string from the fragments OpenAI
 * streams across many deltas.
 */

import type { OpenAIToolDef, OpenAIToolCall } from './tools/types';

/**
 * Messages on the wire can include any of the OpenAI roles. When the
 * caller passes a role='tool' message, it must also set tool_call_id
 * and name to pair the result with the assistant call that produced it.
 * Likewise role='assistant' rows that invoked tools carry a tool_calls
 * array (and usually an empty `content`).
 */
export interface VeniceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface ChatRequest {
  model: string;
  messages: VeniceMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Tools available for this turn. When omitted, no tools are offered
   * and the model responds with plain text. When present, the model
   * may emit `tool_calls` events instead of (or in addition to) text.
   */
  tools?: OpenAIToolDef[];
}

/**
 * Events yielded by streamChat. Text arrives as it's generated; tool
 * calls arrive exactly once each, after their arguments JSON has been
 * fully assembled from its fragments.
 */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolCall: OpenAIToolCall };

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
   * Streaming chat completion. Yields a mix of text deltas (as they
   * arrive) and tool_call events (each emitted once, after its
   * arguments string has been fully assembled).
   */
  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: true,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
    }
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
    // Tool-call fragments stream fragmented across deltas, keyed by
    // `index`. We accumulate until the server signals the call is
    // complete (finish_reason='tool_calls' or stream end), then emit
    // one `tool_call` event per completed call.
    const pending = new Map<number, {
      id?: string;
      name?: string;
      argumentsAccum: string;
    }>();
    let finished = false;

    const flushToolCalls = function* (): Generator<StreamEvent, void, void> {
      const sorted = Array.from(pending.entries()).sort((a, b) => a[0] - b[0]);
      for (const [, partial] of sorted) {
        if (!partial.id || !partial.name) continue;
        yield {
          type: 'tool_call',
          toolCall: {
            id: partial.id,
            type: 'function',
            function: {
              name: partial.name,
              arguments: partial.argumentsAccum,
            },
          },
        };
      }
      pending.clear();
    };

    try {
      outer: for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseFrame(frame);
          if (parsed === null) continue;
          if (parsed === '[DONE]') {
            finished = true;
            break outer;
          }
          if (parsed.text !== undefined && parsed.text.length > 0) {
            yield { type: 'text', delta: parsed.text };
          }
          if (parsed.toolCallFragments) {
            for (const frag of parsed.toolCallFragments) {
              const entry = pending.get(frag.index) ?? { argumentsAccum: '' };
              if (frag.id) entry.id = frag.id;
              if (frag.name) entry.name = frag.name;
              if (frag.argumentsAppend) {
                entry.argumentsAccum += frag.argumentsAppend;
              }
              pending.set(frag.index, entry);
            }
          }
          // On `finish_reason='tool_calls'` (or 'stop' with no pending
          // calls) we're done with this response. We defer emission
          // until the loop actually exits so any straggling text deltas
          // in the same frame already got yielded above.
          if (parsed.finishReason) {
            finished = true;
            break outer;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Regardless of how we exited the loop, emit whatever tool_calls
    // finished accumulating. Fragments without both an id and a name
    // are dropped by flushToolCalls — those would be truncated
    // mid-announcement and can't be executed safely.
    yield* flushToolCalls();
    // The `finished` flag is a debugging aid more than a contract —
    // callers only care that the generator returned.
    void finished;
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
 * A parsed SSE frame. Multiple fields may be set in a single frame —
 * OpenAI sometimes batches a text delta, a tool-call fragment, and a
 * finish_reason into one choice. `null` means the frame carried no
 * actionable info (blank, heartbeat, malformed).
 */
export interface SseDelta {
  text?: string;
  toolCallFragments?: Array<{
    index: number;
    id?: string;
    name?: string;
    argumentsAppend?: string;
  }>;
  finishReason?: string;
}

/**
 * Parses a single SSE frame. Returns '[DONE]' when the server signals
 * end-of-stream; null when the frame has no usable data (heartbeat,
 * empty delta); otherwise an SseDelta with whichever fields the frame
 * contained. Text and tool-call fragments can both be present in the
 * same frame — the caller handles each independently.
 */
export function parseSseFrame(frame: string): SseDelta | '[DONE]' | null {
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

  interface RawChoice {
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }

  let obj: { choices?: RawChoice[] };
  try {
    obj = JSON.parse(payload) as { choices?: RawChoice[] };
  } catch {
    return null;
  }
  const choice = obj.choices?.[0];
  if (!choice) return null;

  const out: SseDelta = {};
  const content = choice.delta?.content;
  if (typeof content === 'string' && content.length > 0) {
    out.text = content;
  }
  const rawCalls = choice.delta?.tool_calls;
  if (Array.isArray(rawCalls) && rawCalls.length > 0) {
    const frags: NonNullable<SseDelta['toolCallFragments']> = [];
    for (const c of rawCalls) {
      if (typeof c.index !== 'number') continue;
      const frag: { index: number; id?: string; name?: string; argumentsAppend?: string } = {
        index: c.index,
      };
      if (typeof c.id === 'string') frag.id = c.id;
      const fname = c.function?.name;
      if (typeof fname === 'string') frag.name = fname;
      const fargs = c.function?.arguments;
      if (typeof fargs === 'string') frag.argumentsAppend = fargs;
      frags.push(frag);
    }
    if (frags.length > 0) out.toolCallFragments = frags;
  }
  if (typeof choice.finish_reason === 'string') {
    out.finishReason = choice.finish_reason;
  }
  return Object.keys(out).length === 0 ? null : out;
}
