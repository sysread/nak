/**
 * Chat-side softening of a memory's confidence. Use when the current
 * exchange casts mild doubt on an existing memory but doesn't
 * outright contradict it - the user hedged on something that had been
 * stated strongly before, or volunteered a small counter-signal.
 *
 * Gentler than the reflection agent's `memory_invalidate` (which halves
 * confidence on the strength of settled evidence): this one multiplies
 * by 0.7, so five calls from the default 1.0 lands around 0.168 -
 * firmly in [shaky] territory but still well above the 0.05 search-hide
 * floor. That gradient gives the LLM room to express uncertainty over
 * a conversation rather than having to nuke a memory in one step.
 *
 * If the evidence is strong enough to warrant outright removal, the
 * model should prefer `memory_update` (with new text) or
 * `memory_delete` over stacking doubts.
 */
import type { ToolDef } from './types';
import { memoryDoubtSchema } from './memory_doubt.schema';

export const memoryDoubt: ToolDef = {
  ...memoryDoubtSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const confidence = await ctx.supabase.doubtMemoryConfidence(id);
    // Null = row not found or RLS blocked the update. Fail loud so the
    // model sees the miss rather than thinking the nudge landed.
    if (confidence === null) {
      throw new Error(`memory ${id} not found or not owned by this user`);
    }
    return { id, confidence };
  },
};
