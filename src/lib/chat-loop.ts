/**
 * Chat-loop orchestrator — runs one user turn from submission through to
 * a final assistant answer, including any tool-call rounds in between.
 *
 * One "round" = stream an assistant response → if it ended with
 * tool_calls, execute every call concurrently and append role='tool'
 * rows for each → start another round with the extended history. Loop
 * exits when an assistant response finishes with text and no
 * tool_calls, or when the MAX_ROUNDS guardrail trips.
 *
 * Split from Chat.svelte.send() so the orchestration logic is
 * unit-testable without a Svelte runtime, and so the UI (pt 4) can
 * consume a stable event stream rather than threading callbacks through
 * the component.
 *
 * Cancellation: every tool execution gets a child AbortController
 * linked to the outer `signal`. Aborting the outer cancels in-flight
 * fetch requests in both the streaming path and the tool path,
 * propagates as rejections in the per-tool promises, and those
 * rejections land as tool-result rows with error content — keeping the
 * persisted history internally consistent even on cancellation.
 *
 * Ordering of persistence within a round: assistant message first (so
 * the tool rows have a parent to reference in future replay), then
 * one tool-result row per call in the order the model returned them.
 */

import type { SupabaseService, Message, Thread } from './supabase';
import type { VeniceClient, VeniceMessage, TokenUsage } from './venice';
import {
  buildToolList,
  buildToolCatalog,
  executeToolCall,
  toggleTools,
  type OpenAIToolCall,
  type ToolContext,
} from './tools';

/** Upper bound on rounds to prevent a runaway tool-call loop. */
export const MAX_ROUNDS = 5;

/**
 * Compose a child AbortController whose `.abort()` fires whenever the
 * parent signal aborts. Used to scope per-tool cancellation under the
 * outer send() signal: aborting the send cancels every in-flight tool
 * fetch as a side effect.
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

/** Event surface consumed by the UI. Each callback is best-effort. */
export interface ChatLoopHandlers {
  /** Cumulative text for the current round; fires on every text delta. */
  onTextUpdate?(text: string): void;
  /** A tool call has been received from the model and is about to execute. */
  onToolStart?(call: OpenAIToolCall): void;
  /** A tool call resolved successfully. `result` is the parsed JS value. */
  onToolDone?(call: OpenAIToolCall, result: unknown): void;
  /** A tool call threw or was aborted. */
  onToolError?(call: OpenAIToolCall, error: Error): void;
  /** The assistant row for the current round has been written to Supabase. */
  onAssistantPersisted?(message: Message): void;
  /** A tool-result row has been written (fires once per tool). */
  onToolResultPersisted?(message: Message): void;
  /**
   * The tools_enabled master switch changed during the round (triggered
   * by a toggle_tools call from the model). UI surfaces this as a
   * flash on the composer toolbox button.
   */
  onToolsEnabledChange?(enabled: boolean): void;
}

export interface ChatLoopOptions {
  venice: VeniceClient;
  supabase: SupabaseService;
  /** Thread we're replying on; used for the tool context and persistence. */
  thread: Thread;
  /** Signed-in user id (used to scope the tool context). */
  userId: string;
  /** Concrete Venice model id to send as `model` in every round. */
  modelId: string;
  /**
   * Prior message history in OpenAI shape — starts with any system
   * messages, ends with the user message that triggered this call. The
   * chat-loop prepends its own catalog system message on top; it
   * doesn't persist that prepended message.
   */
  history: VeniceMessage[];
  signal: AbortSignal;
  handlers?: ChatLoopHandlers;
}

/** Non-error completion shape returned to the caller. */
export interface ChatLoopResult {
  /** Final assistant text the user sees. Empty if the loop hit MAX_ROUNDS. */
  finalText: string;
  /** Number of streaming rounds that ran (>=1). */
  roundsRun: number;
  /** True if we stopped because of MAX_ROUNDS rather than a clean finish. */
  stoppedByLimit: boolean;
  /** Current state of the master switch after the loop finished. */
  toolsEnabled: boolean;
}

/**
 * Project a stored Message row onto the OpenAI wire format. Handles the
 * three shapes we emit: plain text (system/user/assistant-text), an
 * assistant row that invoked tools (`tool_calls` attached, content may
 * be empty), and a tool-result row (`role='tool'` with tool_call_id and
 * name).
 */
export function toVeniceMessage(m: Message): VeniceMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id: m.tool_call_id ?? undefined,
      name: m.name ?? undefined,
    };
  }
  const out: VeniceMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    out.tool_calls = m.tool_calls;
  }
  return out;
}

/**
 * Encode a tool's return value (or error) into the string `content`
 * field that OpenAI's tool-result messages expect. Always JSON so the
 * model sees structured data rather than a toString rendering.
 */
function encodeToolContent(
  result: { ok: true; value: unknown } | { ok: false; error: Error }
): string {
  if (result.ok) {
    // Unknown values — stringify defensively so a thrown toString on a
    // weird object doesn't bubble up as a tool result.
    try {
      return JSON.stringify(result.value ?? null);
    } catch {
      return JSON.stringify({ error: 'result not serializable' });
    }
  }
  return JSON.stringify({ error: result.error.message || String(result.error) });
}

