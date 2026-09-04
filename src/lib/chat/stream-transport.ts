/**
 * Streaming-root transport: routes the browser's streamChat call through
 * the venice edge function's /stream route + a Supabase Realtime
 * Broadcast channel.
 *
 * All the round-internal work (Venice fetch, rate-limit retry, output
 * guards, tool dispatch, assistant-row commit) lives server-side; the
 * browser is a pure event consumer. This module owns the browser-side
 * transport: the Broadcast subscription that translates wire events
 * into StreamEvent, the pre-subscribe-then-POST ordering that prevents
 * dropped reasoning fragments, the reconnect poll for re-attaching to
 * an in-flight turn after a socket drop, and the cancel-channel publish
 * for the stop button.
 *
 * Wire types (StreamEvent, ChatRequest, TokenUsage, Citation), the
 * VeniceError class, and the buildChatBody wire-shape builder live in
 * ../venice; this module imports them. Channel-name helpers and the
 * wire-shape types that cross the Broadcast boundary live in
 * $shared/venice-stream.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  VeniceError,
  buildChatBody,
  type ChatRequest,
  type Citation,
  type StreamEvent,
  type TokenUsage,
} from '../venice';
import {
  controlChannelName,
  streamChannelName,
  type TerminalKind,
  type VeniceErrorKind as SharedVeniceErrorKind,
} from '$shared/venice-stream';
import { coerceIntuitionPayload } from '../intuition/types';
import { coerceContextRecallPayload } from '../context-recall/types';
import { createLogger } from '../logger.svelte';

const log = createLogger('venice');

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
 * chat/loop.ts surfaces it as an exception, and Chat.svelte's
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

export interface StreamEnvelope {
  channelName: string;
  assistantRowId: string | null;
  completedSoFar: string;
  noStreamInFlight?: boolean;
}

// Drain-internal marker for "the silence watchdog fired before any
// event arrived". Never yielded to consumers.
const SILENCE = Symbol('silence');

export async function* streamChatViaFunction(
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
  const subscription = setupStreamSubscription(supabase, channelName, {
    probeInFlight: () => probeStreamInFlight(supabase, ctx.threadId),
  });
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
          // Spread-omitted (not sent as an empty array) on plain
          // sends - the field appears on the wire only when a
          // regenerate is actually replacing rows.
          ...(ctx.supersededIds && ctx.supersededIds.length > 0
            ? { supersededIds: ctx.supersededIds }
            : {}),
          // Destructive-edit atomic insert: the edited text rides
          // to the commit RPC, which inserts it as a new user message
          // + deletes the old range in one transaction.
          ...(ctx.replaceUserMessageContent
            ? { replaceUserMessageContent: ctx.replaceUserMessageContent }
            : {}),
          // Priming inputs for the server-side priming stage. Sent only
          // when present so a caller that does no priming (sub-completion
          // paths never reach here, but be explicit) keeps the wire lean.
          ...(ctx.priming ? { priming: ctx.priming } : {}),
          // Full tool catalog for mid-turn toolbox rearming (see
          // ChatRequest.toolCatalog). Only the chat loop sets it;
          // omitted otherwise so the envelope stays lean.
          ...(req.toolCatalog ? { toolCatalog: req.toolCatalog } : {}),
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

/**
 * One reconnect-only probe of /stream: "is a turn still running on
 * this thread?" The server answers from the orchestrator's liveness
 * heartbeat (and buries a dead turn's row as a side effect), so the
 * verdict is trustworthy even when the function was hard-killed.
 * 'unknown' is a transport failure (offline, edge cold start); callers
 * keep waiting and ask again.
 */
