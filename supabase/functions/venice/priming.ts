// priming ---------------------------------------------------------------------
//
// Server-side turn-entry priming - the opening stage of
// getStreamingResponse. It runs under the same EdgeRuntime.waitUntil
// that keeps streaming alive across a browser disconnect, so "come back
// to a finished answer" holds for the whole turn rather than just the
// streaming half (the reason priming lives here rather than in the
// browser before the /stream POST).
//
// Four pipelines feed the priming chain: bias renders a system-prompt
// appendix (no per-turn UI wire event); intuition, context-recall, and
// samskara each contribute a synthetic <think> row and publish their
// PrimingEvents on the stream channel.
//
// Admin-client scoping: the orchestrator holds a service-role client
// with no auth.uid(), so every read/write here scopes by the explicit
// opts.userId rather than leaning on RLS.
import { type SupabaseClient } from '@supabase/supabase-js';
import { isBiasKey } from '../_shared/bias-catalog.ts';
import {
  type BiasSummaryRow,
  formatBiasProfileBlock,
  pickRenderable,
} from '../_shared/bias-format.ts';
import {
  formatIntentsBlock,
  pickRenderable as pickRenderableIntents,
  INTENT_RENDER_CAP,
  COMBINED_APPENDIX_CEILING,
  type IntentRenderRow,
} from '../_shared/intent-format.ts';
import { createEdgeLogger, type EdgeLogger } from '../_shared/edge-log.ts';
import {
  countUserRounds,
  evaluatePreRoundTrigger,
  type IntuitionTrigger,
  isPayloadFreshForInjection,
} from '../_shared/priming-triggers.ts';
import { type BroadcastPublisher } from './broadcast.ts';
import {
  fireSamskaras,
  getCompoundSummary,
  queryFiredSamskaras,
} from './priming/samskara.ts';
import {
  formatPrimingThinks,
  formatRefinementFireThink,
} from './priming/samskara-format.ts';
import {
  type IntuitionPayload,
  buildIntuitionThinkMessage,
  coerceIntuitionPayload,
} from './priming/intuition-payload.ts';
import { runIntuitionPipeline } from './priming/intuition.ts';
import {
  type ContextRecallPayload,
  buildContextRecallThinkMessage,
  coerceContextRecallPayload,
} from './priming/context-recall-payload.ts';
import { runContextRecallPipeline } from './priming/context-recall.ts';

// Hard cap on the wait for samskara priming before the first round
// starts. The common case lands well under this; the cap exists so a
// slow Venice or a hiccup in the cosine RPC cannot add visible latency
// to the first token.
const SAMSKARA_PRIMING_TIMEOUT_MS = 1500;

// Minimal structural shape of a wire message the priming step mutates.
// Matches getStreamingResponse's local VeniceMessage without importing
// its private interface.
interface PrimingMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
}

export interface BiasPrimingOpts {
  adminClient: SupabaseClient;
  userId: string;
  threadId: string;
  /** Mutated in place: the bias block is appended to the row-0 system
   *  message when present. */
  history: PrimingMessage[];
  log: EdgeLogger;
}

/**
 * Read the user's cached bias aggregates, render the "observed
 * cognitive patterns" block, append it to the baseline system prompt,
 * and fire the two best-effort bias-sweep writes (active-set snapshot
 * and new-user-message clear).
 *
 * Swallow contract: bias plumbing never throws and never fails a turn.
 * A read failure or cold-start cache leaves the system prompt
 * unchanged.
 */
