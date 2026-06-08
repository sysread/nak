/**
 * Venice.ai API client - the browser-side Venice wire-shape facade.
 *
 * The Venice API key is project-global and held server-side in
 * `app_config`; browsers never see it. Every chat and embedding call
 * is routed through the venice edge function, which reads the shared
 * key, talks to Venice, and relays the response. This file's job
 * shrinks to:
 *
 *   - Owning the wire-shape types (`VeniceMessage`, `ChatRequest`,
 *     `StreamEvent`, `Citation`, `TokenUsage`, etc.) that both the
 *     browser and the function-side `_shared/venice-stream.ts` agree
 *     on.
 *   - Building Venice request bodies via {@link buildChatBody}, used
 *     by `streamChat` AND by `SupabaseService.complete` (so the
 *     streaming and one-shot paths can't drift on what they send to
 *     the function).
 *   - {@link VeniceClient.streamChat} - the streaming entry point.
 *     POSTs to the venice edge function's `/stream` route with a
 *     thread + anchor-message context, subscribes to the
 *     `thread:<id>:stream` Broadcast channel, and yields a typed
 *     `StreamEvent` union. The function owns the round chain, tool
 *     dispatch, persistence, retry/output-guard logic - this client
 *     just translates events into UI handler calls. See
 *     `docs/dev/architecture.md` and `supabase/functions/README.md`
 *     for the full split.
 *
 * Non-streaming callers (background agents, sub-agents, headless
 * tool loops, web_search / research_docs / analyze_image sub-calls)
 * go through `SupabaseService.complete` which posts the same wire
 * body to the venice/complete route. The 429 retry loop for that
 * path lives in `SupabaseService.complete` itself; this file owns
 * only the streaming surface.
 *
 * Test-only escape hatch: `streamChatDirect` is retained as a
 * compatibility seam for streaming tests that want to drive a fake
 * `fetch` directly without standing up a full function harness.
 * Production callers never reach it - the public `streamChat` always
 * goes through the function when `supabase` is supplied (which the
 * VeniceClient constructor in `state.svelte.ts` always does).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReasoningEffort, Verbosity } from './models';
import type { OpenAIToolDef, OpenAIToolCall } from './tools/types';
// Re-export so callers consuming a ChatCompletion (ChatCompletion.toolCalls
// is OpenAIToolCall[]) can pull the type from the same module without
// reaching into ./tools/types.
export type { OpenAIToolCall };
import { createLogger } from './logger.svelte';
import {
  controlChannelName,
  streamChannelName,
  type TerminalKind,
  type ToolCallRequest,
  type VeniceErrorKind as SharedVeniceErrorKind,
} from '$shared/venice-stream';

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
  /**
   * Conversation history sent to the model. Last message MUST be
   * role `'user'` (or `'tool'` immediately following an assistant
   * `tool_calls` row). Do NOT end with role `'assistant'` thinking
   * the model will continue or replace it - on the fast tier
   * (GLM-4.7 via Venice) that shape made the model echo the system
   * prompt body verbatim as its `content`, persisting the prompt
   * into a synthesis field instead of producing a synthesis. See
   * src/lib/intuition/pipeline.ts stage 3 for the live regression
   * and the conventional shape that fixed it; if you need to feed
   * the model "prior internal voices" content, fold it into the
   * user turn rather than passing it as an assistant message.
   */
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
   * answer body. Like `webSearch`, only the `web_search` tool's
   * sub-completion sets this.
   */
  webCitations?: boolean;
  /**
   * Whether to set `venice_parameters.enable_web_scraping` on the
   * request. When true, Venice fetches (via Firecrawl) any URL the
   * latest user message contains and inlines the page content into
   * the user turn before the model sees it. Independent of
   * `webSearch` per Venice's docs.
   *
   * Caller scoping: the main chat loop deliberately leaves this
   * unset. Auto-inlining scraped content into the user turn would
   * make it hard for the model to tell its own anchor (the user's
   * actual words) from platform-injected reference material, and
   * would make URL handling implicit rather than tool-driven. The
   * sole caller that sets this is the `web_search` tool's
   * sub-completion - a research query that passes a URL through
   * lets the sub-agent read the page. The main turn routes URL
   * handling through the `web_search` tool explicitly instead.
   */
  webScraping?: boolean;
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
  /**
   * Venice-specific `venice_parameters.disable_thinking` knob. When
   * true, the model skips its reasoning pass entirely - no
   * `reasoning_content` tokens, no chain-of-thought eating into the
   * response budget. Useful for sub-completions where the task is
   * bounded synthesis and the upstream model is a reasoning model
   * (e.g. GLM-4.7) whose default behavior is to spend its first few
   * hundred tokens on CoT before writing any user-visible text.
   * Concretely, the `web_search` tool sets this so its 2-4 sentence
   * answer always lands inside the `maxTokens` cap rather than
   * getting truncated by an internal deliberation tangent.
   *
   * Only forwarded when set, same discipline as `reasoningEffort` -
   * Venice's own default is "thinking enabled when the model
   * supports it", and providers that don't recognise the parameter
   * never see it. Distinct from `reasoningEffort: 'low'`, which
   * shrinks the CoT but doesn't disable it; `disableThinking` is the
   * full off switch.
   */
  disableThinking?: boolean;
  /**
   * Routing context for `streamChat`. When set, the call POSTs to
   * the venice/stream edge function with these identifiers and
   * consumes the round chain via a Realtime Broadcast subscription
   * (the function-owned streaming path). The fields together
   * identify the thread + anchor user message the function should
   * respond to. Required for the main chat path; absent on
   * sub-completion callers that go through the non-streaming
   * /complete route via `SupabaseService.complete` (these never
   * hit streamChat).
   */
  streamCtx?: {
    threadId: string;
    userMessageId: string;
  };
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
  | { type: 'citations'; citations: Citation[] }
  /**
   * Round-boundary marker: the function committed a non-terminal
   * round's assistant-with-tool-calls row (`id`). The chat-loop treats
   * this as a per-round onAssistantPersisted - reset the live streaming
   * buffers so the next round starts clean and hand off rendering to the
   * persisted row. Without it the buffers accumulate every round's
   * deltas into one bubble that duplicates the per-round cards. The
   * terminal round is signaled by `end`, not this event.
   */
  | { type: 'round_committed'; id: string }
  // Server-driven events from the function-side round chain. The
  // Broadcast channel publishes the wire shape from
  // $shared/venice-stream and we translate to these for the browser
  // chat-loop's consumer. tool_call_response is the server-emitted
  // pairing for each tool_call_request - chat-loop fires its
  // onToolDone handler off this rather than executing tools itself.
  // end is the terminal marker; rate_limit_* and guard_retry are UI
  // affordance signals.
  | {
      type: 'tool_call_response';
      id: string;
      name: string;
      /**
       * True when the dispatcher returned a non-error outcome. The
       * persisted tool-result row carries the same signal in its
       * content shape, but it travels via the separate messages
       * subscription with its own propagation latency - this flag
       * lets the chat-loop set per-call timing state (success vs
       * error) the instant the wire event arrives, so the in-card
       * status icon stays correct while the row catches up. Default
       * `true` for older server builds that don't publish the field.
       */
      ok: boolean;
      /** ~200-char preview of the tool result; the full payload is on the tool-result row. */
      resultSummary: string;
    }
  | {
      type: 'rate_limit_wait';
      retryAfterMs: number;
      attempt: number;
      /** ISO 8601 wall-clock time the function intends to retry at. */
      until: string;
    }
  | { type: 'rate_limit_resolved' }
  | { type: 'guard_retry'; reason: string }
  /**
   * Transport-layer retry signal. The function's withRateLimitRetry
   * caught a truncated SSE stream (reader closed without `[DONE]`,
   * no actionable tool calls) and is re-issuing the same body.
   * Browser handlers reset their accumulators (streamingText,
   * streamingReasoning) so the new attempt's content lands clean.
   * Distinct from `guard_retry` because no output guard fired and
   * no slop-notice card should surface - this is a silent recovery.
   */
  | { type: 'stream_retry'; reason: 'truncated'; attempt: number }
  | {
      type: 'error';
      kind: SharedVeniceErrorKind;
      message: string;
      retryable: boolean;
    }
  | {
      type: 'end';
      /** assistant row id the server committed to a terminal state. */
      persistedAssistantId: string;
      terminalKind: TerminalKind;
      /**
       * Rounds the orchestrator entered this turn. Mirrors the field
       * on the server-side END event; consumers drive exchange-level
       * metrics off it and use it to confirm the round-limit terminal
       * actually ran the full MAX_ROUNDS budget.
       */
      roundsRun: number;
      conflict?: string;
    };

