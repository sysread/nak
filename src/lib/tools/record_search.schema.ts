/**
 * Schema-only export for record_search. Impl lives in `./record_search`
 * (edge: supabase/functions/venice/tools/record_search.ts).
 */
export const recordSearchSchema = {
  name: 'record_search',
  description:
    'Semantic search across ALL the user\'s wiki records (every article), ' +
    'ranked by meaning rather than keywords. Provide a natural-language ' +
    'query. Returns {records: [{id, article_id, date, content, tags, ' +
    'similarity}]}. Prefer record_list when you already know the article ' +
    'and just want its timeline; use this to find events by topic across ' +
    'the whole wiki.',
  shortDescription: 'semantic search over records',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description: 'Required. Natural-language description of what to find.',
      },
      limit: {
        type: 'number',
        description: 'Optional. Max records to return (default 20).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