async function probeStreamInFlight(
  supabase: SupabaseClient,
  threadId: string,
): Promise<StreamProbeVerdict> {
  try {
    const { data, error } = await supabase.functions.invoke<StreamEnvelope>(
      'venice/stream',
      { body: { threadId, reconnectOnly: true } },
    );
    if (error || !data) return { kind: 'unknown' };
    return data.noStreamInFlight
      ? { kind: 'settled' }
      : { kind: 'in-flight', completedSoFar: data.completedSoFar };
  } catch {
    // Transient invoke failure (mobile radio waking on foreground,
    // edge cold start). The caller retries on its own cadence.
    return { kind: 'unknown' };
  }
}

type StreamProbeVerdict =
  | { kind: 'in-flight'; completedSoFar: string }
  | { kind: 'settled' }
  | { kind: 'unknown' };

// Live-drain silence watchdog. A publisher that dies mid-turn (the
// edge runtime hard-kills the function for exceeding its CPU-time
// budget) closes nothing: the Broadcast socket stays healthy, no END
// arrives, and the drain would await forever. After this much silence
// the drain asks the server whether the turn is still alive rather
// than guessing - silence alone is not a verdict, because a long tool
// call or a slow model's prefill is legitimately quiet. Generous
// relative to the server's 60s heartbeat ceiling: a dead turn is
// confirmed on the first or second probe (~30-90s after the death),
// and a live one costs one cheap probe per half-minute of quiet.
const SILENCE_PROBE_MS = 30_000;

// Reconnect poll cadence. We re-probe /stream reconnectOnly on this
// interval while a turn we re-attached to is still in flight. Snappy
// enough that a turn finishing feels responsive; slow enough that a
// long generation costs only a handful of probes.
const RECONNECT_POLL_INTERVAL_MS = 2_500;

// Hard ceiling on the reconnect poll. The server-side dead-turn janitor
// (in the /stream handler) flips an orphaned streaming row to 'error'
// once the orchestrator's heartbeat is more than a minute old, after
// which the probe reports noStreamInFlight, so the poll terminates on
// its own in every normal case. This ceiling is the backstop for the
// pathological case where the probe ITSELF keeps failing (persistent
// offline): past it we stop polling and let the caller render whatever
// the row currently holds.
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
    // An 'unknown' verdict (transient invoke failure) is retried on the
    // next tick; the deadline below guarantees we don't spin forever.
    const verdict = await probeStreamInFlight(supabase, ctx.threadId);
    if (signal?.aborted) return;
    if (verdict.kind === 'settled') return;
    if (verdict.kind === 'in-flight') onProgress?.(verdict.completedSoFar);
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

interface StreamSubscriptionOpts {
  /**
   * Asked by the drain after SILENCE_PROBE_MS without an event. A
   * 'settled' answer means the publisher is gone (the server buried
   * the turn); the drain closes and throws StreamDisconnectedError so
   * the caller reconciles against the row. Any other answer keeps the
   * drain waiting.
   */
  probeInFlight: () => Promise<StreamProbeVerdict>;
  /** Silence threshold override (tests). Defaults to SILENCE_PROBE_MS. */
  silenceMs?: number;
}

