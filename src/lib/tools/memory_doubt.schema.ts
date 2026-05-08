/**
 * Schema-only export for memory_doubt. Impl lives in `./memory_doubt`.
 */
export const memoryDoubtSchema = {
  name: 'memory_doubt',
  description:
    'Multiply a memory\'s confidence by 0.7 when the current exchange ' +
    'weakens it without fully contradicting it (no floor; below 0.05 ' +
    'the memory hides from search but is recoverable). For outright ' +
    'contradictions prefer memory_update with corrected text or ' +
    'memory_delete on user request. Returns {id, confidence} ' +
    'post-doubt.',
  shortDescription: 'doubt: multiply confidence x0.7',
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
