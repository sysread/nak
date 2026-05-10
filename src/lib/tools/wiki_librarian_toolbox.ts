/**
 * Toolbox for the wiki librarian agent. Bigger surface than
 * `wikiToolbox` because the librarian's job is to fact-check and
 * reorganise articles against actual conversation history, not just
 * land per-conversation edits:
 *
 *   - wiki_search / wiki_update / wiki_delete - the read + mutate
 *     subset of the wiki agent's toolbox. NO wiki_create: the
 *     librarian's job is to consolidate what's already there, not
 *     to invent new articles. New articles flow from the per-
 *     conversation wiki agent (or the user). If the librarian
 *     decides an article should be split into two, it edits the
 *     existing article down to the bigger half and the next per-
 *     conversation cycle picks up the leftover topic.
 *   - conversation_search - read-only search over the user's prior
 *     threads' titles + summaries. Used to verify that a fact
 *     claimed in an article actually appears in some conversation,
 *     and to find threads relevant to a topic when the librarian
 *     is consolidating.
 *   - memory_search - read-only access to the user's volitional
 *     memory store. The librarian uses this for the same fact-
 *     checking pass conversation_search supports: a memory like
 *     "Maya works at Foo" is corroborating evidence when an
 *     article claims it, or contradicting evidence when the article
 *     says she works somewhere else.
 *
 * No memory write tools - memory mutations are reflection's
 * territory. The librarian only reads.
 *
 * Tool impls are lazy-loaded via `lazyTool`; only the schemas are
 * eagerly imported here. Same chunking discipline as
 * `memory_toolbox.ts` and `wiki_toolbox.ts` - importing this file
 * from a worker bundle should not transitively pull in research_docs
 * or other chat-only tools.
 */
import type { Toolbox } from './types';
import { lazyTool } from './lazy';
import { wikiSearchSchema } from './wiki_search.schema';
import { wikiUpdateSchema } from './wiki_update.schema';
import { wikiDeleteSchema } from './wiki_delete.schema';
import { conversationSearchSchema } from './conversation_search.schema';
import { memorySearchSchema } from './memory_search.schema';

export const wikiLibrarianToolbox: Toolbox = {
  name: 'wiki-librarian',
  description:
    "Read, update, and consolidate the signed-in user's wiki articles " +
    'while cross-referencing conversation history and stored memories ' +
    'to fact-check. Includes wiki_search / wiki_update / wiki_delete ' +
    'plus conversation_search and memory_search; no wiki_create or ' +
    'memory writes (consolidation and read-only fact-checking only).',
  tools: [
    lazyTool(wikiSearchSchema, () => import('./wiki_search'), 'wikiSearch'),
    lazyTool(wikiUpdateSchema, () => import('./wiki_update'), 'wikiUpdate'),
    lazyTool(wikiDeleteSchema, () => import('./wiki_delete'), 'wikiDelete'),
    lazyTool(
      conversationSearchSchema,
      () => import('./conversation_search'),
      'conversationSearch'
    ),
    lazyTool(memorySearchSchema, () => import('./memory_search'), 'memorySearch'),
  ],
};