function setupStreamSubscription(
  supabase: SupabaseClient,
  channelName: string,
  opts: StreamSubscriptionOpts,
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

  // Await the next event, or SILENCE once `ms` pass without one. The
  // timer and the resolver disarm each other so a late push after the
  // timeout queues normally (resolveNext is already null) instead of
  // resolving a settled promise.
  function waitForNext(ms: number): Promise<StreamEvent | null | typeof SILENCE> {
    return new Promise((r) => {
      const timer = setTimeout(() => {
        resolveNext = null;
        r(SILENCE);
      }, ms);
      resolveNext = (ev) => {
        clearTimeout(timer);
        r(ev);
      };
    });
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
    // Do NOT close the drain here. The function breaks its round loop on
    // this event, then runs its terminal write (persisting whatever
    // reasoning/text accumulated as a status='error' row) and publishes
    // END carrying that row's id. The chat-loop consumer needs that END
    // to hydrate the cut-off partial into the transcript before it
    // throws - closing on 'error' would drop the END and the partial
    // card would vanish, leaving only the error banner. END is the sole
    // terminal (the function's finally always publishes it); a genuine
    // socket drop still tears the drain down via the status callback's
    // disconnect path.
  });
  channel.on('broadcast', { event: 'assistant_round_committed' }, ({ payload }) => {
    const p = payload as { id?: string };
    if (typeof p.id === 'string' && p.id.length > 0) {
      push({ type: 'round_committed', id: p.id });
    }
  });
  // Priming liveness + payload refreshes, published by the server's
  // priming stage before BEGIN. The start/end pair is 1:1 (every start
  // gets one end); the consumer toggles the subconscious spinner per
  // op. Payload events carry the freshly-computed cache as raw JSON; we
  // coerce here (same drift guard the thread-row read uses) and drop
  // the event if the shape doesn't clear the coercer.
  const isPrimingOp = (op: unknown): op is 'samskara' | 'intuition' | 'recall' =>
    op === 'samskara' || op === 'intuition' || op === 'recall';
  channel.on('broadcast', { event: 'priming_start' }, ({ payload }) => {
    const p = payload as { op?: unknown };
    if (isPrimingOp(p.op)) push({ type: 'priming_start', op: p.op });
  });
  channel.on('broadcast', { event: 'priming_end' }, ({ payload }) => {
    const p = payload as { op?: unknown };
    if (isPrimingOp(p.op)) push({ type: 'priming_end', op: p.op });
  });
  channel.on('broadcast', { event: 'intuition_payload' }, ({ payload }) => {
    const p = payload as { payload?: unknown };
    const coerced = coerceIntuitionPayload(p.payload);
    if (coerced) push({ type: 'intuition_payload', payload: coerced });
  });
  channel.on('broadcast', { event: 'context_recall_payload' }, ({ payload }) => {
    const p = payload as { payload?: unknown };
    const coerced = coerceContextRecallPayload(p.payload);
    if (coerced) push({ type: 'context_recall_payload', payload: coerced });
  });
  // BEGIN: priming complete, completion starting. The browser uses
  // this to dismiss the pregame card. Without it, a model that emits
  // tool calls without preamble text leaves the card stuck.
  channel.on('broadcast', { event: 'BEGIN' }, () => {
    push({ type: 'begin' });
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

    const silenceMs = opts.silenceMs ?? SILENCE_PROBE_MS;
    try {
      while (true) {
        if (queue.length > 0) {
          const ev = queue.shift();
          if (ev) yield ev;
          continue;
        }
        if (closed) break;
        const next = await waitForNext(silenceMs);
        if (next === SILENCE) {
          // Silence watchdog. The publisher may simply be quiet (a long
          // tool call, a slow prefill) or it may be dead - a function
          // the runtime hard-killed publishes no END and drops no
          // socket, so from here the two are indistinguishable. Ask
          // the server, which reads the orchestrator's heartbeat. An
          // event (or END) that lands while we wait for the answer
          // outranks it: the loop re-checks the queue and `closed`
          // before trusting a 'settled' verdict.
          const verdict = await opts.probeInFlight();
          if (
            verdict.kind === 'settled' &&
            queue.length === 0 &&
            !closed
          ) {
            disconnected = true;
            close();
          }
          continue;
        }
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
 *
 * Joins the channel before publishing - a broadcast over the socket
 * requires the channel to be subscribed first. On a private channel the
 * join is a READ, so it needs the "control channel: owner subscribe"
 * SELECT policy on realtime.messages (supabase/schema.sql), NOT just the
 * INSERT publish policy. Both must exist together: if the SELECT policy
 * is missing the subscribe below rejects ("permission to read from this
 * Channel topic"), the await throws, and the send never runs - the Stop
 * button stops the local consumer while the edge function keeps
 * generating to completion. That failure is silent (caught and warned),
 * so the symptom shows up as "I hit Stop but the full reply still
 * landed", not as an error.
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
