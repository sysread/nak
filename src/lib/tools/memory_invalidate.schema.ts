/**
 * Schema-only export for memory_invalidate. Impl lives in
 * `./memory_invalidate`.
 */
export const memoryInvalidateSchema = {
  name: 'memory_invalidate',
  description:
    'Mark a memory as contradicted or outdated by new evidence, lowering its ' +
    'confidence so it stops surfacing in search. Halves confidence on each ' +
    "call; repeated invalidation hides the memory entirely. The row isn't " +
    'hard-deleted — if you later re-learn the same fact, memory_update or ' +
    'memory_create can restore confidence. Returns {id, confidence} with the ' +
    'post-decay value so you can judge whether further action is needed.',
  shortDescription: 'soft-delete: halve confidence',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the memory to invalidate.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
