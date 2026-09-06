/**
 * Stream-event consumer for a live chat turn. Drives the UI off a
 * `streamChat`-shaped event iterator: owns the streaming-bubble
 * accumulators, the per-call ask_user capture, the rate-limit /
 * guard-retry liveness pairs, and the END routing that maps the
 * server's terminalKind back onto the interrupted / conflict /
 * awaitingUserAnswer flags the caller's UI keys off.
 *
 * Split out from ../chat/loop.ts: `runChatLoop` feeds this its
 * `venice.streamChat` iterator and projects the returned
 * `ConsumedStreamResult` into its own `ChatLoopResult`. The consumer
 * closes over no loop state - everything it needs arrives in `opts` -
 * which is what lets it live (and be tested) on its own.
 */

import type { SupabaseService } from '../supabase';
import type { Citation, StreamEvent, TokenUsage } from '../venice';
import { VeniceError } from '../venice';
import type { OpenAIToolCall } from '../tools';
import { askUserSchema } from '../tools/ask_user.schema';
import { extractAskUserPrompt } from '../ask-user';
import { parseToolArguments } from '../tools/wire';
import { createLogger } from '../logger.svelte';
import type { ChatLoopHandlers, ChatLoopResult } from './types';

// Shares the 'chat-loop' subsystem label with the orchestrator: this
// is the same logical turn, split across files, so its warn lines
// stay grouped with the loop's in the log drawer.
const log = createLogger('chat-loop');

/**
 * What `consumeStreamEvents` carries back to its caller. Mirrors the
 * tail half of `ChatLoopResult` - the bits that key off the END event
 * and the streaming accumulators. `runChatLoop` (the live turn) projects
 * this into its own return shape.
 */
interface ConsumedStreamResult {
  finalText: string;
  roundsRun: number;
  interrupted: boolean;
  conflictDetected: boolean;
  /**
   * Set when the server-side round loop exhausted MAX_ROUNDS without
   * the model ever producing a terminal text round. The END event
   * carries `terminalKind: 'error', conflict: 'round_limit'`; the
   * caller branches off this flag rather than digging through the raw
   * terminal kind + conflict tuple. Mutually exclusive with
   * `conflictDetected` (the other 'error' terminal source - a
   * commit_assistant_message race - flips that flag instead).
   */
  stoppedByLimit: boolean;
  awaitingUserAnswer: ChatLoopResult['awaitingUserAnswer'];
  lastAssistantId: string | null;
  terminalKind:
    | 'completed'
    | 'aborted'
    | 'error'
    | 'suspended_for_ask_user'
    | null;
}

/**
 * Drive the live UI off a `streamChat`-shaped event iterator. Owns
 * the streaming-bubble accumulators, the per-call ask_user capture,
 * the rate-limit / guard-retry liveness pairs, and the END routing
 * that maps the server's terminalKind back onto the legacy
 * interrupted / conflict / awaitingUserAnswer flags the caller's UI
 * still keys off.
 *
 * Fed by `runChatLoop` (the live turn: originating user message +
 * priming + `venice.streamChat`). Reconnect to an already-in-flight
 * turn does NOT feed this - it polls the row to a terminal state and
 * renders from the DB rather than consuming a live event stream (see
 * `reconnectInflightTurn` in Chat.svelte and `awaitStreamSettled` in
 * venice.ts).
 *
 * The function throws on a terminal 'error' END with no conflict
 * reason - the caller's outer try/catch surfaces the error banner.
 * Conflict-tagged errors translate into `conflictDetected = true`
 * and resolve normally.
 */
