// context-recall (function-side pipeline)
//
// The cheap survey tier of context recall - the canonical implementation,
// extracted from the browser during the priming relocation. On a
// topic-boundary trigger it runs three deterministic vector searches
// across the persistent layers (memories / conversations / wiki),
// assembles a works-cited index, and renders it into a short first-person
// note that the orchestrator injects as a synthetic assistant <think>
// turn before the live round.
//
// Why deterministic gather, not LLM synthesis: an earlier design ran
// headless recall sub-agents that synthesized first-person notes - that
// synthesis hallucinated (paraphrasing a memory into a claim the store
// never made) and cost three model round-trips on every topic boundary.
// The index includes memory facts verbatim and references conversations /
// wiki articles by id for on-demand drill-down (conversation_get /
// wiki_get).
//
// Service-side specifics:
//   - Embeddings go through veniceEmbed with the shared key handed in by
//     the orchestrator.
//   - The three searches hit the same RPCs the memory_search / wiki_search
//     tools use, called with an explicit p_user_id arg because the admin
//     client has no auth.uid().
//   - The query is derived from the in-memory history the orchestrator
//     passes (not a listMessages DB read - the orchestrator already holds
//     the turn's messages).
//
// Failure model:
//   - Each search layer degrades independently inside the gather; one
//     throwing or returning nothing contributes an empty list rather than
//     failing the whole run.
//   - When every layer is empty the pipeline still returns a payload with
//     note: '' so the trigger evaluator's same-round debounce holds.
//   - A signal abort, or a throw outside the per-layer isolation, returns
//     null (no payload written). Caller leaves the prior cache in place.

import { type SupabaseClient } from '@supabase/supabase-js';
import { type EdgeLogger } from '../../_shared/edge-log.ts';
import {
  type ContextRecallPayload,
  type ContextRecallCitation,
} from './context-recall-payload.ts';
import { smoothContextRecall } from './context-recall-smoothing.ts';
import {
  padEmbeddingForStorage,
  VENICE_EMBEDDING_MODEL,
} from '../../_shared/backfill.ts';
import { veniceEmbed } from '../../_shared/venice.ts';
import { selectDueFollowups } from '../../_shared/followups.ts';
// Confidence-tag classifier is single-sourced in the memory_search tool
// port; reuse it so the bands cannot drift between the tool and recall.
import { classifyMemoryConfidence } from '../tools/memory_search.ts';

// Per-layer caps. Memories ride inline so the cap also bounds injected
// token cost;
// conversations and wiki are id lists, so their caps bound how many
// drill-down candidates the model weighs.
const CONTEXT_MEMORY_LIMIT = 6;
const CONTEXT_CONVERSATION_LIMIT = 5;
const CONTEXT_WIKI_LIMIT = 3;
// Follow-ups ride inline like memories (short by construction). This
// caps the SEMANTIC matches; the date-due pull has its own cap
// (DUE_SURFACE_CAP in _shared/followups.ts).
const CONTEXT_FOLLOWUP_LIMIT = 3;

// Character ceiling on the derived search query. The query is embedded by
// every layer's search; an unbounded assistant turn would blow past the
// embedding model's window. We keep the tail because the last user
// message sits at the end and carries the strongest topic signal.
const MAX_RECALL_QUERY_CHARS = 4000;

export interface ContextIndexMemory {
  id: string;
  label: string;
  data: string;
  confidence_tag: string | null;
  // Real recorded date (ISO timestamptz). The smoothing pass anchors
  // the recollection on this instead of any stale "(this session)"
  // framing baked into the memory body.
  created_at: string;
}

export interface ContextIndexRef {
  id: string;
  title: string;
}

// An open follow-up - a question the assistant saved for itself whose
// outcome it does not know. The epistemic state is computed here (not
// left to the smoothing model): 'upcoming' = the dated event hasn't
// happened yet; 'pending' = outcome unknown (date passed, or undated).
// `proactive` marks rows the date-due pull selected - they carry the
// "you've been meaning to ask" framing even without topical relevance.
export interface ContextIndexFollowup {
  id: string;
  question: string;
  context: string;
  state: 'upcoming' | 'pending';
  proactive: boolean;
  // Carried so the post-smoothing ledger stamp can increment without a
  // re-read; never rendered. 0 on semantic rows (only proactive rows
  // are ever stamped).
  surface_count: number;
}

