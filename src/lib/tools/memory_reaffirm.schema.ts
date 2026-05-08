/**
 * Schema-only export for memory_reaffirm. Impl lives in
 * `./memory_reaffirm`.
 */
export const memoryReaffirmSchema = {
  name: 'memory_reaffirm',
  description:
    'Add 0.5 to a memory\'s confidence (capped at 10.0) when the ' +
    "current exchange corroborates it or you just used it " +
    'successfully. Returns {id, confidence} post-bump.',
  shortDescription: 'reaffirm: bump confidence +0.5',
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
