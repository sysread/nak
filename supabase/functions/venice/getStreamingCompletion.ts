// getStreamingCompletion ------------------------------------------------------
//
// Function-side Venice SSE consumer that hides all of the round-internal
// recovery (rate-limit retries, output-guard re-rolls, tool-call
// fragment assembly) behind a single AsyncGenerator yielding the typed
// CompletionEvent + StreamSignal union from $shared/venice-stream.
//
// Public contract:
//
//   getStreamingCompletion(opts) yields, in order:
//     - one BEGIN
//     - zero or more reasoning_text, response_text, tool_call_request,
//       usage, citations events
//     - zero or more rate_limit_wait / rate_limit_resolved pairs and
//       guard_retry signals interleaved as recovery happens
//     - one of: DONE (success) OR error (terminal failure)
//
// The generator never throws (except for caller-side programmer
// errors: missing AbortSignal). Upstream failures - 401, 5xx, network
// drops, exhausted rate-limit retries, exhausted guard retries - all
// emerge as a final `error` event so the orchestrator
// (getStreamingResponse) can publish a coherent stream to the
// Broadcast channel and decide what to persist on the row.
//
// Internal composition:
//
//                +---- guard buffering + re-roll ----+
//                |  +-- rate-limit retry wrapper --+ |
//                |  | streamFromVenice (raw SSE) | |
//                |  +-----------------------------+ |
//                +-----------------------------------+
//
// Rate-limit retries can only happen BEFORE the first inner event is
// yielded on an attempt - the moment a delta lands the connection is
// committed. The guard wrapper buffers all of an attempt's events
// (text, reasoning, tool calls) until the guards collectively 'keep';
// only then are they flushed. A guard 'retry' verdict drops everything
// buffered and re-issues with whatever mutation the guards applied
// (e.g. temperature bump). With zero armed guards the wrapper is a
// pass-through with no buffering overhead.
//
// Aborts: opts.signal is honored at every layer. Mid-sleep aborts
// during a rate-limit wait raise an AbortError that the wrapper
// converts to an `error` event with kind='internal' since user-cancel
// is the orchestrator's concern, not this module's.

import {
  type AttemptProgress,
  type CompletionEvent,
  combineVerdicts,
  GuardExhaustedError,
  MAX_STREAM_GUARD_RETRIES,
  parseSseFrame,
  type StreamGuard,
  type StreamSignal,
  ToolCallAssembler,
  type TokenUsage,
  type VeniceCitation,
  type VeniceErrorKind,
} from '../_shared/venice-stream.ts';
import { VeniceError } from '../_shared/venice.ts';
import { streamGuardsForModel } from './stream-guards.ts';

const DEFAULT_BASE_URL = 'https://api.venice.ai/api/v1';

// Match the browser's rate-limit retry policy so a 429 looks the same
// on either path during the migration.
const RATE_LIMIT_MAX_ATTEMPTS = 3;
const RATE_LIMIT_FALLBACK_WAIT_MS: readonly number[] = [2_000, 4_000];
const RATE_LIMIT_WAIT_CAP_MS = 60_000;

// Truncation retry: when the SSE stream from Venice ends without a
// `[DONE]` sentinel AND the assembler had nothing actionable, the
// downstream layer re-issues the body. Capped low - a persistent
// truncation is more likely a wire-format change or an upstream
// regression than a transient blip - and backed off briefly to ride
// out infrastructure hiccups without burning input tokens.
const TRUNCATED_MAX_ATTEMPTS = 2;
const TRUNCATED_BACKOFF_MS = 500;

export interface StreamingCompletionOpts {
  apiKey: string;
  /**
   * Venice wire-shape body. Caller has already run buildChatBody (or
   * its function-side equivalent) and turned streaming on. We never
   * inspect or reshape the body except via guards' prepareRetry hook.
   * `model` is read off it for guard arming.
   */
  body: Record<string, unknown>;
  signal: AbortSignal;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Override the model-to-guards mapping (tests). Production callers
   * leave this undefined; the default arms guards based on body.model
   * via streamGuardsForModel().
   */
  guardsOverride?: StreamGuard[];
  /**
   * When set, the raw SSE stream from Venice is mirrored to a file at
   * this path - one JSONL line per frame, each carrying both the raw
   * `data: ...` payload and the parsed delta the shared parser
   * produced. Off in production; the orchestrator sets it (under
   * `/tmp/nak-venice-<runId>.log`) when the `NAK_DUMP_STREAM` env var
   * is truthy, so a dev-start session can replay exactly what the
   * model emitted - useful when tool calls land inside reasoning
   * text instead of structured `delta.tool_calls` and we need to see
   * which shape Venice actually sent.
   */
  rawFrameDumpPath?: string;
}