export interface ContextIndex {
  memories: ContextIndexMemory[];
  conversations: ContextIndexRef[];
  wiki: ContextIndexRef[];
  followups: ContextIndexFollowup[];
}

interface MemoryRow {
  id: string;
  label: string;
  data: string;
  confidence: number | null;
  created_at: string;
}

interface ThreadHit {
  id: string;
  title: string;
}

interface WikiHit {
  id: string;
  title: string;
}

export interface RunContextRecallOptions {
  admin: SupabaseClient;
  userId: string;
  apiKey: string;
  threadId: string;
  history: Array<{ role: string; content?: string | null }>;
  round: number;
  mood: { band: number; column: 'confident' | 'tentative' } | null;
  nowMs: number;
  trigger: 'title' | 'mood' | 'stale' | 'cold';
  signal?: AbortSignal;
  log: EdgeLogger;
}

/**
 * Run the gather + stitch and return a fresh payload. The orchestrator
 * owns trigger evaluation, cache read, and persistence - this does not
 * do those. Returns null only when the pipeline genuinely cannot run
 * (aborted, or a throw outside the per-layer isolation); an empty note
 * is a VALID payload (note='').
 */
export async function runContextRecallPipeline(
  opts: RunContextRecallOptions,
): Promise<ContextRecallPayload | null> {
  const { round, mood, nowMs, trigger, signal, log } = opts;
  const startedAt = Date.now();
  log.info('context-recall pipeline starting', { trigger, round });

  if (signal?.aborted) return null;

  // Total safety net. gatherContextIndex isolates each search layer
  // internally, but deriveRecallQuery and the embed call outside the
  // layers can still throw. This pipeline runs on the live turn's
  // critical path, so a throw here would crash the user's chat turn
  // rather than degrade priming: any failure returns null, the caller
  // leaves the prior cache in place, and the turn proceeds with no
  // recall block.
  let index: ContextIndex;
  try {
    index = await gatherContextIndex(opts);
  } catch (err) {
    log.warn('context-recall gather failed; skipping recall this round', err);
    return null;
  }

  if (signal?.aborted) return null;

  // Recall-time narrative smoothing: compress the gathered index into a
  // first-person, past-anchored, relevance-bridged recollection with
  // `^N^` citations. Skip the model call when the gather found nothing -
  // an all-empty index is a valid cached negative the trigger debounce
  // relies on, and there is nothing to smooth.
  let note = '';
  let citations: ContextRecallCitation[] = [];
  const hasHits =
    index.memories.length > 0 ||
    index.conversations.length > 0 ||
    index.wiki.length > 0 ||
    // A due follow-up must make the note non-empty even when every
    // other layer is silent - the off-topic ask is the whole point of
    // the date axis.
    index.followups.length > 0;
  if (hasHits) {
    try {
      const smoothed = await smoothContextRecall({
        index,
        recentExchange: deriveRecallQuery(opts.history),
        apiKey: opts.apiKey,
        log,
      });
      note = smoothed.note;
      citations = smoothed.citations;
    } catch (err) {
      // Smoothing is the only place a raw, un-laundered block could
      // leak onto the wire. On failure, inject nothing this round rather
      // than the raw index: return null and the caller leaves the prior
      // cache in place. Same posture as a gather failure above.
      log.warn('context-recall smoothing failed; skipping recall this round', err);
      return null;
    }
  }

  if (signal?.aborted) return null;

  // Stamp the follow-up ask ledger only now - after smoothing produced
  // a non-empty note that this turn will actually inject. Stamping at
  // gather time (the original shape) counted a surfacing even when the
  // smoothing call failed or returned empty, so a flaky smoothing path
  // could burn a loop's whole ask budget (MAX_UNANSWERED_SURFACINGS)
  // and expire it without the user ever being asked once. Best-effort:
  // a failed stamp costs one extra ask, never the turn.
  if (note.length > 0) {
    await stampFollowupLedger(opts, index.followups);
  }

  const payload: ContextRecallPayload = {
    v: 2,
    note,
    citations,
    computed_at_round: round,
    computed_at_band: mood?.band ?? null,
    computed_at_column: mood?.column ?? null,
    computed_at_at: nowMs,
    trigger,
  };

  // Per-layer hit counts tell a debugging eye which layers carried
  // signal on a given thread.
  log.info('context-recall pipeline complete', {
    trigger,
    round,
    memoryCount: index.memories.length,
    conversationCount: index.conversations.length,
    wikiCount: index.wiki.length,
    followupCount: index.followups.length,
    citationCount: citations.length,
    noteLength: note.length,
    elapsedMs: Date.now() - startedAt,
  });
  return payload;
}

