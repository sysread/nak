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

import type { ReasoningEffort } from './models';
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

/**
 * OpenAI-compatible `response_format` body field. Venice honors the
 * `text` / `json_object` variants from OpenAI's spec. We keep the type
 * loose (`type: string` + passthrough props) rather than modelling
 * every OpenAI shape because a future `json_schema` variant — which
 * carries nested `{ name, schema, strict }` — should ride through
 * unchanged if a caller reaches for it, without this file needing an
 * edit. Callers are responsible for building a shape the provider
 * actually accepts.
 */
export interface ResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  [k: string]: unknown;
}

/**
 * Venice-specific web-search mode, passed as
 * `venice_parameters.enable_web_search` on the request body.
 *
 *   'on'   — force a search on every turn. Our enabled-by-default value:
 *            relying on `auto` leaves too many model refusals ("I can't
 *            access the internet") on the table, since in auto mode the
 *            server only runs the search if the model signals intent.
 *   'auto' — let the model decide when a live search improves the answer.
 *   'off'  — disable the server-side tool entirely. Also the implicit
 *            Venice default when `venice_parameters` is omitted; we still
 *            send it explicitly so a user who flipped the setting off
 *            can't be overridden by a future server-side default change.
 *
 * Active modes ('on' / 'auto') additionally set
 * `venice_parameters.enable_web_citations=true` so sourced claims come
 * back attributed rather than silently merged into the answer.
 *
 * Docs: https://docs.venice.ai/api-reference (§ venice_parameters).
 */
export type WebSearchMode = 'auto' | 'on' | 'off';

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
  /**
   * When set, populates `venice_parameters.enable_web_search` on the
   * request body. Omitted → field is not sent (Venice's server-side
   * default applies). See {@link WebSearchMode}.
   */
  webSearch?: WebSearchMode;
  /**
   * OpenAI-style reasoning_effort knob ('low' | 'medium' | 'high').
   * Forwarded as the top-level `reasoning_effort` body field; omitted
   * entirely when unset so models that don't recognize the field
   * don't see it (some providers 400 on unknown params). Caller
   * (chat-loop / Chat.svelte) is responsible for gating on
   * `ModelSpec.supportsReasoning` before setting this.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * OpenAI-compatible `response_format`. Forwarded verbatim on the
   * request body; omitted entirely when unset so providers that
   * 400 on the unknown field never see it. Used by background agents
   * that want structured output (e.g. the recall agent's
   * discriminated union of "nothing to inject" vs. "assimilated
   * note"). The main chat loop leaves this unset — the UI renders
   * free-form markdown, not JSON.
   */
  responseFormat?: ResponseFormat;
}

/**
 * OpenAI-shaped token usage block. Venice emits this in an epilogue SSE
 * frame when we pass `stream_options: { include_usage: true }` — the
 * frame carries an empty `choices` array and a populated `usage` object.
 * All three fields are integers; the server guarantees
 * `total_tokens = prompt_tokens + completion_tokens`.
 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Events yielded by streamChat. Text arrives as it's generated; tool
 * calls arrive exactly once each, after their arguments JSON has been
 * fully assembled from its fragments. A `usage` event — if the provider
 * reported one — fires exactly once, after the final text/tool event
 * and before the generator returns.
 */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolCall: OpenAIToolCall }
  | { type: 'usage'; usage: TokenUsage };

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
      // Ask for a token-usage epilogue frame on the SSE stream. Without
      // this flag Venice (and OpenAI-compatible providers generally)
      // only emit usage on non-streaming responses; with it, a final
      // frame carries `{choices:[], usage:{...}}` after [DONE] logic
      // would otherwise fire. Drives the per-message context-window
      // indicator — a silently-unsupported provider just yields no
      // usage event and the indicator stays hidden.
      stream_options: { include_usage: true },
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
    }
    // Only send reasoning_effort when the caller opted in. Keeps the
    // wire payload clean for non-reasoning models and for test / utility
    // call paths (auto-titling) that shouldn't pay the latency tax.
    if (req.reasoningEffort) {
      body.reasoning_effort = req.reasoningEffort;
    }
    // Same discipline for response_format — only forwarded when the
    // caller asked. Some providers (and Venice's non-default models)
    // reject the field when its value isn't recognised, so silence is
    // the safer default.
    if (req.responseFormat) {
      body.response_format = req.responseFormat;
    }
    // Venice-specific: request web-search behavior via venice_parameters.
    // We send the field only when the caller passed an explicit mode so
    // that unrelated tests / callers that never opt in don't carry an
    // extra body key. Pair an active search mode with
    // `enable_web_citations` so sourced claims come back marked up —
    // without that flag Venice merges the fetched content into the
    // answer but strips the attribution. Citations are meaningless
    // when search is 'off', so we omit that field in that case.
    // (We deliberately do NOT set the xAI xsearch knob — that's a
    // separate server-side tool and the user hasn't opted in.)
    if (req.webSearch) {
      const veniceParams: Record<string, unknown> = {
        enable_web_search: req.webSearch,
      };
      if (req.webSearch !== 'off') {
        veniceParams.enable_web_citations = true;
      }
      body.venice_parameters = veniceParams;
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
    // Captured from the epilogue frame (see `stream_options.include_usage`
    // in the request). Emitted as a trailing `usage` event below after
    // tool-call flushing, so consumers can pair it to the just-finished
    // turn. Stays null if the provider didn't include one.
    let usage: TokenUsage | null = null;

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
          // The epilogue frame requested via `stream_options.include_usage`
          // arrives after the last choice-bearing frame and before
          // `[DONE]`. Capture it so we can emit a trailing `usage`
          // event below.
          if (parsed.usage) usage = parsed.usage;
          // `finish_reason` is informational now: the usage epilogue
          // arrives *after* it, so we can't short-circuit here. We
          // flag the round as finished and keep reading until `[DONE]`
          // or the socket closes.
          if (parsed.finishReason) finished = true;
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
    // Trailing usage event, if the provider honored include_usage. Fires
    // after tool_call flushing so consumers that only care about usage
    // never have to peek past tool events to find it.
    if (usage !== null) {
      yield { type: 'usage', usage };
    }
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
  /**
   * Populated only on the usage epilogue frame (empty `choices`,
   * top-level `usage` object). Carried separately from text/tool fields
   * because it travels on a choice-less frame and describes the whole
   * turn, not a single choice.
   */
  usage?: TokenUsage;
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

  interface RawUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  }

  let obj: { choices?: RawChoice[]; usage?: RawUsage };
  try {
    obj = JSON.parse(payload) as { choices?: RawChoice[]; usage?: RawUsage };
  } catch {
    return null;
  }

  const out: SseDelta = {};

  // Usage epilogue: `choices` is an empty array, `usage` sits at the top
  // level. We accept only fully-formed usage (all three ints present)
  // so downstream code can treat TokenUsage as a total record.
  const rawUsage = obj.usage;
  if (
    rawUsage &&
    typeof rawUsage.prompt_tokens === 'number' &&
    typeof rawUsage.completion_tokens === 'number' &&
    typeof rawUsage.total_tokens === 'number'
  ) {
    out.usage = {
      prompt_tokens: rawUsage.prompt_tokens,
      completion_tokens: rawUsage.completion_tokens,
      total_tokens: rawUsage.total_tokens,
    };
  }

  const choice = obj.choices?.[0];
  if (!choice) {
    // No choice but maybe a usage epilogue — surface that alone.
    return Object.keys(out).length === 0 ? null : out;
  }

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
