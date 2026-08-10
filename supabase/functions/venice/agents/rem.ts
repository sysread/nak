// Rem (associative integration) memory librarian - function-side port
// of src/lib/agents/rem/.
//
// Rem receives a batch of memories that were referenced together
// during recall on one conversation and decides whether the relations
// graph captures the relationships the user's behavior implies. The
// tool calls it makes ARE the persistent output; the model's final
// text is the operator-facing summary surfaced in the log drawer.
//
// Different attractor from deep-sleep: deep-sleep operates on
// SIMILARITY (cosine neighbors); rem operates on CO-OCCURRENCE
// (memories the recall agent surfaced together for the user's
// questions). These are different signals - two memories with high
// cosine similarity may not be behaviorally related; two memories the
// user reaches for together may not be similar at all. Both passes
// are needed for different reasons.
//
// The hint queue rem drains (memory_conversation) is fed by the
// server-side recall agent (agents/recall.ts upserts a row per memory
// it surfaces). Two entry points share the review core:
//
//   - runRemSweepTick: cron-driven (/rem-sweep). Claims the
//     most-overdue eligible user via the global definer RPC (which
//     stamps the 12h cadence BEFORE the run) and drains up to
//     REM_MAX_CONVERSATIONS_PER_CYCLE conversations.
//   - runRemManual: user-triggered (/rem-run, the Memories panel).
//     No cadence stamp - a manual run doesn't reset the scheduled
//     clock. Emits live step events for the panel's progress strip.
//
// Both paths take the SHARED memory-librarian in-flight guard (see
// _memory_librarian_tools.ts) so a rem run never overlaps a
// deep-sleep run (or another rem run) for the same user.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
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
import { REM_MODEL } from '../../_shared/agent-models.ts';

// Mirror of the browser manager's minIntervalSeconds (12h between
// scheduled runs per user). Enforced by claim_next_user_for_rem.
const REM_MIN_INTERVAL_SECONDS = 12 * 3600;

/**
 * Max conversations rem processes per scheduled run. Bounds cost
 * across a chatty period - if the user holds a dozen recall-heavy
 * conversations in a day, rem still only attempts the oldest few.
 * The rest stay eligible and surface on the next cycle. Mirror of
 * REM_MAX_CONVERSATIONS_PER_CYCLE in the browser types.
 */
const REM_MAX_CONVERSATIONS_PER_CYCLE = 3;

/**
 * Hard floor on the batch size that justifies running the agent on a
 * conversation. With only a single memory referenced, there's no pair
 * to relate; the agent has nothing to do. The loop marks the
 * conversation's rows processed and moves on.
 */
const REM_MIN_BATCH_SIZE = 2;

// ---------------------------------------------------------------------------
// Prompt. Runs server-side only - the browser no longer carries a rem
// prompt module.
// ---------------------------------------------------------------------------

const TOOLS_BLOCK = `**Tools you can use**:

- \`memory_search\` - search the broader memory store. Useful when
  one memory in the batch suggests a fact ("user's cat is named
  Mochi") that you want to look up by name to see if a related
  memory exists outside this conversation's recall set.
- \`conversation_search\` - read across past conversations to
  verify a claim before consolidating or relating two memories.
- \`memory_consolidate\` - merge two memories that turned out to
  encode the same fact. The survivor keeps the supplied label and
  data and adopts the STRONGER of the two confidences. Use only
  when you are confident the two rows are the same fact - rem's
  primary mode is relate-not-merge.
- \`memory_relate\` / \`memory_unrelate\` - manage edges in the
  memory graph. THIS IS REM'S PRIMARY MODE. The user behavior
  signal is "the recall agent surfaced these two memories together
  for the user's question" - that's evidence they belong together
  in the graph, even when neither cosine similarity nor
  reflection's per-thread pass caught it. Use \`supports\` /
  \`generalises\` / \`specialises\` / \`contradicts\` kinds.
- \`memory_invalidate\` - halve confidence (soft-delete). Use only
  for clear contradictions surfaced by the batch.
- \`memory_doubt\` - gentle decay (×0.7). Use when a memory smells
  stale but you don't have direct contradiction.
- \`memory_reshape\` - rewrite ONE memory's framing without changing
  its facts or confidence. Use it ONLY to clean encoding-time poison:
  first-person session narration, "this conversation" / "this session"
  / "today" phrasing, or a date that records when the memory was
  WRITTEN (not a date that is part of a fact). Rewrite into a timeless
  statement of the same facts - preserve every number, name, decision,
  and fact-bearing date exactly. The row's created_at already records
  when it was learned.

You do NOT have \`memory_create\` or \`memory_update\` - same
discipline as deep-sleep: librarian collapses, reflection
generates. The one rewrite you ARE allowed is \`memory_reshape\`
(above): cleaning a memory's framing, never its facts.`;

