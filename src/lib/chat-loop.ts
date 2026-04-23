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
  Citation,
} from './venice';
import { buildUserVeniceContent } from './attachments';
import {
  buildToolList,
  buildSystemPrompt,
  executeToolCall,
  toggleTools,
  updateTitle,
  type OpenAIToolCall,
  type ToolContext,
} from './tools';
import {
  fireSamskaras,
  formatPriming,
  getCompoundSummary,
  recordSubstrateStub,
  type FireResult,
} from './samskara';
import { recallOpeningMemories } from './opening-recall';

/** Upper bound on rounds to prevent a runaway tool-call loop. */
export const MAX_ROUNDS = 5;

/**
 * Hard cap on the wait for samskara priming before the first
 * assistant round starts. Common case lands well under this; the
 * cap exists so a slow Venice or a hiccup in the cosine RPC can't
 * add visible latency to the user's first token. Picked at 1500ms
 * because async chat tolerates a half-second send delay but not
 * more - anything beyond that and the user starts noticing.
 *
 * Exported for tests that want to assert the timeout behaviour
 * without waiting for real time.
 */
export const SAMSKARA_PRIMING_TIMEOUT_MS = 1500;

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

/** Placeholder string threads ship with from schema.sql + draft creation. */
const DEFAULT_THREAD_TITLE = 'New conversation';

/**
 * Per-turn note fed to the model via the system-prompt appendix so it
 * can decide whether to call the `update_title` tool. Two shapes:
 *
 *   - Placeholder title: tell the model to look through any opening
 *     greeting and pick a title for the real topic of the conversation.
 *     This is the "Hello -> Saying hi to the user" case - the first
 *     assistant reply is the first point at which there IS a real topic
 *     to title.
 *   - Real title: tell the model to call update_title only if the topic
 *     has meaningfully shifted. Cosmetic drift is not a reason to
 *     rename.
 *
 * Wrapped in `---` fences rather than `<note>` tags. The tag form was
 * considered and rejected: a user typing `</note>` in their own message
 * could escape the block and inject instructions. The fence is
 * imperfect too (a user could paste a matching `---` block), but the
 * exploit requires more intent, and the worst case is a bad title
 * rather than arbitrary prompt injection.
 *
 * Returns null when the user has manually renamed the thread - once
 * they've committed to a title, we stop asking the model to touch it.
 * The `update_title` tool stays in the always-on catalog either way
 * (cheap to leave available; model won't call it without the
 * instruction), but the prompt-level suppression is the real gate.
 */
function buildTitleNote(thread: Thread): string | null {
  if (thread.title_manually_set) return null;
  const isPlaceholder = thread.title === DEFAULT_THREAD_TITLE;
  const lines: string[] = ['---'];
  if (isPlaceholder) {
    lines.push(
      `Conversation title: "${thread.title}" (placeholder).`,
      'This conversation has no title yet. Before responding, call the',
      '`update_title` tool with a concise 3-6 word title describing the',
      'actual topic of the conversation. If the opening user message is',
      'a greeting or pleasantry, look past it to the real topic the',
      'user is asking about (based on their message and your intended',
      'reply). No trailing punctuation, no quotes, plain text.'
    );
  } else {
    lines.push(
      `Conversation title: "${thread.title}".`,
      'If the conversation has meaningfully shifted away from this',
      'topic, call the `update_title` tool with a better 3-6 word',
      'title before responding. Cosmetic drift is not a reason to',
      'rename; only call update_title when the new topic genuinely',
      "doesn't fit the current title. No trailing punctuation, no",
      'quotes, plain text.'
    );
  }
  lines.push('---');
  return lines.join('\n');
}

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
   * Citations to display under the in-flight assistant bubble. Fires
   * whenever a round contributes new sources - either the outer
   * stream emitted a `citations` frame (legacy main-chat search path,
   * no longer active in the default chat loop) or a `web_search` tool
   * call returned a `citations` array that the loop harvested onto
   * the running `toolCitations` accumulator. The argument is the full
   * running list with indexes renumbered contiguously from 1, so the
   * UI can swap in whatever it has without tracking deltas.
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
  /**
   * The thread title changed mid-turn (triggered by an `update_title`
   * call from the model). Fires with the sanitised title the handler
   * actually wrote. The UI uses this to patch the thread row and
   * re-bucket the drawer immediately, instead of waiting for the
   * end-of-turn `refreshThreads()` to pick the new title up.
   */
  onTitleChange?(title: string): void;
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
  /**
   * Optional id of the user message that opened this turn. When set,
   * the chat-loop pairs it with the terminal assistant message id and
   * writes a samskara substrate stub at end-of-round (the formation
   * worker enriches it later). When absent the substrate stub is
   * skipped — older callers and tests don't need to know about
   * samskara to keep working.
   */
  userMessageId?: string;
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
 * Pick a `citations` array off a tool return value when the shape looks
 * like one. Used by the chat loop to harvest web-search sources out of
 * the `web_search` tool's `{answer, citations}` return and merge them
 * onto the terminal assistant row's `citations` column. The check is
 * structural rather than name-based so any future tool returning a
 * similarly shaped payload rides the same path without another branch.
 *
 * Defensive about the field shape: Venice's Citation requires `url`
 * and allows every other field to be absent, so we mirror that here.
 * Anything without a string `url` is skipped rather than silently
 * rendering an empty row.
 */
