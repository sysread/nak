/**
 * Schema-only export for web_search. Impl lives in `./web_search`.
 */
export const webSearchSchema = {
  name: 'web_search',
  description:
    'Search the live web and return a synthesized answer with source ' +
    'citations. Use whenever the question benefits from current facts ' +
    "(news, prices, scores, releases past your training cutoff, " +
    "today's weather, anything time-sensitive). Phrase query like a " +
    'search-engine query, not a sentence to the user. Optional ' +
    'context_hint (1-2 sentences) keeps the sub-search on task. ' +
    'Returns {answer, citations}; citations surface automatically on ' +
    'your next reply (you may reference them inline as ^N^).',
  shortDescription: 'search the live web for current facts',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search-engine-style query (keywords, not a full sentence).',
      },
      context_hint: {
        type: 'string',
        description:
          'Optional 1-2 sentences of caller context for the ' +
          'sub-search.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
