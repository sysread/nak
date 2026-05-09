/**
 * Schema-only export for wiki_create. Impl lives in `./wiki_create`.
 */
import { MAX_WIKI_TITLE_CHARS, MAX_WIKI_CONTENT_CHARS } from '../wiki';

export const wikiCreateSchema = {
  name: 'wiki_create',
  description:
    "Create a new article in the user's wiki. title is the topic name " +
    `(1-${MAX_WIKI_TITLE_CHARS} chars, must be unique per user); content is ` +
    `the article body in encyclopedic third-person prose (max ${MAX_WIKI_CONTENT_CHARS} chars). ` +
    'Throws on a title collision; on error, run wiki_search and call wiki_update on the existing id.',
  shortDescription: 'add a wiki article',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_TITLE_CHARS,
        description: 'Article title (the topic name).',
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_CONTENT_CHARS,
        description: 'Article body, encyclopedic third-person prose.',
      },
    },
    required: ['title', 'content'],
    additionalProperties: false,
  },
} as const;
