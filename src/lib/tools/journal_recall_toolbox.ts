/**
 * Toolbox for the journal-recall agent. Mirror of the sibling recall
 * toolboxes (memories, conversations, wiki), factored out of
 * `./index.ts` for the same circular-import reason: `journal_recall`
 * (the tool that triggers the journal-recall agent) lives in
 * `./index.ts`'s TOOLS list, and the agent needs its own toolbox - if
 * the agent imported it from `./index.ts` we'd have tools/index ->
 * journal_recall -> journal_recall/agent -> tools/index, which ES
 * module circularity handles badly.
 *
 * The single tool here is lazy-loaded via `lazyTool` so its impl
 * (`journal_search`) doesn't end up statically bound to the chunk
 * this file lives in - same chunking concern as the sibling recall
 * toolboxes. Without the lazy wrapper the static import would defeat
 * tools/index.ts's chunk-split for `journal_search` and Vite would
 * surface the conflict as a "dynamically imported by tools/index,
 * statically imported by journal_recall_toolbox" warning every build.
 *
 * Read-only by design: `journal_search` is the only tool the journal-
 * recall agent is allowed to call. No journal_list / journal_read /
 * journal_delete - the agent's job is to find by meaning, write a
 * short first-person note, and stop. Date-range browsing belongs to
 * the main chat's journal toolbox where the user controls the cost.
 */
import type { Toolbox } from './types';
import { lazyTool } from './lazy';
import { journalSearchSchema } from './journal_search.schema';

export const journalRecallToolbox: Toolbox = {
  name: 'journal-recall',
  description:
    "Read-only view into the signed-in user's daily journal. " +
    'Semantic + substring search over dated entries is available via ' +
    "journal_search. No write tools - the recall agent doesn't " +
    'create, edit, or delete entries.',
  tools: [
    lazyTool(
      journalSearchSchema,
      () => import('./journal_search'),
      'journalSearch'
    ),
  ],
};
