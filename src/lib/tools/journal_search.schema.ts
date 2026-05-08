/**
 * Schema-only export for journal_search. Impl lives in
 * `./journal_search`.
 */
export const JOURNAL_SEARCH_DEFAULT_LIMIT = 10;
export const JOURNAL_SEARCH_MAX_LIMIT = 50;

export const journalSearchSchema = {
  name: 'journal_search',
  description:
    "Search the user's journal entries by meaning. Paraphrases work; this " +
    'is a semantic embedding search with a substring fallback for rows ' +
    'the embeddings worker has not yet processed. Returns an array of ' +
    '{id, entry_date, source, content, topics, mood, people, ' +
    'updated_at, similarity?} ranked by relevance. Empty query lists ' +
    'most-recent-first (use journal_list for that; this is for search).',
  shortDescription: 'search journal entries by meaning',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description: 'Natural-language query. Semantic match.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: JOURNAL_SEARCH_MAX_LIMIT,
        description: `Max results (default ${JOURNAL_SEARCH_DEFAULT_LIMIT}, max ${JOURNAL_SEARCH_MAX_LIMIT}).`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
