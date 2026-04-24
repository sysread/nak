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
import type { SupabaseService, Attachment, Message, Thread } from './supabase';
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
  toggleToolbox,
  updateTitle,
  type OpenAIToolCall,
  type ToolContext,
} from './tools';
import { sanitizeToolCallsForWire } from './tools/wire';
import {
  fireSamskaras,
  formatPriming,
  getCompoundSummary,
  recordSubstrateStub,
  type FireResult,
} from './samskara';
import { recallOpeningMemories } from './opening-recall';
import { todayInZone } from './journal-day';
import type { JournalEntry } from './supabase';

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
 * can decide whether to call the `update_title` tool. Two shapes,
 * weighted very differently:
 *
 *   - Placeholder title ("New conversation"): the model MUST call
 *     update_title this turn. Earlier phrasing ("before responding,
 *     call the update_title tool...") was too soft and the model
 *     routinely skipped the rename in favour of just answering the
 *     user, leaving threads stuck on the placeholder across several
 *     turns even after clear topics had been introduced. The
 *     placeholder shape uses an imperative markdown header, labels
 *     the action "required this turn", and spells out the observable
 *     failure mode so the model treats it as a hard requirement
 *     rather than a nudge it can skip. The block is also placed last
 *     in the appendix (see appendixParts in runChatLoop) so it sits
 *     closest to the user turn - the position where instruction-
 *     following is strongest.
 *   - Real title: a terse one-liner telling the model to rename only
 *     on a meaningful topic shift. Kept short because it fires on
 *     every non-placeholder turn and we don't want to pay tokens or
 *     prompt weight for what is almost always a no-op.
 *
 * The placeholder block uses a markdown `##` header rather than
 * `<note>` tags. The tag form was considered and rejected: a user
 * typing `</note>` in their own message could escape the block and
 * inject instructions. A header is imperfect too (a user could paste
 * a matching `##` line) but the exploit requires more intent, and
 * the worst case is a bad title rather than arbitrary prompt
 * injection.
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
  if (isPlaceholder) {
    return [
      '## Required this turn: title this conversation',
      '',
      `The thread title is still the "${DEFAULT_THREAD_TITLE}"`,
      'placeholder. Before generating any reply to the user, call the',
      '`update_title` tool with a concise 3-6 word title describing',
      'what the user is actually asking about. If the opening message',
      'is a greeting or pleasantry, look past it to the real topic of',
      'the conversation - infer it from their message and from the',
      'reply you are about to write.',
      '',
      'This is not optional. Until you call `update_title`, the thread',
      "stays labelled as the placeholder in the user's conversation",
      'drawer - which is a visible bug. No trailing punctuation, no',
      'quotes, plain text.',
    ].join('\n');
  }
  return [
    `Current conversation title: "${thread.title}". If the topic has`,
    'meaningfully shifted, call `update_title` with a better 3-6 word',
    'title. Cosmetic drift is not a reason to rename.',
  ].join('\n');
}

/**
 * Opt-in formatting nudge for the model. When the user has the
 * "Emphasis markdown" setting on (Settings -> AI), chat-loop folds
 * this block into the per-turn system-prompt appendix so every
 * reply this turn carries the same instruction. The goal is a
 * bionic-style scan aid: bold on terms the reader should fix on,
 * italics on phrases that orient them, sparsity calibrated so the
 * emphasis rewards skimming instead of competing with it.
 *
 * Editing this copy changes model behaviour on every turn of every
 * user who has the toggle on - treat it as a voice-tuning change,
 * not a typo fix. Kept in a named function so the prompt text sits
 * next to the rules that shaped it rather than buried inline in
 * the appendix-build block.
 */
