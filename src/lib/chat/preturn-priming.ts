/**
 * Pre-turn priming orchestration: everything `runChatLoop` runs once,
 * before the first streaming round, to shape the turn. It races the
 * samskara compound + situational-fire bundle against a timeout, reads
 * the thread-attachments inventory and the bias-profile block, fires the
 * intuition and context-recall pipelines (each owns its own fire policy
 * via its `maybeRun*` entry point), and splices the resulting synthetic
 * `<think>` chain onto the `history` baton in the contracted order.
 *
 * The fire-decision, freshness, and injection-order rules this module
 * implements are specified in docs/dev/prompt-augmentation.md. It mutates
 * the passed `history` in place (pushing the `<think>` rows) and returns
 * the three values the request assembly needs back.
 */
import type { SupabaseService, Thread, ThreadAttachmentSummary } from '../supabase';
import type { VeniceMessage } from '../venice';
import {
  fireSamskaras,
  formatPrimingThinks,
  getCompoundSummary,
  type FireResult,
} from '../samskara';
import {
  getBiasProfileBlock,
  notifyBiasNewUserMessage,
  snapshotBiasActiveBiases,
} from '../bias';
import {
  buildIntuitionThinkMessage,
  countUserRounds,
  isPayloadFreshForInjection,
  maybeRunIntuitionPipeline,
  readIntuitionCache,
  writeIntuitionCache,
  type IntuitionPayload,
} from '../intuition';
import {
  buildContextRecallThinkMessage,
  maybeRunContextRecallPipeline,
  readContextRecallCache,
  writeContextRecallCache,
  type ContextRecallPayload,
} from '../context-recall';
import type { ChatLoopHandlers, SubconsciousOp } from './types';

/**
 * Hard cap on the wait for samskara priming before the first
 * assistant round starts. Common case lands well under this; the
 * cap exists so a slow Venice or a hiccup in the cosine RPC can't
 * add visible latency to the user's first token. Picked at 1500ms
 * because async chat tolerates a half-second send delay but not
 * more - anything beyond that and the user starts noticing.
 */
const SAMSKARA_PRIMING_TIMEOUT_MS = 1500;

/** Inputs the priming run reads. Mirrors the chat-loop turn options it needs. */
export interface PreTurnPrimingOptions {
  supabase: SupabaseService;
  thread: Thread;
  userId: string;
  /** Mutated in place: the `<think>` priming chain is pushed onto the tail. */
  history: VeniceMessage[];
  signal: AbortSignal;
  handlers?: ChatLoopHandlers;
  intuitionModelId?: string;
  intuitionMood?: { band: number; column: 'confident' | 'tentative' } | null;
  contextRecallEnabled?: boolean;
}

/** What the request assembly needs back from the priming run. */
export interface PreTurnPrimingResult {
  currentUserRound: number;
  attachmentSummaries: ThreadAttachmentSummary[];
  biasProfileBlock: string | null;
}

// Extract the plain text of a user message, flattening the multimodal
// content-part array to its text parts. Used to seed the samskara fire
// embed with the turn's user text.
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
 * Run the once-per-turn priming. Mutates `history` (pushes the <think>
 * chain) and returns the values the request assembly consumes.
 */
