// getStreamingResponse --------------------------------------------------------
//
// Composition layer for the streaming-root migration. The /stream
// handler validates a request, kicks this off via
// EdgeRuntime.waitUntil(), and returns its envelope synchronously;
// this function runs the full streaming chat turn detached from the
// HTTP request, surviving browser disconnect by design.
//
// Owns:
//   - Round loop. One Venice completion per round; each
//     tool_call_request fans out via performToolCall, the results
//     ride into the next round's history baton.
//   - Assistant row lifecycle. Created at first content delta with
//     status='streaming'; debounced content UPDATE every ~500ms so
//     reconnecting clients can read completed-so-far state directly
//     off the row. Terminal commit via the SECURITY DEFINER
//     commit_assistant_message RPC, which runs the same
//     conflict-against-newer-user-message check add_assistant_message
//     does and atomically transitions status to 'complete'.
//   - Tool-result rows. One per tool call, role='tool', with the
//     standard {ok, value} | {error} encoded content shape so the
//     model sees the same payload on the next round it would have
//     seen on the browser-side path.
//   - Live event publishing. Adaptive-buffered publisher writes to
//     the thread:<id>:stream Broadcast channel; the browser
//     subscriber consumes the union as if it were native SSE.
//   - Control channel. Subscribes to thread:<id>:control for
//     {type:'cancel'} events; on cancel, aborts the internal signal
//     so the in-flight Venice fetch and any running tool calls tear
//     down, persists partial state with status='aborted', publishes
//     END(aborted), exits.
//   - Wall-time guard. The Supabase edge runtime kills functions at
//     400s; we set our own deadline a generous margin earlier so we
//     have time to flush, persist 'error', and publish END before
//     Deno cuts us off.
//
// Never throws to its caller. Failures are surfaced as END events
// with terminalKind='error' so the /stream handler's
// EdgeRuntime.waitUntil() can treat the whole thing as fire-and-
// forget; the row itself records the outcome.

import { type SupabaseClient } from '@supabase/supabase-js';
import {
  controlChannelName,
  type OrchestratorEvent,
  streamChannelName,
  type TerminalKind,
  type ToolCallRequest,
  type TokenUsage,
  type VeniceCitation,
  withInterruptedMarker,
} from '../_shared/venice-stream.ts';
import {
  packLastError,
  translateError,
  type TranslateInput,
  type TranslatedErrorKind,
} from '../_shared/error-translate.ts';
import { createBroadcastPublisher } from './broadcast.ts';
import { getStreamingCompletion } from './getStreamingCompletion.ts';
import {
  performToolCall,
  ToolNotImplementedError,
  type ToolContext,
} from './performToolCall.ts';
import { VeniceError } from '../_shared/venice.ts';
import {
  base64ToBytes,
  extractGeneratedImage,
  stripGeneratedImage,
  type GeneratedImagePayload,
} from './tools/_generated_image.ts';
import { reflectOneThread } from './agents/reflection.ts';
import { curateOnTurnTail } from './agents/curation.ts';
import { samskaraOnTurnTail } from './agents/samskara.ts';
import { secondThoughtsOnTurnTail } from './agents/second_thoughts.ts';
import { createEdgeLogger } from '../_shared/edge-log.ts';
import { runServerPriming, type PrimingInputs } from './priming.ts';

// Magic flag the ask_user tool returns to suspend the round chain
// pending a user answer. Mirrors src/lib/tools/ask_user.ts'
// ASK_USER_PENDING_FLAG. Duplicated here so the function does not
// have to drag the browser's tool module in.
const ASK_USER_PENDING_FLAG = '__ask_user_pending__';

// Hard cap on rounds before we treat the turn as runaway. Single-
// source guardrail now - the browser-side round loop is collapsed
// onto this orchestrator, so there's no second copy of the constant
// to keep in sync. The terminal-round model response counts as a
// round, so the wire-budget is `MAX_ROUNDS - 1` tool-using rounds
// followed by one text-only round. Hitting MAX_ROUNDS with every
// round still calling tools is the "runaway" terminal: the loop
// exits naturally, the END event carries conflict='round_limit',
// and the browser surfaces the round-limit banner.
const MAX_ROUNDS = 24;

// How often (ms) we UPDATE the streaming row's content with the
// accumulated buffer. Coarser than the Broadcast publish cadence on
// purpose: the row is the resume state, not the live stream. A
// debounced 500ms cadence gives reconnecting clients near-current
// state while keeping the per-turn DB write rate at a couple per
// second even on a fast model.
const ROW_UPDATE_MS = 500;

// Wall-time deadline. Supabase Edge Functions kill the isolate at
// 400s; we trip our own abort ~20s before that so we have time to
// flush the publisher, persist 'error' status, and emit END.
const WALL_DEADLINE_MS = 380_000;

// Bound the tool-result summary that rides on Broadcast tool_call_response
// events. The full payload lives on the tool-result row; the summary is
// for the in-stream UI affordance only.
const TOOL_RESULT_SUMMARY_CHARS = 200;

// Tool-result row content shape used everywhere. Mirrors the browser's
// encodeToolContent so the model sees the same wire payload on either
// path.
type EncodedToolResult =
  | { ok: true; value: unknown }
  | { ok: false; error: Error };

function encodeToolContent(result: EncodedToolResult): string {
  if (result.ok) {
    try {
      // Strip the generate_image heavy payload before encoding. The
      // ~700KB base64 blob lives on the tool outcome only long enough
      // for the orchestrator to harvest it for the end-of-turn
      // attachment write; the model-visible tool row carries only the
      // compact descriptor so it does not replay into context every
      // round. stripGeneratedImage is a no-op for non-image results.
      const stripped = stripGeneratedImage(result.value);
      return JSON.stringify(stripped ?? null);
    } catch {
      return JSON.stringify({ error: 'result not serializable' });
    }
  }
  return JSON.stringify({
    error: result.error.message || String(result.error),
  });
}

// Minimal subset of the Venice request body the orchestrator reads
// directly. Everything else passes through to getStreamingCompletion
// unchanged.
interface VeniceWireBody extends Record<string, unknown> {
  model?: string;
  messages?: VeniceMessage[];
}

interface VeniceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface OrchestratorOpts {
  /** Venice API key (resolved from app_config by the /stream handler). */
  apiKey: string;
  threadId: string;
  /** Anchor user-message id this turn is responding to. */
  userMessageId: string;
  /** Authoritative user id from the gateway-verified JWT. */
  userId: string;
  /**
   * Regenerate-from-here replace range (uuid-validated by the /stream
   * handler). Rides into the terminal commit RPC, which excludes these
   * rows from its newer-user-message conflict check and deletes them
   * atomically with the commit. Empty/absent on plain sends.
   */
  supersededIds?: readonly string[];
  /**
   * Full Venice wire body for the first round. Already shaped by the
   * browser via buildChatBody; the orchestrator copies it round-to-
   * round, mutating only `messages` between rounds.
   */
  bodyTemplate: VeniceWireBody;
  /** Admin Supabase client (service role) for DB writes and Realtime. */
  adminClient: SupabaseClient;
  /**
   * Turn-entry priming inputs (intuition model/mood, context-recall
   * gate) forwarded from the /stream request body. The priming stage
   * consumes them before the first round; absent leaves each pipeline
   * at its disabled/cold default.
   */
  priming?: PrimingInputs;
  /**
   * Override the wall deadline for tests so the suite is not slow.
   * Defaults to WALL_DEADLINE_MS.
   */
  wallDeadlineMs?: number;
}

