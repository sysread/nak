/**
 * Schema-only export for memory_recall. Impl lives in `./memory_recall`.
 */
export const memoryRecallSchema = {
  name: 'memory_recall',
  description:
    'Pull in any long-term memories that are relevant to the current ' +
    "conversation but aren't already mentioned. Takes no arguments — " +
    'it reads the live thread on its own and returns either ' +
    '`{kind:"none"}` (nothing worth injecting) or `{kind:"note", ' +
    'note:"<first-person paragraph>"}` you should treat as your own ' +
    'recollection and fold into your next reply.' +
    '\n\n' +
    'STRONGLY PREFER THIS over `memory_search` whenever you just want ' +
    'context about the user to answer better. `memory_search` is for ' +
    'when the user has explicitly asked you to find, edit, or remove a ' +
    'specific memory — i.e. when you need the memory id to hand to ' +
    '`memory_update`, `memory_delete`, or `memory_invalidate`. For ' +
    'every other "let me check what I remember" moment, call ' +
    '`memory_recall` instead: it runs a dedicated recall pass for you, ' +
    'skips memories already visible in the conversation, and returns a ' +
    'pre-digested note instead of a raw result list.',
  shortDescription: 'recall memories relevant to this thread',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;
