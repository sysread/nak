// Streaming-root shared module ---------------------------------------------
//
// Wire-shape contract between the Venice SSE consumer
// (getStreamingCompletion), the round-loop orchestrator
// (getStreamingResponse), the Supabase Realtime Broadcast channel that
// carries live events to the browser, and the browser's streamChat
// adapter that materializes them back into slot state.
//
// Lives under supabase/functions/_shared so both sides import the same
// definitions:
//
//   - the Deno edge function imports via a relative .ts path
//     (`import { ... } from '../_shared/venice-stream.ts'`), matching the
//     convention the other _shared/* modules use.
//   - the browser imports via the Vite alias `$shared/venice-stream`,
//     configured in vite.config.ts and tsconfig.json so a wire-shape
//     mismatch fails at compile time, not at runtime in production.
//
// Pure types + pure parsers + a single stateful fragment-assembler class.
// No fetch, no EdgeRuntime, no Supabase client, no Deno globals. Adding
// anything I/O-bound here would couple the browser bundle to the
// function's runtime; that work belongs in the consuming module.

// ---------------------------------------------------------------------------
// Primitive payload shapes the events carry.
// ---------------------------------------------------------------------------

/**
 * One web-search citation as Venice attaches it to a turn. `index` is
 * 1-based and corresponds to the `^N^` superscripts that appear inline
 * in the response text. Optional fields are present when Venice has
 * them and absent otherwise; the parser drops citations with no usable
 * `url` because those render as dead refs in the UI.
 */
export interface VeniceCitation {
  index: number;
  url: string;
  title?: string;
  content?: string;
  date?: string;
}

/**
 * Venice / OpenAI token-usage epilogue. On streaming responses this
 * arrives only when the request opted in via
 * `stream_options: { include_usage: true }`; non-streaming responses
 * always carry it. We accept only fully-formed records (all three
 * fields present) so downstream code can treat the shape as total.
 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * One OpenAI-shaped tool call as it lives on the wire. Mirrors the
 * `messages.tool_calls[]` jsonb shape stored in the DB and the
 * `choices[0].message.tool_calls[]` shape Venice / OpenAI return on
 * non-streaming responses. `function.arguments` is a JSON string the
 * caller is expected to JSON.parse; the streaming path of this file
 * also surfaces a parsed-args variant via `ToolCallRequest`.
 */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * Complete tool-call request emitted by getStreamingCompletion to its
 * consumer. The streaming SSE delivers tool calls in fragments (id +
 * name on one frame, arguments dribbling in over many); the fragment
 * assembler buffers them until a terminal `finish_reason` flushes the
 * accumulated state. By the time a `tool_call_request` reaches a
 * consumer the JSON arguments have been parsed once and the
 * `Record<string, unknown>` is ready to hand to the tool's
 * `execute(args, ctx)`.
 */
export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Error shape carried by `error` stream events.
// ---------------------------------------------------------------------------

/**
 * Closed set of error categories so the browser can branch on the kind
 * without parsing free-form messages. Mirrors the kinds used by the
 * Deno-side VeniceError and the browser's VeniceError - the shared
 * subset is what travels through the streaming event vocabulary.
 *
 *   'rate_limit'  Venice 429. retryAfterMs may be carried alongside on
 *                 stream-signal events; this kind on an `error` event
 *                 means the function gave up after exhausting retries.
 *   'auth'        Venice 401 / 403 - bad or missing key. Fatal; no retry.
 *   'http'        Other non-OK Venice response. Retryable depends on
 *                 the status code; the function decides before emitting.
 *   'network'     Connection / DNS / TLS error contacting Venice.
 *   'parse'       Venice returned 200 but the payload was unreadable
 *                 (truncated SSE frame, malformed JSON).
 *   'internal'    Function-side bug or unexpected state. Always fatal.
 */
export type VeniceErrorKind =
  | 'rate_limit'
  | 'auth'
  | 'http'
  | 'network'
  | 'parse'
  | 'truncated'
  | 'internal';

// ---------------------------------------------------------------------------
// Per-completion event vocabulary.
//
// getStreamingCompletion yields these as its async iterator output. One
// BEGIN and one DONE per logical completion regardless of how many
// internal rate-limit retries or output-guard re-rolls happened - those
// surface separately via StreamSignal events.
// ---------------------------------------------------------------------------

export type CompletionEvent =
  | { type: 'BEGIN' }
  | { type: 'reasoning_text'; content: string }
  | { type: 'response_text'; content: string }
  | { type: 'tool_call_request'; request: ToolCallRequest }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'citations'; citations: VeniceCitation[] }
  | { type: 'DONE'; finishReason: string | null };

