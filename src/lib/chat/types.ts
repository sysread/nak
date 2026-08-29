/**
 * Chat-turn contract types. The option/result/handler shapes that
 * `runChatLoop` (./loop.ts) takes and returns, plus the
 * stream consumer (./stream-events.ts) shares. Kept in their own
 * module so the behavior files stay focused on logic and so UI code
 * that only needs the `SubconsciousOp` vocabulary doesn't import a
 * large behavior module to get one string union.
 */

import type { ReasoningEffort, Verbosity } from '../models';
import type { SupabaseService, Message, Thread } from '../supabase';
import type { VeniceClient, VeniceMessage } from '../venice';
import type { OpenAIToolCall, Toolbox } from '../tools';
import type { IntuitionPayload } from '../intuition';
import type { ContextRecallPayload } from '../context-recall';

/**
 * Which subconscious-priming pipeline a status signal refers to. These
 * are the three pre-response background jobs the chat-loop runs before
 * a turn:
 *
 *   'samskara'  - situational fire (top-k predictions for this turn).
 *   'intuition' - perception + drives + synthesis.
 *   'recall'    - context recall (memory + conversation stitched note).
 *
 * Used by the handler liveness pair (onSubconsciousStart/End) so the
 * UI can show a per-pipeline throbber while each runs.
 */
