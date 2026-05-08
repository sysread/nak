/**
 * Schema-only export for conversation_search. Impl lives in
 * `./conversation_search`.
 */
export const CONVERSATION_SEARCH_DEFAULT_LIMIT = 20;
export const CONVERSATION_SEARCH_MAX_LIMIT = 100;

export const conversationSearchSchema = {
  name: 'conversation_search',
  description:
    "Search the user's prior conversations (threads) by meaning. " +
    'Returns an array of {id, title, summary, updated_at, archived, ' +
    'match_kind, similarity?}. `title` is the user-visible thread ' +
    "name; `summary` is a 2–3 sentence topical summary auto-generated " +
    'after the first terminal assistant turn (null on brand-new ' +
    'threads). Archived threads are included — the `archived` flag ' +
    'lets you weigh them lower if freshness matters. Use this before ' +
    '`conversation_recall` when you need specific details, or directly ' +
    'when the user references a past conversation.',
  shortDescription: 'search past conversations by topic',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural-language query. Semantic (embedding) match against ' +
          'title + summary runs alongside an exact substring match on ' +
          'the title; results are merged with exact hits first. Required.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: CONVERSATION_SEARCH_MAX_LIMIT,
        description: `Max results to return (default ${CONVERSATION_SEARCH_DEFAULT_LIMIT}, max ${CONVERSATION_SEARCH_MAX_LIMIT}).`,
      },
      include_current: {
        type: 'boolean',
        description:
          'Include the current thread in results. Defaults to false — ' +
          "you already have this thread's content in context; asking " +
          'conversation_search for it wastes the query. Set true only ' +
          'when you need to locate a specific earlier turn in the same ' +
          'thread.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