/**
 * Run the full streaming chat turn end-to-end. Never throws.
 * Resolves when the assistant row is in a terminal state and END has
 * been published.
 */
export async function getStreamingResponse(
  opts: OrchestratorOpts,
): Promise<void> {
  // Local-dev liveness markers. Pair every start with an end so a
  // dev-start terminal scan reveals whether the orchestrator
  // completed or got killed mid-flight (the supabase-edge-runtime
  // "early termination has been triggered" warning lands between
  // them when the local isolate gets recycled out from under
  // EdgeRuntime.waitUntil).
  const runId = `${opts.threadId.slice(0, 8)}/${Date.now().toString(36)}`;
  // Drawer-visible operational log for the turn. The browser already
  // renders the CONTENT events off the stream channel; this logger
  // carries the operational layer (rounds, tool dispatch, retries,
  // terminal kind) to the Logs drawer under the 'stream' source -
  // named for the /stream route, and distinct from the browser-side
  // 'chat' source's main-screen one-offs. The console mirror inside
  // the logger keeps the local-dev terminal breadcrumbs these lines
  // used to be. runId stays in each message as the per-turn
  // correlator.
  const log = createEdgeLogger(opts.userId, 'stream');
  log.debug(
    `${runId} start model=${opts.bodyTemplate.model ?? 'unknown'} toolsLen=${Array.isArray(opts.bodyTemplate.tools) ? opts.bodyTemplate.tools.length : 0}`,
  );
  // Optional raw-SSE-frame dump for dev. When NAK_DUMP_STREAM is set,
  // each round's frames + parsed deltas land at /tmp/nak-venice-
  // <runId>.log so we can see what Venice actually sent when the
  // round produces nothing structured the orchestrator can act on.
  // Off in production: a missing env var leaves dumpPath null and
  // streamFromVenice skips every dump write.
  const dumpPath =
    Deno.env.get('NAK_DUMP_STREAM') === '1'
      ? `/tmp/nak-venice-${runId.replace('/', '-')}.log`
      : null;
  if (dumpPath !== null) {
    log.debug(`${runId} dumping raw SSE to ${dumpPath}`);
  }
  // Shared abort controller. Two sources can fire it: the wall-deadline
  // timer (this turn ran out of wall-clock budget) and the control
  // channel's 'cancel' event (the user clicked stop). The reason
  // string differentiates: 'wall_timeout' routes the terminal to
  // status='error' with the matching detail, anything else (today,
  // the literal 'user_cancel' string the control-channel handler
  // passes) routes to status='aborted' with the INTERRUPTED_MARKER
  // appended. Without the differentiation a wall timeout looked
  // exactly like a user cancel - same terminal, same UI affordance -
  // and the row carried a marker that read as a deliberate stop.
  const WALL_TIMEOUT_REASON = 'wall_timeout';
  const ctl = new AbortController();
  const wallTimeoutMs = opts.wallDeadlineMs ?? WALL_DEADLINE_MS;
  const wallTimer = setTimeout(
    () => ctl.abort(WALL_TIMEOUT_REASON),
    wallTimeoutMs,
  );

  const channels = await setupChannels(opts, ctl);
  const publisher = createBroadcastPublisher({
    channel: channels.streamChannel,
  });

  let assistantRowId: string | null = null;
  let rowUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let lastUpdateContent = '';

  const accum = {
    content: '',
    reasoning: '',
    usage: null as TokenUsage | null,
    citations: [] as VeniceCitation[],
  };

  // Citations harvested from successful tool results across every
  // round of the turn. web_search's `{answer, citations}` result is
  // the main contributor; any other tool that returns a
  // `{citations: [...]}` field also flows in here. Used as the
  // fallback citations source at terminal commit when Venice-native
  // citations (accum.citations) didn't fire - the chat-loop sends
  // requests without enable_web_search, so accum.citations is empty
  // in practice and tool citations are the only source.
  const toolCitations: VeniceCitation[] = [];

  let terminalKind: TerminalKind = 'completed';
  let terminalDetail: string | undefined;
  // Per-turn round counter. Set at the top of each iteration so it
  // reflects the count of rounds the orchestrator started, regardless
  // of how the loop exited (break vs natural terminus). Reported on
  // the END event so the browser can render round-aware affordances
  // (the round-limit banner is keyed off the round-limit terminal,
  // but consumers also use the count for
  // exchange-level metrics).
  let roundsRun = 0;
  // Distinguishes "natural for-loop exhaustion" (round_limit hit)
  // from "broke out via tools-done / suspend / abort / error" (every
  // other exit). The for-loop's counter is hoisted to function scope
  // so this comparison survives the loop exit.
  let round = 0;
  // Set when the END event needs to carry an additional reason: the
  // commit_assistant_message RPC's conflict reason ('newer_user_message',
  // 'anchor_missing', ...), or the synthetic 'round_limit' the
  // orchestrator emits on natural for-loop exhaustion. The browser
  // dispatches off this to pick between "stopped at round limit" and
  // "conversation changed under us".
  let conflict: string | undefined;
  // Structured input for translateError() at the terminal-write block.
  // Each error source (VeniceError throw, wall_timeout abort, round-limit
  // detection, commit conflict, RPC error) populates this before
  // breaking / returning so the terminal-write block can build the
  // user-facing payload in one place. Null when the turn completed
  // successfully - the terminal write skips threads.last_error in that
  // case and commit_assistant_message clears any prior error column.
  let lastErrorInput: TranslateInput | null = null;

  // RLS OFF: filter by userId. Lazily create the assistant row on
  // the first content event; subsequent events UPDATE it via the
  // debounced timer below.
  async function ensureAssistantRow(): Promise<void> {
    if (assistantRowId !== null) return;
    const { data, error } = await opts.adminClient
      .from('messages')
      .insert({
        thread_id: opts.threadId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        model: opts.bodyTemplate.model ?? null,
      })
      .select('id')
      .single();
    if (error || !data) {
      throw new Error(
        `Failed to create streaming assistant row: ${
          error?.message ?? 'no row returned'
        }`,
      );
    }
    assistantRowId = data.id as string;
  }

  function scheduleRowUpdate(): void {
    if (rowUpdateTimer !== null) return;
    rowUpdateTimer = setTimeout(() => {
      rowUpdateTimer = null;
      // Fire-and-forget; if the UPDATE fails, the terminal commit
      // still writes the full content. The streaming row is a
      // convenience for reconnect, not the canonical record.
      void flushRowUpdate();
    }, ROW_UPDATE_MS);
  }

  async function flushRowUpdate(): Promise<void> {
    if (assistantRowId === null) return;
    if (accum.content === lastUpdateContent) return;
    const snapshot = accum.content;
    // RLS OFF: filter by id only since the row is uniquely owned by
    // the (threadId, status='streaming') we created above.
    const { error } = await opts.adminClient
      .from('messages')
      .update({ content: snapshot })
      .eq('id', assistantRowId);
    if (!error) lastUpdateContent = snapshot;
    // Swallow update errors - terminal commit is the canonical
    // recording.
  }

  // The active round body. We replace `messages` between rounds with
  // the accumulated history plus the just-finished round's assistant
  // + tool-result rows.
  let body: VeniceWireBody = { ...opts.bodyTemplate };
  let history: VeniceMessage[] = [...(opts.bodyTemplate.messages ?? [])];

  try {
    // In-flight stamp, before anything else. The streaming assistant
    // row (the reconnect probe's other signal) is only created at the
    // first content delta, so the priming stage below - plus any long
    // reasoning-only stretch before the model emits text - would
    // otherwise be invisible to a reconnecting browser: a page refresh
    // during that window found no streaming row, concluded no turn was
    // running, and surfaced the "response was interrupted" retry
    // banners for a turn that was still alive under waitUntil. The
    // stamp is cleared in the finally after the terminal write;
    // resolveStreamContext treats a fresh stamp as in-flight when no
    // streaming row exists yet. Best-effort: a failed write degrades
    // to the old blind window, it must not break the turn.
    try {
      // RLS OFF: filter by threadId (ownership was verified by the
      // /stream handler before the orchestrator started).
      await opts.adminClient
        .from('threads')
        .update({ stream_started_at: new Date().toISOString() })
        .eq('id', opts.threadId);
    } catch (err) {
      log.error(`${runId} failed to stamp stream_started_at:`, err);
    }

    // Turn-entry priming, before the first round. Runs server-side so
    // it survives browser disconnect under the same waitUntil as the
    // streaming loop. Assembles the bias system-prompt appendix and the
    // samskara/context-recall/intuition <think> chain onto `history`,
    // and publishes the priming liveness + payload events the browser
    // renders as the subconscious spinner + Intuition/Recall modals.
    // Never throws - every pipeline swallows its own errors so a priming
    // hiccup degrades to "less context this turn," never a broken turn.
    await runServerPriming({
      adminClient: opts.adminClient,
      userId: opts.userId,
      threadId: opts.threadId,
      apiKey: opts.apiKey,
      history,
      publisher,
      priming: opts.priming,
      signal: ctl.signal,
      runId,
    });

    await publisher.publish({ type: 'BEGIN' });

    roundLoop: for (round = 0; round < MAX_ROUNDS; round += 1) {
      // Count this round as run the instant we enter it. A break
      // inside the body short-circuits the for-loop's increment, so
      // the post-loop "did we exit naturally?" check uses `round`,
      // not `roundsRun` - roundsRun is the metric, `round` is the
      // sentinel.
      roundsRun = round + 1;
      if (ctl.signal.aborted) {
        // Wall-deadline aborts route to 'error' so the row's terminal
        // status carries the timeout cause; user cancels route to
        // 'aborted' (which appends INTERRUPTED_MARKER in the terminal
        // write block, the expected UX for a deliberate stop). The
        // same two-line decision appears at the post-stream abort
        // check below - kept inline because the helper-extracted
        // shape doesn't earn its keep for ten lines used twice, and
        // TS narrowing on `let terminalKind` doesn't track assignments
        // through nested closures.
        if (ctl.signal.reason === WALL_TIMEOUT_REASON) {
          terminalKind = 'error';
          terminalDetail = 'wall timeout';
          lastErrorInput = { kind: 'wall_timeout' };
        } else {
          terminalKind = 'aborted';
        }
        break;
      }
      body = { ...body, messages: history };
      log.debug(`${runId} round ${round} historyLen=${history.length}`);

      let roundHadToolCalls = false;
      const roundToolCalls: ToolCallRequest[] = [];
      // Tracks the round's assistant content so we can carry the
      // tool_calls row into history at the end of the round. accum
      // resets between rounds; this var preserves only the just-
      // finished round's text.
      let roundText = '';
      // Per-round event tally for the dev-start terminal so we can
      // see what the stream actually delivered when the round
      // produces no usable output. Cheap; bounded by the number of
      // distinct event types.
      const eventTally: Record<string, number> = {};
      let roundFinishReason: string | null = null;

      for await (const ev of getStreamingCompletion({
        apiKey: opts.apiKey,
        body,
        signal: ctl.signal,
        ...(dumpPath !== null ? { rawFrameDumpPath: dumpPath } : {}),
      })) {
        eventTally[ev.type] = (eventTally[ev.type] ?? 0) + 1;
        // Republish content + signal events to the Broadcast channel
        // verbatim. Orchestrator-added events (tool_call_response /
        // END) are emitted later; everything else flows through.
        await publisher.publish(ev);

        switch (ev.type) {
          case 'response_text': {
            accum.content += ev.content;
            roundText += ev.content;
            await ensureAssistantRow();
            scheduleRowUpdate();
            break;
          }
          case 'reasoning_text': {
            accum.reasoning += ev.content;
            break;
          }
          case 'tool_call_request': {
            roundHadToolCalls = true;
            roundToolCalls.push(ev.request);
            break;
          }
          case 'usage': {
            accum.usage = ev.usage;
            break;
          }
          case 'citations': {
            // The model emits citations once at first frame; we hold
            // the latest seen across rounds so the terminal commit
            // carries the harvested set.
            accum.citations = ev.citations;
            break;
          }
          case 'error': {
            terminalKind = 'error';
            terminalDetail = ev.message;
            // The StreamSignal carries the typed VeniceErrorKind that
            // the completion consumer mapped from the response. Pass
            // through as the translate kind - the 'truncated' kind is
            // shared by both unions; the others are subsets. Special-
            // case GuardExhaustedError: it surfaces from the completion
            // path as kind='internal' with a "Stream guard ..." prefix
            // (see errorEventFor in getStreamingCompletion.ts). The
            // translator's 'internal' bucket folds the raw jargon
            // into the user-facing prose, which leaks "special-token-
            // leak" diagnostics. Detect the prefix here and route to
            // the dedicated 'guard_exhausted' kind instead so the
            // translator can produce a humane sentence without naming
            // the guard.
            const isGuardExhausted = ev.message.startsWith('Stream guard "');
            lastErrorInput = {
              kind: isGuardExhausted ? 'guard_exhausted' : (ev.kind as TranslatedErrorKind),
              rawMessage: ev.message,
            };
            log.error(
              `${runId} round ${round} venice error kind=${ev.kind}: ${ev.message}`,
            );
            break roundLoop;
          }
          case 'stream_retry': {
            log.warn(
              `${runId} round ${round} truncated stream, retry attempt ${ev.attempt}`,
            );
            // Transport-layer retry from withRateLimitRetry's
            // truncation branch: the upstream SSE cut without a
            // [DONE] sentinel and the wrapper is re-issuing. Reset
            // this round's accumulators so the new attempt's stream
            // doesn't append to the cut-off prefix - the assembler
            // is fresh per attempt, the consumer's accum needs to
            // match. Tool citations from earlier rounds stay; this
            // only discards what THIS attempt of THIS round produced.
            accum.content = '';
            accum.reasoning = '';
            roundText = '';
            // Schedule a row UPDATE so reconnecting clients don't
            // see a partial buffer that's about to be replaced.
            // No-op when assistantRowId is still null (we hadn't
            // started writing yet).
            if (assistantRowId !== null) {
              lastUpdateContent = '';
              await opts.adminClient
                .from('messages')
                .update({ content: '' })
                .eq('id', assistantRowId);
            }
            break;
          }
          default:
            // BEGIN / DONE / rate_limit_* / guard_retry pass-through;
            // no orchestrator state to update beyond the drawer
            // breadcrumbs for the retry-shaped signals. DONE carries
            // the finish_reason from the SSE stream; capture it for
            // the round summary log below.
            if (ev.type === 'DONE') roundFinishReason = ev.finishReason;
            if (ev.type === 'rate_limit_wait') {
              log.warn(
                `${runId} round ${round} rate-limited, retrying in ${ev.retryAfterMs}ms (attempt ${ev.attempt})`,
              );
            }
            if (ev.type === 'guard_retry') {
              log.warn(`${runId} round ${round} output-guard retry: ${ev.reason}`);
            }
            break;
        }
      }

      const reasoningPreview =
        accum.reasoning.length > 0
          ? ` reasoningHead=${JSON.stringify(accum.reasoning.slice(0, 200))}`
          : '';
      log.debug(
        `${runId} round ${round} events: ${Object.entries(eventTally).map(([k, v]) => `${k}=${v}`).join(' ')} contentLen=${accum.content.length} reasoningLen=${accum.reasoning.length} finishReason=${roundFinishReason ?? 'null'}${reasoningPreview}`,
      );

      if (ctl.signal.aborted) {
        // Same wall-timeout-vs-cancel split as the top-of-iteration
        // check above; the stream consumer's for-await ended either
        // because the SSE source completed or because the abort tore
        // the fetch reader down. Either way, the abort reason wins.
        if (ctl.signal.reason === WALL_TIMEOUT_REASON) {
          terminalKind = 'error';
          terminalDetail = 'wall timeout';
          lastErrorInput = { kind: 'wall_timeout' };
        } else {
          terminalKind = 'aborted';
        }
        break;
      }

      if (!roundHadToolCalls) {
        // Terminal round: model finished without calling tools.
        break;
      }

      // Persist the assistant-with-tool-calls row BEFORE dispatching
      // the tools, so the realtime INSERT lands while the dispatch is
      // still running. The browser's ToolCalls component renders off
      // `message.tool_calls`, so persisting after dispatch + after the
      // tool_call_response broadcast would make the card materialize
      // all at once with the result already incorporated - no visible
      // live spinner during execution. Persisting first lets the card
      // paint with the timing pill already ticking (driven by the
      // `tool_call_request` broadcast event that already fired during
      // the for-await above and stamped `slot.toolTimings[id].startedAt`).
      const assistantRoundRow = await persistRoundAssistantRow(
        opts,
        roundText,
        accum.reasoning,
        roundToolCalls,
      );

      // Round-boundary signal. The round's assistant content (text +
      // reasoning) is final the moment its completion stream ends and the
      // row is persisted, so tell the browser now - before tool dispatch,
      // which can run for seconds - so it resets its live streaming
      // buffers and hands off to this persisted row instead of carrying
      // this round's text into the next round's bubble. The browser no
      // longer owns the round loop and has no other way to detect the
      // boundary. Published through the publisher's prompt path (a
      // non-text event), so any text still buffered for this round
      // flushes ahead of it and the reset never races the deltas it
      // follows.
      await publisher.publish({
        type: 'assistant_round_committed',
        id: assistantRoundRow.id,
      });

      // Tool dispatch. Run them in parallel; collect outcomes.
      const ctx: ToolContext = {
        adminClient: opts.adminClient,
        userId: opts.userId,
        threadId: opts.threadId,
        signal: ctl.signal,
        depth: 0,
      };

      // Tool dispatch is the operational heart of the turn - these two
      // lines ride at info so the drawer's default level shows which
      // tools each round ran and how they fared.
      log.info(
        `${runId} round ${round} dispatching ${roundToolCalls.length} tool call(s): ${roundToolCalls.map((tc) => tc.name).join(', ')}`,
      );
      const outcomes = await Promise.all(
        roundToolCalls.map((tc) => runOneToolCall(tc, ctx)),
      );
      log.info(
        `${runId} round ${round} outcomes: ${outcomes.map((o) => `${o.request.name}=${o.ok ? 'ok' : 'err'}`).join(', ')}`,
      );
      // Failed dispatches get their reason in the drawer; the model
      // sees the same text in its tool-result row next round.
      for (const o of outcomes) {
        if (!o.ok) {
          log.error(`${runId} round ${round} ${o.request.name} failed: ${o.errorMessage}`);
        }
      }

      // Harvest generated-image payloads off any tool result before
      // persistRoundToolResults strips them at encode time. Failed
      // outcomes carry the error shape, not a generated image, so we
      // skip them; the structural extractor handles tool results that
      // simply don't have an image (most calls).
      //
      // Persist mid-round: attach the images to THIS round's
      // assistant-with-tool-calls row immediately so a subsequent
      // round's tool that resolves by filename (recipe_photos_attach,
      // analyze_image) can find the row in message_attachments. The
      // earlier shape deferred attachment to the terminal commit at
      // end-of-turn, which broke same-turn referential lookups - a
      // generate_image -> recipe_photos_attach sequence in a single
      // turn would error "not in this thread" because the
      // message_attachments row didn't exist yet when the second
      // tool's filename lookup ran. Per-round attachment fixes that
      // without changing browser-side behaviour: AssistantBody's
      // MessageAttachments renders from message.attachments either
      // way, and the realtime UPDATE on the assistant row already
      // triggers a listAttachmentsByMessageIds re-hydration so the
      // images land in the bubble at commit time. Best-effort: a
      // failure inside attachGeneratedImages logs but doesn't abort
      // the round - the model's prose still references the filename,
      // so the user knows what was produced even when storage is
      // misbehaving.
      const roundImages: GeneratedImagePayload[] = [];
      for (const o of outcomes) {
        if (!o.ok) continue;
        const img = extractGeneratedImage(o.result);
        if (img) roundImages.push(img);
      }
      if (roundImages.length > 0) {
        await attachGeneratedImages(
          opts.adminClient,
          opts.userId,
          assistantRoundRow.id,
          roundImages,
        );
      }
      // The terminal-commit path's attachGeneratedImages call has been
      // retired in favour of this per-round attachment. generate_image
      // can only fire in a round that issued tool_calls (a terminal
      // round has none by definition), so every harvested image
      // belongs to a non-terminal round and gets its message-row
      // anchor here.

      // Detect ask_user suspend: any pending sentinel halts the round
      // chain.
      const suspendIdx = outcomes.findIndex((o) =>
        isAskUserPending(o.result),
      );

      // Harvest citations off any tool result that carries them
      // (web_search, research_docs, etc.). Each gets a running 1-based
      // index continuing from prior rounds so the assistant row's
      // ^N^ superscripts can resolve to a contiguous citation list.
      // Skipped for failed outcomes - their result is the error
      // shape, not a citation-bearing payload.
      for (const o of outcomes) {
        if (!o.ok) continue;
        const extracted = extractToolCitations(o.result);
        for (const cite of extracted) {
          toolCitations.push({
            ...cite,
            index: toolCitations.length + 1,
          });
        }
      }

      // Publish tool_call_response events on the channel so the UI
      // can update its tool-call panel as each lands. Summary only;
      // the full payload lives on the persisted tool-result row.
      for (const o of outcomes) {
        const summaryPayload = o.ok
          ? { ok: true, value: o.result }
          : { ok: false, error: { message: o.errorMessage } };
        let summary: string;
        try {
          summary = JSON.stringify(summaryPayload).slice(
            0,
            TOOL_RESULT_SUMMARY_CHARS,
          );
        } catch {
          summary = '{"error":"result not serializable"}';
        }
        await publisher.publish({
          type: 'tool_call_response',
          id: o.request.id,
          name: o.request.name,
          ok: o.ok,
          result_summary: summary,
        });
      }

      // Tool-result rows persist after dispatch + the
      // tool_call_response broadcast. The result rows feed the model
      // on the next round's history and also drive the expanded
      // detail view in ToolCalls; the live status pill keys off
      // slot.toolTimings (set by tool_call_request/response) so the
      // card stays live independent of the result row's INSERT
      // latency.
      const toolResultRows = await persistRoundToolResults(
        opts,
        outcomes,
        suspendIdx,
      );

      // Append to history for the next round.
      history.push({
        role: 'assistant',
        content: roundText,
        tool_calls: roundToolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        })),
      });
      for (const trr of toolResultRows) {
        history.push({
          role: 'tool',
          tool_call_id: trr.tool_call_id,
          name: trr.name,
          content: trr.content,
        });
      }

      // Per-round content/reasoning accumulators reset; tool-call
      // round produced a non-terminal assistant row but the streaming
      // row's UPDATE target advances to the NEXT round's content
      // only.
      accum.content = '';
      accum.reasoning = '';
      roundText = '';

      // Avoid the streaming row drifting: archive the tool-using
      // assistant row separately (above) and let the NEXT terminal
      // round commit the streaming row to 'complete'. The streaming
      // row content stays empty until the next round produces text.
      //
      // Re-stamp created_at to now() in the same UPDATE. The streaming
      // row was born on the first response_text of the turn
      // (ensureAssistantRow); when the model narrates a preamble before
      // calling tools, that birth is EARLIER than the tool-result rows
      // this round just persisted. The terminal commit reuses this same
      // row id and commit_assistant_message never touches created_at, so
      // an un-restamped row carries that early timestamp and sorts the
      // final response card AHEAD of the tool cards in any created_at-
      // ordered view (mergeMessagesById on thread switch, listMessages on
      // refetch). The live arrival-order view looks right, then the
      // response jumps to the front of the round on the first re-sort.
      // Bumping the timestamp at the boundary - after this round's tool
      // rows are already persisted - keeps the eventual terminal row
      // chronologically after them. A row that was never carried across a
      // boundary (model called tools with no preamble text, so
      // ensureAssistantRow first fired in the terminal round) is born
      // after the tools and needs no fix; this path only runs when the
      // row already exists at a boundary.
      lastUpdateContent = '';
      if (assistantRowId !== null) {
        // RLS OFF: filter by id only.
        await opts.adminClient
          .from('messages')
          .update({ content: '', created_at: new Date().toISOString() })
          .eq('id', assistantRowId);
      }

      if (suspendIdx !== -1) {
        terminalKind = 'suspended_for_ask_user';
        break;
      }
    }

    // Round-limit terminal. If `round === MAX_ROUNDS` the for-loop
    // exhausted its counter without any break statement firing - which
    // only happens when every round (including the last) called tools
    // and the model was about to call more. The accumulator at this
    // point is whatever the last terminal-eligible round produced
    // (empty when the model only emits tool_calls + reasoning in
    // every round). Without this branch, terminalKind stays at its
    // 'completed' default and the commit_assistant_message RPC happily
    // writes an empty assistant bubble - the model never got the
    // round to write a real response. We flag the terminal as 'error'
    // with conflict='round_limit' so the END routing browser-side
    // surfaces the round-limit banner instead of silently shipping
    // an empty reply.
    if (round === MAX_ROUNDS && terminalKind === 'completed') {
      terminalKind = 'error';
      terminalDetail = 'round_limit';
      conflict = 'round_limit';
      lastErrorInput = { kind: 'round_limit' };
    }
  } catch (err) {
    // Abort-driven catches (wall timeout, user cancel) already set
    // terminalKind + detail at the inline check sites; the catch only
    // fires here because the fetch / SSE consumer surfaced the abort
    // as a thrown AbortError. Don't overwrite the pre-set terminal -
    // 'wall timeout' would otherwise lose to 'The signal has been
    // aborted' (or whatever the underlying error library spells the
    // abort message as) and the row would carry a confusing detail.
    if (!ctl.signal.aborted) {
      terminalKind = 'error';
      terminalDetail = err instanceof Error ? err.message : String(err);
      // Capture the structured cause when it's a typed VeniceError;
      // 'internal' fallback for everything else (unhandled throw is
      // almost certainly a code bug). The translator's 'internal' kind
      // folds the raw message into the user-facing prose so it's not
      // lost.
      if (err instanceof VeniceError) {
        lastErrorInput = {
          kind: err.kind as TranslatedErrorKind,
          status: err.status,
          retryAfterMs: err.retryAfterMs,
          rawMessage: err.message,
        };
      } else {
        lastErrorInput = {
          kind: 'internal',
          rawMessage: err instanceof Error ? err.message : String(err),
        };
      }
    }
    // The END event's terminalKind tells the browser the turn failed;
    // this line is the diagnostic detail (message + stack) for the
    // drawer and the function log - the orchestrator's catch is
    // otherwise silent about WHY.
    log.error(`${runId} orchestrator caught:`, err);
  } finally {
    clearTimeout(wallTimer);
    if (rowUpdateTimer !== null) clearTimeout(rowUpdateTimer);

    await flushRowUpdate();
    await publisher.flush();

    // A failure or abort that struck before any visible text left
    // assistantRowId null: ensureAssistantRow fires on the first
    // response_text, but a turn that streamed only reasoning - then the
    // stream errored, or the model "thought" without ever answering -
    // never reached that branch. Without a row the accumulated reasoning
    // (the one artifact that explains WHY the turn failed) is lost: the
    // browser clears its live buffers on the error path and has no
    // persisted card to fall back on, so the user watches the partial
    // vanish with no way to inspect it. Create the row now so the
    // partial (reasoning, plus any text) survives as a status='error' /
    // 'aborted' card. The 'completed' and 'suspended_for_ask_user'
    // terminals own their own row lifecycle.
    //
    // 'aborted' always creates the row, even with nothing accumulated:
    // a user-initiated stop is a deliberate signal that must persist as
    // a first-class 'aborted' row (the marker-only content from
    // withInterruptedMarker('')) so a second device reading the thread
    // sees the same deliberate-endpoint record this device does. Without
    // the row an early stop leaves a bare user-message tail that another
    // device can't distinguish from a crashed turn, and would offer to
    // retry. 'error' still requires something to preserve - an error row
    // with no partial has nothing to show and renders through other
    // affordances (threads.last_error), so an empty one is pure noise.
    if (
      assistantRowId === null &&
      (terminalKind === 'aborted' ||
        (terminalKind === 'error' &&
          (accum.content.length > 0 || accum.reasoning.length > 0)))
    ) {
      // Best-effort: ensureAssistantRow throws on an insert failure, and
      // this runs in the finally where a throw would escape the
      // orchestrator and mask the original terminal. Swallow - failing
      // to preserve the partial degrades to the prior behavior (the
      // card is lost), it doesn't break the turn.
      try {
        await ensureAssistantRow();
      } catch (err) {
        log.error(`${runId} failed to persist cut-off partial row:`, err);
      }
    }

    // Terminal write: commit to 'complete' via the SECURITY DEFINER
    // RPC on the happy path; otherwise transition the row to the
    // matching terminal status directly via UPDATE.
    let persistedId = assistantRowId ?? '';
    // `conflict` is function-scoped (declared up top). The round-limit
    // case sets it before the catch path runs; the commit RPC's
    // conflict-row response sets it below.
    // Citations priority: Venice-native (accum.citations, emitted by
    // the streaming completion when enable_web_search is on) outrank
    // tool-harvested citations because they pair directly to ^N^
    // superscripts the model emitted inline. Tool citations are the
    // fallback for the request shapes that DON'T enable web_search
    // (the chat-loop's default - the model reaches for web_search
    // via the tool path instead). Null when neither source fired.
    const finalCitations: VeniceCitation[] | null =
      accum.citations.length > 0
        ? accum.citations
        : toolCitations.length > 0
          ? toolCitations
          : null;
    if (assistantRowId !== null) {
      // Generated images get attached mid-round to the round's
      // assistant-with-tool-calls row immediately after dispatch (see
      // the per-round attachGeneratedImages call above) so a same-turn
      // follow-up tool that resolves by filename can find the row.
      // No end-of-turn bulk attach remains.

      if (terminalKind === 'completed') {
        const { data, error } = await opts.adminClient.rpc(
          'commit_assistant_message',
          {
            p_assistant_message_id: assistantRowId,
            p_user_message_id: opts.userMessageId,
            p_user_id: opts.userId,
            p_content: accum.content,
            p_model: opts.bodyTemplate.model ?? null,
            p_usage: accum.usage,
            p_reasoning: accum.reasoning,
            p_citations: finalCitations,
            p_superseded_ids:
              opts.supersededIds && opts.supersededIds.length > 0
                ? opts.supersededIds
                : null,
          },
        );
        if (error) {
          terminalKind = 'error';
          terminalDetail = error.message;
          lastErrorInput = {
            kind: 'internal',
            rawMessage: `commit_assistant_message RPC failed: ${error.message}`,
          };
          await transitionRowTo(
            opts.adminClient,
            assistantRowId,
            'error',
          );
        } else if (data && typeof data === 'object' && 'conflict' in data) {
          const c = data as { conflict?: boolean; reason?: string };
          if (c.conflict) {
            terminalKind = 'error';
            conflict = c.reason ?? 'unknown';
            terminalDetail = `commit_assistant_message conflict: ${conflict}`;
            lastErrorInput = {
              kind: 'commit_conflict',
              conflictReason: conflict,
            };
            await transitionRowTo(
              opts.adminClient,
              assistantRowId,
              'error',
            );
          }
        }
      } else {
        // 'aborted' | 'error' | 'suspended_for_ask_user' - flip the
        // row to the matching status with whatever content we
        // accumulated. No conflict check; the row already exists in
        // a status that no replay path would touch.
        //
        // On 'aborted' we append the interrupted marker so a stopped
        // reply reads as a deliberate stop instead of a model that
        // just happened to write a short answer. The shared helper
        // handles the empty-content case by emitting the marker
        // alone. 'error' and 'suspended_for_ask_user' rows render
        // through other affordances and don't carry the marker.
        const terminalContent =
          terminalKind === 'aborted'
            ? withInterruptedMarker(accum.content)
            : accum.content;
        await transitionRowTo(
          opts.adminClient,
          assistantRowId,
          terminalKind,
          {
            content: terminalContent,
            reasoning: accum.reasoning,
            usage: accum.usage,
            citations: finalCitations,
          },
        );
      }
    }

    // Clear the in-flight stamp now that the row (if any) carries a
    // terminal status. Ordered after the terminal write so the
    // reconnect probe never observes "no signal at all" while the
    // streaming row is still mid-transition. Best-effort: a failed
    // clear is swept by the probe's staleness janitor.
    try {
      await opts.adminClient
        .from('threads')
        .update({ stream_started_at: null })
        .eq('id', opts.threadId);
    } catch (err) {
      log.error(`${runId} failed to clear stream_started_at:`, err);
    }

    // Persistent error surface. threads.last_error is the column the
    // browser keys its error card off; commit_assistant_message clears
    // it on the happy path (see the RPC's threads update in schema.sql),
    // so we only write it on terminalKind='error'. The structured
    // lastErrorInput captured at each error source above is passed
    // through the shared translator to land a user-facing prose string
    // alongside the machine-readable kind. Best-effort: an UPDATE
    // failure here doesn't change the END event (the row's terminal
    // status is still the authoritative record), it just means the
    // error card won't render on next thread open.
    if (terminalKind === 'error') {
      // Safety net: a code path that flipped terminalKind without
      // populating lastErrorInput would otherwise skip the error card
      // entirely. Fall back to the 'internal' kind with terminalDetail
      // as the prose - the user sees "Internal error: <detail>"
      // instead of nothing, which is the right tradeoff while we
      // catch up on missed sources.
      if (!lastErrorInput) {
        lastErrorInput = {
          kind: 'internal',
          rawMessage: terminalDetail ?? 'Unknown error',
        };
      }
      const translated = translateError(lastErrorInput);
      const payload = packLastError(translated, new Date().toISOString());
      try {
        await opts.adminClient
          .from('threads')
          .update({ last_error: payload })
          .eq('id', opts.threadId);
      } catch (err) {
        log.error(`${runId} failed to write threads.last_error:`, err);
      }
    }


    const endEvent: OrchestratorEvent = {
      type: 'END',
      persistedAssistantId: persistedId,
      terminalKind,
      roundsRun,
      ...(conflict ? { conflict } : {}),
    };
    // Publish END directly; flush already drained pending text.
    try {
      await publisher.publish(endEvent);
    } catch {
      // If the channel disconnected before END could send, the row
      // status is the canonical record - reconnecting clients see
      // terminal state from the row.
    }

    publisher.dispose();
    try {
      await channels.streamChannel.unsubscribe();
    } catch {
      /* best-effort */
    }
    try {
      await channels.controlChannel.unsubscribe();
    } catch {
      /* best-effort */
    }
    // terminalDetail is captured in terminalKind + the END event;
    // referenced for future telemetry hookup.
    void terminalDetail;
    // The one per-turn info line: how the turn ended. Non-'completed'
    // kinds are the drawer's first clue that a turn aborted or errored.
    log.info(
      `${runId} end terminalKind=${terminalKind} persistedId=${persistedId || 'none'}`,
    );

    // Reflection piggyback. A completed chat turn is the trigger that
    // drains ONE day-gate-eligible OLDER thread from the reflection
    // queue (not this thread - see agents/reflection.ts for why). The
    // hourly /reflection-sweep cron route is the catch-up sibling for
    // users who stopped conversing; the per-thread claim makes the two
    // drivers safe together. Runs here in the already-detached waitUntil tail,
    // after the response shipped and the channels tore down, so it never
    // delays the user-visible turn. reflectOneThread is non-throwing and
    // logs its own outcome (to the function log + the user's Logs
    // drawer); the catch is a defensive backstop so a reflection bug
    // still can't disturb this turn's already-committed row.
    if (terminalKind === 'completed') {
      // Second-thoughts reflex, FIRST in the tail: re-read the turn we
      // just committed and write a self-doubt verdict onto the terminal
      // assistant row. The browser hydrates it via the messages UPDATE
      // echo (subscribeToMessages listens for UPDATE), so the
      // per-message slide-down lands a beat after the reply settles.
      // Ordered ahead of curation/samskara/reflection so the
      // user-visible verdict isn't starved behind reflection, which can
      // span minutes of tool rounds. Guarded on persistedId - a turn
      // that committed no assistant row (should not happen on the
      // 'completed' path, but cheap to check) has nothing to review.
      if (persistedId) {
        try {
          await secondThoughtsOnTurnTail(
            opts.adminClient,
            opts.userId,
            opts.threadId,
            opts.userMessageId,
            persistedId,
          );
        } catch (err) {
          log.error(`${runId} second-thoughts tail failed:`, err);
        }
      }
      // Curation piggyback, BEFORE reflection on purpose: the chain is
      // sequential and reflection can span minutes of tool rounds,
      // while curation is a handful of quick completions whose first
      // unit (auto-title) is the user-visible one - a brand-new
      // conversation sits on the 'New conversation' placeholder until
      // it runs. Same non-throwing contract and hourly catch-up
      // sibling (/curation-sweep) as reflection below.
      try {
        await curateOnTurnTail(opts.adminClient, opts.userId);
      } catch (err) {
        log.error(`${runId} curation tail failed:`, err);
      }
      // Samskara before reflection: reflection can span minutes of
      // tool rounds, and the samskara rotation carries the fleet's
      // only hard timing window (reaction-classify must catch a fired
      // cohort 1-10 minutes after the fire - this turn's user message
      // is what resolves the PREVIOUS turn's cohort). The hourly
      // /samskara-sweep cron is the catch-up sibling.
      try {
        await samskaraOnTurnTail(opts.adminClient, opts.userId);
      } catch (err) {
        log.error(`${runId} samskara tail failed:`, err);
      }
      try {
        await reflectOneThread(opts.adminClient, opts.userId);
      } catch (err) {
        log.error(`${runId} reflection tail failed:`, err);
      }
    }

    // Drain pending drawer broadcasts before the waitUntil promise
    // resolves - the isolate can be recycled the moment it settles,
    // and an unflushed publish would be lost (see edge-log.ts header).
    await log.flush();
  }
}

