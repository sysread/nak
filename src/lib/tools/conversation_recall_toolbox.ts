/**
 * Toolbox for the conversation-recall agent. Mirror of `./recall_toolbox`
 * for the memory side - factored out of `./index.ts` for the same
 * circular-import reason: `conversation_recall` (the tool that
 * triggers the conversation-recall agent) lives in `./index.ts`'s
 * TOOLS list, and the agent needs its own toolbox.
 *
 * The single tool here is lazy-loaded via `lazyTool` so its impl
 * (`conversation_search`) doesn't end up statically bound to the
 * chunk this file lives in - same chunking concern as
 * `./recall_toolbox`. Without the lazy wrapper the static import
 * would defeat tools/index.ts's chunk-split for `conversation_search`
 * and Vite would surface the conflict as a "dynamically imported by
 * tools/index, statically imported by conversation_recall_toolbox"
 * warning every build.
 *
 * Read-only by design: `conversation_search` is the only tool the
 * recall agent is allowed to call. No way to mutate a thread from the
 * recall path - the agent's job is to read past conversations and
 * write a short first-person note, not to touch the threads table.
 */
import type { Toolbox } from './types';
import { lazyTool } from './lazy';
import { conversationSearchSchema } from './conversation_search.schema';

export const conversationRecallToolbox: Toolbox = {
  name: 'conversation-recall',
  description:
    "Read-only view into the signed-in user's prior conversations. " +
    'Full exact + semantic search over every thread is available via ' +
    "conversation_search. No write tools - the recall agent doesn't " +
    'rename, archive, or otherwise touch threads.',
  tools: [
    lazyTool(
      conversationSearchSchema,
      () => import('./conversation_search'),
      'conversationSearch'
    ),
  ],
};
