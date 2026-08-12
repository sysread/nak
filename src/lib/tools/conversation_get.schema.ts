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
    'archived, truncated, window: {start, end, total}, matched_query, ' +
    'messages: [{role, content}]}} or {found: false}. ' +
    'Long threads do not fit in one response, so you get a WINDOW of ' +
    'turns, and `window` tells you which: {start: 99, end: 106, total: ' +
    '107} means you are looking at the last eight turns of a ' +
    '107-turn conversation and everything before turn 99 is not in ' +
    'front of you. ' +
    'PASS `query` WHENEVER YOU ARE LOOKING FOR SOMETHING SPECIFIC. ' +
    'Without it you get the most recent turns, which is the wrong part ' +
    'of the thread whenever what you want was said earlier - and ' +
    're-calling with the same id returns the same window, so retrying ' +
    'is never the fix. With it, the window centres on the best-matching ' +
    'turn and its surrounding exchange. `matched_query` is false when ' +
    'your terms were not found and you got the ordinary tail instead. ' +
    'Use conversation_search to discover ids; a hit there carries a ' +
    '`passage` you can feed straight back as this `query`.',
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
      query: {
        type: 'string',
        description:
          'What you are looking for in this conversation, in the words ' +
          'you expect it to have been said in. Centres the returned ' +
          'window on the best-matching turn instead of the most recent ' +
          'ones. Omit only when you genuinely want the end of the ' +
          'conversation.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
