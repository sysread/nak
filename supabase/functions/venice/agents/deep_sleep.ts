// Deep-sleep (slow-wave consolidation) memory librarian - function-side
// port of src/lib/agents/deep-sleep/.
//
// Deep-sleep receives a similarity-clustered batch of memories (seed +
// top-k cosine neighbors above the threshold) and decides for each
// pair whether to consolidate, relate, or leave alone. The tool calls
// it makes ARE the persistent output; the model's final text is the
// operator-facing summary surfaced in the log drawer.
//
// Work unit per run:
//
//   1. Pick the oldest-unvisited memory as the seed.
//   2. Embed the seed and vector-search the rest of the user's
//      memories for the top-k neighbors above the similarity
//      threshold (DEEP_SLEEP_MIN_SIMILARITY = 0.80).
//   3. Hand the batch (seed + neighbors) to the agent.
//   4. Mark the batch as visited so the next sweep picks a different
//      neighborhood.
//
// Two entry points share that core: runDeepSleepSweepTick (cron-driven
// /deep-sleep-sweep; global definer claim stamps the cadence) and
// runDeepSleepManual (user-triggered /deep-sleep-run from the Memories
// panel; no cadence stamp). Both take the SHARED memory-librarian
// in-flight guard (see _memory_librarian_tools.ts) so a deep-sleep run
// never overlaps a rem run (or another deep-sleep run) for the user.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { veniceEmbed } from '../../_shared/venice.ts';
import {
  padEmbeddingForStorage,
  VENICE_EMBEDDING_MODEL,
} from '../../_shared/backfill.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { classifyMemoryConfidence } from '../tools/memory_search.ts';
import {
  buildMemoryLibrarianToolbox,
  claimMemoryLibrarianInflight,
  releaseMemoryLibrarianInflight,
} from './_memory_librarian_tools.ts';
import {
  runHeadlessAgent,
  type AgentCompleteFn,
  type AgentProgressEvent,
  type AgentToolContext,
  withProgressNarration,
} from './_run.ts';

// Mirror of agentModel('deepSleep').id in src/lib/models/index.ts - a
// static role->model map, not a per-user tier, so hardcoding stays
// faithful.
const DEEP_SLEEP_MODEL = 'deepseek-v4-flash';

/**
 * Minimum gap between scheduled runs for one user, passed to
 * claim_next_user_for_deep_sleep as p_min_interval_seconds (the gate
 * lives in that RPC, so this constant is the whole knob - no schema
 * change to retune).
 *
 * This is the sweep's throughput dial, not a rate limit. The cron
 * ticks HOURLY (`47 * * * *`); this decides how many of those ticks
 * find an eligible user instead of returning no-user. A refused tick
 * costs one indexed claim query and no Venice call, so shortening the
 * interval adds no ticks - it converts existing refusals into runs.
 *
 * 3h rather than 12h because the seed queue has inflow, not just a
 * backlog: clear_memory_librarian_visit_on_change nulls a memory's
 * visit stamp whenever its text changes, so every edited memory
 * re-enters the queue - including the ones deep-sleep itself just
 * merged. At 12h the queue outran the sweep. The cost is Venice spend
 * on the extra passes.
 */
const DEEP_SLEEP_MIN_INTERVAL_SECONDS = 3 * 3600;

/**
 * Cosine-similarity threshold for a neighbor to land in the batch.
 * Below this, the pair is too dissimilar for the librarian to spend
 * tokens reasoning about - reflection's "search before create" already
 * covers the obvious-near-duplicate case. 0.80 is a medium gate: high
 * enough to filter out unrelated memories, low enough to let "related
 * but distinct" pairs through for the relation-edge pass. Tuned with
 * score-in-prompt so the agent can self-tier within the batch.
 */
const DEEP_SLEEP_MIN_SIMILARITY = 0.8;

