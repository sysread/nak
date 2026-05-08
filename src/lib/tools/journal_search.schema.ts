/**
 * Schema-only export for journal_search. Impl lives in
 * `./journal_search`.
 */
export const JOURNAL_SEARCH_DEFAULT_LIMIT = 10;
export const JOURNAL_SEARCH_MAX_LIMIT = 50;

export const journalSearchSchema = {
  name: 'journal_search',
  description:
    "Semantic search over the user's journal entries (with substring " +
    'fallback for rows the embeddings worker has not yet processed). ' +
    'Returns {id, entry_date, source, content, topics, mood, people, ' +
    'updated_at, similarity?}[] ranked by relevance. For most-recent ' +
    'browsing use journal_list.',
  shortDescription: 'search journal entries by meaning',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description: 'Natural-language query.',
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