function buildEmphasisNote(): string {
  return [
    'Formatting: when the reply runs more than a sentence or two,',
    'use light Markdown emphasis as scan-points so the reader can',
    'skim. Bold (`**term**`) meaningful single words, proper nouns,',
    'and identifiers - things the reader should fix on. Italicise',
    '(`*phrase*`) short phrases, transitional clauses, or compound',
    'noun phrases that orient the reader. Either style works for a',
    'single or compound word; pick bold for terms worth fixing on,',
    'italics for phrases that set up what comes next. Aim for',
    'roughly one emphasised span per sentence in prose; less in',
    'code-heavy, list-heavy, or tabular passages. Do not emphasise',
    'whole sentences, filler adjectives, or boilerplate - the',
    'emphasis should reward skimming, not compete with it. Skip',
    "emphasis on short replies where skimming wouldn't help.",
  ].join('\n');
}

/**
 * Render today's automatic journal entry as a short appendix block for
 * the system prompt. Returns null when there's no entry yet today or
 * when the caller passed no entry (mid-thread turns, the priming
 * timeout fell through, etc.).
 *
 * Design intent: the block is context, not instruction. The baseline
 * prompt already explains what Reflections are and how to use them -
 * this block just ships the actual content so the model can weave
 * continuity in. Kept compact: date header + topics/mood line + body.
 * No `###` heavy formatting because the appendix as a whole is
 * already framed as per-turn reference material, not an essay.
 */
function buildJournalNote(entry: JournalEntry | null): string | null {
  if (!entry) return null;
  const tags: string[] = [];
  if (entry.topics.length > 0) {
    tags.push(`topics: ${entry.topics.join(', ')}`);
  }
  if (entry.mood) tags.push(`mood: ${entry.mood}`);
  if (entry.people.length > 0) {
    tags.push(`people: ${entry.people.join(', ')}`);
  }
  const lines: string[] = [
    `## Today's journal (${entry.entry_date})`,
    '',
  ];
  if (tags.length > 0) {
    lines.push(`_${tags.join(' / ')}_`, '');
  }
  lines.push(entry.content);
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
 * Order-insensitive equality for two toolbox-name arrays. Used to
 * decide whether a `toggle_toolbox` result changed the thread's
 * effective set - if it didn't (the model toggled to the same
 * array), we skip the onToolboxesEnabledChange notification so the
 * UI doesn't flash for a no-op. The toolbox name list is tiny (< 10
 * entries) so the nested-loop cost is negligible.
 */
function sameToolboxSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  for (const name of a) {
    if (!bSet.has(name)) return false;
  }
  return true;
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
   * The thread's gated-toolbox set changed during the round (triggered
   * by a `toggle_toolbox` call from the model). UI surfaces this as
   * a flash on the composer toolbox button. The handler receives the
   * new enabled array verbatim; callers wanting a delta should diff
   * against what they stored.
   */
  onToolboxesEnabledChange?(enabled: readonly string[]): void;
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
   * When true, append a short formatting-nudge block to the per-turn
   * system-prompt appendix asking the model to sprinkle light
   * Markdown emphasis (bold terms, italic phrases) through its reply
   * as scan-points. Opt-in; the block is skipped when false/absent
   * so the baseline prompt stays free of formatting hints for users
   * who didn't ask for them. See `buildEmphasisNote` below for the
   * exact wording - modifying it changes model behaviour on every
   * turn of every user who has the toggle on.
   */
  emphasisMarkdown?: boolean;
  /**
   * IANA timezone used to compute "today" for the Reflections
   * appendix. When null/undefined the journal lookup falls through to
   * the chat-loop's process-level default (typically the browser's
   * own zone). The chat-loop uses this ONLY to pull today's automatic
   * journal entry into the per-turn prompt; it doesn't affect the
   * model's reasoning directly.
   */
  journalTimezone?: string | null;
  /**
   * Optional id of the user message that opened this turn. When set,
   * the chat-loop pairs it with the terminal assistant message id and
   * writes a samskara substrate stub at end-of-round (the formation
   * worker enriches it later). When absent the substrate stub is
   * skipped — older callers and tests don't need to know about
   * samskara to keep working.
   */
  userMessageId?: string;
  /**
   * Hydrated Attachment[] for the user message that opened this turn.
   * Threaded into ToolContext so analyze_image can find image bytes by
   * filename without a DB query inside the tool. Optional - callers
   * that don't deal in attachments (tests, background agents) pass
   * nothing and ctx.attachments will be undefined; the tool guards
   * with ctx.attachments ?? [].
   */
  currentMessageAttachments?: Attachment[];
}

