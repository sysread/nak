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
import { createBroadcastPublisher } from './broadcast.ts';
import { getStreamingCompletion } from './getStreamingCompletion.ts';
import {
  performToolCall,
  ToolNotImplementedError,
  type ToolContext,
} from './performToolCall.ts';

// Magic flag the ask_user tool returns to suspend the round chain
// pending a user answer. Mirrors src/lib/tools/ask_user.ts'
// ASK_USER_PENDING_FLAG. Duplicated here so the function does not
// have to drag the browser's tool module in.
const ASK_USER_PENDING_FLAG = '__ask_user_pending__';

// Hard cap on rounds before we treat the turn as runaway. Mirrors
// the browser-side MAX_ROUNDS guardrail.
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
      return JSON.stringify(result.value ?? null);
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
   * Full Venice wire body for the first round. Already shaped by the
   * browser via buildChatBody; the orchestrator copies it round-to-
   * round, mutating only `messages` between rounds.
   */
  bodyTemplate: VeniceWireBody;
  /** Admin Supabase client (service role) for DB writes and Realtime. */
  adminClient: SupabaseClient;
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
  const ctl = new AbortController();
  const wallTimeoutMs = opts.wallDeadlineMs ?? WALL_DEADLINE_MS;
  const wallTimer = setTimeout(() => ctl.abort(), wallTimeoutMs);

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
    await publisher.publish({ type: 'BEGIN' });

    roundLoop: for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (ctl.signal.aborted) {
        terminalKind = 'aborted';
        break;
      }
      body = { ...body, messages: history };

      let roundHadToolCalls = false;
      const roundToolCalls: ToolCallRequest[] = [];
      // Tracks the round's assistant content so we can carry the
      // tool_calls row into history at the end of the round. accum
      // resets between rounds; this var preserves only the just-
      // finished round's text.
      let roundText = '';

      for await (const ev of getStreamingCompletion({
        apiKey: opts.apiKey,
        body,
        signal: ctl.signal,
      })) {
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
            break roundLoop;
          }
          default:
            // BEGIN / DONE / rate_limit_* / guard_retry pass-through;
            // no orchestrator state to update.
            break;
        }
      }

      if (ctl.signal.aborted) {
        terminalKind = 'aborted';
        break;
      }

      if (!roundHadToolCalls) {
        // Terminal round: model finished without calling tools.
        break;
      }

      // Tool dispatch. Run them in parallel; collect outcomes.
      const ctx: ToolContext = {
        adminClient: opts.adminClient,
        userId: opts.userId,
        threadId: opts.threadId,
        signal: ctl.signal,
        depth: 0,
      };

      const outcomes = await Promise.all(
        roundToolCalls.map((tc) => runOneToolCall(tc, ctx)),
      );

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
          result_summary: summary,
        });
      }

      // Persist the assistant-with-tool-calls row for this round, then
      // one tool-result row per call. Order matters for replay.
      const assistantRoundRow = await persistRoundAssistantRow(
        opts,
        roundText,
        roundToolCalls,
      );
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
      lastUpdateContent = '';
      if (assistantRowId !== null) {
        // RLS OFF: filter by id only.
        await opts.adminClient
          .from('messages')
          .update({ content: '' })
          .eq('id', assistantRowId);
      }

      if (suspendIdx !== -1) {
        terminalKind = 'suspended_for_ask_user';
        break;
      }

      // Suppress unused warning for the assistant-row-of-this-round
      // reference - we capture it for the side-effect persistence,
      // but the orchestrator's streaming row is separate.
      void assistantRoundRow;
    }
  } catch (err) {
    terminalKind = 'error';
    terminalDetail = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(wallTimer);
    if (rowUpdateTimer !== null) clearTimeout(rowUpdateTimer);

    await flushRowUpdate();
    await publisher.flush();

    // Terminal write: commit to 'complete' via the SECURITY DEFINER
    // RPC on the happy path; otherwise transition the row to the
    // matching terminal status directly via UPDATE.
    let persistedId = assistantRowId ?? '';
    let conflict: string | undefined;
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
          },
        );
        if (error) {
          terminalKind = 'error';
          terminalDetail = error.message;
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

    const endEvent: OrchestratorEvent = {
      type: 'END',
      persistedAssistantId: persistedId,
      terminalKind,
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
 */
async function persistRoundAssistantRow(
  opts: OrchestratorOpts,
  text: string,
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
      ctl.abort();
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