export async function applyBiasPriming(opts: BiasPrimingOpts): Promise<void> {
  const { adminClient, userId, threadId, history, log } = opts;

  let rows: BiasSummaryRow[];
  try {
    rows = await readBiasSummary(adminClient, userId);
  } catch (err) {
    log.debug('bias priming: summary read failed', err);
    rows = [];
  }

  const block = formatBiasProfileBlock(rows);
  // activeBiases is the set that actually rendered (post tier filter,
  // post render cap) - the same rule the formatter applies internally,
  // lifted out here so the snapshot write below records exactly what
  // landed in the prompt. Empty when nothing cleared soft.
  const activeBiases = pickRenderable(rows).map((r) => r.bias);

  if (block && block.length > 0) {
    // Bias rides at the end of the baseline system prompt (row 0),
    // joined with the same blank-line separator buildSystemPrompt uses,
    // so the wire bytes match what the browser used to bake in. The
    // trailing metadata system row is a SEPARATE message at the tail of
    // history; the bias block must not land there.
    const systemRow = history[0];
    if (systemRow && systemRow.role === 'system') {
      const base = systemRow.content ?? '';
      systemRow.content = base.length > 0 ? `${base}\n\n${block}` : block;
    } else {
      // Defensive: the browser always ships a role:system message
      // first. If that ever changes, skip injection rather than
      // corrupt an unexpected row - the turn proceeds unprimed.
      log.debug('bias priming: no leading system row; skipped injection');
    }
  }

  // Snapshot the active set so the bias sweep's reactor pass knows
  // which biases the user's messages this turn could have been
  // reacting to. Empty array is a valid write ("no compensation
  // active"). Detached + swallowed - never blocks or fails the turn.
  void snapshotBiasActiveBiases(adminClient, threadId, userId, activeBiases).catch(
    (err) => log.debug('bias priming: snapshot failed', err),
  );

  // Each turn is one new user message on this thread; clear the sweep's
  // processed state so a previously-analyzed thread gets re-observed
  // against the fresh conversation. No-op when never processed.
  // Detached + swallowed.
  void clearBiasThread(adminClient, threadId, userId).catch((err) =>
    log.debug('bias priming: clear thread failed', err),
  );
}

export interface IntentPrimingOpts {
  adminClient: SupabaseClient;
  userId: string;
  threadId: string;
  /** Mutated in place: the intents block is appended to the row-0
   *  system message AFTER the bias block. */
  history: PrimingMessage[];
  log: EdgeLogger;
}

/**
 * Gated on the per-user intents toggle (off by default). When enabled,
 * read the active intents, render the "Working intentions" block under
 * a bias-aware combined cap, and append it to the row-0 system message
 * AFTER the bias block - so the block's precedence note ("any
 * compensation guidance above") resolves correctly. Also snapshot the
 * rendered intent ids into threads.intent_active_at_turn for the
 * employment-classification half of evaluation (not yet built).
 *
 * MUST run sequenced after applyBiasPriming: both mutate the row-0
 * system message, so running them concurrently would race and lose one
 * block. runServerPriming chains them in one closure for this reason.
 *
 * Swallow contract: never throws, never fails a turn. Toggle off,
 * cold-start, or any read failure leaves the prompt unchanged.
 */
