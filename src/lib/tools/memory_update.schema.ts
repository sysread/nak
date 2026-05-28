/**
 * Schema-only export for memory_update. Impl lives in `./memory_update`.
 */
import { MAX_MEMORY_DATA_CHARS } from '../memories';
import { MAX_MEMORY_CHANGELOG_MESSAGE_CHARS } from '../memories';

export const memoryUpdateSchema = {
  name: 'memory_update',
  description:
    'Update a memory by id. Omit label/data to leave it unchanged (but ' +
    'provide at least one). data ' +
    `capped at ${MAX_MEMORY_DATA_CHARS} chars. Use memory_search to find ` +
    'the id. message is a required one-line summary of what changed and ' +
    'why - it lands in the memory changelog the user reviews. Returns ' +
    'the updated row.',
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
      message: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
        description:
          'One-line, commit-style summary of what changed and why. ' +
          'Lands in the memory changelog.',
      },
    },
    required: ['id', 'message'],
    additionalProperties: false,
  },
} as const;