export type SubconsciousOp = 'samskara' | 'intuition' | 'recall';

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
   * The thread title changed mid-turn (triggered by an `update_title`
   * call from the model). Fires with the sanitised title the handler
   * actually wrote. The UI uses this to patch the thread row and
   * re-bucket the drawer immediately, instead of waiting for the
   * end-of-turn `refreshThreads()` to pick the new title up.
   */
  onTitleChange?(title: string): void;
  /**
   * A fresh intuition payload was computed for this thread (the
   * pre-round trigger or stale-fuse). Fires with the new payload
   * so the UI can update the modal / inline indicator without waiting
   * for the next thread re-fetch. Skipped on rounds where the cache is
   * reused as-is - we only signal *changes*.
   */
  onIntuitionUpdate?(payload: IntuitionPayload): void;
  /**
   * A fresh context-recall payload was computed for this thread (the
   * pre-round trigger or stale fuse fired and the pipeline produced a
   * payload). Sibling of onIntuitionUpdate -
   * fires once per refresh, with the freshly-computed payload, so the
   * UI can patch the in-memory thread row without waiting for the
   * next thread re-fetch. Skipped on rounds where the cache is reused
   * as-is.
   */
  onContextRecallUpdate?(payload: ContextRecallPayload): void;
  /**
   * A subconscious-priming pipeline started (`...Start`) or settled
   * (`...End`) for this turn. A liveness pair, like
   * onRateLimitWait/onRateLimitResolved: every Start is followed by
   * exactly one End regardless of outcome (fresh payload, empty result,
   * or error - the throbber signals "this is running", not "this
   * succeeded"). `op` keys which pipeline fired. Intuition and recall
   * run in parallel and the samskara fire overlaps both, so more than
   * one op can be active at once; the UI tracks a set, not a single
   * flag. The samskara End can land after the priming race timeout has
   * already let the turn proceed (the fire keeps running in the
   * background), so a UI consuming these must tolerate an End that
   * arrives once streaming is well underway.
   */
  onSubconsciousStart?(op: SubconsciousOp): void;
  onSubconsciousEnd?(op: SubconsciousOp): void;
  /**
   * Priming is complete and the first Venice completion is about to
   * start. The UI dismisses the pregame (subconscious priming) card
   * on this signal so it does not stay visible when a model emits
   * tool calls without preamble text.
   */
  onBegin?(): void;
  /**
   * The current round hit a Venice 429 and the loop is going to wait
   * before re-issuing the request. Fires once per wait, before the
   * sleep starts; `onRateLimitResolved` fires when the next attempt
   * begins (whether or not it succeeds). The UI uses this pair to
   * swap the streaming-bubble spinner for a "waiting on Venice"
   * indicator with a cancel button. The cancel path is the same
   * abort signal the stop button uses - aborting during the wait
   * lands in the existing AbortError branch and writes an
   * INTERRUPTED_MARKER row, identical to a mid-stream cancel.
   *
   * `attempt` is 1-indexed - the first wait after the initial 429
   * is attempt 1. `until` is a wall-clock epoch ms target, suitable
   * for rendering a live countdown. `retryAfterMs` is the parsed
   * hint from the Venice headers (Retry-After or
   * x-ratelimit-reset-{requests,tokens}); null when Venice didn't
   * supply one and the loop fell back to its own backoff.
   */
  onRateLimitWait?(info: {
    retryAfterMs: number | null;
    attempt: number;
    until: number;
  }): void;
  /**
   * A rate-limit wait period has ended - either the sleep elapsed
   * and the next attempt is starting, or the request that followed
   * a wait succeeded. Always fires after a matching
   * `onRateLimitWait`. The UI uses this to swap the waiting
   * indicator back to the normal streaming spinner.
   */
  onRateLimitResolved?(): void;
  /**
   * An output guard rejected the current streaming attempt as junk
   * (e.g. a leaked special token) and the loop is re-rolling. Fires
   * once per re-roll, before the next attempt's stream opens, with the
   * tripping guard's name and the 1-based retry number. None of the
   * discarded attempt's text reached the consumer, so the UI's job is
   * cosmetic: drop a stylized "discarded a glitch, regenerating" notice
   * (the "oops, all slop!" card) and reset the streaming buffers so the
   * replacement renders cleanly. The notice is animated away once the
   * replacement persists.
   */
  onGuardRetry?(info: { guard: string; attempt: number }): void;
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
   * Kill switch for reasoning. When true, every streamChat call this
   * turn ships `venice_parameters.disable_thinking: true`. Caller
   * (Chat.svelte) is expected to also omit `reasoningEffort` when this
   * is true - the two knobs are mutually exclusive on the wire
   * (reasoning_effort: 'low' shrinks the CoT but doesn't disable it;
   * disable_thinking is the full off switch). Set when the thread's
   * resolved thinking level is 'off' - e.g. a model profile whose
   * default reasoning is Off - so the turn stays fast even though the
   * profile fronts a reasoning-capable model.
   */
  disableThinking?: boolean;
  /**
   * Optional text.verbosity knob forwarded to every streamChat call.
   * Unlike reasoningEffort there's no model-capability gate — providers
   * that don't recognize the field silently ignore it.
   */
  verbosity?: Verbosity;
  /**
   * When true, the per-turn metadata system message carries a short
   * formatting nudge asking the model to sprinkle light Markdown
   * emphasis (bold terms, italic phrases) through its reply as
   * scan-points. Opt-in; the block is skipped when false/absent so
   * users who didn't ask for it never see formatting hints. See
   * `buildMetadataSystemMessage` for the exact wording - modifying
   * it changes model behaviour on every turn of every user who has
   * the toggle on.
   */
  emphasisMarkdown?: boolean;
  /**
   * Optional free-form display name + location the user entered in
   * Settings -> AI -> About you. When either is non-empty, the
   * per-turn metadata system message opens with a short identity
   * paragraph so the model can address the user naturally and
   * ground location-specific answers (weather, local time, regional
   * context). Both empty / absent skips the block entirely so a
   * fresh account pays zero tokens. See `buildMetadataSystemMessage`
   * for the exact rendered shape - editing that wording changes
   * model behaviour on every turn of every user who has filled the
   * form.
   */
  userName?: string | null;
  userLocation?: string | null;
  /**
   * IANA timezone used to format the wall-clock paragraph the
   * per-turn metadata system message opens with (see
   * `buildDatetimeParagraph`). When null / undefined the helper falls
   * back to the runtime's reported zone (typically the browser's
   * own). A wrong value here surfaces as the model giving the user
   * the wrong wall-clock time.
   */
  displayTimezone?: string | null;
  /**
   * ISO 8601 `created_at` of the most recent persisted assistant
   * message on the thread, used to compute the "about X since your
   * last reply" sentence in the per-turn metadata system message.
   * Null / undefined on the opening turn of a thread (no prior
   * assistant message); the metadata message then omits the elapsed
   * sentence rather than shipping a meaningless "just now". Caller
   * (Chat.svelte) walks its `messages` array for the latest
   * role==='assistant' row - synthetic ephemeral injections
   * (intuition / context-recall / samskara `<think>` blocks) are
   * not persisted and therefore not eligible anchors, which is the
   * correct semantic: "how long since your last actual reply to the
   * user?".
   */
  lastAssistantTimestamp?: string | null;
  /**
   * Id of the user message that opened this turn. Anchors the
   * streaming-root request: the function uses it to pair the streamed
   * assistant row to its parent user message via the
   * commit_assistant_message RPC's conflict check, and the browser
   * passes it to /stream so a concurrent foreign send is detected
   * server-side. Required since the streaming-root collapse - the
   * direct-Venice path that previously coped with its absence no
   * longer runs from here.
   */
  userMessageId: string;
  /**
   * Regenerate-from-here replace range: DB row ids the new completion
   * replaces (the clicked assistant turn plus everything after it).
   * Rides the /stream request into the commit_assistant_message RPC,
   * which excludes these rows from its newer-user-message conflict
   * check - they are still in the DB while the replacement streams -
   * and deletes them atomically with the terminal commit. Omitted on
   * plain sends; the caller filters out synthetic recovery rows
   * (never persisted, sentinel ids) before passing.
   */
  supersededIds?: readonly string[];
  /**
   * Destructive-edit atomic insert: the edited text that replaces
   * the old user message. When set, the browser does NOT insert a
   * new user message before the exchange; instead, the
   * commit_assistant_message RPC inserts it + deletes the old range
   * + commits the assistant reply in one transaction. On failure
   * (abort/error), nothing was inserted - the edit is a clean no-op.
   */
  replaceUserMessageContent?: string;
  /**
   * Concrete Venice model id used by the intuition pipeline's drive
   * reactions (stage 2) and synthesis (stage 3). The perception stage
   * (stage 1) uses `intuitionPerceptionModelId` instead, because it
   * reads the entire transcript and needs a larger context window.
   * Caller resolves both via agentModel. Omitted / undefined disables
   * the intuition feature entirely on this turn - older callers (older
   * test fixtures) keep working without knowing the field exists. The
   * cache is left untouched when this is absent, so a turn without an
   * intuition model doesn't invalidate prior payloads.
   */
  intuitionModelId?: string;
  /**
   * Venice model id for the intuition PERCEPTION stage only - the one
   * stage that reads the entire untrimmed thread transcript. Routed to
   * a 1M-window id (deepseek-v4-flash-0731-fast) so a long thread does
   * not overflow context. The drive reactions and synthesis stages
   * ride `intuitionModelId` (mistral, 256k) because their inputs are
   * short. Falls back to `intuitionModelId` when absent, preserving
   * backward compat for callers that predate the split.
   */
  intuitionPerceptionModelId?: string;
  /**
   * Mood snapshot at turn-entry. The chat-loop compares it against the
   * cached payload's mood snapshot to decide whether the band /
   * confidence column has shifted enough to warrant a refresh. Null /
   * undefined disables the mood-shift trigger - the cold-start and
   * stale-fuse triggers still operate. Both bands and column come from the same
   * MOOD_TABLE the samskara mood pill renders against (see
   * src/lib/samskara/events.ts).
   */
  intuitionMood?: { band: number; column: 'confident' | 'tentative' } | null;
  /**
   * Whether to run the context-recall pipeline alongside intuition.
   * When true, the same trigger evaluator that schedules an intuition
   * refresh ALSO schedules a context-recall refresh (cold-start, mid-
   * turn title shift, mood-band shift, stale fuse) - the two pipelines
   * run in parallel, both write their own cache columns, and both
   * inject their own synthetic <think> block into the priming chain.
   *
   * Independent of `intuitionModelId`: a caller can run only intuition,
   * only context-recall, both, or neither. The trigger evaluator is
   * shared; the cache + pipeline machinery is sibling-but-separate.
   *
   * Omitted / false: the context-recall pipeline does not fire, the
   * cache is left untouched, and `onContextRecallUpdate` never invokes -
   * identical pre-feature behaviour, so older tests / callers stay
   * green without knowing the field exists.
   */
  contextRecallEnabled?: boolean;
  /**
   * Skip the STANDARD server-side priming stage for this turn - the
   * bias appendix AND the samskara / intuition / context-recall
   * `<think>` chain. Two callers set it:
   *
   * - The second-thoughts refinement turn (Chat.svelte `refineFrom`):
   *   a refinement is the model reconsidering its own prior answer,
   *   NOT a new user round, so re-running the user-round-keyed priming
   *   would double-fire the samskara situational cohort for one round
   *   (pipeline pollution) and bury the refinement's own `<think>`
   *   doubt behind the samskara chain. The refinement carries the
   *   doubt block itself, plus the targeted samskara probe driven by
   *   `refinementDoubtNote` below.
   * - The user-requested quick send (Chat.svelte lightning bolt): a
   *   normal user round whose pre-flight injection is skipped so the
   *   first token lands sooner. Unlike a refinement it omits the
   *   doubt note and the targeted probe - NOTHING is injected.
   *
   * Either way, callers must also omit the intuition/recall inputs
   * (intuitionModelId, contextRecallEnabled) - `skipPriming` alone
   * gates only the samskara chain + bias; those two pipelines gate on
   * their own inputs. Omitted / false leaves priming running as
   * normal.
   */
  skipPriming?: boolean;
  /**
   * The second-thoughts doubt note (the reviewer's first-person
   * twinge) for a refinement turn. The server keys ONE read-only
   * samskara probe to it - cross-thread patterns spliced as a single
   * `<think>` block so the full-context deliberation can weigh the
   * low-context reviewer's twinge against what the model knows about
   * this user. No cohort is recorded. Only meaningful alongside
   * `skipPriming`; omitted on normal turns.
   */
  refinementDoubtNote?: string;
  /**
   * True when the user message that opened this turn carries one or
   * more attachments. Drives the metadata message's anti-fabrication
   * reinforcement (see `buildMetadataSystemMessage`), which pins the
   * model's claims about a file to content it actually inspected this
   * turn. Omitted / false on turns with no upload (and for older
   * callers / tests) so a text-only turn pays zero tokens for it.
   */
  currentTurnHasAttachments?: boolean;
  /**
   * Whether the send-time model accepts inline image_url parts
   * (ModelSpec.supportsVision, snapshotted by the caller alongside the
   * history build so both read the same spec). Drives the
   * thread-attachments block's live-images phrasing: a vision model is
   * told its images are already visible instead of being instructed to
   * call analyze_image for them. See `buildMetadataSystemMessage`.
   */
  modelSupportsVision?: boolean;
  /**
   * The dynamic MCP-integration toolboxes the user has authorized,
   * built by the caller (Chat.svelte) via buildMcpToolboxes from
   * `app.mcpIntegrations` + `app.mcpToolSchemas`. Forwarded to
   * buildSystemPrompt, buildToolList, and the per-turn metadata
   * toolbox-state block so a `mcp:<id>` toolbox composes with the
   * static catalog under one dedup-by-name pass. Absent / empty on
   * accounts with no connected integrations - the static catalog
   * alone ships, byte-identical to pre-MCP behaviour.
   */
  mcpToolboxes?: readonly Toolbox[];
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
   * True when the terminal assistant row could not be committed because
   * another device inserted a new user message after the user message
   * this loop was responding to. The generated content is discarded
   * server-side; the caller should surface a "conversation changed on
   * another device" prompt rather than treating this as an error.
   * Only set when userMessageId was provided; always false otherwise.
   */
  conflictDetected: boolean;
  /**
   * Non-null when the loop exited because the model called the
   * `ask_user` tool and is now waiting on a human answer. The tool-
   * result row is already written (carrying the pending sentinel as
   * its content) so the wire shape stays valid; conversation-recovery
   * sees every tool_call_id matched and stays a no-op. The caller
   * (Chat.svelte) is expected to surface the question via the
   * AskUserCard UI, fire a notification, and on submit:
   *   1. UPDATE the tool row's content to the answer payload via
   *      `supabase.updateToolMessageContent(threadId, toolCallId, ...)`,
   *   2. Re-invoke `runChatLoop` against the updated history.
   *
   * The substrate stub is intentionally skipped on suspend (the turn
   * is not yet logically complete); the next runChatLoop call writes
   * it when the turn actually terminates.
   *
   * `toolCallId` is the same id the chat-loop wrote on the pending
   * tool row; the answer-write path locates the row by it. `question`
   * and `options` are forwarded so the UI doesn't have to re-parse
   * the persisted content on the same-tab happy path.
   */
  awaitingUserAnswer: {
    toolCallId: string;
    question: string;
    options: { label: string; description: string }[];
  } | null;
}
