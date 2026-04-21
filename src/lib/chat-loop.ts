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

import type { ReasoningEffort, Verbosity } from './models';
import type { SupabaseService, Message, Thread } from './supabase';
import type {
  VeniceClient,
  VeniceMessage,
  TokenUsage,
  WebSearchMode,
  Citation,
} from './venice';
import { buildUserVeniceContent } from './attachments';
import {
  buildToolList,
  buildSystemPrompt,
  executeToolCall,
  toggleTools,
  type OpenAIToolCall,
  type ToolContext,
} from './tools';

/** Upper bound on rounds to prevent a runaway tool-call loop. */
export const MAX_ROUNDS = 5;

/**
 * Boundary markers we splice around the current turn's user text when
 * Venice web search is active. Venice inlines its search payload plus
 * a framing instruction ("you can use this real time information to
 * answer the user's query above") into the user's turn server-side,
 * before the model ever sees it — and without a structural boundary
 * the model confuses the Venice injection for user-authored input
 * (observed: it started thanking the user for links they never sent
 * and quoting snippets back as if they were the user's words, with
 * the reasoning trace literally saying 'and the user says: "..."').
 *
 * Wrapping the user's real message gives the model an unambiguous
 * signal. The system prompt's web-search block (see buildSystemPrompt
 * in ./tools/index.ts) tells the model that only the text inside
 * these tags is from the human; anything outside — even though it
 * rides inside role=user on the wire — is platform-injected
 * reference material.
 */
const USER_MSG_OPEN = '<user_message>';
const USER_MSG_CLOSE = '</user_message>';

/**
 * Return a shallow copy of `messages` with the last role='user'
 * message's content wrapped in the <user_message> boundary tags. The
 * input messages are not mutated — we allocate a fresh message object
 * (and fresh content array, when the content is multimodal) so that
 * the caller's history stays untouched across the chat loop's rounds.
 *
 * Scope is deliberately "last user turn only": that's the one Venice
 * augments on the current round. Earlier user turns in history were
 * already processed on prior rounds and don't need re-tagging — and
 * tagging every user turn in the request would bloat the wire and
 * could confuse the model into thinking the tags carry per-turn
 * semantics beyond "this is where the human's words are."
 */