export async function applyIntentPriming(opts: IntentPrimingOpts): Promise<void> {
  const { adminClient, userId, threadId, history, log } = opts;

  // Toggle gate: a missing or false flag is a hard no-op - no intents
  // read, no injection, no snapshot.
  let enabled = false;
  try {
    const { data } = await adminClient
      .from('profiles')
      .select('settings')
      .eq('user_id', userId)
      .maybeSingle();
    enabled =
      (data?.settings as { intentsEnabled?: unknown } | null)?.intentsEnabled === true;
  } catch (err) {
    log.debug('intent priming: settings read failed', err);
  }
  if (!enabled) return;

  let rows: Array<{ id: string; statement: string }>;
  try {
    const { data, error } = await adminClient
      .from('intents')
      .select('id, statement')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('last_minted_at', { ascending: false });
    if (error) throw new Error(error.message);
    rows = (data ?? []) as Array<{ id: string; statement: string }>;
  } catch (err) {
    log.debug('intent priming: active intents read failed', err);
    return;
  }
  if (rows.length === 0) return;

  // Bias-aware combined cap: the bias appendix and this block share one
  // ceiling so two features cannot together crowd the instruction
  // surface. Count what bias actually rendered (cheap cached read) and
  // give intents the remainder, capped at their own ceiling.
  let biasRendered = 0;
  try {
    biasRendered = pickRenderable(await readBiasSummary(adminClient, userId)).length;
  } catch (err) {
    log.debug('intent priming: bias-count read failed; assuming 0', err);
  }
  const cap = Math.min(INTENT_RENDER_CAP, COMBINED_APPENDIX_CEILING - biasRendered);

  const renderRows: IntentRenderRow[] = rows.map((r) => ({
    statement: r.statement,
    status: 'active',
  }));
  const picked = pickRenderableIntents(renderRows, cap);
  // The rendered set is the first picked.length rows in the order the
  // renderer kept (active-filter is a no-op here - all are active - and
  // the cap is a head slice), so map those ids back for the snapshot.
  const renderedIds = rows.slice(0, picked.length).map((r) => r.id);

  const block = formatIntentsBlock(renderRows, { cap });
  if (block && block.length > 0) {
    const systemRow = history[0];
    if (systemRow && systemRow.role === 'system') {
      const base = systemRow.content ?? '';
      systemRow.content = base.length > 0 ? `${base}\n\n${block}` : block;
    } else {
      log.debug('intent priming: no leading system row; skipped injection');
    }
  }

  // Snapshot which intents were live in the prompt this turn. Empty is a
  // valid write ("none rendered"). Detached + swallowed - never blocks
  // or fails the turn.
  void snapshotIntentActive(adminClient, threadId, userId, renderedIds).catch((err) =>
    log.debug('intent priming: snapshot failed', err),
  );
}

async function snapshotIntentActive(
  adminClient: SupabaseClient,
  threadId: string,
  userId: string,
  intentIds: string[],
): Promise<void> {
  await adminClient
    .from('threads')
    .update({ intent_active_at_turn: intentIds })
    .eq('id', threadId)
    .eq('user_id', userId);
}

/**
 * Read every cached aggregate for the user from bias_summary, scoped
 * by explicit user_id (admin client has no auth.uid()). Unknown-key
 * rows are dropped - a key not in the catalog means the catalog was
 * edited but the cache is stale; safer to skip than to render an entry
 * whose guidance we cannot resolve.
 */
async function readBiasSummary(
  adminClient: SupabaseClient,
  userId: string,
): Promise<BiasSummaryRow[]> {
  const { data, error } = await adminClient
    .from('bias_summary')
    .select(
      'bias, effective_n, posterior_alpha, posterior_beta, posterior_mean, ci_lower, feedback_score, tier, computed_at',
    )
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  const raw = (data ?? []) as Array<{
    bias: string;
    effective_n: number;
    posterior_alpha: number;
    posterior_beta: number;
    posterior_mean: number;
    ci_lower: number;
    feedback_score: number | null;
    tier: 'elided' | 'soft' | 'strong';
    computed_at: string;
  }>;
  const rows: BiasSummaryRow[] = [];
  for (const r of raw) {
    if (!isBiasKey(r.bias)) continue;
    rows.push({
      bias: r.bias,
      effectiveN: r.effective_n,
      posteriorAlpha: r.posterior_alpha,
      posteriorBeta: r.posterior_beta,
      posteriorMean: r.posterior_mean,
      ciLower: r.ci_lower,
      // feedback_score was added in v2; pre-v2 rows return null which
      // we treat as the neutral 0.
      feedbackScore: r.feedback_score ?? 0,
      tier: r.tier,
      computedAt: r.computed_at,
    });
  }
  return rows;
}

/**
 * Persist the rendered bias keys into threads.bias_active_at_turn,
 * scoped by user_id (admin client).
 */
