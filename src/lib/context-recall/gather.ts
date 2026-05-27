/**
 * Deterministic context gathering - the retrieval half of context
 * recall, shared by the auto-injection pipeline and the umbrella
 * `context` tool.
 *
 * Why deterministic rather than three LLM sub-agents: the prior design
 * fanned out three headless tool-loops (memory / conversation / wiki)
 * that each read the thread, ran searches, and synthesized a first-
 * person note. That synthesis step was the source of recurring
 * hallucination in the injected <think> block - the model paraphrasing
 * a memory into something the store never said - and it paid three
 * model round-trips on every topic boundary, slowing the live turn.
 *
 * This module runs the three vector searches directly and assembles a
 * works-cited index instead of synthesized prose:
 *
 *   - memories       included VERBATIM (capped). Short standing facts;
 *                    verbatim text cannot hallucinate, and the fact is
 *                    present immediately with no drill-down round-trip.
 *   - conversations  title + id list. The model reads a specific thread
 *                    with `conversation_get` when it wants the details.
 *   - wiki           title + id list. The model reads a specific
 *                    article with `wiki_get` when it wants the body.
 *
 * Size-appropriate split: small payloads (memory facts) ride inline;
 * large payloads (full transcripts, long articles) are referenced by
 * id and pulled on demand, so the main model chooses when to pay the
 * drill-down cost rather than paying it automatically every time.
 *
 * Query: the pipeline has no explicit topic, so it derives one from
 * the live thread - the last user turn plus the assistant response
 * before it (see `deriveRecallQuery`). The `context` tool substitutes
 * the caller's explicit topic. Both feed the same three searches.
 *
 * The per-layer recall tools (`memory_recall`, `conversation_recall`,
 * `wiki_recall`) still wrap the LLM sub-agents as the expensive,
 * targeted drill-down tier; this module is the cheap survey tier. That
 * divergence is deliberate - see docs/dev/context-recall.md.
 */
import type { VeniceClient } from '../venice';
import type { SupabaseService, Message } from '../supabase';
import {
  searchMemoriesSemantic,
  classifyMemoryConfidence,
  type MemoryConfidenceTag,
} from '../memories';
import { searchWikiArticlesSemantic } from '../wiki';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from '../models';
import { createLogger } from '../logger.svelte';

const log = createLogger('context-recall');

/** Verbatim memory row as it lands in the index. A subset of the full
 *  Memory shape - the fields the consuming model needs to read the fact
 *  and weight it, nothing more. `confidence_tag` lets the model
 *  discount a shaky recollection without a second lookup. */
export interface ContextIndexMemory {
  id: string;
  label: string;
  data: string;
  confidence_tag: MemoryConfidenceTag;
}

/** A by-reference index entry for the layers we don't inline. Title for
 *  the model to recognise the topic, id for the drill-down tool
 *  (`conversation_get` / `wiki_get`). */
export interface ContextIndexRef {
  id: string;
  title: string;
}

/** Assembled index across the three persistent layers. Empty arrays are
 *  a legitimate "nothing matched" state - the renderer collapses an
 *  all-empty index to the empty string. */
export interface ContextIndex {
  memories: ContextIndexMemory[];
  conversations: ContextIndexRef[];
  wiki: ContextIndexRef[];
}

/** Per-layer caps. Memories ride inline so the cap also bounds the
 *  injected token cost; conversations and wiki are id lists, so their
 *  caps just bound how many drill-down candidates the model weighs. */
export const CONTEXT_MEMORY_LIMIT = 6;
export const CONTEXT_CONVERSATION_LIMIT = 5;
export const CONTEXT_WIKI_LIMIT = 3;

/** Character ceiling on the derived search query. The query is embedded
 *  by every layer's search; an unbounded assistant turn would blow past
 *  the embedding model's window. We keep the tail because the last user
 *  message sits at the end and carries the strongest topic signal. */
const MAX_RECALL_QUERY_CHARS = 4000;

export interface GatherContextInputs {
  venice: VeniceClient;
  supabase: SupabaseService;
  /** Thread we're recalling for. Used to read messages when no explicit
   *  query is passed, and to exclude the current thread / its sole-
   *  sourced wiki articles from the results (a thread should not recall
   *  itself). */
  threadId: string;
  signal: AbortSignal;
  /** Explicit query - the `context` tool's `topic` argument. When
   *  null/empty the query is derived from the live thread. */
  query?: string | null;
}

/**
 * Build the search query for the auto-injection path from a thread's
 * messages: the last user turn plus the assistant response immediately
 * before it. The previous assistant turn carries the context the user's
 * latest message is responding to, which sharpens retrieval on short
 * follow-ups ("what about the second option?") that would otherwise
 * embed to noise on their own.
 *
 * Trailing assistant / tool rows after the last user turn (an in-flight
 * round the chat-loop persisted on its way into recall) are ignored -
 * we anchor on the last USER message and look backward from there.
 *
 * Returns the empty string when the thread has no user turn yet; the
 * caller treats that as "nothing to search on."
 */
