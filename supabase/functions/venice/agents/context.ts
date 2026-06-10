// context tool (function-side port)
//
// Umbrella tool the main chat model calls for broad lookups of
// persistent RAG about the user. Mirror of src/lib/tools/context.ts +
// src/lib/context-recall/gather.ts at the function side: runs the
// three persistent-layer searches in parallel and assembles a works-
// cited index - memories verbatim, conversations + wiki articles by
// (id, title) so the model can drill down via conversation_get /
// wiki_get when one looks relevant.
//
// Deterministic by design: this is the cheap survey tier. memory_recall
// / conversation_recall / wiki_recall remain the LLM-synthesized,
// targeted drill-down tier. The split is deliberate; see
// docs/dev/context-recall.md.
//
// Layer degradation: Promise.allSettled. A failing layer contributes
// an empty array rather than failing the whole gather - the umbrella
// runs on the live turn's critical path and one layer throwing must
// not surface as a chat-turn failure.

import { createEdgeLogger } from '../../_shared/edge-log.ts';
import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { memorySearch } from '../tools/memory_search.ts';
import { conversationSearch } from '../tools/conversation_search.ts';
import { wikiSearch } from '../tools/wiki_search.ts';
import { logPreview } from './_recall_helpers.ts';

// Per-layer caps. Memories ride inline so the cap also bounds the
// injected token cost; conversations and wiki are id lists, so their
// caps just bound how many drill-down candidates the model weighs.
const CONTEXT_MEMORY_LIMIT = 6;
const CONTEXT_CONVERSATION_LIMIT = 5;
const CONTEXT_WIKI_LIMIT = 3;
const MAX_RECALL_QUERY_CHARS = 4000;

interface StoredMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

interface ContextIndexMemory {
  id: string;
  label: string;
  data: string;
  confidence_tag: 'corroborated' | 'hedged' | 'shaky' | null;
}

interface ContextIndexRef {
  id: string;
  title: string;
}

interface ContextIndex {
  memories: ContextIndexMemory[];
  conversations: ContextIndexRef[];
  wiki: ContextIndexRef[];
}

/**
 * Derive a search query from the thread when the caller didn't pass a
 * topic. Anchors on the last user turn and prepends the nearest
 * assistant response with real content (skipping tool_calls-only
 * rows). Truncates to MAX_RECALL_QUERY_CHARS keeping the tail because
 * the last user message sits at the end and carries the strongest
 * topic signal.
 */
function deriveRecallQuery(messages: StoredMessage[]): string {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return '';

  const parts: string[] = [];
  for (let i = lastUserIdx - 1; i >= 0; i -= 1) {
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

interface MemoryHit {
  id?: unknown;
  label?: unknown;
  data?: unknown;
  confidence_tag?: unknown;
}

interface RefHit {
  id?: unknown;
  title?: unknown;
}

function isValidConfidenceTag(
  t: unknown,
): t is 'corroborated' | 'hedged' | 'shaky' | null {
  return t === null || t === 'corroborated' || t === 'hedged' || t === 'shaky';
}

export const contextTool: ToolDef = {
  name: 'context',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const empty: ContextIndex = { memories: [], conversations: [], wiki: [] };
    if (ctx.signal.aborted) return empty;

    // Drawer logging. The umbrella runs mid-turn on the live chat
    // path, so the run - and the finally-flush below - is bounded by
    // the turn.
    const log = createEdgeLogger(ctx.userId, 'context');
    try {
      let query =
        typeof args.topic === 'string' && args.topic.trim().length > 0
          ? args.topic.trim()
          : '';
      if (query.length === 0) {
        // RLS OFF: scoped via parent thread.
        const { data: msgs, error: msgErr } = await ctx.adminClient
          .from('messages')
          .select('role, content')
          .eq('thread_id', ctx.threadId)
          .order('created_at', { ascending: true });
        if (msgErr) {
          // Degrade quietly - we cannot derive a query without the
          // thread, so the umbrella returns the empty index.
          log.error(`message read failed: ${msgErr.message}`, msgErr);
          return empty;
        }
        query = deriveRecallQuery((msgs ?? []) as StoredMessage[]);
      }
      if (query.length === 0) return empty;

      log.debug(`context gather start: query "${logPreview(query)}"`);

      // Run all three searches in parallel via allSettled. A search that
      // throws contributes an empty list rather than failing the gather
      // - one layer's outage must not surface as a chat-turn failure.
      const [memoryR, convR, wikiR] = await Promise.allSettled([
        memorySearch.execute(
          { query, limit: CONTEXT_MEMORY_LIMIT },
          ctx,
        ),
        conversationSearch.execute(
          { query, limit: CONTEXT_CONVERSATION_LIMIT },
          ctx,
        ),
        wikiSearch.execute({ query, limit: CONTEXT_WIKI_LIMIT }, ctx),
      ]);

      if (memoryR.status === 'rejected') {
        log.error('memory layer failed:', memoryR.reason);
      }
      if (convR.status === 'rejected') {
        log.error('conversation layer failed:', convR.reason);
      }
      if (wikiR.status === 'rejected') {
        log.error('wiki layer failed:', wikiR.reason);
      }

      const memories: ContextIndexMemory[] = [];
      if (memoryR.status === 'fulfilled' && Array.isArray(memoryR.value)) {
        for (const raw of memoryR.value as MemoryHit[]) {
          if (!raw || typeof raw !== 'object') continue;
          const id = raw.id;
          const label = raw.label;
          const data = raw.data;
          const tag = raw.confidence_tag;
          if (
            typeof id !== 'string' ||
            typeof label !== 'string' ||
            typeof data !== 'string' ||
            !isValidConfidenceTag(tag)
          ) {
            continue;
          }
          memories.push({ id, label, data, confidence_tag: tag });
          if (memories.length >= CONTEXT_MEMORY_LIMIT) break;
        }
      }

      const conversations: ContextIndexRef[] = [];
      if (convR.status === 'fulfilled' && Array.isArray(convR.value)) {
        for (const raw of convR.value as RefHit[]) {
          if (!raw || typeof raw !== 'object') continue;
          const id = raw.id;
          const title = raw.title;
          if (typeof id !== 'string' || typeof title !== 'string') continue;
          conversations.push({ id, title });
          if (conversations.length >= CONTEXT_CONVERSATION_LIMIT) break;
        }
      }

      const wiki: ContextIndexRef[] = [];
      if (wikiR.status === 'fulfilled' && Array.isArray(wikiR.value)) {
        for (const raw of wikiR.value as RefHit[]) {
          if (!raw || typeof raw !== 'object') continue;
          const id = raw.id;
          const title = raw.title;
          if (typeof id !== 'string' || typeof title !== 'string') continue;
          wiki.push({ id, title });
          if (wiki.length >= CONTEXT_WIKI_LIMIT) break;
        }
      }

      log.info(
        `context gather finished (${memories.length} memories, ` +
          `${conversations.length} conversations, ${wiki.length} wiki articles)`,
      );
      return { memories, conversations, wiki };
    } catch (err) {
      // Logging only - the failure still propagates to the tool
      // dispatcher unchanged; this line is the drawer-visible reason.
      log.error(
        'context gather failed',
        err instanceof Error ? err : new Error(String(err)),
      );
      throw err;
    } finally {
      await log.flush();
    }
  },
};

registerTool(contextTool);