/**
 * Result returned by `SupabaseService.complete` (the non-streaming
 * chat-completion path through the venice/complete edge function).
 * The POST gives us everything in one shot, so the shape is a flat
 * record rather than a stream of events. Mirrors
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

/**
 * Request shape for `POST /image/generate`. `model` and `prompt` are
 * required; everything else is optional and only sent when supplied,
 * matching the wire-discipline used by buildChatBody. Dimensions are
 * pixel-based (width/height) because the default model is
 * pixel-dimensioned; the generate_image tool maps user-facing aspect
 * ratios to width/height pairs before calling.
 *
 * Docs: https://docs.venice.ai/api-reference/endpoint/image/generate
 */
export interface ImageGenRequest {
  model: string;
  prompt: string;
  negativePrompt?: string;
  stylePreset?: string;
  /** Pixel width, 1-1280 for venice-sd35. */
  width?: number;
  /** Pixel height, 1-1280 for venice-sd35. */
  height?: number;
  seed?: number;
  steps?: number;
  cfgScale?: number;
  /** Blur adult content. Defaults to true (mirrors Venice's default). */
  safeMode?: boolean;
  /**
   * Suppress the Venice watermark on the returned image. Sent only when
   * set; Venice defaults to a watermarked image, and may ignore the
   * request on plans that force the watermark.
   */
  hideWatermark?: boolean;
  format?: 'webp' | 'png' | 'jpeg';
  signal?: AbortSignal;
}

