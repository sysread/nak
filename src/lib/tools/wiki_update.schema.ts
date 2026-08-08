/**
 * Schema-only export for wiki_update. Impl lives in the venice edge
 * function (supabase/functions/venice/tools/wiki_update.ts), which also
 * self-registers the tool for dispatch.
 *
 * Kept aligned with the agent-side wire schema in
 * supabase/functions/venice/agents/wiki.ts (WIKI_UPDATE_WIRE_SCHEMA).
 * Deliberate drift: the chat schema omits the librarian-only
 * `source_thread_ids` param. A chat turn always has a current thread,
 * which the tool attaches as the article's source automatically; the
 * thread-ids-from-conversation_search workflow that param exists for is
 * a librarian concern, not a main-chat one.
 */
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../wiki';

function formatWikiUpdateArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof args.message === 'string' && args.message) {
    lines.push(`**Why:** ${args.message}`);
  }
  if (typeof args.title === 'string' && args.title) {
    lines.push(`**New title:** ${args.title}`);
  }
  if (typeof args.content === 'string' && args.content) {
    lines.push('', args.content);
  }
  return lines.join('\n');
}

export const wikiUpdateSchema = {
  name: 'wiki_update',
  description:
    'Update a wiki article by id. Provide at least one of title or ' +
    'content; omit the other to leave it unchanged.' +
    `  title capped at ${MAX_WIKI_TITLE_CHARS} chars ` +
    `(must remain unique per user); content capped at ${MAX_WIKI_CONTENT_CHARS} chars. ` +
    'Use wiki_search to find the id. Returns the updated row. Preserve ' +
    'existing facts unless the user has explicitly contradicted them. ' +
    'message is a one-line commit-message-style summary of WHY you are ' +
    `editing this article (max ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars); ` +
    'it lands in the wiki changelog.',
  shortDescription: 'edit a wiki article',
  formatArgs: formatWikiUpdateArgs,
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
        description: 'Optional. New title; omit to leave unchanged.',
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_CONTENT_CHARS,
        description: 'Optional. New body; omit to leave unchanged.',
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
    },
    required: ['id', 'message'],
    additionalProperties: false,
  },
} as const;
