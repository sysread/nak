/**
 * Schema-only export for conversation_recall. Impl lives in
 * `./conversation_recall`.
 */
export const conversationRecallSchema = {
  name: 'conversation_recall',
  description:
    'Run a recall pass over PRIOR conversations with this user, ' +
    "searching by topical summary. Returns either `{kind:\"none\"}` " +
    '(nothing worth injecting) or `{kind:"note", note:"<first-person ' +
    'paragraph>"}` to fold into your next reply as your own ' +
    'recollection. Call at the start of a new topic, not every turn; ' +
    'for raw search results (e.g. the user asks for a specific past ' +
    'thread) use conversation_search.',
  shortDescription: 'recall relevant prior conversations',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          'Optional phrase to seed the recall agent\'s first search. ' +
          'Pass the user-facing topic ("moving to Lisbon"); omit to ' +
          'let the agent infer from the conversation.',
      },
    },
    additionalProperties: false,
  },
} as const;