async function snapshotBiasActiveBiases(
  adminClient: SupabaseClient,
  threadId: string,
  userId: string,
  biases: readonly string[],
): Promise<void> {
  const { error } = await adminClient
    .from('threads')
    .update({ bias_active_at_turn: Array.from(biases) })
    .eq('id', threadId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/**
 * Clear the sweep's processed state for a thread on a new user
 * message. Passes p_user_id because the admin client has no auth.uid()
 * for the RPC's internal ownership scoping.
 */
async function clearBiasThread(
  adminClient: SupabaseClient,
  threadId: string,
  userId: string,
): Promise<void> {
  const { error } = await adminClient.rpc('bias_clear_thread', {
    p_thread_id: threadId,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message);
}

// --- The <think>-chain priming stage ----------------------------------------
//
// Ports src/lib/chat/preturn-priming.ts: the samskara compound+fire
// bundle (raced against a timeout), plus the intuition and
// context-recall pipelines (each gated by the shared trigger
// evaluator), spliced as a synthetic <think> chain onto the history
// baton in the contracted order. Each pipeline's liveness + payload
// refresh is published over the stream channel so the browser drives
// the same spinner + modal feedback the local callbacks used to.

/** Turn-entry priming inputs forwarded from the /stream request body. */
export interface PrimingInputs {
  intuitionModelId?: string;
  intuitionMood?: { band: number; column: 'confident' | 'tentative' } | null;
  contextRecallEnabled?: boolean;
  /**
   * Skip the STANDARD priming stage (bias appendix + the whole
   * `<think>` chain). Set by the second-thoughts refinement turn: it is
   * the model reconsidering its own answer, not a new user round, so
   * re-running the user-round-keyed priming would double-fire the
   * samskara situational cohort and bury the refinement's own `<think>`
   * doubt. The refinement instead gets the targeted samskara probe
   * below when `refinementDoubtNote` is present. See the field docs on
   * `ChatLoopOptions.skipPriming` (src/lib/chat/types.ts).
   */
  skipPriming?: boolean;
  /**
   * The second-thoughts doubt note driving this refinement turn (the
   * reviewer's first-person twinge). When present alongside
   * `skipPriming`, the stage runs ONE targeted samskara probe - a
   * read-only cosine query keyed to the doubt + the original user text,
   * spliced as a single `<think>` block - so the full-context
   * deliberation can weigh the twinge against what the model has
   * learned about this user across threads. Read-only on purpose: no
   * cohort is recorded, so the original turn's fire stays the round's
   * only samskara bookkeeping.
   */
  refinementDoubtNote?: string;
}

/**
 * The Venice/RPC-coupled pipeline functions the orchestration calls.
 * Injectable so the orchestration's pure logic (splice order, the
 * liveness/payload event sequence, the timeout race, freshness
 * suppression) can be unit-tested with stubs, without standing up
 * Venice. Production passes DEFAULT_PRIMING_DEPS.
 */
export interface ServerPrimingDeps {
  applyBiasPriming: typeof applyBiasPriming;
  applyIntentPriming: typeof applyIntentPriming;
  getCompoundSummary: typeof getCompoundSummary;
  fireSamskaras: typeof fireSamskaras;
  queryFiredSamskaras: typeof queryFiredSamskaras;
  runIntuitionPipeline: typeof runIntuitionPipeline;
  runContextRecallPipeline: typeof runContextRecallPipeline;
}

const DEFAULT_PRIMING_DEPS: ServerPrimingDeps = {
  applyBiasPriming,
  applyIntentPriming,
  getCompoundSummary,
  fireSamskaras,
  queryFiredSamskaras,
  runIntuitionPipeline,
  runContextRecallPipeline,
};

export interface ServerPrimingOpts {
  adminClient: SupabaseClient;
  userId: string;
  threadId: string;
  apiKey: string;
  /** Mutated in place: bias appends to row 0, the <think> chain splices
   *  in before the trailing metadata system row. */
  history: PrimingMessage[];
  /** Publishes priming liveness + payload events on the stream channel. */
  publisher: BroadcastPublisher;
  priming?: PrimingInputs;
  signal?: AbortSignal;
  /** The orchestrator's per-turn correlator, for log lines. */
  runId: string;
  /** Test-only pipeline overrides. Omitted in production. */
  deps?: ServerPrimingDeps;
}

/**
 * Run the full turn-entry priming stage: bias appendix + the <think>
 * chain (samskara, context-recall, intuition). Bias and the chain are
 * independent (bias appends to the row-0 system message; the chain
 * splices before the trailing metadata row), so they run concurrently.
 * Never throws - every pipeline swallows its own errors so a priming
 * hiccup degrades to "less context this turn," never a broken or
 * delayed turn. Three source-tagged edge loggers (samskara, intuition,
 * context-recall) plus the bias logger round-trip to the drawer; all
 * are flushed before this resolves so the waitUntil budget does not
 * cut their broadcasts off.
 */
export async function runServerPriming(opts: ServerPrimingOpts): Promise<void> {
  const { adminClient, userId, threadId, apiKey, history, publisher, signal } =
    opts;
  // Refinement turns (second-thoughts "Let me ..." button) carry their
  // own `<think>` doubt and are not a new user round, so they opt out of
  // the standard stage entirely - running it would double-fire samskara
  // for the round and bury the doubt. They get the targeted
  // doubt-keyed samskara probe instead (a no-op for old clients that
  // send skipPriming without a note).
  if (opts.priming?.skipPriming) {
    await runRefinementPriming(opts);
    return;
  }
  const deps = opts.deps ?? DEFAULT_PRIMING_DEPS;
  const biasLog = createEdgeLogger(userId, 'bias');
  const intentLog = createEdgeLogger(userId, 'intent');
  const samskaraLog = createEdgeLogger(userId, 'samskara');
  const intuitionLog = createEdgeLogger(userId, 'intuition');
  const recallLog = createEdgeLogger(userId, 'context-recall');

  try {
    await Promise.all([
      // Bias then intents, SEQUENCED: both append to the row-0 system
      // message, so running them concurrently would race and drop a
      // block. Intents render after bias so the precedence note's
      // "guidance above" resolves. This pair runs concurrently with the
      // <think> chain, which touches a different part of history.
      (async () => {
        await deps.applyBiasPriming({ adminClient, userId, threadId, history, log: biasLog });
        await deps.applyIntentPriming({ adminClient, userId, threadId, history, log: intentLog });
      })(),
      runThinkChain({
        adminClient,
        userId,
        threadId,
        apiKey,
        history,
        publisher,
        priming: opts.priming ?? {},
        signal,
        samskaraLog,
        intuitionLog,
        recallLog,
        deps,
      }),
    ]);
  } finally {
    // Flush the drawer broadcasts before the caller's waitUntil budget
    // can reclaim the isolate. allSettled inside each flush; this never
    // throws.
    await Promise.allSettled([
      biasLog.flush(),
      intentLog.flush(),
      samskaraLog.flush(),
      intuitionLog.flush(),
      recallLog.flush(),
    ]);
  }
}

/**
 * The refinement turn's priming: one read-only samskara probe keyed to
 * the doubt note plus the original user text, spliced as a single
 * `<think>` block before the trailing metadata row. This is the
 * "deliberation gets the context" half of the second-thoughts design:
 * the low-context reviewer twinged, and the full-context refinement
 * adjudicates that twinge - so it is the refinement, not the reflex,
 * that gets to see what the model has learned about this user across
 * threads. The probe records no cohort (queryFiredSamskaras, not
 * fireSamskaras): the original turn's fire remains the round's only
 * samskara bookkeeping, so fire_count, co-fire detection, and the
 * evaluation judge see one fire per user round as before.
 *
 * Same never-throws / never-delays posture as the standard stage: the
 * probe races the shared samskara timeout and any failure degrades to
 * "no probe block this turn."
 */
async function runRefinementPriming(opts: ServerPrimingOpts): Promise<void> {
  // Runtime typeof guard: the note crosses the /stream body boundary,
  // and it feeds an embed call - coerce anything non-string to absent
  // rather than serializing garbage into the query.
  const rawNote = opts.priming?.refinementDoubtNote;
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  if (note.length === 0) return;
  const deps = opts.deps ?? DEFAULT_PRIMING_DEPS;
  const samskaraLog = createEdgeLogger(opts.userId, 'samskara');
  try {
    const userText = extractUserText(opts.history);
    // Key the probe to doubt + question: the doubt names what feels
    // off, the user text names the topic, and predictions relevant to
    // either can bear on whether the twinge holds. The note is capped
    // defensively - reviewer notes run a sentence or two, so a huge
    // value here is a hostile body, not a real verdict.
    const queryText = [userText, note.slice(0, 2000)]
      .filter((s) => s.length > 0)
      .join('\n\n');
    void opts.publisher.publish({ type: 'priming_start', op: 'samskara' });
    const probe = deps
      .queryFiredSamskaras({
        admin: opts.adminClient,
        userId: opts.userId,
        apiKey: opts.apiKey,
        queryText,
        signal: opts.signal,
        log: samskaraLog,
      })
      .finally(() => {
        void opts.publisher.publish({ type: 'priming_end', op: 'samskara' });
      });
    // Same cap as the standard stage, same cleanup: the refinement is a
    // user-triggered streaming turn, so a slow probe must not delay its
    // first token. A timed-out probe keeps running detached; its result
    // is simply not spliced.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const fired = await Promise.race([
      probe,
      new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), SAMSKARA_PRIMING_TIMEOUT_MS);
      }),
    ]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    const body = formatRefinementFireThink(fired);
    if (body !== null) {
      // Before the trailing metadata system row, same as the standard
      // chain. The acted-doubt <think> rides inside the original
      // assistant row earlier in history, so the model reads doubt
      // first, then these patterns, then generates.
      const insertAt = Math.max(0, opts.history.length - 1);
      opts.history.splice(insertAt, 0, {
        role: 'assistant',
        content: `<think>\n${body}\n</think>`,
      });
      samskaraLog.info('refinement probe: spliced', {
        fired: fired?.length ?? 0,
      });
    } else {
      samskaraLog.debug('refinement probe: nothing fired');
    }
  } finally {
    await samskaraLog.flush();
  }
}