/**
 * Top-level entrypoint. Yields one BEGIN, then content + signal
 * events, then exactly one DONE or error.
 */
export async function* getStreamingCompletion(
  opts: StreamingCompletionOpts,
): AsyncGenerator<CompletionEvent | StreamSignal, void, void> {
  yield { type: 'BEGIN' };

  const guards =
    opts.guardsOverride ??
    streamGuardsForModel(
      typeof opts.body.model === 'string' ? opts.body.model : '',
    );

  let finishReason: string | null = null;
  try {
    for await (const ev of withGuards(opts, guards)) {
      if (ev.type === 'DONE') {
        finishReason = ev.finishReason;
        continue;
      }
      yield ev;
    }
    yield { type: 'DONE', finishReason };
  } catch (err) {
    yield errorEventFor(err);
    // No DONE after error - the contract is one-or-the-other.
  }
}

// ---------------------------------------------------------------------------
// Layer 2: guards wrapper.
//
// Buffers events until guards collectively 'keep', then flushes and
// streams through. On 'retry', drops the buffer, applies guards'
// prepareRetry to the body, and re-issues. The DONE event from the
// rate-limit layer reaches here too - we use it to give a final
// verdict on a short stream (a guard that was 'undecided' on three
// characters of text becomes 'keep' or 'retry' once 'ended' flips
// true).
// ---------------------------------------------------------------------------

async function* withGuards(
  opts: StreamingCompletionOpts,
  guards: StreamGuard[],
): AsyncGenerator<CompletionEvent | StreamSignal, void, void> {
  if (guards.length === 0) {
    yield* withRateLimitRetry(opts);
    return;
  }

  let body = opts.body;
  let attempt = 0;

  for (;;) {
    const childAbort = childController(opts.signal);
    const progress: AttemptProgress = {
      visibleText: '',
      sawReasoning: false,
      sawToolCall: false,
      ended: false,
    };
    const buffer: Array<CompletionEvent | StreamSignal> = [];
    let committed = false;
    let retryGuard: string | null = null;
    let lastFinishReason: string | null = null;

    try {
      for await (const ev of withRateLimitRetry({
        ...opts,
        body,
        signal: childAbort.signal,
      })) {
        if (ev.type === 'DONE') {
          lastFinishReason = ev.finishReason;
          // Don't pass DONE through here - the outer
          // getStreamingCompletion emits exactly one DONE per
          // completion. End-of-attempt is signaled by the inner loop
          // ending.
          continue;
        }
        if (committed) {
          yield ev;
          continue;
        }
        buffer.push(ev);
        if (ev.type === 'response_text') progress.visibleText += ev.content;
        else if (ev.type === 'reasoning_text') progress.sawReasoning = true;
        else if (ev.type === 'tool_call_request') progress.sawToolCall = true;
        // Signals (rate_limit_*, guard_retry from a nested layer) do
        // not affect progress - they're meta-events about the attempt
        // itself.

        const verdicts = guards.map((g) => g.verdict(progress));
        const combined = combineVerdicts(verdicts);
        if (combined === 'retry') {
          retryGuard = guards[verdicts.indexOf('retry')].name;
          break;
        }
        if (combined === 'keep') {
          committed = true;
          for (const b of buffer) yield b;
          buffer.length = 0;
        }
      }
    } finally {
      // No-op when the attempt completed cleanly. Decisive when we
      // broke out early on retry - severs the underlying fetch so we
      // stop paying for a leak that is still streaming.
      childAbort.abort();
    }

    if (committed) {
      // The attempt's stream returned. Flush the closing DONE so the
      // outer wrapper can stamp finishReason.
      yield { type: 'DONE', finishReason: lastFinishReason };
      return;
    }

    if (retryGuard === null) {
      // Stream ended while still buffering - every guard was
      // undecided. Give them a final verdict with ended=true.
      progress.ended = true;
      const verdicts = guards.map((g) => g.verdict(progress));
      if (combineVerdicts(verdicts) !== 'retry') {
        for (const b of buffer) yield b;
        yield { type: 'DONE', finishReason: lastFinishReason };
        return;
      }
      retryGuard = guards[verdicts.indexOf('retry')].name;
    }

    if (attempt >= MAX_STREAM_GUARD_RETRIES) {
      throw new GuardExhaustedError(retryGuard, attempt + 1);
    }
    attempt += 1;
    yield { type: 'guard_retry', reason: retryGuard };
    body = guards.reduce((b, g) => g.prepareRetry(b, attempt), body);
  }
}