export interface ImageGenResult {
  /** Base64-encoded image bytes, no `data:` prefix. */
  imageBase64: string;
  /** MIME type derived from the requested format, e.g. `image/webp`. */
  mimeType: string;
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
  /**
   * Milliseconds the caller should wait before retrying. Populated only
   * for kind === 'rate_limit', from Venice's Retry-After header (per
   * https://docs.venice.ai/api-reference/rate-limiting#response-headers)
   * and falls back to the soonest x-ratelimit-reset-{requests,tokens}
   * window. Null when no header was present or parseable - callers
   * should pick their own backoff in that case.
   */
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    kind: VeniceError['kind'],
    status: number | null = null,
    retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = 'VeniceError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse Venice's rate-limit hint headers into a wait duration in
 * milliseconds. Preference order:
 *   1. Retry-After - the canonical 429 header. Per RFC 7231 section
 *      7.1.3 it can be either an HTTP-date or a delta-seconds integer.
 *      Venice currently sends seconds, but we accept both shapes so a
 *      future switch on their end doesn't break this path.
 *   2. x-ratelimit-reset-requests / x-ratelimit-reset-tokens - present
 *      on every Venice response (not just 429s). When 429 fires
 *      without a Retry-After we fall back to the soonest of these
 *      two windows. Documented as seconds-until-reset.
 * Returns null when none of the headers are present or parseable;
 * callers fall back to their own backoff schedule in that case.
 */
function parseRetryAfterMs(headers: Headers): number | null {
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

export interface VeniceClientOptions {
  /**
   * Optional Venice API key. Production callers leave this unset -
   * `streamChat` routes through the venice edge function which reads
   * the shared key from `app_config` server-side, so no key lives
   * in the browser bundle. The test-only `streamChatDirect` path
   * is the only consumer that pairs with a set `apiKey`; it
   * exists so streaming tests can drive a fake fetch without
   * standing up a full function harness.
   */
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Supabase client used to route streaming chat through the venice
   * edge function (POST /venice/stream + Broadcast subscription).
   * Production callers always supply this; tests that drive the
   * direct-Venice path omit it.
   */
  supabase?: SupabaseClient;
}

/**
 * Build the JSON body for a Venice `/chat/completions` request. The
 * `streaming` arg toggles the `stream` / `stream_options` fields and
 * the `include_search_results_in_stream` venice_parameter - everything
 * else (tools, reasoning, verbosity, response_format, web search,
 * scraping, the system-prompt opt-out) lands on both paths identically.
 * Centralising the build means a wire-shape change can't accidentally
 * land on one path and not the other.
 *
 * Exported as a free function so SupabaseService.complete can build the
 * same Venice wire shape and send it through the function as a thin
 * proxy - the body-shaping stays on the browser side rather than being
 * duplicated into a Deno helper, so the streaming and one-shot paths
 * keep using the same wire-shape builder.
 */
export function buildChatBody(req: ChatRequest, streaming: boolean): Record<string, unknown> {
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
    // indicator - a silently-unsupported provider just yields no
    // usage event and the indicator stays hidden. Non-streaming
    // responses always carry `usage` at the top level so this flag
    // is meaningless on the /complete path.
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
  // Same discipline for text.verbosity - only forward when the
  // caller opted in, and nest under `text` to match the OpenAI
  // spec shape. Providers that don't recognize the field silently
  // ignore it; ones that 400 on unknown params never see it.
  if (req.verbosity) {
    body.text = { verbosity: req.verbosity };
  }
  // Same discipline for response_format - only forwarded when the
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
  // `enable_web_citations` so sourced claims come back marked up -
  // without that flag Venice merges the fetched content into the
  // answer but strips the attribution. Citations are meaningless
  // when search is 'off', so we omit that field in that case.
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
  // `buildSystemPrompt()` output and can drag responses back toward
  // the diplomatic / comfort-first tone our Voice block is
  // specifically pushing away from. Nak's baseline system prompt
  // is intentional and covers identity, tool framing, and voice on
  // its own - Venice's prefix is redundant at best and counter-
  // productive at worst. The flag is `include_venice_system_prompt`;
  // it defaults to true server-side, so we have to explicitly opt
  // out.
  //
  // Applies to every chat-completion call (main chat + all sub-
  // agents - recall, conversation_recall, reflection, summary,
  // auto-title, samskara, intuition, the web_search /
  // research_docs / analyze_image tools). Each of those prompts is
  // self-sufficient; none of them benefit from a Venice generic
  // preamble landing on top.
  //
  // `enable_web_scraping` (caller-gated, off by default): tells
  // Venice to fetch the full content of any URL the user pastes
  // into their latest message, via Firecrawl on Venice's side.
  // Independent of `enable_web_search` per Venice's docs - search
  // augments the turn with results from a query, scraping reads
  // URLs the user explicitly provided. The main chat loop leaves
  // this unset: implicit URL-inlining makes it hard for the model
  // to tell its own anchor (the user's actual typed words) apart
  // from platform-injected reference material, and forces
  // structural workarounds (`<user_message>` fences, attribution
  // guards in the system prompt) just to keep the boundary
  // legible. URL handling routes through the `web_search` tool,
  // which sets `webScraping: true` on its sub-completion so a
  // research query that quotes a URL can pull the page content
  // as part of resolving the query.
  const veniceParams: Record<string, unknown> = {
    include_venice_system_prompt: false,
  };
  if (req.webScraping) {
    veniceParams.enable_web_scraping = true;
  }
  // Venice-specific reasoning kill switch. Only forwarded when the
  // caller explicitly opted in; an unset field leaves Venice's
  // server-side default ("thinking on" for reasoning models) in
  // place. The web_search tool flips this on because the fast tier
  // currently routes to a reasoning model whose CoT preamble would
  // otherwise eat the entire `maxTokens` cap before the model emits
  // a single character of answer text.
  if (req.disableThinking) {
    veniceParams.disable_thinking = true;
  }
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

export class VeniceClient {
  /**
   * Direct-Venice key. Null in production - the streaming-root
   * function reads the shared key from app_config server-side, so the
   * browser never sees it. Non-null only when tests construct the
   * client to exercise streamChatDirect against a stubbed fetch.
   */
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private supabase: SupabaseClient | null;

  constructor(opts: VeniceClientOptions = {}) {
    this.apiKey = opts.apiKey ?? null;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.supabase = opts.supabase ?? null;
  }

  /**
   * Attach a Supabase client after construction. State init creates
   * the venice client before the supabase client is ready, so this
   * lets the main chat path opt into streaming-root once both are
   * available without ripping up the init ordering.
   */
  setSupabase(client: SupabaseClient): void {
    this.supabase = client;
  }

  private headers(): Record<string, string> {
    if (this.apiKey === null) {
      throw new VeniceError(
        'VeniceClient has no apiKey - direct-Venice path is unavailable. Use streamChat with streamCtx + supabase instead.',
        'auth',
      );
    }
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
        res.status,
        parseRetryAfterMs(res.headers)
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
   *
   * Two transport paths:
   *
   *   1. Streaming-root (preferred). When `req.streamCtx` is set and
   *      the venice client has a Supabase client attached, this POSTs
   *      to the venice edge function's /stream route, subscribes to
   *      the returned Broadcast channel, and yields events as the
   *      server-side orchestrator (getStreamingResponse) publishes
   *      them. The function owns the round chain, tool dispatch,
   *      rate-limit retry, output guards, and assistant-row commit;
   *      the browser is a pure observer. This is the load-bearing
   *      path that lets the assistant turn survive browser disconnect
   *      on mobile PWAs.
   *
   *   2. Direct Venice (legacy fallback). When streamCtx is absent,
   *      this opens fetch directly to Venice /chat/completions and
   *      parses SSE in-process. Kept for test ergonomics and any
   *      caller wired before the supabase client lands.
   *
   * Used only by the main user-facing chat loop. Background callers
   * go through `SupabaseService.complete` (the non-streaming
   * venice/complete edge function).
   */
  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    if (req.streamCtx && this.supabase) {
      yield* streamChatViaFunction(this.supabase, req, req.streamCtx);
      return;
    }
    yield* this.streamChatDirect(req);
  }

  private async *streamChatDirect(
    req: ChatRequest,
  ): AsyncGenerator<StreamEvent, void, void> {
    const body = buildChatBody(req, true);
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
          // `finish_reason` is informational: the usage epilogue
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
      //
      // Exception: a user-initiated abort (stop button, or aborting
      // the in-flight stream to retry a response) rejects read() with
      // an AbortError ("BodyStreamBuffer was aborted"). That's the
      // expected outcome of a cancel, not a failure - chat-loop's
      // AbortError branch swallows it downstream - so don't log it as
      // an error. Rethrow regardless so that branch still fires.
      const isAbort =
        req.signal?.aborted === true ||
        (err instanceof Error && err.name === 'AbortError');
      if (!isAbort) log.error('streamChat SSE loop failed', err);
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

}

// ---------------------------------------------------------------------------
// Streaming-root transport.
//
// Routes the browser's streamChat call through the venice edge
// function's /stream route + a Supabase Realtime Broadcast channel.
// All the round-internal work (Venice fetch, rate-limit retry, output
// guards, tool dispatch, assistant-row commit) lives server-side; the
// browser is a pure event consumer.
// ---------------------------------------------------------------------------

/**
 * The live Broadcast channel dropped AFTER a successful subscribe, mid-
 * turn. Distinct from a turn failure: the edge-function orchestrator
 * runs detached (EdgeRuntime.waitUntil) and is unaffected by the
 * browser losing its socket, so the turn is still running (or already
 * committed) server-side - its outcome lives on the DB row. Broadcast
 * events are ephemeral with no replay, so the single END that closes
 * the stream may have fired into the dead socket; the consumer can no
 * longer trust the live path and must reconcile against the row.
 *
 * Thrown by the drain (not yielded) so the for-await consumer in
 * chat-loop.ts surfaces it as an exception, and Chat.svelte's
 * runExchange catch can route it into the poll-the-row reconnect
 * (`reconnectInflightTurn`) instead of the generic "response was cut
 * off" banner. NOT a VeniceError subclass on purpose: the existing
 * `instanceof VeniceError` rate-limit / kind checks must not match it.
 */
export class StreamDisconnectedError extends Error {
  constructor(message = 'live stream channel disconnected mid-turn') {
    super(message);
    this.name = 'StreamDisconnectedError';
  }
}

interface StreamEnvelope {
  channelName: string;
  assistantRowId: string | null;
  completedSoFar: string;
  noStreamInFlight?: boolean;
}

async function* streamChatViaFunction(
  supabase: SupabaseClient,
  req: ChatRequest,
  ctx: NonNullable<ChatRequest['streamCtx']>,
): AsyncGenerator<StreamEvent, void, void> {
  // Build the Venice wire body once and ship as the orchestrator's
  // bodyTemplate. The function copies and mutates only `messages`
  // between rounds; everything else (model, venice_parameters, tools)
  // rides untouched.
  const body = buildChatBody(req, true);

  // Pre-subscribe to the stream channel BEFORE POSTing /stream. The
  // function publishes the first broadcasts (typically reasoning_text
  // for reasoning models, which often arrives within ~100ms of the
  // Venice connection opening) as soon as the waitUntil-anchored
  // orchestrator gets its first SSE delta. If we subscribed AFTER the
  // POST returned, the Realtime subscribe round-trip (~200-500ms) and
  // the function's startup could race, and the first reasoning
  // chunks would broadcast into nothing because no subscriber was
  // listening yet. Text events have a replay buffer via
  // `envelope.completedSoFar` (the function persists content
  // progressively to the streaming row); reasoning has no such
  // buffer, so the leading reasoning fragment would silently
  // disappear from the user's screen and from any device that
  // observed only the live stream. The deterministic channel name
  // (streamChannelName(threadId)) lets us subscribe before the
  // envelope is in hand. The post-subscribe completedSoFar drain
  // still fires below for text - which is correct: any text that
  // landed before we subscribed is already in the row, and the
  // envelope returns it.
  const channelName = streamChannelName(ctx.threadId);
  const subscription = setupStreamSubscription(supabase, channelName);
  await subscription.subscribed;

  try {
    // Envelope POST. functions.invoke wraps the bearer token from
    // the signed-in session so the edge function's verify_jwt
    // accepts the call and the userIdFromJwt helper can read the
    // sub claim.
    const { data, error } = await supabase.functions.invoke<StreamEnvelope>(
      'venice/stream',
      {
        body: {
          threadId: ctx.threadId,
          userMessageId: ctx.userMessageId,
          body,
        },
      },
    );
    if (error) {
      throw new VeniceError(
        `/stream invoke failed: ${error.message}`,
        'http',
      );
    }
    if (!data) {
      throw new VeniceError('/stream returned no envelope', 'parse');
    }

    yield* subscription.drain(data, req.signal);
  } finally {
    await subscription.unsubscribe();
  }
}

// Reconnect poll cadence. We re-probe /stream reconnectOnly on this
// interval while a turn we re-attached to is still in flight. Snappy
// enough that a turn finishing feels responsive; slow enough that a
// long generation costs only a handful of probes.
const RECONNECT_POLL_INTERVAL_MS = 2_500;

// Hard ceiling on the reconnect poll. The server-side stale-row janitor
// (in the /stream handler) flips an orphaned streaming row to 'error'
// once it ages past ~760s, after which the probe reports
// noStreamInFlight, so the poll terminates on its own in every normal
// case. This ceiling is the backstop for the pathological case where
// the probe ITSELF keeps failing (persistent offline): past it we stop
// polling and let the caller render whatever the row currently holds.
const RECONNECT_POLL_MAX_WAIT_MS = 800_000;

export interface AwaitStreamSettledOpts {
  signal?: AbortSignal;
  /** Poll cadence override (tests). Defaults to RECONNECT_POLL_INTERVAL_MS. */
  intervalMs?: number;
  /** Ceiling override (tests). Defaults to RECONNECT_POLL_MAX_WAIT_MS. */
  maxWaitMs?: number;
  /**
   * Called after each still-in-flight probe with the row's
   * completed-so-far content (the function persists it progressively to
   * the streaming row). Lets a caller paint the partial reply under the
   * reconnecting throbber. Not called once the turn has settled.
   */
  onProgress?(completedSoFar: string): void;
}

/**
 * Re-attach to a turn that was already in flight when this tab last had
 * it, by POLLING the row to a terminal state rather than resuming the
 * live Broadcast stream.
 *
 * Why poll, not re-subscribe: Broadcast events are ephemeral - there is
 * no replay. A tab that was backgrounded (mobile PWA, often discarded)
 * or reloaded missed whatever the function published while it was gone,
 * INCLUDING the single END event that signals completion. Re-subscribing
 * only catches events published from that point on, so if the turn
 * finished (or finishes) during the realtime gap the consumer either
 * waits forever for an END that already fired or surfaces a spurious
 * channel error - the two failure cards this path used to produce. The
 * DB row is the canonical record; its status reaching a terminal value
 * is the reliable "done" signal, and incremental content UPDATEs mean we
 * can still show the partial.
 *
 * Mechanic: POST /stream reconnectOnly on an interval. The handler
 * returns an in-flight envelope while a status='streaming' row exists,
 * or noStreamInFlight once the row has committed to a terminal status
 * (or the stale janitor swept it). Resolve when noStreamInFlight; the
 * caller then re-fetches the thread and renders the terminal rows.
 * Resolves (never rejects) on abort or the max-wait ceiling so the
 * caller's cleanup always runs. Transient invoke failures are swallowed
 * and retried - resilience to a flaky connection is the entire point.
 */
export async function awaitStreamSettled(
  supabase: SupabaseClient,
  ctx: { threadId: string },
  opts: AwaitStreamSettledOpts = {},
): Promise<void> {
  const interval = opts.intervalMs ?? RECONNECT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts.maxWaitMs ?? RECONNECT_POLL_MAX_WAIT_MS);
  const { signal, onProgress } = opts;

  for (;;) {
    if (signal?.aborted) return;
    let envelope: StreamEnvelope | null = null;
    try {
      const { data, error } = await supabase.functions.invoke<StreamEnvelope>(
        'venice/stream',
        { body: { threadId: ctx.threadId, reconnectOnly: true } },
      );
      if (!error && data) envelope = data;
    } catch {
      // Transient invoke failure (mobile radio waking on foreground,
      // edge cold start). Swallow and retry on the next tick; the
      // deadline below guarantees we don't spin forever.
    }
    if (signal?.aborted) return;
    if (envelope?.noStreamInFlight) return;
    if (envelope) onProgress?.(envelope.completedSoFar);
    if (Date.now() >= deadline) return;

    const aborted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(false);
      }, interval);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    if (aborted) return;
  }
}

/**
 * Per-channel handle owned by a single stream consumer. Use
 * `setupStreamSubscription` to construct one. The shape lets the
 * subscribe step happen BEFORE the POST that triggers broadcasts
 * (`streamChatViaFunction` subscribes first so the function's opening
 * reasoning frames - which have no replay buffer - aren't published
 * into a void).
 *
 *   - `subscribed`: resolves once the channel has reached SUBSCRIBED.
 *     Reject on CHANNEL_ERROR / TIMED_OUT. The subscribe() call has
 *     already been made by setupStreamSubscription; this is just an
 *     awaitable for the status.
 *   - `drain(envelope, signal)`: yields the StreamEvent stream the
 *     channel produces, drained from the internal queue. Yields the
 *     envelope's noStreamInFlight short-circuit first when set, or
 *     the completedSoFar text replay otherwise. Honours the abort
 *     signal by closing the queue.
 *   - `unsubscribe()`: best-effort channel teardown. Idempotent.
 */
interface StreamSubscription {
  readonly subscribed: Promise<void>;
  drain(
    envelope: StreamEnvelope,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamEvent, void, void>;
  unsubscribe(): Promise<void>;
}

function setupStreamSubscription(
  supabase: SupabaseClient,
  channelName: string,
): StreamSubscription {
  // Channel subscribe. private:true engages the realtime.messages RLS
  // policies in supabase/schema.sql that gate this topic to the
  // thread owner. The function (service_role) is what publishes on
  // the other side.
  const channel = supabase.channel(channelName, {
    config: { private: true },
  });

  // Producer queue. The Broadcast callbacks fire on a microtask
  // outside the for-await consumer's frame; we buffer events here and
  // resolve the awaiting consumer when one arrives.
  const queue: StreamEvent[] = [];
  let resolveNext: ((ev: StreamEvent | null) => void) | null = null;
  let closed = false;
  // Set when the channel reports a failure status AFTER a successful
  // subscribe (socket loss while backgrounded, a transient network
  // blip). Drives the drain's post-loop throw so a mid-turn drop
  // surfaces as a StreamDisconnectedError rather than a silent hang.
  let disconnected = false;

  function push(ev: StreamEvent): void {
    if (closed) return;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(ev);
    } else {
      queue.push(ev);
    }
  }

