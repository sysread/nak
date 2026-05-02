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
 * Two entry points for chat completions:
 *
 *   - {@link VeniceClient.streamChat} - SSE-streaming. Yields a
 *     discriminated union of StreamEvent values; text deltas appear
 *     as they arrive, tool_call events appear *once* per call after
 *     the accumulator has assembled a complete `arguments` JSON
 *     string from the fragments OpenAI streams across many deltas.
 *     Used ONLY by the main user-facing chat (`chat-loop.ts`) where
 *     incremental rendering is what makes the app feel alive.
 *
 *   - {@link VeniceClient.completeChat} - one-shot non-streaming
 *     POST. Returns a fully-assembled {@link ChatCompletion} record
 *     once the response lands. Used by every background path -
 *     auto-titling, summary, samskara, intuition, the recall and
 *     reflection agents, the web_search / research_docs /
 *     analyze_image tools, and the headless tool loop. Background
 *     callers don't have a UI surface to render token-by-token, and
 *     long-lived SSE connections are noticeably slower end-to-end
 *     than the equivalent non-streaming POST (the provider has to
 *     flush after every chunk, which serializes cross-region latency
 *     into the per-token path). They also fail in transient ways
 *     specific to streaming - the silent "stream completed with no
 *     text" error mode the web_search tool kept hitting was a Venice
 *     SSE quirk that simply doesn't exist for the non-streaming
 *     completion endpoint.
 *
 * Body building is shared via {@link buildChatBody}; the two methods
 * differ only in the `stream` / `stream_options` flags they layer on
 * and how they consume the wire response.
 */

import type { ReasoningEffort, Verbosity } from './models';
import type { OpenAIToolDef, OpenAIToolCall } from './tools/types';
// Re-export so callers consuming a ChatCompletion (ChatCompletion.toolCalls
// is OpenAIToolCall[]) can pull the type from the same module without
// reaching into ./tools/types.
export type { OpenAIToolCall };
import { createLogger } from './logger.svelte';

const log = createLogger('venice');

/**
 * One entry in an OpenAI-compatible multimodal `content` array. Used for
 * vision inlining: when a user message carries images and the model
 * supports vision, we send `content` as `[{type:'text', text:'...'},
 * {type:'image_url', image_url:{url:'data:image/png;base64,...'}}]`
 * instead of a plain string. Venice accepts data-URI inputs for
 * `image_url.url` on vision-capable tiers.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Messages on the wire can include any of the OpenAI roles. When the
 * caller passes a role='tool' message, it must also set tool_call_id
 * and name to pair the result with the assistant call that produced it.
 * Likewise role='assistant' rows that invoked tools carry a tool_calls
 * array (and usually an empty `content`).
 *
 * `content` widened to accept a ContentPart[] so user messages with
 * image attachments can inline them as `image_url` entries for vision
 * models. Plain-string callers keep working unchanged — the union
 * widens without breaking them.
 */