/**
 * Build the search query from the turn's messages: the last user turn
 * plus the assistant response immediately before it. The previous
 * assistant turn carries the context the user's latest message is
 * responding to, which sharpens retrieval on short follow-ups ("what
 * about the second option?") that would otherwise embed to noise.
 *
 * Trailing assistant / tool rows after the last user turn are ignored -
 * we anchor on the last USER message and look backward from there.
 * Returns the empty string when there is no user turn yet.
 */
function deriveRecallQuery(
  messages: Array<{ role: string; content?: string | null }>,
): string {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return '';

  const parts: string[] = [];
  // Nearest assistant turn with real text before the user's message.
  // Skip tool_calls-only assistant rows (empty content) - they carry no
  // readable topic signal.
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.role === 'assistant' &&
      typeof m.content === 'string' &&
      m.content.trim().length > 0
    ) {
      parts.push(m.content.trim());
      break;
    }
  }
  const userText = messages[lastUserIdx].content?.trim() ?? '';
  if (userText.length > 0) parts.push(userText);

  const query = parts.join('\n\n');
  return query.length > MAX_RECALL_QUERY_CHARS
    ? query.slice(query.length - MAX_RECALL_QUERY_CHARS)
    : query;
}

/**
 * Embed the query once and run the three persistent-layer searches in
 * parallel, assembling the index. Each layer degrades independently: a
 * search that throws or returns nothing contributes an empty array
 * rather than failing the whole gather - allSettled (not Promise.all)
 * is load-bearing here, because this runs on the live turn's critical
 * path and one layer throwing must never surface as a chat-turn failure.
 */
async function gatherContextIndex(
  opts: RunContextRecallOptions,
): Promise<ContextIndex> {
  const { signal } = opts;
  const empty: ContextIndex = {
    memories: [],
    conversations: [],
    wiki: [],
    followups: [],
  };
  if (signal?.aborted) return empty;

  const query = deriveRecallQuery(opts.history);
  // No user turn yet -> nothing to search semantically. The follow-up
  // layer's date-due pull still runs: a due ask belongs at thread open,
  // which is exactly when the history may hold no user text.
  if (query.length === 0) {
    try {
      return { ...empty, followups: await gatherFollowups(opts, null) };
    } catch (err) {
      opts.log.warn('context-recall followup layer failed', err);
      return empty;
    }
  }

  // Embed once and share the vector across all three layers. A failure
  // (no key, Venice unreachable) degrades to a null embedding - the
  // memory layer falls back to ILIKE, the conversation layer to exact-
  // title-only, and the wiki layer to nothing, each independently.
  let queryEmbedding: number[] | null = null;
  try {
    const response = await veniceEmbed({
      apiKey: opts.apiKey,
      model: VENICE_EMBEDDING_MODEL,
      input: query,
      signal,
    });
    const raw = response.data[0]?.embedding;
    if (raw && raw.length > 0) queryEmbedding = padEmbeddingForStorage(raw);
  } catch {
    // Degrade per-layer rather than failing the gather. The fallbacks
    // below each handle a null embedding.
    queryEmbedding = null;
  }

  const [memoriesR, conversationsR, wikiR, followupsR] =
    await Promise.allSettled([
      gatherMemories(opts, query, queryEmbedding),
      gatherConversations(opts, query, queryEmbedding),
      gatherWiki(opts, queryEmbedding),
      gatherFollowups(opts, queryEmbedding),
    ]);

  if (memoriesR.status === 'rejected')
    opts.log.warn('context-recall memory layer failed', memoriesR.reason);
  if (conversationsR.status === 'rejected')
    opts.log.warn(
      'context-recall conversation layer failed',
      conversationsR.reason,
    );
  if (wikiR.status === 'rejected')
    opts.log.warn('context-recall wiki layer failed', wikiR.reason);
  if (followupsR.status === 'rejected')
    opts.log.warn('context-recall followup layer failed', followupsR.reason);

  return {
    memories: memoriesR.status === 'fulfilled' ? memoriesR.value : [],
    conversations:
      conversationsR.status === 'fulfilled' ? conversationsR.value : [],
    wiki: wikiR.status === 'fulfilled' ? wikiR.value : [],
    followups: followupsR.status === 'fulfilled' ? followupsR.value : [],
  };
}

