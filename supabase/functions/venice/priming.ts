// priming ---------------------------------------------------------------------
//
// Server-side turn-entry priming. The browser used to run priming
// before POSTing /stream (src/lib/chat/preturn-priming.ts); it now runs
// here as the opening stage of getStreamingResponse, under the same
// EdgeRuntime.waitUntil that keeps streaming alive across browser
// disconnect, so "come back to a finished answer" holds for the whole
// turn rather than just the streaming half.
//
// This file is being built one pipeline at a time (see the plan in the
// branch description). Bias is first: it is a system-prompt appendix
// rather than a <think> row and carries no per-turn UI wire event, so
// it is the smallest complete slice. Intuition, context-recall, and
// samskara follow.
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
} from './priming/samskara.ts';
import { formatPrimingThinks } from './priming/samskara-format.ts';
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
// to the first token. Mirrors SAMSKARA_PRIMING_TIMEOUT_MS in the
// retired browser src/lib/chat/preturn-priming.ts.
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
 * Swallow contract mirrors the browser's getBiasProfileBlock /
 * snapshotBiasActiveBiases / notifyBiasNewUserMessage: bias plumbing
 * never throws and never fails a turn. A read failure or cold-start
 * cache leaves the system prompt unchanged.
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

/**
 * Read every cached aggregate for the user from bias_summary, scoped
 * by explicit user_id (admin client has no auth.uid()). Unknown-key
 * rows are dropped - a key not in the catalog means the catalog was
 * edited but the cache is stale; safer to skip than to render an entry
 * whose guidance we cannot resolve. Mirrors the browser's
 * biasListSummary + getBiasProfileBlock row coercion.
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
 * scoped by user_id (admin client). Mirrors the browser's
 * biasSnapshotActiveBiases UPDATE.
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
 * message. Mirrors the browser's notifyBiasNewUserMessage; passes
 * p_user_id because the admin client has no auth.uid() for the RPC's
 * internal ownership scoping.
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
  getCompoundSummary: typeof getCompoundSummary;
  fireSamskaras: typeof fireSamskaras;
  runIntuitionPipeline: typeof runIntuitionPipeline;
  runContextRecallPipeline: typeof runContextRecallPipeline;
}

const DEFAULT_PRIMING_DEPS: ServerPrimingDeps = {
  applyBiasPriming,
  getCompoundSummary,
  fireSamskaras,
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
  const deps = opts.deps ?? DEFAULT_PRIMING_DEPS;
  const biasLog = createEdgeLogger(userId, 'bias');
  const samskaraLog = createEdgeLogger(userId, 'samskara');
  const intuitionLog = createEdgeLogger(userId, 'intuition');
  const recallLog = createEdgeLogger(userId, 'context-recall');

  try {
    await Promise.all([
      deps.applyBiasPriming({ adminClient, userId, threadId, history, log: biasLog }),
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
      samskaraLog.flush(),
      intuitionLog.flush(),
      recallLog.flush(),
    ]);
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
