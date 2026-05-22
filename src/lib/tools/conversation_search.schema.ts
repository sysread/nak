/**
 * Schema-only export for conversation_search. Impl lives in
 * `./conversation_search`.
 */
export const CONVERSATION_SEARCH_DEFAULT_LIMIT = 20;
export const CONVERSATION_SEARCH_MAX_LIMIT = 100;

export const conversationSearchSchema = {
  name: 'conversation_search',
  description:
    "Semantic search over the user's prior conversations (threads) " +
    'by title + summary. Returns {id, title, summary, updated_at, ' +
    'archived, match_kind, similarity?}[]. summary is auto-generated ' +
    'after the first terminal assistant turn (null on brand-new ' +
    'threads). Archived threads are included; weigh the archived flag ' +
    'lower if freshness matters. Embedding match runs alongside an ' +
    'exact title substring match; exact hits sort first.',
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