function extractToolCitations(value: unknown): Citation[] {
  if (!value || typeof value !== 'object') return [];
  const raw = (value as { citations?: unknown }).citations;
  if (!Array.isArray(raw)) return [];
  const out: Citation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.url !== 'string' || e.url.length === 0) continue;
    const cite: Citation = {
      // Placeholder index - the caller rewrites this to a running
      // 1-based global position so indexes stay contiguous across
      // multiple tool calls within a turn.
      index: 0,
      url: e.url,
    };
    if (typeof e.title === 'string') cite.title = e.title;
    if (typeof e.content === 'string') cite.content = e.content;
    if (typeof e.date === 'string') cite.date = e.date;
    out.push(cite);
  }
  return out;
}

/**
 * Pull the plain-text portion of a user message off the wire shape.
 * `VeniceMessage.content` is `string | ContentPart[]`; multimodal
 * user messages with attachments arrive as the array form, in which
 * case we concatenate the `'text'` parts. Empty string when the
 * message has no text component (e.g. an image-only user message).
 */
function extractUserText(msg: VeniceMessage | undefined): string {
  if (!msg || msg.role !== 'user') return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  return c
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
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
    reasoningEffort,
    verbosity,
    userMessageId,
  } = opts;
  // Copy so we can extend locally each round without mutating the caller.
  const history: VeniceMessage[] = [...opts.history];
  let toolsEnabled = thread.tools_enabled;
  let finalText = '';
  let roundsRun = 0;
  let stoppedByLimit = false;
  // Track the last assistant row we persisted across rounds. End-of-
  // turn samskara substrate writes pair the opening user message with
  // whichever assistant row closed the turn — final text or terminal
  // tool-using row, whichever the loop ends on.
  let lastAssistantId: string | null = null;

  // Citations sourced from tool results over the whole turn. Accumulated
  // across rounds with monotonic 1-based indexes so the rendered panel
  // reads 1,2,3,... regardless of how many `web_search` calls fired or
  // what per-call numbering each returned. Persisted on the terminal
  // assistant row when `roundCitations` (Venice's direct citations on
  // the outer stream) is empty - which is the common case now that the
  // main chat-loop no longer sets `enable_web_search` on its own
  // requests, so the only citation source is the tool path.
  const toolCitations: Citation[] = [];

  // Turn-open priming. Computed ONCE before the round loop so every
  // round in this turn sees the same compound + fire + opening-recall
  // block - the user's input doesn't change across rounds, and
  // recomputing per round would burn embedding calls and confuse the
  // cohort tracking (one cohort id per user turn, not per round).
  //
  // Three pieces run in parallel:
  //   1. Samskara compound summary (cached prose row, fast SELECT).
  //   2. Samskara fire (one embed + one cosine RPC + one log write).
  //   3. Opening-turn memory recall (one embed + one scored cosine
  //      RPC). Gated on "is this the first assistant turn of this
  //      thread?" so mid-conversation turns don't pay the tax. The
  //      model handles later-turn recall itself via the memory_recall
  //      tool, so auto-injection on every turn would be double work.
  //
  // Any piece may resolve to null/empty; the formatter and the
  // conditional history.push below render whatever sections are
  // present. Errors are already swallowed inside each helper - a
  // priming failure should never block a chat turn.
  //
  // Bounded wait. All three calls race the same timeout. The cosine
  // fire involves one Venice embed plus one Supabase RPC; the
  // compound summary is a single SELECT; the opening recall is one
  // embed plus one RPC. Common case lands in 100-300 ms. Cap at
  // SAMSKARA_PRIMING_TIMEOUT_MS so a slow Venice doesn't add visible
  // latency to the user's first token. The underlying Promises keep
  // running on timeout so the fire-log RPC inside fireSamskaras still
  // completes - the worst case is one cohort logged but never
  // reaction-classified, which the worker's resolution-window
  // discards naturally.
  const userText = extractUserText(history[history.length - 1]);
  // "Opening turn" = no assistant messages in history yet. A fresh
  // thread on turn 1 matches; a thread where the user edited their
  // first message before any reply also matches (correctly - the
  // model still hasn't seen anything). Later turns fall through to
  // the model's own memory_recall cadence.
  const isOpeningTurn = history.every((m) => m.role !== 'assistant');
  interface PrimingBundle {
    samskaraAppendix: string;
    openingRecallBlock: string | null;
  }
  const primingWork = (async (): Promise<PrimingBundle> => {
    const [compoundSummary, fireResult, openingRecallBlock] = await Promise.all([
      getCompoundSummary(supabase),
      fireSamskaras(supabase, venice, thread.id, userText, signal),
      isOpeningTurn
        ? recallOpeningMemories(supabase, venice, userText, signal)
        : Promise.resolve<string | null>(null),
    ]);
    return {
      samskaraAppendix: formatPriming({
        compoundSummary,
        fire: fireResult as FireResult | null,
      }),
      openingRecallBlock,
    };
  })();
  const priming = await Promise.race<PrimingBundle>([
    primingWork,
    new Promise<PrimingBundle>((resolve) =>
      setTimeout(
        () => resolve({ samskaraAppendix: '', openingRecallBlock: null }),
        SAMSKARA_PRIMING_TIMEOUT_MS
      )
    ),
  ]);
  // The title note and the samskara block are both per-turn appendices
  // to the baseline system prompt. Concatenate with a blank-line spacer
  // when both are present so the model sees them as distinct sections
  // rather than one run-on block. Either can be empty - the note is
  // null when the user has manually renamed (no instruction to inject),
  // samskara is empty on cold-start or timeout - and the filter+join
  // handles any combination cleanly.
  const titleNote = buildTitleNote(thread);
  const appendixParts = [titleNote, priming.samskaraAppendix].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );
  const promptAppendix = appendixParts.join('\n\n');

  // Push the opening-recall <think> block onto local history as an
  // ephemeral assistant turn. Not persisted - the round loop only
  // writes assistant rows that the model itself generated; this
  // synthetic turn lives only for the duration of this chat-loop
  // call, same contract as the <user_message> tag wrapping. Strict
  // role alternation is broken here (user -> assistant-think ->
  // assistant-reply), but Venice tolerates that on the wire and the
  // model reads the <think> block as its own prior recollection.
  if (priming.openingRecallBlock !== null) {
    history.push({
      role: 'assistant',
      content: priming.openingRecallBlock,
    });
  }

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
    // The current user turn is ALWAYS wrapped in <user_message>
    // boundary tags (see tagLastUserMessage above). Venice's
    // `enable_web_scraping` is always on in venice.ts, so any URL the
    // user pastes lands inlined in the user turn alongside whatever
    // they typed. Wrapping unconditionally keeps the boundary
    // reliable; the ~10 tokens per user turn are a cheap price for a
    // signal the model can anchor on every time. Live web search,
    // previously also an `enable_web_search` injection on every
    // request, now flows through the `web_search` tool instead - the
    // main chat loop never sets those Venice parameters.
    const projectedHistory = tagLastUserMessage(history);
    const requestMessages: VeniceMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          // Per-turn appendix - pre-computed before the round loop so
          // every round sees the same block. Currently concatenates
          // (in order): the title note (buildTitleNote above, guiding
          // `update_title` tool calls), and the samskara compound +
          // fire block. Empty string when both are absent (manually-
          // named thread with no samskaras, cold start, or priming
          // timeout).
          promptAppendix: promptAppendix,
        }),
      },
      ...projectedHistory,
    ];

    const stream = venice.streamChat({
      model: modelId,
      messages: requestMessages,
      signal,
      tools: buildToolList(toolsEnabled),
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
        // Citations priority:
        //   1. `roundCitations` from the outer stream - only non-null
        //      when the main chat request itself asked Venice for
        //      server-side search, which nak no longer does. Kept as
        //      the first branch for defensive parity with the old
        //      shape and so a future re-enablement of main-chat search
        //      would Just Work without revisiting this line.
        //   2. Accumulated tool citations from any `web_search` calls
        //      that ran in the turn. This is the live path.
        //   3. null - no citations to render.
        const finalCitations =
          roundCitations ?? (toolCitations.length > 0 ? toolCitations : null);
        const msg = await supabase.addMessage(thread.id, 'assistant', roundText, {
          model: modelId,
          usage: roundUsage,
          // Reasoning / citations ride along on the assistant row so
          // the panels below the message survive a page refresh. Null
          // when the model didn't produce either — keeps older rows
          // (before the columns existed) distinguishable from "this
          // turn actually had none."
          reasoning: roundReasoning.length > 0 ? roundReasoning : null,
          citations: finalCitations,
        });
        handlers?.onAssistantPersisted?.(msg);
        lastAssistantId = msg.id;
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
    lastAssistantId = assistantMsg.id;

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
        // update_title returns the sanitised title; forward so the UI
        // can patch the drawer row immediately rather than waiting for
        // the end-of-turn refreshThreads() to pick up the change.
        if (call.function.name === updateTitle.name) {
          const newTitle = (value as { title?: string })?.title;
          if (typeof newTitle === 'string' && newTitle.length > 0) {
            handlers?.onTitleChange?.(newTitle);
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
    // Snapshot the pre-settlement citation count so we can tell at the
    // end of this round whether a tool contributed new sources and
    // should therefore fire an `onCitationsUpdate` notification - the
    // UI's live source-panel animates in the same way it did when
    // Venice itself streamed citations on the outer completion.
    const citationsBefore = toolCitations.length;
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
      // Harvest citations from any tool that returned them (web_search
      // is the intended source; the shape check is structural, not
      // name-based, so a future tool returning `{..., citations: [...]}`
      // rides the same path without another branch here). Indexes are
      // rewritten to the running 1-based global position so the
      // rendered CitationsPanel sees a contiguous list regardless of
      // per-tool numbering.
      if (r.ok) {
        const extracted = extractToolCitations(r.value);
        for (const cite of extracted) {
          toolCitations.push({ ...cite, index: toolCitations.length + 1 });
        }
      }
    }
    if (toolCitations.length > citationsBefore) {
      // Fire once per round that added citations; the handler
      // snapshots the running list so the UI can render a live
      // sources panel on the in-flight assistant bubble before the
      // terminal assistant row is persisted.
      handlers?.onCitationsUpdate?.(toolCitations.slice());
    }

    // Loop back for another round. The model will see the tool results
    // in the extended history and either produce a final answer or
    // request more tool calls.
    if (round === MAX_ROUNDS - 1) {
      stoppedByLimit = true;
    }
  }

  // Samskara substrate stub. Written once per turn after the loop
  // settles, paired with whichever assistant row closed the turn.
  // Fire-and-forget: a substrate write failure is logged inside
  // `recordSubstrateStub` but not surfaced — the formation pipeline
  // simply has fewer rows to work from until the next round writes
  // successfully. Skipped when the caller didn't supply
  // userMessageId (older callers, tests) or when no assistant row
  // landed at all (early abort, error path).
  if (userMessageId && lastAssistantId !== null) {
    void recordSubstrateStub(supabase, thread.id, userMessageId, lastAssistantId);
  }

  return { finalText, roundsRun, stoppedByLimit, toolsEnabled };
}