// Memory layer: vector search via search_memories_by_embedding, ILIKE
// fallback when the query couldn't be embedded. Memories ride inline
// (verbatim text cannot hallucinate).
async function gatherMemories(
  opts: RunContextRecallOptions,
  query: string,
  queryEmbedding: number[] | null,
): Promise<ContextIndexMemory[]> {
  const { admin, userId } = opts;
  let rows: MemoryRow[];
  if (queryEmbedding) {
    const { data, error } = await admin.rpc('search_memories_by_embedding', {
      query_embedding: queryEmbedding,
      match_limit: CONTEXT_MEMORY_LIMIT,
      p_user_id: userId,
    });
    if (error) {
      // RPC failure falls back to ILIKE rather than a hard error.
      rows = await ilikeMemories(opts, query);
    } else {
      rows = (data ?? []) as MemoryRow[];
    }
  } else {
    rows = await ilikeMemories(opts, query);
  }
  return rows.map((m) => ({
    id: m.id,
    label: m.label,
    data: m.data,
    confidence_tag: classifyMemoryConfidence(m.confidence),
    created_at: m.created_at,
  }));
}

// ILIKE substring fallback on label + data. RLS OFF on the admin client,
// so the user scope is an explicit user_id filter.
async function ilikeMemories(
  opts: RunContextRecallOptions,
  query: string,
): Promise<MemoryRow[]> {
  const pattern = `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { data, error } = await opts.admin
    .from('memories')
    .select('id, label, data, confidence, created_at')
    .eq('user_id', opts.userId)
    .or(`label.ilike.${pattern},data.ilike.${pattern}`)
    .order('updated_at', { ascending: false })
    .limit(CONTEXT_MEMORY_LIMIT);
  if (error) throw new Error(`ilikeMemories failed: ${error.message}`);
  return (data ?? []) as MemoryRow[];
}

// Conversation layer: exact-title ILIKE plus a semantic RPC, deduped,
// with the current thread excluded so a thread never recalls itself.
async function gatherConversations(
  opts: RunContextRecallOptions,
  query: string,
  queryEmbedding: number[] | null,
): Promise<ContextIndexRef[]> {
  const { admin, userId, threadId } = opts;
  // Overfetch one so dropping the current thread doesn't push us under
  // the cap.
  const limit = CONTEXT_CONVERSATION_LIMIT + 1;

  const pattern = `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const exactPromise = admin
    .from('threads')
    .select('id, title')
    .eq('user_id', userId)
    .ilike('title', pattern)
    .order('updated_at', { ascending: false })
    .limit(limit);

  const semanticPromise = queryEmbedding
    ? admin.rpc('search_threads_by_embedding', {
        query_embedding: queryEmbedding,
        match_limit: limit,
        p_user_id: userId,
      })
    : Promise.resolve({ data: [] as unknown[], error: null });

  const [exactRes, semRes] = await Promise.all([exactPromise, semanticPromise]);
  if (exactRes.error) {
    throw new Error(`searchThreads (exact) failed: ${exactRes.error.message}`);
  }
  // A semantic failure shouldn't kill the whole layer - fall back to
  // exact-only.
  const semanticRows =
    semRes.error !== null ? [] : ((semRes.data ?? []) as ThreadHit[]);

  const out: ContextIndexRef[] = [];
  const seen = new Set<string>();
  for (const hit of [
    ...((exactRes.data ?? []) as ThreadHit[]),
    ...semanticRows,
  ]) {
    if (hit.id === threadId) continue; // a thread should not recall itself
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push({ id: hit.id, title: hit.title });
    if (out.length >= CONTEXT_CONVERSATION_LIMIT) break;
  }
  return out;
}