export interface VeniceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
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
 * Web-search source cited by Venice when `enable_web_citations=true`.
 * Ships on `venice_parameters.web_search_citations` — a top-level array
 * on the non-streaming response, and on the FIRST chunk of a streaming
 * result (Venice's own phrasing; see
 * https://docs.venice.ai/api-reference/endpoint/chat/completions). The
 * model is instructed to mark sourced claims inline with `^N^` /
 * `^i,j^` superscripts that index into this array (1-based).
 *
 * Fields beyond `url` are all optional because Venice doesn't guarantee
 * them per result — some sources come back with just a URL, others
 * include title/date/snippet. Be liberal about what we render; the
 * citation panel handles each field being absent.
 */
export interface Citation {
  /** 1-based index matching the `^N^` superscripts in the message body. */
  index: number;
  title?: string;
  url: string;
  /** Short snippet / summary of the source content. */
  content?: string;
  /** ISO-ish date string; rendered verbatim. */
  date?: string;
}

/**
 * Venice-specific web-search mode, passed as
 * `venice_parameters.enable_web_search` on the request body.
 *
 *   'on'   — force a search on every turn.
 *   'auto' — let the model decide when a live search improves the answer.
 *   'off'  — disable the server-side tool entirely. Also the implicit
 *            Venice default when the parameter is omitted.
 *
 * Active modes ('on' / 'auto') additionally gate
 * `venice_parameters.enable_web_citations`; whether that flag lands
 * `true` or `false` is controlled independently by
 * {@link ChatRequest.webCitations} so a caller can keep grounding
 * while suppressing the `[1]` / `[2]` markers in the answer body.
 *
 * Caller scoping: the main chat loop in `chat-loop.ts` deliberately
 * does NOT set `webSearch` or `webCitations` on its `streamChat`
 * calls. Venice treats `enable_web_search: 'on'` as unconditional
 * (every request runs a search), so leaving the flag unset is the
 * only way to keep the default chat path from burning quota on
 * questions the model could have answered from weights. The sole
 * caller that sets these is the `web_search` tool (see
 * `src/lib/tools/web_search.ts`), which runs a one-shot sub-
 * completion with search on and returns the answer + citations as a
 * structured tool result.
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
   * default applies). See {@link WebSearchMode}. The main chat loop
   * never sets this - only the `web_search` tool does, for the sub-
   * completion it wraps.
   */
  webSearch?: WebSearchMode;
  /**
   * Whether to also request Venice's inline source attribution
   * (`venice_parameters.enable_web_citations`). Only consulted when
   * `webSearch` is active (`'on'` / `'auto'`) - citations without a
   * search would be sourceless anyway. Undefined means "citations on"
   * so callers that opted into web search but haven't opinionated on
   * citations get the enabled-by-default behavior. Set `false` to
   * keep grounding but suppress the `[1]` / `[2]` markers from the
   * answer body. Like `webSearch`, only the `web_search` tool sets
   * this now.
   */
  webCitations?: boolean;
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
   * OpenAI-style `text.verbosity` knob ('low' | 'medium' | 'high').
   * Nests under the top-level `text` object on the wire — body shape
   * `{text: {verbosity: '…'}}` — not a flat field like
   * `reasoning_effort`. Omitted entirely when unset so providers
   * that don't recognize the field can't 400 on it. Orthogonal to
   * reasoning_effort: verbosity controls answer length, reasoning
   * controls hidden-thought depth.
   */
  verbosity?: Verbosity;
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
 *
 * `reasoning` carries chain-of-thought tokens streamed on
 * `delta.reasoning_content` (OpenAI-compat; providers that support
 * Anthropic-style thinking map into the same field). Arrives before
 * the visible text on reasoning-capable models and lets the UI show a
 * "thinking…" panel that collapses once real content starts flowing.
 *
 * `citations` carries Venice's `web_search_citations` array. Venice
 * ships it on the first streaming chunk OR at the top of the non-
 * streaming response (per docs); we normalize to one event emitted
 * the first time we see a non-empty list in the stream.
 */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; toolCall: OpenAIToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'citations'; citations: Citation[] };

/**
 * Result returned by {@link VeniceClient.completeChat}. The
 * non-streaming POST gives us everything in one shot, so the shape
 * is a flat record rather than a stream of events. Mirrors
 * {@link StreamEvent} field-for-field so callers that don't need
 * incremental rendering can use either path with no behavioural
 * difference.
 *
 *   - `text`: the assistant message body (`choices[0].message.content`),
 *     trimmed of the empty-string default. Safe to read directly without
 *     any nullable checks.
 *   - `reasoning`: chain-of-thought string from
 *     `choices[0].message.reasoning_content`, or '' when the provider
 *     didn't surface any (non-reasoning models, or reasoning gated
 *     behind a flag the caller didn't set).
 *   - `toolCalls`: assembled tool calls from `choices[0].message.tool_calls`.
 *     Each entry is OpenAI's `{id, type, function: {name, arguments}}` shape;
 *     `arguments` is a JSON string the caller is expected to JSON.parse.
 *   - `usage`: top-level `usage` object on the completion. Always
 *     populated by the non-streaming path (no `include_usage` opt-in
 *     required) but kept nullable for symmetry with StreamEvent and
 *     to tolerate a provider that drops the field.
 *   - `citations`: Venice's `web_search_citations` array. Empty when
 *     no search ran or no sources came back.
 *   - `finishReason`: `choices[0].finish_reason`. Informational; used
 *     by the headless tool loop to decide nothing-yet-vs-stop.
 */
