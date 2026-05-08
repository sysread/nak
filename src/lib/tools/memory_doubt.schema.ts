/**
 * Schema-only export for memory_doubt. Impl lives in `./memory_doubt`.
 */
export const memoryDoubtSchema = {
  name: 'memory_doubt',
  description:
    'Nudge a memory downward in confidence when the current exchange ' +
    'weakens it without fully contradicting it. Multiplies confidence ' +
    'by 0.7 (no floor; below 0.05 the memory hides from search but is ' +
    "recoverable). Don't use this for outright contradictions - prefer " +
    'memory_update with corrected text, or memory_delete if the user ' +
    'asked you to forget. Returns {id, confidence} with the post-doubt ' +
    'value.',
  shortDescription: 'doubt: multiply confidence x0.7',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the memory to doubt.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