// ---------------------------------------------------------------------------
// Layer 1: rate-limit + truncation retry wrapper.
//
// Two re-issue paths share this wrapper because both rebuild the same
// request body and both are bounded retries:
//
//   - 429 BEFORE any event yields -> wait per Venice's hint (or
//     fallback schedule), emit rate_limit_wait / rate_limit_resolved
//     signals, retry. 429 AFTER the first event has yielded is fatal
//     (we cannot un-yield events for the rate-limit case - the
//     contract there is "this attempt is over, the next is fresh"
//     but rate_limit doesn't get a chance to come back as content).
//   - Stream truncation (reader closed without `[DONE]` AND no tool
//     calls assembled). Even when events HAVE yielded - typically
//     response_text deltas the consumer accumulated against the
//     streaming row - we still retry, because the downstream
//     consumers (orchestrator + browser) cooperate to reset their
//     accumulators on the `stream_retry` signal emitted before each
//     retry attempt. Earlier persisted rows (tool_call_request
//     rounds) are untouched; only the in-flight terminal round's
//     partial content gets discarded and re-rolled.
//
// Caps and backoff differ per kind: rate-limit follows Venice's
// retry-after schedule with up to RATE_LIMIT_MAX_ATTEMPTS, truncation
// retries up to TRUNCATED_MAX_ATTEMPTS with a small fixed backoff.
// ---------------------------------------------------------------------------

