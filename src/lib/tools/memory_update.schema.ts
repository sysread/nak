/**
 * Schema-only export for memory_update. Impl lives in `./memory_update`.
 */
import { MAX_MEMORY_DATA_CHARS } from '../embeddings/types';

export const memoryUpdateSchema = {
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
} as const;
