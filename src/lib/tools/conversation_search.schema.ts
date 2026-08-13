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
    'the archived flag lower if freshness matters. ' +
    'RANKING IS BY TOPIC ONLY unless you say otherwise. If the user ' +
    'anchors their request in time - "yesterday", "last week", "the ' +
    'other day", "recently" - a plain query will happily return the ' +
    'best topical match from a year ago and nothing recent at all. Use ' +
    '`within_days` when the time frame is a requirement, and ' +
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
          'A hard filter, so a great match outside the window is dropped ' +
          'entirely - use it when the user made the time frame a ' +
          'requirement ("the conversation from yesterday"), not when they ' +
          'merely implied freshness. "the last few days" is about 3; "last ' +
          'week" about 7.',
      },
      prefer_recent: {
        type: 'boolean',
        description:
          'Break near-ties toward more recent conversations, without ' +
          'excluding anything. Deliberately gentle: it reorders results ' +
          'that already score similarly and will NOT lift a weak match ' +
          'above a strong one. Use for "did we talk about this recently"; ' +
          'use within_days when the time frame is the actual requirement.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
