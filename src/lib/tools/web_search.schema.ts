/**
 * Schema-only export for web_search. Impl lives in `./web_search`.
 */
export const webSearchSchema = {
  name: 'web_search',
  description:
    'Search the live web for up-to-date information and return a short ' +
    'synthesized answer with source citations. Use this whenever the ' +
    'question benefits from current facts - news, prices, sports scores, ' +
    "product releases past your training cutoff, today's weather, " +
    'anything time-sensitive. Takes a `query` string; phrase it like a ' +
    'search engine query, not a question to the user. Optionally pass ' +
    '`context_hint` with 1-2 sentences on what the caller needs the ' +
    'lookup for so the sub-search stays on task. Returns `{answer, ' +
    'citations}`; the citations will be surfaced automatically on your ' +
    'next reply - you may (but need not) reference them inline as ^N^ ' +
    'superscripts. Prefer this over answering from memory whenever the ' +
    'user asks for anything time-sensitive or verifiable from primary ' +
    'sources.',
  shortDescription: 'search the live web for current facts',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search query, phrased like a search-engine query (keywords, ' +
          'not a full sentence to the user).',
      },
      context_hint: {
        type: 'string',
        description:
          'Optional 1-2 sentences of caller context so the sub-search ' +
          'model knows why it is looking. Helps keep the synthesis on ' +
          'task when the query alone is ambiguous.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