async function* withRateLimitRetry(
  opts: StreamingCompletionOpts,
): AsyncGenerator<CompletionEvent | StreamSignal, void, void> {
  let rateLimitAttempt = 0;
  let truncatedAttempt = 0;
  for (;;) {
    let emitted = false;
    try {
      for await (const ev of streamFromVenice(opts)) {
        emitted = true;
        yield ev;
      }
      return;
    } catch (err) {
      const isRateLimit =
        err instanceof VeniceError && err.kind === 'rate_limit';
      const isTruncated =
        err instanceof VeniceError && err.kind === 'truncated';
      if (isTruncated) {
        if (
          truncatedAttempt >= TRUNCATED_MAX_ATTEMPTS - 1 ||
          opts.signal.aborted
        ) {
          throw err;
        }
        truncatedAttempt += 1;
        // Emit the retry signal BEFORE sleeping so downstream
        // consumers can reset their accumulators (streaming row
        // content, slot.streamingText, slot.streamingReasoning) and
        // the new attempt's stream lands into a clean slate. Skipped
        // when no events emitted yet - there's nothing to reset, and
        // an unsolicited stream_retry on a fresh round would surprise
        // a consumer reading the signal as "discard prior partial".
        if (emitted) {
          yield {
            type: 'stream_retry',
            reason: 'truncated',
            attempt: truncatedAttempt,
          };
        }
        const interrupted = await sleepCancellable(
          TRUNCATED_BACKOFF_MS,
          opts.signal,
        );
        if (interrupted || opts.signal.aborted) {
          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        // Loop back into the streamFromVenice attempt fresh.
        continue;
      }
      const retriesExhausted =
        rateLimitAttempt >= RATE_LIMIT_MAX_ATTEMPTS - 1;
      if (!isRateLimit || emitted || retriesExhausted || opts.signal.aborted) {
        throw err;
      }
      rateLimitAttempt += 1;
      const hint = (err as VeniceError).retryAfterMs;
      const fallbackIdx = Math.min(
        rateLimitAttempt - 1,
        RATE_LIMIT_FALLBACK_WAIT_MS.length - 1,
      );
      const baseMs = hint ?? RATE_LIMIT_FALLBACK_WAIT_MS[fallbackIdx];
      const waitMs = Math.min(baseMs, RATE_LIMIT_WAIT_CAP_MS);
      const until = new Date(Date.now() + waitMs).toISOString();
      yield {
        type: 'rate_limit_wait',
        retryAfterMs: waitMs,
        attempt: rateLimitAttempt,
        until,
      };
      const interrupted = await sleepCancellable(waitMs, opts.signal);
      yield { type: 'rate_limit_resolved' };
      if (interrupted || opts.signal.aborted) {
        const abortErr = new Error('Aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Layer 0: raw SSE reader.
//
// Opens POST /chat/completions, reads frames, parses with the shared
// parseSseFrame, and emits CompletionEvents plus a final DONE carrying
// the captured finish_reason. Throws VeniceError on transport / wire
// failures so the rate-limit wrapper can branch.
// ---------------------------------------------------------------------------

async function* streamFromVenice(
  opts: StreamingCompletionOpts,
): AsyncGenerator<CompletionEvent, void, void> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    throw new VeniceError(
      `Network error contacting Venice: ${(err as Error).message}`,
      'network',
    );
  }

  if (!res.ok) throw await classifyHttpError(res);
  if (!res.body) {
    throw new VeniceError('Venice returned empty body', 'parse');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const assembler = new ToolCallAssembler();
  // The completion's natural end is the `[DONE]` sentinel after the
  // last data frame. The reader returning `done:true` without us
  // having seen the sentinel means Venice closed the socket early -
  // either a clean cut at the transport layer, or upstream
  // infrastructure dropped the connection mid-stream. The retry layer
  // above this one uses sawDoneSentinel + assembler.hasPending() to
  // distinguish a recoverable cut (no terminal sequence, no tool
  // fragments assembled) from a partial-but-actionable round (got
  // some tool fragments before the cut - dispatch what we have).
  let sawDoneSentinel = false;
  // Optional raw-frame dump. Opened lazily on the first frame so the
  // file appears in /tmp only when frames actually arrive. Append
  // mode so a long round shares one file. Best-effort: any write
  // error stops further dumping but doesn't affect streaming.
  const dumpPath = opts.rawFrameDumpPath;
  let dumpDisabled = false;
  const dumpFrame = async (raw: string, parsed: unknown): Promise<void> => {
    if (!dumpPath || dumpDisabled) return;
    try {
      const line = JSON.stringify({ raw, parsed }) + '\n';
      await Deno.writeTextFile(dumpPath, line, { append: true });
    } catch {
      dumpDisabled = true;
    }
  };
  // Captured but only emitted at end. The shared SseDelta carries a
  // usage frame distinct from content frames; we hold it until DONE so
  // consumers can pair it with the round that produced it.
  let usage: TokenUsage | null = null;
  let citationsEmitted = false;
  let finishReason: string | null = null;

  try {
    outer: for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseSseFrame(frame);
        await dumpFrame(frame, parsed);
        if (parsed === null) continue;
        if (parsed === '[DONE]') {
          sawDoneSentinel = true;
          break outer;
        }

        if (parsed.text !== undefined && parsed.text.length > 0) {
          yield { type: 'response_text', content: parsed.text };
        }
        if (parsed.reasoning !== undefined && parsed.reasoning.length > 0) {
          yield { type: 'reasoning_text', content: parsed.reasoning };
        }
        if (
          !citationsEmitted &&
          parsed.citations &&
          parsed.citations.length > 0
        ) {
          citationsEmitted = true;
          yield emitCitations(parsed.citations);
        }
        if (parsed.toolCallFragments) {
          assembler.ingest(parsed.toolCallFragments);
        }
        if (parsed.usage) usage = parsed.usage;
        if (parsed.finishReason) finishReason = parsed.finishReason;
      }
    }
  } catch (err) {
    if (
      opts.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      // The caller cancelled. Propagate the AbortError so the upper
      // layers know not to retry; the outer getStreamingCompletion
      // converts it to an `error` event.
      throw err;
    }
    throw new VeniceError(
      `SSE read failed: ${(err as Error).message}`,
      'parse',
    );
  } finally {
    reader.releaseLock();
  }

  // Flush any tool calls assembled but not yet flushed. Fragments
  // missing id or name are dropped silently - the assembler logs the
  // reason but the consumer cannot execute a tool whose identity is
  // partial.
  const { requests, dropped } = assembler.flush();
  if (dropped.length > 0 || (finishReason === 'tool_calls' && requests.length === 0)) {
    console.log(
      `[streamFromVenice] flush: requests=${requests.length} dropped=${JSON.stringify(dropped)} finishReason=${finishReason}`,
    );
  }

  // Truncation detection. If the reader returned `done:true` without
  // us having seen the `[DONE]` sentinel AND we have no actionable
  // tool calls to dispatch, the upstream stream cut early and the
  // round should be retried. We throw a VeniceError with
  // kind='truncated' so withRateLimitRetry (which already owns the
  // re-issue mechanic) can catch it, emit the retry signal, and
  // re-run the body. When tool calls DID land before the cut, we
  // forward them and let the round dispatch - the model gave us
  // something actionable, the cut happened on the tail and isn't
  // recoverable cleanly anyway.
  if (!sawDoneSentinel && requests.length === 0) {
    throw new VeniceError(
      'Venice SSE stream ended without [DONE] sentinel',
      'truncated',
    );
  }

  for (const r of requests) {
    yield { type: 'tool_call_request', request: r };
  }

  if (usage !== null) {
    yield { type: 'usage', usage };
  }

  // Synthetic DONE the wrappers consume to thread finish_reason
  // through. The outer getStreamingCompletion strips this and emits
  // its own canonical DONE.
  yield { type: 'DONE', finishReason };
}

function emitCitations(c: VeniceCitation[]): CompletionEvent {
  return { type: 'citations', citations: c };
}

async function classifyHttpError(res: Response): Promise<VeniceError> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 500);
  } catch {
    /* ignore */
  }
  if (res.status === 401 || res.status === 403) {
    return new VeniceError(
      `Venice rejected the API key (HTTP ${res.status}). ${detail}`,
      'auth',
      res.status,
    );
  }
  if (res.status === 429) {
    return new VeniceError(
      `Venice rate limit hit (HTTP 429). ${detail}`,
      'rate_limit',
      res.status,
      parseRetryAfterMs(res.headers),
    );
  }
  return new VeniceError(
    `Venice HTTP ${res.status}: ${detail}`,
    'http',
    res.status,
  );
}

