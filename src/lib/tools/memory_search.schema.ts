/**
 * Schema-only export for memory_search. Impl lives in `./memory_search`.
 */
export const MEMORY_SEARCH_DEFAULT_LIMIT = 20;
export const MEMORY_SEARCH_MAX_LIMIT = 100;

export const memorySearchSchema = {
  name: 'memory_search',
  description:
    "Semantic search over the user's saved memories. Returns " +
    '{id, label, data, confidence, confidence_tag, updated_at, ' +
    'relations}[]. confidence_tag is corroborated/hedged/shaky or ' +
    'null. relations carries outbound graph edges with the target ' +
    "memory's label/data inlined. Empty query lists everything. " +
    'Pass ids from this tool to memory_update / memory_delete.',
  shortDescription: "search the user's saved notes",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural-language query. Embedding match (paraphrases work). ' +
          'Empty/omitted lists all.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MEMORY_SEARCH_MAX_LIMIT,
        description: `Max results (default ${MEMORY_SEARCH_DEFAULT_LIMIT}, max ${MEMORY_SEARCH_MAX_LIMIT}).`,
      },
    },
    additionalProperties: false,
  },
} as const;
