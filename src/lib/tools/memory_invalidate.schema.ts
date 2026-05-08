/**
 * Schema-only export for memory_invalidate. Impl lives in
 * `./memory_invalidate`.
 */
export const memoryInvalidateSchema = {
  name: 'memory_invalidate',
  description:
    'Mark a memory as contradicted/outdated, halving its confidence ' +
    'so it stops surfacing in search. Repeated invalidation hides it ' +
    "entirely; the row isn't hard-deleted, so memory_update / " +
    'memory_create can restore confidence later. Returns ' +
    '{id, confidence} post-decay.',
  shortDescription: 'soft-delete: halve confidence',
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