/** Non-error completion shape returned to the caller. */
export interface ChatLoopResult {
  /** Final assistant text the user sees. Empty if the loop hit MAX_ROUNDS. */
  finalText: string;
  /** Number of streaming rounds that ran (>=1). */
  roundsRun: number;
  /** True if we stopped because of MAX_ROUNDS rather than a clean finish. */
  stoppedByLimit: boolean;
  /**
   * True if the loop exited because the caller's AbortSignal fired mid-
   * stream (user clicked the stop button). The UI uses this to skip
   * the "something went wrong" banner a generic catch would produce -
   * the user asked for the abort, it's not a failure to report.
   */
  interrupted: boolean;
  /**
   * The thread's enabled gated-toolbox set at the end of the loop.
   * Callers persist this back to local state so subsequent user sends
   * see the same surface the model last saw.
   */
  toolboxesEnabled: readonly string[];
}

/**
 * Marker appended to the content field of an assistant row whose stream
 * the user cut short mid-response. Rendered verbatim in the message
 * bubble so the reader can tell a truncated reply from a naturally
 * short one. ASCII only and placed on its own line so a markdown
 * renderer treats it as paragraph text rather than a setext heading
 * (three hyphens alone would become an &lt;hr&gt; / H2; three hyphens
 * followed by more text on the same line parses as paragraph).
 */