// ---------------------------------------------------------------------------
// Stream-level signal events.
//
// Things the consumer cares about that are not about content delivered
// but about the connection itself or a retry the function just
// performed. The browser maps these to UI feedback (rate-limit waiting
// indicator, output-guard retry banner).
// ---------------------------------------------------------------------------

export type StreamSignal =
  | {
      type: 'error';
      kind: VeniceErrorKind;
      message: string;
      retryable: boolean;
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
   * The completion's SSE stream ended without a proper terminal
   * sequence (no `[DONE]` sentinel, reader closed early) AND the
   * tool-call assembler had nothing actionable, so we couldn't tell
   * whether the model intended to keep going. The retry layer is
   * re-issuing the same body; downstream consumers (orchestrator,
   * browser) reset accumulators (content, reasoning, streaming-row
   * UPDATE target) so the new attempt's stream replaces the partial
   * one cleanly. Distinct from `guard_retry` because no output guard
   * fired and no UI affordance (slop-notice card) should surface -
   * this is a silent recovery for a transport-layer cut.
   */
  | { type: 'stream_retry'; reason: 'truncated'; attempt: number };

// ---------------------------------------------------------------------------
// Orchestrator-added events.
//
// getStreamingResponse layers these on top of the completion vocabulary
// before publishing to the Broadcast channel. tool_call_response pairs
// with a prior tool_call_request by id; END is the terminal marker the
// browser keys final-state rendering off of.
// ---------------------------------------------------------------------------

export type TerminalKind =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'suspended_for_ask_user';

export type OrchestratorEvent =
  | {
      type: 'tool_call_response';
      id: string;
      name: string;
      /**
       * True when the dispatcher returned a non-error outcome, false on
       * a thrown / errored tool. The persisted tool-result row carries
       * the same signal in its content shape (an error key means
       * failure), but the row arrives via the separate messages
       * realtime subscription with its own propagation latency - a
       * tool that succeeded on the function side can have its
       * tool_call_response land on the stream channel well before the
       * row's INSERT propagates. Browsers branch off this flag to
       * drive the per-call timing state (success vs error path) so
       * the in-card status icon stays correct in the gap.
       */
      ok: boolean;
      /**
       * Truncated tool result for the streaming UI - the full tool-result
       * row carries the complete payload and the messages subscription
       * delivers it for callers that need more than the summary. Cap
       * around 200 characters; longer results add Broadcast bandwidth
       * without adding what the UI shows.
       */
      result_summary: string;
    }
  | {
      type: 'END';
      persistedAssistantId: string;
      terminalKind: TerminalKind;
      /**
       * Number of rounds the orchestrator started this turn. Counted
       * at the top of each round body so the value reflects "rounds
       * entered" regardless of how that round exited (tool dispatch,
       * suspend, abort, terminal text). Browser uses this to drive
       * exchange-level metrics and to confirm a round-limit terminal
       * actually ran the full MAX_ROUNDS budget.
       */
      roundsRun: number;
      /**
       * Set when the END event needs to carry an additional reason.
       * Two sources today: the commit_assistant_message RPC's conflict
       * column ('newer_user_message', 'anchor_missing', ...), and the
       * synthetic 'round_limit' the orchestrator emits when the round
       * loop exhausts naturally (every round called tools, model never
       * got a terminal text round). Only meaningful when
       * terminalKind === 'error'; absent on the happy commit.
       */
      conflict?: string;
    };

/**
 * Full event union published over the Broadcast channel. Consumers
 * discriminate by `type`. The browser's streamChat re-emits this union
 * to its caller (chat-loop today) as an async iterator;
 * getStreamingResponse publishes via Supabase Realtime's
 * `channel.send({ type: 'broadcast', event: <type>, payload: <event> })`.
 */
export type StreamEvent =
  | CompletionEvent
  | StreamSignal
  | OrchestratorEvent;

// ---------------------------------------------------------------------------
// SSE frame parsing.
//
// Lifted from the browser's parseSseFrame so both sides see the same
// shape. The Deno function uses this to read its Venice upstream; the
// browser keeps using it during the migration for any path still
// consuming Venice SSE directly. Pure: take a frame string, return a
// structured delta (or null for heartbeats / malformed frames, or the
// sentinel '[DONE]' for end-of-stream).
// ---------------------------------------------------------------------------

/**
 * Per-frame partial structure. Multiple fields may be set in a single
 * frame - OpenAI sometimes batches a text delta, a tool-call fragment,
 * and a `finish_reason` into one choice. `null` from parseSseFrame
 * means the frame carried no actionable info (blank, heartbeat,
 * malformed) and should be skipped.
 */
export interface SseDelta {
  text?: string;
  reasoning?: string;
  toolCallFragments?: ToolCallFragment[];
  finishReason?: string;
  usage?: TokenUsage;
  citations?: VeniceCitation[];
}

/**
 * Single tool-call fragment as it appears on the wire. The streaming
 * model emits multiple fragments per tool call: typically one with
 * `id` + `name`, then several with chunks of `argumentsAppend`. The
 * assembler stitches them together by `index`.
 */
export interface ToolCallFragment {
  index: number;
  id?: string;
  name?: string;
  argumentsAppend?: string;
}

/**
 * Parses a single SSE frame. Returns '[DONE]' when the server signals
 * end-of-stream; null when the frame has no usable data (heartbeat,
 * empty delta); otherwise an SseDelta with whichever fields the frame
 * contained. Text and tool-call fragments can both be present in the
 * same frame - the caller handles each independently.
 *
 * Defensive about Venice / OpenAI wire-shape variations: every field
 * we read is checked before use, and a frame whose JSON fails to parse
 * yields null rather than throwing. The streaming consumer treats
 * unreadable frames as transient noise and reads the next one.
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

  // Venice's `web_search_citations` ride at the top level, nested
  // under `venice_parameters` - sibling of `choices` and `usage`, not
  // part of any individual delta. Drop rows with no usable url; they
  // would render as dead refs.
  const rawCitations = obj.venice_parameters?.web_search_citations;
  if (Array.isArray(rawCitations) && rawCitations.length > 0) {
    const citations: VeniceCitation[] = [];
    rawCitations.forEach((c, i) => {
      if (typeof c !== 'object' || c === null) return;
      const url = typeof c.url === 'string' ? c.url : null;
      if (!url) return;
      const cite: VeniceCitation = { index: i + 1, url };
      if (typeof c.title === 'string') cite.title = c.title;
      if (typeof c.content === 'string') cite.content = c.content;
      if (typeof c.date === 'string') cite.date = c.date;
      citations.push(cite);
    });
    if (citations.length > 0) out.citations = citations;
  }

  // Usage epilogue: `choices` is an empty array, `usage` sits at the
  // top level. Only accept fully-formed usage so downstream code can
  // treat TokenUsage as a total record.
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
    // No choice but maybe a usage / citations epilogue - surface that alone.
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
    const frags: ToolCallFragment[] = [];
    for (const c of rawCalls) {
      if (typeof c.index !== 'number') continue;
      const frag: ToolCallFragment = { index: c.index };
      // Skip empty-string id and name. Venice's continuation
      // fragments carry `id: ""` and `function.name: ""` alongside
      // the real argumentsAppend payload; passing them through would
      // overwrite the real id/name the first fragment set, which the
      // assembler then drops as "missing id" at flush.
      if (typeof c.id === 'string' && c.id.length > 0) frag.id = c.id;
      const fname = c.function?.name;
      if (typeof fname === 'string' && fname.length > 0) frag.name = fname;
      // argumentsAppend can legitimately be an empty string on the
      // opening fragment (the model declared the call but hasn't
      // started streaming args yet); only forward it when there's
      // something to append.
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

// ---------------------------------------------------------------------------
// Tool-call fragment assembler.
//
// The streaming wire delivers tool calls in pieces - typically one
// fragment with `id` and `name`, then several with chunks of
// `argumentsAppend`. Consumers want complete `tool_call_request`
// events with parsed args, not the fragment shape. This class buffers
// fragments by `index` until flush() is called (when `finish_reason`
// arrives) and emits a ToolCallRequest for each completed entry.
// ---------------------------------------------------------------------------

interface PendingToolCall {
  id?: string;
  name?: string;
  argumentsBuf: string;
}

/**
 * Stateful per-completion buffer. Caller pushes fragments as they
 * arrive via `ingest(fragments)`, then calls `flush()` once the
 * upstream signaled tool_calls are done (finish_reason='tool_calls'
 * or the SSE [DONE] sentinel). flush() returns the parsed
 * ToolCallRequest list and resets internal state so the same instance
 * can be reused across subsequent rounds inside one
 * getStreamingCompletion call.
 *
 * Args parsing failures are surfaced as part of the returned tuple
 * shape so the caller can decide whether to drop the call, send a
 * synthetic error to the model, or surface it to the user. The
 * assembler itself never throws - it carries forward whatever
 * fragments arrived, even if they look broken, so a partial tool
 * call does not silently disappear.
 */
export class ToolCallAssembler {
  private readonly pending = new Map<number, PendingToolCall>();

  /**
   * Merge a frame's worth of fragments into the buffer. Cheap; the
   * caller can invoke this on every SSE delta.
   */
  ingest(fragments: ToolCallFragment[]): void {
    for (const frag of fragments) {
      let entry = this.pending.get(frag.index);
      if (!entry) {
        entry = { argumentsBuf: '' };
        this.pending.set(frag.index, entry);
      }
      if (frag.id !== undefined) entry.id = frag.id;
      if (frag.name !== undefined) entry.name = frag.name;
      if (frag.argumentsAppend !== undefined) {
        entry.argumentsBuf += frag.argumentsAppend;
      }
    }
  }

  /**
   * True when at least one fragment has been ingested since the last
   * flush. The orchestrator uses this to decide whether to expect any
   * tool calls on `finish_reason='tool_calls'`.
   */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Drain the buffer into complete ToolCallRequest objects, in index
   * order. Entries with no id or no name are dropped (the model
   * emitted a tool-call fragment without a callable identity, which
   * Venice / OpenAI shouldn't do but a wire-shape drift could
   * produce). Entries whose argumentsBuf isn't valid JSON are dropped
   * the same way - a tool dispatched with `args: undefined` would
   * crash inside its execute() handler.
   *
   * Side effect: clears the internal map, so a second flush() returns
   * an empty array. This is intentional: the assembler is reused
   * across rounds inside one getStreamingCompletion invocation, and
   * each round needs a fresh start.
   *
   * Returns a tuple of [requests, dropped] so the caller can log or
   * surface dropped fragments. In v1 we just log and keep going.
   */
  flush(): {
    requests: ToolCallRequest[];
    dropped: Array<{ index: number; reason: string }>;
  } {
    const requests: ToolCallRequest[] = [];
    const dropped: Array<{ index: number; reason: string }> = [];
    const indices = Array.from(this.pending.keys()).sort((a, b) => a - b);
    for (const idx of indices) {
      const entry = this.pending.get(idx);
      if (!entry) continue;
      if (!entry.id) {
        dropped.push({ index: idx, reason: 'missing id' });
        continue;
      }
      if (!entry.name) {
        dropped.push({ index: idx, reason: 'missing name' });
        continue;
      }
      // The empty-args case is common and legitimate (a tool that takes
      // no parameters). Treat '' as {} rather than dropping.
      const argsText = entry.argumentsBuf.length === 0 ? '{}' : entry.argumentsBuf;
      let args: unknown;
      try {
        args = JSON.parse(argsText);
      } catch {
        dropped.push({ index: idx, reason: 'unparseable arguments JSON' });
        continue;
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        dropped.push({ index: idx, reason: 'arguments JSON was not an object' });
        continue;
      }
      requests.push({
        id: entry.id,
        name: entry.name,
        args: args as Record<string, unknown>,
      });
    }
    this.pending.clear();
    return { requests, dropped };
  }
}

// ---------------------------------------------------------------------------
// Channel-name helpers.
//
// Centralized so the function and the browser agree on the topic
// strings. Both sides will construct names from a threadId, and the
// realtime.messages RLS policies in supabase/schema.sql key off the
// same shape. Keeping the format in one place means a change to the
// topic naming convention does not silently desynchronize the policies
// and the consumers.
// ---------------------------------------------------------------------------

export function streamChannelName(threadId: string): string {
  return `thread:${threadId}:stream`;
}

export function controlChannelName(threadId: string): string {
  return `thread:${threadId}:control`;
}

// ---------------------------------------------------------------------------
// Output-guard primitives.
//
// A guard inspects an in-flight streaming attempt and votes on whether to
// keep it ('keep'), throw it away and re-roll ('retry'), or wait for more
// data ('undecided'). The driver lives in getStreamingCompletion; the
// concrete guards (e.g. the special-token-leak detector) live next to it
// in supabase/functions/venice/stream-guards.ts so the function side can
// arm them by model id without dragging the browser's models registry
// across the boundary.
//
// The interface itself is shared because the BROWSER and the FUNCTION
// need to agree on what `guard_retry` events on the Broadcast channel
// represent. Concrete impls do not have to match line-for-line on both
// sides - same guard name, same semantics, two implementations is fine
// during the migration.
// ---------------------------------------------------------------------------

/**
 * What the guard wrapper knows about one attempt at the moment a guard
 * is consulted. `ended` flips true once the underlying SSE stream
 * returns - that's the moment a guard gets a last word on a short-but-
 * legitimate reply it had been undecided about.
 */
export interface AttemptProgress {
  /** Concatenated response_text deltas seen so far this attempt. */
  visibleText: string;
  /** True once any reasoning_text event has arrived. */
  sawReasoning: boolean;
  /** True once any tool_call_request event has arrived. */
  sawToolCall: boolean;
  /** True once the underlying stream returned (no more events incoming). */
  ended: boolean;
}

/**
 * A guard's read on the current attempt:
 *   - 'keep'       commit to this attempt; flush buffered events live.
 *   - 'retry'      this attempt is junk; drop buffered events and re-issue.
 *   - 'undecided'  not enough has arrived to tell; keep buffering.
 */
export type GuardVerdict = 'keep' | 'retry' | 'undecided';

/**
 * Closed contract a concrete guard implements. The function-side
 * `prepareRetry` mutates the Venice wire body (e.g. bumps temperature)
 * for the next attempt rather than a ChatRequest-shaped object - the
 * function only ever has the wire body, not the higher-level request.
 */
export interface StreamGuard {
  readonly name: string;
  verdict(progress: AttemptProgress): GuardVerdict;
  /**
   * Returns a new wire-body for the next attempt. Never mutates the
   * input. The driver calls this once per guard per retry, folding the
   * body through every armed guard so multiple guards can compose their
   * mutations on the same re-roll.
   */
  prepareRetry(
    body: Record<string, unknown>,
    attempt: number,
  ): Record<string, unknown>;
}

/**
 * Maximum number of guard-driven re-rolls before the wrapper gives up
 * and surfaces a GuardExhaustedError. Two re-rolls (three attempts
 * total) clears a stochastic glitch like the special-token leak without
 * spinning the user's turn forever when a model is stuck in a
 * degenerate mode. Matches the browser-side value so the same model
 * gets the same retry budget on either path during the migration.
 */
export const MAX_STREAM_GUARD_RETRIES = 2;

/**
 * Compose per-guard verdicts into the driver's decision. Any 'retry'
 * wins (one guard rejecting is enough to re-roll). Otherwise any
 * 'undecided' holds the decision open (keep buffering). Only when
 * every guard is satisfied do we 'keep'.
 */
export function combineVerdicts(
  verdicts: readonly GuardVerdict[],
): GuardVerdict {
  if (verdicts.some((v) => v === 'retry')) return 'retry';
  if (verdicts.some((v) => v === 'undecided')) return 'undecided';
  return 'keep';
}

/**
 * Thrown by the guards driver when a guard kept voting to retry past
 * the cap. Distinct from the streaming error vocabulary so the
 * browser can surface a manual-retry affordance ("the model kept
 * emitting a glitch") rather than treating it as a transport failure.
 */
export class GuardExhaustedError extends Error {
  readonly guard: string;
  readonly attempts: number;
  constructor(guard: string, attempts: number) {
    super(`Stream guard "${guard}" exhausted after ${attempts} attempts`);
    this.name = 'GuardExhaustedError';
    this.guard = guard;
    this.attempts = attempts;
  }
}

/**
 * Trailing line appended to an assistant row's content when the user
 * cancels mid-stream. The marker turns a truncated bubble into a
 * legible "this got stopped" affordance instead of leaving the reader
 * to wonder whether the model just wrote a short answer. ASCII only
 * and placed on its own line so a markdown renderer treats it as
 * paragraph text rather than a setext heading (three hyphens alone
 * become an <hr> / H2; three hyphens followed by more text on the
 * same line parses as paragraph).
 *
 * Lives in the shared module because both the browser and the
 * orchestrator need the same string - the orchestrator appends it
 * on terminal abort writes, and the browser's chat-loop history
 * projection treats it as a recognised closer.
 */
export const INTERRUPTED_MARKER = '--- user interrupted response';

/**
 * Append the interrupted marker to a partial assistant content
 * buffer in the canonical way: two newlines for paragraph spacing
 * when the model produced any text; otherwise the marker alone.
 */
export function withInterruptedMarker(partial: string): string {
  if (partial.length === 0) return INTERRUPTED_MARKER;
  return `${partial}\n\n${INTERRUPTED_MARKER}`;
}