/**
 * Max number of neighbors (excluding the seed) fetched per run.
 *
 * Sized against the hosted edge-function wall clock, not the prompt
 * budget. The agent works the batch pair by pair, so the reasoning
 * rounds it needs grow far faster than the row count - a seed + 8
 * batch was observed spending six-plus rounds on consolidations and
 * getting killed mid-flight, which leaves no run outcome persisted
 * and strands the in-flight lease until its TTL expires.
 *
 * On its own this only lowers the ODDS of an overrun;
 * DEEP_SLEEP_BUDGET_MS is what bounds it.
 *
 * The cost of a smaller batch is rotation speed: a clean pass retires
 * its whole batch, so fewer rows per pass means more passes to sweep
 * the set. DEEP_SLEEP_MIN_INTERVAL_SECONDS pays that back by running
 * passes more often, which is the cheaper side of the trade against
 * runs that die and take the lease with them.
 */
const DEEP_SLEEP_MAX_NEIGHBORS = 4;

/**
 * Wall-clock budget for the agent loop.
 *
 * The hosted edge runtime kills an isolate at roughly 400s, and being
 * killed is the worst way for this run to end: the code that persists
 * the run-outcome envelope and releases the in-flight lease never
 * executes, so nothing is recorded and every client treats the pass
 * as live until the lease TTL expires ~10 minutes later - locking the
 * user out of starting another. Stopping one round early instead
 * costs one consolidation on a pass that comes round again in hours,
 * and visitStampIds keeps the unreviewed neighbors queued for it.
 *
 * 300s leaves ~100s of headroom for the post-loop writes and for the
 * loop's next-round estimate coming in low (it extrapolates from the
 * slowest round so far, which a slower round can still beat).
 */
const DEEP_SLEEP_BUDGET_MS = 300_000;

/**
 * Hard floor on the batch size that justifies running the agent.
 * Below this (the seed alone), the consolidation decision is too
 * narrow to need an LLM - the run stamps the seed's visit timestamp
 * and skips Venice entirely.
 */
const DEEP_SLEEP_MIN_BATCH_SIZE = 2;

// ---------------------------------------------------------------------------
// Prompt. Runs server-side only - the browser no longer carries a
// deep-sleep prompt module.
//
// Why score-in-prompt: cosine similarity is a noisy signal at the
// 0.80-0.95 range. Showing the score per pair lets the agent self-
// tier - 0.95+ rows can be consolidated with little ceremony,
// 0.80-0.90 rows usually warrant memory_relate (genuinely related but
// distinct) rather than consolidation. The single-gate threshold +
// score-in-prompt is the deliberate v1 choice; tiered thresholds are
// a tuning move deferred until we see how it behaves.
// ---------------------------------------------------------------------------

const TOOLS_BLOCK = `**Tools you can use**:

- \`memory_search\` - read the user's atomic-fact memory store with
  vector + text search. Useful when you want to verify whether a
  third memory not in the current batch is also a duplicate of the
  pair you are considering, or when one of the rows in your batch
  refers to a concept ("their cat") that you want to look up by
  name.
- \`conversation_search\` - read across the user's past conversations
  to fact-check a claim. Use this when a memory in the batch makes a
  specific factual assertion that you want to corroborate before
  trusting it as the consolidation target.
- \`memory_consolidate\` - merge two memories that turned out to
  encode the same fact. The survivor keeps the supplied label and
  data; its confidence becomes the STRONGER of the two existing
  confidences (no bump). The loser is halved (soft-delete via the
  standard invalidate semantic; recoverable). Any
  memory_conversation rows and memory_relations edges pointing at
  the loser are redirected to the survivor.
- \`memory_relate\` / \`memory_unrelate\` - manage edges in the
  memory graph. Use \`memory_relate\` when two memories in the batch
  are clearly related but encode distinct facts (kinds:
  \`supports\`, \`contradicts\`, \`generalises\`, \`specialises\`).
  Use \`memory_unrelate\` when an existing edge no longer makes
  sense (e.g. you just consolidated the two endpoints into one).
- \`memory_invalidate\` - halve a memory's confidence. Use when a
  memory is clearly contradicted by another in the batch or by
  evidence from \`conversation_search\`. Soft-delete; the row stays
  recoverable.
- \`memory_doubt\` - decay confidence by a factor of 0.7 (gentler
  than \`memory_invalidate\`). Use when a memory smells stale or
  questionable but you don't have direct contradiction. Five doubts
  from a fresh 1.0 land around 0.17 ([shaky] tag).
- \`memory_reshape\` - rewrite ONE memory's framing without changing
  its facts or confidence. Use it ONLY to clean encoding-time poison:
  first-person session narration, "this conversation" / "this session"
  / "today" phrasing, or a date that records when the memory was
  WRITTEN (not a date that is part of a fact). Rewrite into a timeless
  statement of the same facts - preserve every number, name, decision,
  and fact-bearing date exactly. The row's created_at already records
  when it was learned.

You do NOT have \`memory_create\` (the librarian does not invent
facts) or \`memory_update\` (reflection's verb for refining a fact,
not yours). The one content rewrite you ARE allowed is
\`memory_reshape\` (above): cleaning a row's framing, never its
facts.`;