interface ThinkChainOpts {
  adminClient: SupabaseClient;
  userId: string;
  threadId: string;
  apiKey: string;
  history: PrimingMessage[];
  publisher: BroadcastPublisher;
  priming: PrimingInputs;
  signal?: AbortSignal;
  samskaraLog: EdgeLogger;
  intuitionLog: EdgeLogger;
  recallLog: EdgeLogger;
  deps: ServerPrimingDeps;
}

async function runThinkChain(opts: ThinkChainOpts): Promise<void> {
  const {
    adminClient,
    userId,
    threadId,
    apiKey,
    history,
    publisher,
    priming,
    signal,
    samskaraLog,
    intuitionLog,
    recallLog,
    deps,
  } = opts;

  const userText = extractUserText(history);
  const currentUserRound = countUserRounds(history);
  // One wall-clock snapshot shared by both pipelines' staleness fuse and
  // the injection guard, so "should we refresh" and "is the cache fresh
  // enough to inject" judge against the same instant.
  const nowMs = Date.now();
  const mood = priming.intuitionMood ?? null;
  const intuitionModelId = priming.intuitionModelId;
  const contextRecallEnabled = priming.contextRecallEnabled ?? false;

  let { intuition: intuitionCache, contextRecall: contextRecallCache } =
    await readThreadCaches(adminClient, userId, threadId, recallLog);

  // Samskara priming bundle: compound summary (always-on across turns) +
  // situational fire (top-k for THIS user text), raced against the
  // timeout so a slow Venice never delays the first token. The fire's
  // start/end liveness brackets the underlying fire promise (not the
  // raced one), so the spinner end fires when the fire actually settles
  // - which may be after the timeout resolved the race with nulls; the
  // detached fire still records its cohort under the orchestrator's
  // waitUntil. Mirrors preturn-priming's trackSubconscious('samskara').
  const trackSamskara = <T>(work: Promise<T>): Promise<T> => {
    void publisher.publish({ type: 'priming_start', op: 'samskara' });
    return work.finally(() => {
      void publisher.publish({ type: 'priming_end', op: 'samskara' });
    });
  };
  const samskaraWork = (async () => {
    const [compoundSummary, fire] = await Promise.all([
      deps.getCompoundSummary(adminClient, userId, samskaraLog),
      trackSamskara(
        deps.fireSamskaras({
          admin: adminClient,
          userId,
          apiKey,
          threadId,
          userRound: currentUserRound,
          userText,
          signal,
          log: samskaraLog,
        }),
      ),
    ]);
    return formatPrimingThinks({ compoundSummary, fire });
  })();
  // Clear the timeout when the bundle wins the race - otherwise the
  // timer stays pending for the full window on every fast turn (a
  // harmless leak in production, but a dangling op the test sanitizer
  // flags). When the timeout wins, clearing an already-fired timer is a
  // no-op and the underlying fire stays detached (its cohort still
  // records under the orchestrator's waitUntil).
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const samskaraThinks = await Promise.race([
    samskaraWork,
    new Promise<{ compound: string | null; fire: string | null }>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ compound: null, fire: null }),
        SAMSKARA_PRIMING_TIMEOUT_MS,
      );
    }),
  ]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

  // Subconscious-priming pipelines. Each reads the shared trigger
  // evaluator independently (per-cache computed_at_round, so the same
  // turn can refresh one and debounce the other) and is gated by its
  // feature switch. The onWillRun-equivalent liveness publish fires only
  // when a pipeline commits to running, so a no-trigger turn never
  // flashes a spinner. Run in parallel: the wall-clock cost is
  // max(intuition, recall), not additive.
  const intuitionTrigger: IntuitionTrigger | null = intuitionModelId
    ? evaluatePreRoundTrigger({ cache: intuitionCache, round: currentUserRound, mood, nowMs })
    : null;
  const recallTrigger: IntuitionTrigger | null = contextRecallEnabled
    ? evaluatePreRoundTrigger({ cache: contextRecallCache, round: currentUserRound, mood, nowMs })
    : null;

  const [freshIntuition, freshRecall] = await Promise.all([
    (async (): Promise<IntuitionPayload | null> => {
      if (!intuitionModelId || !intuitionTrigger) return null;
      void publisher.publish({ type: 'priming_start', op: 'intuition' });
      try {
        return await deps.runIntuitionPipeline({
          admin: adminClient,
          userId,
          apiKey,
          threadId,
          modelId: intuitionModelId,
          history,
          round: currentUserRound,
          mood,
          nowMs,
          trigger: intuitionTrigger,
          signal,
          log: intuitionLog,
        });
      } catch (err) {
        intuitionLog.debug('intuition pipeline failed', err);
        return null;
      } finally {
        void publisher.publish({ type: 'priming_end', op: 'intuition' });
      }
    })(),
    (async (): Promise<ContextRecallPayload | null> => {
      if (!contextRecallEnabled || !recallTrigger) return null;
      void publisher.publish({ type: 'priming_start', op: 'recall' });
      try {
        return await deps.runContextRecallPipeline({
          admin: adminClient,
          userId,
          apiKey,
          threadId,
          history,
          round: currentUserRound,
          mood,
          nowMs,
          trigger: recallTrigger,
          signal,
          log: recallLog,
        });
      } catch (err) {
        recallLog.debug('context-recall pipeline failed', err);
        return null;
      } finally {
        void publisher.publish({ type: 'priming_end', op: 'recall' });
      }
    })(),
  ]);

  // Persist the fresh payloads before publishing their refresh events -
  // same ordering preturn-priming enforced: a realtime echo that arrives
  // between the patch and the write must see the persisted payload, not
  // a transient null.
  if (freshIntuition) {
    intuitionCache = freshIntuition;
    await persistThreadCache(adminClient, userId, threadId, 'intuition_payload', freshIntuition, intuitionLog);
  }
  if (freshRecall) {
    contextRecallCache = freshRecall;
    await persistThreadCache(adminClient, userId, threadId, 'context_recall_payload', freshRecall, recallLog);
  }
  if (freshIntuition) {
    void publisher.publish({ type: 'intuition_payload', payload: freshIntuition });
  }
  if (freshRecall) {
    void publisher.publish({ type: 'context_recall_payload', payload: freshRecall });
  }

  // Splice the synthetic <think> chain in the contracted order (broadest
  // to most turn-specific): context-recall, samskara compound, samskara
  // fire, intuition. The injection guard suppresses a payload older than
  // the staleness fuse even as a <think> block - a stale prime steers
  // the model wrong, worse than no prime. Insert before the trailing
  // metadata system row (the last element); an empty chain is a no-op.
  const thinks: PrimingMessage[] = [];
  if (contextRecallCache && isPayloadFreshForInjection(contextRecallCache, nowMs)) {
    const msg = buildContextRecallThinkMessage(contextRecallCache);
    if (msg !== null) thinks.push(msg);
  }
  if (samskaraThinks.compound !== null) {
    thinks.push({ role: 'assistant', content: `<think>\n${samskaraThinks.compound}\n</think>` });
  }
  if (samskaraThinks.fire !== null) {
    thinks.push({ role: 'assistant', content: `<think>\n${samskaraThinks.fire}\n</think>` });
  }
  if (intuitionCache && isPayloadFreshForInjection(intuitionCache, nowMs)) {
    thinks.push(buildIntuitionThinkMessage(intuitionCache));
  }
  if (thinks.length > 0) {
    const insertAt = Math.max(0, history.length - 1);
    history.splice(insertAt, 0, ...thinks);
  }
}