export interface ChatCompletion {
  text: string;
  reasoning: string;
  toolCalls: OpenAIToolCall[];
  usage: TokenUsage | null;
  citations: Citation[];
  finishReason: string | null;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  signal?: AbortSignal;
}

export interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

/**
 * Currency codes Venice reports on billing rows. USD is the obvious
 * fiat denominator; VCU ("Venice Compute Units") is the credit unit on
 * prepaid/bundled plans; DIEM and BUNDLED_CREDITS show up on Venice's
 * token-economy and partner-credit tiers. Listed here as a union so the
 * UI can format the pill ("$0.07" vs "0.15 VCU") without having to
 * guess.
 *
 * Docs: https://docs.venice.ai/api-reference/endpoint/billing/usage
 */
export type UsageCurrency = 'USD' | 'VCU' | 'DIEM' | 'BUNDLED_CREDITS';

/**
 * One row of the `/billing/usage` response. Each row is a single
 * charge against a product SKU — one chat completion, one embedding
 * batch, one image generation. LLM rows carry an `inferenceDetails`
 * block with prompt/completion token counts; non-LLM SKUs (image,
 * video, etc.) leave it null. `units` is the billable quantity in
 * whatever unit the SKU bills in (typically output mega-tokens for
 * LLMs); `amount` is the cost in `currency`.
 *
 * Every field beyond the JSON-mandatory ones is treated as optional by
 * the parser — the endpoint is marked beta in Venice's docs and shape
 * drift is likely. See `fetchUsage` for the defensive coercion.
 */
export interface UsageRow {
  timestamp: string;
  sku: string;
  pricePerUnitUsd: number;
  units: number;
  amount: number;
  currency: UsageCurrency;
  notes: string;
  inferenceDetails: {
    requestId?: string;
    inferenceExecutionTime?: number;
    promptTokens?: number;
    completionTokens?: number;
  } | null;
}

