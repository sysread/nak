/**
 * Toolbox for the recall agent. Factored out of `./index.ts` to break
 * a circular import: `memory_recall` (the tool that triggers the
 * recall agent) lives in `./index.ts`'s TOOLS list, and the recall
 * agent needs its own toolbox - if the agent imported it from
 * `./index.ts` we'd have tools/index → memory_recall → recall/agent →
 * tools/index, which ES module circularity handles badly (the agent
 * would load before `memoryRecall` was defined, giving it an
 * undefined toolbox at class-init time).
 *
 * The single tool here is lazy-loaded via `lazyTool` so the impl
 * (`memory_search`) doesn't end up bound to whatever chunk this file
 * lives in - main, the recall-agent chunk, or anywhere else that
 * happens to reach `recallToolbox`. Without the lazy wrapper the
 * static `import { memorySearch }` here would defeat the chunk-split
 * tools/index.ts is trying to achieve and Vite would surface the
 * conflict as a "dynamically imported by tools/index, statically
 * imported by recall_toolbox" warning every build.
 *
 * The toolbox is intentionally read-only: `memory_search` is the
 * only tool the recall agent is allowed to call. No create / update /
 * invalidate / delete - a bug in the recall prompt shouldn't be able
 * to scribble over long-term memory, and `memory_recall` is excluded
 * so the agent can't recurse into another recall pass.
 */
import type { Toolbox } from './types';
import { lazyTool } from './lazy';
import { memorySearchSchema } from './memory_search.schema';

export const recallToolbox: Toolbox = {
  name: 'recall',
  description:
    "Read-only view into the signed-in user's memories. Vector + " +
    'text search is available via memory_search. No write tools - the ' +
    'recall agent is a reader, not a curator.',
  tools: [
    lazyTool(memorySearchSchema, () => import('./memory_search'), 'memorySearch'),
  ],
};
