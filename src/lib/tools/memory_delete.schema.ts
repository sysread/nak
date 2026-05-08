/**
 * Schema-only export for memory_delete. Impl lives in `./memory_delete`.
 */
export const memoryDeleteSchema = {
  name: 'memory_delete',
  description:
    'Hard-delete a memory by id. Use memory_search to find the id. ' +
    'Returns {deleted: true}.',
  shortDescription: 'remove a saved note',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the memory.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
