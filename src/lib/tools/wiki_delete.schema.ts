/**
 * Schema-only export for wiki_delete. Impl lives in `./wiki_delete`.
 */
export const wikiDeleteSchema = {
  name: 'wiki_delete',
  description:
    'Delete a wiki article by id. Use only for consolidation - when one ' +
    'article is now strictly subsumed by another article you just updated. ' +
    'Never delete on the basis of "the user said something contradictory ' +
    'today" alone; in that case, update the article to reflect the new view.',
  shortDescription: 'delete a wiki article',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the article (from wiki_search).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
