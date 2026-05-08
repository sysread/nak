/**
 * Schema-only export for memory_reaffirm. Impl lives in
 * `./memory_reaffirm`.
 */
export const memoryReaffirmSchema = {
  name: 'memory_reaffirm',
  description:
    'Nudge a memory upward in confidence when the current exchange ' +
    'corroborates it. Adds 0.5 to confidence (capped at 10.0). Use ' +
    "this when the user's words reinforce an existing memory or you " +
    'just used it successfully. Returns {id, confidence} with the ' +
    'post-bump value.',
  shortDescription: 'reaffirm: bump confidence +0.5',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the memory to reaffirm.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