  function close(): void {
    closed = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(null);
    }
  }

  // Map each Broadcast event name onto the legacy StreamEvent shape
  // the chat-loop already understands, plus the new variants
  // (tool_call_response, rate_limit_*, guard_retry, error, end). The
  // server publishes the wire shape from $shared/venice-stream.
  channel.on('broadcast', { event: 'response_text' }, ({ payload }) => {
    const p = payload as { content?: string };
    if (typeof p.content === 'string' && p.content.length > 0) {
      push({ type: 'text', delta: p.content });
    }
  });
  channel.on('broadcast', { event: 'reasoning_text' }, ({ payload }) => {
    const p = payload as { content?: string };
    if (typeof p.content === 'string' && p.content.length > 0) {
      push({ type: 'reasoning', delta: p.content });
    }
  });
  channel.on('broadcast', { event: 'tool_call_request' }, ({ payload }) => {
    const p = payload as { request?: { id?: string; name?: string; args?: unknown } };
    const r = p.request;
    if (!r || typeof r.id !== 'string' || typeof r.name !== 'string') return;
    let args: string;
    try {
      args = JSON.stringify(r.args ?? {});
    } catch {
      args = '{}';
    }
    push({
      type: 'tool_call',
      toolCall: {
        id: r.id,
        type: 'function',
        function: { name: r.name, arguments: args },
      },
    });
  });
  channel.on('broadcast', { event: 'tool_call_response' }, ({ payload }) => {
    const p = payload as { id?: string; name?: string; ok?: boolean; result_summary?: string };
    if (typeof p.id !== 'string' || typeof p.name !== 'string') return;
    push({
      type: 'tool_call_response',
      id: p.id,
      name: p.name,
      // Default true when an older server omitted the field: the
      // wire shape stays backwards compatible and the consumer
      // falls back to "trust the persisted row" semantics for
      // pre-ok-field builds.
      ok: typeof p.ok === 'boolean' ? p.ok : true,
      resultSummary: typeof p.result_summary === 'string' ? p.result_summary : '',
    });
  });
  channel.on('broadcast', { event: 'usage' }, ({ payload }) => {
    const p = payload as { usage?: TokenUsage };
    if (p.usage) push({ type: 'usage', usage: p.usage });
  });
  channel.on('broadcast', { event: 'citations' }, ({ payload }) => {
    const p = payload as { citations?: Citation[] };
    if (Array.isArray(p.citations) && p.citations.length > 0) {
      push({ type: 'citations', citations: p.citations });
    }
  });
  channel.on('broadcast', { event: 'rate_limit_wait' }, ({ payload }) => {
    const p = payload as {
      retryAfterMs?: number;
      attempt?: number;
      until?: string;
    };
    if (
      typeof p.retryAfterMs === 'number' &&
      typeof p.attempt === 'number' &&
      typeof p.until === 'string'
    ) {
      push({
        type: 'rate_limit_wait',
        retryAfterMs: p.retryAfterMs,
        attempt: p.attempt,
        until: p.until,
      });
    }
  });
  channel.on('broadcast', { event: 'rate_limit_resolved' }, () => {
    push({ type: 'rate_limit_resolved' });
  });
  channel.on('broadcast', { event: 'guard_retry' }, ({ payload }) => {
    const p = payload as { reason?: string };
    push({ type: 'guard_retry', reason: typeof p.reason === 'string' ? p.reason : '' });
  });
  channel.on('broadcast', { event: 'stream_retry' }, ({ payload }) => {
    const p = payload as { reason?: string; attempt?: number };
    // Only one reason in v1 (`truncated`); the server enforces it.
    // Drop the event if the wire shape skews so we don't surface a
    // bogus reset to the consumer.
    if (p.reason !== 'truncated') return;
    const attempt = typeof p.attempt === 'number' ? p.attempt : 1;
    push({ type: 'stream_retry', reason: 'truncated', attempt });
  });
  channel.on('broadcast', { event: 'error' }, ({ payload }) => {
    const p = payload as {
      kind?: SharedVeniceErrorKind;
      message?: string;
      retryable?: boolean;
    };
    push({
      type: 'error',
      kind: p.kind ?? 'internal',
      message: typeof p.message === 'string' ? p.message : 'stream error',
      retryable: p.retryable === true,
    });
    close();
  });
  channel.on('broadcast', { event: 'assistant_round_committed' }, ({ payload }) => {
    const p = payload as { id?: string };
    if (typeof p.id === 'string' && p.id.length > 0) {
      push({ type: 'round_committed', id: p.id });
    }
  });
  channel.on('broadcast', { event: 'END' }, ({ payload }) => {
    const p = payload as {
      persistedAssistantId?: string;
      terminalKind?: TerminalKind;
      roundsRun?: number;
      conflict?: string;
    };
    push({
      type: 'end',
      persistedAssistantId:
        typeof p.persistedAssistantId === 'string' ? p.persistedAssistantId : '',
      terminalKind: p.terminalKind ?? 'completed',
      // Defaults to 0 when an older server (pre-roundsRun field) reaches
      // a newer browser. consumeStreamEvents falls back to the legacy
      // "did anything run" heuristic in that case.
      roundsRun: typeof p.roundsRun === 'number' ? p.roundsRun : 0,
      ...(p.conflict ? { conflict: p.conflict } : {}),
    });
    close();
  });