const DISCIPLINE_BLOCK = `**Discipline**:

- **Preserve facts.** Consolidation never throws away information.
  The merged body MUST encode every distinct fact from both
  originals (you may rephrase, combine, or condense duplicates -
  but the union of facts cannot shrink). If two memories disagree,
  do not consolidate - that is a contradiction, not a duplication.
  Use \`memory_invalidate\` on the losing side instead, or
  \`memory_relate\` with kind \`contradicts\` to flag it for later.
- **The librarian collapses; reflection generates.** Your job is to
  reorganise what already exists, not to add new facts. If you
  find a gap in the user's memory ("we know X but not the obvious
  follow-up Y"), do nothing - reflection will catch Y on a future
  thread. Never invent.
- **Score is a signal, not a verdict.** Cosine similarity above
  0.95 usually means the same fact in different wording; 0.80-0.90
  often means "related but distinct" (memory_relate is the right
  move, not memory_consolidate). Read the label and data; do not
  consolidate purely on score.
- **Confidence tells you which memory is the survivor.** When you
  do consolidate, the survivor is normally the higher-confidence
  row (the user has corroborated it more), but well-written
  language matters too - a clearer, more specific data field on
  the lower-confidence row may be the better survivor body. Use
  judgment.
- **The graph is sparse on purpose.** Don't draw every plausible
  edge. \`memory_relate\` is for relationships strong enough that a
  later recall pass would want to find the second memory by
  starting from the first. Drawing weak edges crowds the graph and
  dilutes the strong ones.
- **No tool calls is a valid outcome.** If the batch contains
  similar-but-not-the-same memories and the existing graph already
  captures the relationships, leave it alone. The cost of a wrong
  consolidate (a deliberately distinct pair collapsed into one) is
  higher than the cost of a missed consolidate (next cycle catches
  it).`;

const FINAL_REPLY_BLOCK = `**Final reply**:

After your tool calls (or even with no tool calls), reply with one
or two sentences summarising what you did and why - e.g. "Merged
the two 'prefers tabs' memories; left 'prefers Vim' and 'prefers
tmux' separate with a \`supports\` edge between them." or "Left
all five memories alone; the score band suggested superficial
similarity, but each covers a distinct fact." This operator-facing
summary lands in the log drawer; aim for the brevity of a git
commit message.

If you made no changes, say so ("No changes - the four memories
covered distinct facts and the existing edges captured the
relationships."). Don't burn budget on an apology or a lengthy
explanation.`;

export interface DeepSleepPromptInput {
  /**
   * Pre-rendered batch list: the seed and its similarity neighbors,
   * one row per line with score / confidence / label / data.
   */
  batchList: string;
  /** Number of rows in the batch (seed + neighbors). */
  batchSize: number;
}

