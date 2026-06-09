/**
 * Toolbox for the autonomous wiki agent. Factored out of
 * `./index.ts` into its own leaf file for the same reason the other
 * agent-toolbox leaf files are - importing `./index.ts` from a worker
 * bundle transitively pulls in `research_docs` and other chat-only
 * tools, blowing up the worker build.
 *
 * Tool impls are lazy-loaded via `lazyTool`; only the schemas are
 * eagerly imported here. The autonomous wiki agent runs
 * `runHeadlessToolLoop` against this toolbox (search-then-mutate
 * shape: search first to find existing articles, then update or
 * create based on the conversation; delete only for consolidation).
 *
 * `memory_search` rides along as a READ-ONLY tool so the agent can
 * ground article content in facts the reflection agent has already
 * extracted - "Maya is the user's sister, works at X, lives in Y" -
 * rather than rediscovering them from the conversation each cycle.
 * The wiki agent does NOT get any of the memory write tools; memory
 * mutations stay owned by the reflection agent and the user.
 *
 * The chat-side toolbox does NOT include the wiki write tools - the
 * user's main LLM only reaches wiki_search (registered in the
 * always-on toolbox in ./index.ts). Article mutations come from
 * either the autonomous agent here or the per-article "ask agent to
 * update" UI flow on Wiki.svelte.
 */
import type { Toolbox } from './types';
import { lazyTool } from './lazy';
import { wikiSearchSchema } from './wiki_search.schema';
import { wikiCreateSchema } from './wiki_create.schema';
import { wikiUpdateSchema } from './wiki_update.schema';
import { wikiDeleteSchema } from './wiki_delete.schema';
import { memorySearchSchema } from './memory_search.schema';

export const wikiToolbox: Toolbox = {
  name: 'wiki',
  description:
    "Read, create, update, and delete the signed-in user's wiki articles. " +
    'Vector + text search via wiki_search; read-only memory_search rides ' +
    'along for grounding article content in established facts. Article ' +
    'voice is encyclopedic third-person prose. Preserve existing facts ' +
    'unless the conversation contradicts them; delete only for ' +
    'consolidation.',
  tools: [
    lazyTool(wikiSearchSchema, () => import('./wiki_search'), 'wikiSearch'),
    lazyTool(wikiCreateSchema, () => import('./wiki_create'), 'wikiCreate'),
    lazyTool(wikiUpdateSchema, () => import('./wiki_update'), 'wikiUpdate'),
    lazyTool(wikiDeleteSchema, () => import('./wiki_delete'), 'wikiDelete'),
    lazyTool(memorySearchSchema, () => import('./memory_search'), 'memorySearch'),
  ],
};