  // Kick subscribe immediately so callers waiting on `subscribed`
  // get an awaitable that resolves once Realtime confirms.
  //
  // The status callback fires for the WHOLE channel lifetime, not just
  // the initial join: Supabase Realtime re-invokes it on every state
  // transition. We use the first SUBSCRIBED to resolve `subscribed`,
  // then keep listening so a LATER failure (the socket falling over
  // mid-turn) flips `disconnected` and closes the drain. Without this
  // the drain would await an event - including the terminal END - that
  // can never arrive on a dead channel, hanging the turn forever.
  let hasSubscribed = false;
  const subscribed = new Promise<void>((resolve, reject) => {
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        hasSubscribed = true;
        resolve();
        return;
      }
      if (
        status === 'CHANNEL_ERROR' ||
        status === 'TIMED_OUT' ||
        status === 'CLOSED'
      ) {
        if (!hasSubscribed) {
          // Initial join never succeeded: reject so the POST path
          // surfaces a normal stream error rather than a disconnect.
          reject(err ?? new Error(`Channel ${status}`));
          return;
        }
        // Our own unsubscribe() drove this CLOSED (it calls close()
        // first, setting `closed`). Not a drop - ignore so a clean
        // end-of-turn teardown isn't mistaken for a disconnect.
        if (closed) return;
        // Post-join drop: hand the turn off to the poll-the-row path.
        disconnected = true;
        close();
      }
    });
  });

  async function* drain(
    envelope: StreamEnvelope,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamEvent, void, void> {
    // Reconnect-only short-circuit: when the envelope reports no
    // in-flight stream, the caller asked us to observe rather than
    // start. Emit a terminal end so the chat-loop's consumer wraps
    // up cleanly without waiting for events that aren't coming.
    if (envelope.noStreamInFlight) {
      yield {
        type: 'end',
        persistedAssistantId: envelope.assistantRowId ?? '',
        terminalKind: 'completed',
        // The function side already returned; we never observed any
        // rounds and don't know the count it ran. 0 is the safe
        // stand-in for reconnect callers that don't branch on the
        // metric.
        roundsRun: 0,
      };
      return;
    }

    // Drain any completedSoFar buffer the envelope surfaced. Text
    // events have this replay path (the function persists content
    // progressively to the streaming row); reasoning does not, which
    // is why streamChatViaFunction now subscribes BEFORE POSTing
    // /stream rather than after, so the function's first reasoning
    // broadcasts land in our queue instead of dropping into the
    // pre-subscribe void.
    if (envelope.completedSoFar.length > 0) {
      yield { type: 'text', delta: envelope.completedSoFar };
    }

    // Wire the caller's AbortSignal to local close.
    // The signal fires when the chat-loop's stop button or a foreign
    // claim's abort propagates here; the FUNCTION continues regardless
    // (cancel is the control-channel publish path, not this signal).
    const onAbort = (): void => close();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      while (true) {
        if (queue.length > 0) {
          const ev = queue.shift();
          if (ev) yield ev;
          continue;
        }
        if (closed) break;
        const next = await new Promise<StreamEvent | null>((r) => {
          resolveNext = r;
        });
        if (next === null) break;
        yield next;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    // Any buffered events have flushed above; only now decide whether
    // the close was a clean end (END / caller abort) or a mid-turn
    // socket drop. A caller abort wins - the user stopped on purpose,
    // and the server publishes its own END(aborted) - so we only throw
    // for a genuine disconnect.
    if (disconnected && !signal?.aborted) {
      throw new StreamDisconnectedError();
    }
  }

  async function unsubscribe(): Promise<void> {
    close();
    try {
      await channel.unsubscribe();
    } catch {
      /* best-effort */
    }
  }

  return { subscribed, drain, unsubscribe };
}

/**
 * Publish a user-initiated cancel on the thread's control channel.
 * The streaming function (which subscribes to this same channel)
 * receives the event and aborts its in-flight Venice fetch + tool
 * calls, then publishes END(aborted) on the stream channel. The
 * browser observes the END event through its existing streamChat
 * consumer.
 *
 * Idempotent: extra cancel publishes are no-ops once the orchestrator
 * has unsubscribed.
 */
export async function cancelStream(
  supabase: SupabaseClient,
  threadId: string,
): Promise<void> {
  const ch = supabase.channel(controlChannelName(threadId), {
    config: { private: true },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ch.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') resolve();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(err ?? new Error(`Cancel channel ${status}`));
        }
      });
    });
    await ch.send({
      type: 'broadcast',
      event: 'cancel',
      payload: { type: 'cancel' },
    });
  } catch (err) {
    log.warn(`cancelStream failed: ${(err as Error).message}`);
  } finally {
    try {
      await ch.unsubscribe();
    } catch {
      /* best-effort */
    }
  }
}

// Suppress unused-name warning on the imported ToolCallRequest type -
// it's intentionally re-exported below for chat-loop consumers that
// want the typed shape from the shared module.
export type { ToolCallRequest };

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
      // Skip empty-string id and name. Venice's continuation
      // fragments carry `id: ""` and `function.name: ""` alongside
      // the real argumentsAppend payload; passing them through would
      // overwrite the assembler's real id/name (set by the opening
      // fragment), which then fails the !entry.id check at flush and
      // drops the call as "missing id".
      if (typeof c.id === 'string' && c.id.length > 0) frag.id = c.id;
      const fname = c.function?.name;
      if (typeof fname === 'string' && fname.length > 0) frag.name = fname;
      // argumentsAppend can legitimately be an empty string on the
      // opening fragment; the assembler initialises argumentsBuf=''
      // and only concatenates non-empty appends, so dropping the
      // empty case at the parse layer keeps the shape consistent
      // with continuation frames that omit the field entirely.
      const fargs = c.function?.arguments;
      if (typeof fargs === 'string' && fargs.length > 0) {
        frag.argumentsAppend = fargs;
      }
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
