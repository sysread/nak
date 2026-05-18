/**
 * Schema-only export for wiki_get. Impl lives in `./wiki_get`.
 */
export const wikiGetSchema = {
  name: 'wiki_get',
  description:
    'Fetch a wiki article by id. Returns ' +
    '{found: true, article: {id, title, content, created_at, updated_at}} ' +
    'or {found: false}. Use wiki_list to discover ids, or wiki_search ' +
    'when you only have a topic phrase. Prefer this over wiki_search ' +
    'when you already know the id - a primary-key fetch is cheaper ' +
    'than a vector search.',
  shortDescription: 'fetch a wiki article by id',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the article (from wiki_list or wiki_search).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