/**
 * Pull Venice's rate-limit hint from response headers. Preference:
 * Retry-After first (canonical), x-ratelimit-reset-{requests,tokens}
 * second. Returns null when no header is present or parseable; the
 * caller falls back to its own schedule.
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
  for (const name of [
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
  ]) {
    const raw = headers.get(name);
    if (!raw) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      candidates.push(seconds * 1000);
    }
  }
  if (candidates.length === 0) return null;
  return Math.round(Math.min(...candidates));
}

/**
 * Sleep that resolves either when `ms` elapses or when `signal`
 * aborts. Returns true if the signal interrupted the sleep, false on
 * a clean timeout.
 */
function sleepCancellable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create a child controller that aborts when the parent does, but can
 * also be aborted independently. Used by the guards wrapper to tear
 * down a single attempt's fetch on a 'retry' verdict without
 * cancelling the whole user turn.
 */
function childController(parent: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent.aborted) {
    child.abort(parent.reason);
    return child;
  }
  const onAbort = (): void => child.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return child;
}

/**
 * Translate any thrown error into a terminal `error` StreamSignal.
 * VeniceError carries a kind we surface directly. GuardExhaustedError
 * collapses to kind='internal' (it is not a transport failure - the
 * model kept emitting a glitch) with the guard name on the message
 * so the browser can surface its own copy. AbortError collapses to
 * kind='internal' too - the user/orchestrator initiated the cancel
 * and the orchestrator will publish its own END with terminalKind
 * 'aborted'. Anything else collapses to kind='internal' with
 * retryable=false to be conservative.
 */
function errorEventFor(err: unknown): StreamSignal {
  if (err instanceof VeniceError) {
    return {
      type: 'error',
      kind: err.kind as VeniceErrorKind,
      message: err.message,
      retryable: err.kind === 'rate_limit' || err.kind === 'network',
    };
  }
  if (err instanceof GuardExhaustedError) {
    return {
      type: 'error',
      kind: 'internal',
      message: err.message,
      retryable: false,
    };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return {
      type: 'error',
      kind: 'internal',
      message: 'Stream aborted.',
      retryable: false,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    type: 'error',
    kind: 'internal',
    message,
    retryable: false,
  };
}
