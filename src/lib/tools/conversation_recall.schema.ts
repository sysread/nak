/**
 * Schema-only export for conversation_recall. Impl lives in
 * `./conversation_recall`.
 */
export const conversationRecallSchema = {
  name: 'conversation_recall',
  description:
    'Pull in relevant context from PRIOR conversations with this user ' +
    "that aren't already mentioned in the current thread. Runs a " +
    'dedicated recall pass over every conversation the user has had ' +
    'with you, searching by topical summary, and returns either ' +
    '`{kind:"none"}` (nothing worth injecting) or `{kind:"note", ' +
    'note:"<first-person paragraph>"}` you should treat as your own ' +
    'recollection and fold into your next reply.' +
    '\n\n' +
    'PREFER THIS over `conversation_search` whenever you just want ' +
    'context to answer better. `conversation_search` is for when you ' +
    'need raw search results (e.g. the user asked "what was that ' +
    'thread where we discussed X"). For every other "let me check ' +
    'what we talked about before" moment, call `conversation_recall` ' +
    'instead: it runs the search for you, cross-checks against the ' +
    'current thread, and returns a pre-digested note.' +
    '\n\n' +
    'Call this at the start of a new topic, not every turn. Once the ' +
    'topic is established you already have the recalled context in ' +
    'your working memory.',
  shortDescription: 'recall relevant prior conversations',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          'Optional topic hint to bias the recall agent’s first ' +
          'search query. Pass the user-facing phrase for what they ' +
          'just opened up (e.g. "moving to Lisbon", "the ' +
          'dissertation chapter on X"). Omit to let the agent infer ' +
          'from the conversation above.',
      },
    },
    additionalProperties: false,
  },
} as const;
