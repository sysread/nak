/**
 * Schema-only export for conversation_search. Impl lives in
 * `./conversation_search`.
 */
export const CONVERSATION_SEARCH_DEFAULT_LIMIT = 10;
export const CONVERSATION_SEARCH_MAX_LIMIT = 50;

/** Upper bound on `within_days`, ~5 years. Guards a nonsense value, not a real range. */
export const CONVERSATION_SEARCH_MAX_WITHIN_DAYS = 1825;

export const conversationSearchSchema = {
  name: 'conversation_search',
  description:
    "Semantic search over the user's prior conversations (threads), " +
    'over what was actually said in them as well as their title and ' +
    'summary. Returns {id, title, summary, updated_at, archived, ' +
    'match_kind, similarity?, passage?}[]. ' +
    'Search in the words the user would have used, not title words - ' +
    'the message text is indexed, so "ran out of lentils" finds the ' +
    'conversation that says it however it is titled. `passage` is the ' +
    'matched excerpt; pass it back as conversation_get\'s `query` to ' +
    'open the thread at that point. ' +
    'RANKING IS BY TOPIC ONLY unless you say otherwise: if the user ' +
    'anchors the request in time ("yesterday", "last week", "recently"), ' +
    'a plain query may return the best topical match from a year ago. ' +
    'Use `within_days` when the time frame is a requirement, ' +
    '`prefer_recent` when it is only a lean.',
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
      within_days: {
        type: 'integer',
        minimum: 1,
        maximum: CONVERSATION_SEARCH_MAX_WITHIN_DAYS,
        description:
          'Only consider conversations with activity in the last N days. ' +
          'A hard filter - a great match outside the window is dropped ' +
          'entirely. Use when the user made the time frame a requirement, ' +
          'not when they merely implied freshness ("the last few days" is ' +
          'about 3; "last week" about 7).',
      },
      prefer_recent: {
        type: 'boolean',
        description:
          'Break near-ties toward more recent conversations without ' +
          'excluding anything - it reorders similar scores, it will NOT ' +
          'lift a weak match above a strong one. Use for "did we talk ' +
          'about this recently"; use within_days when the frame is a ' +
          'requirement.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
