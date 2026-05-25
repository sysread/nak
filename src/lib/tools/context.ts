/**
 * Umbrella `context` tool - the single point of entry for broad
 * lookups of persistent RAG about the user. Runs the same deterministic
 * gather the auto-injection pipeline uses (memories verbatim, plus a
 * by-id index of related conversations and wiki articles) and returns
 * it structured for the main model to read and drill into.
 *
 * Why a tool rather than only auto-injection: the chat-loop's context-
 * recall pipeline ALREADY auto-injects this index on topic boundaries
 * (cold-start, title shift, mood shift, stale fuse). That auto-
 * injection is keyed off the live conversation. The `context` tool is
 * the explicit, model-driven counterpart: when the main model wants a
 * broad lookup right now - optionally biased toward a specific topic it
 * passes - it calls this tool and gets the same kind of index
 * synchronously, regardless of whether a topic boundary fired.
 *
 * Why an umbrella rather than three separate searches: round-trips
 * compound. memory_search, conversation_search, and wiki_search each
 * cost the model a tool call; the umbrella runs all three in parallel
 * internally and returns one result, collapsing three round-trips at
 * the main-model level into one.
 *
 * Drill-down: the result inlines memory facts verbatim (no follow-up
 * needed) but references conversations and wiki articles by id only.
 * The model reads a specific one with `conversation_get` / `wiki_get`
 * when it wants the transcript / article body. The per-layer recall
 * tools (memory_recall, conversation_recall, wiki_recall) stay
 * available as the LLM-synthesized, targeted drill-down tier.
 *
 * Toolbox scoping: lives in the main chat's TOOLS list. NOT available
 * in any agent-only toolbox - background agents have no business
 * calling a three-way umbrella recall.
 *
 * Schema lives in `./context.schema.ts`.
 */
import type { ToolDef } from './types';
import {
  gatherContextIndex,
  type ContextIndex,
} from '../context-recall/gather';
import { createLogger } from '../logger.svelte';
import { contextSchema } from './context.schema';

const log = createLogger('context-tool');

export const contextTool: ToolDef = {
  ...contextSchema,
  async execute(args, ctx): Promise<ContextIndex> {
    const topic =
      typeof args.topic === 'string' && args.topic.trim().length > 0
        ? args.topic.trim()
        : null;

    // Breadcrumb matches the other recall surfaces - consistent log
    // prefixes let the log drawer be eyeballed for "a recall is
    // happening right now" without remembering distinct tags.
    log.info(`picked up thread ${ctx.threadId}`);
    const startedAt = Date.now();

    const index = await gatherContextIndex({
      venice: ctx.venice,
      supabase: ctx.supabase,
      threadId: ctx.threadId,
      signal: ctx.signal,
      query: topic,
    });

    log.info(
      `finished thread ${ctx.threadId} ` +
        `(memories=${index.memories.length}, ` +
        `conversations=${index.conversations.length}, ` +
        `wiki=${index.wiki.length}, elapsedMs=${Date.now() - startedAt})`
    );

    return index;
  },
};
