/**
 * Persist a new memory for the current user. Returns the created row so
 * the LLM can reference its id in a follow-up update/delete without a
 * second search.
 *
 * The hard cap on `data` length (`MAX_MEMORY_DATA_CHARS`) exists because
 * every memory gets embedded by the background worker for semantic search.
 * Venice's embedding model has a bounded context; a 100k-char memory
 * would either overflow that context or come back with a useless
 * average-of-everything vector. The cap also keeps `memory_search` cheap
 * — search ships the full `data` back to the LLM, so a giant memory
 * blows up the next round's prompt budget.
 */
import type { ToolDef } from './types';
import { MAX_MEMORY_DATA_CHARS } from '../embeddings/types';
import { memoryCreateSchema } from './memory_create.schema';

export const memoryCreate: ToolDef = {
  ...memoryCreateSchema,
  async execute(args, ctx) {
    const label = typeof args.label === 'string' ? args.label.trim() : '';
    const data = typeof args.data === 'string' ? args.data : '';
    if (!label) throw new Error('label is required');
    if (!data) throw new Error('data is required');
    // The model may ignore the schema's maxLength hint, so enforce here.
    // Rejecting (rather than silently truncating) gives the LLM an error
    // it can act on — it'll split the memory rather than getting a
    // confusingly-half-saved row.
    if (data.length > MAX_MEMORY_DATA_CHARS) {
      throw new Error(
        `data exceeds ${MAX_MEMORY_DATA_CHARS}-char limit (got ${data.length}); split across multiple memories`
      );
    }
    // `confidence` is optional and bounded [1.0, 10.0]. The schema default
    // is 1.0 on the server; we only pass a value when the LLM explicitly
    // supplied one. Out-of-range input is rejected rather than clamped so
    // the model sees a clear error instead of a silent mismatch between
    // what it asked for and what got saved.
    let confidence: number | undefined;
    if (args.confidence !== undefined) {
      if (typeof args.confidence !== 'number' || !Number.isFinite(args.confidence)) {
        throw new Error('confidence must be a finite number');
      }
      if (args.confidence < 1.0 || args.confidence > 10.0) {
        throw new Error(
          `confidence must be in [1.0, 10.0] (got ${args.confidence})`
        );
      }
      confidence = args.confidence;
    }
    return ctx.supabase.createMemory(label, data, confidence);
  },
};
