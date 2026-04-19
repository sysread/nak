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

export const memoryCreate: ToolDef = {
  name: 'memory_create',
  description:
    "Save a new memory for the user. `label` is a short handle " +
    `(1-80 chars); \`data\` is the full content (max ${MAX_MEMORY_DATA_CHARS} ` +
    'chars — split across multiple memories if longer). Returns the ' +
    'created {id, label, data, updated_at}.',
  shortDescription: 'save a new note',
  parameters: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description: 'Short name for the memory.',
      },
      data: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MEMORY_DATA_CHARS,
        description: `Full content of the memory (max ${MAX_MEMORY_DATA_CHARS} chars).`,
      },
    },
    required: ['label', 'data'],
    additionalProperties: false,
  },
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
    return ctx.supabase.createMemory(label, data);
  },
};
