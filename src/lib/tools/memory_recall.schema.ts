/**
 * Schema-only export for memory_recall. Impl lives in `./memory_recall`.
 */
export const memoryRecallSchema = {
  name: 'memory_recall',
  description: `
Run a recall pass over the user's long-term memories against the live thread.
Use at the start of a new topic or when context is likely stale.
For direct lookups by phrase (including "what do you remember about me?") use memory_search.

Takes no arguments; returns:
- {kind:"none"} (nothing worth injecting)
- {kind:"note", note:"<your subjective memories>"}

IMPORTANT: Some memories returned may be from the current conversation!
`,
  shortDescription: 'recall memories relevant to this thread',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;
