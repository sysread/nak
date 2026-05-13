/**
 * Schema-only export for wiki_update. Impl lives in `./wiki_update`.
 */
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../wiki';

export const wikiUpdateSchema = {
  name: 'wiki_update',
  description:
    'Update a wiki article by id. Omit title or content to leave that ' +
    `field unchanged. title capped at ${MAX_WIKI_TITLE_CHARS} chars ` +
    `(must remain unique per user); content capped at ${MAX_WIKI_CONTENT_CHARS} chars. ` +
    'Use wiki_search to find the id. Returns the updated row. Preserve ' +
    'existing facts unless the user has explicitly contradicted them. ' +
    'message is a one-line commit-message-style summary of WHY you are ' +
    `editing this article (max ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars); ` +
    "it lands in the wiki changelog. When invoked by the librarian " +
    'after consulting conversation_search, pass `source_thread_ids` with the ' +
    'thread ids whose content actually informed this update so they land in ' +
    "the article's bibliography. The autonomous wiki agent leaves " +
    '`source_thread_ids` unset; its current thread is attached automatically.',
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
      message: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
        description:
          'One-line summary of why this article is being edited. Written ' +
          'in the imperative voice ("Correct Maya\'s employer to Bar (from ' +
          'November 2026 chat)") so the changelog reads as a log of ' +
          'discrete decisions. Lands in the wiki changelog the user can ' +
          'browse from the Wiki top bar.',
      },
      source_thread_ids: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 20,
        description:
          'Thread ids whose content informed this update. The librarian ' +
          'populates this with ids from conversation_search results; ' +
          'unknown ids are silently dropped (validated against the ' +
          'threads table). Leave unset on the autonomous path - the ' +
          "current thread is attached automatically by the tool.",
      },
    },
    required: ['id', 'message'],
    additionalProperties: false,
  },
} as const;
