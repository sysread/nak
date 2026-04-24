/**
 * Toolbox for the memory-reflection agent (and any future memory-only
 * agent). Factored out of `./index.ts` into its own leaf file for the
 * same reason `./recall_toolbox.ts` is: the reflection agent runs
 * inside a Web Worker, and Vite's default worker output format is
 * IIFE, which is incompatible with code-splitting. If the agent
 * imported `memoryToolbox` from `./index.ts`, the worker bundle would
 * transitively pull in every tool re-exported by the barrel - notably
 * `research_docs`, which reaches into `src/lib/docs.ts` whose non-eager
 * `import.meta.glob('/docs/user/**\/*.md', ...)` forces code-splitting
 * on the per-doc chunks and crashes the worker build with
 * `Invalid value "iife" for option "output.format" - UMD and IIFE
 * output formats are not supported for code-splitting builds.`
 *
 * Keeping the toolbox definition in a file that only reaches for leaf
 * tool modules keeps the reflection worker's import graph narrow and
 * free of lazy globs.
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
import { memorySearch } from './memory_search';
import { memoryCreate } from './memory_create';
import { memoryUpdate } from './memory_update';
import { memoryInvalidate } from './memory_invalidate';
import { memoryReaffirm } from './memory_reaffirm';
import { memoryDoubt } from './memory_doubt';
import { memoryRelate } from './memory_relate';
import { memoryUnrelate } from './memory_unrelate';

export const memoryToolbox: Toolbox = {
  name: 'memory',
  description:
    "Create, read, update, and link the signed-in user's memories, and " +
    'invalidate or doubt ones contradicted or weakened by new evidence. ' +
    'Vector + text search via memory_search. Invalidation halves ' +
    'confidence; the gentler reaffirm/doubt pair nudges it; memory_relate ' +
    'and memory_unrelate manage edges in the memory graph.',
  tools: [
    memorySearch,
    memoryCreate,
    memoryUpdate,
    memoryInvalidate,
    memoryReaffirm,
    memoryDoubt,
    memoryRelate,
    memoryUnrelate,
  ],
};