const DISCIPLINE_BLOCK = `**Discipline**:

- **Rem's job is graph hygiene, not consolidation.** Most of the
  time, the right answer for a batch is one or two
  \`memory_relate\` calls connecting memories the recall agent
  reached for together. Consolidation is for the rare case where
  the batch contains an actual duplicate that deep-sleep missed
  (different wording, different embedding neighborhoods).
- **The user's behavior is the signal.** These memories came up
  together because the user's question was reaching for the
  combined fact. If existing edges already encode that combined
  fact, you're done. If they don't, draw the missing edge.
- **Sparse edges beat dense ones.** Don't draw an edge between
  every pair - only between pairs where the relationship is strong
  enough that a future recall pass would benefit from following
  the edge. Crowding the graph with weak edges dilutes the strong
  ones.
- **No tool calls is a valid outcome.** Most batches resolve here.
  The recall agent already knew how to find these memories
  together; rem's job is to make that easier next time by recording
  the relationship explicitly. If the relationship is already
  recorded, leave it alone.
- **Preserve facts.** When you do consolidate, the merged body
  must encode every distinct fact from both originals. No
  invention, no discarding of information.`;

const FINAL_REPLY_BLOCK = `**Final reply**:

After your tool calls (or even with no tool calls), reply with one
or two sentences summarising what you did and why. Match the
brevity of a git commit message: "Linked 'prefers tabs' and
'prefers Vim' (supports). Left the other three alone - already
edge-connected." or "No changes - all four memories were already
related correctly." Don't apologise for no-ops; they are the
default.`;

export interface RemPromptInput {
  /** Pre-rendered batch list: one row per memory with confidence + label/data. */
  batchList: string;
  batchSize: number;
}

export function buildRemPrompt(input: RemPromptInput): string {
  return `You are the memory librarian's rem (associative
integration) pass. Your job is to inspect a batch of memories that
were surfaced together during recall on a single conversation, and
decide whether the memory graph has captured the relationships
between them.

Why this matters: reflection writes memories one conversation at a
time and only sees that conversation; deep-sleep finds cosine-near
duplicates but misses pairs that aren't similar in vector space.
Rem catches the relationships that show up only when memories are
behaviorally reached for together - the user asked a question, the
recall agent pulled these memories to answer it, and now you get
to decide whether the graph reflects that.

**The batch** (${input.batchSize} memories the recall agent
surfaced during this conversation):

${input.batchList}

${TOOLS_BLOCK}

${DISCIPLINE_BLOCK}

**Workflow**:

1. Read every row. Note which look like exact duplicates (rare -
   deep-sleep usually catches these first; mostly you should see
   distinct facts), which look behaviorally related, and which
   look unrelated.
2. For each related-but-distinct pair, check whether an edge
   already exists (the rows came in with their outbound relations
   if any; if not, you can \`memory_search\` to see the full
   graph around them). If not, call \`memory_relate\` with the
   appropriate kind.
3. For any rare duplicate, call \`memory_consolidate\`.
4. For any contradiction surfaced by the batch, call
   \`memory_invalidate\` (or \`memory_doubt\` if you're unsure).
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

interface RemMemoryRow {
  id: string;
  label: string;
  data: string;
  confidence: number;
}

/**
 * Render the batch into the bullet list the prompt embeds. One row
 * per memory: "(confidence_tag conf=N.NN, id=...) `label` - data".
 * Mirror of the browser RemAgent's renderer.
 */
function renderBatchList(batch: readonly RemMemoryRow[]): string {
  if (batch.length === 0) return '(empty batch)';
  return batch
    .map((row) => {
      const tag = classifyMemoryConfidence(row.confidence);
      const tagFragment = tag ? `${tag} ` : '';
      const labelFragment = row.label.replace(/\s+/g, ' ').trim();
      const dataFragment = row.data.replace(/\s+/g, ' ').trim();
      return (
        `- (${tagFragment}conf=${row.confidence.toFixed(2)}, id=${row.id}) ` +
        `\`${labelFragment}\` - ${dataFragment}`
      );
    })
    .join('\n');
}

