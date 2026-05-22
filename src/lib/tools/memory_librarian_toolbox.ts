/**
 * Toolbox for the memory librarian agents (deep-sleep and rem). Both
 * share the same surface; the difference between the two is the
 * seed-selection strategy upstream (oldest-unvisited-similar for
 * deep-sleep, oldest-eligible-conversation-batch for rem), not the
 * tool kit.
 *
 * Shape contract vs reflection's `memoryToolbox` (the other write-
 * capable memory toolbox):
 *
 *   - memory_consolidate is the librarian's content-write primitive.
 *     Reflection's memory_update auto-bumps confidence on every
 *     write; the librarian needs max-confidence semantics on merges
 *     and a single atomic step over the four-table sequence
 *     (memories, memory_conversation, memory_relations, the loser's
 *     confidence). Reflection doesn't see this tool.
 *
 *   - memory_update is ABSENT. The librarian doesn't rephrase
 *     individual rows - consolidation collapses two; relations
 *     annotate without rewriting; doubt nudges confidence. If the
 *     librarian wants to rewrite a single memory's content (without
 *     merging), it would have to do so by consolidating the row with
 *     itself, which the RPC refuses. Surfacing memory_update would
 *     reintroduce the auto-bump path we deliberately ruled out for
 *     the librarian.
 *
 *   - memory_create is ABSENT. Reinforces "librarian collapses,
 *     reflection generates." No invention.
 *
 *   - memory_reaffirm is ABSENT. Confidence-up is a per-turn
 *     volitional signal from the main chat / reflection, not the
 *     librarian's role - the librarian sees the store globally and
 *     would systematically inflate if it reaffirmed liberally.
 *
 *   - memory_invalidate, memory_doubt are PRESENT. Soft-delete and
 *     gentle decay - both legitimate for "this is contradicted /
 *     stale" decisions the librarian makes from cross-row evidence.
 *
 *   - memory_relate, memory_unrelate are PRESENT. The librarian's
 *     primary graph-shaping primitives. Rem in particular treats
 *     graph hygiene as a first-class operation.
 *
 *   - conversation_search is PRESENT for fact-checking. Same
 *     rationale as the wiki librarian's inclusion.
 *
 *   - memory_recall is ABSENT (recursion guard, same as the other
 *     memory toolboxes).
 *
 * Tool impls are lazy-loaded via `lazyTool`; only the schemas are
 * eagerly imported here. Same chunking discipline as
 * `memory_toolbox.ts` and `wiki_librarian_toolbox.ts`.
 */
import type { Toolbox } from './types';
import { lazyTool } from './lazy';
import { memorySearchSchema } from './memory_search.schema';
import { memoryConsolidateSchema } from './memory_consolidate.schema';
import { memoryInvalidateSchema } from './memory_invalidate.schema';
import { memoryDoubtSchema } from './memory_doubt.schema';
import { memoryRelateSchema } from './memory_relate.schema';
import { memoryUnrelateSchema } from './memory_unrelate.schema';
import { conversationSearchSchema } from './conversation_search.schema';

export const memoryLibrarianToolbox: Toolbox = {
  name: 'memory-librarian',
  description:
    "Read, consolidate, relate, and soft-invalidate the signed-in user's " +
    'memories while cross-referencing conversation history to fact-check. ' +
    'Merge duplicates via memory_consolidate (preserves max confidence); ' +
    'draw graph edges via memory_relate / memory_unrelate; soft-delete ' +
    'contradicted facts via memory_invalidate (halve) or memory_doubt ' +
    '(gentle decay). No memory_create (no invention) and no memory_update ' +
    '(auto-bump would systematically inflate across consolidation passes).',
  tools: [
    lazyTool(memorySearchSchema, () => import('./memory_search'), 'memorySearch'),
    lazyTool(
      memoryConsolidateSchema,
      () => import('./memory_consolidate'),
      'memoryConsolidate'
    ),
    lazyTool(
      memoryInvalidateSchema,
      () => import('./memory_invalidate'),
      'memoryInvalidate'
    ),
    lazyTool(memoryDoubtSchema, () => import('./memory_doubt'), 'memoryDoubt'),
    lazyTool(memoryRelateSchema, () => import('./memory_relate'), 'memoryRelate'),
    lazyTool(
      memoryUnrelateSchema,
      () => import('./memory_unrelate'),
      'memoryUnrelate'
    ),
    lazyTool(
      conversationSearchSchema,
      () => import('./conversation_search'),
      'conversationSearch'
    ),
  ],
};