/**
 * Drive one user turn through as many rounds as the model asks for
 * (capped at MAX_ROUNDS). The function returns when the assistant
 * produces a terminal response (no tool_calls) or the cap trips.
 */
export async function runChatLoop(opts: ChatLoopOptions): Promise<ChatLoopResult> {
  const { venice, supabase, thread, userId, modelId, signal, handlers } = opts;
  // Copy so we can extend locally each round without mutating the caller.
  const history: VeniceMessage[] = [...opts.history];
  let toolsEnabled = thread.tools_enabled;
  let finalText = '';
  let roundsRun = 0;
  let stoppedByLimit = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal.aborted) break;
    roundsRun++;

    // Prepend the system-prompt catalog every round. It's not stored in
    // the DB — it's derived from the registry at request-time, so adding
    // a tool automatically updates what the model knows about.
    const requestMessages: VeniceMessage[] = [
      { role: 'system', content: buildToolCatalog() },
      ...history,
    ];

    const stream = venice.streamChat({
      model: modelId,
      messages: requestMessages,
      signal,
      tools: buildToolList(toolsEnabled),
    });

    let roundText = '';
    const roundCalls: OpenAIToolCall[] = [];
    let roundUsage: TokenUsage | null = null;
    for await (const ev of stream) {
      if (ev.type === 'text') {
        roundText += ev.delta;
        handlers?.onTextUpdate?.(roundText);
      } else if (ev.type === 'tool_call') {
        roundCalls.push(ev.toolCall);
      } else if (ev.type === 'usage') {
        // Captured from the stream's trailing usage frame. Persisted on
        // every assistant row we write below — the tokens were spent
        // regardless of whether the turn produced text or tool calls,
        // and we want the per-row data honest for future aggregates.
        roundUsage = ev.usage;
      }
    }

    // No tool calls → this is the final assistant message. Persist and
    // exit; no need for a tool round.
    if (roundCalls.length === 0) {
      if (roundText.length > 0) {
        const msg = await supabase.addMessage(thread.id, 'assistant', roundText, {
          model: modelId,
          usage: roundUsage,
        });
        handlers?.onAssistantPersisted?.(msg);
      }
      finalText = roundText;
      break;
    }

    // Persist the assistant row first so the tool rows below have
    // something to pair to in future replays. `content` can be empty
    // on a pure tool-call response — OpenAI sends content=null then,
    // but our column is NOT NULL so we coerce to ''.
    const assistantMsg = await supabase.addMessage(
      thread.id,
      'assistant',
      roundText,
      { tool_calls: roundCalls, model: modelId, usage: roundUsage }
    );
    handlers?.onAssistantPersisted?.(assistantMsg);

    // Kick every tool off in parallel so the wall-clock latency is
    // max(individual durations) rather than sum. Each promise catches
    // internally so Promise.all never rejects — we want all of them to
    // settle before moving on, mirroring OpenAI's requirement that
    // every tool_call has a matching tool-result row.
    const executions = roundCalls.map(async (call) => {
      handlers?.onToolStart?.(call);
      const ctl = childController(signal);
      const ctx: ToolContext = {
        supabase,
        userId,
        threadId: thread.id,
        signal: ctl.signal,
      };
      let args: Record<string, unknown>;
      try {
        // Arguments arrive as a JSON string per the OpenAI spec. An
        // invalid JSON blob is the model's fault, not ours — surface
        // it as a tool error so the next round sees the parse failure.
        args = call.function.arguments.length > 0
          ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
          : {};
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        handlers?.onToolError?.(call, error);
        return { call, ok: false as const, error };
      }
      try {
        const value = await executeToolCall(call.function.name, args, ctx);
        handlers?.onToolDone?.(call, value);
        // toggle_tools is the only tool that changes the master switch;
        // observe its return value instead of a separate DB re-fetch.
        if (call.function.name === toggleTools.name) {
          const next = Boolean((value as { enabled?: boolean })?.enabled);
          if (next !== toolsEnabled) {
            toolsEnabled = next;
            handlers?.onToolsEnabledChange?.(toolsEnabled);
          }
        }
        return { call, ok: true as const, value };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        handlers?.onToolError?.(call, error);
        return { call, ok: false as const, error };
      }
    });
    const settled = await Promise.all(executions);

    // Extend the history with the assistant-with-tool-calls row plus
    // one tool-result row per call. Order matters: the assistant row
    // must precede its result rows in the array we send next round.
    history.push({
      role: 'assistant',
      content: roundText,
      tool_calls: roundCalls,
    });
    for (const r of settled) {
      const content = r.ok
        ? encodeToolContent({ ok: true, value: r.value })
        : encodeToolContent({ ok: false, error: r.error });
      const msg = await supabase.addMessage(thread.id, 'tool', content, {
        tool_call_id: r.call.id,
        name: r.call.function.name,
      });
      handlers?.onToolResultPersisted?.(msg);
      history.push({
        role: 'tool',
        content,
        tool_call_id: r.call.id,
        name: r.call.function.name,
      });
    }

    // Loop back for another round. The model will see the tool results
    // in the extended history and either produce a final answer or
    // request more tool calls.
    if (round === MAX_ROUNDS - 1) {
      stoppedByLimit = true;
    }
  }

  return { finalText, roundsRun, stoppedByLimit, toolsEnabled };
}