// ---------------------------------------------------------------------------
// Helpers (file-internal).
// ---------------------------------------------------------------------------

interface ToolOutcome {
  request: ToolCallRequest;
  ok: boolean;
  result: unknown;
  errorMessage: string;
}

async function runOneToolCall(
  request: ToolCallRequest,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  try {
    const result = await performToolCall(request, ctx);
    return { request, ok: true, result, errorMessage: '' };
  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : String(err);
    // ToolNotImplementedError is the common gap during migration;
    // surface it as a clear error to the model rather than crashing
    // the round.
    const reason =
      err instanceof ToolNotImplementedError
        ? `${message} (function-side tool dispatch is in migration)`
        : message;
    // Local-dev diagnostic. The tool result row carries the error
    // message back to the model on the next round, but the runtime
    // log is where a human watching the dev-start terminal will
    // notice "ah, that's why nothing's coming back."
    console.error(
      `[performToolCall] ${request.name} threw:`,
      reason,
      err instanceof Error ? err.stack : undefined,
    );
    return {
      request,
      ok: false,
      result: { error: reason },
      errorMessage: reason,
    };
  }
}

function isAskUserPending(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return (
    (value as Record<string, unknown>)[ASK_USER_PENDING_FLAG] === true
  );
}

/**
 * Insert the assistant-with-tool-calls row for one round (a non-
 * terminal round that emitted tool_calls). The streaming row stays
 * separate; this is the persistent record the next round's history
 * baton replays from.
 *
 * Carries the same `model` and `reasoning` fields the terminal
 * commit_assistant_message path writes. Both are nullable in the
 * column shape but landed empty on intermediate rounds historically -
 * the per-message context ring in AssistantBody.svelte falls back to
 * "no badge" when model is null, and reasoning text emitted during a
 * tool-call round (the model's narration of what it's about to do)
 * would silently disappear. Writing both keeps tool-call rounds
 * symmetric with terminal text rounds.
 */