// Extract the plain text of the latest user message, flattening a
// multimodal content-part array to its text parts. Seeds the samskara
// fire embed with the turn's user text. Scans from the tail because the
// trailing metadata system row sits after the latest user turn.
function extractUserText(history: PrimingMessage[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== 'user') continue;
    const c = history[i].content as unknown;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .filter(
          (p): p is { type: 'text'; text: string } =>
            !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text',
        )
        .map((p) => p.text)
        .join('\n');
    }
    return '';
  }
  return '';
}

async function readThreadCaches(
  adminClient: SupabaseClient,
  userId: string,
  threadId: string,
  log: EdgeLogger,
): Promise<{
  intuition: IntuitionPayload | null;
  contextRecall: ContextRecallPayload | null;
}> {
  try {
    const { data, error } = await adminClient
      .from('threads')
      .select('intuition_payload, context_recall_payload')
      .eq('id', threadId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as {
      intuition_payload?: unknown;
      context_recall_payload?: unknown;
    } | null;
    return {
      intuition: coerceIntuitionPayload(row?.intuition_payload),
      contextRecall: coerceContextRecallPayload(row?.context_recall_payload),
    };
  } catch (err) {
    log.debug('priming: thread cache read failed', err);
    return { intuition: null, contextRecall: null };
  }
}

async function persistThreadCache(
  adminClient: SupabaseClient,
  userId: string,
  threadId: string,
  column: 'intuition_payload' | 'context_recall_payload',
  payload: IntuitionPayload | ContextRecallPayload,
  log: EdgeLogger,
): Promise<void> {
  try {
    const { error } = await adminClient
      .from('threads')
      .update({ [column]: payload })
      .eq('id', threadId)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
  } catch (err) {
    log.debug(`priming: ${column} write failed`, err);
  }
}
