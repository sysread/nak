/**
 * Schema-only export for conversation_search. Impl lives in
 * `./conversation_search`.
 */
export const CONVERSATION_SEARCH_DEFAULT_LIMIT = 10;
export const CONVERSATION_SEARCH_MAX_LIMIT = 50;

export const conversationSearchSchema = {
  name: 'conversation_search',
  description:
    "Semantic search over the user's prior conversations (threads), " +
    'over what was actually said in them as well as their title and ' +
    'summary. Returns {id, title, summary, updated_at, archived, ' +
    'match_kind, similarity?, passage?}[]. ' +
    'Search in the words the user would have used, not in the words a ' +
    'title would use - the message text is indexed, so "ran out of ' +
    'lentils" finds the conversation that says it however it is ' +
    'titled. ' +
    '`passage` is the excerpt that matched, when the hit came from the ' +
    'message text; pass it back as conversation_get\'s `query` to open ' +
    'the thread at that point rather than at its end. Absent on threads ' +
    'matched only by title/summary. ' +
    'summary is auto-generated after the first terminal assistant turn ' +
    '(null on brand-new threads). Archived threads are included; weigh ' +
    'the archived flag lower if freshness matters.',
  shortDescription: 'search past conversations by topic',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language query. Required.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: CONVERSATION_SEARCH_MAX_LIMIT,
        description: `Max results (default ${CONVERSATION_SEARCH_DEFAULT_LIMIT}, max ${CONVERSATION_SEARCH_MAX_LIMIT}).`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