/**
 * Conversations with unprocessed memory_conversation rows, oldest
 * first. The dedup + FIFO ordering live in the RPC (the eligibility
 * predicate is a column-vs-column comparison PostgREST can't
 * express); p_user_id is the b-strict escape hatch for this
 * service-role caller.
 */
async function pickEligibleConversations(
  adminClient: SupabaseClient,
  userId: string,
  limit: number,
): Promise<string[]> {
  const { data, error } = await adminClient.rpc('pick_rem_eligible_conversations', {
    p_limit: limit,
    p_user_id: userId,
  });
  if (error) throw new Error(`pick_rem_eligible_conversations failed: ${error.message}`);
  return ((data ?? []) as Array<{ conversation_id: string }>).map(
    (r) => r.conversation_id,
  );
}

/**
 * Every memory referenced during recall on one conversation, joined
 * against memories for label/data/confidence in one round-trip.
 * Filters out memories below the search floor (same 0.05 cutoff as
 * deep-sleep seed selection) - a memory the user has effectively
 * retired isn't worth the agent's attention even if it was recalled
 * recently. RLS OFF: explicit user filter on the hint-queue row.
 */
async function fetchBatchForConversation(
  adminClient: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<RemMemoryRow[]> {
  const { data, error } = await adminClient
    .from('memory_conversation')
    .select('memory_id, memories!inner(id, label, data, confidence)')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .gte('memories.confidence', 0.05);
  if (error) throw new Error(`fetchBatchForConversation failed: ${error.message}`);
  type Row = {
    memory_id: string;
    memories: { id: string; label: string; data: string; confidence: number };
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.memory_id,
    label: r.memories.label,
    data: r.memories.data,
    confidence: r.memories.confidence,
  }));
}

/**
 * Stamp every memory_conversation row for one conversation as
 * processed. Called after a successful agent run - or for a
 * too-small batch, which doesn't need revisiting unless new
 * co-occurrence rows arrive (the upsert bumps last_seen_at, which
 * re-fires the eligibility predicate). RLS OFF: explicit user filter.
 */
