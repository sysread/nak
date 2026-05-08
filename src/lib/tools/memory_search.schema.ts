/**
 * Schema-only export for memory_search. Impl lives in `./memory_search`.
 */
export const MEMORY_SEARCH_DEFAULT_LIMIT = 20;
export const MEMORY_SEARCH_MAX_LIMIT = 100;

export const memorySearchSchema = {
  name: 'memory_search',
  description:
    "Search the user's saved memories by meaning. Returns an array of " +
    '{id, label, data, confidence, confidence_tag, updated_at, relations}. ' +
    '`confidence_tag` is one of "corroborated"/"hedged"/"shaky" or null ' +
    '(neutral). `relations` is the outbound edges for this memory ' +
    '(supports/contradicts/generalises/specialises) with the target ' +
    "memory's label/data inlined. Leave `query` empty to list every " +
    'memory. Use this before memory_update / memory_delete to find the ' +
    'id of the memory you want to target.',
  shortDescription: "search the user's saved notes",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural-language query. Semantic (embedding) match — paraphrases ' +
          'and synonyms work, not just substrings. Empty or omitted returns ' +
          'all memories.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MEMORY_SEARCH_MAX_LIMIT,
        description: `Max results to return (default ${MEMORY_SEARCH_DEFAULT_LIMIT}, max ${MEMORY_SEARCH_MAX_LIMIT}).`,
      },
    },
    additionalProperties: false,
  },
} as const;