export function buildDeepSleepPrompt(input: DeepSleepPromptInput): string {
  return `You are the memory librarian's deep-sleep pass. Your job is
to inspect a small cluster of similarity-near memories from the
user's atomic-fact memory store and decide, for each pair, whether
to consolidate them (one fact in two rows), relate them (genuinely
distinct but adjacent), or leave them alone (the existing structure
already captures the relationship).

The user's memory store grows append-only. Reflection writes facts
one thread at a time and never sees the store as a whole, so cross-
thread duplicates accumulate. You see the store globally and clean
up what reflection structurally couldn't.

**The batch** (${input.batchSize} memories, seed first, then
similarity neighbors ordered by descending cosine score):

${input.batchList}

${TOOLS_BLOCK}

${DISCIPLINE_BLOCK}

**Workflow**:

1. Read every row carefully. Note which look like exact duplicates,
   which look related-but-distinct, and which look genuinely
   different (these last shouldn't have made it into the batch
   given the similarity gate, but the embedding model is noisy at
   0.80; ignore them).
2. For each likely-duplicate pair, decide which row is the
   survivor (higher confidence usually wins; better wording can
   tilt) and call \`memory_consolidate\`. The consolidated body
   must preserve every distinct fact from both originals.
3. For each related-but-distinct pair, consider whether the
   relation graph already captures the connection. If not, call
   \`memory_relate\` with the appropriate kind. Don't draw weak
   edges.
4. For any row contradicted by another in the batch (or by
   evidence you found via \`conversation_search\` /
   \`memory_search\`), call \`memory_invalidate\` (clear
   contradiction) or \`memory_doubt\` (smells stale, no direct
   contradiction).
5. For any row whose TEXT carries encoding-time framing - "this
   conversation" / "this session", a write-date narration, or
   first-person AI narration - call \`memory_reshape\` to rewrite it
   timeless, preserving every fact. Leave already-clean rows alone.
6. Leave the rest alone.

${FINAL_REPLY_BLOCK}`;
}

// ---------------------------------------------------------------------------
// Batch assembly
// ---------------------------------------------------------------------------

interface DeepSleepMemoryRow {
  id: string;
  label: string;
  data: string;
  confidence: number;
  /** Cosine similarity to the seed, in [0, 1]. The seed itself is 1.0. */
  score: number;
}

/**
 * Render the batch into the bullet list the prompt embeds. Each row
 * is "[score] (confidence_tag conf=N.NN) `label` - data" so the agent
 * can scan vertically and compare scores against text. The seed
 * appears with a leading "SEED" marker so the agent knows which row
 * anchored the batch. Mirror of the browser DeepSleepAgent's renderer.
 */
function renderBatchList(batch: readonly DeepSleepMemoryRow[]): string {
  if (batch.length === 0) return '(empty batch)';
  return batch
    .map((row, idx) => {
      const tag = classifyMemoryConfidence(row.confidence);
      const tagFragment = tag ? `${tag} ` : '';
      const scoreFragment = idx === 0 ? 'SEED' : row.score.toFixed(2);
      const labelFragment = row.label.replace(/\s+/g, ' ').trim();
      const dataFragment = row.data.replace(/\s+/g, ' ').trim();
      return (
        `- [${scoreFragment}] (${tagFragment}conf=${row.confidence.toFixed(2)}, id=${row.id}) ` +
        `\`${labelFragment}\` - ${dataFragment}`
      );
    })
    .join('\n');
}

interface SeedRow {
  id: string;
  label: string;
  data: string;
  confidence: number;
}

/**
 * Oldest last_librarian_visit_at first, never-visited (null) before
 * everything. Confidence floor of 0.05 mirrors the memory_search hide
 * threshold; memories that have decayed below the floor are
 * effectively retired and not worth the agent's attention. Null when
 * the user has no eligible memories. RLS OFF: explicit user filter.
 */