export function deriveRecallQuery(messages: Message[]): string {
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
 * Run the three persistent-layer searches in parallel and assemble the
 * index. Each layer degrades independently: a search that throws or
 * returns nothing contributes an empty array rather than failing the
 * whole gather.
 */
export async function gatherContextIndex(
  inputs: GatherContextInputs
): Promise<ContextIndex> {
  const { venice, supabase, threadId, signal } = inputs;
  const empty: ContextIndex = { memories: [], conversations: [], wiki: [] };
  if (signal.aborted) return empty;

  let query =
    typeof inputs.query === 'string' && inputs.query.trim().length > 0
      ? inputs.query.trim()
      : '';
  if (query.length === 0) {
    const messages = await supabase.listMessages(threadId);
    query = deriveRecallQuery(messages);
  }
  if (query.length === 0) return empty;

  // Each layer degrades independently: a search that throws (Venice
  // unreachable for the embed, a PostgREST error on an oversized query,
  // an RPC failure) contributes an empty list rather than rejecting the
  // whole gather. allSettled (not Promise.all) is load-bearing here -
  // this gather runs on the live turn's critical path via
  // runContextRecallPipeline, so one layer throwing must never surface
  // as a chat-turn failure. The failure mode that motivated this: a
  // very large opening message on a brand-new thread, where the
  // cold-start trigger fires recall and one layer's search threw.
  const [memoriesR, conversationsR, wikiR] = await Promise.allSettled([
    gatherMemories(query, { supabase, venice, signal }),
    gatherConversations(query, threadId, { venice, supabase, signal }),
    gatherWiki(query, threadId, { supabase, venice, signal }),
  ]);

  if (memoriesR.status === 'rejected')
    log.warn('memory layer failed', memoriesR.reason);
  if (conversationsR.status === 'rejected')
    log.warn('conversation layer failed', conversationsR.reason);
  if (wikiR.status === 'rejected')
    log.warn('wiki layer failed', wikiR.reason);

  return {
    memories: memoriesR.status === 'fulfilled' ? memoriesR.value : [],
    conversations:
      conversationsR.status === 'fulfilled' ? conversationsR.value : [],
    wiki: wikiR.status === 'fulfilled' ? wikiR.value : [],
  };
}

async function gatherMemories(
  query: string,
  deps: { supabase: SupabaseService; venice: VeniceClient; signal: AbortSignal }
): Promise<ContextIndexMemory[]> {
  const rows = await searchMemoriesSemantic(query, CONTEXT_MEMORY_LIMIT, deps);
  return rows.map((m) => ({
    id: m.id,
    label: m.label,
    data: m.data,
    confidence_tag: classifyMemoryConfidence(m.confidence),
  }));
}

async function gatherWiki(
  query: string,
  threadId: string,
  deps: { supabase: SupabaseService; venice: VeniceClient; signal: AbortSignal }
): Promise<ContextIndexRef[]> {
  // Exclude articles whose only source is THIS thread, so a thread does
  // not recall its own synthesised article back at itself - same
  // hygiene the wiki_search tool applies in recall mode.
  const rows = await searchWikiArticlesSemantic(query, CONTEXT_WIKI_LIMIT, {
    ...deps,
    excludeSoleSourceThreadId: threadId,
  });
  return rows.map((a) => ({ id: a.id, title: a.title }));
}

async function gatherConversations(
  query: string,
  threadId: string,
  deps: { venice: VeniceClient; supabase: SupabaseService; signal: AbortSignal }
): Promise<ContextIndexRef[]> {
  const { venice, supabase, signal } = deps;

  let queryEmbedding: number[] | null = null;
  try {
    const response = await venice.embed({
      model: VENICE_EMBEDDING_MODEL,
      input: query,
      signal,
    });
    const raw = response.data[0]?.embedding;
    if (raw && raw.length > 0) queryEmbedding = padEmbeddingForStorage(raw);
  } catch {
    // Degrade to exact-title-only - a partial result beats failing the
    // whole conversation layer when Venice is unreachable.
    queryEmbedding = null;
  }

  // Overfetch one so dropping the current thread doesn't push us under
  // the cap. searchThreads caps its own output at the limit it's given.
  const hits = await supabase.searchThreads({
    query,
    queryEmbedding,
    limit: CONTEXT_CONVERSATION_LIMIT + 1,
  });
  return hits
    .filter((h) => h.thread.id !== threadId)
    .slice(0, CONTEXT_CONVERSATION_LIMIT)
    .map((h) => ({ id: h.thread.id, title: h.thread.title }));
}

/**
 * Render the index into the body of the synthetic `<think>` turn the
 * pipeline injects. Returns the inner text only - `ephemeral.ts` wraps
 * it in `<think>` tags and the marker comment. An all-empty index
 * renders to the empty string, which the caller caches as the negative
 * result and skips injecting.
 *
 * Voice: first person, framed as the assistant's own recollection plus
 * an offer to look up the referenced items. The memory facts are
 * verbatim; the conversation and wiki sections name the drill-down tool
 * so the model knows the ids are actionable.
 */
export function renderContextThink(index: ContextIndex): string {
  const sections: string[] = [];

  if (index.memories.length > 0) {
    const lines = index.memories.map(renderMemoryLine).join('\n');
    sections.push(`I recall some related things about this topic:\n\n${lines}`);
  }

  if (index.conversations.length > 0) {
    const bullets = index.conversations
      .map((c) => `- ${c.title} (id: ${c.id})`)
      .join('\n');
    sections.push(
      'We have talked about related topics before. I can call ' +
        'conversation_get with one of these ids to pull up what was ' +
        `said if it would help:\n${bullets}`
    );
  }

  if (index.wiki.length > 0) {
    const bullets = index.wiki
      .map((w) => `- ${w.title} (id: ${w.id})`)
      .join('\n');
    sections.push(
      'We have documented some possibly-related information in the ' +
        'wiki. I can call wiki_get with one of these ids to read the ' +
        `full article if it would help:\n${bullets}`
    );
  }

  return sections.join('\n\n');
}

function renderMemoryLine(m: ContextIndexMemory): string {
  // Flag a low-confidence recollection inline so the model can hedge or
  // verify rather than asserting it. Corroborated / unset tags read as
  // plain facts and need no annotation.
  const hedge =
    m.confidence_tag === 'hedged' || m.confidence_tag === 'shaky'
      ? ` (${m.confidence_tag} recollection)`
      : '';
  return `- ${m.data}${hedge}`;
}
