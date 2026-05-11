/**
 * Schema-only export for journal_recall. Impl lives in
 * `./journal_recall`.
 */
export const journalRecallSchema = {
  name: 'journal_recall',
  description:
    "Run a recall pass over the user's daily journal - dated " +
    'reflective entries summarising what they processed each day. ' +
    "Returns either `{kind:\"none\"}` (nothing worth injecting) or " +
    '`{kind:"note", note:"<first-person paragraph>"}` to fold into ' +
    'your next reply as your own recollection. Most useful when the ' +
    'user is in a reflective headspace (revisiting an old emotional ' +
    'thread, processing again); for raw entry retrieval use ' +
    'journal_search or journal_read.',
  shortDescription:
    "recall reflective journal entries relevant to this thread",
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          "Optional phrase to seed the recall agent's first search. " +
          'Pass the user-facing topic ("my dad", "the move"); omit to ' +
          'let the agent infer from the conversation.',
      },
    },
    additionalProperties: false,
  },
} as const;
