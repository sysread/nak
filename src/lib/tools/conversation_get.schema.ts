/**
 * Schema-only export for conversation_get. Impl lives in
 * `./conversation_get`.
 *
 * Mirror of wiki_get against `threads` rather than `wiki_articles`:
 * fetch one prior conversation by id once the model knows which thread
 * it wants to read - from a `conversation_search` hit or from an id in
 * an auto-injected context block.
 */
export const conversationGetSchema = {
  name: 'conversation_get',
  description:
    'Fetch a prior conversation by id. Returns ' +
    '{found: true, conversation: {id, title, summary, updated_at, ' +
    'archived, truncated, messages: [{role, content}]}} or ' +
    '{found: false}. The transcript is the most recent messages; long ' +
    'threads are windowed (truncated: true) with the summary covering ' +
    'the earlier part. Use conversation_search to discover ids, or read ' +
    'an id straight from an auto-injected context block. Prefer this ' +
    'over conversation_search when you already know the id - a ' +
    'primary-key fetch is cheaper than a vector search.',
  shortDescription: 'fetch a prior conversation by id',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'UUID of the thread (from conversation_search or an injected ' +
          'context block).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