export async function consumeStreamEvents(opts: {
  events: AsyncIterable<StreamEvent>;
  signal: AbortSignal;
  supabase: SupabaseService;
  handlers?: ChatLoopHandlers;
}): Promise<ConsumedStreamResult> {
  const { events, signal, supabase, handlers } = opts;

  // ask_user request capture. The model emits a tool_call_request for
  // ask_user with the question + options as its args; we parse them
  // here so an END {terminalKind: 'suspended_for_ask_user'} can return
  // the question/options to the caller without a separate fetch. Only
  // the FIRST ask_user call captures - sibling ask_user calls are
  // marked cancelled server-side.
  let pendingAskUser: ChatLoopResult['awaitingUserAnswer'] = null;

  // Server-driven END marker. Populated by the END event and consumed
  // after the loop closes; null when the stream never reached an END
  // (caught error / aborted-before-end). roundsRun is the
  // orchestrator's per-turn counter; we default to null and fall back
  // to a coarse 0/1 signal if the END event predates the field (older
  // server vs newer browser).
  let endPersistedId: string | null = null;
  let endTerminalKind: ConsumedStreamResult['terminalKind'] = null;
  let endConflict: string | undefined;
  let endRoundsRun: number | null = null;
  // Rows the server's empty-row sweep deleted this turn; handed to
  // onRowsPruned after the terminal hydration below.
  let endPrunedIds: string[] = [];
  // A terminal stream error, captured but NOT thrown until after the
  // post-loop persisted-row hydration. Throwing the instant the 'error'
  // event arrives would skip the hydration below, so the cut-off
  // partial (the model's reasoning, plus any text that streamed before
  // the break) never lands in the transcript - the browser's error path
  // then clears the live buffers and leaves only the error banner with
  // nothing to inspect. Deferring the throw lets the persisted
  // status='error' row hand off to its card first.
  let streamError: VeniceError | null = null;

  // Track the in-flight calls keyed by id so a tool_call_response can
  // pair to the originating tool_call request for the UI's per-tool
  // timing/state machinery. The server publishes tool_call_response
  // separately from tool_call_request; the browser doesn't execute
  // tools anymore, just reflects status.
  const pendingCallsById = new Map<string, OpenAIToolCall>();

  // Round-counter shim for output-guard retries. The server publishes
  // guard_retry events with a reason string; the UI handler expects an
  // attempt count, so we keep one locally.
  let guardAttemptCount = 0;

  // Accumulators for streaming feedback. The server is the source of
  // truth for the persisted assistant row; these drive the live
  // streaming bubble + reasoning panel + citation panel rendering
  // until END arrives, then feed the synthesized Message we hand to
  // onAssistantPersisted so the slot's persistedRows replay buffer
  // carries a row regardless of whether the realtime echo has landed.
  let streamingText = '';
  let streamingReasoning = '';
  let streamingCitations: Citation[] | null = null;
  let streamingUsage: TokenUsage | null = null;

  let interrupted = false;
  let conflictDetected = false;

  try {
    for await (const ev of events) {
      switch (ev.type) {
        case 'text':
          streamingText += ev.delta;
          handlers?.onTextUpdate?.(streamingText);
          break;
        case 'reasoning':
          streamingReasoning += ev.delta;
          handlers?.onReasoningUpdate?.(streamingReasoning);
          break;
        case 'tool_call': {
          pendingCallsById.set(ev.toolCall.id, ev.toolCall);
          handlers?.onToolStart?.(ev.toolCall);
          // Capture the ask_user question + options off the request
          // args so an END {terminalKind: 'suspended_for_ask_user'}
          // can return them without re-fetching the persisted tool
          // row. The server enforces the first-call-wins suspend
          // rule; we mirror that here by only writing pendingAskUser
          // when the slot is empty.
          if (
            ev.toolCall.function.name === askUserSchema.name &&
            pendingAskUser === null
          ) {
            try {
              const a = parseToolArguments(
                ev.toolCall.function.arguments,
              ) as Record<string, unknown>;
              pendingAskUser = {
                toolCallId: ev.toolCall.id,
                ...extractAskUserPrompt(a),
              };
            } catch {
              // Malformed args from the model. The server will surface
              // this as a tool-error row and the model gets a chance to
              // recover on the next round. UI just doesn't get the
              // pre-populated AskUserCard data.
            }
          }
          break;
        }
        case 'tool_call_response': {
          // The server-side dispatcher finished executing the tool and
          // wrote its result row. Route to onToolDone (success) or
          // onToolError (failure) based on the wire ev.ok flag - the
          // tool-result row travels via the separate messages
          // realtime subscription with its own propagation latency,
          // and the in-card status icon (statusFor) consults the
          // per-call timing's `error` flag to render success vs
          // failure during the window where the row hasn't arrived
          // yet. ev.resultSummary is a preview the UI doesn't read
          // today but is wired through for forward compatibility.
          const call = pendingCallsById.get(ev.id);
          if (call) {
            if (ev.ok) {
              handlers?.onToolDone?.(call, ev.resultSummary);
            } else {
              // The error shape on the wire is the truncated summary
              // string ('{"ok":false,"error":{"message":"..."}}' from
              // the orchestrator). The full payload lives on the
              // tool-result row; this Error is a synthetic wrapper so
              // the handler's signature stays Error-typed.
              handlers?.onToolError?.(call, new Error(ev.resultSummary));
            }
          }
          break;
        }
        case 'usage':
          streamingUsage = ev.usage;
          break;
        case 'citations':
          streamingCitations = ev.citations;
          break;
        case 'rate_limit_wait': {
          // The wire carries an ISO 8601 timestamp; the UI handler
          // wants epoch ms for a countdown render.
          const untilMs = Date.parse(ev.until);
          handlers?.onRateLimitWait?.({
            retryAfterMs: ev.retryAfterMs,
            attempt: ev.attempt,
            until: Number.isFinite(untilMs)
              ? untilMs
              : Date.now() + ev.retryAfterMs,
          });
          break;
        }
        case 'rate_limit_resolved':
          handlers?.onRateLimitResolved?.();
          break;
        case 'guard_retry': {
          guardAttemptCount += 1;
          handlers?.onGuardRetry?.({
            guard: ev.reason || 'guard',
            attempt: guardAttemptCount,
          });
          // The discarded attempt's buffered text/reasoning must be
          // cleared so the re-roll renders into a clean streaming
          // bubble. The server discards the same prefix on its end.
          streamingText = '';
          streamingReasoning = '';
          break;
        }
        case 'stream_retry': {
          // Transport-layer retry. Server's withRateLimitRetry caught
          // a truncated SSE stream and is re-issuing the same body;
          // the consumer's accumulated content/reasoning belong to
          // the cut-off prefix and must be discarded so the new
          // attempt's stream renders cleanly. No UI affordance fires
          // (this is a silent recovery, unlike guard_retry which
          // raises a slop-notice card); the streaming bubble just
          // resets to empty and starts collecting again.
          streamingText = '';
          streamingReasoning = '';
          handlers?.onTextUpdate?.('');
          handlers?.onReasoningUpdate?.('');
          break;
        }
        case 'round_committed': {
          // Round boundary. The function committed this non-terminal
          // round's assistant-with-tool-calls row and is moving on to
          // the next completion. Reset the local accumulators so the
          // next round's deltas don't append onto this round's
          // text/reasoning, and route the persisted row through the same
          // onAssistantPersisted hand-off the terminal round gets at END
          // - it resets the slot's streaming buffers, cancels any
          // pending flush, and renders the row as its own card. Without
          // this the live bubble carries every round's content
          // concatenated and duplicates the per-round cards (the round
          // loop runs server-side now, so the browser has no other way
          // to see the boundary). Best-effort fetch: on failure the
          // messages realtime subscription still delivers the row, we
          // just miss the proactive buffer reset for this round (the
          // next round_committed or END recovers it).
          streamingText = '';
          streamingReasoning = '';
          try {
            const msg = await supabase.getMessage(ev.id);
            if (msg) handlers?.onAssistantPersisted?.(msg);
          } catch (err) {
            log.warn(
              `getMessage(${ev.id}) failed on round boundary; relying on realtime INSERT: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          break;
        }
        case 'priming_start':
          // Turn-entry priming liveness. Toggles the subconscious
          // spinner for this op; the server runs the pipeline now, but
          // the UI feedback is identical to the old local callback.
          handlers?.onSubconsciousStart?.(ev.op);
          break;
        case 'priming_end':
          handlers?.onSubconsciousEnd?.(ev.op);
          break;
        case 'intuition_payload':
          // Fresh intuition cache from the server's priming run. Routes
          // to the same handler the local pipeline used, so the
          // Intuition modal + pill update exactly as before. Already
          // coerced at decode.
          handlers?.onIntuitionUpdate?.(ev.payload);
          break;
        case 'context_recall_payload':
          handlers?.onContextRecallUpdate?.(ev.payload);
          break;
        case 'begin':
          // Priming complete, completion starting. Dismiss the pregame
          // card so it does not stay visible when a model emits tool
          // calls without preamble text.
          handlers?.onBegin?.();
          break;
        case 'error':
          // The server reported a terminal stream failure. Stash it
          // with a kind matching the original VeniceError categorization
          // (so the outer try/catch surfaces a recognisable shape and
          // a rate_limit keeps its retry closure) but DON'T throw yet:
          // the server breaks its round loop on this event, then runs
          // its terminal write - persisting whatever reasoning/text
          // accumulated as a status='error' row - and publishes END
          // carrying that row's id. We keep consuming so the END below
          // sets endPersistedId and the post-loop hydration hands the
          // partial off to its card before we throw. (venice.ts no
          // longer closes the drain on 'error' for exactly this reason;
          // END is the sole terminal.)
          streamError = new VeniceError(
            ev.message || 'stream error',
            ev.kind === 'rate_limit' ? 'rate_limit' : 'http',
          );
          break;
        case 'end':
          endPersistedId =
            ev.persistedAssistantId.length > 0
              ? ev.persistedAssistantId
              : null;
          endTerminalKind = ev.terminalKind;
          endConflict = ev.conflict;
          endRoundsRun = typeof ev.roundsRun === 'number' ? ev.roundsRun : null;
          endPrunedIds = ev.prunedIds ?? [];
          break;
      }
    }
  } catch (err) {
    // User clicked the stop button (or the caller aborted for any
    // other reason) while the stream consumer was still reading.
    // The server-side function continues running until our control-
    // channel cancel publish reaches it; both paths drive END
    // {terminalKind: 'aborted'} eventually. Locally we just stop
    // consuming and flag interrupted - the server owns persistence.
    const isAbort =
      signal.aborted || (err instanceof Error && err.name === 'AbortError');
    if (!isAbort) throw err;
    interrupted = true;
  }

  // END routing. terminalKind is the canonical signal from the server;
  // the local catch above only sets interrupted when the consumer
  // never saw END. Translate each terminal kind into the legacy
  // ChatLoopResult fields the caller expects.
  if (endTerminalKind === 'aborted') {
    interrupted = true;
  }
  // Default state - flipped below if the END routing puts us into a
  // round-limit terminal.
  let stoppedByLimit = false;
  if (endTerminalKind === 'error') {
    // Server-side END error routing. Three sources today:
    //   - conflict='round_limit' - the orchestrator's round loop
    //     exhausted MAX_ROUNDS without the model ever producing a
    //     terminal text round. Map onto stoppedByLimit so the caller
    //     can render the round-limit banner.
    //   - conflict=<commit_assistant_message reason> - the assistant
    //     commit RPC saw a newer user message land underneath us, or
    //     another conversation-level race. Map onto the legacy
    //     conflictDetected path so the "conversation changed on
    //     another device" UI fires.
    //   - no conflict - generic stream error that already published
    //     an END. Stash a thrown error so the caller's error banner
    //     shows, but only if the mid-stream 'error' event didn't
    //     already give us a more specific kind/message (it usually
    //     fires first and carries the provider's detail). The throw
    //     itself is deferred to after hydration (see streamError).
    if (endConflict === 'round_limit') {
      stoppedByLimit = true;
    } else if (endConflict) {
      conflictDetected = true;
    } else if (!streamError) {
      streamError = new VeniceError('stream ended in error state', 'http');
    }
  }
  const awaitingUserAnswer =
    endTerminalKind === 'suspended_for_ask_user' && pendingAskUser
      ? pendingAskUser
      : null;
  const lastAssistantId = endPersistedId;
  // Server-driven roundsRun when the END event carried it; coarse
  // fallback ("did anything run" vs nothing) for older server builds
  // that don't publish the field.
  const roundsRun = endRoundsRun ?? (endTerminalKind !== null ? 1 : 0);

  // Hydrate the persisted assistant row so the slot's persistedRows
  // replay buffer carries a canonical record. The realtime UPDATE
  // echo also delivers this row to subscribeToMessages, but exchanges
  // on a non-active thread won't have a live subscription - and the
  // slot's replay buffer is what populates `messages` on thread
  // re-entry. Best-effort: if the fetch fails the realtime path will
  // eventually catch up via the next listMessages.
  if (lastAssistantId !== null) {
    try {
      const msg = await supabase.getMessage(lastAssistantId);
      if (msg) handlers?.onAssistantPersisted?.(msg);
    } catch (err) {
      log.warn(
        `getMessage(${lastAssistantId}) failed; relying on realtime UPDATE: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Empty rows the server swept at commit time. Ordered after the
  // terminal hydration so the handler sees the final transcript shape
  // (new row in, stale empties out) in one settled pass.
  if (endPrunedIds.length > 0) handlers?.onRowsPruned?.(endPrunedIds);

  // Terminal error: throw AFTER hydrating the persisted partial above,
  // so the cut-off card (reasoning + whatever text streamed) is already
  // in the transcript when runExchange's catch clears the live buffers
  // and raises the error banner. The user keeps the partial to diagnose
  // WHY the turn failed instead of watching it vanish.
  if (streamError) throw streamError;

  // Suppress unused-name warnings on the round-only state we used to
  // mutate. streamingCitations / streamingUsage land on the persisted
  // assistant row server-side; nothing on the browser consumes them
  // directly anymore.
  void streamingCitations;
  void streamingUsage;

  return {
    finalText: streamingText,
    roundsRun,
    interrupted,
    conflictDetected,
    stoppedByLimit,
    awaitingUserAnswer,
    lastAssistantId,
    terminalKind: endTerminalKind,
  };
}

