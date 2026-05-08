/**
 * Toolbox for the memory-reflection agent (and any future memory-only
 * agent). Factored out of `./index.ts` into its own leaf file so the
 * reflection worker's bundle reaches only the modules it actually
 * needs - importing `./index.ts` would transitively pull in
 * `research_docs` and that file's lazy docs glob, which used to
 * crash the worker build before workers moved to `type: 'module'`.
 *
 * Tool impls are lazy-loaded via `lazyTool`: only the schemas land
 * eagerly here, the `execute` bodies fetch their chunk on first
 * dispatch. That keeps the static-import graph for this file
 * narrow (just schemas, no DB-call bodies, no event-bus emitters)
 * which is what makes memory_search etc. moveable into their own
 * Vite chunks. Pre-lazy versions of this file pulled the full
 * impls eagerly, which kept memory_search bound to whichever chunk
 * memoryToolbox ended up in (main, the reflection worker, both)
 * and defeated the chunk-splitting tools/index.ts was trying to
 * achieve.
 *
 * Shape contract: NOT identical to the main chat's `memoriesToolbox`.
 *
 *   - `toggle_toolbox` is absent - chat-UX concern; agents don't need
 *     a context-window gate because their prompts and tool schemas
 *     aren't shared with the user-facing conversation.
 *   - `memory_recall` is absent - it spawns another agent, and giving
 *     reflection a nested recall pass would be recursion with no
 *     purpose (reflection already has the whole conversation in
 *     context). Main-chat tool only.
 *   - `conversation_recall` is absent for the same reason, and
 *     `conversation_search` has no business in a memory-mutation
 *     toolbox at all.
 *   - `memory_delete` is replaced by `memory_invalidate`. The agent's
 *     job is to react to new evidence, which sometimes means
 *     contradicting what it knew before - but we don't want autonomous
 *     hard deletes. `memory_invalidate` halves confidence (schema
 *     `decay_memory_confidence` RPC), which drives the row below the
 *     search floor without erasing it. Recoverable if the agent
 *     re-learns the fact. The main chat keeps hard-delete semantics
 *     because "forget X" is user-directed and unambiguous.
 */
import type { Toolbox } from './types';
import { lazyTool } from './lazy';
import { memorySearchSchema } from './memory_search.schema';
import { memoryCreateSchema } from './memory_create.schema';
import { memoryUpdateSchema } from './memory_update.schema';
import { memoryInvalidateSchema } from './memory_invalidate.schema';
import { memoryReaffirmSchema } from './memory_reaffirm.schema';
import { memoryDoubtSchema } from './memory_doubt.schema';
import { memoryRelateSchema } from './memory_relate.schema';
import { memoryUnrelateSchema } from './memory_unrelate.schema';

export const memoryToolbox: Toolbox = {
  name: 'memory',
  description:
    "Create, read, update, and link the signed-in user's memories, and " +
    'invalidate or doubt ones contradicted or weakened by new evidence. ' +
    'Vector + text search via memory_search. Invalidation halves ' +
    'confidence; the gentler reaffirm/doubt pair nudges it; memory_relate ' +
    'and memory_unrelate manage edges in the memory graph.',
  tools: [
    lazyTool(memorySearchSchema, () => import('./memory_search'), 'memorySearch'),
    lazyTool(memoryCreateSchema, () => import('./memory_create'), 'memoryCreate'),
    lazyTool(memoryUpdateSchema, () => import('./memory_update'), 'memoryUpdate'),
    lazyTool(
      memoryInvalidateSchema,
      () => import('./memory_invalidate'),
      'memoryInvalidate'
    ),
    lazyTool(
      memoryReaffirmSchema,
      () => import('./memory_reaffirm'),
      'memoryReaffirm'
    ),
    lazyTool(memoryDoubtSchema, () => import('./memory_doubt'), 'memoryDoubt'),
    lazyTool(memoryRelateSchema, () => import('./memory_relate'), 'memoryRelate'),
    lazyTool(
      memoryUnrelateSchema,
      () => import('./memory_unrelate'),
      'memoryUnrelate'
    ),
  ],
};