async function persistRoundAssistantRow(
  opts: OrchestratorOpts,
  text: string,
  reasoning: string,
  calls: ToolCallRequest[],
): Promise<{ id: string }> {
  // RLS OFF: filter by userId via the thread relationship enforced
  // upstream when /stream resolved the threadId against the JWT's
  // user.
  const { data, error } = await opts.adminClient
    .from('messages')
    .insert({
      thread_id: opts.threadId,
      role: 'assistant',
      content: text,
      model: opts.bodyTemplate.model ?? null,
      reasoning: reasoning.length > 0 ? reasoning : null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: {
          name: c.name,
          arguments: JSON.stringify(c.args),
        },
      })),
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(
      `Failed to persist tool-calls assistant row: ${
        error?.message ?? 'no row returned'
      }`,
    );
  }
  return { id: data.id as string };
}

/**
 * Insert one tool-result row per call. Mirrors the browser's
 * encodeToolContent shape so the model sees identical payloads on
 * the next round. Honors the ask_user sibling-cancel rule: when
 * multiple ask_user calls fire in one round, only the first carries
 * the pending sentinel; the others go in as pre-cancelled answers.
 */
async function persistRoundToolResults(
  opts: OrchestratorOpts,
  outcomes: ToolOutcome[],
  suspendIdx: number,
): Promise<Array<{
  tool_call_id: string;
  name: string;
  content: string;
}>> {
  const rows: Array<{
    tool_call_id: string;
    name: string;
    content: string;
  }> = [];
  for (let i = 0; i < outcomes.length; i += 1) {
    const o = outcomes[i];
    let content: string;
    if (i === suspendIdx) {
      // First ask_user pending: carry the sentinel verbatim - the UI
      // surfaces it as an AskUserCard on reconnect.
      content = JSON.stringify(o.result);
    } else if (suspendIdx !== -1 && isAskUserPending(o.result)) {
      // Sibling ask_user calls within the same round: pre-cancel so
      // the UI never renders a second pending card.
      content = JSON.stringify({
        __ask_user_answered__: true,
        via: 'cancelled_by_sibling_ask_user',
        answer: null,
      });
    } else {
      content = encodeToolContent(
        o.ok
          ? { ok: true, value: o.result }
          : { ok: false, error: new Error(o.errorMessage) },
      );
    }
    // RLS OFF: thread ownership already verified upstream.
    const { error } = await opts.adminClient.from('messages').insert({
      thread_id: opts.threadId,
      role: 'tool',
      content,
      tool_call_id: o.request.id,
      name: o.request.name,
    });
    if (error) {
      // Tool result rows missing on the next round would leave
      // orphaned tool_call_ids on the wire; surface the failure.
      throw new Error(
        `Failed to persist tool-result row for ${o.request.name}: ${error.message}`,
      );
    }
    rows.push({
      tool_call_id: o.request.id,
      name: o.request.name,
      content,
    });
  }
  return rows;
}

