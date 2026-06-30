/**
 * Schema-only export for wiki_create. Impl lives in the venice edge
 * function (supabase/functions/venice/tools/wiki_create.ts), which also
 * self-registers the tool for dispatch.
 *
 * Kept byte-aligned with the agent-side wire schema in
 * supabase/functions/venice/agents/wiki.ts (WIKI_CREATE_WIRE_SCHEMA) so
 * the main chat and the autonomous/librarian agents present the model
 * one contract - the only deliberate drift is that the chat schema omits
 * the librarian-only `source_thread_ids` (a chat turn's current thread
 * is attached as the source automatically by the tool).
 *
 * The `message` field is required (unlike memory_create's optional
 * changelog line): a new article has no sensible label-derived default,
 * and the user wants the "why" recorded in the wiki changelog.
 */
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../wiki';

function formatWikiWriteArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof args.message === 'string' && args.message) {
    lines.push(`**Why:** ${args.message}`);
  }
  if (typeof args.title === 'string' && args.title) {
    lines.push(`**Title:** ${args.title}`);
  }
  if (typeof args.content === 'string' && args.content) {
    lines.push('', args.content);
  }
  return lines.join('\n');
}

export const wikiCreateSchema = {
  name: 'wiki_create',
  description:
    "Create a new article in the user's wiki. title is the topic name " +
    `(1-${MAX_WIKI_TITLE_CHARS} chars, must be unique per user); content is ` +
    `the article body in encyclopedic third-person prose (max ${MAX_WIKI_CONTENT_CHARS} chars). ` +
    'message is a one-line commit-message-style summary of WHY you are creating this article (max ' +
    `${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars); it lands in the wiki changelog so the user can ` +
    'audit who/what added the article and why. ' +
    'Throws on a title collision; on error, run wiki_search and call wiki_update on the existing id.',
  shortDescription: 'create a wiki article',
  formatArgs: formatWikiWriteArgs,
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
      message: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
        description:
          'One-line summary of why this article is being added. Written ' +
          'in the imperative voice ("Add Jeff\'s sister Maya, recently ' +
          'moved to Seattle") so the changelog reads as a log of ' +
          'discrete decisions. Lands in the wiki changelog the user can ' +
          'browse from the Wiki top bar.',
      },
    },
    required: ['title', 'content', 'message'],
    additionalProperties: false,
  },
} as const;
