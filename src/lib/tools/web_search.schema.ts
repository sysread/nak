/**
 * Schema-only export for web_search. Impl lives in
 * `supabase/functions/venice/tools/web_search.ts`.
 */
export const webSearchSchema = {
  name: 'web_search',
  description:
    'Reach the live web, two ways. (1) Search: pass `query` and get a ' +
    'synthesized answer with source citations - use whenever the ' +
    'question benefits from current facts (news, prices, scores, ' +
    "releases past your training cutoff, today's weather, anything " +
    'time-sensitive). Phrase query like a search-engine query, not a ' +
    'sentence to the user. Optional context_hint (1-2 sentences) keeps ' +
    'the sub-search on task. (2) Fetch a page: pass `url` when the user ' +
    'gives you a specific link or you already know the exact page - the ' +
    'page content comes back directly as markdown (truncated: true ' +
    'flags a cut-off tail). Never put a URL in `query`; the search ' +
    'backend searches FOR the URL instead of reading it. Provide query ' +
    'or url, not both. Returns {answer, citations} for a search and ' +
    '{url, content} for a fetch; citations surface automatically on ' +
    'your next reply (you may reference them inline as ^N^).',
  shortDescription: 'search the live web or fetch a specific URL',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search-engine-style query (keywords, not a full sentence). ' +
          'Omit when passing url.',
      },
      context_hint: {
        type: 'string',
        description:
          'Optional 1-2 sentences of caller context for the ' +
          'sub-search. Query mode only.',
      },
      url: {
        type: 'string',
        description:
          'Exact http(s) page to fetch directly instead of searching. ' +
          'Omit when passing query.',
      },
    },
    required: [],
    additionalProperties: false,
  },
} as const;
