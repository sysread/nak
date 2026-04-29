/**
 * Toolbox for the journaling agent. Sibling of `./recall_toolbox.ts`
 * and `./conversation_recall_toolbox.ts` - factored into a leaf file
 * so the journal Web Worker bundle can import it without dragging in
 * `./index.ts`'s lazy globs (research_docs reaches into
 * `src/lib/docs.ts`'s non-eager `import.meta.glob`, which forces code-
 * splitting and crashes the worker's IIFE build).
 *
 * Read-only by design: the journal agent reads the conversation it's
 * processing plus whatever context these two searches surface, then
 * emits the entry through `response_format=json_object` and writes it
 * via the atomic upsert RPC. It never mutates memories or threads
 * itself - a bug in the journal prompt shouldn't be able to scribble
 * over long-term memory or rename threads.
 *
 * Why search-only and not the recall sub-agents (`memory_recall` /
 * `conversation_recall`):
 *
 *   - Both recall agents synthesize a first-person note ("you said
 *     earlier...") meant to be folded into a chat assistant's reply.
 *     The journal agent writes in third-person observational voice,
 *     so the recall output would need translation.
 *   - The journal agent already runs inside its own tool loop; nesting
 *     a sub-agent's tool loop inside it doubles the round-trip cost
 *     for marginal value over the raw search.
 *   - `memory_search` and `conversation_search` together cover the
 *     "pull in adjacent context for richer entries" use case.
 *
 * Current-thread exclusion: `conversation_search` defaults to filtering
 * `ctx.threadId` out of its results. The journal agent populates
 * `toolCtx.threadId` with `req.input.threadId` (the thread being
 * journaled, NOT whatever thread the user happens to have open in the
 * UI), so the default exclusion automatically prevents the agent from
 * pulling its own source conversation back in via search.
 */
import type { Toolbox } from './types';
import { memorySearch } from './memory_search';
import { conversationSearch } from './conversation_search';

export const journalAgentToolbox: Toolbox = {
  name: 'journal-agent',
  description:
    "Read-only context lookup for the journaling agent. " +
    '`memory_search` finds saved memories about people, themes, or ' +
    'situations the conversation touches; `conversation_search` ' +
    'finds prior threads the user might be implicitly referring to. ' +
    'No write tools - the agent reads context, then writes the entry ' +
    'through structured JSON output, not tool calls.',
  tools: [memorySearch, conversationSearch],
};
