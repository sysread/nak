/**
 * Chat-side counterpart to the reflection agent's implicit
 * `bump_memory_confidence`. Lets the LLM explicitly mark a memory as
 * corroborated by the current exchange - the user just said something
 * that reinforces it, or the LLM used it successfully in a recent
 * reply.
 *
 * Gentler than the reflection-side bump (+0.5 vs +1.0) because it fires
 * mid-turn on a single exchange rather than on settled evidence across
 * a whole conversation. Returns the post-bump confidence so the model
 * sees the effect.
 *
 * Companion to `memory_doubt`. The two together are the volitional
 * confidence lever; the reflection agent's `memory_invalidate` stays as
 * the larger-hammer contradiction path.
 */
import type { ToolDef } from './types';
import { memoryReaffirmSchema } from './memory_reaffirm.schema';

export const memoryReaffirm: ToolDef = {
  ...memoryReaffirmSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const confidence = await ctx.supabase.reaffirmMemoryConfidence(id);
    // Null means the row wasn't found or RLS blocked the update. Surface
    // the failure so the model doesn't silently think its action landed.
    if (confidence === null) {
      throw new Error(`memory ${id} not found or not owned by this user`);
    }
    return { id, confidence };
  },
};