export async function runPreTurnPriming(
  opts: PreTurnPrimingOptions
): Promise<PreTurnPrimingResult> {
  const {
    supabase,
    thread,
    userId,
    history,
    signal,
    handlers,
    intuitionModelId,
    intuitionMood,
    contextRecallEnabled,
  } = opts;

  const userText = extractUserText(history[history.length - 1]);
  // User-round index for the current turn (1-based count of user
  // messages in history, including the just-sent one). Hoisted up
  // here from its later use because fireSamskaras now persists this
  // value on every cohort fire so the per-message inline UI can
  // anchor each cohort to the user message that triggered it. The
  // count includes the current user message because history's last
  // element is that message at this point in the loop.
  const currentUserRound = countUserRounds(history);
  // Samskara priming bundle: compound summary (always-on across
  // turns) + situational fire (top-k for THIS user text). Both
  // resolve to potentially-null `<think>` block bodies; the chat-loop
  // pushes them as separate assistant <think> messages after the
  // user turn. Cold-start threads (no formation rows yet) produce
  // both-null and skip the pushes entirely.
  //
  // The old opening-recall pipeline used to ride alongside this
  // bundle on the opening turn. Context-recall now covers the
  // cold-start memory-pull job (memory_recall, conversation_recall,
  // wiki_recall children stitched into one note), leaving the
  // priming bundle smaller and the wire shape simpler.
  interface PrimingBundle {
    compoundThink: string | null;
    fireThink: string | null;
  }
  // Bracket a subconscious-priming pipeline's promise with the UI
  // start/end signals. Start fires synchronously (the throbber should
  // appear the instant the pipeline is kicked off, not a microtask
  // later); End fires when the promise settles, success or failure -
  // the row tracks liveness, not outcome. No-op when handlers is
  // absent. Returns the same promise so call sites read as a thin
  // wrapper around the underlying work.
  const trackSubconscious = <T>(op: SubconsciousOp, work: Promise<T>): Promise<T> => {
    handlers?.onSubconsciousStart?.(op);
    return work.finally(() => handlers?.onSubconsciousEnd?.(op));
  };

  const primingWork = (async (): Promise<PrimingBundle> => {
    const [compoundSummary, fireResult] = await Promise.all([
      getCompoundSummary(supabase),
      trackSubconscious(
        'samskara',
        fireSamskaras(supabase, thread.id, currentUserRound, userText, signal)
      ),
    ]);
    const { compound, fire } = formatPrimingThinks({
      compoundSummary,
      fire: fireResult as FireResult | null,
    });
    return { compoundThink: compound, fireThink: fire };
  })();
  const priming = await Promise.race<PrimingBundle>([
    primingWork,
    new Promise<PrimingBundle>((resolve) =>
      setTimeout(
        () => resolve({ compoundThink: null, fireThink: null }),
        SAMSKARA_PRIMING_TIMEOUT_MS,
      ),
    ),
  ]);

  // Per-turn thread-attachments inventory. Lists every file attached
  // anywhere in the conversation by category (live images, live
  // documents, expired) so the model has a holistic view rather than
  // having to scan every prior user turn for inline notes. The query
  // is a single thread-scoped SELECT against `message_attachments` and
  // doesn't go through Venice, so it stays out of the priming race and
  // its associated timeout. Failure is swallowed - the model falls
  // back to the per-message inline note rendered by
  // buildUserVeniceContent, same as before this block existed.
  const attachmentSummaries: ThreadAttachmentSummary[] = await supabase
    .listAttachmentSummariesForThread(thread.id)
    .catch(() => []);

  // Bias-profile block. One cached SELECT against bias_summary; null
  // on cold start (no observations yet) or when no row clears the
  // elided tier. The block rides at the end of the baseline system
  // prompt rather than as a per-turn ambient context message because
  // the profile is a slowly-changing structural claim about the user,
  // not turn-specific weather. Read once at turn entry; reused across
  // every round of this turn. Errors are swallowed inside
  // getBiasProfileBlock; `activeBiases` is the set that actually
  // rendered (post tier filter, post render cap) and feeds the v2
  // snapshot write below.
  const { block: biasProfileBlock, activeBiases: biasActiveBiases } =
    await getBiasProfileBlock(supabase);

  // Bias-profile invalidation. Each chat-loop invocation corresponds
  // to one new user message on this thread. If the thread had been
  // analyzed by the bias sweep before, the prior observations are
  // now based on a stale view of the conversation; clear them. The
  // RPC is a no-op when the thread was never processed, so calling
  // unconditionally is correct and cheap. Fire-and-forget: bias
  // plumbing must never block a chat turn.
  void notifyBiasNewUserMessage(supabase, thread.id);

  // Bias-profile active-set snapshot (v2). Persist the bias keys
  // that just rendered into the system prompt to
  // threads.bias_active_at_turn so the bias sweep's reactor pass
  // knows which biases the user's messages on this turn could have
  // been reacting to. Empty array is a valid write and means "no
  // compensation guidance was active this turn" - the reactor
  // pass produces zero rows and the feedback EMA stays unchanged.
  // Fire-and-forget; errors swallowed inside the helper.
  void snapshotBiasActiveBiases(supabase, thread.id, biasActiveBiases);

  // Subconscious-priming layer: two parallel pipelines, fired on the
  // same trigger machinery (cold-start, mid-turn title shift, mood
  // shift, stale fuse) but writing to independent caches and producing
  // independent synthetic <think> blocks.
  //
  //   1. Intuition (perception + 5 drives + synthesis). Cache lives on
  //      threads.intuition_payload. Skipped entirely when
  //      `intuitionModelId` is absent.
  //   2. Context recall (memory_recall + conversation_recall stitched
  //      into one note). Cache lives on threads.context_recall_payload.
  //      Skipped entirely when `contextRecallEnabled` is false/absent.
  //
  // Both pipelines read the trigger evaluator independently: each
  // payload carries its own `computed_at_round`, so the same-round
  // debounce works per-cache and a turn that already refreshed one
  // pipeline can still fire the other. When both fire on the same
  // trigger evaluation we run them in parallel via Promise.all - the
  // wall-clock cost is max(intuition, context-recall) plus one
  // Promise.all on the persist writes, not additive.
  //
  // `currentUserRound` is computed up at the top of this function
  // (before priming) because fireSamskaras now needs it to anchor
  // each cohort to a user-message round. Tool-using rounds inflate
  // the chat-loop's internal `round` counter but do not change this
  // value - one user message, one round id, regardless of how many
  // tool calls happen during the response.
  let intuitionCache: IntuitionPayload | null = readIntuitionCache(thread);
  let contextRecallCache: ContextRecallPayload | null =
    readContextRecallCache(thread);

  // Fire-policy (the feature gates, trigger evaluation, and inflight
  // dedup) lives inside each pipeline's maybeRun entry point - the
  // loop supplies inputs and owns sequencing only. The onWillRun
  // hooks are where the UI status signals attach: they fire at the
  // moment a pipeline commits to running, so a no-trigger turn never
  // flashes a status chip.
  let intuitionStarted = false;
  let contextRecallStarted = false;
  // One wall-clock snapshot shared by both pipelines' staleness fuse
  // and the injection guard below, so "should we refresh" and "is the
  // cache fresh enough to inject" judge against the same instant.
  const nowMs = Date.now();
  const [freshIntuition, freshContextRecall] = await Promise.all([
    maybeRunIntuitionPipeline({
      supabase,
      threadId: thread.id,
      modelId: intuitionModelId,
      cache: intuitionCache,
      history,
      signal,
      round: currentUserRound,
      mood: intuitionMood ?? null,
      nowMs,
      onWillRun: () => {
        intuitionStarted = true;
        handlers?.onSubconsciousStart?.('intuition');
      },
    }).finally(() => {
      if (intuitionStarted) handlers?.onSubconsciousEnd?.('intuition');
    }),
    maybeRunContextRecallPipeline({
      supabase,
      threadId: thread.id,
      userId,
      enabled: contextRecallEnabled,
      cache: contextRecallCache,
      signal,
      round: currentUserRound,
      mood: intuitionMood ?? null,
      nowMs,
      onWillRun: () => {
        contextRecallStarted = true;
        handlers?.onSubconsciousStart?.('recall');
      },
    }).finally(() => {
      if (contextRecallStarted) handlers?.onSubconsciousEnd?.('recall');
    }),
  ]);

  // Persist both writes in parallel. The await-before-continuing
  // rationale on the existing intuition write applies symmetrically
  // to context-recall: a race against an unrelated thread UPDATE
  // (an update_title call mid-turn, a server-side curation write, a
  // cross-tab edit) could otherwise strand a fresh payload behind a
  // stale realtime echo. Cost is ~50-200ms of one Supabase UPDATE
  // each, parallel-merged into one wait.
  const persistOps: Promise<void>[] = [];
  if (freshIntuition) {
    intuitionCache = freshIntuition;
    persistOps.push(writeIntuitionCache(supabase, thread.id, freshIntuition));
  }
  if (freshContextRecall) {
    contextRecallCache = freshContextRecall;
    persistOps.push(
      writeContextRecallCache(supabase, thread.id, freshContextRecall)
    );
  }
  if (persistOps.length > 0) await Promise.all(persistOps);

  // UI handlers fire AFTER the writes settle - same ordering the
  // prior intuition-only path enforced, for the same reason: a
  // realtime echo that arrives between the patch and the write must
  // see the persisted payload, not a transient null.
  if (freshIntuition) handlers?.onIntuitionUpdate?.(freshIntuition);
  if (freshContextRecall)
    handlers?.onContextRecallUpdate?.(freshContextRecall);

  // Inject the synthetic `<think>` priming chain. Order matters for how
  // the model reads its own internal layers, from broadest to most
  // turn-specific:
  //
  //   1. Context-recall - stitched first-person note across the three
  //      persistent layers (memories, prior conversations, wiki).
  //      Covers cold-start memory pull as well as mid-thread topic
  //      shifts; the old opening-recall pipeline retired in favor of
  //      letting context-recall handle the opening turn too.
  //   2. Samskara compound prose - the "current model of the user"
  //      summary the formation worker maintains across turns.
  //   3. Samskara situational fire - top-k predictions for THIS user
  //      turn, rendered as first-person observations with
  //      parenthetical confidence hedges.
  //   4. Intuition synthesis - the most-processed layer (perception +
  //      5 drives + synthesis), reads cleanly as the last think block.
  //      The per-turn metadata system row rides after this whole chain
  //      (see the request assembly below), so a trailing system block
  //      follows intuition even though it is the final <think>.
  //
  // Each push is conditional: an empty-note context-recall, a
  // cold-start thread with no compound summary, a turn where the fire
  // top-k came back empty, an intuition-disabled thread - any of those
  // skips its push so we never burn tokens on an empty `<think>` block.
  // Injection guard: a payload older than the staleness fuse never
  // reaches the wire, even as a <think> block. Normally the trigger
  // above already refreshed anything this old, so the freshly-written
  // cache passes. The guard is the backstop for the cases the refresh
  // could not cover - the pipeline erroring out, an inflight-dedup
  // returning null, or the feature being off this turn - where the
  // cache would otherwise still hold a stale snapshot. Injecting a
  // day-old intuition synthesis (an imperative aimed at a situation
  // that no longer exists) actively steers the model wrong, so we
  // suppress rather than poison; the next triggering turn recomputes.
  // isPayloadFreshForInjection shares STALE_FUSE_MS with the refresh
  // trigger so the two judgments stay in lockstep.
  if (
    contextRecallCache &&
    isPayloadFreshForInjection(contextRecallCache, nowMs)
  ) {
    const msg = buildContextRecallThinkMessage(contextRecallCache);
    if (msg !== null) history.push(msg);
  }
  if (priming.compoundThink !== null) {
    history.push({
      role: 'assistant',
      content: `<think>\n${priming.compoundThink}\n</think>`,
    });
  }
  if (priming.fireThink !== null) {
    history.push({
      role: 'assistant',
      content: `<think>\n${priming.fireThink}\n</think>`,
    });
  }
  if (intuitionCache && isPayloadFreshForInjection(intuitionCache, nowMs)) {
    history.push(buildIntuitionThinkMessage(intuitionCache));
  }

  return { currentUserRound, attachmentSummaries, biasProfileBlock };
}
