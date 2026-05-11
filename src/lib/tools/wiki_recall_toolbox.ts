/**
 * Toolbox for the wiki-recall agent. Mirror of `./recall_toolbox`
 * (memories) and `./conversation_recall_toolbox` (prior threads),
 * factored out of `./index.ts` for the same circular-import reason:
 * `wiki_recall` (the tool that triggers the wiki-recall agent) lives
 * in `./index.ts`'s TOOLS list, and the agent needs its own toolbox -
 * if the agent imported it from `./index.ts` we'd have tools/index ->
 * wiki_recall -> wiki_recall/agent -> tools/index, which ES module
 * circularity handles badly (the agent would load before `wikiRecall`
 * was defined, giving it an undefined toolbox at class-init time).
 *
 * The single tool here is lazy-loaded via `lazyTool` so its impl
 * (`wiki_search`) doesn't end up statically bound to the chunk this
 * file lives in - same chunking concern as the sibling recall
 * toolboxes. Without the lazy wrapper the static import would defeat
 * tools/index.ts's chunk-split for `wiki_search` and Vite would
 * surface the conflict as a "dynamically imported by tools/index,
 * statically imported by wiki_recall_toolbox" warning every build.
 *
 * Read-only by design: `wiki_search` is the only tool the wiki-recall
 * agent is allowed to call. No way to mutate an article from the
 * recall path - the agent's job is to read the wiki and write a
 * short first-person note, not to touch the articles table. Article
 * mutations stay owned by the autonomous wiki agent and the user.
 */
import type { Toolbox } from './types';
import { lazyTool } from './lazy';
import { wikiSearchSchema } from './wiki_search.schema';

export const wikiRecallToolbox: Toolbox = {
  name: 'wiki-recall',
  description:
    "Read-only view into the signed-in user's wiki. Vector + text " +
    'search over titled encyclopedic articles is available via ' +
    "wiki_search. No write tools - the recall agent doesn't create, " +
    'update, or delete articles.',
  tools: [
    lazyTool(wikiSearchSchema, () => import('./wiki_search'), 'wikiSearch'),
  ],
};