// Wiki layer: semantic-only via search_wiki_articles_by_embedding, with
// the sole-source exclusion (drop articles whose only source row is THIS
// thread, so a thread does not recall its own synthesised article).
async function gatherWiki(
  opts: RunContextRecallOptions,
  queryEmbedding: number[] | null,
): Promise<ContextIndexRef[]> {
  const { admin, userId, threadId } = opts;
  // No embedding -> no vector hits. The function-side wiki_search tool
  // likewise treats an un-embeddable query as "no wiki hits"; match that
  // simpler posture rather than an ILIKE title listing.
  if (!queryEmbedding) return [];

  // Overfetch a small constant so trimming sole-source rows rarely drops
  // below the cap.
  const fetchLimit = CONTEXT_WIKI_LIMIT + 3;
  const { data, error } = await admin.rpc('search_wiki_articles_by_embedding', {
    query_embedding: queryEmbedding,
    match_limit: fetchLimit,
    p_user_id: userId,
  });
  if (error) {
    throw new Error(`searchWikiArticlesByEmbedding failed: ${error.message}`);
  }
  const rows = (data ?? []) as WikiHit[];
  if (rows.length === 0) return [];

  // Sole-source filter: fetch the source thread ids for the candidate
  // articles and drop any whose only source is the excluded thread.
  // Articles with multiple sources (cross-thread syntheses) and orphans
  // (no source rows) both stay.
  const sourcesByArticle = await listSourceThreadIdsForArticles(
    admin,
    rows.map((a) => a.id),
  );
  const kept: ContextIndexRef[] = [];
  for (const article of rows) {
    const sources = sourcesByArticle.get(article.id);
    if (sources && sources.size === 1 && sources.has(threadId)) continue;
    kept.push({ id: article.id, title: article.title });
    if (kept.length >= CONTEXT_WIKI_LIMIT) break;
  }
  return kept;
}

interface FollowupRow {
  id: string;
  question: string;
  context: string;
  relevant_after: string | null;
  last_surfaced_at: string | null;
  surface_count: number;
}

interface FollowupSemanticHit {
  id: string;
  question: string;
  context: string;
  relevant_after: string | null;
}

// Follow-up layer: the two surfacing axes of the assistant's pending
// questions (docs/dev/followups.md), unioned.
//   - Semantic: open loops matching the derived query, via
//     search_followups_by_embedding. NOT cooldown-gated - when the user
//     brings the topic up, the unresolved status is always relevant.
//   - Date-due: open loops whose relevant_after has passed, selected by
//     the pure cooldown/expiry/cap logic in _shared/followups.ts. These
//     are the proactive asks, so the gather stamps the surfacing ledger
//     (last_surfaced_at / surface_count) and lazily flips
//     policy-expired rows to 'expired'. Ledger writes are best-effort:
//     a failed stamp costs one extra ask somewhere, never the turn.
async function gatherFollowups(
  opts: RunContextRecallOptions,
  queryEmbedding: number[] | null,
): Promise<ContextIndexFollowup[]> {
  const { admin, userId, nowMs, log } = opts;
  const nowIso = new Date(nowMs).toISOString();

  // Date-due pull. RLS OFF: explicit user_id filter.
  const { data: dueData, error: dueErr } = await admin
    .from('followups')
    .select('id, question, context, relevant_after, last_surfaced_at, surface_count')
    .eq('user_id', userId)
    .eq('status', 'open')
    .not('relevant_after', 'is', null)
    .lte('relevant_after', nowIso);
  if (dueErr) throw new Error(`followups due pull failed: ${dueErr.message}`);
  const { due, expiredIds } = selectDueFollowups(
    (dueData ?? []) as FollowupRow[],
    nowMs,
  );

  // Semantic matches. Skipped without an embedding, same posture as the
  // wiki layer - the due pull above already covered the proactive axis.
  let semantic: FollowupSemanticHit[] = [];
  if (queryEmbedding) {
    const { data, error } = await admin.rpc('search_followups_by_embedding', {
      query_embedding: queryEmbedding,
      match_limit: CONTEXT_FOLLOWUP_LIMIT,
      p_user_id: userId,
    });
    if (error) {
      // Semantic failure degrades to due-only rather than killing the
      // layer - the proactive ask is the half that has no other path.
      log.warn('followups semantic search failed', error);
    } else {
      semantic = (data ?? []) as FollowupSemanticHit[];
    }
  }

  // Union, due rows first (they carry the proactive framing). The
  // epistemic state is computed here so the smoothing model never has
  // to date-math: upcoming = dated event still ahead; pending =
  // outcome unknown (date passed, or undated).
  const out: ContextIndexFollowup[] = [];
  const seen = new Set<string>();
  for (const row of due) {
    seen.add(row.id);
    out.push({
      id: row.id,
      question: row.question,
      context: row.context,
      state: 'pending',
      proactive: true,
      surface_count: row.surface_count,
    });
  }
  for (const hit of semantic) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    const at = hit.relevant_after ? Date.parse(hit.relevant_after) : NaN;
    out.push({
      id: hit.id,
      question: hit.question,
      context: hit.context,
      state: Number.isFinite(at) && at > nowMs ? 'upcoming' : 'pending',
      proactive: false,
      surface_count: 0,
    });
  }

  // Expiry flips at gather time - it is a policy judgment about the
  // row, not about this turn's delivery. The ASK LEDGER deliberately
  // does NOT stamp here: the pipeline stamps it after the smoothing
  // pass ships a non-empty note (see runContextRecallPipeline), so a
  // failed or empty smoothing never burns ask budget.
  if (expiredIds.length > 0) {
    const { error } = await admin
      .from('followups')
      .update({ status: 'expired', updated_at: nowIso })
      .in('id', expiredIds)
      .eq('user_id', userId)
      .eq('status', 'open');
    if (error) log.warn('followup expiry flip failed', error);
  }

  return out;
}

