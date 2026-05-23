/**
 * Schema-only export for memory_delete. Impl lives in `./memory_delete`.
 */
import { MAX_MEMORY_CHANGELOG_MESSAGE_CHARS } from '../memories';

export const memoryDeleteSchema = {
  name: 'memory_delete',
  description:
    'Hard-delete a memory by id. Use memory_search to find the id. ' +
    'message is a required one-line summary of why you removed it - it ' +
    'lands in the memory changelog the user reviews. Returns ' +
    '{deleted: true}.',
  shortDescription: 'remove a saved note',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the memory.',
      },
      message: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
        description:
          'One-line, commit-style summary of why this memory was ' +
          'removed. Lands in the memory changelog.',
      },
    },
    required: ['id', 'message'],
    additionalProperties: false,
  },
} as const;