export interface UsageRequestOptions {
  /** ISO 8601 lower bound (inclusive). Omitted ⇒ unbounded. */
  startDate?: string;
  /** ISO 8601 upper bound (exclusive, per Venice docs). Omitted ⇒ unbounded. */
  endDate?: string;
  /**
   * Filter to a single currency. Usually left unset so the caller
   * sees every charge regardless of denomination — pill formatting
   * downstream handles the mix.
   */
  currency?: UsageCurrency;
  signal?: AbortSignal;
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

/**
 * Safety cap on {@link VeniceClient.fetchUsage} paging. 20 × 500 =
 * 10k rows — more than enough for a month of heavy use, and bounded
 * memory for a pathological response. Hitting the cap is surfaced by
 * the Usage pane as a truncation note so the user knows to narrow the
 * date range rather than silently seeing only the top slice.
 */
export const USAGE_MAX_PAGES = 20;

/**
 * Defensive reader for one `/billing/usage` row. Venice's docs mark the
 * endpoint beta and we've seen shape drift on other beta endpoints
 * there — so every field is validated and a row that fails any check
 * is dropped entirely. Better to lose one malformed row than crash the
 * Usage pane on a single bad entry.
 */
function coerceUsageRow(raw: unknown): UsageRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const timestamp = typeof r.timestamp === 'string' ? r.timestamp : null;
  const sku = typeof r.sku === 'string' ? r.sku : null;
  const amount = typeof r.amount === 'number' ? r.amount : null;
  const units = typeof r.units === 'number' ? r.units : null;
  const pricePerUnitUsd =
    typeof r.pricePerUnitUsd === 'number' ? r.pricePerUnitUsd : null;
  const currency = isUsageCurrency(r.currency) ? r.currency : null;
  if (!timestamp || !sku || amount === null || units === null || currency === null) {
    return null;
  }
  const notes = typeof r.notes === 'string' ? r.notes : '';
  let inferenceDetails: UsageRow['inferenceDetails'] = null;
  if (typeof r.inferenceDetails === 'object' && r.inferenceDetails !== null) {
    const d = r.inferenceDetails as Record<string, unknown>;
    const details: NonNullable<UsageRow['inferenceDetails']> = {};
    if (typeof d.requestId === 'string') details.requestId = d.requestId;
    if (typeof d.inferenceExecutionTime === 'number') {
      details.inferenceExecutionTime = d.inferenceExecutionTime;
    }
    if (typeof d.promptTokens === 'number') details.promptTokens = d.promptTokens;
    if (typeof d.completionTokens === 'number') {
      details.completionTokens = d.completionTokens;
    }
    inferenceDetails = details;
  }
  return {
    timestamp,
    sku,
    pricePerUnitUsd: pricePerUnitUsd ?? 0,
    units,
    amount,
    currency,
    notes,
    inferenceDetails,
  };
}