/**
 * Increment the ask ledger for the follow-ups the date-due pull
 * surfaced this round. Called by the pipeline only after a non-empty
 * note exists - a surfacing counts when it ships, not when it is
 * gathered. Semantic rows (proactive=false) are never stamped: topical
 * surfacing is not an ask-prompt, so it must not consume ask budget.
 * Best-effort: errors are logged and swallowed (a lost stamp costs one
 * extra ask before cooldown/expiry catches up; two devices racing the
 * read-modify-write can likewise lose an increment - accepted, not
 * worth a coordination primitive).
 */
async function stampFollowupLedger(
  opts: Pick<RunContextRecallOptions, 'admin' | 'userId' | 'nowMs' | 'log'>,
  followups: readonly ContextIndexFollowup[],
): Promise<void> {
  const proactive = followups.filter((f) => f.proactive);
  if (proactive.length === 0) return;
  const nowIso = new Date(opts.nowMs).toISOString();
  await Promise.all(
    proactive.map((row) =>
      opts.admin
        .from('followups')
        .update({
          last_surfaced_at: nowIso,
          surface_count: row.surface_count + 1,
        })
        .eq('id', row.id)
        .eq('user_id', opts.userId)
        .then(({ error }) => {
          if (error) opts.log.warn('followup ledger stamp failed', error);
        }),
    ),
  );
}

// Test-only surface. The gather/stamp split is a timing contract - the
// due pull must not consume ask budget unless a note actually ships -
// so both halves get offline coverage with a scripted admin client in
// supabase/functions/tests/followup-gather.test.ts.
export const __test = { gatherFollowups, stampFollowupLedger };

// Map article id -> set of source thread ids. Articles with no rows in
// wiki_article_sources are absent from the map (orphans). RLS OFF on the
// admin client; the wiki_article_sources rows are scoped through the
// articles' user, but we read by article id only - the candidate ids
// already came from a user-scoped RPC.
async function listSourceThreadIdsForArticles(
  admin: SupabaseClient,
  articleIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (articleIds.length === 0) return out;
  const { data, error } = await admin
    .from('wiki_article_sources')
    .select('article_id, thread_id')
    .in('article_id', [...articleIds]);
  if (error) throw new Error(`listSourceThreadIds failed: ${error.message}`);
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const articleId = row.article_id;
    const threadId = row.thread_id;
    if (typeof articleId !== 'string' || typeof threadId !== 'string') continue;
    const set = out.get(articleId);
    if (set) set.add(threadId);
    else out.set(articleId, new Set([threadId]));
  }
  return out;
}

