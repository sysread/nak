/**
 * Patch an existing memory's label and/or data. Either field can be
 * omitted to leave it alone, so the LLM can rename without rewriting
 * or vice versa.
 *
 * Mirrors memory_create's `data` cap — and here it matters twice: any
 * change to `label` or `data` fires the schema trigger that nulls the
 * embedding, sending the row back to the worker's pending queue, so an
 * oversize update would fail to re-embed (and the old embedding is
 * already gone).
 */
import type { ToolDef } from './types';
import { MAX_MEMORY_DATA_CHARS } from '../embeddings/types';

export const memoryUpdate: ToolDef = {
  name: 'memory_update',
  description:
    'Update a memory by id. Omit a field to leave it unchanged. ' +
    `\`data\` is capped at ${MAX_MEMORY_DATA_CHARS} chars — split across ` +
    "multiple memories if longer. Use memory_search first if you don't " +
    'already have the id. Returns the updated row.',
  shortDescription: 'edit a saved note',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the memory to update (from memory_search).',
      },
      label: { type: 'string', minLength: 1, maxLength: 80 },
      data: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_DATA_CHARS },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const patch: { label?: string; data?: string } = {};
    if (typeof args.label === 'string' && args.label.trim().length > 0) {
      patch.label = args.label.trim();
    }
    if (typeof args.data === 'string' && args.data.length > 0) {
      if (args.data.length > MAX_MEMORY_DATA_CHARS) {
        throw new Error(
          `data exceeds ${MAX_MEMORY_DATA_CHARS}-char limit (got ${args.data.length}); split across multiple memories`
        );
      }
      patch.data = args.data;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('provide at least one of label or data');
    }
    return ctx.supabase.updateMemory(id, patch);
  },
};