function isUsageCurrency(v: unknown): v is UsageCurrency {
  return (
    v === 'USD' || v === 'VCU' || v === 'DIEM' || v === 'BUNDLED_CREDITS'
  );
}

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
   * Build the JSON body shared by streamChat and completeChat. The
   * `streaming` arg toggles the `stream` / `stream_options` fields
   * and the `include_search_results_in_stream` venice_parameter -
   * everything else (tools, reasoning, verbosity, response_format,
   * web search, scraping, the system-prompt opt-out) lands on both
   * paths identically. Centralising the build means a wire-shape
   * change can't accidentally land on one path and not the other.
   */
  private buildChatBody(req: ChatRequest, streaming: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
    };
    if (streaming) {
      body.stream = true;
      // Ask for a token-usage epilogue frame on the SSE stream. Without
      // this flag Venice (and OpenAI-compatible providers generally)
      // only emit usage on non-streaming responses; with it, a final
      // frame carries `{choices:[], usage:{...}}` after [DONE] logic
      // would otherwise fire. Drives the per-message context-window
      // indicator — a silently-unsupported provider just yields no
      // usage event and the indicator stays hidden. Non-streaming
      // responses always carry `usage` at the top level so this flag
      // is meaningless on the completeChat path.
      body.stream_options = { include_usage: true };
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
    }
    // Only send reasoning_effort when the caller opted in. Keeps the
    // wire payload clean for non-reasoning models and for test / utility
    // call paths (auto-titling) that shouldn't pay the latency tax.
    if (req.reasoningEffort) {
      body.reasoning_effort = req.reasoningEffort;
    }
    // Same discipline for text.verbosity — only forward when the
    // caller opted in, and nest under `text` to match the OpenAI
    // spec shape. Providers that don't recognize the field silently
    // ignore it; ones that 400 on unknown params never see it.
    if (req.verbosity) {
      body.text = { verbosity: req.verbosity };
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
    //
    // `include_search_results_in_stream` is the opt-in for receiving
    // the `web_search_citations` array during a streaming response -
    // it defaults to `false` server-side, meaning citations would
    // otherwise only appear in non-streaming responses. Without this
    // flag the model still adds `^N^` superscripts to the content
    // (that's what `enable_web_citations` gates), but the matching
    // list never arrives and the superscripts become orphaned.
    // Flagged experimental in the Venice docs but it's the only way
    // to surface citations in our streaming pipeline. Non-streaming
    // responses always include the citations list at the top level
    // so the flag is unnecessary there.
    //
    // Disable Venice's platform-level system prompt. By default
    // Venice prepends its own generic "you are a helpful assistant"
    // framing to every request, which stacks on top of our
    // `buildSystemPrompt()` output and can drag responses back
    // toward the diplomatic / comfort-first tone our Voice block is
    // specifically pushing away from. Nak's baseline system prompt
    // is intentional and covers identity, tool framing, and voice
    // on its own — Venice's prefix is redundant at best and
    // counter-productive at worst. The flag is
    // `include_venice_system_prompt`; it defaults to true server-
    // side, so we have to explicitly opt out.
    //
    // Applies to every chat-completion call (main chat + all sub-
    // agents - recall, conversation_recall, reflection, summary,
    // auto-title, samskara, intuition, the web_search /
    // research_docs / analyze_image tools). Each of those prompts is
    // self-sufficient; none of them benefit from a Venice generic
    // preamble landing on top.
    //
    // `enable_web_scraping` (also always on): tells Venice to fetch
    // the full content of any URL the user pastes into their latest
    // message, via Firecrawl on Venice's side. Independent of
    // `enable_web_search` per Venice's docs — search augments the
    // turn with results from a query, scraping reads URLs the user
    // explicitly provided. Baseline cost is zero when the message
    // has no URLs, so there's no reason to gate it; when a user
    // drops a link, they nearly always want it read. The scraped
    // content lands inlined in the user turn the same way search
    // results do, so the attribution guard in `buildSystemPrompt`
    // plus the `<user_message>` wrapping in chat-loop.ts cover
    // both injection paths uniformly.
    const veniceParams: Record<string, unknown> = {
      include_venice_system_prompt: false,
      enable_web_scraping: true,
    };
    if (req.webSearch) {
      veniceParams.enable_web_search = req.webSearch;
      if (req.webSearch !== 'off') {
        // Inline citations default to on for backwards-compat; the
        // caller flips this off to keep grounding but strip the
        // `[1]` / `[2]` markers from the answer body. Gated inside
        // the active-search branch because citations without a
        // search are sourceless - no `enable_web_search=off` request
        // should ever carry a citations flag.
        veniceParams.enable_web_citations = req.webCitations ?? true;
        if (streaming) {
          veniceParams.include_search_results_in_stream = true;
        }
      }
    }
    body.venice_parameters = veniceParams;
    return body;
  }

  /**
   * Streaming chat completion. Yields a mix of text deltas (as they
   * arrive) and tool_call events (each emitted once, after its
   * arguments string has been fully assembled).
   *
   * Used only by the main user-facing chat loop. Background callers
   * should use {@link completeChat}; see the file header for the
   * rationale.
   */
  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const body = this.buildChatBody(req, true);
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
    // Venice's web_search_citations ride on `venice_parameters` on a
    // frame early in the stream (docs: "first chunk of a streaming
    // result"). Emit exactly one `citations` event the first time we
    // see a non-empty list — re-emitting on every frame would force
    // downstream consumers to dedupe. Stays false when citations
    // weren't requested or the provider skipped them.
    let citationsEmitted = false;

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
          // Reasoning tokens land on a separate field per the
          // OpenAI-compat convention (`delta.reasoning_content`). We
          // pass them through as a distinct event rather than folding
          // into `text` so the UI can present them in its own
          // collapsible panel — if we mixed the two, reasoning would
          // either leak into the rendered answer or get stripped by a
          // post-hoc regex.
          if (parsed.reasoning !== undefined && parsed.reasoning.length > 0) {
            yield { type: 'reasoning', delta: parsed.reasoning };
          }
          // Emit citations the first time we see them — downstream
          // consumers get the full list in one event, not a sequence
          // they have to reconcile. Venice documents this as
          // first-chunk-only, but guard anyway so a provider that
          // re-sends the list doesn't produce duplicate events.
          if (
            !citationsEmitted &&
            parsed.citations &&
            parsed.citations.length > 0
          ) {
            citationsEmitted = true;
            yield { type: 'citations', citations: parsed.citations };
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
    } catch (err) {
      // SSE parse failures, network interruptions mid-stream, and
      // reader.read() rejections all land here. The error is re-
      // thrown so the for-await consumer in chat-loop.ts sees it
      // (and runExchange's outer catch surfaces it to the user),
      // but we log at the source layer too so the log drawer shows
      // the error with `venice` as the source tag. Mobile users
      // without devtools depend on this breadcrumb to tell a stream
      // failure apart from a later persistence failure - they have
      // identical downstream symptoms without it.
      log.error('streamChat SSE loop failed', err);
      throw err;
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

  /**
   * Non-streaming chat completion. POSTs the same body shape
   * streamChat builds (minus the `stream` / `stream_options` flags
   * and the streaming-only `include_search_results_in_stream` venice
   * parameter), parses the single JSON response, and returns a flat
   * {@link ChatCompletion} record.
   *
   * Used by every background path - sub-agents, headless tool loops,
   * and the auto-running pipelines (intuition, samskara, summary,
   * recall). See the file header for why background callers
   * shouldn't use streamChat: SSE adds latency the user can't see
   * and exposes us to provider-specific stream-only failure modes.
   */
  async completeChat(req: ChatRequest): Promise<ChatCompletion> {
    const body = this.buildChatBody(req, false);
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
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new VeniceError('Failed to parse Venice completion response.', 'parse');
    }
    return parseChatCompletion(payload);
  }

  /**
   * Fetch billing usage from `GET /billing/usage`. Pages through the
   * cursor transparently and returns every row in the requested range.
   *
   * The endpoint is flagged beta in Venice's docs and may reshape; the
   * response is coerced defensively — a row with a bad type on any
   * field is dropped rather than surfaced, so the Usage pane never
   * renders NaN bars or "undefined" pills.
   *
   * Paging cap: {@link USAGE_MAX_PAGES} pages (× 500 rows/page). A
   * runaway response never spends the tab's memory without bound —
   * hitting the cap just truncates the tail of the range, which the
   * UI flags in a footer note.
   */
  async fetchUsage(opts: UsageRequestOptions = {}): Promise<UsageRow[]> {
    const out: UsageRow[] = [];
    const limit = 500;
    let page = 1;
    for (;;) {
      const qs = new URLSearchParams();
      qs.set('limit', String(limit));
      qs.set('page', String(page));
      qs.set('sortOrder', 'desc');
      if (opts.startDate) qs.set('startDate', opts.startDate);
      if (opts.endDate) qs.set('endDate', opts.endDate);
      if (opts.currency) qs.set('currency', opts.currency);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/billing/usage?${qs}`, {
          method: 'GET',
          // Don't reach for `this.headers()` — the JSON Content-Type
          // there is meaningful only for POST bodies. GET with a body-
          // less request + that header confuses some intermediaries
          // (and, more prosaically, preflights an extra OPTIONS round-
          // trip we don't need). Also pin `Accept: application/json`
          // so a client that defaults to `*/*` doesn't accidentally
          // negotiate the CSV variant Venice also offers on this path.
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
          signal: opts.signal,
        });
      } catch (err) {
        throw new VeniceError(
          `Network error contacting Venice: ${(err as Error).message}`,
          'network'
        );
      }
      if (!res.ok) throw await this.classifyError(res);
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        throw new VeniceError('Failed to parse Venice usage response.', 'parse');
      }
      const body = payload as {
        data?: unknown;
        pagination?: { totalPages?: number };
      };
      const rows = Array.isArray(body.data) ? body.data : [];
      for (const raw of rows) {
        const row = coerceUsageRow(raw);
        if (row) out.push(row);
      }
      const totalPages = body.pagination?.totalPages ?? 1;
      if (page >= totalPages || page >= USAGE_MAX_PAGES) break;
      page++;
    }
    return out;
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

  /**
   * Extract readable text from a user-uploaded file via Venice's
   * `POST /augment/text-parser` endpoint. Used at attachment-upload
   * time for non-image files so the LLM sees a prompt-ready
   * representation — avoids bundling a PDF / office-doc parser client-
   * side. The returned string lands in `message_attachments.extracted_text`
   * and survives the 30-day binary expiry.
   *
   * Multipart/form-data is required (the endpoint is file-typed, not
   * JSON). We explicitly don't set Content-Type — the browser
   * generates the correct `multipart/form-data; boundary=…` header
   * from the FormData body.
   *
   * Throws a VeniceError on any failure; the caller decides whether to
   * block the send or treat the file as text-less.
   */
  async extractText(file: Blob, filename: string): Promise<string> {
    const form = new FormData();
    form.append('file', file, filename);
    form.append('response_format', 'json');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/augment/text-parser`, {
        method: 'POST',
        // Not `this.headers()` — the JSON Content-Type would clobber
        // the multipart boundary the browser needs to write.
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
    } catch (err) {
      throw new VeniceError(
        `Network error contacting Venice: ${(err as Error).message}`,
        'network'
      );
    }
    if (!res.ok) throw await this.classifyError(res);
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new VeniceError('Failed to parse Venice text-parser response.', 'parse');
    }
    // Venice's documented response shape is `{ text: string, ... }`.
    // Accept `text` as the canonical field and fall back to a couple
    // of plausible alternates so an API tweak doesn't instantly break
    // us — we'll see a populated string from at least one of them.
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
}

/**
 * A parsed SSE frame. Multiple fields may be set in a single frame —
 * OpenAI sometimes batches a text delta, a tool-call fragment, and a
 * finish_reason into one choice. `null` means the frame carried no
 * actionable info (blank, heartbeat, malformed).
 */
export interface SseDelta {
  text?: string;
  /**
   * Reasoning / chain-of-thought delta, surfaced on
   * `choices[0].delta.reasoning_content` (the OpenAI-compat field
   * Venice and most reasoning-capable providers use). Streamed
   * incrementally just like `text`, so we accumulate by append on the
   * consumer side.
   */
  reasoning?: string;
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
  /**
   * Populated from `venice_parameters.web_search_citations` when
   * Venice attaches sources to a response. Docs say the list rides on
   * the first chunk of a streaming result; we normalize to "whichever
   * frame carries it" because a provider version bump could shift the
   * exact frame. Stays absent when citations weren't requested or
   * weren't produced.
   */
  citations?: Citation[];
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
      reasoning_content?: string;
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

  interface RawCitation {
    title?: unknown;
    url?: unknown;
    content?: unknown;
    date?: unknown;
  }

  interface RawVeniceParams {
    web_search_citations?: RawCitation[];
  }

  let obj: {
    choices?: RawChoice[];
    usage?: RawUsage;
    venice_parameters?: RawVeniceParams;
  };
  try {
    obj = JSON.parse(payload) as {
      choices?: RawChoice[];
      usage?: RawUsage;
      venice_parameters?: RawVeniceParams;
    };
  } catch {
    return null;
  }

  const out: SseDelta = {};

  // Venice's `web_search_citations` ride at the top level (nested
  // inside `venice_parameters`). The field is a sibling of `choices`
  // and `usage`, not part of any individual delta — it describes the
  // whole turn's sourcing. Parse defensively: every citation field
  // except `url` is optional per the docs, and we drop rows with no
  // usable url entirely (they'd render as dead refs).
  const rawCitations = obj.venice_parameters?.web_search_citations;
  if (Array.isArray(rawCitations) && rawCitations.length > 0) {
    const citations: Citation[] = [];
    rawCitations.forEach((c, i) => {
      if (typeof c !== 'object' || c === null) return;
      const url = typeof c.url === 'string' ? c.url : null;
      if (!url) return;
      const cite: Citation = { index: i + 1, url };
      if (typeof c.title === 'string') cite.title = c.title;
      if (typeof c.content === 'string') cite.content = c.content;
      if (typeof c.date === 'string') cite.date = c.date;
      citations.push(cite);
    });
    if (citations.length > 0) out.citations = citations;
  }

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
  const reasoning = choice.delta?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    out.reasoning = reasoning;
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

/**
 * Coerce the JSON body of a non-streaming `/chat/completions`
 * response into a {@link ChatCompletion}. Defensive about each field:
 *
 *   - `choices[0].message.content` may be null when the model
 *     produced only tool calls; render as ''.
 *   - `tool_calls` rides on `message.tool_calls` (not in fragments
 *     keyed by `index` like the streaming path) - each entry is
 *     already a complete OpenAI tool-call record.
 *   - Citations live on the same `venice_parameters.web_search_citations`
 *     path as the streaming first-frame; reuse the same coercion.
 *   - `usage` is always at the top level on non-streaming responses;
 *     no `include_usage` opt-in is needed.
 *
 * Exported for direct test coverage and so a future migration to a
 * different transport (websocket, gRPC, etc.) can reuse the
 * shape-translation logic without duplicating it.
 */
export function parseChatCompletion(payload: unknown): ChatCompletion {
  if (typeof payload !== 'object' || payload === null) {
    throw new VeniceError('Venice completion response was not an object.', 'parse');
  }
  interface RawMessage {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  }
  interface RawChoice {
    message?: RawMessage;
    finish_reason?: string | null;
  }
  interface RawUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  }
  interface RawCitation {
    title?: unknown;
    url?: unknown;
    content?: unknown;
    date?: unknown;
  }
  interface RawVeniceParams {
    web_search_citations?: RawCitation[];
  }
  const obj = payload as {
    choices?: RawChoice[];
    usage?: RawUsage;
    venice_parameters?: RawVeniceParams;
  };

  const choice = obj.choices?.[0];
  const message = choice?.message;
  const text =
    typeof message?.content === 'string' ? message.content : '';
  const reasoning =
    typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';

  const toolCalls: OpenAIToolCall[] = [];
  if (Array.isArray(message?.tool_calls)) {
    for (const c of message.tool_calls) {
      if (typeof c.id !== 'string') continue;
      const fname = c.function?.name;
      if (typeof fname !== 'string') continue;
      const fargs = typeof c.function?.arguments === 'string' ? c.function.arguments : '';
      toolCalls.push({
        id: c.id,
        type: 'function',
        function: { name: fname, arguments: fargs },
      });
    }
  }

  let usage: TokenUsage | null = null;
  const rawUsage = obj.usage;
  if (
    rawUsage &&
    typeof rawUsage.prompt_tokens === 'number' &&
    typeof rawUsage.completion_tokens === 'number' &&
    typeof rawUsage.total_tokens === 'number'
  ) {
    usage = {
      prompt_tokens: rawUsage.prompt_tokens,
      completion_tokens: rawUsage.completion_tokens,
      total_tokens: rawUsage.total_tokens,
    };
  }

  const citations: Citation[] = [];
  const rawCitations = obj.venice_parameters?.web_search_citations;
  if (Array.isArray(rawCitations)) {
    rawCitations.forEach((c, i) => {
      if (typeof c !== 'object' || c === null) return;
      const url = typeof c.url === 'string' ? c.url : null;
      if (!url) return;
      const cite: Citation = { index: i + 1, url };
      if (typeof c.title === 'string') cite.title = c.title;
      if (typeof c.content === 'string') cite.content = c.content;
      if (typeof c.date === 'string') cite.date = c.date;
      citations.push(cite);
    });
  }

  const finishReason =
    typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;

  return { text, reasoning, toolCalls, usage, citations, finishReason };
}