async function pickSeed(
  adminClient: SupabaseClient,
  userId: string,
): Promise<SeedRow | null> {
  const { data, error } = await adminClient
    .from('memories')
    .select('id, label, data, confidence')
    .eq('user_id', userId)
    .gte('confidence', 0.05)
    .order('last_librarian_visit_at', { ascending: true, nullsFirst: true })
    .order('updated_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`pickSeed failed: ${error.message}`);
  return (data as SeedRow | null) ?? null;
}

/**
 * Embed a query string into the native bge-m3 vector. Injectable so
 * the behavioral tests can run the batch pipeline without network;
 * the default closes over the Venice key.
 */
type EmbedFn = (input: string) => Promise<number[] | undefined>;

function defaultEmbed(apiKey: string): EmbedFn {
  return async (input) => {
    const response = await veniceEmbed({
      apiKey,
      model: VENICE_EMBEDDING_MODEL,
      input,
    });
    return response.data[0]?.embedding;
  };
}

/**
 * Pick the seed's neighborhood: embed the seed, vector-search for the
 * top-k neighbors above the threshold. The seed's existing embedding
 * in the DB is the truthful one to query against, but pgvector has no
 * "get the embedding back" RPC and re-embedding is cheap - the bge-m3
 * input is bounded by the memory's 8000-char data cap, well under the
 * model's window. An empty embedding response degrades to a
 * seed-only batch (which the callers treat as too-small) rather than
 * erroring.
 */
async function buildBatchForSeed(
  adminClient: SupabaseClient,
  userId: string,
  seed: SeedRow,
  embed: EmbedFn,
): Promise<DeepSleepMemoryRow[]> {
  const seedRow: DeepSleepMemoryRow = { ...seed, score: 1.0 };

  const probe = `${seed.label}: ${seed.data}`.slice(0, 8000);
  const raw = await embed(probe);
  if (!raw || raw.length === 0) return [seedRow];
  const padded = padEmbeddingForStorage(raw);

  // Generous overfetch so the seed itself can be filtered out and the
  // batch still lands MAX_NEIGHBORS. The scored RPC returns boosted
  // cosine similarities in [0, 1].
  const { data, error } = await adminClient.rpc('search_memories_by_embedding_scored', {
    query_embedding: padded,
    match_limit: DEEP_SLEEP_MAX_NEIGHBORS + 4,
    p_user_id: userId,
  });
  if (error) {
    throw new Error(`search_memories_by_embedding_scored failed: ${error.message}`);
  }
  type Scored = {
    id: string;
    label: string;
    data: string;
    confidence: number;
    similarity: number;
  };
  const neighbors = ((data ?? []) as Scored[])
    .filter((row) => row.id !== seed.id)
    .filter((row) => row.similarity >= DEEP_SLEEP_MIN_SIMILARITY)
    .slice(0, DEEP_SLEEP_MAX_NEIGHBORS)
    .map((row) => ({
      id: row.id,
      label: row.label,
      data: row.data,
      confidence: row.confidence,
      score: row.similarity,
    }));
  return [seedRow, ...neighbors];
}

/**
 * Stamp last_librarian_visit_at = now() on a batch of memories so the
 * next sweep picks a different neighborhood. Marks the ENTIRE batch,
 * not just the seed - marking only the seed would mean the next cycle
 * picks one of the neighbors and re-inspects the same neighborhood.
 * Similarity space drifts slowly; accept the imperfection that a
 * neighbor-as-seed never gets its own perspective until the
 * next-after-next sweep. RLS OFF: explicit user filter.
 */
async function markVisited(
  adminClient: SupabaseClient,
  userId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await adminClient
    .from('memories')
    .update({ last_librarian_visit_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('id', [...ids]);
  if (error) throw new Error(`markVisited failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Review core
// ---------------------------------------------------------------------------

/**
 * Live-progress events for user-visible deep-sleep runs. `preparing`
 * fires once the batch is assembled (its size is the most useful
 * pre-model breadcrumb - the embed + similarity search run before
 * it); thinking/tool stream the middle; `done` settles the strip.
 */
export type DeepSleepProgressEvent =
  | { kind: 'preparing'; batchSize: number }
  | AgentProgressEvent
  | { kind: 'done'; ok: boolean };

export interface DeepSleepRunOptions {
  /** Test seam; forwarded to runHeadlessAgent. */
  complete?: AgentCompleteFn;
  /** Test seam; replaces the Venice embed call in batch assembly. */
  embed?: EmbedFn;
}

interface ReviewResult {
  toolCalls: number;
  finalText: string;
  batchSize: number;
  /** The agent loop ran out of budget or rounds instead of settling. */
  stoppedByLimit: boolean;
}

/**
 * Which of the batch's memories earned a visit stamp.
 *
 * A stamp means "the librarian has considered this neighborhood",
 * which pushes the row to the back of the seed queue. Stamping the
 * whole batch is right when the agent worked through it and settled.
 * When the loop stopped on a limit it may have reviewed only the first
 * few pairs, so stamping everything would retire memories nothing
 * looked at - they would not resurface until the entire queue cycled.
 *
 * Stamping the SEED only is the middle ground: the queue still
 * advances, so a pathological neighborhood cannot wedge the sweep by
 * being re-picked forever, but the neighbors stay queued for a pass
 * that has time for them. Same shape as the lonely-seed path, which
 * also stamps just the seed.
 */
export function visitStampIds(
  batch: readonly { id: string }[],
  stoppedByLimit: boolean,
): string[] {
  // Batch order is [seed, ...neighbors] - see buildBatchForSeed.
  if (batch.length === 0) return [];
  return stoppedByLimit ? [batch[0].id] : batch.map((m) => m.id);
}

/**
 * Run the agent over an assembled batch. Throws on failure - each
 * entry point owns its own error folding, visit stamping, and guard
 * release.
 */
async function runReview(args: {
  adminClient: SupabaseClient;
  userId: string;
  batch: readonly DeepSleepMemoryRow[];
  apiKey: string;
  log: EdgeLogger;
  complete?: AgentCompleteFn;
  onProgress?: (event: DeepSleepProgressEvent) => void;
}): Promise<ReviewResult> {
  const { adminClient, userId, batch, apiKey, log } = args;
  log.info(
    `deep-sleep reviewing batch of ${batch.length} memor${batch.length === 1 ? 'y' : 'ies'}`,
  );

  const promptText = buildDeepSleepPrompt({
    batchList: renderBatchList(batch),
    batchSize: batch.length,
  });

  // The librarians are not thread-scoped: memory tools ignore
  // threadId, and conversation_search's self-exclude doesn't apply to
  // a background pass. Empty string matches the browser agents.
  const baseCtx: Omit<AgentToolContext, 'signal' | 'depth'> = {
    adminClient,
    userId,
    threadId: null,
  };

  const result = await runHeadlessAgent(
    {
      model: DEEP_SLEEP_MODEL,
      messages: [{ role: 'system', content: promptText }],
      // Narration params only when someone is watching live (the
      // manual run's progress strip); the cron sweep keeps the wire
      // bytes free of them.
      toolbox: args.onProgress
        ? withProgressNarration(buildMemoryLibrarianToolbox())
        : buildMemoryLibrarianToolbox(),
      baseCtx,
      apiKey,
      signal: new AbortController().signal,
      reasoningEffort: 'low',
      budgetMs: DEEP_SLEEP_BUDGET_MS,
      complete: args.complete,
      onProgress: args.onProgress,
    },
    0,
  );

  return {
    toolCalls: result.toolCalls,
    finalText: result.finalText,
    batchSize: batch.length,
    stoppedByLimit: result.stoppedByLimit,
  };
}

/** Normalise the model's operator summary for the single-line log convention. */
function normaliseReasoning(finalText: string): string {
  return finalText.replace(/\s+/g, ' ').trim() || '(none)';
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Per-tick outcome returned to the /deep-sleep-sweep caller (and the dev shim). */
export interface DeepSleepSweepSummary {
  outcome: 'no-user' | 'inflight-blocked' | 'no-eligible' | 'too-small' | 'reviewed' | 'error';
  toolCalls?: number;
  batchSize?: number;
}

/**
 * One cron tick: claim the most-overdue eligible user and run one
 * seed-neighborhood review for them. NON-throwing by contract. The
 * cadence stamp lands at claim time, so a tick that ends no-eligible,
 * too-small, or inflight-blocked consumes that user's slot
 * (DEEP_SLEEP_MIN_INTERVAL_SECONDS) - the claim deliberately precedes
 * seed selection. An agent error leaves the batch UNVISITED on purpose
 * so the next cycle retries the same neighborhood; a run that stops on
 * the budget stamps only its seed, so the queue advances without
 * retiring neighbors nothing reviewed (see visitStampIds).
 */
export async function runDeepSleepSweepTick(
  adminClient: SupabaseClient,
  opts: DeepSleepRunOptions = {},
): Promise<DeepSleepSweepSummary> {
  let userId: string;
  try {
    const { data, error } = await adminClient.rpc('claim_next_user_for_deep_sleep', {
      p_min_interval_seconds: DEEP_SLEEP_MIN_INTERVAL_SECONDS,
    });
    if (error) throw new Error(`claim_next_user_for_deep_sleep failed: ${error.message}`);
    if (typeof data !== 'string' || data.length === 0) return { outcome: 'no-user' };
    userId = data;
  } catch (err) {
    console.error(`[deep-sleep-sweep] ${err instanceof Error ? err.message : String(err)}`);
    return { outcome: 'error' };
  }

  const log = createEdgeLogger(userId, 'deep-sleep');
  const holderId = crypto.randomUUID();
  let held = false;
  try {
    held = await claimMemoryLibrarianInflight(adminClient, userId, holderId);
    if (!held) {
      log.info('scheduled deep-sleep run skipped - another memory-librarian run is in flight');
      return { outcome: 'inflight-blocked' };
    }

    const seed = await pickSeed(adminClient, userId);
    if (!seed) {
      log.info('no eligible memories for deep-sleep; skipping');
      return { outcome: 'no-eligible' };
    }

    const apiKey = await readVeniceKey(adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    const batch = await buildBatchForSeed(
      adminClient,
      userId,
      seed,
      opts.embed ?? defaultEmbed(apiKey),
    );
    if (batch.length < DEEP_SLEEP_MIN_BATCH_SIZE) {
      // Lonely seed: stamp its visit so the next sweep moves on; no
      // need to run the agent on a single-row batch.
      log.info(
        `seed ${seed.id} has no neighbors above ${DEEP_SLEEP_MIN_SIMILARITY}; ` +
          'marking visited and skipping',
      );
      await markVisited(adminClient, userId, [seed.id]);
      return { outcome: 'too-small', batchSize: batch.length };
    }

    const result = await runReview({
      adminClient,
      userId,
      batch,
      apiKey,
      log,
      complete: opts.complete,
    });
    await markVisited(adminClient, userId, visitStampIds(batch, result.stoppedByLimit));
    log.info(
      `deep-sleep finished (${result.toolCalls} tool calls over ` +
        `${result.batchSize} memories` +
        `${result.stoppedByLimit ? ', stopped on limit - neighbors left queued' : ''}` +
        `, reasoning="${normaliseReasoning(result.finalText)}")`,
    );
    return { outcome: 'reviewed', toolCalls: result.toolCalls, batchSize: result.batchSize };
  } catch (err) {
    log.error(
      'scheduled deep-sleep run failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    return { outcome: 'error' };
  } finally {
    if (held) await releaseMemoryLibrarianInflight(adminClient, userId, holderId);
    await log.flush();
  }
}

/** Result union for the /deep-sleep-run route; mirrors the browser manual runner. */
export type DeepSleepManualResult =
  | { kind: 'ok'; finalText: string; toolCalls: number; batchSize: number }
  | { kind: 'no-eligible' }
  | { kind: 'too-small'; batchSize: number }
  | { kind: 'busy' }
  | { kind: 'error'; error: string };

/**
 * User-triggered run (the Memories panel). Same review core as the
 * sweep but WITHOUT the cadence stamp - a manual run doesn't reset
 * the scheduled clock. One deliberate divergence
 * from the sweep path, ported from the browser manual runner: the
 * batch's visit stamps land even when the agent errors, so a poison
 * neighborhood can't wedge the manual button on the same batch run
 * after run - the next click moves on. NON-throwing.
 */
export async function runDeepSleepManual(
  adminClient: SupabaseClient,
  userId: string,
  onProgress?: (event: DeepSleepProgressEvent) => void,
  opts: DeepSleepRunOptions = {},
): Promise<DeepSleepManualResult> {
  const log = createEdgeLogger(userId, 'deep-sleep');
  const holderId = crypto.randomUUID();
  let held = false;
  try {
    held = await claimMemoryLibrarianInflight(adminClient, userId, holderId);
    if (!held) return { kind: 'busy' };

    log.info('manual deep-sleep run requested');
    const seed = await pickSeed(adminClient, userId);
    if (!seed) {
      log.info('manual deep-sleep: no eligible memories');
      onProgress?.({ kind: 'done', ok: true });
      return { kind: 'no-eligible' };
    }

    const apiKey = await readVeniceKey(adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    const batch = await buildBatchForSeed(
      adminClient,
      userId,
      seed,
      opts.embed ?? defaultEmbed(apiKey),
    );
    onProgress?.({ kind: 'preparing', batchSize: batch.length });

    if (batch.length < DEEP_SLEEP_MIN_BATCH_SIZE) {
      // Lonely seed: stamp and surface to the UI so the user reads
      // "ran, nothing to do" rather than "ran, agent decided no
      // changes."
      await markVisited(adminClient, userId, [seed.id]);
      onProgress?.({ kind: 'done', ok: true });
      return { kind: 'too-small', batchSize: batch.length };
    }

    let result: ReviewResult;
    // Read by the finally below, which cannot see `result` on the throw
    // path. Staying false there is deliberate - see the comment.
    let stoppedByLimit = false;
    try {
      result = await runReview({
        adminClient,
        userId,
        batch,
        apiKey,
        log,
        complete: opts.complete,
        onProgress,
      });
      stoppedByLimit = result.stoppedByLimit;
    } finally {
      // Visit stamps land even on agent error - see the docblock. The
      // two non-clean endings get different treatment on purpose: an
      // error tells us nothing about how far the agent got and the
      // batch may be why it failed, so the whole batch retires rather
      // than risk wedging the queue on it. A budget stop is a healthy
      // batch that merely ran long, so only the seed retires and the
      // neighbors stay queued for a pass with time for them.
      await markVisited(
        adminClient,
        userId,
        visitStampIds(batch, stoppedByLimit),
      ).catch((err) => {
        log.debug(
          'failed to stamp visit timestamps on manual batch',
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    log.info(
      `manual deep-sleep finished (${result.toolCalls} tool calls over ` +
        `${result.batchSize} memories, reasoning="${normaliseReasoning(result.finalText)}")`,
    );
    onProgress?.({ kind: 'done', ok: true });
    return {
      kind: 'ok',
      finalText: result.finalText,
      toolCalls: result.toolCalls,
      batchSize: result.batchSize,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`manual deep-sleep run failed: ${msg}`);
    onProgress?.({ kind: 'done', ok: false });
    return { kind: 'error', error: msg };
  } finally {
    if (held) await releaseMemoryLibrarianInflight(adminClient, userId, holderId);
    await log.flush();
  }
}

// Test-only surface (composition + prompt invariants, batch pipeline).
export const __test = { renderBatchList, buildBatchForSeed, pickSeed };