function tagLastUserMessage(messages: VeniceMessage[]): VeniceMessage[] {
  // Walk from the end so we find the most recent user message even
  // when tool-result rows follow it on a mid-loop round.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;
  const out = messages.slice();
  const orig = out[lastUserIdx];
  if (typeof orig.content === 'string') {
    out[lastUserIdx] = {
      ...orig,
      content: `${USER_MSG_OPEN}${orig.content}${USER_MSG_CLOSE}`,
    };
  } else {
    // Vision/multimodal: prepend an opening-tag text part and append
    // a closing-tag text part so images and extracted-text prelude
    // blocks all sit *inside* the user-message boundary. Allocating a
    // fresh array so we don't mutate the caller's content.
    out[lastUserIdx] = {
      ...orig,
      content: [
        { type: 'text', text: USER_MSG_OPEN },
        ...orig.content,
        { type: 'text', text: USER_MSG_CLOSE },
      ],
    };
  }
  return out;
}

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
  /**
   * Cumulative reasoning / chain-of-thought text for the current round.
   * Fires on every reasoning delta, which on reasoning-capable models
   * arrives before the visible `onTextUpdate` stream. The UI uses the
   * transition from "reasoning arriving" to "text arriving" to animate
   * the reasoning panel closed.
   */
  onReasoningUpdate?(text: string): void;
  /**
   * Venice citations for the current round. Fires at most once per
   * round (Venice sends the full list in one frame). Replaces whatever
   * the previous round emitted — each assistant row carries only its
   * own turn's citations.
   */
  onCitationsUpdate?(citations: Citation[]): void;
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
  /**
   * Optional Venice web-search mode. When set, forwarded to every
   * streamChat call in the loop as `venice_parameters.enable_web_search`.
   * Caller (Chat.svelte) derives this from `app.webSearchEnabled`:
   * enabled → 'auto', disabled → 'off'. Omitted here means "don't pass
   * the field" — used by tests that don't care about web-search.
   */
  webSearch?: WebSearchMode;
  /**
   * Optional reasoning-effort knob forwarded to every streamChat call.
   * Caller (Chat.svelte) is expected to only set this on models whose
   * ModelSpec marks `supportsReasoning: true` — we don't re-check here
   * because the chat-loop only sees the concrete model id, not the spec.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Optional text.verbosity knob forwarded to every streamChat call.
   * Unlike reasoningEffort there's no model-capability gate — providers
   * that don't recognize the field silently ignore it.
   */
  verbosity?: Verbosity;
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
export function toVeniceMessage(
  m: Message,
  opts?: { visionSpec?: { supportsVision: boolean } }
): VeniceMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id: m.tool_call_id ?? undefined,
      name: m.name ?? undefined,
    };
  }
  // User messages may carry attachments; build the multimodal content
  // through the attachments helper so extracted text lands as fenced
  // prelude blocks and images inline as `image_url` parts on vision
  // tiers. Passing a default (non-vision) spec when the caller doesn't
  // provide one keeps older callers working — they just never inline
  // images. See buildUserVeniceContent for the rules.
  if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
    const content = buildUserVeniceContent(
      m.content,
      m.attachments,
      opts?.visionSpec ?? { supportsVision: false }
    );
    return { role: 'user', content };
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
  const {
    venice,
    supabase,
    thread,
    userId,
    modelId,
    signal,
    handlers,
    webSearch,
    reasoningEffort,
    verbosity,
  } = opts;
  // Copy so we can extend locally each round without mutating the caller.
  const history: VeniceMessage[] = [...opts.history];
  let toolsEnabled = thread.tools_enabled;
  let finalText = '';
  let roundsRun = 0;
  let stoppedByLimit = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal.aborted) break;
    roundsRun++;

    // Prepend the baseline system prompt every round. It's not stored
    // in the DB — it's derived from the registry at request-time, so
    // adding a tool automatically updates what the model knows about,
    // and editing the identity copy takes effect for the next turn
    // with no migration. User-configured system prompts from Settings
    // ride AFTER this in `history`, which means a custom "you are a
    // pirate" prompt still wins on voice while the baseline tool
    // framing stays in force.
    //
    // Advertise Venice's web-search augmentation to the model when
    // the user hasn't opted out. In `auto` mode Venice only runs the
    // search if the model signals intent — without this hint the
    // model reads the gated-tool list as exhaustive and refuses.
    //
    // When web search is active we ALSO wrap the current user turn
    // in <user_message> boundary tags (see tagLastUserMessage above):
    // Venice inlines its search payload + framing into the user turn
    // server-side, and the tags give the model a reliable "this is
    // where the human's words are" signal. The system prompt block
    // added in buildSystemPrompt ties the tags back to the warning.
    const webSearchActive = webSearch === 'auto' || webSearch === 'on';
    const projectedHistory = webSearchActive
      ? tagLastUserMessage(history)
      : history;
    const requestMessages: VeniceMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt({ webSearch: webSearchActive }),
      },
      ...projectedHistory,
    ];

    const stream = venice.streamChat({
      model: modelId,
      messages: requestMessages,
      signal,
      tools: buildToolList(toolsEnabled),
      webSearch,
      reasoningEffort,
      verbosity,
    });

    let roundText = '';
    let roundReasoning = '';
    let roundCitations: Citation[] | null = null;
    const roundCalls: OpenAIToolCall[] = [];
    let roundUsage: TokenUsage | null = null;
    for await (const ev of stream) {
      if (ev.type === 'text') {
        roundText += ev.delta;
        handlers?.onTextUpdate?.(roundText);
      } else if (ev.type === 'reasoning') {
        roundReasoning += ev.delta;
        handlers?.onReasoningUpdate?.(roundReasoning);
      } else if (ev.type === 'tool_call') {
        roundCalls.push(ev.toolCall);
      } else if (ev.type === 'usage') {
        // Captured from the stream's trailing usage frame. Persisted on
        // every assistant row we write below — the tokens were spent
        // regardless of whether the turn produced text or tool calls,
        // and we want the per-row data honest for future aggregates.
        roundUsage = ev.usage;
      } else if (ev.type === 'citations') {
        roundCitations = ev.citations;
        handlers?.onCitationsUpdate?.(ev.citations);
      }
    }

    // No tool calls → this is the final assistant message. Persist and
    // exit; no need for a tool round.
    if (roundCalls.length === 0) {
      if (roundText.length > 0) {
        const msg = await supabase.addMessage(thread.id, 'assistant', roundText, {
          model: modelId,
          usage: roundUsage,
          // Reasoning / citations ride along on the assistant row so
          // the panels below the message survive a page refresh. Null
          // when the model didn't produce either — keeps older rows
          // (before the columns existed) distinguishable from "this
          // turn actually had none."
          reasoning: roundReasoning.length > 0 ? roundReasoning : null,
          citations: roundCitations,
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
      {
        tool_calls: roundCalls,
        model: modelId,
        usage: roundUsage,
        // Intermediate tool-invoking rounds rarely carry reasoning or
        // citations — but when they do (some reasoning models think
        // out loud before picking a tool), persist them so the
        // per-round panels reflect what actually happened.
        reasoning: roundReasoning.length > 0 ? roundReasoning : null,
        citations: roundCitations,
      }
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
        venice,
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
