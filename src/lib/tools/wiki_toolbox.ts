/**
 * Toolbox for the autonomous wiki agent. Factored out of
 * `./index.ts` into its own leaf file for the same reason
 * `memory_toolbox.ts` exists - importing `./index.ts` from a worker
 * bundle transitively pulls in `research_docs` and other chat-only
 * tools, blowing up the worker build.
 *
 * Tool impls are lazy-loaded via `lazyTool`; only the schemas are
 * eagerly imported here. The autonomous wiki agent runs
 * `runHeadlessToolLoop` against this toolbox (search-then-mutate
 * shape: search first to find existing articles, then update or
 * create based on the conversation; delete only for consolidation).
 *
 * The chat-side toolbox does NOT include these write tools - the
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

export const wikiToolbox: Toolbox = {
  name: 'wiki',
  description:
    "Read, create, update, and delete the signed-in user's wiki articles. " +
    'Vector + text search via wiki_search. Article voice is encyclopedic ' +
    'third-person prose. Preserve existing facts unless the conversation ' +
    'contradicts them; delete only for consolidation.',
  tools: [
    lazyTool(wikiSearchSchema, () => import('./wiki_search'), 'wikiSearch'),
    lazyTool(wikiCreateSchema, () => import('./wiki_create'), 'wikiCreate'),
    lazyTool(wikiUpdateSchema, () => import('./wiki_update'), 'wikiUpdate'),
    lazyTool(wikiDeleteSchema, () => import('./wiki_delete'), 'wikiDelete'),
  ],
};
