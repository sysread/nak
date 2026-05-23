/**
 * Merge two duplicate memories into one. The librarian agents' single
 * content-write primitive; not available to reflection or the main
 * chat (consolidation is a cross-row decision the per-turn agents
 * shouldn't be making).
 *
 * The heavy lifting lives in the `consolidate_memories` Postgres RPC
 * so the four-step sequence (write survivor content + max confidence,
 * halve loser, redirect memory_conversation rows, redirect
 * memory_relations edges with self-loop and duplicate cleanup) runs
 * in one transaction. See supabase/schema.sql for the rationale on
 * each step.
 *
 * Confidence-handling note: the survivor's post-merge confidence is
 * `greatest(survivor.confidence, loser.confidence)`, NOT a bump via
 * bump_memory_confidence. Two threads independently producing the
 * same fact IS corroboration, but we preserve the strongest existing
 * evidence rather than manufacturing new evidence. This avoids
 * systematic inflation as memories survive repeated consolidation
 * passes.
 *
 * If future fidelity issues surface - the librarian failing to
 * consolidate because confidence drift is hiding genuine duplicates -
 * revisit by giving the librarian an explicit bump path here. The
 * inflation-vs-fidelity trade-off was the central design question
 * for this tool; see CLAUDE.md and docs/dev/memory.md for the
 * conversation history.
 */
import type { ToolDef } from './types';
import { MAX_MEMORY_DATA_CHARS } from '../embeddings/types';
import { memoryConsolidateSchema } from './memory_consolidate.schema';

export const memoryConsolidate: ToolDef = {
  ...memoryConsolidateSchema,
  async execute(args, ctx) {
    const survivorId =
      typeof args.survivor_id === 'string' ? args.survivor_id.trim() : '';
    const loserId = typeof args.loser_id === 'string' ? args.loser_id.trim() : '';
    const label = typeof args.label === 'string' ? args.label.trim() : '';
    const data = typeof args.data === 'string' ? args.data : '';

    if (!survivorId) throw new Error('survivor_id is required');
    if (!loserId) throw new Error('loser_id is required');
    if (survivorId === loserId) {
      throw new Error('survivor_id and loser_id must differ');
    }
    if (label.length === 0) throw new Error('label is required');
    if (data.length === 0) throw new Error('data is required');
    if (data.length > MAX_MEMORY_DATA_CHARS) {
      throw new Error(
        `data exceeds ${MAX_MEMORY_DATA_CHARS}-char limit (got ${data.length}); ` +
          'consolidation needs a single condensed body, not the concatenation of two'
      );
    }
    const confidence = await ctx.supabase.consolidateMemories(
      survivorId,
      loserId,
      label,
      data
    );
    return { survivor_id: survivorId, confidence };
  },
};
