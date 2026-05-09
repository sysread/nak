/**
 * Schema-only export for wiki_update. Impl lives in `./wiki_update`.
 */
import { MAX_WIKI_TITLE_CHARS, MAX_WIKI_CONTENT_CHARS } from '../wiki';

export const wikiUpdateSchema = {
  name: 'wiki_update',
  description:
    'Update a wiki article by id. Omit a field to leave it unchanged. ' +
    `title capped at ${MAX_WIKI_TITLE_CHARS} chars (must remain unique per user); ` +
    `content capped at ${MAX_WIKI_CONTENT_CHARS} chars. Use wiki_search to find ` +
    'the id. Returns the updated row. Preserve existing facts unless the ' +
    'user has explicitly contradicted them.',
  shortDescription: 'edit a wiki article',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the article (from wiki_search).',
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_TITLE_CHARS,
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_CONTENT_CHARS,
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