async function markConversationProcessed(
  adminClient: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<void> {
  const { error } = await adminClient
    .from('memory_conversation')
    .update({ last_processed_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('conversation_id', conversationId);
  if (error) throw new Error(`markConversationProcessed failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Review core
// ---------------------------------------------------------------------------

/**
 * Live-progress events for user-visible rem runs. Same bracketing as
 * the wiki librarian's: `preparing` (with the conversation count)
 * opens the strip, the runner's own thinking/tool events stream the
 * middle, `done` settles it.
 */
export type RemProgressEvent =
  | { kind: 'preparing'; conversationCount: number }
  | AgentProgressEvent
  | { kind: 'done'; ok: boolean };

interface ProcessOneResult {
  status: 'reviewed' | 'too-small' | 'error';
  toolCalls: number;
  finalText: string;
}

/**
 * Process one conversation: fetch its batch, run the agent (if the
 * batch is large enough to warrant it), mark the conversation's rows
 * processed. A too-small batch is marked processed WITHOUT running
 * the agent; an agent error leaves the rows UNPROCESSED on purpose so
 * the next cycle retries the conversation (browser-loop parity).
 */
async function processOneConversation(args: {
  adminClient: SupabaseClient;
  userId: string;
  conversationId: string;
  apiKey: string;
  log: EdgeLogger;
  complete?: AgentCompleteFn;
  onProgress?: (event: RemProgressEvent) => void;
}): Promise<ProcessOneResult> {
  const { adminClient, userId, conversationId, apiKey, log } = args;

  const batch = await fetchBatchForConversation(adminClient, userId, conversationId);
  if (batch.length < REM_MIN_BATCH_SIZE) {
    log.info(
      `conversation ${conversationId} has ${batch.length} eligible ` +
        'memor(y/ies); below the rem minimum, marking processed and skipping',
    );
    await markConversationProcessed(adminClient, userId, conversationId);
    return { status: 'too-small', toolCalls: 0, finalText: '' };
  }

  log.info(
    `rem reviewing batch of ${batch.length} memor${batch.length === 1 ? 'y' : 'ies'} ` +
      `from conversation ${conversationId}`,
  );

  const promptText = buildRemPrompt({
    batchList: renderBatchList(batch),
    batchSize: batch.length,
  });

  // The librarians are not thread-scoped: memory tools ignore
  // threadId, and conversation_search's self-exclude doesn't apply to
  // a background pass.
  const baseCtx: Omit<AgentToolContext, 'signal' | 'depth'> = {
    adminClient,
    userId,
    threadId: null,
  };

  let result;
  try {
    result = await runHeadlessAgent(
      {
        model: REM_MODEL,
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
        complete: args.complete,
        onProgress: args.onProgress,
      },
      0,
    );
  } catch (err) {
    // Do NOT mark processed - the next cycle re-picks this
    // conversation rather than silently dropping the batch.
    log.warn(
      `rem failed on ${conversationId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { status: 'error', toolCalls: 0, finalText: '' };
  }

  await markConversationProcessed(adminClient, userId, conversationId);
  log.info(
    `rem finished ${conversationId} (${result.toolCalls} tool calls over ` +
      `${batch.length} memories, reasoning="${normaliseReasoning(result.finalText)}")`,
  );
  return { status: 'reviewed', toolCalls: result.toolCalls, finalText: result.finalText };
}

/** Normalise the model's operator summary for the single-line log convention. */
function normaliseReasoning(finalText: string): string {
  return finalText.replace(/\s+/g, ' ').trim() || '(none)';
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Per-tick outcome returned to the /rem-sweep caller (and the dev shim). */
export interface RemSweepSummary {
  outcome: 'no-user' | 'inflight-blocked' | 'empty-queue' | 'reviewed' | 'error';
  conversationsProcessed?: number;
  toolCalls?: number;
}

export interface RemRunOptions {
  /** Test seam; forwarded to runHeadlessAgent. */
  complete?: AgentCompleteFn;
}

/**
 * One cron tick: claim the most-overdue eligible user and drain up to
 * REM_MAX_CONVERSATIONS_PER_CYCLE of their conversations. NON-throwing
 * by contract. The cadence stamp lands at claim time, so a tick that
 * ends empty-queue or inflight-blocked consumes that user's 12h slot -
 * faithful to the browser loop (its claim also preceded the queue
 * check). A per-conversation agent error skips just that conversation;
 * the unprocessed rows retry on the next cycle.
 */
export async function runRemSweepTick(
  adminClient: SupabaseClient,
  opts: RemRunOptions = {},
): Promise<RemSweepSummary> {
  let userId: string;
  try {
    const { data, error } = await adminClient.rpc('claim_next_user_for_rem', {
      p_min_interval_seconds: REM_MIN_INTERVAL_SECONDS,
    });
    if (error) throw new Error(`claim_next_user_for_rem failed: ${error.message}`);
    if (typeof data !== 'string' || data.length === 0) return { outcome: 'no-user' };
    userId = data;
  } catch (err) {
    console.error(`[rem-sweep] ${err instanceof Error ? err.message : String(err)}`);
    return { outcome: 'error' };
  }

  const log = createEdgeLogger(userId, 'rem');
  const holderId = crypto.randomUUID();
  let held = false;
  try {
    held = await claimMemoryLibrarianInflight(adminClient, userId, holderId);
    if (!held) {
      log.info('scheduled rem run skipped - another memory-librarian run is in flight');
      return { outcome: 'inflight-blocked' };
    }

    const apiKey = await readVeniceKey(adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    const conversationIds = await pickEligibleConversations(
      adminClient,
      userId,
      REM_MAX_CONVERSATIONS_PER_CYCLE,
    );
    if (conversationIds.length === 0) {
      log.info('no conversations eligible for rem; skipping');
      return { outcome: 'empty-queue' };
    }

    let processed = 0;
    let toolCalls = 0;
    for (const conversationId of conversationIds) {
      const one = await processOneConversation({
        adminClient,
        userId,
        conversationId,
        apiKey,
        log,
        complete: opts.complete,
      });
      if (one.status === 'reviewed') {
        processed += 1;
        toolCalls += one.toolCalls;
      }
    }

    return processed > 0
      ? { outcome: 'reviewed', conversationsProcessed: processed, toolCalls }
      : { outcome: 'empty-queue' };
  } catch (err) {
    log.error(
      'scheduled rem run failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    return { outcome: 'error' };
  } finally {
    if (held) await releaseMemoryLibrarianInflight(adminClient, userId, holderId);
    await log.flush();
  }
}

/** Result union for the /rem-run route; mirrors the browser manual runner. */
export type RemManualResult =
  | { kind: 'ok'; finalText: string; toolCalls: number; conversationsProcessed: number }
  | { kind: 'empty-queue' }
  | { kind: 'busy' }
  | { kind: 'error'; error: string };

/**
 * User-triggered run (the Memories panel). Same per-conversation core
 * as the sweep but WITHOUT the cadence stamp - the user explicitly
 * asked, so a manual run doesn't reset the scheduled 12h clock
 * (browser parity). The concatenated per-conversation summaries come
 * back as finalText for the panel's result card. NON-throwing.
 */
export async function runRemManual(
  adminClient: SupabaseClient,
  userId: string,
  onProgress?: (event: RemProgressEvent) => void,
  opts: RemRunOptions = {},
): Promise<RemManualResult> {
  const log = createEdgeLogger(userId, 'rem');
  const holderId = crypto.randomUUID();
  let held = false;
  try {
    held = await claimMemoryLibrarianInflight(adminClient, userId, holderId);
    if (!held) return { kind: 'busy' };

    log.info('manual rem run requested');
    const apiKey = await readVeniceKey(adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    const conversationIds = await pickEligibleConversations(
      adminClient,
      userId,
      REM_MAX_CONVERSATIONS_PER_CYCLE,
    );
    onProgress?.({ kind: 'preparing', conversationCount: conversationIds.length });
    if (conversationIds.length === 0) {
      log.info('manual rem: no eligible conversations');
      onProgress?.({ kind: 'done', ok: true });
      return { kind: 'empty-queue' };
    }

    let processed = 0;
    let toolCalls = 0;
    const summaries: string[] = [];
    for (const conversationId of conversationIds) {
      const one = await processOneConversation({
        adminClient,
        userId,
        conversationId,
        apiKey,
        log,
        complete: opts.complete,
        onProgress,
      });
      if (one.status === 'reviewed') {
        processed += 1;
        toolCalls += one.toolCalls;
        const summary = one.finalText.replace(/\s+/g, ' ').trim();
        if (summary.length > 0) summaries.push(summary);
      }
    }

    log.info(
      `manual rem finished (${toolCalls} tool calls across ${processed} conversation(s))`,
    );
    onProgress?.({ kind: 'done', ok: true });
    return {
      kind: 'ok',
      finalText: summaries.join(' '),
      toolCalls,
      conversationsProcessed: processed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`manual rem run failed: ${msg}`);
    onProgress?.({ kind: 'done', ok: false });
    return { kind: 'error', error: msg };
  } finally {
    if (held) await releaseMemoryLibrarianInflight(adminClient, userId, holderId);
    await log.flush();
  }
}

// Test-only surface (composition + prompt invariants, batch renderer).
export const __test = { renderBatchList };
