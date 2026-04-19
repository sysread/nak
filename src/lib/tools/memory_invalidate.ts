/**
 * Soft-delete a memory by halving its confidence. The reflection
 * agent's equivalent of memory_delete — contradicted memories shouldn't
 * be hard-erased, they should just stop winning search against newer,
 * more-confident ones. Repeated invalidation drives confidence below
 * the 0.05 search floor (see schema `search_memories_by_embedding`),
 * effectively hiding the row from the main chat's memory_search while
 * keeping it recoverable if the agent ever re-learns the fact.
 *
 * Deliberately separate from the main chat's `memory_delete` (which
 * stays hard-delete, because when a user says "forget X" they expect
 * the row gone, not ranked lower). This tool ships only in
 * `memoryToolbox` — the reflection agent's toolbox — and is not part
 * of the main chat's tool registry.
 *
 * Return value carries the post-decay confidence so the calling model
 * sees the effect of its action. A memory that's been invalidated
 * repeatedly will come back with a tiny number (e.g. 0.031); the model
 * can decide on its next turn whether further invalidation is warranted
 * or whether the fact is stable-enough-to-be-stale and worth a fresh
 * replacement via memory_create.
 */
import type { ToolDef } from './types';

export const memoryInvalidate: ToolDef = {
  name: 'memory_invalidate',
  description:
    "Mark a memory as contradicted or outdated by new evidence, lowering its " +
    'confidence so it stops surfacing in search. Halves confidence on each ' +
    "call; repeated invalidation hides the memory entirely. The row isn't " +
    'hard-deleted — if you later re-learn the same fact, memory_update or ' +
    'memory_create can restore confidence. Returns {id, confidence} with the ' +
    'post-decay value so you can judge whether further action is needed.',
  shortDescription: 'soft-delete: halve confidence',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the memory to invalidate.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const confidence = await ctx.supabase.decayMemoryConfidence(id);
    // A null result means the row wasn't found (or RLS blocked the
    // update). Surface this as an error so the agent sees the failure
    // rather than the tool call silently no-op'ing.
    if (confidence === null) {
      throw new Error(`memory ${id} not found or not owned by this user`);
    }
    return { id, confidence };
  },
};