/**
 * Upload one or more harvested generate_image payloads into the
 * `attachments` Storage bucket and insert message_attachments rows
 * pointing at the persisted assistant row. Mirrors
 * SupabaseService.addAttachments on the browser side: each
 * attachment gets its own UUID; the bucket path is
 * `<userId>/<attachmentId>/<filename>`; storage_path lands on the row
 * so the renderer can mint a signed URL on read.
 *
 * Best-effort end-to-end: per-image failures get logged but don't
 * abort the whole turn. The assistant row is already committed by
 * the time this runs, so partial attachment is preferable to backing
 * out the whole reply.
 */
async function attachGeneratedImages(
  admin: SupabaseClient,
  userId: string,
  messageId: string,
  images: readonly GeneratedImagePayload[],
): Promise<void> {
  interface InsertRow {
    id: string;
    message_id: string;
    position: number;
    filename: string;
    mime_type: string;
    size_bytes: number;
    storage_path: string;
    extracted_text: string | null;
  }
  const prepared: InsertRow[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i];
    const id = crypto.randomUUID();
    const path = `${userId}/${id}/${img.filename}`;
    try {
      const { error: upErr } = await admin.storage
        .from('attachments')
        .upload(path, base64ToBytes(img.data_base64), {
          contentType: img.mime_type,
          upsert: true,
        });
      if (upErr) {
        console.error(
          `[attachGeneratedImages] upload failed for ${img.filename}: ${upErr.message}`,
        );
        continue;
      }
    } catch (err) {
      console.error(
        `[attachGeneratedImages] upload threw for ${img.filename}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    prepared.push({
      id,
      message_id: messageId,
      position: i,
      filename: img.filename,
      mime_type: img.mime_type,
      size_bytes: img.size_bytes,
      storage_path: path,
      // Generated images have no extracted text - analyze_image reads
      // pixels directly when the user wants the image inspected.
      extracted_text: null,
    });
  }
  if (prepared.length === 0) return;
  // RLS OFF: thread ownership already verified upstream; the explicit
  // message_id ties the attachment to a row whose authority has
  // already been checked.
  const { error: insErr } = await admin
    .from('message_attachments')
    .insert(prepared);
  if (insErr) {
    console.error(
      `[attachGeneratedImages] insert failed: ${insErr.message}`,
    );
  }
}

/**
 * Pull `{citations: [...]}` off a tool result payload and normalise
 * each entry to `VeniceCitation` shape. Tool results that don't
 * carry citations - the common case - return [] cheaply. Entries
 * without a usable `url` are dropped because the UI renders them
 * as dead refs.
 *
 * The returned `index` is a placeholder (0); callers stamp a
 * running 1-based index as they append into the running list so
 * the inline `^N^` superscripts stay contiguous across multiple
 * tool calls.
 */
function extractToolCitations(value: unknown): VeniceCitation[] {
  if (!value || typeof value !== 'object') return [];
  const raw = (value as { citations?: unknown }).citations;
  if (!Array.isArray(raw)) return [];
  const out: VeniceCitation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.url !== 'string' || e.url.length === 0) continue;
    const cite: VeniceCitation = { index: 0, url: e.url };
    if (typeof e.title === 'string') cite.title = e.title;
    if (typeof e.content === 'string') cite.content = e.content;
    if (typeof e.date === 'string') cite.date = e.date;
    out.push(cite);
  }
  return out;
}

async function transitionRowTo(
  admin: SupabaseClient,
  rowId: string,
  status: TerminalKind | 'error' | 'aborted' | 'suspended_for_ask_user',
  fields?: {
    content?: string;
    reasoning?: string;
    usage?: TokenUsage | null;
    citations?: VeniceCitation[] | null;
  },
): Promise<void> {
  const update: Record<string, unknown> = { status };
  if (fields) {
    if (fields.content !== undefined) update.content = fields.content;
    if (fields.reasoning !== undefined) update.reasoning = fields.reasoning;
    if (fields.usage !== undefined) update.usage = fields.usage;
    if (fields.citations !== undefined) update.citations = fields.citations;
  }
  // RLS OFF: filter by id; the row was created by this function and
  // belongs to opts.userId via the thread relationship.
  await admin.from('messages').update(update).eq('id', rowId);
}

// ---------------------------------------------------------------------------
// Channel setup. Subscribes to stream + control channels and wires
// the control channel's cancel event into the orchestrator's
// AbortController.
// ---------------------------------------------------------------------------

interface ChannelHandles {
  streamChannel: ReturnType<SupabaseClient['channel']>;
  controlChannel: ReturnType<SupabaseClient['channel']>;
}

async function setupChannels(
  opts: OrchestratorOpts,
  ctl: AbortController,
): Promise<ChannelHandles> {
  // Stream channel: function publishes; browser subscribes. private:
  // true is required for the realtime.messages RLS policies in
  // supabase/schema.sql to take effect on the subscriber path.
  // service_role (this function) bypasses RLS unconditionally.
  const streamChannel = opts.adminClient.channel(
    streamChannelName(opts.threadId),
    { config: { private: true } },
  );
  await waitForJoin(streamChannel);

  const controlChannel = opts.adminClient
    .channel(controlChannelName(opts.threadId), {
      config: { private: true },
    })
    .on('broadcast', { event: 'cancel' }, () => {
      // Pass a literal reason rather than relying on a closure constant
      // here - this handler is set up by setupChannels(), one layer
      // removed from the run() caller that owns WALL_TIMEOUT_REASON /
      // USER_CANCEL_REASON. The string is matched verbatim at the
      // abort-check sites in run(); keeping the values in sync is on
      // the reader.
      ctl.abort('user_cancel');
    });
  await waitForJoin(controlChannel);

  return { streamChannel, controlChannel };
}

function waitForJoin(
  channel: ReturnType<SupabaseClient['channel']>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        reject(err ?? new Error(`Channel subscribe ${status}`));
      }
    });
  });
}

