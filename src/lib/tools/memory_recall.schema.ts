/**
 * Schema-only export for memory_recall. Impl lives in `./memory_recall`.
 */
export const memoryRecallSchema = {
  name: 'memory_recall',
  description:
    'Run a recall pass over the user\'s long-term memories against ' +
    'the live thread. Takes no arguments; returns either ' +
    '`{kind:"none"}` (nothing worth injecting) or `{kind:"note", ' +
    'note:"<first-person paragraph>"}` to fold into your next reply ' +
    'as your own recollection. Use at the start of a new topic or ' +
    'when context is likely stale; for direct lookups by phrase ' +
    '(including "what do you remember about me?") use memory_search.',
  shortDescription: 'recall memories relevant to this thread',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;