export const INTERRUPTED_MARKER = '--- user interrupted response';

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
    out.tool_calls = sanitizeToolCallsForWire(m.tool_calls);
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
    emphasisMarkdown,
    journalTimezone,
    userMessageId,
    currentMessageAttachments,
  } = opts;
  // Copy so we can extend locally each round without mutating the caller.
  const history: VeniceMessage[] = [...opts.history];
  // Snapshot the thread's current toolbox set. Mutated in the loop
  // whenever the model calls `toggle_toolbox` so later rounds see the
  // new wire catalog. Returned to the caller at the end for local
  // state rehydration.
  let toolboxesEnabled: readonly string[] = thread.toolboxes_enabled;
  let finalText = '';
  let roundsRun = 0;
  let stoppedByLimit = false;
  let interrupted = false;
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
    /**
     * Today's automatic journal entry for the signed-in user, if one
     * exists. Injected as an appendix block on opening turns so the
     * model can weave continuity in without a tool call. Null when
     * there's no entry yet today, or when this isn't the opening
     * turn (mid-thread turns pay no tax).
     */
    journalEntry: JournalEntry | null;
  }
  // Pre-compute today's date in the user's timezone so the journal
  // lookup (a tiny indexed SELECT) can race alongside the samskara
  // bundle. Bucketing is cheap; both feeds run under the same
  // SAMSKARA_PRIMING_TIMEOUT_MS cap.
  const journalToday = todayInZone(journalTimezone ?? null);
  const primingWork = (async (): Promise<PrimingBundle> => {
    const [compoundSummary, fireResult, openingRecallBlock, journalRows] =
      await Promise.all([
        getCompoundSummary(supabase),
        fireSamskaras(supabase, venice, thread.id, userText, signal),
        isOpeningTurn
          ? recallOpeningMemories(supabase, venice, userText, signal)
          : Promise.resolve<string | null>(null),
        // Only pull the journal row on the opening turn - the same
        // reason we only do opening-recall there. Mid-thread turns
        // would rebuild the same appendix every round with no benefit.
        // Degrades silently: an error here just means "no journal
        // block this turn."
        isOpeningTurn
          ? supabase.getJournalEntriesForDate(journalToday).catch(() => [])
          : Promise.resolve([]),
      ]);
    const automatic =
      journalRows.find((e) => e.source === 'automatic') ?? null;
    return {
      samskaraAppendix: formatPriming({
        compoundSummary,
        fire: fireResult as FireResult | null,
      }),
      openingRecallBlock,
      journalEntry: automatic,
    };
  })();
  const priming = await Promise.race<PrimingBundle>([
    primingWork,
    new Promise<PrimingBundle>((resolve) =>
      setTimeout(
        () =>
          resolve({
            samskaraAppendix: '',
            openingRecallBlock: null,
            journalEntry: null,
          }),
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
  //
  // Order: samskara priming first, title note last. The title note's
  // placeholder shape is a "you must act this turn" directive that
  // benefits from being the closest block to the user turn, where the
  // model's instruction-following is strongest. Burying it above the
  // samskara Calibration/Fire sections (as the previous order did)
  // made the model gloss over the rename and answer the user directly,
  // leaving threads parked on "New conversation" across several turns.
  const titleNote = buildTitleNote(thread);
  // Emphasis blurb slots between samskara priming and the title
  // note: it's ambient voice tuning (less urgent than the title
  // directive, which needs to sit closest to the user turn) but
  // not per-user context (samskara priming carries the user
  // profile and belongs at the top of the appendix). Null when the
  // setting is off so the filter below skips it cleanly.
  const emphasisNote = emphasisMarkdown ? buildEmphasisNote() : null;
  // Today's Reflections block sits between the samskara priming and
  // the emphasis/title nudges: it's user-specific context (belongs
  // with samskara) but not urgent (title note stays closest to the
  // user turn). Null on mid-thread turns or when no automatic entry
  // exists yet.
  const journalNote = buildJournalNote(priming.journalEntry);
  const appendixParts = [
    priming.samskaraAppendix,
    journalNote,
    emphasisNote,
    titleNote,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
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
    // Phase B abort exit: the prior round reached tool execution, then
    // the user clicked stop while tools were running. Promise.all
    // settled (each in-flight tool's childController fired; cancelled
    // tools landed as error rows via the tool executor's catch), so
    // the history is internally consistent. No content marker needed -
    // the error tool rows already tell the story. Flag the result so
    // the UI knows to suppress the inline error banner this failure
    // would otherwise raise.
    if (signal.aborted) {
      interrupted = true;
      break;
    }
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
          // Pass the thread's current gated-toolbox set so the
          // catalog block renders [x]/[ ] marks that match what the
          // model will actually see on the wire this round.
          enabledToolboxes: toolboxesEnabled,
          // Per-turn appendix - pre-computed before the round loop so
          // every round sees the same block. Concatenates (in order):
          // the samskara compound + fire block, and the title note
          // (buildTitleNote above, guiding `update_title` tool calls).
          // Title goes last so its "required this turn" directive is
          // the closest block to the user turn. Empty string when
          // both are absent (manually-named thread with no samskaras,
          // cold start, or priming timeout).
          promptAppendix: promptAppendix,
        }),
      },
      ...projectedHistory,
    ];

    const stream = venice.streamChat({
      model: modelId,
      messages: requestMessages,
      signal,
      tools: buildToolList(toolboxesEnabled),
      reasoningEffort,
      verbosity,
    });

    let roundText = '';
    let roundReasoning = '';
    let roundCitations: Citation[] | null = null;
    const roundCalls: OpenAIToolCall[] = [];
    let roundUsage: TokenUsage | null = null;
    try {
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
    } catch (err) {
      // User clicked the stop button (or the caller aborted for any
      // other reason) while the stream was still producing deltas.
      // `fetch` rejects with an AbortError whose `.name` is literally
      // 'AbortError'; we also check `signal.aborted` as a belt-and-
      // braces fallback because a `reader.read()` rejection shape
      // isn't fully standardized across browsers and some runtimes
      // wrap the error.
      //
      // Persist whatever text / reasoning / citations arrived this
      // round with a visible marker appended to the content field so
      // the user can see exactly where the reply was cut. Partial
      // tool-call fragments live inside venice.ts's private accumulator
      // and are never emitted as tool_call events mid-stream, so there
      // is nothing partial to drop here - any entries in roundCalls
      // are fully-assembled-but-unexecuted, and we discard them per
      // spec (the user asked to stop; an unexecuted tool call isn't
      // "a tool call completed already"). Break out of the round loop
      // without recursing into tool execution.
      const isAbort =
        signal.aborted ||
        (err instanceof Error && err.name === 'AbortError');
      if (!isAbort) throw err;
      interrupted = true;
      if (roundText.length > 0 || roundReasoning.length > 0) {
        // Same citation priority as the clean-finish branch below:
        // outer-stream citations win over accumulated tool citations.
        const finalCitations =
          roundCitations ?? (toolCitations.length > 0 ? toolCitations : null);
        // Append the marker on its own line after whatever prose
        // arrived. An empty roundText with reasoning-only still gets
        // the marker as standalone content so the bubble renders
        // something - otherwise the user sees only the reasoning
        // panel with no indication the answer was cut.
        const interruptedContent =
          roundText.length > 0
            ? `${roundText}\n\n${INTERRUPTED_MARKER}`
            : INTERRUPTED_MARKER;
        const msg = await supabase.addMessage(
          thread.id,
          'assistant',
          interruptedContent,
          {
            model: modelId,
            // Usage frame often doesn't land before the abort - Venice
            // emits it after the last choice-bearing frame. The column
            // is nullable; the context ring simply hides on absence.
            usage: roundUsage,
            reasoning: roundReasoning.length > 0 ? roundReasoning : null,
            citations: finalCitations,
          }
        );
        handlers?.onAssistantPersisted?.(msg);
        lastAssistantId = msg.id;
      }
      finalText = roundText;
      break;
    }

    // No tool calls → this is the final assistant message. Persist and
    // exit; no need for a tool round.
    if (roundCalls.length === 0) {
      // Persist when there is text, reasoning, or both. A response with
      // only reasoning_content (content === "") is valid - kimi-k2 and
      // some other models emit reasoning-only turns - and must be saved
      // so the streaming bubble isn't orphaned when the stream closes.
      if (roundText.length > 0 || roundReasoning.length > 0) {
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
        // Pass current message's attachments so analyze_image can find
        // image bytes by filename without a DB query inside the tool.
        attachments: currentMessageAttachments,
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
        // `toggle_toolbox` is the only tool that changes the gated-
        // toolbox set; observe its return value instead of a separate
        // DB re-fetch. The tool's execute handler already filtered the
        // incoming names against the known toolbox list, so whatever
        // we read back here is a valid array.
        if (call.function.name === toggleToolbox.name) {
          const raw = (value as { enabled?: unknown })?.enabled;
          const next = Array.isArray(raw)
            ? raw.filter((v): v is string => typeof v === 'string')
            : [];
          if (!sameToolboxSet(next, toolboxesEnabled)) {
            toolboxesEnabled = next;
            handlers?.onToolboxesEnabledChange?.(toolboxesEnabled);
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
    // Arguments are sanitised before going back on the wire - see
    // sanitizeToolCallsForWire for the rationale (Venice 400s on a
    // malformed arguments JSON string and the failure rides every
    // subsequent round unless we normalise here).
    history.push({
      role: 'assistant',
      content: roundText,
      tool_calls: sanitizeToolCallsForWire(roundCalls),
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

  return { finalText, roundsRun, stoppedByLimit, interrupted, toolboxesEnabled };
}
