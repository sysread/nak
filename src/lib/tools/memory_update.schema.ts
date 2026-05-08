/**
 * Schema-only export for memory_update. Impl lives in `./memory_update`.
 */
import { MAX_MEMORY_DATA_CHARS } from '../embeddings/types';

export const memoryUpdateSchema = {
  name: 'memory_update',
  description:
    'Update a memory by id. Omit a field to leave it unchanged. data ' +
    `capped at ${MAX_MEMORY_DATA_CHARS} chars. Use memory_search to find ` +
    'the id. Returns the updated row.',
  shortDescription: 'edit a saved note',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the memory (from memory_search).',
      },
      label: { type: 'string', minLength: 1, maxLength: 80 },
      data: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_DATA_CHARS },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
