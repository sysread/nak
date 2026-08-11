/**
 * Schema-only export for wiki_search. Impl lives in `./wiki_search`.
 */
export const WIKI_SEARCH_DEFAULT_LIMIT = 5;
export const WIKI_SEARCH_MAX_LIMIT = 20;

export const wikiSearchSchema = {
  name: 'wiki_search',
  description:
    "Semantic search over the user's wiki - flat encyclopedic articles " +
    'about topics, people, places, and projects in their life (with ' +
    'substring fallback for rows the embeddings backfill has not yet ' +
    'processed). Returns {id, title, content, updated_at, similarity?}[] ' +
    'ranked by relevance. Articles are NEVER auto-injected into the chat; ' +
    'this is the only way to surface them.',
  shortDescription: 'look up a wiki article by topic',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description: 'Natural-language query, topic, or article title.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: WIKI_SEARCH_MAX_LIMIT,
        description: `Max results (default ${WIKI_SEARCH_DEFAULT_LIMIT}, max ${WIKI_SEARCH_MAX_LIMIT}).`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
